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
                                      :context     :ad-hoc}))
                 (catch Exception e
                   {:error (.getMessage e)}))]
    (format-qp-result result)))

(defn- execute-card [card-id]
  (let [card (t2/select-one :model/Card :id card-id)
        _    (api/check-404 card)
        _    (api/check-403 (mi/can-read? card))
        result (try
                 (qp/process-query
                  (assoc (:dataset_query card)
                         :info {:executed-by api/*current-user-id*
                                :context     :ad-hoc
                                :card-id     card-id}))
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
      "create_question"   (create-question args)
      (str "Unknown tool: " tool-name))
    (catch Exception e
      (log/warn e "AI Agent tool execution failed" {:tool tool-name})
      (str "Error executing " tool-name ": " (.getMessage e)))))
