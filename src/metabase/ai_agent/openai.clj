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
   [clojure.java.io :as io]
   [metabase.util.log :as log]))

(set! *warn-on-reflection* true)

(def ^:private openai-responses-url "https://api.openai.com/v1/responses")

(defn- load-prompt-file!
  "Load a prompt file from the path given by env var.
  Throws if the env var is not set or the file does not exist."
  [env-var]
  (let [path (or (System/getenv env-var)
                 (throw (ex-info (str "BI Agent: env var " env-var " is not set. "
                                      "Set it to the path of the prompt file.")
                                 {:env-var env-var})))
        f    (io/file path)]
    (when-not (.exists f)
      (throw (ex-info (str "BI Agent: " env-var " points to non-existent file '" path "'")
                      {:env-var env-var :path path})))
    (slurp f)))

(defn- effective-system-instructions
  "Read the system prompt from disk on every call.
  File path is taken from MB_AI_AGENT_SYSTEM_PROMPT_FILE at runtime — never at build/compile time."
  []
  (load-prompt-file! "MB_AI_AGENT_SYSTEM_PROMPT_FILE"))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Request building
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- build-input
  "Build the `input` array for a Responses API request.

  - Tool result turn: array of function_call_output items (one per tool result).
  - User message turn: array with a single user message item (optionally with a file attachment)."
  [{:keys [message tool-results file]}]
  (if (seq tool-results)
    ;; Submitting tool outputs — field is `call_id` (not `tool_call_id`)
    (mapv (fn [{:keys [call-id output]}]
            {:type    "function_call_output"
             :call_id call-id
             :output  (str output)})
          tool-results)
    ;; Regular user turn — string content when no file, array when file attached
    [{:role    "user"
      :content (if file
                 ;; Array of content parts required when file is present
                 (cond-> []
                   (seq (clojure.string/trim (str message)))
                   (conj {:type "input_text" :text (clojure.string/trim (str message))})
                   file
                   (conj {:type      "input_file"
                          :filename  (:filename file)
                          :file_data (:file-data file)}))
                 ;; Plain string for text-only messages (simpler, backward-compatible)
                 (str message))}]))

