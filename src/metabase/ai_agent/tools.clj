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

(declare execute-tool)

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
                                         :type  {:type ["string" "null"]
                                                 :enum ["question" "dashboard" "collection" "table" "metric" "model" "document" nil]
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
    :description "Run an existing saved question (card) by its card_id and return the results. NOT for tables or metrics — use card_id from list_questions, search_items, or context."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:card_id {:type        "integer"
                                                   :description "Card ID (from list_questions, search_items, or context). NOT a table_id or metric_id."}}
                  :required             ["card_id"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "get_card_details"
    :description "Get details of a saved question/model/metric card: name, query, display, collection. Use card_id from list_questions, search_items, or context — NOT a table_id."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:card_id {:type        "integer"
                                                   :description "Card ID (from list_questions, search_items, or [Context] with type=question/model). NOT a table_id or database_id."}}
                  :required             ["card_id"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "get_dashboard_details"
    :description "Get dashboard details: name, cards, filters, layout. Use dashboard_id from search_items or context — NOT a card_id or table_id."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:dashboard_id {:type        "integer"
                                                        :description "Dashboard ID (from search_items or [Context] with type=dashboard). NOT a card_id."}}
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
    :description "Get table columns with field IDs and types. Use table_id from get_database_tables or [Context] with type=table — NOT a card_id."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:table_id {:type        "integer"
                                                    :description "Table ID (from get_database_tables or [Context] with type=table). NOT a card_id or database_id."}}
                  :required             ["table_id"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "create_question"
    :description "Create and save a new SQL question in Metabase. Use this ONLY for native SQL. For structured queries use create_notebook_question."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:name          {:type "string" :description "Question title."}
                                         :database_id   {:type "integer" :description "Database ID."}
                                         :sql           {:type "string" :description "Native SQL query."}
                                         :description   {:type ["string" "null"] :description "Optional description."}
                                         :collection_id {:type ["integer" "null"] :description "Collection ID."}
                                         :display       {:type ["string" "null"] :enum ["table" "bar" "line" "pie" "scalar" "area" "row" "progress" "funnel" "scatter" nil] :description "Visualization type."}}
                  :required             ["name" "database_id" "sql" "description" "collection_id" "display"]
                  :additionalProperties false}}

   {:type        "function"
    :name        "update_question"
    :description "Update an existing saved question. Pass null for fields you don't want to change."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:card_id        {:type "integer" :description "ID of the question to update."}
                                         :name           {:type ["string" "null"] :description "New title."}
                                         :description    {:type ["string" "null"] :description "New description."}
                                         :sql            {:type ["string" "null"] :description "New SQL query."}
                                         :display        {:type ["string" "null"] :enum ["table" "bar" "line" "pie" "scalar" "area" "row" "progress" "funnel" "scatter" nil] :description "New visualization type."}
                                         :collection_id  {:type ["integer" "null"] :description "Move to this collection."}}
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
    :description "Get metric details: name, description, dataset_query, source table. Use metric_id from list_metrics."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:metric_id {:type        "integer"
                                                     :description "Metric card ID (from list_metrics). NOT a table_id or field_id."}}
                  :required             ["metric_id"]
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
    :description "Create and save a question using structured params. The backend builds MBQL automatically. PREFERRED way to create questions."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:name          {:type "string" :description "Question title."}
                                         :database_id   {:type "integer" :description "Database ID."}
                                         :source_table  {:type ["integer" "null"] :description "Table ID to query. Use this OR source_card, never both."}
                                         :source_card   {:type ["integer" "null"] :description "Saved question/model ID to query. Use this OR source_table, never both."}
                                         :aggregations  {:type ["array" "null"]
                                                         :items {:type "object"
                                                                 :properties {:type       {:type "string" :enum ["count" "sum" "avg" "min" "max" "distinct" "metric" "divide" "multiply" "subtract" "add"]}
                                                                              :field_id   {:type ["integer" "null"] :description "Field ID for sum/avg/min/max/distinct."}
                                                                              :metric_ids {:type ["array" "null"] :items {:type "integer"} :description "Metric IDs. For type=metric: [id]. For divide/multiply/subtract/add: [numerator_id, denominator_id]."}
                                                                              :scalar     {:type ["number" "null"] :description "Multiply result by this (e.g. 1000 for eCPM)."}}
                                                                 :required ["type" "field_id" "metric_ids" "scalar"]
                                                                 :additionalProperties false}
                                                         :description "Aggregations. Use type=metric for saved metrics, type=divide for metric1/metric2."}
                                         :breakouts     {:type ["array" "null"]
                                                         :items {:type "object"
                                                                 :properties {:field_id      {:type "integer"}
                                                                              :temporal_unit {:type ["string" "null"] :enum ["minute" "hour" "day" "week" "month" "quarter" "year" nil]}}
                                                                 :required ["field_id" "temporal_unit"]
                                                                 :additionalProperties false}
                                                         :description "Group by fields. Use temporal_unit for date fields."}
                                         :filters       {:type ["array" "null"]
                                                         :items {:type "object"
                                                                 :properties {:operator {:type "string" :enum ["=" "!=" ">" "<" ">=" "<=" "between" "contains" "does-not-contain" "starts-with" "ends-with" "is-null" "not-null" "is-empty" "not-empty" "time-interval"]}
                                                                              :field_id {:type "integer"}
                                                                              :values   {:type "array" :items {:type ["string" "number" "boolean" "null"]} :description "Filter values. =: [val]. between: [min, max]. time-interval: [-7, \"day\"]. is-null: []."}}
                                                                 :required ["operator" "field_id" "values"]
                                                                 :additionalProperties false}
                                                         :description "Filters. For time-interval: values=[-7, \"day\"] means last 7 days. For is-null: values=[]."}
                                         :order_by      {:type ["array" "null"]
                                                         :items {:type "object"
                                                                 :properties {:field_id          {:type ["integer" "null"] :description "Field ID to sort by. null if sorting by aggregation."}
                                                                              :aggregation_index {:type ["integer" "null"] :description "Aggregation index (0-based) to sort by. null if sorting by field."}
                                                                              :direction         {:type "string" :enum ["asc" "desc"]}}
                                                                 :required ["field_id" "aggregation_index" "direction"]
                                                                 :additionalProperties false}}
                                         :limit         {:type ["integer" "null"] :description "Max rows to return."}
                                         :display       {:type ["string" "null"] :enum ["table" "bar" "line" "pie" "scalar" "area" "row" "progress" "funnel" "scatter" nil] :description "Visualization type."}
                                         :description   {:type ["string" "null"] :description "Optional description."}
                                         :collection_id {:type ["integer" "null"] :description "Collection ID to save into."}}
                  :required             ["name" "database_id" "source_table" "source_card" "aggregations" "breakouts" "filters" "order_by" "limit" "display" "description" "collection_id"]
                  :additionalProperties false}}
   {:type        "function"
    :name        "run_mbql_query"
    :description "Run a structured query and return results without saving. The backend builds MBQL from structured params."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:database_id   {:type "integer" :description "Database ID."}
                                         :source_table  {:type ["integer" "null"] :description "Table ID. Use this OR source_card."}
                                         :source_card   {:type ["integer" "null"] :description "Saved question/model ID. Use this OR source_table."}
                                         :aggregations  {:type ["array" "null"] :description "What to calculate."
                                                         :items {:type "object"
                                                                 :properties {:type       {:type "string" :enum ["count" "sum" "avg" "min" "max" "distinct" "metric" "divide" "multiply" "subtract" "add"] :description "Aggregation type."}
                                                                              :field_id   {:type ["integer" "null"] :description "Field ID for sum/avg/min/max/distinct. Null for count/metric."}
                                                                              :metric_ids {:type ["array" "null"] :items {:type "integer"} :description "For metric: [id]. For divide: [numerator_id, denominator_id]."}
                                                                              :scalar     {:type ["number" "null"] :description "Multiply result (e.g. 1000 for eCPM)."}}
                                                                 :required ["type" "field_id" "metric_ids" "scalar"]
                                                                 :additionalProperties false}}
                                         :breakouts     {:type ["array" "null"] :description "Group by fields."
                                                         :items {:type "object"
                                                                 :properties {:field_id {:type "integer" :description "Field ID to group by."} :temporal_unit {:type ["string" "null"] :enum ["minute" "hour" "day" "week" "month" "quarter" "year" nil] :description "Time grouping. Null for non-date."}}
                                                                 :required ["field_id" "temporal_unit"]
                                                                 :additionalProperties false}}
                                         :filters       {:type ["array" "null"] :description "Row filters. Multiple are ANDed."
                                                         :items {:type "object"
                                                                 :properties {:operator {:type "string" :enum ["=" "!=" ">" "<" ">=" "<=" "between" "contains" "does-not-contain" "starts-with" "ends-with" "is-null" "not-null" "is-empty" "not-empty" "time-interval"] :description "Filter operator."}
                                                                              :field_id {:type "integer" :description "Field ID to filter."}
                                                                              :values   {:type "array" :items {:type ["string" "number" "boolean" "null"]} :description "Values. =:[val]. between:[min,max]. time-interval:[-7,\"day\"]. is-null:[]."}}
                                                                 :required ["operator" "field_id" "values"]
                                                                 :additionalProperties false}}
                                         :order_by      {:type ["array" "null"] :description "Sort order."
                                                         :items {:type "object"
                                                                 :properties {:field_id {:type ["integer" "null"] :description "Field to sort. Null if by aggregation."} :aggregation_index {:type ["integer" "null"] :description "0-based agg index. Null if by field."} :direction {:type "string" :enum ["asc" "desc"] :description "Sort direction."}}
                                                                 :required ["field_id" "aggregation_index" "direction"]
                                                                 :additionalProperties false}}
                                         :limit         {:type ["integer" "null"] :description "Max rows."}}
                  :required             ["database_id" "source_table" "source_card" "aggregations" "breakouts" "filters" "order_by" "limit"]
                  :additionalProperties false}}
   {:type        "function"
    :name        "create_document"
    :description "Create a new Metabase Document. Pass structured nodes — the backend converts to ProseMirror AST automatically. Start with title + 1-2 nodes, use append_to_document for the rest."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:name          {:type        "string"
                                                         :description "Document title."}
                                         :nodes         {:type  "array"
                                                         :items {:type                 "object"
                                                                 :properties           {:type     {:type "string" :enum ["heading" "paragraph" "bullet_list" "ordered_list" "card_embed" "code_block" "blockquote" "horizontal_rule" "image"]}
                                                                                        :text     {:type ["string" "null"] :description "Text content. For paragraph, heading, code_block, blockquote."}
                                                                                        :level    {:type ["integer" "null"] :description "Heading level 1-6. Only for type=heading."}
                                                                                        :items    {:type ["array" "null"] :items {:type "string"} :description "List items as strings. Only for bullet_list/ordered_list."}
                                                                                        :card_id  {:type ["integer" "null"] :description "Card ID to embed. Only for type=card_embed."}
                                                                                        :src      {:type ["string" "null"] :description "Image URL. Only for type=image."}
                                                                                        :alt      {:type ["string" "null"] :description "Image alt text. Only for type=image."}
                                                                                        :language {:type ["string" "null"] :description "Code language. Only for type=code_block."}}
                                                                 :required             ["type" "text" "level" "items" "card_id" "src" "alt" "language"]
                                                                 :additionalProperties false}
                                                         :description "Array of content nodes. Each node has a type and relevant fields."}
                                         :collection_id {:type        ["integer" "null"]
                                                         :description "Collection ID to save the document into. Pass null for default."}}
                  :required             ["name" "nodes" "collection_id"]
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
    :description "Update an existing Metabase Document. Pass null for fields you don't want to change. To replace content, pass structured nodes — backend converts to ProseMirror AST."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:document_id   {:type "integer" :description "The document ID to update."}
                                         :name          {:type ["string" "null"] :description "New document name."}
                                         :nodes         {:type ["array" "null"]
                                                         :items {:type "object"
                                                                 :properties {:type {:type "string" :enum ["heading" "paragraph" "bullet_list" "ordered_list" "card_embed" "code_block" "blockquote" "horizontal_rule" "image"]}
                                                                              :text {:type ["string" "null"]}
                                                                              :level {:type ["integer" "null"]}
                                                                              :items {:type ["array" "null"] :items {:type "string"}}
                                                                              :card_id {:type ["integer" "null"]}
                                                                              :src {:type ["string" "null"]}
                                                                              :alt {:type ["string" "null"]}
                                                                              :language {:type ["string" "null"]}}
                                                                 :required ["type" "text" "level" "items" "card_id" "src" "alt" "language"]
                                                                 :additionalProperties false}
                                                         :description "New document content as structured nodes. Pass null to keep unchanged."}
                                         :collection_id {:type ["integer" "null"] :description "New collection ID."}
                                         :archived      {:type ["boolean" "null"] :description "Archive/unarchive."}}
                  :required             ["document_id" "name" "nodes" "collection_id" "archived"]
                  :additionalProperties false}}
   {:type        "function"
    :name        "append_to_document"
    :description "Append new sections to the END of an existing Metabase Document. Pass structured nodes — the backend converts to ProseMirror AST automatically. Send 1-3 nodes per call."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:document_id {:type        "integer"
                                                       :description "The document ID to append to."}
                                         :nodes       {:type  "array"
                                                       :items {:type                 "object"
                                                               :properties           {:type     {:type "string" :enum ["heading" "paragraph" "bullet_list" "ordered_list" "card_embed" "code_block" "blockquote" "horizontal_rule" "image"]}
                                                                                      :text     {:type ["string" "null"] :description "Text content."}
                                                                                      :level    {:type ["integer" "null"] :description "Heading level 1-6."}
                                                                                      :items    {:type ["array" "null"] :items {:type "string"} :description "List items as strings."}
                                                                                      :card_id  {:type ["integer" "null"] :description "Card ID to embed."}
                                                                                      :src      {:type ["string" "null"] :description "Image URL."}
                                                                                      :alt      {:type ["string" "null"] :description "Image alt text."}
                                                                                      :language {:type ["string" "null"] :description "Code language."}}
                                                               :required             ["type" "text" "level" "items" "card_id" "src" "alt" "language"]
                                                               :additionalProperties false}
                                                       :description "Array of content nodes to append."}}
                  :required             ["document_id" "nodes"]
                  :additionalProperties false}}
   {:type        "function"
    :name        "delegate_task"
    :description "Delegate a research task to a sub-agent with a clean context. The sub-agent gets its own conversation with AI, has access to ALL the same tools, and returns a concise text result. Use this when you need to: (1) search for specific metrics/questions/dashboards without polluting your context, (2) investigate a specific data question, (3) look up field details or metric definitions, (4) load a guide and extract specific information. The sub-agent has max 10 tool iterations and returns plain text summary."
    :strict      true
    :parameters  {:type                 "object"
                  :properties           {:task          {:type        "string"
                                                         :description "Clear description of what the sub-agent should do. Be specific: include database IDs, table names, metric names, etc. Example: \"Find all metrics related to ad revenue in database 2 and return their IDs and names\""}
                                         :response_format {:type        "string"
                                                           :description "How the sub-agent should format its response. Example: \"Return a numbered list of metric ID: name pairs\" or \"Return ONLY the JSON template for heading + paragraph + card embed, nothing else\" or \"Return a bullet list with field_id, field_name, field_type for each column\""}}
                  :required             ["task" "response_format"]
                  :additionalProperties false}}
   ])

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Tool implementations
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- run-search-single
  "Run a single search query."
  [query {:keys [models table-db-id limit] :or {limit 50}}]
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
      (or (:data (search/search (search/search-context ctx))) [])
      (catch Exception e
        (log/warn e "Search failed" {:term query})
        []))))

