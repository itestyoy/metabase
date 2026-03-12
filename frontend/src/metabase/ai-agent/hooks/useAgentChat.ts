import { useCallback, useState } from "react";

import { METABASE_TOOLS } from "../tools/definitions";
import { executeTool } from "../tools/executor";
import type { AgentSettings, ChatMessage, ToolCall } from "../types";

const STORAGE_KEY = "metabase_ai_agent_settings";
const MAX_TOOL_ITERATIONS = 10;

export function loadSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {
    // ignore
  }
  return { openaiApiKey: "", model: "gpt-4o" };
}

export function saveSettings(settings: AgentSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function makeId(): string {
  return Math.random().toString(36).slice(2);
}

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export function useAgentChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettingsState] = useState<AgentSettings>(loadSettings);

  const updateSettings = useCallback((next: AgentSettings) => {
    saveSettings(next);
    setSettingsState(next);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setError(null);
  }, []);

  const sendMessage = useCallback(
    async (userText: string) => {
      if (!settings.openaiApiKey) {
        setError(
          "OpenAI API key is not configured. Click the gear icon to set it up.",
        );
        return;
      }

      setError(null);
      setIsLoading(true);

      const userMsg: ChatMessage = {
        id: makeId(),
        role: "user",
        content: userText,
      };

      setMessages(prev => [...prev, userMsg]);

      // Build the conversation history for OpenAI
      const systemPrompt: OpenAIMessage = {
        role: "system",
        content: `You are a helpful Metabase assistant. You help users analyze data, create questions (saved queries), explore databases, and manage their Metabase instance.

When a user asks you to do something (like "create a question showing monthly revenue"), you should:
1. First explore the available databases and their schemas if needed
2. Understand the data structure
3. Write an appropriate SQL query
4. Preview the query results if uncertain
5. Create and save the question

Always be proactive: if a user asks to create a question without specifying a database, discover available databases first.
When creating SQL queries, prefer clear column aliases and readable formatting.
After creating a question, provide the direct link so the user can navigate to it.`,
      };

      // Convert chat history to OpenAI format
      const historyMessages: OpenAIMessage[] = [];
      for (const msg of messages) {
        if (msg.role === "user" || msg.role === "assistant") {
          const m: OpenAIMessage = { role: msg.role, content: msg.content };
          if (msg.tool_calls) {
            m.tool_calls = msg.tool_calls;
          }
          historyMessages.push(m);
        } else if (msg.role === "tool" && msg.tool_call_id) {
          historyMessages.push({
            role: "tool",
            content: msg.content,
            tool_call_id: msg.tool_call_id,
          });
        }
      }

      // Add current user message
      historyMessages.push({ role: "user", content: userText });

      const apiMessages = [systemPrompt, ...historyMessages];

      try {
        let iterations = 0;

        while (iterations < MAX_TOOL_ITERATIONS) {
          iterations++;

          const response = await fetch(
            "https://api.openai.com/v1/chat/completions",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${settings.openaiApiKey}`,
              },
              body: JSON.stringify({
                model: settings.model || "gpt-4o",
                messages: apiMessages,
                tools: METABASE_TOOLS,
                tool_choice: "auto",
                max_tokens: 4096,
              }),
            },
          );

          if (!response.ok) {
            const errBody = await response.text();
            throw new Error(
              `OpenAI API error ${response.status}: ${errBody}`,
            );
          }

          const data = await response.json();
          const choice = data.choices?.[0];

          if (!choice) {
            throw new Error("No response from OpenAI");
          }

          const assistantMsg = choice.message;

          // Add assistant message to OpenAI history
          apiMessages.push(assistantMsg);

          if (
            choice.finish_reason === "tool_calls" &&
            assistantMsg.tool_calls?.length
          ) {
            // Show assistant thinking message (if any content)
            if (assistantMsg.content) {
              const thinkingMsg: ChatMessage = {
                id: makeId(),
                role: "assistant",
                content: assistantMsg.content,
                tool_calls: assistantMsg.tool_calls,
              };
              setMessages(prev => [...prev, thinkingMsg]);
            }

            // Execute each tool call
            for (const toolCall of assistantMsg.tool_calls) {
              const toolName = toolCall.function.name;
              let parsedArgs: Record<string, unknown> = {};
              try {
                parsedArgs = JSON.parse(toolCall.function.arguments);
              } catch {
                // ignore parse errors
              }

              // Add "running" tool message to UI
              const runningMsg: ChatMessage = {
                id: makeId(),
                role: "tool",
                content: null,
                tool_call_id: toolCall.id,
                toolStatus: "running",
                toolName,
              };
              setMessages(prev => [...prev, runningMsg]);

              // Execute the tool
              const result = await executeTool(toolName, parsedArgs);

              // Update the tool message with result
              setMessages(prev =>
                prev.map(m =>
                  m.tool_call_id === toolCall.id
                    ? {
                        ...m,
                        content: result,
                        toolStatus: result.startsWith("Error") ? "error" : "done",
                        toolResult: result,
                      }
                    : m,
                ),
              );

              // Add tool result to OpenAI history
              apiMessages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: result,
              });
            }

            // Continue the loop to get the next assistant response
            continue;
          }

          // Regular text response - done
          const finalMsg: ChatMessage = {
            id: makeId(),
            role: "assistant",
            content: assistantMsg.content || "",
          };
          setMessages(prev => [...prev, finalMsg]);
          break;
        }

        if (iterations >= MAX_TOOL_ITERATIONS) {
          setMessages(prev => [
            ...prev,
            {
              id: makeId(),
              role: "assistant",
              content:
                "I reached the maximum number of tool calls. Please try a more specific request.",
            },
          ]);
        }
      } catch (err: unknown) {
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
    [messages, settings],
  );

  return {
    messages,
    isLoading,
    error,
    settings,
    updateSettings,
    sendMessage,
    clearMessages,
  };
}
