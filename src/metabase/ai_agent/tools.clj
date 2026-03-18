(ns metabase.ai-agent.tools
  "Tool implementations executed under the current user's identity and permissions.
   All functions rely on `api/*current-user*` / `api/*current-user-id*` being bound by
   the surrounding request middleware — so results are always scoped to what the user
   is allowed to see."
  (:require
   [cheshire.core :as json]
   [clojure.java.io :as io]
   [clojure.string :as str]
   [metabase.ai-agent.mcp :as mcp]
   [metabase.api.common :as api]
   [metabase.models.interface :as mi]
   [metabase.permissions.core :as perms]
   [metabase.queries.models.card :as queries.card]
   [metabase.query-processor :as qp]
   [metabase.query-processor.util :as qp.util]
   [metabase.documents.prose-mirror :as prose-mirror]
   [metabase.search.core :as search]
   [metabase.util.log :as log]
   [toucan2.core :as t2]))

(set! *warn-on-reflection* true)

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Tool definitions (for OpenAI Responses API)
;;; ─────────────────────────────────────────────────────────────────────────────

(def tool-definitions
  "Tool schemas in the Responses API format (flat, NOT nested under a :function key).
   All tools use strict: true with additionalProperties: false for reliable parameter validation."
  [{:type        "function"
    :name        "list_databases"
    :description "List all databases in Metabase that the current user has access to. Optionally search by name."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:search {:type        ["string" "null"]
                                                  :description "Search term to filter databases by name. Pass null to list all."}}
                  :required             ["search"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "get_database_schema"
    :description "Get the full schema (tables and columns) for a specific database.
Use this before writing SQL to understand the available tables and column names."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:database_id {:type        "integer"
                                                       :description "ID of the database."}}
                  :required             ["database_id"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "list_questions"
    :description "List existing saved questions (cards) in Metabase.
Useful to check whether a similar question already exists before creating one."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:search {:type        ["string" "null"]
                                                  :description "Optional name filter (case-insensitive substring match). Pass null to list recent questions."}}
                  :required             ["search"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "search_items"
    :description "Search across all Metabase items: questions, dashboards, collections, tables, metrics."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:query {:type        "string"
                                                 :description "Search query string."}
                                         :type  {:anyOf       [{:type "string"
                                                                :enum ["question" "dashboard" "collection" "table" "metric"]}
                                                               {:type "null"}]
                                                 :description "Optional: restrict results to this item type. Pass null to search all types."}}
                  :required             ["query" "type"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "run_query"
    :description "Execute a native SQL query against a database and return results. Returns up to 50 rows.
Use this to preview data or validate SQL before saving a question."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:database_id {:type        "integer"
                                                       :description "Database ID to run the query against."}
                                         :sql         {:type        "string"
                                                       :description "SQL query to execute."}}
                  :required             ["database_id" "sql"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "execute_card"
    :description "Run an existing saved question (card) by its ID and return the results.
Use this to show the user the current data from a question they already have, or to
inspect results before referencing them in your answer."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:card_id {:type        "integer"
                                                   :description "ID of the saved question to execute."}}
                  :required             ["card_id"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "get_card_details"
    :description "Get detailed information about a saved question (card): its name, description,
dataset query (SQL or structured), visualization type, parameters, and the collection it belongs to.
Use this when the user asks about a specific question, wants to understand how it works, or you need
to inspect its query before modifying or recreating it."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:card_id {:type        "integer"
                                                   :description "ID of the saved question to inspect."}}
                  :required             ["card_id"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "get_dashboard_details"
    :description "Get detailed information about a dashboard: its name, description, parameters (filters),
and the list of cards (questions) it contains with their sizes and positions.
Use this when the user asks about a dashboard's structure, wants to know what questions are on it,
or needs to understand how its filters work."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:dashboard_id {:type        "integer"
                                                        :description "ID of the dashboard to inspect."}}
                  :required             ["dashboard_id"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "list_collections"
    :description "List Metabase collections the current user has access to.
Use this to help the user navigate their content or find where items are saved. Supports search by name."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:parent_id {:type        ["integer" "null"]
                                                     :description "Parent collection ID. Pass null to list root-level collections."}
                                         :search    {:type        ["string" "null"]
                                                     :description "Search collections by name using full-text search. Pass null to list without filtering."}}
                  :required             ["parent_id" "search"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "get_collection_contents"
    :description "List the items (questions, dashboards, sub-collections) inside a specific collection.
Use this when the user asks what is inside a collection or wants to browse its content."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:collection_id {:type        "integer"
                                                         :description "ID of the collection to list contents for."}}
                  :required             ["collection_id"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "get_table_details"
    :description "Get detailed information about a specific table or model: its columns (names, types),
the database it belongs to, and its schema. Use this when the context references a table or model,
or when you need column details for a single table without fetching the entire database schema."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:table_id {:type        "integer"
                                                    :description "ID of the table to inspect."}}
                  :required             ["table_id"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "create_question"
    :description "Create and save a new question (saved query) in Metabase.
After creating, always provide the URL /question/<id> to the user."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:name          {:type        "string"
                                                         :description "Question title."}
                                         :database_id   {:type        "integer"
                                                         :description "Database ID this question queries."}
                                         :sql           {:type        "string"
                                                         :description "Native SQL query."}
                                         :description   {:type        ["string" "null"]
                                                         :description "Optional description of the question. Pass null if none."}
                                         :collection_id {:type        ["integer" "null"]
                                                         :description "Optional collection ID to save the question into. Pass null for default collection."}
                                         :display       {:anyOf       [{:type "string"
                                                                        :enum ["table" "bar" "line" "pie" "scalar" "area" "row" "progress" "funnel" "scatter"]}
                                                                       {:type "null"}]
                                                         :description "Visualization type. Pass null to use default (table)."}}
                  :required             ["name" "database_id" "sql" "description" "collection_id" "display"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "update_question"
    :description "Update an existing saved question (card). You can change its name, description, SQL query,
visualization type, or move it to another collection. Only pass the fields you want to change — omitted
fields (null) stay unchanged. Use get_card_details first to see the current state."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:card_id        {:type        "integer"
                                                          :description "ID of the question to update."}
                                         :name           {:type        ["string" "null"]
                                                          :description "New question title. Pass null to keep current."}
                                         :description    {:type        ["string" "null"]
                                                          :description "New description. Pass null to keep current."}
                                         :sql            {:type        ["string" "null"]
                                                          :description "New native SQL query. Pass null to keep current."}
                                         :display        {:anyOf       [{:type "string"
                                                                         :enum ["table" "bar" "line" "pie" "scalar" "area" "row"]}
                                                                        {:type "null"}]
                                                          :description "New visualization type. Pass null to keep current."}
                                         :collection_id  {:type        ["integer" "null"]
                                                          :description "Move to this collection. Pass null to keep current."}}
                  :required             ["card_id" "name" "description" "sql" "display" "collection_id"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "create_dashboard"
    :description "Create a new empty dashboard. After creating, use add_card_to_dashboard to add questions to it.
Always provide the URL /dashboard/<id> to the user."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:name          {:type        "string"
                                                         :description "Dashboard title."}
                                         :description   {:type        ["string" "null"]
                                                         :description "Optional description. Pass null if none."}
                                         :collection_id {:type        ["integer" "null"]
                                                         :description "Collection ID to save the dashboard into. Pass null for default."}}
                  :required             ["name" "description" "collection_id"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "add_card_to_dashboard"
    :description "Add an existing saved question (card) to a dashboard. The card will be placed automatically
in the next available position. Use this after creating questions and a dashboard to assemble them together."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:dashboard_id {:type        "integer"
                                                        :description "ID of the dashboard to add the card to."}
                                         :card_id      {:type        "integer"
                                                        :description "ID of the saved question to add."}
                                         :size_x       {:type        ["integer" "null"]
                                                        :description "Width in grid units (1-18). Pass null for default (6)."}
                                         :size_y       {:type        ["integer" "null"]
                                                        :description "Height in grid units (1-12). Pass null for default (4)."}}
                  :required             ["dashboard_id" "card_id" "size_x" "size_y"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "archive_item"
    :description "Archive (soft-delete) a question or dashboard. The item is not permanently deleted
and can be restored from the trash. Use this when the user asks to delete, remove, or archive something."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:item_type {:type        "string"
                                                     :enum        ["card" "dashboard"]
                                                     :description "Type of item to archive."}
                                         :item_id   {:type        "integer"
                                                     :description "ID of the item to archive."}}
                  :required             ["item_type" "item_id"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "move_item"
    :description "Move a question or dashboard to a different collection.
Use this when the user asks to move, reorganize, or relocate an item."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:item_type     {:type        "string"
                                                         :enum        ["card" "dashboard"]
                                                         :description "Type of item to move."}
                                         :item_id       {:type        "integer"
                                                         :description "ID of the item to move."}
                                         :collection_id {:type        "integer"
                                                         :description "Target collection ID."}}
                  :required             ["item_type" "item_id" "collection_id"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "get_database_tables"
    :description "List all tables in a database (names, schemas, IDs) without column details.
Much faster than get_database_schema for large databases. Use this when you only need to know
which tables exist, then call get_table_details for specific tables."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:database_id {:type        "integer"
                                                       :description "ID of the database."}}
                  :required             ["database_id"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "list_metrics"
    :description "List available metrics (reusable aggregation definitions). Metrics can be used inside
notebook-mode questions as aggregations via [\"metric\", metric_id]. Optionally filter by table, database, or search by name.
Returns metric IDs, names, descriptions, and their source tables."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:database_id {:type        ["integer" "null"]
                                                       :description "Filter metrics to this database. Pass null to list all."}
                                         :table_id    {:type        ["integer" "null"]
                                                       :description "Filter metrics to this source table. Pass null to list all."}
                                         :search      {:type        ["string" "null"]
                                                       :description "Search metrics by name using full-text search. Pass null to list without filtering."}}
                  :required             ["database_id" "table_id" "search"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "get_metric"
    :description "Get details of a specific metric by its ID. Returns name, description, source table, database, and the metric's dataset_query definition."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:metric_id {:type        "integer"
                                                     :description "The metric card ID."}}
                  :required             ["metric_id"]
                  :additionalProperties false}}
   {:type        "function"
    :name        "get_mbql_guide"
    :description "Get the full MBQL (Metabase Query Language) syntax reference for building structured queries.
Returns field reference formats, aggregation types, filter operators, join syntax, order-by, expressions,
and display types. You MUST call this before building any MBQL query for notebook_link or create_notebook_question."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {}
                  :required             []
                  :additionalProperties false}}

   {:type        "function"
    :name        "get_sql_guide"
    :description "Get SQL syntax guide for a specific database engine. Returns quoting rules, date/time functions,
string functions, and other dialect-specific best practices. You MUST call this before writing any SQL query
to ensure correct syntax for the target database."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:database_id {:type        "integer"
                                                       :description "ID of the database you will write SQL for."}}
                  :required             ["database_id"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "get_document_guide"
    :description "Get the full Metabase Document authoring guide: ProseMirror AST node types, text formatting marks,
embedded cards, smart links, and best practices. You MUST call this before creating or updating any document
to ensure the AST structure is valid."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {}
                  :required             []
                  :additionalProperties false}}

   {:type        "function"
    :name        "get_analytical_guide"
    :description "Get the analytical investigation methodology guide. You MUST call this before starting any
data investigation, root-cause analysis, anomaly detection, or exploratory research task.
Returns a structured framework for how to approach analytical problems like a senior data analyst."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {}
                  :required             []
                  :additionalProperties false}}

   {:type        "function"
    :name        "get_metrics_guide"
    :description "Get the metrics taxonomy and query guide for the Semantic Layer database.
Call this before building any query that uses metrics — it explains the atomic vs semi-atomic
metric distinction, available dimensions for each type, conversion rate formulas, and common
use-case patterns (LTV, Retention, UA Performance, A/B Tests, Monetization)."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {}
                  :required             []
                  :additionalProperties false}}
   {:type        "function"
    :name        "get_search_guide"
    :description "Get the search strategy guide. Call this BEFORE searching for anything — metrics, questions, dashboards, collections. Explains fuzzy search, bilingual strategies, synonym expansion, and when to use which search tool."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {}
                  :required             []
                  :additionalProperties false}}

   {:type        "function"
    :name        "create_notebook_question"
    :description "Create and save a new question using a structured MBQL query (notebook mode).
Use this instead of create_question when you want to save a question with a structured query
rather than raw SQL. The dataset_query must be a valid Metabase MBQL structured query object.
This is the PREFERRED way to create questions — use create_question (SQL) only when the user explicitly asks for SQL."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:name          {:type        "string"
                                                         :description "Question title."}
                                         :database_id   {:type        "integer"
                                                         :description "Database ID this question queries."}
                                         :dataset_query {:type        "string"
                                                         :description "The MBQL inner query as a JSON string. Must contain EXACTLY ONE of: \"source-table\": <table_id> (for raw tables) OR \"source-card\": <card_id> (for saved questions/models) — NEVER both. Optional keys: aggregation, breakout, filter, order-by, limit, joins, expressions. Pass ONLY the inner query object, NOT the outer {type,database,query} wrapper. Example: {\"source-table\": 5, \"aggregation\": [[\"count\"]], \"breakout\": [[\"field\", 12, {\"temporal-unit\": \"month\"}]]}"}
                                         :display       {:anyOf       [{:type "string"
                                                                        :enum ["table" "bar" "line" "pie" "scalar" "area" "row" "progress" "funnel" "scatter"]}
                                                                       {:type "null"}]
                                                         :description "Visualization type. Pass null to use default (table)."}
                                         :description   {:type        ["string" "null"]
                                                         :description "Optional description of the question. Pass null if none."}
                                         :collection_id {:type        ["integer" "null"]
                                                         :description "Optional collection ID to save the question into. Pass null for default collection."}}
                  :required             ["name" "database_id" "dataset_query" "display" "description" "collection_id"]
                  :additionalProperties false}}
   {:type        "function"
    :name        "run_mbql_query"
    :description "Run a structured MBQL query and return the results without saving. Use this to preview notebook-mode query results before saving with create_notebook_question."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:database_id   {:type        "integer"
                                                         :description "Database ID to run the query against."}
                                         :dataset_query {:type        "string"
                                                         :description "The MBQL inner query as a JSON string. Must contain EXACTLY ONE of: \"source-table\": <table_id> (for raw tables) OR \"source-card\": <card_id> (for saved questions/models) — NEVER both. Optional keys: aggregation, breakout, filter, order-by, limit, joins, expressions. Pass ONLY the inner query object, NOT the outer {type,database,query} wrapper. Example: {\"source-table\": 5, \"aggregation\": [[\"count\"]], \"breakout\": [[\"field\", 12, {\"temporal-unit\": \"month\"}]]}"}}
                  :required             ["database_id" "dataset_query"]
                  :additionalProperties false}}
   {:type        "function"
    :name        "create_document"
    :description "Create a new Metabase Document — a rich-text page that can embed questions (cards) and smart links. Use this when the user asks to create a report, writeup, analysis page, or document. The content is a ProseMirror AST as a JSON string."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:name          {:type        "string"
                                                         :description "Document title."}
                                         :content       {:type        "string"
                                                         :description "The document body as a ProseMirror AST JSON string. Structure: {\"type\":\"doc\",\"content\":[...nodes]}. Supported node types: paragraph ({\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"...\"}]}), heading ({\"type\":\"heading\",\"attrs\":{\"level\":2},\"content\":[...]}), bulletList/orderedList with listItem children, codeBlock, blockquote, cardEmbed ({\"type\":\"cardEmbed\",\"attrs\":{\"id\":<card_id>}}). For simple text documents, wrap paragraphs in a doc node."}
                                         :collection_id {:type        ["integer" "null"]
                                                         :description "Collection ID to save the document into. Pass null for default."}}
                  :required             ["name" "content" "collection_id"]
                  :additionalProperties false}}
   {:type        "function"
    :name        "get_document"
    :description "Get details of a Metabase Document by ID: name, content (ProseMirror AST), embedded cards, collection, creator."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:document_id {:type        "integer"
                                                       :description "The document ID."}}
                  :required             ["document_id"]
                  :additionalProperties false}}
   {:type        "function"
    :name        "update_document"
    :description "Update an existing Metabase Document. You can change the name, content, collection, or archive it."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:document_id   {:type        "integer"
                                                         :description "The document ID to update."}
                                         :name          {:type        ["string" "null"]
                                                         :description "New document name. Pass null to keep unchanged."}
                                         :content       {:type        ["string" "null"]
                                                         :description "New ProseMirror AST JSON string. Pass null to keep unchanged."}
                                         :collection_id {:type        ["integer" "null"]
                                                         :description "New collection ID. Pass null to keep unchanged."}
                                         :archived      {:type        ["boolean" "null"]
                                                         :description "Set to true to archive, false to unarchive. Pass null to keep unchanged."}}
                  :required             ["document_id" "name" "content" "collection_id" "archived"]
                  :additionalProperties false}}
   {:type        "function"
    :name        "append_to_document"
    :description "Append new sections to the END of an existing Metabase Document. Use this to build documents incrementally — add 1-3 sections at a time without reading or rewriting the full document. Much more efficient than get_document + update_document for long documents."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:document_id {:type        "integer"
                                                       :description "The document ID to append to."}
                                         :nodes       {:type        "string"
                                                       :description "A JSON array of ProseMirror nodes to append. Example: [{\"type\":\"heading\",\"attrs\":{\"level\":2},\"content\":[{\"type\":\"text\",\"text\":\"New Section\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Some text.\"}]}]"}}
                  :required             ["document_id" "nodes"]
                  :additionalProperties false}}
   {:type        "function"
    :name        "validate_document_nodes"
    :description "Validate ProseMirror AST nodes BEFORE sending them to create_document or append_to_document. Returns OK or a list of errors to fix. You MUST call this before every create_document and append_to_document call."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:nodes {:type        "string"
                                                 :description "JSON string to validate. For create_document: the full doc node {\"type\":\"doc\",...}. For append_to_document: the array of nodes [{...},{...}]."}}
                  :required             ["nodes"]
                  :additionalProperties false}}
   {:type        "function"
    :name        "validate_mbql_query"
    :description "Validate an MBQL query by compiling it to SQL WITHOUT executing. Returns the compiled SQL if valid, or an error message describing what's wrong. You MUST call this before every run_mbql_query, create_notebook_question, and notebook_link to catch structural errors early."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:database_id   {:type        "integer"
                                                         :description "Database ID to compile the query against."}
                                         :dataset_query {:type        "string"
                                                         :description "JSON string of the MBQL dataset_query to validate. Same format as run_mbql_query."}}
                  :required             ["database_id" "dataset_query"]
                  :additionalProperties false}}])

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Tool implementations
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- run-search
  "Run Metabase search engine with the given query, model filter, and limit."
  [query & {:keys [models table-db-id limit] :or {limit 50}}]
  (let [ctx (cond-> {:search-string         query
                     :limit                 limit
                     :current-user-id       api/*current-user-id*
                     :current-user-perms    @api/*current-user-permissions-set*
                     :is-superuser?         api/*is-superuser?*
                     :is-impersonated-user? (perms/impersonated-user?)
                     :is-sandboxed-user?    (perms/sandboxed-user?)}
              models      (assoc :models models)
              table-db-id (assoc :table-db-id table-db-id))]
    (try
      (:data (search/search (search/search-context ctx)))
      (catch Exception e
        (log/warn e "Search failed" {:term query})
        []))))

(defn- list-databases [search-term]
  (let [dbs (if (seq search-term)
              (run-search search-term :models #{"database"} :limit 20)
              (filter mi/can-read? (t2/select :model/Database {:order-by [[:name :asc]]})))]
    (if (empty? dbs)
      (if (seq search-term)
        (format "No databases found matching \"%s\"." search-term)
        "No databases available.")
      (str "Available databases:\n"
           (str/join "\n"
             (map (fn [db]
                    (format "- ID: %d, Name: \"%s\"%s"
                            (:id db) (:name db)
                            (if-let [e (:engine db)] (str ", Engine: " (name e)) "")))
                  dbs))))))

(defn- get-database-schema [database-id]
  (let [db     (t2/select-one :model/Database :id database-id)
        _      (api/check-404 db)
        _      (api/check-403 (mi/can-read? db))
        tables (filter mi/can-read?
                       (t2/select :model/Table :db_id database-id :active true
                                  :visibility_type nil
                                  {:order-by [[:schema :asc] [:name :asc]]}))]
    (if (empty? tables)
      (format "Database \"%s\" has no accessible tables." (:name db))
      (let [table-ids (map :id tables)
            fields    (when (seq table-ids)
                        (t2/select :model/Field
                                   :table_id [:in table-ids]
                                   :active true
                                   :visibility_type :normal
                                   {:order-by [[:table_id :asc] [:position :asc]]}))
            by-table  (group-by :table_id fields)
            summaries (map (fn [tbl]
                             (let [flds (get by-table (:id tbl) [])]
                               (str (format "Table: %s%s (ID: %d)\n"
                                            (if (:schema tbl) (str (:schema tbl) ".") "")
                                            (:name tbl)
                                            (:id tbl))
                                    (str/join "\n"
                                      (map (fn [f]
                                             (format "    - %s (%s)" (:name f) (name (:base_type f))))
                                           flds)))))
                           tables)]
        (str (format "Schema for \"%s\":\n\n" (:name db))
             (str/join "\n\n" summaries))))))

(defn- list-questions [search-term]
  (let [cards (->> (if (seq search-term)
                     (t2/select :model/Card
                                :name [:like (str "%" search-term "%")]
                                :archived false
                                {:limit 50 :order-by [[:name :asc]]})
                     (t2/select :model/Card
                                :archived false
                                {:limit 50 :order-by [[:updated_at :desc]]}))
                   (filter mi/can-read?)
                   (take 20))]
    (if (empty? cards)
      (if search-term
        (format "No questions found matching \"%s\"." search-term)
        "No questions found.")
      (str "Questions (up to 20):\n"
           (str/join "\n"
             (map (fn [c]
                    (format "- ID: %d, Name: \"%s\"%s"
                            (:id c) (:name c)
                            (if (:description c) (str ", Desc: " (:description c)) "")))
                  cards))))))

(def ^:private ai-type->search-model
  "Map user-friendly type names (used by the AI) to internal search model names."
  {"question"   "card"
   "dashboard"  "dashboard"
   "collection" "collection"
   "table"      "table"
   "metric"     "metric"
   "model"      "dataset"
   "document"   "document"})

(defn- search-items [query item-type]
  (let [search-model (when item-type (get ai-type->search-model item-type item-type))
        ctx     (cond-> {:search-string        query
                         :limit                15
                         :current-user-id      api/*current-user-id*
                         :current-user-perms   @api/*current-user-permissions-set*
                         :is-superuser?        api/*is-superuser?*
                         :is-impersonated-user? (perms/impersonated-user?)
                         :is-sandboxed-user?   (perms/sandboxed-user?)}
                  search-model (assoc :models #{search-model}))
        results (try
                  (:data (search/search (search/search-context ctx)))
                  (catch Exception e
                    (log/warn e "Search failed" {:term query})
                    (throw (ex-info (str "Search failed: " (.getMessage e)) {}))))]
    (if (empty? results)
      (format "No results found for \"%s\"." query)
      (str (format "Search results for \"%s\" (up to 15):\n" query)
           (str/join "\n"
             (map (fn [item]
                    (format "- [%s] ID: %d, Name: \"%s\"%s"
                            (name (:model item))
                            (:id item)
                            (:name item)
                            (if-let [d (:description item)]
                              (str ", Desc: " (subs d 0 (min 80 (count d))))
                              "")))
                  results))))))

(defn- format-qp-result
  "Formats a query-processor result map into a human-readable string for the AI."
  [result]
  (if-let [err (:error result)]
    (str "Query error: " err)
    (let [cols (get-in result [:data :cols] [])
          rows (get-in result [:data :rows] [])]
      (if (empty? rows)
        "Query executed successfully. No rows returned."
        (let [header    (str/join " | " (map :name cols))
              separator (str/join " | " (repeat (count cols) "---"))
              data-rows (map (fn [row]
                               (str/join " | "
                                 (map #(if (nil? %) "NULL" (str %)) row)))
                             (take 50 rows))
              total     (count rows)
              note      (when (> total 50)
                          (format "\n... (%d total rows, showing first 50)" total))]
          (str "Results:\n" header "\n" separator "\n"
               (str/join "\n" data-rows)
               note))))))

(defn- run-query [database-id sql]
  (let [db     (t2/select-one :model/Database :id database-id)
        _      (api/check-404 db)
        _      (api/check-403 (mi/can-read? db))
        query  {:database database-id
                :type     :native
                :native   {:query sql :template-tags {}}}
        result (try
                 (qp/process-query
                  (assoc query :info {:executed-by api/*current-user-id*
                                      :context     :ad-hoc
                                      :query-hash  (qp.util/query-hash query)}))
                 (catch Exception e
                   {:error (.getMessage e)}))]
    (format-qp-result result)))

(defn- parse-dataset-query
  "Parse the dataset_query string the AI provides.
   Returns {:query-map <inner-query-map> :database-id <id-or-nil>}.

   Handles two shapes the AI may send:
   1. Inner query only: {\"source-table\": 5, ...}
      → query-map = that map, database-id = nil (caller must supply it)
   2. Full outer wrapper: {\"type\":\"query\",\"database\":2,\"query\":{\"source-table\":5,...}}
      → query-map = the inner :query value, database-id = 2 (extracted from wrapper)"
  [dataset-query-str]
  (let [raw (if (string? dataset-query-str)
              (json/parse-string dataset-query-str)
              dataset-query-str)]
    (if (contains? raw "query")
      {:query-map   (get raw "query")
       :database-id (get raw "database")}
      {:query-map   raw
       :database-id nil})))

(defn- run-mbql-query [database-id dataset-query-str]
  (let [{:keys [query-map] db-from-json :database-id} (parse-dataset-query dataset-query-str)
        effective-db-id (or database-id db-from-json)
        _  (when-not effective-db-id
             (throw (ex-info "database_id is required: pass it as the database_id argument or include \"database\" in the outer query wrapper." {})))
        db (t2/select-one :model/Database :id effective-db-id)
        _  (api/check-404 db)
        _  (api/check-403 (mi/can-read? db))
        query  {:database effective-db-id
                :type     :query
                :query    query-map}
        result (try
                 (qp/process-query
                  (assoc query :info {:executed-by api/*current-user-id*
                                      :context     :ad-hoc
                                      :query-hash  (qp.util/query-hash query)}))
                 (catch Exception e
                   {:error (.getMessage e)}))]
    (format-qp-result result)))

(defn- execute-card [card-id]
  (let [card (t2/select-one :model/Card :id card-id)
        _    (api/check-404 card)
        _    (api/check-403 (mi/can-read? card))
        dq   (:dataset_query card)
        result (try
                 (qp/process-query
                  (assoc dq
                         :info {:executed-by api/*current-user-id*
                                :context     :ad-hoc
                                :card-id     card-id
                                :query-hash  (qp.util/query-hash dq)}))
                 (catch Exception e
                   {:error (.getMessage e)}))]
    (str (format "Results for question \"%s\" (ID: %d):\n" (:name card) card-id)
         (format-qp-result result))))

(defn- get-card-details [card-id]
  (let [card (t2/select-one :model/Card :id card-id)
        _    (api/check-404 card)
        _    (api/check-403 (mi/can-read? card))
        coll (when (:collection_id card)
               (t2/select-one :model/Collection :id (:collection_id card)))
        dq   (:dataset_query card)
        query-info (cond
                     (= "native" (name (or (:type dq) "")))
                     (str "Type: Native SQL\nSQL:\n" (get-in dq [:native :query]))

                     (= "query" (name (or (:type dq) "")))
                     (str "Type: Structured (MBQL)\n"
                          "Query: " (json/generate-string (:query dq)))

                     :else
                     (str "Query: " (json/generate-string dq)))]
    (str (format "Question details (ID: %d):\n" card-id)
         (format "- Name: \"%s\"\n" (:name card))
         (when (:description card)
           (format "- Description: %s\n" (:description card)))
         (format "- Display: %s\n" (name (or (:display card) :table)))
         (format "- Database ID: %s\n" (:database dq))
         (when coll
           (format "- Collection: \"%s\" (ID: %d)\n" (:name coll) (:id coll)))
         (format "- Created at: %s\n" (:created_at card))
         (format "- Updated at: %s\n" (:updated_at card))
         (format "\n%s\n" query-info)
         (when-let [params (:parameters card)]
           (when (seq params)
             (str "\nParameters:\n"
                  (str/join "\n"
                    (map (fn [p]
                           (format "  - %s (slug: %s, type: %s)"
                                   (get p "name" (:name p))
                                   (get p "slug" (:slug p))
                                   (get p "type" (:type p))))
                         params))))))))

(defn- get-dashboard-details [dashboard-id]
  (let [dash (t2/select-one :model/Dashboard :id dashboard-id)
        _    (api/check-404 dash)
        _    (api/check-403 (mi/can-read? dash))
        coll (when (:collection_id dash)
               (t2/select-one :model/Collection :id (:collection_id dash)))
        dashcards (t2/select :model/DashboardCard :dashboard_id dashboard-id
                             {:order-by [[:row :asc] [:col :asc]]})
        card-ids  (keep :card_id dashcards)
        cards-map (when (seq card-ids)
                    (into {} (map (juxt :id identity)
                                  (t2/select :model/Card :id [:in card-ids]))))]
    (str (format "Dashboard details (ID: %d):\n" dashboard-id)
         (format "- Name: \"%s\"\n" (:name dash))
         (when (:description dash)
           (format "- Description: %s\n" (:description dash)))
         (when coll
           (format "- Collection: \"%s\" (ID: %d)\n" (:name coll) (:id coll)))
         (format "- Created at: %s\n" (:created_at dash))
         (format "- Updated at: %s\n" (:updated_at dash))

         ;; Parameters (dashboard filters)
         (when-let [params (:parameters dash)]
           (when (seq params)
             (str "\nFilters/Parameters:\n"
                  (str/join "\n"
                    (map (fn [p]
                           (format "  - %s (slug: %s, type: %s)"
                                   (get p "name" (:name p))
                                   (get p "slug" (:slug p))
                                   (get p "type" (:type p))))
                         params)))))

         ;; Cards on the dashboard
         (str "\n\nCards on this dashboard (" (count dashcards) "):\n"
              (str/join "\n"
                (map (fn [dc]
                       (let [card (get cards-map (:card_id dc))]
                         (if card
                           (format "  - Card ID: %d, Name: \"%s\", Display: %s, Position: row %d col %d, Size: %dx%d"
                                   (:id card)
                                   (:name card)
                                   (name (or (:display card) :table))
                                   (or (:row dc) 0)
                                   (or (:col dc) 0)
                                   (or (:size_x dc) 4)
                                   (or (:size_y dc) 4))
                           (format "  - Text/Heading card at row %d col %d, Size: %dx%d"
                                   (or (:row dc) 0)
                                   (or (:col dc) 0)
                                   (or (:size_x dc) 4)
                                   (or (:size_y dc) 4)))))
                     dashcards))))))

(defn- list-collections [parent-id search-term]
  (let [colls (if (seq search-term)
                (run-search search-term :models #{"collection"} :limit 30)
                (->> (if parent-id
                       (t2/select :model/Collection
                                  :location (format "/%d/" parent-id)
                                  :archived false
                                  {:order-by [[:name :asc]]
                                   :limit    50})
                       (t2/select :model/Collection
                                  :location "/"
                                  :archived false
                                  {:order-by [[:name :asc]]
                                   :limit    50}))
                     (filter mi/can-read?)
                     (take 30)))]
    (if (empty? colls)
      (cond
        (seq search-term) (format "No collections found matching \"%s\"." search-term)
        parent-id         (format "No sub-collections found in collection %d." parent-id)
        :else             "No collections found.")
      (str (cond
             (seq search-term) (format "Collections matching \"%s\":\n" search-term)
             parent-id         (format "Sub-collections of collection %d:\n" parent-id)
             :else             "Root collections:\n")
           (str/join "\n"
             (map (fn [c]
                    (format "- ID: %d, Name: \"%s\"%s%s"
                            (:id c) (:name c)
                            (if (:personal_owner_id c) " [Personal]" "")
                            (if (:description c) (str ", Desc: " (:description c)) "")))
                  colls))))))

(defn- get-collection-contents [collection-id]
  (let [coll   (t2/select-one :model/Collection :id collection-id)
        _      (api/check-404 coll)
        _      (api/check-403 (mi/can-read? coll))
        ;; Sub-collections
        sub-colls (->> (t2/select :model/Collection
                                  :location (format "/%d/" collection-id)
                                  :archived false
                                  {:order-by [[:name :asc]]})
                       (filter mi/can-read?))
        ;; Cards (questions, models, metrics)
        cards  (->> (t2/select :model/Card
                               :collection_id collection-id
                               :archived false
                               {:order-by [[:name :asc]]
                                :limit    50})
                    (filter mi/can-read?))
        ;; Dashboards
        dashes (->> (t2/select :model/Dashboard
                               :collection_id collection-id
                               :archived false
                               {:order-by [[:name :asc]]
                                :limit    50})
                    (filter mi/can-read?))]
    (str (format "Collection \"%s\" (ID: %d) contents:\n\n" (:name coll) collection-id)
         (when (seq sub-colls)
           (str "Sub-collections:\n"
                (str/join "\n"
                  (map (fn [c] (format "  - [collection] ID: %d, Name: \"%s\"" (:id c) (:name c)))
                       sub-colls))
                "\n\n"))
         (when (seq cards)
           (str "Questions/Models:\n"
                (str/join "\n"
                  (map (fn [c]
                         (format "  - [%s] ID: %d, Name: \"%s\", Display: %s"
                                 (name (or (:type c) :question))
                                 (:id c) (:name c)
                                 (name (or (:display c) :table))))
                       cards))
                "\n\n"))
         (when (seq dashes)
           (str "Dashboards:\n"
                (str/join "\n"
                  (map (fn [d] (format "  - [dashboard] ID: %d, Name: \"%s\"" (:id d) (:name d)))
                       dashes))
                "\n"))
         (when (and (empty? sub-colls) (empty? cards) (empty? dashes))
           "This collection is empty."))))

(defn- get-table-details [table-id]
  (let [tbl    (t2/select-one :model/Table :id table-id)
        _      (api/check-404 tbl)
        _      (api/check-403 (mi/can-read? tbl))
        db     (t2/select-one :model/Database :id (:db_id tbl))
        fields (t2/select :model/Field
                           :table_id table-id
                           :active true
                           :visibility_type :normal
                           {:order-by [[:position :asc]]})]
    (str (format "Table details (ID: %d):\n" table-id)
         (format "- Name: %s%s\n"
                 (if (:schema tbl) (str (:schema tbl) ".") "")
                 (:name tbl))
         (when (:description tbl)
           (format "- Description: %s\n" (:description tbl)))
         (format "- Database: \"%s\" (ID: %d)\n" (:name db) (:id db))
         (format "- Engine: %s\n" (name (:engine db)))
         (format "\nColumns (%d):\n" (count fields))
         (str/join "\n"
           (map (fn [f]
                  (str (format "  - ID: %d, %s (%s%s)"
                               (:id f) (:name f) (name (:base_type f))
                               (if (:semantic_type f) (str ", " (name (:semantic_type f))) ""))
                       (when (:description f)
                         (str " — " (:description f)))
                       (when (:fk_target_field_id f)
                         (let [fk-field (t2/select-one :model/Field :id (:fk_target_field_id f))
                               fk-table (when fk-field (t2/select-one :model/Table :id (:table_id fk-field)))]
                           (when (and fk-field fk-table)
                             (format " → FK to %s.%s (field ID: %d)" (:name fk-table) (:name fk-field) (:id fk-field)))))))
                fields)))))

(defn- update-question [{:strs [card_id name description sql display collection_id]}]
  (let [card (t2/select-one :model/Card :id card_id)
        _    (api/check-404 card)
        _    (api/check-403 (mi/can-write? card))
        updates (cond-> {}
                  name          (assoc :name name)
                  description   (assoc :description description)
                  display       (assoc :display (keyword display))
                  collection_id (assoc :collection_id collection_id)
                  sql           (assoc :dataset_query
                                       (assoc-in (:dataset_query card) [:native :query] sql)))]
    (if (empty? updates)
      (format "No changes specified for question %d." card_id)
      (do
        (t2/update! :model/Card card_id updates)
        (let [updated (t2/select-one :model/Card :id card_id)]
          (format "Question updated successfully!\n- ID: %d\n- Name: \"%s\"\n- URL: /question/%d"
                  (:id updated) (:name updated) (:id updated)))))))

(defn- create-dashboard [{:strs [name description collection_id]}]
  (when collection_id
    (let [coll (t2/select-one :model/Collection :id collection_id)]
      (api/check-404 coll)
      (api/check-403 (mi/can-write? coll))))
  (let [dash-data (cond-> {:name       name
                            :creator_id api/*current-user-id*
                            :parameters []}
                    description   (assoc :description description)
                    collection_id (assoc :collection_id collection_id))
        dash (t2/insert-returning-instance! :model/Dashboard dash-data)]
    (format "Dashboard created successfully!\n- ID: %d\n- Name: \"%s\"\n- Display: dashboard\n- URL: /dashboard/%d"
            (:id dash) (:name dash) (:id dash))))

(defn- add-card-to-dashboard [{:strs [dashboard_id card_id size_x size_y]}]
  (let [dash (t2/select-one :model/Dashboard :id dashboard_id)
        _    (api/check-404 dash)
        _    (api/check-403 (mi/can-write? dash))
        card (t2/select-one :model/Card :id card_id)
        _    (api/check-404 card)
        _    (api/check-403 (mi/can-read? card))
        ;; Find next available row position
        existing (t2/select :model/DashboardCard :dashboard_id dashboard_id)
        next-row (if (empty? existing)
                   0
                   (apply max (map (fn [dc] (+ (or (:row dc) 0) (or (:size_y dc) 4)))
                                   existing)))
        sx (or size_x 6)
        sy (or size_y 4)
        dc (t2/insert-returning-instance! :model/DashboardCard
                                          {:dashboard_id dashboard_id
                                           :card_id      card_id
                                           :row          next-row
                                           :col          0
                                           :size_x       sx
                                           :size_y       sy})]
    (format "Card added to dashboard!\n- Dashboard: \"%s\" (ID: %d)\n- Card: \"%s\" (ID: %d)\n- Position: row %d, col 0, size %dx%d"
            (:name dash) dashboard_id
            (:name card) card_id
            next-row sx sy)))

(defn- create-question [{:strs [name description database_id sql collection_id display]}]
  (when collection_id
    (let [coll (t2/select-one :model/Collection :id collection_id)]
      (api/check-404 coll)
      (api/check-403 (mi/can-write? coll))))
  (let [card-data (cond-> {:name          name
                           :dataset_query {:database database_id
                                           :type     :native
                                           :native   {:query              sql
                                                      :template-tags      {}}}
                           :display       (keyword (or display "table"))
                           :visualization_settings {}}
                    description   (assoc :description description)
                    collection_id (assoc :collection_id collection_id))
        card      (queries.card/create-card! card-data @api/*current-user*)]
    (format "Question created successfully!\n- ID: %d\n- Name: \"%s\"\n- Display: %s\n- URL: /question/%d"
            (:id card) (:name card) (clojure.core/name (or (:display card) :table)) (:id card))))

(defn- archive-item [item-type item-id]
  (let [model (case item-type
                "card"      :model/Card
                "dashboard" :model/Dashboard)
        item  (t2/select-one model :id item-id)
        _     (api/check-404 item)
        _     (api/check-403 (mi/can-write? item))]
    (t2/update! model item-id {:archived true})
    (format "%s \"%s\" (ID: %d) has been archived."
            (str/capitalize item-type)
            (:name item) item-id)))

(defn- move-item [item-type item-id collection-id]
  (let [model (case item-type
                "card"      :model/Card
                "dashboard" :model/Dashboard)
        item  (t2/select-one model :id item-id)
        _     (api/check-404 item)
        _     (api/check-403 (mi/can-write? item))
        coll  (t2/select-one :model/Collection :id collection-id)
        _     (api/check-404 coll)
        _     (api/check-403 (mi/can-write? coll))]
    (t2/update! model item-id {:collection_id collection-id})
    (format "%s \"%s\" (ID: %d) moved to collection \"%s\" (ID: %d)."
            (str/capitalize item-type)
            (:name item) item-id
            (:name coll) collection-id)))

(defn- get-database-tables [database-id]
  (let [db     (t2/select-one :model/Database :id database-id)
        _      (api/check-404 db)
        _      (api/check-403 (mi/can-read? db))
        tables (filter mi/can-read?
                       (t2/select :model/Table :db_id database-id :active true
                                  :visibility_type nil
                                  {:order-by [[:schema :asc] [:name :asc]]}))]
    (if (empty? tables)
      (format "Database \"%s\" has no accessible tables." (:name db))
      (str (format "Tables in \"%s\" (%d total):\n" (:name db) (count tables))
           (str/join "\n"
             (map (fn [tbl]
                    (format "- ID: %d, %s%s%s"
                            (:id tbl)
                            (if (:schema tbl) (str (:schema tbl) ".") "")
                            (:name tbl)
                            (if (:description tbl) (str " — " (:description tbl)) "")))
                  tables))))))

(defn- load-guide-file!
  "Load a guide file from the path given by env var.
  Throws if the env var is not set or the file does not exist."
  [env-var]
  (let [path (or (System/getenv env-var)
                 (throw (ex-info (str "BI Agent: env var " env-var " is not set. "
                                      "Set it to the path of the guide file.")
                                 {:env-var env-var})))
        f    (io/file path)]
    (when-not (.exists f)
      (throw (ex-info (str "BI Agent: " env-var " points to non-existent file '" path "'")
                      {:env-var env-var :path path})))
    (slurp f)))

(defn- get-mbql-guide []
  (load-guide-file! "MB_AI_AGENT_MBQL_GUIDE_FILE"))

(defn- parse-sql-guide-sections
  "Parse the SQL guide file into a map of engine-name -> section-text.
   Sections are delimited by `## engine-name` headers."
  [content]
  (let [sections (str/split content #"(?m)^## ")
        parsed   (into {}
                   (for [section (rest sections) ;; skip text before first ##
                         :let [[first-line & rest-lines] (str/split-lines section)
                               engine (str/trim (str/lower-case first-line))
                               body   (str/join "\n" rest-lines)]
                         :when (seq engine)]
                     [engine (str "## " first-line "\n" body)]))]
    parsed))

(defn- get-sql-guide [database-id]
  (let [db (t2/select-one :model/Database :id database-id)
        _  (api/check-404 db)
        _  (api/check-403 (mi/can-read? db))
        engine   (name (:engine db))
        content  (load-guide-file! "MB_AI_AGENT_SQL_GUIDE_FILE")
        sections (parse-sql-guide-sections content)
        guide    (or (get sections engine) (get sections "default"))]
    (str (format "SQL guide for database \"%s\" (ID: %d, Engine: %s):\n\n"
                 (:name db) (:id db) engine)
         (or guide "No specific SQL guide available for this engine."))))

(defn- get-document-guide []
  (load-guide-file! "MB_AI_AGENT_DOCUMENT_GUIDE_FILE"))

(defn- get-metrics-guide []
  (load-guide-file! "MB_AI_AGENT_METRICS_GUIDE_FILE"))

(defn- get-search-guide []
  (load-guide-file! "MB_AI_AGENT_SEARCH_GUIDE_FILE"))

(defn- get-analytical-guide []
  (load-guide-file! "MB_AI_AGENT_ANALYTICAL_GUIDE_FILE"))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; ProseMirror AST validator
;;; ─────────────────────────────────────────────────────────────────────────────

(def ^:private valid-block-types
  #{"paragraph" "heading" "bulletList" "orderedList" "blockquote"
    "codeBlock" "horizontalRule" "resizeNode" "image" "table"})

(def ^:private valid-inline-types #{"text"})

(def ^:private camel-case-types
  {"bullet_list"     "bulletList"
   "ordered_list"    "orderedList"
   "list_item"       "listItem"
   "code_block"      "codeBlock"
   "horizontal_rule" "horizontalRule"
   "card_embed"      "cardEmbed"
   "resize_node"     "resizeNode"
   "table_row"       "tableRow"
   "table_cell"      "tableCell"
   "table_header"    "tableHeader"})

(def ^:private no-content-types #{"horizontalRule" "image"})

(defn- validate-node
  "Validate a single ProseMirror node. Returns a vector of error strings (empty = valid)."
  [node path]
  (if-not (map? node)
    [(str path ": node must be a JSON object, got " (type node))]
    (let [t    (or (get node "type") (get node :type))
          errs (transient [])]
      ;; Check type exists
      (when-not t
        (conj! errs (str path ": missing \"type\" field")))

      (when t
        ;; Check snake_case
        (when-let [fix (get camel-case-types (name t))]
          (conj! errs (str path ": wrong type \"" t "\" (snake_case). Use \"" fix "\"")))

        ;; Heading must have attrs.level as integer
        (when (= (name t) "heading")
          (let [attrs (or (get node "attrs") (get node :attrs))]
            (when-not attrs
              (conj! errs (str path ": heading missing \"attrs\":{\"level\":N}")))
            (when attrs
              (let [level (or (get attrs "level") (get attrs :level))]
                (when-not (integer? level)
                  (conj! errs (str path ": heading level must be integer 1-6, got " (pr-str level))))))))

        ;; cardEmbed must have attrs.id, must be inside resizeNode
        (when (= (name t) "cardEmbed")
          (let [attrs (or (get node "attrs") (get node :attrs))
                id    (when attrs (or (get attrs "id") (get attrs :id)))]
            (when-not id
              (conj! errs (str path ": cardEmbed missing attrs.id (use \"id\", not \"card_id\")")))
            (when (or (get attrs "card_id") (get attrs :card_id))
              (conj! errs (str path ": cardEmbed uses \"card_id\" — must be \"id\"")))))

        ;; No content on leaf nodes
        (when (contains? no-content-types (name t))
          (let [content (or (get node "content") (get node :content))]
            (when (some? content)
              (conj! errs (str path ": " t " must NOT have a \"content\" field")))))

        ;; text node checks
        (when (= (name t) "text")
          (let [text-val (or (get node "text") (get node :text))]
            (when-not (string? text-val)
              (conj! errs (str path ": text node missing \"text\" string field")))
            (when (or (get node "content") (get node :content))
              (conj! errs (str path ": text node must NOT have \"content\"")))))

        ;; listItem must contain paragraph
        (when (= (name t) "listItem")
          (let [content (or (get node "content") (get node :content))]
            (when (or (not (sequential? content)) (empty? content))
              (conj! errs (str path ": listItem must have content with at least one paragraph")))
            (when (sequential? content)
              (doseq [child content]
                (let [ct (or (get child "type") (get child :type))]
                  (when (= (name (or ct "")) "text")
                    (conj! errs (str path ": text directly inside listItem — wrap in paragraph"))))))))

        ;; bulletList/orderedList must contain only listItem
        (when (#{"bulletList" "orderedList"} (name t))
          (let [content (or (get node "content") (get node :content))]
            (when (or (not (sequential? content)) (empty? content))
              (conj! errs (str path ": " t " must have at least one listItem")))
            (when (sequential? content)
              (doseq [child content]
                (let [ct (name (or (get child "type") (get child :type) ""))]
                  (when-not (= ct "listItem")
                    (conj! errs (str path ": " t " can only contain listItem, found \"" ct "\""))))))))

        ;; paragraph/heading should only contain text nodes
        (when (#{"paragraph" "heading"} (name t))
          (let [content (or (get node "content") (get node :content))]
            (when (sequential? content)
              (doseq [child content]
                (let [ct (name (or (get child "type") (get child :type) ""))]
                  (when-not (valid-inline-types ct)
                    (conj! errs (str path ": " t " can only contain text nodes, found \"" ct "\""))))))))

        ;; marks only on text nodes
        (when (and (not= (name t) "text")
                   (or (get node "marks") (get node :marks)))
          (conj! errs (str path ": \"marks\" only allowed on text nodes, found on \"" t "\"")))

        ;; Recurse into content
        (let [content (or (get node "content") (get node :content))]
          (when (sequential? content)
            (doseq [[i child] (map-indexed vector content)]
              (let [child-errs (validate-node child (str path ".content[" i "]"))]
                (doseq [e child-errs] (conj! errs e)))))))

      (persistent! errs))))

(defn- validate-mbql-query [{:strs [database_id dataset_query]}]
  (let [{:keys [query-map] db-from-json :database-id} (parse-dataset-query dataset_query)
        effective-db-id (or database_id db-from-json)]
    (when-not effective-db-id
      (throw (ex-info "database_id is required." {})))
    (let [db (t2/select-one :model/Database :id effective-db-id)
          _  (api/check-404 db)
          _  (api/check-403 (mi/can-read? db))
          query    {:database effective-db-id
                    :type     :query
                    :query    query-map}
          compile-fn (requiring-resolve 'metabase.query-processor.compile/compile)]
      (try
        (let [compiled (compile-fn query)
              sql      (if (map? compiled) (:query compiled) (str compiled))]
          (str "OK — query is valid.\n\nCompiled SQL:\n" sql))
        (catch Exception e
          (str "INVALID MBQL — compilation failed:\n" (.getMessage e)
               "\n\nFix the error and call validate_mbql_query again."))))))

(defn- validate-document-nodes [{:strs [nodes]}]
  (let [parsed (try
                 (json/parse-string nodes)
                 (catch Exception e
                   (str "INVALID JSON: " (.getMessage e))))]
    (if (string? parsed)
      parsed
      (let [node-list (if (and (map? parsed) (= (get parsed "type") "doc"))
                        ;; create_document format: validate children of doc
                        (let [content (get parsed "content")]
                          (if (sequential? content)
                            content
                            [{:error "doc node must have \"content\" array"}]))
                        ;; append_to_document format: array of nodes
                        (if (sequential? parsed)
                          parsed
                          [{:error (str "Expected JSON array or {\"type\":\"doc\",...}, got " (type parsed))}]))
            ;; Check for top-level errors
            top-errors (when-let [e (:error (first node-list))]
                         [e])
            ;; Validate doc-level if wrapped in doc
            doc-errors (when (and (map? parsed) (= (get parsed "type") "doc"))
                         (let [content (get parsed "content")]
                           (when (sequential? content)
                             (->> content
                                  (keep-indexed (fn [i child]
                                                  (let [ct (or (get child "type") (get child :type) "")]
                                                    (when (= (name ct) "text")
                                                      (str "doc.content[" i "]: text directly inside doc — wrap in paragraph")))))
                                  vec))))
            ;; Validate each node
            all-errors (if top-errors
                         top-errors
                         (into (vec doc-errors)
                               (mapcat (fn [[i node]]
                                         (validate-node node (str "node[" i "]")))
                                       (map-indexed vector node-list))))]
        (if (empty? all-errors)
          "OK — all nodes are valid."
          (str "ERRORS FOUND (" (count all-errors) "):\n"
               (str/join "\n" (map-indexed (fn [i e] (str (inc i) ". " e)) all-errors))
               "\n\nFix these errors and call validate_document_nodes again before submitting."))))))

(defn- create-notebook-question [{:strs [name description database_id dataset_query display collection_id]}]
  (when collection_id
    (let [coll (t2/select-one :model/Collection :id collection_id)]
      (api/check-404 coll)
      (api/check-403 (mi/can-write? coll))))
  (let [{:keys [query-map] db-from-json :database-id} (parse-dataset-query dataset_query)
        effective-db-id (or database_id db-from-json)
        _  (when-not effective-db-id
             (throw (ex-info "database_id is required: pass it as the database_id argument or include \"database\" in the outer query wrapper." {})))
        card-data (cond-> {:name          name
                           :dataset_query {:database effective-db-id
                                           :type     :query
                                           :query    query-map}
                           :display       (keyword (or display "table"))
                           :visualization_settings {}}
                    description   (assoc :description description)
                    collection_id (assoc :collection_id collection_id))
        card      (queries.card/create-card! card-data @api/*current-user*)]
    (format "Question created successfully!\n- ID: %d\n- Name: \"%s\"\n- Display: %s\n- URL: /question/%d"
            (:id card) (:name card) (clojure.core/name (or (:display card) :table)) (:id card))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Document tools
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- create-document [{:strs [name content collection_id]}]
  (when collection_id
    (let [coll (t2/select-one :model/Collection :id collection_id)]
      (api/check-404 coll)
      (api/check-403 (mi/can-write? coll))))
  (let [ast (try
              (json/parse-string content)
              (catch Exception e
                (throw (ex-info (str "Error: the `content` parameter is not valid JSON. "
                                     "Make sure the ProseMirror AST is a complete, well-formed JSON string. "
                                     "Parse error: " (.getMessage e))
                                {:content-preview (subs content 0 (min 200 (count content)))}))))
        doc (t2/insert-returning-instance! :model/Document
              {:name          name
               :document      ast
               :content_type  prose-mirror/prose-mirror-content-type
               :collection_id collection_id
               :creator_id    api/*current-user-id*})]
    (format "Document created successfully!\n- ID: %d\n- Name: \"%s\"\n- URL: /document/%d"
            (:id doc) (:name doc) (:id doc))))

(defn- get-document-details [document-id]
  (let [doc (t2/select-one :model/Document :id document-id)
        _   (api/check-404 doc)
        _   (api/check-403 (mi/can-read? doc))
        ast (:document doc)
        ;; Extract embedded card IDs from AST
        card-ids (prose-mirror/card-ids {:document ast :content_type (:content_type doc)})]
    (str (format "Document: \"%s\" (ID: %d)\n" (:name doc) (:id doc))
         (format "- Collection ID: %s\n" (or (:collection_id doc) "root"))
         (format "- Creator: user %d\n" (:creator_id doc))
         (format "- Created: %s\n" (:created_at doc))
         (format "- Updated: %s\n" (:updated_at doc))
         (format "- Archived: %s\n" (:archived doc))
         (when (seq card-ids)
           (format "- Embedded card IDs: %s\n" (str/join ", " card-ids)))
         (format "- URL: /document/%d\n" (:id doc))
         (format "- Content (ProseMirror AST JSON):\n%s" (json/generate-string ast)))))

(defn- update-document [{:strs [document_id name content collection_id archived]}]
  (let [doc (t2/select-one :model/Document :id document_id)
        _   (api/check-404 doc)
        _   (api/check-403 (mi/can-write? doc))
        parsed-content (when (some? content)
                         (try
                           (json/parse-string content)
                           (catch Exception _
                             (throw (ex-info "The `content` parameter is not valid JSON. Provide a valid ProseMirror AST JSON string." {})))))
        updates (cond-> {}
                  (some? name)          (assoc :name name)
                  (some? content)       (assoc :document parsed-content
                                               :content_type prose-mirror/prose-mirror-content-type)
                  (some? collection_id) (assoc :collection_id collection_id)
                  (some? archived)      (assoc :archived archived))]
    (when (seq updates)
      (t2/update! :model/Document :id document_id updates))
    (format "Document updated successfully!\n- ID: %d\n- URL: /document/%d"
            document_id document_id)))

(defn- append-to-document [{:strs [document_id nodes]}]
  (let [doc       (t2/select-one :model/Document :id document_id)
        _         (api/check-404 doc)
        _         (api/check-403 (mi/can-write? doc))
        new-nodes (try
                    ;; Parse with keyword keys to match mi/transform-json keywordization
                    (json/parse-string nodes true)
                    (catch Exception e
                      (throw (ex-info (str "Error: `nodes` is not valid JSON array. Parse error: "
                                           (.getMessage e))
                                      {}))))
        _         (when-not (sequential? new-nodes)
                    (throw (ex-info "Error: `nodes` must be a JSON array of ProseMirror nodes." {})))
        current-ast (:document doc)
        ;; Use keyword key :content — mi/transform-json deserializes with keywordization
        updated-ast (update current-ast :content
                            (fn [existing] (into (vec existing) new-nodes)))]
    (t2/update! :model/Document :id document_id
                {:document     updated-ast
                 :content_type prose-mirror/prose-mirror-content-type})
    (format "Appended %d node(s) to document.\n- ID: %d\n- URL: /document/%d"
            (count new-nodes) document_id document_id)))

(defn- list-metrics [database-id table-id search-term]
  (let [metrics (if (seq search-term)
                  ;; Full-text search via Metabase search engine
                  (let [results (run-search search-term
                                  :models #{"metric"}
                                  :table-db-id database-id
                                  :limit 50)]
                    (cond->> results
                      table-id (filter #(= (:table_id %) table-id))))
                  ;; Direct DB query (no search term)
                  (let [conditions (cond-> [:type :metric :archived false]
                                     database-id (into [:database_id database-id])
                                     table-id    (into [:table_id    table-id]))]
                    (->> (apply t2/select :model/Card conditions)
                         (filter mi/can-read?)
                         (take 50))))]
    (if (empty? metrics)
      (cond
        (seq search-term) (format "No metrics found matching \"%s\"." search-term)
        (and database-id table-id) (format "No metrics found for table %d in database %d." table-id database-id)
        database-id                (format "No metrics found in database %d." database-id)
        table-id                   (format "No metrics found for table %d." table-id)
        :else                      "No metrics found.")
      (str (format "Available metrics (%d):\n" (count metrics))
           (str/join "\n"
             (map (fn [m]
                    (let [tbl-id  (or (:table_id m) (:table-id m))
                          tbl     (when tbl-id (t2/select-one :model/Table :id tbl-id))
                          db-id   (or (:database_id m) (:database-id m))]
                      (str (format "- ID: %d, Name: \"%s\"" (:id m) (:name m))
                           (when (:description m) (str ", Desc: " (:description m)))
                           (when tbl (format ", Table: %s (ID: %d)" (:name tbl) (:id tbl)))
                           (when db-id (format ", Database ID: %d" db-id))
                           (format "\n  Use in MBQL aggregation: [\"metric\", %d]" (:id m)))))
                  metrics))))))

(defn- get-metric [metric-id]
  (let [card (t2/select-one :model/Card :id metric-id)
        _    (api/check-404 card)
        _    (api/check-403 (mi/can-read? card))]
    (when-not (= (keyword (:type card)) :metric)
      (throw (ex-info (format "Card %d is not a metric (type: %s)." metric-id (name (:type card))) {})))
    (let [tbl (when (:table_id card)
                (t2/select-one :model/Table :id (:table_id card)))]
      (str (format "Metric: \"%s\" (ID: %d)\n" (:name card) (:id card))
           (when (:description card) (str "Description: " (:description card) "\n"))
           (format "Database ID: %d\n" (:database_id card))
           (when tbl (format "Source table: %s (ID: %d)\n" (:name tbl) (:id tbl)))
           (format "Use in MBQL: [\"metric\", %d]\n" (:id card))
           (format "Dataset query:\n%s" (json/encode (:dataset_query card) {:pretty true}))))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Dispatcher
;;; ─────────────────────────────────────────────────────────────────────────────

;; IMPORTANT: keep this set in sync with the tool definitions above.
;; Any tool that creates, modifies, or deletes data must be listed here
;; so it is excluded when safe-mode? is true.
(def ^:private write-tool-names
  "Tool names that create, modify, or delete data. Disabled in safe mode."
  #{"create_question" "update_question" "create_dashboard" "add_card_to_dashboard"
    "archive_item" "move_item" "create_notebook_question" "create_document" "update_document" "append_to_document"})

(defn- read-only-tools
  "Filter tool definitions to only include read-only tools."
  [tools]
  (vec (remove #(write-tool-names (:name %)) tools)))

(defn all-tool-definitions
  "Return built-in tool definitions combined with MCP server tools.
   MCP tools are discovered from configured external MCP servers.
   When safe-mode? is true, all write/modify tools are excluded."
  ([] (all-tool-definitions false))
  ([safe-mode?]
   (let [built-in (if safe-mode? (read-only-tools tool-definitions) tool-definitions)
         mcp-tools (try (mcp/mcp-tool-definitions) (catch Exception _ nil))
         ;; In safe mode, also exclude MCP tools (external tools may write data)
         all-tools (if (seq mcp-tools)
                     (into built-in (if safe-mode? [] mcp-tools))
                     built-in)]
     all-tools)))

(defn execute-tool
  "Execute a tool call and return its string result.
   Routes MCP tools (containing '__') to the MCP client,
   built-in tools to the local dispatcher.
   Runs under the current user's bound identity/permissions."
  [tool-name args]
  (try
    (if (mcp/mcp-tool? tool-name)
      ;; MCP tool — delegate to external server
      (mcp/execute-mcp-tool tool-name args)
      ;; Built-in tool
      (case tool-name
        "list_databases"    (list-databases (get args "search"))
        "get_database_schema" (get-database-schema (get args "database_id"))
        "list_questions"    (list-questions (get args "search"))
        "search_items"      (search-items (get args "query") (get args "type"))
        "run_query"         (run-query (get args "database_id") (get args "sql"))
        "execute_card"      (execute-card (get args "card_id"))
        "get_card_details"  (get-card-details (get args "card_id"))
        "get_dashboard_details" (get-dashboard-details (get args "dashboard_id"))
        "get_table_details"  (get-table-details (get args "table_id"))
        "list_collections"   (list-collections (get args "parent_id") (get args "search"))
        "get_collection_contents" (get-collection-contents (get args "collection_id"))
        "create_question"   (create-question args)
        "update_question"   (update-question args)
        "create_dashboard"  (create-dashboard args)
        "add_card_to_dashboard" (add-card-to-dashboard args)
        "archive_item"      (archive-item (get args "item_type") (get args "item_id"))
        "move_item"         (move-item (get args "item_type") (get args "item_id") (get args "collection_id"))
        "get_database_tables" (get-database-tables (get args "database_id"))
        "list_metrics"       (list-metrics (get args "database_id") (get args "table_id") (get args "search"))
        "get_metric"         (get-metric (get args "metric_id"))
        "create_notebook_question" (create-notebook-question args)
        "get_sql_guide"  (get-sql-guide (get args "database_id"))
        "get_mbql_guide" (get-mbql-guide)
        "get_document_guide" (get-document-guide)
        "get_analytical_guide" (get-analytical-guide)
        "get_metrics_guide"    (get-metrics-guide)
        "get_search_guide"     (get-search-guide)
        "run_mbql_query"  (run-mbql-query (get args "database_id") (get args "dataset_query"))
        "create_document" (create-document args)
        "get_document"    (get-document-details (get args "document_id"))
        "update_document" (update-document args)
        "append_to_document" (append-to-document args)
        "validate_document_nodes" (validate-document-nodes args)
        "validate_mbql_query" (validate-mbql-query args)
        (str "Unknown tool: " tool-name)))
    (catch Exception e
      (log/warn e "AI Agent tool execution failed" {:tool tool-name})
      (str "Error executing " tool-name ": " (.getMessage e)))))
