/**
 * Tool executor - runs Metabase API calls under the current user's session.
 * All requests use `api` from `metabase/lib/api` which automatically includes
 * the user's session cookie and CSRF token.
 */

import api from "metabase/lib/api";

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    switch (toolName) {
      case "list_databases":
        return await listDatabases();
      case "get_database_schema":
        return await getDatabaseSchema(args.database_id as number);
      case "list_questions":
        return await listQuestions(args.search as string | undefined);
      case "search_items":
        return await searchItems(
          args.query as string,
          args.type as string | undefined,
        );
      case "run_query":
        return await runQuery(args.database_id as number, args.sql as string);
      case "create_question":
        return await createQuestion(args);
      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (error: unknown) {
    const msg =
      error instanceof Error ? error.message : JSON.stringify(error);
    return `Error executing ${toolName}: ${msg}`;
  }
}

async function listDatabases(): Promise<string> {
  const response = await api.GET("/api/database")({});
  const databases = (response as { data?: unknown[] }).data || response;
  if (!Array.isArray(databases)) {
    return "No databases found.";
  }
  const formatted = databases.map((db: unknown) => {
    const d = db as { id: number; name: string; engine: string };
    return `- ID: ${d.id}, Name: "${d.name}", Engine: ${d.engine}`;
  });
  return `Available databases:\n${formatted.join("\n")}`;
}

async function getDatabaseSchema(databaseId: number): Promise<string> {
  const metadata = await api.GET(`/api/database/${databaseId}/metadata`)({
    include_hidden: false,
  });

  const db = metadata as {
    name: string;
    tables?: Array<{
      id: number;
      name: string;
      schema?: string;
      fields?: Array<{ name: string; base_type: string; description?: string }>;
    }>;
  };

  if (!db.tables || db.tables.length === 0) {
    return `Database "${db.name}" has no accessible tables.`;
  }

  const tablesSummary = db.tables.map(table => {
    const fields = (table.fields || [])
      .map(f => `    - ${f.name} (${f.base_type})`)
      .join("\n");
    return `Table: ${table.schema ? table.schema + "." : ""}${table.name} (ID: ${table.id})\n${fields}`;
  });

  return `Schema for database "${db.name}":\n\n${tablesSummary.join("\n\n")}`;
}

async function listQuestions(search?: string): Promise<string> {
  const params: Record<string, unknown> = { type: "question", limit: 20 };
  if (search) {
    params.q = search;
  }
  const response = await api.GET("/api/card")(params);
  const cards = Array.isArray(response) ? response : [];

  if (cards.length === 0) {
    return search
      ? `No questions found matching "${search}".`
      : "No questions found.";
  }

  const formatted = cards
    .slice(0, 20)
    .map(
      (c: unknown) => {
        const card = c as { id: number; name: string; description?: string; collection?: { name: string } };
        return `- ID: ${card.id}, Name: "${card.name}"${card.description ? `, Description: ${card.description}` : ""}${card.collection ? `, Collection: ${card.collection.name}` : ""}`;
      },
    );
  return `Questions (showing up to 20):\n${formatted.join("\n")}`;
}

async function searchItems(query: string, type?: string): Promise<string> {
  const params: Record<string, unknown> = { q: query };
  if (type) {
    params.type = type;
  }
  const response = await api.GET("/api/search")(params);
  const results = (response as { data?: unknown[] }).data || [];

  if (results.length === 0) {
    return `No results found for "${query}".`;
  }

  const formatted = results.slice(0, 15).map((item: unknown) => {
    const i = item as { model: string; id: number; name: string; description?: string; collection?: { name: string } };
    return `- [${i.model}] ID: ${i.id}, Name: "${i.name}"${i.description ? `, Desc: ${i.description.slice(0, 80)}` : ""}${i.collection ? `, In: ${i.collection.name}` : ""}`;
  });
  return `Search results for "${query}" (showing up to 15):\n${formatted.join("\n")}`;
}

async function runQuery(databaseId: number, sql: string): Promise<string> {
  const response = await api.POST("/api/dataset")({
    database: databaseId,
    type: "native",
    native: {
      query: sql,
    },
  });

  const dataset = response as {
    data?: {
      rows?: unknown[][];
      cols?: Array<{ name: string }>;
    };
    error?: string;
  };

  if (dataset.error) {
    return `Query error: ${dataset.error}`;
  }

  const cols = dataset.data?.cols || [];
  const rows = dataset.data?.rows || [];

  if (rows.length === 0) {
    return "Query executed successfully. No rows returned.";
  }

  const header = cols.map(c => c.name).join(" | ");
  const separator = cols.map(() => "---").join(" | ");
  const dataRows = rows
    .slice(0, 10)
    .map(row =>
      (row as unknown[]).map(v => (v === null ? "NULL" : String(v))).join(" | "),
    );

  const totalRows = rows.length;
  const note =
    totalRows > 10 ? `\n... (${totalRows} total rows, showing first 10)` : "";

  return `Query results:\n${header}\n${separator}\n${dataRows.join("\n")}${note}`;
}

async function createQuestion(
  args: Record<string, unknown>,
): Promise<string> {
  const {
    name,
    description,
    database_id,
    sql,
    collection_id,
    display = "table",
  } = args;

  const dataset_query = {
    database: database_id,
    type: "native",
    native: {
      query: sql,
      "template-tags": {},
    },
  };

  const body: Record<string, unknown> = {
    name,
    dataset_query,
    display,
    visualization_settings: {},
  };

  if (description) {
    body.description = description;
  }
  if (collection_id !== undefined && collection_id !== null) {
    body.collection_id = collection_id;
  }

  const card = await api.POST("/api/card")(body);
  const c = card as { id: number; name: string };

  return `Question created successfully!\n- ID: ${c.id}\n- Name: "${c.name}"\n- URL: /question/${c.id}`;
}
