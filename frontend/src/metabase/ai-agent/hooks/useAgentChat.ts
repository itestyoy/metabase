import { useCallback, useEffect, useRef, useState } from "react";

import api from "metabase/lib/api";

import type { AgentContextValue } from "../AgentContextPicker";
import type { AgentDatasource } from "../AgentDatasourcePicker";
import type { ChatMessage, ContentBlock } from "../types";

const STORAGE_KEY = "ai-agent-chat-state";

interface PersistedChatState {
  messages: ChatMessage[];
  previousResponseId: string | null;
  chatCollectionId: number | null;
  chatCollectionName: string | null;
}

function saveChatState(state: PersistedChatState) {
  try {
    // Filter out transient tool "running" states before saving
    const messages = state.messages.filter(
      m => m.toolStatus !== "running",
    );
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...state, messages }),
    );
  } catch {
    // Storage full or unavailable — silently ignore
  }
}

function loadChatState(): PersistedChatState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedChatState;
    if (!Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearChatState() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

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
      return typeof block.name === "string" && block.dataset_query != null && typeof block.dataset_query === "object";
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
  default_database?: { id: number; name: string } | null;
  max_file_bytes?: number | null;
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
  const savedState = useRef(loadChatState()).current;
  const [messages, setMessages] = useState<ChatMessage[]>(
    savedState?.messages ?? [],
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previousResponseId, setPreviousResponseId] = useState<string | null>(
    savedState?.previousResponseId ?? null,
  );
  const [chatCollectionId, setChatCollectionId] = useState<number | null>(
    savedState?.chatCollectionId ?? null,
  );
  const [chatCollectionName, setChatCollectionName] = useState<string | null>(
    savedState?.chatCollectionName ?? null,
  );
  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(
    null,
  );
  const abortRef = useRef<AbortController | null>(null);
  const lastSendArgsRef = useRef<{
    text: string;
    context?: AgentContextValue | null;
    safeMode?: boolean;
    collectionId?: number | null;
    datasource?: AgentDatasource | null;
  } | null>(null);

  // Persist chat state to sessionStorage on every change
  useEffect(() => {
    saveChatState({
      messages,
      previousResponseId,
      chatCollectionId,
      chatCollectionName,
    });
  }, [messages, previousResponseId, chatCollectionId, chatCollectionName]);

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
        const full = s as {
          default_database?: { id: number; name: string } | null;
          max_file_bytes?: number | null;
        };
        setAgentSettings({
          configured: s.configured ?? false,
          model: s.model ?? "gpt-5.4",
          enabled: s.enabled ?? true,
          access: s.access ?? false,
          default_database: full.default_database ?? null,
          max_file_bytes: full.max_file_bytes ?? null,
        });
      })
      .catch(() => {
        // 403 means no access (not in AI group); other errors = assume no access
        setAgentSettings({ configured: false, model: "gpt-5.4", enabled: true, access: false });
      });
  }, []);

  const stopGeneration = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    // Remove any loading/running placeholders
    setMessages(prev =>
      prev.filter(m => m.content !== null || m.toolStatus === "done" || m.toolStatus === "error"),
    );
    setIsLoading(false);
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
    clearChatState();
    lastSendArgsRef.current = null;
  }, []);

  const sendMessage = useCallback(
    async (userText: string, context?: AgentContextValue | null, safeMode?: boolean, targetCollectionId?: number | null, datasource?: AgentDatasource | null, attachedFile?: { name: string; data: string; mimeType: string } | null) => {
      lastSendArgsRef.current = { text: userText, context, safeMode, collectionId: targetCollectionId, datasource };
      setError(null);
      setIsLoading(true);

      const userMsg: ChatMessage = {
        id: makeId(),
        role: "user",
        content: userText.replace(/\n\[Respond in [^\]]+\]$/, ""),
        timestamp: new Date().toISOString(),
        ...(attachedFile ? { attachedFile: { name: attachedFile.name, mimeType: attachedFile.mimeType } } : {}),
      };
      setMessages(prev => [...prev, userMsg]);

      // Optimistic loading bubble while waiting for the first SSE event
      const loadingId = makeId();
      setMessages(prev => [
        ...prev,
        { id: loadingId, role: "assistant", content: null },
      ]);

      // Build request — multipart when file attached, JSON otherwise
      let fetchBody: BodyInit;
      let fetchHeaders: Record<string, string> = {};
      const endpoint = attachedFile ? "/api/ai-agent/chat-stream-upload" : "/api/ai-agent/chat-stream";

      if (attachedFile) {
        // Convert base64 DataURL back to Blob for binary multipart upload
        const [meta, b64] = attachedFile.data.split(",");
        const mime = meta.replace("data:", "").replace(";base64", "");
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: mime });

        const form = new FormData();
        form.append("file", blob, attachedFile.name);
        form.append("message", userText.trim() || "");
        if (previousResponseId) form.append("previous_response_id", previousResponseId);
        if (context) form.append("context", JSON.stringify({
          id: context.id, name: context.name, model: context.model,
          ...(context.db_id != null ? { db_id: context.db_id } : {}),
          ...(context.url_params ? { url_params: context.url_params } : {}),
          ...(context.dataset_query ? { dataset_query: context.dataset_query } : {}),
        }));
        if (datasource) form.append("datasource", JSON.stringify({
          type: datasource.type, id: datasource.id, name: datasource.name,
          ...(datasource.db_id != null ? { db_id: datasource.db_id } : {}),
        }));
        if (safeMode) form.append("safe_mode", "true");
        const effectiveCollectionId = targetCollectionId ?? chatCollectionId;
        if (effectiveCollectionId) form.append("chat_collection_id", String(effectiveCollectionId));
        fetchBody = form;
        // Don't set Content-Type — browser sets it with boundary automatically
      } else {
        const jsonBody: Record<string, unknown> = { message: userText };
        if (previousResponseId) jsonBody.previous_response_id = previousResponseId;
        if (context) {
          jsonBody.context = {
            id: context.id, name: context.name, model: context.model,
            ...(context.db_id != null ? { db_id: context.db_id } : {}),
            ...(context.url_params ? { url_params: context.url_params } : {}),
            ...(context.dataset_query ? { dataset_query: context.dataset_query } : {}),
          };
        }
        if (datasource) {
          jsonBody.datasource = {
            type: datasource.type, id: datasource.id, name: datasource.name,
            ...(datasource.db_id != null ? { db_id: datasource.db_id } : {}),
          };
        }
        if (safeMode) jsonBody.safe_mode = true;
        const effectiveCollectionId = targetCollectionId ?? chatCollectionId;
        if (effectiveCollectionId) jsonBody.chat_collection_id = effectiveCollectionId;
        fetchBody = JSON.stringify(jsonBody);
        fetchHeaders = { "Content-Type": "application/json" };
      }

      // Map of tool_name → message_id for tracking running tools
      const toolMsgIds = new Map<string, string>();
      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        if (api.sessionToken) {
          fetchHeaders["X-Metabase-Session"] = api.sessionToken;
        }

        const response = await fetch(endpoint, {
          method: "POST",
          headers: fetchHeaders,
          body: fetchBody,
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
            } else if (evt.event === "mcp_approval_request") {
              // MCP tool wants approval before executing
              if (!loadingRemoved) {
                setMessages(prev => prev.filter(m => m.id !== loadingId));
                loadingRemoved = true;
              }
              const approvalData = parsed as { response_id: string; tools: { id: string; name: string; arguments: string; server_label: string }[] };
              const msgId = makeId();
              setMessages(prev => [
                ...prev,
                {
                  id: msgId,
                  role: "tool" as const,
                  content: null,
                  toolStatus: "running" as const,
                  toolName: "mcp_approval",
                  mcpApproval: {
                    responseId: approvalData.response_id,
                    tools: approvalData.tools,
                  },
                },
              ]);
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
                timestamp: new Date().toISOString(),
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
              timestamp: new Date().toISOString(),
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

  const retryLastMessage = useCallback(() => {
    const args = lastSendArgsRef.current;
    if (!args) return;
    // Remove the last error message and the failed user message
    setMessages(prev => {
      const copy = [...prev];
      if (copy.length > 0 && copy[copy.length - 1].role === "assistant" && copy[copy.length - 1].content?.startsWith("Sorry, I encountered")) {
        copy.pop();
      }
      if (copy.length > 0 && copy[copy.length - 1].role === "user") {
        copy.pop();
      }
      return copy;
    });
    setError(null);
    sendMessage(args.text, args.context, args.safeMode, args.collectionId, args.datasource);
  }, [sendMessage]);

  return {
    messages,
    isLoading,
    error,
    agentSettings,
    chatCollectionId,
    chatCollectionName,
    sendMessage,
    clearMessages,
    stopGeneration,
    retryLastMessage,
  };
}
