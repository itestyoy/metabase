export type MessageRole = "user" | "assistant" | "tool";

/** Structured content blocks returned by the AI agent. */
export type ContentBlock =
  | { type: "text"; content: string }
  | { type: "card_link"; card_id: number; name: string }
  | { type: "dashboard_link"; dashboard_id: number; name: string }
  | { type: "sql"; content: string }
  | { type: "table"; columns: string[]; rows: unknown[][] };

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string | null;
  /** Parsed structured blocks from JSON response (assistant only). */
  blocks?: ContentBlock[];
  /** Follow-up suggestions from the AI (assistant only). */
  suggestions?: string[];
  /** UI-only: tool execution status */
  toolStatus?: "done" | "error";
  toolName?: string;
  toolResult?: string;
}
