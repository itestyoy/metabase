export type MessageRole = "user" | "assistant" | "tool";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string | null;
  /** UI-only: tool execution status */
  toolStatus?: "done" | "error";
  toolName?: string;
  toolResult?: string;
}
