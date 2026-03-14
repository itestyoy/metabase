import { useCallback, useEffect, useRef, useState } from "react";

import api from "metabase/lib/api";

import type { AgentContextValue } from "../AgentContextPicker";
import type { ChatMessage, ContentBlock } from "../types";

function makeId(): string {
  return Math.random().toString(36).slice(2);
}

/** Minimal check that a block has the required fields for its type. */
function isValidBlock(b: unknown): b is ContentBlock {
  if (!b || typeof b !== "object" || !("type" in b)) {
    return false;
  }
  const block = b as Record<string, unknown>;
  switch (block.type) {
    case "text":
    case "sql":
      return typeof block.content === "string";
    case "card_link":
      return typeof block.card_id === "number" && typeof block.name === "string";
    case "card_preview":
      return typeof block.card_id === "number" && typeof block.name === "string" && typeof block.display === "string";
    case "notebook_link":
      return typeof block.name === "string" && typeof block.display === "string" && block.dataset_query != null && typeof block.dataset_query === "object";
    case "dashboard_link":
      return typeof block.dashboard_id === "number" && typeof block.name === "string";
    case "document_link":
      return typeof block.document_id === "number" && typeof block.name === "string";
    case "table":
      return Array.isArray(block.columns) && Array.isArray(block.rows);
    default:
      return false;
  }
}

interface ParsedResponse {
  blocks?: ContentBlock[];
  suggestions?: string[];
}

/** Try to parse the AI response as structured JSON blocks + suggestions.
 *  Falls back to plain markdown if parsing or validation fails. */
function parseResponse(content: string): ParsedResponse {
  if (!content) {
    return {};
  }
  try {
    const parsed = JSON.parse(content);
    if (parsed && Array.isArray(parsed.blocks) && parsed.blocks.length > 0) {
      const valid = parsed.blocks.filter(isValidBlock);
      const suggestions = Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s: unknown) => typeof s === "string" && s.length > 0)
        : undefined;
      return {
        blocks: valid.length > 0 ? valid : undefined,
        suggestions: suggestions && suggestions.length > 0 ? suggestions : undefined,
      };
    }
  } catch {
    // Not JSON — return empty so we render as plain markdown
  }
  return {};
}

export interface AgentSettings {
  configured: boolean;
  model: string;
  enabled: boolean;
  access: boolean;
}

interface AgentResponse {
  response_id: string | null;
  content: string;
  chat_collection_id: number | null;
  chat_collection_name: string | null;
  tool_calls: Array<{
    name: string;
    args: Record<string, unknown>;
    result: string;
  }>;
}

/** Parse SSE text into events. Handles multi-line data fields. */
function parseSSE(text: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
  const blocks = text.split("\n\n");
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) {
        event = line.slice(7);
      } else if (line.startsWith("data: ")) {
        data += line.slice(6);
      }
    }
    if (event && data) {
      events.push({ event, data });
    }
  }
  return events;
}

