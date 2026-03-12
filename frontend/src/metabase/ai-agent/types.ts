export type MessageRole = "user" | "assistant" | "tool" | "system";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  tool_call_id: string;
  role: "tool";
  content: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** UI-only: tool execution status */
  toolStatus?: "running" | "done" | "error";
  toolName?: string;
  toolResult?: string;
}

export interface AgentSettings {
  openaiApiKey: string;
  model: string;
}

export type ToolName =
  | "list_databases"
  | "get_database_schema"
  | "create_question"
  | "search_items"
  | "run_query"
  | "list_questions";

export interface OpenAITool {
  type: "function";
  function: {
    name: ToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}