(defn- run-search
  "Run Metabase search engine with word-level splitting and union.
   First tries the full query. If no results, splits into individual words
   and searches each, then deduplicates by :id."
  [query & {:keys [models table-db-id limit] :as opts-map}]
  (let [opts   (or opts-map {})
        ;; Try full query first
        full-results (run-search-single query opts)]
    (if (seq full-results)
      full-results
      ;; No results — split into words and search each
      (let [words (->> (str/split (str/trim query) #"[\s_\-]+")
                       (filter #(>= (count %) 2))
                       distinct)
            limit-per-word (max 10 (quot (or limit 50) (max 1 (count words))))]
        (if (<= (count words) 1)
          full-results ;; single word already tried
          (let [all-results (->> words
                                 (mapcat #(run-search-single % (assoc opts :limit limit-per-word)))
                                 ;; deduplicate by id
                                 (reduce (fn [acc item]
                                           (if (contains? (:seen acc) (:id item))
                                             acc
                                             (-> acc
                                                 (update :seen conj (:id item))
                                                 (update :items conj item))))
                                         {:seen #{} :items []})
                                 :items
                                 (take (or limit 50)))]
            all-results))))))

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
        query  {:database   database-id
                :type       :native
                :native     {:query sql :template-tags {}}
                :middleware {:userland-query? true}}
        result (try
                 (qp/process-query
                  (assoc query :info {:executed-by api/*current-user-id*
                                      :context     :ad-hoc
                                      :query-hash  (qp.util/query-hash query)}))
                 (catch Exception e
                   {:error (.getMessage e)}))]
    (format-qp-result result)))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Simplified params → MBQL converter
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- field-ref
  "Build a field reference from field_id and optional temporal_unit."
  ([field-id] ["field" field-id nil])
  ([field-id temporal-unit]
   (if temporal-unit
     ["field" field-id {"temporal-unit" temporal-unit}]
     ["field" field-id nil])))

(defn- build-aggregation
  "Convert a simplified aggregation map to MBQL clause."
  [{:strs [type field_id metric_ids scalar]}]
  (let [m1 (first metric_ids)
        m2 (second metric_ids)
        agg (case type
              "count"    ["count"]
              "sum"      ["sum" (field-ref field_id)]
              "avg"      ["avg" (field-ref field_id)]
              "min"      ["min" (field-ref field_id)]
              "max"      ["max" (field-ref field_id)]
              "distinct" ["distinct" (field-ref field_id)]
              "metric"   ["metric" m1]
              "divide"   ["/" ["metric" m1] ["metric" m2]]
              "multiply" ["*" ["metric" m1] ["metric" m2]]
              "subtract" ["-" ["metric" m1] ["metric" m2]]
              "add"      ["+" ["metric" m1] ["metric" m2]]
              ["count"])]
    (if (and scalar (#{"divide" "multiply" "subtract" "add"} type))
      ["*" agg scalar]
      agg)))

(defn- build-filter
  "Convert a simplified filter map to MBQL clause."
  [{:strs [operator field_id values]}]
  (let [v1 (first values)
        v2 (second values)]
    (case operator
      ("=" "!=" ">" "<" ">=" "<=")
      [operator (field-ref field_id) v1]

      "between"
      ["between" (field-ref field_id) v1 v2]

      ("contains" "does-not-contain" "starts-with" "ends-with")
      [operator (field-ref field_id) v1]

      ("is-null" "not-null" "is-empty" "not-empty")
      [operator (field-ref field_id)]

      "time-interval"
      ["time-interval" (field-ref field_id) v1 v2]

      ;; fallback
      ["=" (field-ref field_id) v1])))

(defn- build-order-by
  "Convert a simplified order-by map to MBQL clause."
  [{:strs [field_id aggregation_index direction]}]
  (let [dir (or direction "asc")]
    (if aggregation_index
      [dir ["aggregation" aggregation_index]]
      [dir (field-ref field_id)])))

(defn- structured-params->mbql-query
  "Convert structured tool params to an MBQL inner query map."
  [{:strs [source_table source_card aggregations breakouts filters order_by limit]}]
  (cond-> {}
    source_table           (assoc "source-table" source_table)
    source_card            (assoc "source-card" source_card)
    (seq aggregations)     (assoc "aggregation" (mapv build-aggregation aggregations))
    (seq breakouts)        (assoc "breakout" (mapv (fn [{:strs [field_id temporal_unit]}]
                                                     (field-ref field_id temporal_unit))
                                                   breakouts))
    (seq filters)          (assoc "filter" (if (= 1 (count filters))
                                             (build-filter (first filters))
                                             (into ["and"] (mapv build-filter filters))))
    (seq order_by)         (assoc "order-by" (mapv build-order-by order_by))
    limit                  (assoc "limit" limit)))


(defn- run-mbql-query [args]
  (let [query-map   (structured-params->mbql-query args)
        database-id (get args "database_id")
        _  (when-not database-id
             (throw (ex-info "database_id is required." {})))
        db (t2/select-one :model/Database :id database-id)
        _  (api/check-404 db)
        _  (api/check-403 (mi/can-read? db))
        query  {:database   database-id
                :type       :query
                :query      query-map
                :middleware {:userland-query? true}}
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
        _    (when-not card
               (throw (ex-info (format "Card/question with ID %d not found. Make sure you're using a valid card_id." card-id) {})))
        _    (api/check-403 (mi/can-read? card))
        dq   (:dataset_query card)
        result (try
                 (qp/process-query
                  (assoc dq
                         :middleware {:userland-query? true}
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
        _    (when-not card
               (throw (ex-info (format "Card/question with ID %d not found. Check that you're using a card_id, not a table_id or metric_id." card-id) {})))
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
        _    (when-not dash
               (throw (ex-info (format "Dashboard with ID %d not found." dashboard-id) {})))
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
        _      (when-not tbl
                 (throw (ex-info (format "Table with ID %d not found." table-id) {})))
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


(defn- get-metrics-guide []
  (load-guide-file! "MB_AI_AGENT_METRICS_GUIDE_FILE"))

(defn- get-search-guide []
  (load-guide-file! "MB_AI_AGENT_SEARCH_GUIDE_FILE"))

(defn- get-analytical-guide []
  (load-guide-file! "MB_AI_AGENT_ANALYTICAL_GUIDE_FILE"))


(defn- create-notebook-question [{:strs [name description database_id display collection_id] :as args}]
  (when collection_id
    (let [coll (t2/select-one :model/Collection :id collection_id)]
      (api/check-404 coll)
      (api/check-403 (mi/can-write? coll))))
  (let [query-map (structured-params->mbql-query args)
        _  (when-not database_id
             (throw (ex-info "database_id is required." {})))
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

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Simplified node → ProseMirror AST converter
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- text-node [text]
  {:type "text" :text text})

(defn- paragraph-node [text]
  (if text
    {:type "paragraph" :content [(text-node text)]}
    {:type "paragraph"}))

(defn- simplified->ast-node
  "Convert a simplified node map to a ProseMirror AST node."
  [{:strs [type text level items card_id src alt language]
    :keys [type text level items card_id src alt language]
    :as   node}]
  (let [t (or (get node "type") (get node :type) type)
        txt (or (get node "text") (get node :text) text)
        lvl (or (get node "level") (get node :level) level)
        itms (or (get node "items") (get node :items) items)
        cid (or (get node "card_id") (get node :card_id) card_id)
        img-src (or (get node "src") (get node :src) src)
        img-alt (or (get node "alt") (get node :alt) alt)
        lang (or (get node "language") (get node :language) language)]
    (case t
      "heading"          {:type "heading"
                          :attrs {:level (or lvl 2)}
                          :content [(text-node (or txt ""))]}
      "paragraph"        (paragraph-node txt)
      "bullet_list"      {:type "bulletList"
                          :content (mapv (fn [item]
                                          {:type "listItem"
                                           :content [(paragraph-node item)]})
                                        (or itms []))}
      "ordered_list"     {:type "orderedList"
                          :content (mapv (fn [item]
                                          {:type "listItem"
                                           :content [(paragraph-node item)]})
                                        (or itms []))}
      "card_embed"       {:type "resizeNode"
                          :content [{:type "cardEmbed"
                                     :attrs {:id cid :name nil}}]}
      "code_block"       (cond-> {:type "codeBlock"
                                  :content [(text-node (or txt ""))]}
                           lang (assoc :attrs {:language lang}))
      "blockquote"       {:type "blockquote"
                          :content [(paragraph-node (or txt ""))]}
      "horizontal_rule"  {:type "horizontalRule"}
      "image"            {:type "image"
                          :attrs {:src (or img-src "") :alt (or img-alt "")}}
      ;; fallback
      (paragraph-node (or txt (str "Unknown node type: " t))))))

(defn- simplified-nodes->ast
  "Convert an array of simplified nodes to a complete ProseMirror doc AST."
  [nodes]
  {:type "doc"
   :content (mapv simplified->ast-node nodes)})

(defn- simplified-nodes->ast-nodes
  "Convert an array of simplified nodes to ProseMirror AST nodes (without doc wrapper)."
  [nodes]
  (mapv simplified->ast-node nodes))

(defn- create-document [{:strs [name nodes collection_id]}]
  (when collection_id
    (let [coll (t2/select-one :model/Collection :id collection_id)]
      (api/check-404 coll)
      (api/check-403 (mi/can-write? coll))))
  (let [ast (simplified-nodes->ast nodes)
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
        _   (when-not doc
               (throw (ex-info (format "Document with ID %d not found." document-id) {})))
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

(defn- update-document [{:strs [document_id name nodes collection_id archived]}]
  (let [doc (t2/select-one :model/Document :id document_id)
        _   (api/check-404 doc)
        _   (api/check-403 (mi/can-write? doc))
        updates (cond-> {}
                  (some? name)          (assoc :name name)
                  (some? nodes)         (assoc :document (simplified-nodes->ast nodes)
                                               :content_type prose-mirror/prose-mirror-content-type)
                  (some? collection_id) (assoc :collection_id collection_id)
                  (some? archived)      (assoc :archived archived))]
    (when (seq updates)
      (t2/update! :model/Document :id document_id updates))
    (format "Document updated successfully!\n- ID: %d\n- URL: /document/%d"
            document_id document_id)))

(defn- append-to-document [{:strs [document_id nodes]}]
  (let [doc         (t2/select-one :model/Document :id document_id)
        _           (api/check-404 doc)
        _           (api/check-403 (mi/can-write? doc))
        new-nodes   (simplified-nodes->ast-nodes nodes)
        current-ast (:document doc)
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
                                  :limit 20)]
                    (cond->> results
                      table-id (filter #(= (:table_id %) table-id))))
                  ;; Direct DB query (no search term) — filter by readable databases first
                  (let [readable-db-ids (when-not database-id
                                          (->> (t2/select :model/Database)
                                               (filter mi/can-read?)
                                               (map :id)
                                               set))
                        conditions (cond-> [:type :metric :archived false]
                                     database-id  (into [:database_id database-id])
                                     table-id     (into [:table_id    table-id]))]
                    (->> (apply t2/select :model/Card conditions)
                         ;; Scope to databases the user can read
                         (filter (fn [m]
                                   (let [db-id (or (:database_id m) (:database-id m))]
                                     (if readable-db-ids
                                       (contains? readable-db-ids db-id)
                                       ;; database-id was explicitly provided — check it directly
                                       (when-let [db (t2/select-one :model/Database :id db-id)]
                                         (mi/can-read? db))))))
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
        _    (when-not card
               (throw (ex-info (format "Metric with ID %d not found." metric-id) {})))
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

(def ^:private subagent-system-prompt
  "You are a research sub-agent. Find information and return a CONCISE summary.
You have access to Metabase tools (search, list, get details, guides).
Rules:
- Be concise — return just the key findings (IDs, names, values).
- Do NOT call delegate_task (no recursive sub-agents).
- Do NOT create/modify anything (read-only).
- Max 15 tool calls then return what you have.
- Follow the RESPONSE FORMAT instructions from the task.")

(def ^:private max-subagent-iterations 15)

(def ^:private subagent-excluded-tools
  "Tools excluded from sub-agent to prevent recursion and unnecessary calls."
  #{"delegate_task"
    "create_document" "append_to_document" "update_document"
    "create_notebook_question" "create_question" "create_dashboard"
    "add_card_to_dashboard" "archive_item" "move_item"
    "run_mbql_query"})

(defn- subagent-tool-definitions
  "Tool definitions for sub-agent — read-only, no recursion, no validators."
  []
  (vec (remove #(subagent-excluded-tools (:name %)) tool-definitions)))

(def ^:private subagent-response-schema
  "Structured output schema for sub-agent — plain text result."
  {:type                 "object"
   :properties           {:result {:type "string" :description "The research findings."}}
   :required             ["result"]
   :additionalProperties false})

(defn- delegate-task [task response-format]
  (let [openai-create  (requiring-resolve 'metabase.ai-agent.openai/create-response)
        openai-id      (requiring-resolve 'metabase.ai-agent.openai/response-id)
        openai-failed? (requiring-resolve 'metabase.ai-agent.openai/failed?)
        openai-tools?  (requiring-resolve 'metabase.ai-agent.openai/has-tool-calls?)
        openai-calls   (requiring-resolve 'metabase.ai-agent.openai/extract-tool-calls)
        openai-text    (requiring-resolve 'metabase.ai-agent.openai/extract-text)
        api-key        ((requiring-resolve 'metabase.ai-agent.settings/ai-agent-openai-api-key))
        model          (or ((requiring-resolve 'metabase.ai-agent.settings/ai-agent-openai-model)) "gpt-5.4")
        tools          (subagent-tool-definitions)]
    (loop [opts       {:message      (str task "\n\nRESPONSE FORMAT: " response-format)
                       :text-format  {:type   "json_schema"
                                      :name   "subagent_response"
                                      :strict true
                                      :schema subagent-response-schema}}
           iterations 0]
      (if (>= iterations max-subagent-iterations)
        "Sub-agent reached iteration limit. Partial results may be incomplete."
        (let [response (openai-create (assoc opts
                                             :api-key      api-key
                                             :model        model
                                             :tools        tools
                                             :instructions subagent-system-prompt))]
          (when (openai-failed? response)
            (throw (ex-info "Sub-agent OpenAI call failed" {})))
          (if (openai-tools? response)
            (let [tool-calls (openai-calls response)
                  _          (log/debug "Sub-agent executing tools" {:tools (map :name tool-calls)})
                  results    (mapv (fn [{:keys [call-id name arguments]}]
                                    {:call-id call-id
                                     :output  (execute-tool name arguments)})
                                  tool-calls)]
              (recur (-> opts
                         (dissoc :message :text-format)
                         (assoc :previous-response-id (openai-id response)
                                :tool-results results))
                     (inc iterations)))
            ;; Text response — extract result from structured output
            (let [raw (openai-text response)]
              (try
                (get (json/parse-string raw) "result" raw)
                (catch Exception _ raw)))))))))

;; Tools that are always loaded (high-frequency, core workflow)
(def ^:private immediate-tool-names
  #{"list_databases" "get_database_tables" "get_table_details" "list_metrics" "get_metric"
    "search_items" "list_questions" "list_collections"
    "run_mbql_query" "create_notebook_question" "run_query"
    "execute_card" "get_card_details" "delegate_task"})

;; Tools loaded on demand via tool_search (lower frequency)
(def ^:private deferred-tool-names
  #{"get_database_schema" "get_collection_contents" "get_dashboard_details"
    "create_question" "update_question" "create_dashboard" "add_card_to_dashboard"
    "archive_item" "move_item"
    "create_document" "get_document" "update_document" "append_to_document"
    "get_sql_guide" "get_analytical_guide" "get_metrics_guide" "get_search_guide"})

(def ^:private tool-search-entry
  "The tool_search hosted entry — enables GPT to request deferred tools."
  {:type "tool_search"})

(defn all-tool-definitions
  "Return built-in tool definitions combined with MCP server tools.
   Immediate tools are loaded directly. Deferred tools are marked with defer_loading.
   A tool_search entry enables the model to request deferred tools on demand.
   When safe-mode? is true, all write/modify tools are excluded."
  ([] (all-tool-definitions false nil))
  ([safe-mode?] (all-tool-definitions safe-mode? nil))
  ([safe-mode? user-id]
   (let [built-in   (if safe-mode? (read-only-tools tool-definitions) tool-definitions)
         ;; Mark deferred tools
         marked     (mapv (fn [tool]
                            (if (deferred-tool-names (:name tool))
                              (assoc tool :defer_loading true)
                              tool))
                          built-in)
         ;; Add tool_search entry
         with-search (conj marked tool-search-entry)
         ;; Add MCP tools (always deferred since they're external)
         mcp-tools  (try (mcp/mcp-tool-definitions user-id) (catch Exception _ nil))
         all-tools  (if (seq mcp-tools)
                      (into with-search
                            (if safe-mode?
                              []
                              (mapv #(assoc % :defer_loading true) mcp-tools)))
                      with-search)]
     all-tools)))

(defn execute-tool
  "Execute a tool call and return its string result.
   Routes MCP tools (containing '__') to the MCP client,
   built-in tools to the local dispatcher.
   Pass `user-id` for OAuth2 MCP servers.
   Runs under the current user's bound identity/permissions."
  ([tool-name args] (execute-tool tool-name args nil))
  ([tool-name args user-id]
   (try
     (if (mcp/mcp-tool? tool-name)
       ;; MCP tool — delegate to external server
       (mcp/execute-mcp-tool tool-name args user-id)
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
         "get_analytical_guide" (get-analytical-guide)
         "get_metrics_guide"    (get-metrics-guide)
         "get_search_guide"     (get-search-guide)
         "run_mbql_query"  (run-mbql-query args)
         "create_document" (create-document args)
         "get_document"    (get-document-details (get args "document_id"))
         "update_document" (update-document args)
         "append_to_document" (append-to-document args)
         "delegate_task"      (delegate-task (get args "task") (get args "response_format"))
         (str "Unknown tool: " tool-name)))
     (catch Exception e
       (log/warn e "AI Agent tool execution failed" {:tool tool-name})
       (str "Error executing " tool-name ": " (.getMessage e))))))
