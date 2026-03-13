(ns metabase.ai-agent.tools
  "Tool implementations executed under the current user's identity and permissions.
   All functions rely on `api/*current-user*` / `api/*current-user-id*` being bound by
   the surrounding request middleware — so results are always scoped to what the user
   is allowed to see."
  (:require
   [cheshire.core :as json]
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
    :description "List all databases in Metabase that the current user has access to."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {}
                  :required             []
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
    :description "Execute a native SQL query against a database and return the first 10 rows.
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
Use this to help the user navigate their content or find where items are saved."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:parent_id {:type        ["integer" "null"]
                                                     :description "Parent collection ID. Pass null to list root-level collections."}}
                  :required             ["parent_id"]
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
                                                                        :enum ["table" "bar" "line" "pie" "scalar" "area" "row"]}
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
notebook-mode questions as aggregations via [\"metric\", metric_id]. Optionally filter by table or database.
Returns metric IDs, names, descriptions, and their source tables."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:database_id {:type        ["integer" "null"]
                                                       :description "Filter metrics to this database. Pass null to list all."}
                                         :table_id    {:type        ["integer" "null"]
                                                       :description "Filter metrics to this source table. Pass null to list all."}}
                  :required             ["database_id" "table_id"]
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
                                                         :description "The MBQL structured query as a JSON string. Must be a JSON object with keys: source-table (integer), and optionally: aggregation, breakout, filter, order-by, limit, joins, expressions. Example: {\"source-table\": 5, \"aggregation\": [[\"count\"]], \"breakout\": [[\"field\", 12, {\"temporal-unit\": \"month\"}]]}"}
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
                                                         :description "The MBQL structured query as a JSON string. Must be a JSON object with keys: source-table (integer), and optionally: aggregation, breakout, filter, order-by, limit, joins, expressions. Example: {\"source-table\": 5, \"aggregation\": [[\"count\"]], \"breakout\": [[\"field\", 12, {\"temporal-unit\": \"month\"}]]}"}}
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
                  :additionalProperties false}}])

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Tool implementations
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- list-databases []
  (let [dbs (filter mi/can-read? (t2/select :model/Database {:order-by [[:name :asc]]}))]
    (if (empty? dbs)
      "No databases available."
      (str "Available databases:\n"
           (clojure.string/join "\n"
             (map (fn [db]
                    (format "- ID: %d, Name: \"%s\", Engine: %s"
                            (:id db) (:name db) (name (:engine db))))
                  dbs))))))

(defn- get-database-schema [database-id]
  (let [db     (t2/select-one :model/Database :id database-id)
        _      (api/check-404 db)
        _      (api/check-403 (mi/can-read? db))
        tables (filter mi/can-read?
                       (t2/select :model/Table :db_id database-id :active true
                                  {:order-by [[:schema :asc] [:name :asc]]}))]
    (if (empty? tables)
      (format "Database \"%s\" has no accessible tables." (:name db))
      (let [table-ids (map :id tables)
            fields    (when (seq table-ids)
                        (t2/select :model/Field
                                   :table_id [:in table-ids]
                                   :active true
                                   {:order-by [[:table_id :asc] [:position :asc]]}))
            by-table  (group-by :table_id fields)
            summaries (map (fn [tbl]
                             (let [flds (get by-table (:id tbl) [])]
                               (str (format "Table: %s%s (ID: %d)\n"
                                            (if (:schema tbl) (str (:schema tbl) ".") "")
                                            (:name tbl)
                                            (:id tbl))
                                    (clojure.string/join "\n"
                                      (map (fn [f]
                                             (format "    - %s (%s)" (:name f) (name (:base_type f))))
                                           flds)))))
                           tables)]
        (str (format "Schema for \"%s\":\n\n" (:name db))
             (clojure.string/join "\n\n" summaries))))))

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
           (clojure.string/join "\n"
             (map (fn [c]
                    (format "- ID: %d, Name: \"%s\"%s"
                            (:id c) (:name c)
                            (if (:description c) (str ", Desc: " (:description c)) "")))
                  cards))))))

