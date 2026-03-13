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
                                         :dataset_query {:type        "object"
                                                         :description "The MBQL structured query object. Must have keys: source-table (integer), and optionally: aggregation, breakout, filter, order-by, limit, joins, expressions."}
                                         :display       {:anyOf       [{:type "string"
                                                                        :enum ["table" "bar" "line" "pie" "scalar" "area" "row" "progress" "funnel" "scatter"]}
                                                                       {:type "null"}]
                                                         :description "Visualization type. Pass null to use default (table)."}
                                         :description   {:type        ["string" "null"]
                                                         :description "Optional description of the question. Pass null if none."}
                                         :collection_id {:type        ["integer" "null"]
                                                         :description "Optional collection ID to save the question into. Pass null for default collection."}}
                  :required             ["name" "database_id" "dataset_query" "display" "description" "collection_id"]
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
                             (take 10 rows))
              total     (count rows)
              note      (when (> total 10)
                          (format "\n... (%d total rows, showing first 10)" total))]
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

(defn- create-notebook-question [{:strs [name description database_id dataset_query display collection_id]}]
  (let [card-data (cond-> {:name          name
                           :dataset_query {:database database_id
                                           :type     :query
                                           :query    dataset_query}
                           :display       (keyword (or display "table"))
                           :visualization_settings {}}
                    description   (assoc :description description)
                    collection_id (assoc :collection_id collection_id))
        card      (queries.card/create-card! card-data @api/*current-user*)]
    (format "Question created successfully!\n- ID: %d\n- Name: \"%s\"\n- Display: %s\n- URL: /question/%d"
            (:id card) (:name card) (clojure.core/name (or (:display card) :table)) (:id card))))

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
      (str "Unknown tool: " tool-name))
    (catch Exception e
      (log/warn e "AI Agent tool execution failed" {:tool tool-name})
      (str "Error executing " tool-name ": " (.getMessage e)))))
