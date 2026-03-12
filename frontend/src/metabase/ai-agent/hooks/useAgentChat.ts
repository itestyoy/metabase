import { useCallback, useEffect, useState } from "react";

import api from "metabase/lib/api";

import type { ChatMessage } from "../types";

function makeId(): string {
  return Math.random().toString(36).slice(2);
}

export interface AgentSettings {
  configured: boolean;
  model: string;
  enabled: boolean;
}

interface AgentResponse {
  response_id: string | null;
  content: string;
  tool_calls: Array<{
    name: string;
    args: Record<string, unknown>;
    result: string;
  }>;
}

export function useAgentChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previousResponseId, setPreviousResponseId] = useState<string | null>(
    null,
  );
  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(
    null,
  );

  // Fetch agent settings from backend (is it configured, what model)
  useEffect(() => {
    api
      .GET("/api/ai-agent/settings")({})
      .then((data: unknown) => {
        const s = data as {
          configured?: boolean;
          model?: string;
          enabled?: boolean;
        };
        setAgentSettings({
          configured: s.configured ?? false,
          model: s.model ?? "gpt-4o",
          enabled: s.enabled ?? true,
        });
      })
      .catch(() => {
        setAgentSettings({ configured: false, model: "gpt-4o", enabled: true });
      });
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setError(null);
    setPreviousResponseId(null);
  }, []);

  const sendMessage = useCallback(
    async (userText: string) => {
      setError(null);
      setIsLoading(true);

      const userMsg: ChatMessage = {
        id: makeId(),
        role: "user",
        content: userText,
      };
      setMessages(prev => [...prev, userMsg]);

      // Optimistic loading bubble while waiting for the backend
      const loadingId = makeId();
      setMessages(prev => [
        ...prev,
        { id: loadingId, role: "assistant", content: null },
      ]);

      try {
        const body: Record<string, unknown> = { message: userText };
        if (previousResponseId) {
          body.previous_response_id = previousResponseId;
        }

        const response = (await api.POST("/api/ai-agent/chat")(
          body,
        )) as AgentResponse;

        // Remove the loading bubble
        setMessages(prev => prev.filter(m => m.id !== loadingId));

        // Show tool call executions (returned by backend)
        if (response.tool_calls?.length) {
          const toolMsgs: ChatMessage[] = response.tool_calls.map(tc => ({
            id: makeId(),
            role: "tool" as const,
            content: tc.result,
            toolStatus: tc.result.startsWith("Error")
              ? ("error" as const)
              : ("done" as const),
            toolName: tc.name,
            toolResult: tc.result,
          }));
          setMessages(prev => [...prev, ...toolMsgs]);
        }

        // Final assistant text
        const assistantMsg: ChatMessage = {
          id: makeId(),
          role: "assistant",
          content: response.content ?? "",
        };
        setMessages(prev => [...prev, assistantMsg]);

        // Persist the response_id so next turn continues the conversation
        if (response.response_id) {
          setPreviousResponseId(response.response_id);
        }
      } catch (err: unknown) {
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
      } finally {
        setIsLoading(false);
      }
    },
    [previousResponseId],
  );

  return {
    messages,
    isLoading,
    error,
    agentSettings,
    sendMessage,
    clearMessages,
  };
}