(defn- search-items [query item-type]
  (let [ctx     (cond-> {:search-string        query
                         :limit                15
                         :current-user-id      api/*current-user-id*
                         :current-user-perms   @api/*current-user-permissions-set*
                         :is-superuser?        api/*is-superuser?*
                         :is-impersonated-user? (perms/impersonated-user?)
                         :is-sandboxed-user?   (perms/sandboxed-user?)}
                  item-type (assoc :models #{item-type}))
        results (try
                  (:data (search/search (search/search-context ctx)))
                  (catch Exception e
                    (log/warn e "AI Agent search failed")
                    []))]
    (if (empty? results)
      (format "No results found for \"%s\"." query)
      (str (format "Search results for \"%s\" (up to 15):\n" query)
           (clojure.string/join "\n"
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
        (let [header    (clojure.string/join " | " (map :name cols))
              separator (clojure.string/join " | " (repeat (count cols) "---"))
              data-rows (map (fn [row]
                               (clojure.string/join " | "
                                 (map #(if (nil? %) "NULL" (str %)) row)))
                             (take 50 rows))
              total     (count rows)
              note      (when (> total 50)
                          (format "\n... (%d total rows, showing first 50)" total))]
          (str "Results:\n" header "\n" separator "\n"
               (clojure.string/join "\n" data-rows)
               note))))))

(defn- run-query [database-id sql]
  (let [query  {:database database-id
                :type     :native
                :native   {:query sql}}
        result (try
                 (qp/process-query
                  (assoc query :info {:executed-by api/*current-user-id*
                                      :context     :ad-hoc
                                      :query-hash  (qp.util/query-hash query)}))
                 (catch Exception e
                   {:error (.getMessage e)}))]
    (format-qp-result result)))

(defn- run-mbql-query [database-id dataset-query-str]
  (let [query-map (if (string? dataset-query-str)
                    (json/parse-string dataset-query-str)
                    dataset-query-str)
        query  {:database database-id
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
                  (clojure.string/join "\n"
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
                  (clojure.string/join "\n"
                    (map (fn [p]
                           (format "  - %s (slug: %s, type: %s)"
                                   (get p "name" (:name p))
                                   (get p "slug" (:slug p))
                                   (get p "type" (:type p))))
                         params)))))

         ;; Cards on the dashboard
         (str "\n\nCards on this dashboard (" (count dashcards) "):\n"
              (clojure.string/join "\n"
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

(defn- list-collections [parent-id]
  (let [colls (->> (if parent-id
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
                   (take 30))]
    (if (empty? colls)
      (if parent-id
        (format "No sub-collections found in collection %d." parent-id)
        "No collections found.")
      (str (if parent-id
             (format "Sub-collections of collection %d:\n" parent-id)
             "Root collections:\n")
           (clojure.string/join "\n"
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
                (clojure.string/join "\n"
                  (map (fn [c] (format "  - [collection] ID: %d, Name: \"%s\"" (:id c) (:name c)))
                       sub-colls))
                "\n\n"))
         (when (seq cards)
           (str "Questions/Models:\n"
                (clojure.string/join "\n"
                  (map (fn [c]
                         (format "  - [%s] ID: %d, Name: \"%s\", Display: %s"
                                 (name (or (:type c) :question))
                                 (:id c) (:name c)
                                 (name (or (:display c) :table))))
                       cards))
                "\n\n"))
         (when (seq dashes)
           (str "Dashboards:\n"
                (clojure.string/join "\n"
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
         (clojure.string/join "\n"
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
  (let [dash-data (cond-> {:name       name
                            :creator_id api/*current-user-id*
                            :parameters []}
                    description   (assoc :description description)
                    collection_id (assoc :collection_id collection_id))
        dash (t2/insert-returning-instance! :model/Dashboard dash-data)]
    (format "Dashboard created successfully!\n- ID: %d\n- Name: \"%s\"\n- URL: /dashboard/%d"
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
    (format "Question created successfully!\n- ID: %d\n- Name: \"%s\"\n- URL: /question/%d"
            (:id card) (:name card) (:id card))))

(defn- archive-item [item-type item-id]
  (let [model (case item-type
                "card"      :model/Card
                "dashboard" :model/Dashboard)
        item  (t2/select-one model :id item-id)
        _     (api/check-404 item)
        _     (api/check-403 (mi/can-write? item))]
    (t2/update! model item-id {:archived true})
    (format "%s \"%s\" (ID: %d) has been archived."
            (clojure.string/capitalize item-type)
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
        _     (api/check-403 (mi/can-read? coll))]
    (t2/update! model item-id {:collection_id collection-id})
    (format "%s \"%s\" (ID: %d) moved to collection \"%s\" (ID: %d)."
            (clojure.string/capitalize item-type)
            (:name item) item-id
            (:name coll) collection-id)))

(defn- get-database-tables [database-id]
  (let [db     (t2/select-one :model/Database :id database-id)
        _      (api/check-404 db)
        _      (api/check-403 (mi/can-read? db))
        tables (filter mi/can-read?
                       (t2/select :model/Table :db_id database-id :active true
                                  {:order-by [[:schema :asc] [:name :asc]]}))]
    (if (empty? tables)
      (format "Database \"%s\" has no accessible tables." (:name db))
      (str (format "Tables in \"%s\" (%d total):\n" (:name db) (count tables))
           (clojure.string/join "\n"
             (map (fn [tbl]
                    (format "- ID: %d, %s%s%s"
                            (:id tbl)
                            (if (:schema tbl) (str (:schema tbl) ".") "")
                            (:name tbl)
                            (if (:description tbl) (str " — " (:description tbl)) "")))
                  tables))))))

(defn- get-mbql-guide []
  "## MBQL Reference (Metabase Query Language)

The `dataset_query` in a `notebook_link` block or `create_notebook_question` uses Metabase's structured query format.
You MUST use real field IDs from get_table_details — never guess or use field names.

### Structure
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
- Combined: [\"field\", <field_id>, {\"temporal-unit\": \"month\", \"join-alias\": \"T2\"}]

### Aggregations (array of clauses)
- [\"count\"]
- [\"sum\", <field_ref>]
- [\"avg\", <field_ref>]
- [\"min\", <field_ref>], [\"max\", <field_ref>]
- [\"distinct\", <field_ref>]
- [\"metric\", <metric_card_id>] — use a saved metric (call list_metrics to find available ones)
- [\"cum-sum\", <field_ref>] — cumulative sum
- [\"cum-count\"] — cumulative count
- [\"stddev\", <field_ref>] — standard deviation
- [\"percentile\", <field_ref>, 0.95] — percentile (e.g. 95th)

### Filters
- [\"=\", <field_ref>, value]
- [\"!=\", <field_ref>, value]
- [\">\", <field_ref>, value], [\"<\", <field_ref>, value]
- [\">=\", <field_ref>, value], [\"<=\", <field_ref>, value]
- [\"between\", <field_ref>, val1, val2]
- [\"contains\", <field_ref>, \"string\"]
- [\"does-not-contain\", <field_ref>, \"string\"]
- [\"starts-with\", <field_ref>, \"string\"]
- [\"ends-with\", <field_ref>, \"string\"]
- [\"is-null\", <field_ref>], [\"not-null\", <field_ref>]
- [\"is-empty\", <field_ref>], [\"not-empty\", <field_ref>]
- [\"time-interval\", <field_ref>, -7, \"day\"] — last 7 days
- [\"time-interval\", <field_ref>, -30, \"day\"] — last 30 days
- [\"time-interval\", <field_ref>, -12, \"month\"] — last 12 months
- [\"time-interval\", <field_ref>, \"current\", \"month\"] — current month
- [\"time-interval\", <field_ref>, -1, \"month\"] — last month
- [\"and\", filter1, filter2, ...] — combine with AND
- [\"or\", filter1, filter2, ...] — combine with OR
- [\"not\", filter] — negate a filter

### Order-by
- [\"asc\", <field_ref>]
- [\"desc\", <field_ref>]
- Can also order by aggregation: [\"asc\", [\"aggregation\", 0]] — sort by first aggregation

### Joins
{\"source-table\": <table_id>,
 \"alias\": \"T2\",
 \"condition\": [\"=\", [\"field\", <fk_field_id>, null], [\"field\", <pk_field_id>, {\"join-alias\": \"T2\"}]],
 \"strategy\": \"left-join\",  // \"left-join\", \"right-join\", \"inner-join\", \"full-join\"
 \"fields\": \"all\"}          // \"all\", \"none\", or array of field refs

### Expressions (calculated columns)
{\"profit\": [\"-\", [\"field\", <revenue_id>, null], [\"field\", <cost_id>, null]],
 \"full_name\": [\"concat\", [\"field\", <first_name_id>, null], \" \", [\"field\", <last_name_id>, null]]}
- Arithmetic: [\"+\", a, b], [\"-\", a, b], [\"*\", a, b], [\"/\", a, b]
- String: [\"concat\", ...], [\"substring\", str, start, length], [\"upper\", str], [\"lower\", str], [\"trim\", str], [\"length\", str]
- Logic: [\"case\", [[condition1, result1], [condition2, result2]], {\"default\": default_val}]
- Coalesce: [\"coalesce\", val1, val2]
- Reference expression in aggregation/breakout: [\"expression\", \"profit\"]

### Display types
\"table\", \"bar\", \"line\", \"area\", \"pie\", \"row\", \"scalar\", \"progress\", \"funnel\", \"scatter\"

Choose display based on the data:
- Time series (date breakout + metric): \"line\" or \"area\"
- Categorical comparison: \"bar\" or \"row\"
- Part of whole: \"pie\"
- Single number: \"scalar\"
- Raw data / listing: \"table\"

### Example: Monthly revenue with time filter
{\"type\": \"query\", \"database\": 1, \"query\": {
  \"source-table\": 5,
  \"aggregation\": [[\"sum\", [\"field\", 10, null]]],
  \"breakout\": [[\"field\", 12, {\"temporal-unit\": \"month\"}]],
  \"filter\": [\"time-interval\", [\"field\", 12, null], -12, \"month\"],
  \"order-by\": [[\"asc\", [\"field\", 12, {\"temporal-unit\": \"month\"}]]]
}}

### Example: Top 10 products by order count with join
{\"type\": \"query\", \"database\": 1, \"query\": {
  \"source-table\": 3,
  \"joins\": [{\"source-table\": 5, \"alias\": \"Products\",
              \"condition\": [\"=\", [\"field\", 15, null], [\"field\", 20, {\"join-alias\": \"Products\"}]],
              \"strategy\": \"left-join\", \"fields\": \"all\"}],
  \"aggregation\": [[\"count\"]],
  \"breakout\": [[\"field\", 21, {\"join-alias\": \"Products\"}]],
  \"order-by\": [[\"desc\", [\"aggregation\", 0]]],
  \"limit\": 10
}}")

(def ^:private sql-guides
  "Engine-specific SQL syntax guides."
  {"postgres"
   "## PostgreSQL SQL Guide

### Quoting
- ALWAYS quote column aliases with double quotes: AS \"month\", AS \"revenue\"
- Table/column names: double quotes if mixed case or reserved word: \"Order\".\"userId\"
- String literals: single quotes: 'hello'

### Date/Time
- DATE_TRUNC('month', created_at) — truncate to month/year/day/hour etc.
- CURRENT_DATE, CURRENT_TIMESTAMP, NOW()
- CURRENT_DATE - INTERVAL '7 days' — last 7 days
- EXTRACT(MONTH FROM created_at) — extract part
- TO_CHAR(created_at, 'YYYY-MM') — format as string
- created_at::date — cast to date

### Aggregation & Grouping
- GROUP BY 1, 2 — positional grouping allowed
- HAVING clause for filtering aggregates
- FILTER (WHERE ...) clause: COUNT(*) FILTER (WHERE status = 'active')

### Strings
- Concatenation: string || string
- ILIKE for case-insensitive matching (not LIKE)
- LENGTH(), LOWER(), UPPER(), TRIM(), SUBSTRING()

### Other
- LIMIT x OFFSET y for pagination
- COALESCE(val, default) for null handling
- BOOLEAN type: TRUE/FALSE
- Arrays: ARRAY[1,2,3], ANY(), ALL()
- CTEs: WITH cte AS (SELECT ...) SELECT ... FROM cte"

   "redshift"
   "## Redshift SQL Guide

### Quoting
- ALWAYS quote column aliases with double quotes: AS \"month\", AS \"revenue\"
- String literals: single quotes

### Date/Time
- DATE_TRUNC('month', created_at)
- GETDATE() or CURRENT_DATE / CURRENT_TIMESTAMP
- DATEADD(day, -7, GETDATE()) or CURRENT_DATE - INTERVAL '7 days'
- EXTRACT(MONTH FROM created_at), DATE_PART('month', created_at)
- TO_CHAR(created_at, 'YYYY-MM')

### Strings
- Concatenation: string || string
- ILIKE for case-insensitive
- LEN() instead of LENGTH()

### Other
- LIMIT x for pagination
- No FILTER clause (use CASE WHEN inside aggregate)
- APPROXIMATE COUNT(DISTINCT ...) available
- LISTAGG() instead of STRING_AGG()"

   "mysql"
   "## MySQL SQL Guide

### Quoting
- ALWAYS quote column aliases with backticks: AS `month`, AS `revenue`
- Table/column names: backticks: `order`.`user_id`
- String literals: single quotes: 'hello'
- Do NOT use double quotes for identifiers (they mean strings in default mode)

### Date/Time
- DATE_FORMAT(created_at, '%Y-%m-01') — format/truncate
- CURDATE(), NOW(), CURRENT_TIMESTAMP
- DATE_SUB(CURDATE(), INTERVAL 7 DAY) — last 7 days
- DATE_ADD(created_at, INTERVAL 1 MONTH)
- EXTRACT(MONTH FROM created_at), YEAR(), MONTH(), DAY()

### Aggregation & Grouping
- GROUP BY 1, 2 — positional grouping allowed
- No FILTER clause — use SUM(CASE WHEN ... THEN 1 ELSE 0 END)

### Strings
- CONCAT(a, b, c) — multi-arg concat
- LIKE is case-insensitive by default (depends on collation)
- LENGTH(), LOWER(), UPPER(), TRIM(), SUBSTRING()

### Other
- LIMIT x OFFSET y for pagination
- IFNULL(val, default) or COALESCE()
- Use LIMIT x, not FETCH FIRST x ROWS
- No BOOLEAN type — use TINYINT(1)
- GROUP_CONCAT() for string aggregation"

   "mariadb"
   "## MariaDB SQL Guide
(Same rules as MySQL)

### Quoting
- ALWAYS quote aliases with backticks: AS `month`, AS `revenue`

### Date/Time
- DATE_FORMAT(created_at, '%Y-%m-01'), CURDATE(), NOW()
- DATE_SUB(CURDATE(), INTERVAL 7 DAY)

### Strings
- CONCAT(a, b), LIKE (case-insensitive by default)

### Other
- LIMIT x OFFSET y, IFNULL(), GROUP_CONCAT()"

   "sqlserver"
   "## SQL Server Guide

### Quoting
- ALWAYS quote column aliases with square brackets: AS [month], AS [revenue]
- Table/column names: [Order].[UserId]
- String literals: single quotes: 'hello'
- Do NOT use double quotes (they may mean identifiers but brackets are standard)

### Date/Time
- DATETRUNC(month, created_at) (SQL Server 2022+) or DATEFROMPARTS(YEAR(x),MONTH(x),1)
- FORMAT(created_at, 'yyyy-MM') — format as string
- GETDATE(), CURRENT_TIMESTAMP, SYSDATETIME()
- DATEADD(day, -7, GETDATE()) — last 7 days
- DATEDIFF(day, start, end), DATEPART(month, created_at)

### Aggregation & Grouping
- No positional GROUP BY — must repeat expressions
- No FILTER clause — use SUM(CASE WHEN ... THEN 1 ELSE 0 END)

### Strings
- Concatenation: string + string or CONCAT(a, b)
- LIKE is case-insensitive with CI collation (default)
- LEN(), LOWER(), UPPER(), LTRIM(), RTRIM(), SUBSTRING()

### Other
- TOP x instead of LIMIT: SELECT TOP 10 * FROM ...
- OFFSET x ROWS FETCH NEXT y ROWS ONLY (SQL Server 2012+)
- ISNULL(val, default) or COALESCE()
- STRING_AGG() for string aggregation (SQL Server 2017+)
- No BOOLEAN — use BIT (0/1)"

   "bigquery"
   "## BigQuery SQL Guide

### Quoting
- ALWAYS quote column aliases with double quotes (backticks also work): AS \"month\" or AS `month`
- Table references use backticks: `project.dataset.table`
- String literals: single quotes

### Date/Time
- DATE_TRUNC(created_at, MONTH) — note: field first, then unit (no quotes around unit)
- CURRENT_DATE(), CURRENT_TIMESTAMP()
- DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
- DATE_ADD(created_at, INTERVAL 1 MONTH)
- EXTRACT(MONTH FROM created_at), FORMAT_DATE('%Y-%m', created_at)

### Strings
- CONCAT(a, b), string || string not supported
- LIKE is case-sensitive; use LOWER() for case-insensitive
- LENGTH(), LOWER(), UPPER(), TRIM(), SUBSTR()

### Other
- LIMIT x OFFSET y
- IFNULL(), COALESCE()
- No table alias AS keyword: FROM `table` t (not `table` AS t)
- ARRAY_AGG(), STRING_AGG() available
- Supports STRUCT, ARRAY types natively"

   "snowflake"
   "## Snowflake SQL Guide

### Quoting
- ALWAYS quote column aliases with double quotes: AS \"month\", AS \"revenue\"
- Unquoted identifiers are UPPERCASE by default
- Double-quote to preserve case: \"myColumn\"
- String literals: single quotes

### Date/Time
- DATE_TRUNC('month', created_at)
- CURRENT_DATE(), CURRENT_TIMESTAMP(), SYSDATE()
- DATEADD(day, -7, CURRENT_DATE()) — last 7 days
- DATEDIFF(day, start, end)
- TO_CHAR(created_at, 'YYYY-MM'), TO_DATE(), TO_TIMESTAMP()

### Strings
- Concatenation: string || string or CONCAT()
- ILIKE for case-insensitive matching
- LENGTH(), LOWER(), UPPER(), TRIM(), SUBSTR()

### Other
- LIMIT x OFFSET y
- NVL(val, default) or COALESCE() or IFNULL()
- LISTAGG() or ARRAY_AGG() for aggregation
- FLATTEN() for semi-structured data
- VARIANT type for JSON: col:key::string"

   "h2"
   "## H2 SQL Guide

### Quoting
- ALWAYS quote column aliases with double quotes: AS \"month\", AS \"revenue\"
- String literals: single quotes

### Date/Time
- PARSEDATETIME(FORMATDATETIME(created_at, 'yyyy-MM'), 'yyyy-MM') — truncate
- FORMATDATETIME(created_at, 'yyyy-MM-dd') — format
- CURRENT_DATE, CURRENT_TIMESTAMP
- DATEADD('DAY', -7, CURRENT_DATE) — last 7 days
- EXTRACT(MONTH FROM created_at), DAY_OF_WEEK()

### Strings
- Concatenation: string || string or CONCAT()
- LIKE (case-sensitive), use LOWER() for insensitive
- LENGTH(), LOWER(), UPPER(), TRIM(), SUBSTRING()

### Other
- LIMIT x OFFSET y
- NVL(val, default) or COALESCE()
- ARRAY_AGG(), LISTAGG() available"

   "sqlite"
   "## SQLite SQL Guide

### Quoting
- ALWAYS quote column aliases with double quotes: AS \"month\" (or square brackets: AS [month])
- String literals: single quotes

### Date/Time
- strftime('%Y-%m', created_at) — format/truncate
- date('now'), datetime('now'), strftime('%s','now')
- date('now', '-7 days') — last 7 days
- date(created_at, '+1 month')
- No EXTRACT — use strftime('%m', created_at)

### Strings
- Concatenation: string || string
- LIKE is case-insensitive for ASCII
- LENGTH(), LOWER(), UPPER(), TRIM(), SUBSTR()

### Other
- LIMIT x OFFSET y
- COALESCE(), IFNULL()
- No BOOLEAN — use 0/1
- GROUP_CONCAT() for string aggregation
- No DATE type — dates are stored as TEXT or INTEGER"

   "duckdb"
   "## DuckDB SQL Guide

### Quoting
- ALWAYS quote column aliases with double quotes: AS \"month\", AS \"revenue\"
- String literals: single quotes

### Date/Time
- DATE_TRUNC('month', created_at)
- CURRENT_DATE, CURRENT_TIMESTAMP, NOW()
- CURRENT_DATE - INTERVAL 7 DAY — last 7 days
- DATE_ADD(created_at, INTERVAL 1 MONTH)
- EXTRACT(MONTH FROM created_at), STRFTIME('%Y-%m', created_at)

### Strings
- Concatenation: string || string or CONCAT()
- ILIKE for case-insensitive
- LENGTH(), LOWER(), UPPER(), TRIM(), SUBSTRING()

### Other
- LIMIT x OFFSET y
- COALESCE()
- LIST_AGG(), STRING_AGG(), ARRAY_AGG()
- Supports LIST, STRUCT, MAP types
- FILTER (WHERE ...) clause supported"

   "vertica"
   "## Vertica SQL Guide

### Quoting
- ALWAYS quote column aliases with double quotes: AS \"month\", AS \"revenue\"
- String literals: single quotes

### Date/Time
- DATE_TRUNC('month', created_at)
- CURRENT_DATE, CURRENT_TIMESTAMP, NOW()
- CURRENT_DATE - INTERVAL '7 days' or TIMESTAMPADD('DAY', -7, CURRENT_DATE)

### Strings
- Concatenation: string || string
- ILIKE for case-insensitive
- LENGTH(), LOWER(), UPPER(), TRIM(), SUBSTR()

### Other
- LIMIT x OFFSET y
- NVL(), COALESCE()
- LISTAGG() for string aggregation"})

(def ^:private sql-guide-default
  "## Generic SQL Guide

### Quoting
- ALWAYS quote column aliases with double quotes: AS \"month\", AS \"revenue\"
- Many words are reserved (month, year, date, user, name, type, order, group, count, sum)
- If you use them as aliases without quoting, the query WILL fail
- String literals: single quotes

### Date/Time
- Check the engine type and use the appropriate date functions
- Common: DATE_TRUNC, EXTRACT, CURRENT_DATE, DATEADD

### Strings
- Concatenation varies: || (most), CONCAT() (MySQL/BigQuery), + (SQL Server)

### General rules
- Always quote ALL aliases, not just reserved words — this prevents subtle bugs
- Use COALESCE() for null handling
- Use LIMIT for pagination (except SQL Server which uses TOP)")

(defn- get-sql-guide [database-id]
  (let [db (t2/select-one :model/Database :id database-id)
        _  (api/check-404 db)
        _  (api/check-403 (mi/can-read? db))
        engine (name (:engine db))]
    (str (format "SQL guide for database \"%s\" (ID: %d, Engine: %s):\n\n"
                 (:name db) (:id db) engine)
         (get sql-guides engine sql-guide-default))))

(defn- get-document-guide []
  "## Metabase Document Authoring Guide (ProseMirror AST)

Documents use a ProseMirror AST: a JSON object with `type` and `content` fields.
The top-level node is always `{\"type\": \"doc\", \"content\": [...]}`.

### Block nodes (top-level children of \"doc\")

1. **paragraph** — basic text block
   {\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"Hello world\"}]}
   Empty paragraph (spacer): {\"type\": \"paragraph\"}

2. **heading** — section title (levels 1-6)
   {\"type\": \"heading\", \"attrs\": {\"level\": 2}, \"content\": [{\"type\": \"text\", \"text\": \"Section Title\"}]}

3. **bulletList** — unordered list
   {\"type\": \"bulletList\", \"content\": [
     {\"type\": \"listItem\", \"content\": [{\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"Item 1\"}]}]},
     {\"type\": \"listItem\", \"content\": [{\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"Item 2\"}]}]}
   ]}

4. **orderedList** — numbered list (same structure as bulletList but type is \"orderedList\")

5. **codeBlock** — fenced code block
   {\"type\": \"codeBlock\", \"content\": [{\"type\": \"text\", \"text\": \"SELECT * FROM orders\"}]}

6. **blockquote** — quoted text
   {\"type\": \"blockquote\", \"content\": [{\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"Important note\"}]}]}

7. **horizontalRule** — divider line
   {\"type\": \"horizontalRule\"}

8. **cardEmbed** — embedded Metabase question/visualization (IMPORTANT)
   Wrap in a resizeNode for proper rendering:
   {\"type\": \"resizeNode\", \"content\": [{\"type\": \"cardEmbed\", \"attrs\": {\"id\": <card_id>, \"name\": null}}]}
   The card_id must be a valid saved question ID. Create questions first, then embed them.

9. **image** — inline image
   {\"type\": \"image\", \"attrs\": {\"src\": \"https://...\", \"alt\": \"description\"}}

### Inline marks (applied to text nodes)

Text nodes can have a `marks` array with formatting:
- **bold**: {\"type\": \"text\", \"text\": \"important\", \"marks\": [{\"type\": \"bold\"}]}
- **italic**: {\"type\": \"text\", \"text\": \"emphasis\", \"marks\": [{\"type\": \"italic\"}]}
- **strike**: {\"type\": \"text\", \"text\": \"deleted\", \"marks\": [{\"type\": \"strike\"}]}
- **code**: {\"type\": \"text\", \"text\": \"inline code\", \"marks\": [{\"type\": \"code\"}]}
- **link**: {\"type\": \"text\", \"text\": \"click here\", \"marks\": [{\"type\": \"link\", \"attrs\": {\"href\": \"https://...\"}}]}

Multiple marks can be combined:
{\"type\": \"text\", \"text\": \"bold link\", \"marks\": [{\"type\": \"bold\"}, {\"type\": \"link\", \"attrs\": {\"href\": \"...\"}}]}

### Best practices

1. **Always create questions before embedding them** — call create_notebook_question or create_question first,
   then use the returned card_id in a cardEmbed node.

2. **Structure your document logically** — use headings (level 2-3) to organize sections, embed relevant
   charts after explanatory text, and use bullet/ordered lists for key findings.

3. **Wrap cardEmbed in resizeNode** — this is required for the editor to properly render and resize the embed.

4. **Use empty paragraphs as spacers** — add {\"type\": \"paragraph\"} between sections for visual breathing room.

5. **Keep the AST valid** — every text must be inside a paragraph, heading, or listItem.
   Never put text nodes directly inside \"doc\" or \"bulletList\".

6. **Typical document structure**:
   - Heading (level 1): document title
   - Paragraph: introduction / summary
   - Heading (level 2): section for each analysis area
   - Paragraph: explanation
   - resizeNode > cardEmbed: embedded chart
   - Paragraph: interpretation of the chart
   - bulletList: key takeaways
   - Heading (level 2): conclusion

### Complete example

{\"type\": \"doc\", \"content\": [
  {\"type\": \"heading\", \"attrs\": {\"level\": 1}, \"content\": [{\"type\": \"text\", \"text\": \"Q1 Revenue Report\"}]},
  {\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"This report summarizes revenue trends for Q1 2025.\"}]},
  {\"type\": \"heading\", \"attrs\": {\"level\": 2}, \"content\": [{\"type\": \"text\", \"text\": \"Monthly Revenue\"}]},
  {\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"Revenue grew steadily across all three months:\"}]},
  {\"type\": \"resizeNode\", \"content\": [{\"type\": \"cardEmbed\", \"attrs\": {\"id\": 42, \"name\": null}}]},
  {\"type\": \"paragraph\"},
  {\"type\": \"heading\", \"attrs\": {\"level\": 2}, \"content\": [{\"type\": \"text\", \"text\": \"Key Findings\"}]},
  {\"type\": \"bulletList\", \"content\": [
    {\"type\": \"listItem\", \"content\": [{\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"Revenue up 15% vs Q4\"}]}]},
    {\"type\": \"listItem\", \"content\": [{\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"Top category: Widgets (34% of total)\"}]}]}
  ]}
]}")

(defn- get-analytical-guide []
  "## Analytical Investigation Framework

You are a senior data analyst. When investigating a problem, follow this structured methodology.

### Phase 1: Understand the problem
- Clarify what exactly happened: what metric changed, by how much, when did it start?
- Identify the key metric(s) and the expected vs actual values.
- Determine the time window of the anomaly — when did things start deviating?

### Phase 2: Scope the data landscape
- Identify which tables and databases are relevant (use get_database_tables, get_table_details).
- Check available metrics (list_metrics) — they contain team-agreed definitions, prefer them.
- Understand the data model: what joins exist, what are the key dimensions for slicing.

### Phase 3: Establish baselines
- Query the metric over a broader time range to see historical norms.
- Compare the anomaly period to prior periods (week-over-week, month-over-month).
- Save baseline queries as questions — you'll embed them in the final report.

### Phase 4: Segment & drill down
- Break the metric by key dimensions: geography, product, channel, user segment, platform, etc.
- Look for which segment is driving the change — often one segment explains 80%+ of the shift.
- Use filters to isolate segments and run targeted queries.
- At each step, ask: does this segment explain the anomaly? If not, try another dimension.

### Phase 5: Identify root cause
- Once you find the responsible segment, dig deeper:
  - Did something change upstream (e.g. a data pipeline issue, missing data)?
  - Is there a business event (launch, outage, promotion, seasonality)?
  - Did the definition or tracking change (new event schema, removed field)?
- Cross-reference with other tables if needed (e.g. events vs transactions).

### Phase 6: Quantify the impact
- Calculate the exact impact: how much revenue/users/events were affected?
- Compare against what the numbers would have been without the anomaly.
- Express in both absolute and relative terms (e.g. -$12K, -8% vs prior week).

### Phase 7: Compile the report
Save all key queries as questions, then build a Metabase Document with:
1. **Title**: clear description of the investigation
2. **Executive summary**: 2-3 sentences with the headline finding
3. **Background**: what triggered the investigation, the metric and time range
4. **Analysis sections** (each with an embedded chart + written interpretation):
   - Overall trend (baseline vs anomaly)
   - Segment breakdown (which dimensions explain the change)
   - Root cause deep-dive
5. **Key findings**: bullet list of the most important facts
6. **Impact**: quantified effect on the business
7. **Recommendations**: actionable next steps

### Analytical principles
- **Always show your evidence** — every claim should have a query/chart backing it.
- **Compare, don't just describe** — a number without context is meaningless. Always compare to a baseline.
- **Start broad, then narrow** — don't jump to conclusions. Let the data guide you through progressive filtering.
- **Check data quality first** — before blaming business factors, rule out data issues (NULL spikes, missing days, schema changes).
- **Use percentages AND absolutes** — a 50% drop in a tiny segment matters less than a 5% drop in the biggest one.
- **Be honest about uncertainty** — if the data is inconclusive, say so. Suggest what additional data would help.
- **Think about the audience** — the report should be understandable by someone who wasn't part of the investigation.")

(defn- create-notebook-question [{:strs [name description database_id dataset_query display collection_id]}]
  (let [query-map (if (string? dataset_query)
                    (json/parse-string dataset_query)
                    dataset_query)
        card-data (cond-> {:name          name
                           :dataset_query {:database database_id
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
  (let [ast (json/parse-string content)
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
        card-ids (prose-mirror/card-ids {:document ast :content_type (:content_type doc)})
        ;; Summarize content as plain text (collect text nodes)
        text-summary (->> (tree-seq :content :content ast)
                          (keep #(when (= "text" (:type %)) (:text %)))
                          (clojure.string/join " ")
                          (#(if (> (count %) 500) (str (subs % 0 500) "…") %)))]
    (str (format "Document: \"%s\" (ID: %d)\n" (:name doc) (:id doc))
         (format "- Collection ID: %s\n" (or (:collection_id doc) "root"))
         (format "- Creator: user %d\n" (:creator_id doc))
         (format "- Created: %s\n" (:created_at doc))
         (format "- Updated: %s\n" (:updated_at doc))
         (format "- Archived: %s\n" (:archived doc))
         (when (seq card-ids)
           (format "- Embedded card IDs: %s\n" (clojure.string/join ", " card-ids)))
         (format "- Content preview: %s\n" (if (seq text-summary) text-summary "(no text content)"))
         (format "- URL: /document/%d" (:id doc)))))

(defn- update-document [{:strs [document_id name content collection_id archived]}]
  (let [doc (t2/select-one :model/Document :id document_id)
        _   (api/check-404 doc)
        _   (api/check-403 (mi/can-write? doc))
        updates (cond-> {}
                  (some? name)          (assoc :name name)
                  (some? content)       (assoc :document (json/parse-string content)
                                               :content_type prose-mirror/prose-mirror-content-type)
                  (some? collection_id) (assoc :collection_id collection_id)
                  (some? archived)      (assoc :archived archived))]
    (when (seq updates)
      (t2/update! :model/Document :id document_id updates))
    (format "Document updated successfully!\n- ID: %d\n- URL: /document/%d"
            document_id document_id)))

(defn- list-metrics [database-id table-id]
  (let [metrics (->> (cond-> {:archived false
                              :type     :metric}
                       database-id (assoc :database_id database-id)
                       table-id    (assoc :table_id table-id))
                     (apply concat)
                     (apply t2/select :model/Card)
                     (filter mi/can-read?)
                     (take 50))]
    (if (empty? metrics)
      (cond
        (and database-id table-id) (format "No metrics found for table %d in database %d." table-id database-id)
        database-id                (format "No metrics found in database %d." database-id)
        table-id                   (format "No metrics found for table %d." table-id)
        :else                      "No metrics found.")
      (str (format "Available metrics (%d):\n" (count metrics))
           (clojure.string/join "\n"
             (map (fn [m]
                    (let [tbl (when (:table_id m)
                                (t2/select-one :model/Table :id (:table_id m)))]
                      (str (format "- ID: %d, Name: \"%s\"" (:id m) (:name m))
                           (when (:description m) (str ", Desc: " (:description m)))
                           (when tbl (format ", Table: %s (ID: %d)" (:name tbl) (:id tbl)))
                           (format ", Database ID: %d" (:database_id m))
                           (format "\n  Use in MBQL aggregation: [\"metric\", %d]" (:id m)))))
                  metrics))))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Dispatcher
;;; ─────────────────────────────────────────────────────────────────────────────

(defn execute-tool
  "Execute a tool call and return its string result.
   Runs under the current user's bound identity/permissions."
  [tool-name args]
  (try
    (case tool-name
      "list_databases"    (list-databases)
      "get_database_schema" (get-database-schema (get args "database_id"))
      "list_questions"    (list-questions (get args "search"))
      "search_items"      (search-items (get args "query") (get args "type"))
      "run_query"         (run-query (get args "database_id") (get args "sql"))
      "execute_card"      (execute-card (get args "card_id"))
      "get_card_details"  (get-card-details (get args "card_id"))
      "get_dashboard_details" (get-dashboard-details (get args "dashboard_id"))
      "get_table_details"  (get-table-details (get args "table_id"))
      "list_collections"   (list-collections (get args "parent_id"))
      "get_collection_contents" (get-collection-contents (get args "collection_id"))
      "create_question"   (create-question args)
      "update_question"   (update-question args)
      "create_dashboard"  (create-dashboard args)
      "add_card_to_dashboard" (add-card-to-dashboard args)
      "archive_item"      (archive-item (get args "item_type") (get args "item_id"))
      "move_item"         (move-item (get args "item_type") (get args "item_id") (get args "collection_id"))
      "get_database_tables" (get-database-tables (get args "database_id"))
      "list_metrics"       (list-metrics (get args "database_id") (get args "table_id"))
      "create_notebook_question" (create-notebook-question args)
      "get_sql_guide"  (get-sql-guide (get args "database_id"))
      "get_mbql_guide" (get-mbql-guide)
      "get_document_guide" (get-document-guide)
      "get_analytical_guide" (get-analytical-guide)
      "run_mbql_query"  (run-mbql-query (get args "database_id") (get args "dataset_query"))
      "create_document" (create-document args)
      "get_document"    (get-document-details (get args "document_id"))
      "update_document" (update-document args)
      (str "Unknown tool: " tool-name))
    (catch Exception e
      (log/warn e "AI Agent tool execution failed" {:tool tool-name})
      (str "Error executing " tool-name ": " (.getMessage e)))))