export function useAgentChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previousResponseId, setPreviousResponseId] = useState<string | null>(
    null,
  );
  const [chatCollectionId, setChatCollectionId] = useState<number | null>(null);
  const [chatCollectionName, setChatCollectionName] = useState<string | null>(null);
  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(
    null,
  );
  const abortRef = useRef<AbortController | null>(null);

  // Fetch agent settings from backend (is it configured, what model)
  useEffect(() => {
    api
      .GET("/api/ai-agent/settings")({})
      .then((data: unknown) => {
        const s = data as {
          configured?: boolean;
          model?: string;
          enabled?: boolean;
          access?: boolean;
        };
        setAgentSettings({
          configured: s.configured ?? false,
          model: s.model ?? "gpt-5.4",
          enabled: s.enabled ?? true,
          access: s.access ?? false,
        });
      })
      .catch(() => {
        // 403 means no access (not in AI group); other errors = assume no access
        setAgentSettings({ configured: false, model: "gpt-5.4", enabled: true, access: false });
      });
  }, []);

  const clearMessages = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setMessages([]);
    setError(null);
    setPreviousResponseId(null);
    setChatCollectionId(null);
    setChatCollectionName(null);
  }, []);

  const sendMessage = useCallback(
    async (userText: string, context?: AgentContextValue | null, safeMode?: boolean, targetCollectionId?: number | null) => {
      setError(null);
      setIsLoading(true);

      const userMsg: ChatMessage = {
        id: makeId(),
        role: "user",
        content: userText,
      };
      setMessages(prev => [...prev, userMsg]);

      // Optimistic loading bubble while waiting for the first SSE event
      const loadingId = makeId();
      setMessages(prev => [
        ...prev,
        { id: loadingId, role: "assistant", content: null },
      ]);

      const body: Record<string, unknown> = { message: userText };
      if (previousResponseId) {
        body.previous_response_id = previousResponseId;
      }
      if (context) {
        body.context = {
          id: context.id,
          name: context.name,
          model: context.model,
          ...(context.db_id != null ? { db_id: context.db_id } : {}),
          ...(context.url_params ? { url_params: context.url_params } : {}),
          ...(context.dataset_query ? { dataset_query: context.dataset_query } : {}),
        };
      }
      if (safeMode) {
        body.safe_mode = true;
      }
      const effectiveCollectionId = targetCollectionId ?? chatCollectionId;
      if (effectiveCollectionId) {
        body.chat_collection_id = effectiveCollectionId;
      }

      // Map of tool_name → message_id for tracking running tools
      const toolMsgIds = new Map<string, string>();
      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (api.sessionToken) {
          headers["X-Metabase-Session"] = api.sessionToken;
        }

        const response = await fetch("/api/ai-agent/chat-stream", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw new Error(`Server error: ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let loadingRemoved = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE events (separated by \n\n)
          const events = parseSSE(buffer);
          // Keep any incomplete trailing text in buffer
          const lastDoubleNewline = buffer.lastIndexOf("\n\n");
          if (lastDoubleNewline >= 0) {
            buffer = buffer.slice(lastDoubleNewline + 2);
          }

          for (const evt of events) {
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(evt.data);
            } catch {
              continue;
            }

            if (evt.event === "tool_start") {
              // Remove loading bubble on first tool event
              if (!loadingRemoved) {
                setMessages(prev => prev.filter(m => m.id !== loadingId));
                loadingRemoved = true;
              }
              const toolName = parsed.name as string;
              const msgId = makeId();
              toolMsgIds.set(toolName, msgId);
              setMessages(prev => [
                ...prev,
                {
                  id: msgId,
                  role: "tool" as const,
                  content: null,
                  toolStatus: "running" as const,
                  toolName,
                },
              ]);
            } else if (evt.event === "tool_result") {
              const toolName = parsed.name as string;
              const result = parsed.result as string;
              const existingId = toolMsgIds.get(toolName);
              if (existingId) {
                // Update the running tool message to done/error
                setMessages(prev =>
                  prev.map(m =>
                    m.id === existingId
                      ? {
                          ...m,
                          content: result,
                          toolStatus: result.startsWith("Error") ? "error" as const : "done" as const,
                          toolResult: result,
                        }
                      : m,
                  ),
                );
              }
            } else if (evt.event === "done") {
              // Remove loading bubble if no tools ran
              if (!loadingRemoved) {
                setMessages(prev => prev.filter(m => m.id !== loadingId));
                loadingRemoved = true;
              }

              const doneData = parsed as unknown as AgentResponse;

              // Final assistant text
              const rawContent = doneData.content ?? "";
              const { blocks, suggestions } = parseResponse(rawContent);
              const assistantMsg: ChatMessage = {
                id: makeId(),
                role: "assistant",
                content: blocks ? null : rawContent,
                blocks,
                suggestions,
              };
              setMessages(prev => [...prev, assistantMsg]);

              if (doneData.response_id) {
                setPreviousResponseId(doneData.response_id);
              }
              if (doneData.chat_collection_id) {
                setChatCollectionId(doneData.chat_collection_id);
                if (doneData.chat_collection_name) {
                  setChatCollectionName(doneData.chat_collection_name);
                }
              }
            } else if (evt.event === "error") {
              throw new Error((parsed.message as string) || "Stream error");
            }
          }
        }
      } catch (err: unknown) {
        if ((err as Error).name === "AbortError") {
          // User cleared chat — ignore
        } else {
          setMessages(prev => prev.filter(m => m.id !== loadingId));
          const errMsg =
            err instanceof Error ? err.message : "An unexpected error occurred";
          setError(errMsg);
          setMessages(prev => [
            ...prev,
            {
              id: makeId(),
              role: "assistant",
              content: `Sorry, I encountered an error: ${errMsg}`,
            },
          ]);
        }
      } finally {
        abortRef.current = null;
        setIsLoading(false);
      }
    },
    [previousResponseId, chatCollectionId],
  );

  return {
    messages,
    isLoading,
    error,
    agentSettings,
    chatCollectionId,
    chatCollectionName,
    sendMessage,
    clearMessages,
  };
}
