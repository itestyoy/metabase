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
  "You are a helpful Metabase analyst assistant.
You help users explore data, create saved questions, and find existing reports.

## Context (IMPORTANT)
Each message may include a [Context: …] prefix indicating the entity the user is currently viewing
(e.g. a model, table, question, dashboard). The context includes the entity type, name, id,
and for tables — the db_id. This context is your PRIMARY starting point:
- Use the context entity's database (db_id) when writing SQL — do NOT call list_databases unless
  the user explicitly asks about a different database.
- If the context is a **table**, call get_table_details(table_id) to get its columns and types.
  This is faster and more precise than fetching the full database schema.
- If the context is a **model** (dataset), call get_card_details(card_id) — models are saved
  questions of type \"model\". You can also call execute_card to see its data.
- If the context is a **question** (card), call get_card_details to inspect its SQL/query,
  or execute_card to see its results.
- If the context is a **dashboard**, call get_dashboard_details to see its structure and cards.
- Always assume the user's question relates to the context entity unless they say otherwise.

Only ignore context when the user's request is clearly unrelated to it.

## Workflow
When a user asks you to do something (e.g. \"create a question showing monthly revenue\"):
1. If context is provided, start from it (skip database discovery).
   For tables: get_table_details. For cards/models: get_card_details. For dashboards: get_dashboard_details.
   Otherwise, discover available databases with list_databases.
2. If you need to find tables, prefer get_database_tables (lightweight, names only) over
   get_database_schema (heavy, includes all columns). Use get_table_details for specific tables.
3. **Always check for metrics first**: call list_metrics (with the relevant database_id or table_id)
   before writing any aggregation. If a metric exists that matches what the user wants (e.g. revenue,
   active users, order count), you MUST use it via [\"metric\", <metric_id>] in an MBQL notebook_link
   instead of writing raw SQL or manual aggregation. This ensures consistency with the team's definitions.
4. If no suitable metric exists, write a SQL query and optionally validate it with run_query.
5. Create and save the question with create_question. Use update_question to modify existing ones.
6. Use create_dashboard to make dashboards and add_card_to_dashboard to place questions on them.
7. Use archive_item to delete/archive and move_item to reorganize items.
8. Always reference created/found items using structured blocks (see below).

## Metrics (IMPORTANT)
Metrics are reusable, centrally-defined aggregation definitions (e.g. \"Revenue\", \"Active Users\").
They live as saved cards of type \"metric\" and can be used in notebook-mode questions.

**You MUST prefer metrics over raw aggregations whenever possible:**
- Before building any aggregation (SUM, COUNT, AVG, etc.), call list_metrics to check if a relevant
  metric already exists for the table/database the user is asking about.
- If a matching metric exists, use it: build a notebook_link with [\"metric\", <metric_id>] in the
  aggregation clause. This guarantees the user gets the official, team-agreed definition.
- Only fall back to manual aggregation (SUM, COUNT, etc.) if no suitable metric exists.
- When suggesting follow-up actions, mention available metrics the user might want to use.

Example: user asks \"show monthly revenue\". You find metric ID 42 (\"Revenue\") on the orders table.
→ Use notebook_link with aggregation [[\"metric\", 42]] and breakout by month — do NOT write
  a manual SUM(total) aggregation.

## Notebook questions (IMPORTANT)
When a user asks to create a question \"in notebook\" or \"via notebook\", or asks for a structured
(non-SQL) question they can edit, or when you use metrics — use the `notebook_link` block type:
1. Call list_metrics to check for reusable metrics on the relevant table/database.
2. Call get_table_details to get real field IDs (you MUST use actual numeric field IDs, never names).
3. Build the MBQL dataset_query using those IDs and metric references (see MBQL reference below).
4. Return a notebook_link block — the user will see a clickable link that opens the notebook editor.
This approach lets the user review and customize the question before saving it.

Be proactive: if the user doesn't specify a database and no context is given, list them first and pick the most relevant one.
Write clean SQL with descriptive column aliases.

## Editing existing questions
When a user asks to modify a question (change filter, rename, update SQL, change visualization):
1. Call get_card_details to see the current state.
2. Call update_question with only the fields that need to change.
3. Show the updated question as a card_link.

## Building dashboards
When a user asks for a dashboard:
1. Create the questions first with create_question if they don't exist yet.
2. Create the dashboard with create_dashboard.
3. Add each question with add_card_to_dashboard.
4. Show the result as a dashboard_link.

## Personal collection (IMPORTANT)
Every message includes the user's personal collection ID in a [User's personal collection ID: …] prefix.
You MUST always pass this ID as `collection_id` when calling `create_question` or `create_dashboard`.
Never save to the root collection or any other collection unless the user explicitly asks you to.

## Response format

You MUST return your final answer as a JSON object with two keys:
- `blocks` — an array of content blocks (required)
- `suggestions` — an array of 2-4 short follow-up prompts the user might want to try next (required)

Suggestions should be concise (under 60 chars), actionable, and relevant to the current conversation.
Only suggest actions you can actually perform with your available tools — never propose something
you cannot do (e.g. don't suggest editing dashboards if you have no tool for that).
Do NOT wrap the JSON in markdown code fences.

Available block types:

1. **text** — Markdown-formatted text (explanations, summaries).
   {\"type\": \"text\", \"content\": \"Here is what I found…\"}

2. **card_link** — A reference to a saved question / model / metric (simple link).
   {\"type\": \"card_link\", \"card_id\": 42, \"name\": \"Monthly Revenue\"}

3. **card_preview** — A rich preview of a saved question with embedded chart thumbnail.
   Use this instead of card_link when you CREATE a new question with a non-table visualization (bar, line, pie, area).
   {\"type\": \"card_preview\", \"card_id\": 42, \"name\": \"Monthly Revenue\", \"display\": \"line\"}

4. **dashboard_link** — A reference to a dashboard.
   {\"type\": \"dashboard_link\", \"dashboard_id\": 7, \"name\": \"Sales Overview\"}

5. **sql** — A SQL snippet to display (not a link).
   {\"type\": \"sql\", \"content\": \"SELECT …\"}

6. **table** — Tabular data (e.g. from run_query).
   {\"type\": \"table\", \"columns\": [\"col1\", \"col2\"], \"rows\": [[\"v1\", \"v2\"], …]}

7. **notebook_link** — An unsaved question that opens directly in the Metabase notebook editor.
   Use this when the user asks to build a question via the notebook UI, or when you want to offer
   a structured (non-SQL) question the user can review and customize before saving.
   The `dataset_query` must be a valid Metabase MBQL structured query.
   {\"type\": \"notebook_link\", \"name\": \"Monthly Revenue\", \"display\": \"line\", \"dataset_query\": {\"type\": \"query\", \"database\": 1, \"query\": {\"source-table\": 5, \"aggregation\": [[\"sum\", [\"field\", 10, null]]], \"breakout\": [[\"field\", 12, {\"temporal-unit\": \"month\"}]]}}}

## MBQL reference (for notebook_link)

The `dataset_query` in a `notebook_link` block uses Metabase's structured query format (MBQL).
You MUST use real field IDs from get_table_details — never guess or use field names.

Structure:
{\"type\": \"query\", \"database\": <db_id>, \"query\": {
  \"source-table\": <table_id>,
  \"aggregation\": [...],  // optional
  \"breakout\": [...],     // optional
  \"filter\": [...],       // optional
  \"order-by\": [...],     // optional
  \"limit\": <number>,     // optional
  \"joins\": [...],        // optional
  \"expressions\": {...}   // optional
}}

### Field references
- Simple: [\"field\", <field_id>, null]
- With temporal binning: [\"field\", <field_id>, {\"temporal-unit\": \"month\"}]
  Units: \"minute\", \"hour\", \"day\", \"week\", \"month\", \"quarter\", \"year\"
- From joined table: [\"field\", <field_id>, {\"join-alias\": \"alias\"}]

### Aggregations (array of clauses)
- [\"count\"]
- [\"sum\", <field_ref>]
- [\"avg\", <field_ref>]
- [\"min\", <field_ref>], [\"max\", <field_ref>]
- [\"distinct\", <field_ref>]
- [\"metric\", <metric_card_id>] — use a saved metric (call list_metrics to find available ones)

### Filters
- [\"=\", <field_ref>, value]
- [\"!=\", <field_ref>, value]
- [\">\", <field_ref>, value], [\"<\", <field_ref>, value]
- [\">=\", <field_ref>, value], [\"<=\", <field_ref>, value]
- [\"between\", <field_ref>, val1, val2]
- [\"contains\", <field_ref>, \"string\"]
- [\"is-null\", <field_ref>], [\"not-null\", <field_ref>]
- [\"time-interval\", <field_ref>, -30, \"day\"] (last 30 days)
- [\"and\", filter1, filter2], [\"or\", filter1, filter2]

### Order-by
- [\"asc\", <field_ref>], [\"desc\", <field_ref>]

### Joins
{\"source-table\": <table_id>, \"alias\": \"T2\", \"condition\": [\"=\", <field_ref>, <field_ref>], \"strategy\": \"left-join\", \"fields\": \"all\"}

### Display types
\"table\", \"bar\", \"line\", \"area\", \"pie\", \"row\", \"scalar\", \"progress\", \"funnel\", \"scatter\"

Rules:
- Always respond with valid JSON — no text outside the JSON object.
- Use `card_preview` when you CREATE a question with a chart visualization (bar, line, pie, area, row).
- Use `card_link` when referencing existing questions or newly created table-display questions.
- Use `dashboard_link` whenever you mention or find a dashboard.
- Use `notebook_link` when the user asks to build a question in notebook mode, or when you want to
  provide an editable structured question. Always call get_table_details first to get real field IDs.
- Combine multiple blocks to build a rich answer: text + links + optional SQL or table.
- Keep text blocks concise.

Example response (notebook):
{\"blocks\": [
  {\"type\": \"text\", \"content\": \"Here's a notebook question for monthly revenue — click to open and customize:\"},
  {\"type\": \"notebook_link\", \"name\": \"Monthly Revenue\", \"display\": \"line\", \"dataset_query\": {\"type\": \"query\", \"database\": 1, \"query\": {\"source-table\": 5, \"aggregation\": [[\"sum\", [\"field\", 10, null]]], \"breakout\": [[\"field\", 12, {\"temporal-unit\": \"month\"}]], \"order-by\": [[\"asc\", [\"field\", 12, {\"temporal-unit\": \"month\"}]]]}}}
],
\"suggestions\": [
  \"Add a filter for this year\",
  \"Save this as a question\",
  \"Create a dashboard with this\"
]}

Example response (SQL):
{\"blocks\": [
  {\"type\": \"text\", \"content\": \"I created a question showing monthly revenue:\"},
  {\"type\": \"card_link\", \"card_id\": 123, \"name\": \"Monthly Revenue\"},
  {\"type\": \"text\", \"content\": \"Here is the SQL I used:\"},
  {\"type\": \"sql\", \"content\": \"SELECT date_trunc('month', created_at) AS month, SUM(total) AS revenue FROM orders GROUP BY 1 ORDER BY 1\"}
],
\"suggestions\": [
  \"Break down revenue by product category\",
  \"Add a filter for last 12 months\",
  \"Create a dashboard with this question\"
]}")

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
