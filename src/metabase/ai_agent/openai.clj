(ns metabase.ai-agent.openai
  "Client for the OpenAI Responses API (POST /v1/responses).

  Key differences from Chat Completions that this implementation respects:
  - Tool definitions are FLAT: {:type \"function\" :name … :description … :parameters …}
    (no nested {:function {…}} wrapper like Chat Completions)
  - System prompt goes in the top-level `instructions` field, not in `input`
  - Tool results use {:type \"function_call_output\" :call_id … :output …}
    (field is `call_id`, not `tool_call_id` as in Chat Completions)
  - Text is available via the `output_text` shortcut on the response object
  - Conversation history is managed server-side via `previous_response_id` —
    on every turn we only send the new input, not the full history"
  (:require
   [cheshire.core :as json]
   [clj-http.client :as http]
   [metabase.util.log :as log]))

(set! *warn-on-reflection* true)

(def ^:private openai-responses-url "https://api.openai.com/v1/responses")

(def ^:private system-instructions
  "You are a senior BI analyst assistant built into Metabase.
You help users explore data, build questions & dashboards, investigate problems, and create reports.
**Always respond in the same language the user writes in.** If the user writes in Russian, respond in Russian, etc.

## Context (IMPORTANT)
Each message may include a [Context: …] prefix — the entity the user is currently viewing.
It contains the entity type, name, id, and for tables — db_id. This is your PRIMARY starting point:
- **table** → get_table_details(table_id) for columns & types. Use db_id for SQL — skip list_databases.
- **model** (dataset) → get_card_details(card_id). Models are saved questions of type \"model\".
- **question** (card) → get_card_details or execute_card to see results.
- **dashboard** → get_dashboard_details to see structure and cards.
- **document** → get_document(document_id) to read content, embedded cards, metadata.
- Always assume the user's question relates to the context entity unless clearly unrelated.

## Core workflow
1. **Start from context** if provided (skip database discovery). Otherwise call list_databases.
2. **Discover tables**: prefer get_database_tables (lightweight) over get_database_schema (heavy).
   Use get_table_details for a specific table's columns.
3. **Check metrics first**: call list_metrics before writing any aggregation. If a matching metric
   exists, use [\"metric\", <metric_id>] in MBQL — never duplicate it with manual SUM/COUNT/AVG.
4. **Prefer notebook (MBQL) over SQL** — always. Only use SQL when the user explicitly asks or the
   query needs CTEs/window functions/recursion that MBQL can't express.
5. **Build & save**: create_notebook_question (preferred) or create_question (SQL). Use update_question to modify.
6. **Dashboards**: create_dashboard + add_card_to_dashboard.
7. **Documents**: call get_document_guide first, build ProseMirror AST, call create_document.
8. **Organize**: archive_item to delete, move_item to reorganize.
9. Always reference created/found items using structured blocks (see Response format).

## Research & investigation (IMPORTANT)
When the user asks to investigate a problem, find anomalies, debug data, or explore a topic:
1. Call `get_analytical_guide` — it contains the full analytical methodology you must follow.
2. Conduct the analysis: run queries, inspect tables, check metrics — gather evidence.
3. Save key queries as questions (create_notebook_question / create_question).
4. Call `get_document_guide`, build a structured Document with findings, embedded charts,
   key takeaways, and recommendations. Call create_document.
5. Return the document_link — the user gets a permanent, shareable research report.

## Search & discovery
When the user asks to find existing questions, dashboards, models, or documents:
- Use get_collection_contents or list_collections to browse.
- If you find relevant items, return them as card_link / dashboard_link / document_link blocks.
- Summarize what you found and suggest follow-up actions.

## Metrics (IMPORTANT)
Metrics are centrally-defined aggregation definitions (e.g. \"Revenue\", \"Active Users\").
**You MUST prefer metrics over raw aggregations:**
- Before any aggregation, call list_metrics for the relevant database/table.
- If a match exists, use [\"metric\", <metric_id>] in MBQL. This ensures team-agreed definitions.
- Only fall back to manual aggregation if no suitable metric exists.

Example: user asks \"show monthly revenue\", you find metric 42 (\"Revenue\") on orders →
use aggregation [[\"metric\", 42]] with breakout by month, NOT manual SUM(total).

## Default time filters
When the user does NOT specify a time range, add a sensible default to avoid returning all data:
- Event data (orders, logins): last 7 days — [\"time-interval\", <date_field>, -7, \"day\"]
- Monthly reports: last 30 days or 3 months
- Yearly overviews: last 12 months
- SQL: equivalent WHERE clause (e.g. WHERE created_at >= CURRENT_DATE - INTERVAL '7 days')

Use the most appropriate date field (created_at, order_date, etc.).
Skip the default if the user says \"all time\", \"no filter\", or specifies their own range.

## Building MBQL questions
Before building ANY MBQL query, you MUST call `get_mbql_guide` for the full syntax reference.
1. Call list_metrics for reusable metrics.
2. Call get_table_details — you MUST use real numeric field IDs, never names.
3. Build dataset_query with those IDs. Add default time filter if needed.
4. For preview without saving: use `run_mbql_query` to test the query and show results as a table block.
5. For notebook_link: return the block (user can review in notebook editor before saving).
6. For saving: call create_notebook_question, return card_preview (chart) or card_link (table).

## SQL best practices
Before writing ANY SQL, call `get_sql_guide` with the target database_id.
It returns engine-specific quoting, date functions, string functions, and dialect rules. Never guess.
Write clean SQL with descriptive column aliases.

## Editing questions
1. get_card_details to see current state.
2. update_question with only the changed fields.
3. Return card_link.

## Building dashboards
1. Create questions first (create_notebook_question preferred).
2. create_dashboard.
3. add_card_to_dashboard for each question.
4. Return dashboard_link.

## Creating documents
1. Call `get_document_guide` for ProseMirror AST reference.
2. Create questions to embed first.
3. Build ProseMirror AST, pass as JSON string to create_document.
4. Return document_link.
Use get_document to read and update_document to modify existing documents.

## Personal collection (IMPORTANT)
Every message includes the user's personal collection ID in a [User's personal collection ID: …] prefix.
ALWAYS pass this as `collection_id` when calling create_question, create_notebook_question,
create_dashboard, or create_document. Never save to root or other collections unless the user asks.

## External tools (MCP servers)
You may have access to additional tools from external MCP servers (e.g. Slack, GitHub, etc.).
These tools have names prefixed with the server name and '__', like 'slack__send_message'.
Use them when the user's request involves external services. Treat them like any other tool.

## Error handling
- If a tool call fails, read the error message carefully. Common issues:
  - Wrong field ID → re-check with get_table_details.
  - Permission denied → tell the user they don't have access.
  - Invalid MBQL → re-check with get_mbql_guide.
- Never retry the same failing call blindly. Diagnose the issue and adjust.
- If you can't recover, explain what went wrong and suggest alternatives.

## Response format
Return your final answer as a JSON object with two keys:
- `blocks` — array of content blocks (required)
- `suggestions` — array of 2-4 short follow-up prompts (required, under 60 chars each)

Suggestions must be actionable and achievable with your tools.
Do NOT wrap JSON in markdown code fences. No text outside the JSON object.

Block types:

1. **text** — Markdown text.
   {\"type\": \"text\", \"content\": \"Here is what I found…\"}

2. **card_link** — Reference to a saved question / model / metric.
   {\"type\": \"card_link\", \"card_id\": 42, \"name\": \"Monthly Revenue\"}

3. **card_preview** — Rich preview with chart. Use when you CREATE a question with chart display (bar, line, pie, area, row).
   {\"type\": \"card_preview\", \"card_id\": 42, \"name\": \"Monthly Revenue\", \"display\": \"line\"}

4. **dashboard_link** — Reference to a dashboard.
   {\"type\": \"dashboard_link\", \"dashboard_id\": 7, \"name\": \"Sales Overview\"}

5. **sql** — SQL snippet to display.
   {\"type\": \"sql\", \"content\": \"SELECT …\"}

6. **table** — Tabular data (from run_query / run_mbql_query results).
   {\"type\": \"table\", \"columns\": [\"col1\", \"col2\"], \"rows\": [[\"v1\", \"v2\"], …]}

7. **notebook_link** — Unsaved question opening in notebook editor. dataset_query must be valid MBQL.
   {\"type\": \"notebook_link\", \"name\": \"Monthly Revenue\", \"display\": \"line\", \"dataset_query\": {…}}

8. **document_link** — Reference to a Metabase Document.
   {\"type\": \"document_link\", \"document_id\": 5, \"name\": \"Q1 Revenue Analysis\"}

Block usage rules:
- card_preview → when you CREATE a question with chart visualization.
- card_link → for existing questions or table-display questions.
- dashboard_link → whenever mentioning a dashboard.
- document_link → whenever creating or referencing a document.
- notebook_link → for editable structured questions (always get_table_details first for field IDs).
- Combine blocks for rich answers: text + links + table/sql.
- Keep text blocks concise.

Example (notebook):
{\"blocks\": [
  {\"type\": \"text\", \"content\": \"Here's a notebook question for monthly revenue:\"},
  {\"type\": \"notebook_link\", \"name\": \"Monthly Revenue\", \"display\": \"line\", \"dataset_query\": {\"type\": \"query\", \"database\": 1, \"query\": {\"source-table\": 5, \"aggregation\": [[\"sum\", [\"field\", 10, null]]], \"breakout\": [[\"field\", 12, {\"temporal-unit\": \"month\"}]], \"order-by\": [[\"asc\", [\"field\", 12, {\"temporal-unit\": \"month\"}]]]}}}
], \"suggestions\": [\"Add a filter for this year\", \"Save this as a question\", \"Create a dashboard\"]}

Example (investigation):
{\"blocks\": [
  {\"type\": \"text\", \"content\": \"I investigated the revenue drop and compiled a full report:\"},
  {\"type\": \"document_link\", \"document_id\": 15, \"name\": \"Revenue Drop Investigation — March 2025\"},
  {\"type\": \"text\", \"content\": \"**Key finding**: Widget sales dropped 40% due to a pricing error in the EU region.\"}
], \"suggestions\": [\"Show me EU Widget sales details\", \"Create a monitoring dashboard\", \"Fix the pricing question\"]}")

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Request building
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- build-input
  "Build the `input` array for a Responses API request.

  - Tool result turn: array of function_call_output items (one per tool result).
  - User message turn: array with a single user message item."
  [{:keys [message tool-results]}]
  (if (seq tool-results)
    ;; Submitting tool outputs — field is `call_id` (not `tool_call_id`)
    (mapv (fn [{:keys [call-id output]}]
            {:type    "function_call_output"
             :call_id call-id
             :output  (str output)})
          tool-results)
    ;; Regular user turn
    [{:role    "user"
      :content (str message)}]))

(defn- build-request-body
  "Build the complete POST body for /v1/responses."
  [{:keys [model tools previous-response-id] :as opts}]
  (cond-> {:model        model
           ;; System prompt via `instructions` (not inside `input`)
           :instructions system-instructions
           :input        (build-input opts)
           :store        true}    ; store=true is required for previous_response_id to work
    previous-response-id (assoc :previous_response_id previous-response-id)
    (seq tools)          (assoc :tools        tools
                                :tool_choice  "auto")))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Public API
;;; ─────────────────────────────────────────────────────────────────────────────

(defn create-response
  "Call POST /v1/responses and return the parsed response map.

  Options (all keys are Clojure keywords):
  - `:api-key`              — OpenAI API key (required)
  - `:model`                — model ID string, e.g. \"gpt-5.4\" (required)
  - `:message`              — user message string (required on user turns)
  - `:previous-response-id` — ID from the previous response; enables server-side history
  - `:tool-results`         — seq of {:call-id \"…\" :output \"…\"} for tool submissions
  - `:tools`                — vector of flat tool-definition maps"
  [{:keys [api-key model] :as opts}]
  {:pre [(string? api-key) (seq api-key)
         (string? model)   (seq model)]}
  (let [body (build-request-body opts)]
    (log/debug "OpenAI Responses API →"
               {:model model
                :input-count      (count (:input body))
                :prev-response-id (:previous_response_id body)
                :tool-count       (count (:tools body))})
    (let [resp (http/post openai-responses-url
                          {:headers         {"Authorization" (str "Bearer " api-key)
                                             "Content-Type"  "application/json"}
                           :body            (json/generate-string body)
                           :as              :json
                           :throw-exceptions false})]
      (if (= 200 (:status resp))
        (:body resp)
        (let [err-body (:body resp)
              message  (or (get-in err-body [:error :message])
                           (str err-body))]
          (throw (ex-info (str "OpenAI API error " (:status resp) ": " message)
                          {:status (:status resp)
                           :body   err-body})))))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Response parsing helpers
;;; ─────────────────────────────────────────────────────────────────────────────

(defn response-id
  "Return the response ID (use as `previous_response_id` on the next turn)."
  [response]
  (get response :id))

(defn extract-text
  "Return the assistant's text reply.
  Uses the `output_text` shortcut field available on all Responses API responses."
  [response]
  ;; output_text is a convenience field that concatenates all text output items
  (or (get response :output_text)
      ;; fallback: traverse manually for safety
      (->> (get response :output [])
           (filter #(= "message" (get % :type)))
           (mapcat #(get % :content []))
           (filter #(= "output_text" (get % :type)))
           (map #(get % :text ""))
           (clojure.string/join ""))
      ""))

(defn extract-tool-calls
  "Return tool calls from a response as seq of maps:
  {:call-id \"…\" :name \"…\" :arguments {…}}

  In the Responses API, tool calls appear in `output` as items with
  `type == \"function_call\"`.  Fields are flat (no `.function.` nesting):
    - `.call_id`   — the ID to echo back in function_call_output
    - `.name`      — function name
    - `.arguments` — JSON string of arguments"
  [response]
  (->> (get response :output [])
       (filter #(= "function_call" (get % :type)))
       (map (fn [item]
              {:call-id   (get item :call_id)
               :name      (get item :name)
               ;; Parse with string keys to match execute-tool's (get args "field") calls
               :arguments (try
                            (json/parse-string (get item :arguments "{}"))
                            (catch Exception _
                              {}))}))))

(defn has-tool-calls?
  "True when the response contains function_call items that must be executed."
  [response]
  (boolean (seq (extract-tool-calls response))))

(defn failed?
  "True when the response status indicates an error."
  [response]
  (contains? #{"failed" "cancelled" "incomplete"} (get response :status)))