(def ^:private response-json-schema
  "Unified JSON schema for structured output. 6 universal fields per block.
   Backend converts to the legacy format that frontend expects."
  {:type                 "object"
   :description          "BI Agent response. Use MULTIPLE blocks with specific types — do NOT put everything in one text block. Use card_link for questions, dashboard_link for dashboards, document_link for documents."
   :properties           {:blocks      {:type  "array"
                                        :description "Content blocks. Each block has a type and 5 universal fields. Use the right type for each piece — text for explanations, card_link for question references, table for data, etc."
                                        :items {:type                 "object"
                                                :description          "A content block. Fill only the fields relevant to the type. Set irrelevant fields to null."
                                                :properties           {:type    {:type "string"
                                                                                :enum ["text" "sql" "card_link" "card_preview" "dashboard_link" "document_link" "notebook_link" "table"]
                                                                                :description "Block type. text=markdown, sql=code, card_link=link to question, card_preview=created question, dashboard_link=link to dashboard, document_link=link to document, notebook_link=MBQL draft, table=inline data."}
                                                                      :content {:type ["string" "null"]
                                                                                :description "For text: markdown content. For sql: SQL code. Null for other types."}
                                                                      :id      {:type ["integer" "null"]
                                                                                :description "For card_link/card_preview: card ID. For dashboard_link: dashboard ID. For document_link: document ID. Null for text/sql/notebook_link/table."}
                                                                      :name    {:type ["string" "null"]
                                                                                :description "Human-readable display name. Required for card_link, card_preview, dashboard_link, document_link, notebook_link. Null for text/sql/table."}
                                                                      :display {:type ["string" "null"]
                                                                                :enum ["line" "bar" "area" "pie" "table" "scalar" "row" "progress" "funnel" "scatter" nil]
                                                                                :description "Visualization type. For card_preview and notebook_link. Null for others."}
                                                                      :data    {:type ["object" "null"]
                                                                                :description "Table data for table block only. Null for all other types."
                                                                                :properties {:columns {:type "array" :items {:type "string"} :description "Column names."}
                                                                                             :rows    {:type "array" :items {:type "array" :items {:type ["string" "number" "boolean" "null"]}} :description "Row data."}}
                                                                                :required ["columns" "rows"]
                                                                                :additionalProperties false}
                                                                      :query   {:type ["object" "null"]
                                                                                :description "Structured query for notebook_link only. Null for all other types."
                                                                                :properties {:database_id  {:type "integer" :description "Database ID to query."}
                                                                                             :source_table {:type ["integer" "null"] :description "Table ID. Use this OR source_card, never both."}
                                                                                             :source_card  {:type ["integer" "null"] :description "Saved question/model ID. Use this OR source_table, never both."}
                                                                                             :aggregations {:type ["array" "null"]
                                                                                                            :description "What to calculate. Use metric for saved metrics, divide for ratios."
                                                                                                            :items {:type "object"
                                                                                                                    :description "One aggregation."
                                                                                                                    :properties {:type {:type "string" :enum ["count" "sum" "avg" "min" "max" "distinct" "metric" "divide" "multiply" "subtract" "add"] :description "count/sum/avg/min/max/distinct=field agg. metric=saved metric. divide/multiply/subtract/add=combine two metrics."}
                                                                                                                                 :field_id {:type ["integer" "null"] :description "Field ID for sum/avg/min/max/distinct. Null for count/metric/divide."}
                                                                                                                                 :metric_ids {:type ["array" "null"] :items {:type "integer"} :description "Metric IDs. For metric: [id]. For divide/multiply: [numerator_id, denominator_id]. Null for field aggregations."}
                                                                                                                                 :scalar {:type ["number" "null"] :description "Multiply result by this (e.g. 1000 for eCPM). Only for divide/multiply/subtract/add."}}
                                                                                                                    :required ["type" "field_id" "metric_ids" "scalar"]
                                                                                                                    :additionalProperties false}}
                                                                                             :breakouts {:type ["array" "null"]
                                                                                                         :description "Group by fields. Use temporal_unit for date grouping."
                                                                                                         :items {:type "object"
                                                                                                                 :description "One breakout dimension."
                                                                                                                 :properties {:field_id {:type "integer" :description "Field ID to group by."}
                                                                                                                              :temporal_unit {:type ["string" "null"] :enum ["minute" "hour" "day" "week" "month" "quarter" "year" nil] :description "Time grouping. Null for non-date fields."}}
                                                                                                                 :required ["field_id" "temporal_unit"]
                                                                                                                 :additionalProperties false}}
                                                                                             :filters {:type ["array" "null"]
                                                                                                       :description "Row filters. Multiple filters are ANDed."
                                                                                                       :items {:type "object"
                                                                                                               :description "One filter condition."
                                                                                                               :properties {:operator {:type "string" :enum ["=" "!=" ">" "<" ">=" "<=" "between" "contains" "does-not-contain" "starts-with" "ends-with" "is-null" "not-null" "is-empty" "not-empty" "time-interval"] :description "Filter operator."}
                                                                                                                            :field_id {:type "integer" :description "Field ID to filter on."}
                                                                                                                            :values {:type "array" :items {:type ["string" "number" "boolean" "null"]} :description "Filter values. =: [val]. between: [min, max]. time-interval: [-7, \"day\"]. is-null: []."}}
                                                                                                               :required ["operator" "field_id" "values"]
                                                                                                               :additionalProperties false}}
                                                                                             :order_by {:type ["array" "null"]
                                                                                                        :description "Sort order."
                                                                                                        :items {:type "object"
                                                                                                                :description "One sort clause."
                                                                                                                :properties {:field_id {:type ["integer" "null"] :description "Field ID to sort by. Null if sorting by aggregation."}
                                                                                                                             :aggregation_index {:type ["integer" "null"] :description "0-based aggregation index to sort by. Null if sorting by field."}
                                                                                                                             :direction {:type "string" :enum ["asc" "desc"] :description "Sort direction."}}
                                                                                                                :required ["field_id" "aggregation_index" "direction"]
                                                                                                                :additionalProperties false}}
                                                                                             :limit {:type ["integer" "null"] :description "Max rows. Null for no limit."}}
                                                                                :required ["database_id" "source_table" "source_card" "aggregations" "breakouts" "filters" "order_by" "limit"]
                                                                                :additionalProperties false}}
                                                :required             ["type" "content" "id" "name" "display" "data" "query"]
                                                :additionalProperties false}}
                          :suggestions {:type  "array"
                                        :description "2-6 short follow-up prompts the user can click. Human-readable, max 60 chars each, no internal IDs."
                                        :items {:type "string"}}
                          :title       {:type ["string" "null"]
                                        :description "Short conversation title (3-7 words) summarizing the conversation topic. Generate on every response. Use the same language as the user's message."}}
   :required             ["blocks" "suggestions" "title"]
   :additionalProperties false})

(defn- build-request-body
  "Build the complete POST body for /v1/responses."
  [{:keys [model tools previous-response-id instructions text-format] :as opts}]
  (cond-> {:model             model
           ;; System prompt via `instructions` — use override if provided, else load from file
           :instructions      (or instructions (effective-system-instructions))
           :input             (build-input opts)
           :store             true       ; store=true is required for previous_response_id to work
           :max_output_tokens 65536      ; large limit so tool call arguments (e.g. ProseMirror AST) aren't truncated
           ;; Structured output — use override if provided, else default unified schema
           :text              {:format (or text-format
                                           {:type   "json_schema"
                                            :name   "agent_response"
                                            :strict true
                                            :schema response-json-schema})}}

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
    (let [do-request (fn []
                       (http/post openai-responses-url
                                  {:headers         {"Authorization" (str "Bearer " api-key)
                                                     "Content-Type"  "application/json"}
                                   :body            (json/generate-string body)
                                   :as              :json
                                   :throw-exceptions false}))
          ;; Retry once on 5xx — transient OpenAI server errors happen occasionally
          resp       (let [r (do-request)]
                       (if (>= (:status r) 500)
                         (do (log/warn "OpenAI 5xx, retrying once…" {:status (:status r)})
                             (Thread/sleep 1500)
                             (do-request))
                         r))]
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
