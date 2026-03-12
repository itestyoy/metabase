import type { OpenAITool } from "../types";

export const METABASE_TOOLS: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "list_databases",
      description:
        "List all available databases in Metabase that the current user has access to.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_database_schema",
      description:
        "Get the schema of a specific database: its tables and their columns. Use this to understand data structure before creating questions.",
      parameters: {
        type: "object",
        properties: {
          database_id: {
            type: "number",
            description: "The ID of the database to get schema for.",
          },
        },
        required: ["database_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_questions",
      description:
        "List existing questions (saved queries) in Metabase. Useful to find if a similar question already exists.",
      parameters: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description: "Optional search term to filter questions by name.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_items",
      description:
        "Search across all Metabase items: questions, dashboards, collections, tables, etc.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query string.",
          },
          type: {
            type: "string",
            enum: ["question", "dashboard", "collection", "table", "metric"],
            description: "Optional: filter results by item type.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_query",
      description:
        "Execute a native SQL query against a database and return the results. Use to preview data or validate a query before creating a question.",
      parameters: {
        type: "object",
        properties: {
          database_id: {
            type: "number",
            description: "The database ID to run the query against.",
          },
          sql: {
            type: "string",
            description: "The SQL query to execute.",
          },
        },
        required: ["database_id", "sql"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_question",
      description:
        "Create and save a new question (saved query) in Metabase. Can create both native SQL questions and MBQL structured questions.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name/title of the question.",
          },
          description: {
            type: "string",
            description: "Optional description for the question.",
          },
          database_id: {
            type: "number",
            description: "The database ID this question queries.",
          },
          sql: {
            type: "string",
            description:
              "Native SQL query. Use this for custom SQL questions. Provide either sql or mbql, not both.",
          },
          collection_id: {
            type: "number",
            description:
              "Optional collection ID to save the question into. Omit to save to root collection.",
          },
          display: {
            type: "string",
            enum: [
              "table",
              "bar",
              "line",
              "pie",
              "scalar",
              "row",
              "area",
              "combo",
            ],
            description:
              "The visualization type. Default is 'table' for tabular data.",
          },
        },
        required: ["name", "database_id", "sql"],
      },
    },
  },
];
