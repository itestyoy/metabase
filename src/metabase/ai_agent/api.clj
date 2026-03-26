(ns metabase.ai-agent.api
  "/api/ai-agent endpoints.

  Provides a thin proxy to the OpenAI Responses API that:
  - Keeps the OpenAI API key server-side (no CSP issues)
  - Executes tool calls under the current user's Metabase session/permissions
  - Uses the Responses API `previous_response_id` for server-managed history"
  (:require
   [cheshire.core :as json]
   [metabase.ai-agent.mcp :as ai.mcp]
   [metabase.ai-agent.mcp-oauth :as ai.mcp-oauth]
   [metabase.ai-agent.openai :as ai.openai]
   [metabase.ai-agent.settings :as ai.settings]
   [metabase.ai-agent.tools :as ai.tools]
   [metabase.api.common :as api]
   [metabase.api.macros :as api.macros]
   [metabase.collections.models.collection :as collection]
   [metabase.server.streaming-response :as streaming-response]
   [metabase.util.log :as log]
   [metabase.util.malli.schema :as ms]
   [toucan2.core :as t2]))

(set! *warn-on-reflection* true)

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Access control
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- current-user-in-ai-group?
  "Returns true if the current user is a superuser OR belongs to a permissions
  group named exactly \"AI\"."
  []
  (or api/*is-superuser?*
      (boolean
       (seq (t2/query {:select [1]
                       :from   [[:permissions_group_membership :pgm]]
                       :join   [[:permissions_group :pg] [:= :pg.id :pgm.group_id]]
                       :where  [:and
                                [:= :pgm.user_id api/*current-user-id*]
                                [:= :pg.name "AI"]]
                       :limit  1})))))

(def ^:private max-tool-iterations 25)
(def ^:private max-validation-retries 5)

(defn- strip-markdown-fences
  "Remove markdown code fences wrapping JSON: ```json ... ``` or ``` ... ```.
   Also strips any leading/trailing whitespace and text outside the JSON object."
  [^String s]
  (let [s (clojure.string/trim s)
        ;; Remove ```json ... ``` or ``` ... ```
        s (if-let [[_ inner] (re-find #"(?s)^```(?:json)?\s*\n?(.*?)\n?\s*```$" s)]
            (clojure.string/trim inner)
            s)
        ;; If there's text before the first { or after the last }, try to extract the JSON object
        first-brace (.indexOf s "{")
        last-brace  (.lastIndexOf s "}")]
    (if (and (>= first-brace 0) (> last-brace first-brace))
      (subs s first-brace (inc last-brace))
      s)))

(defn- extract-error-location
  "Try to extract line/column from a Jackson parse error message and show the surrounding context."
  [^String s ^String parse-error]
  (when-let [[_ line-str col-str] (re-find #"line:\s*(\d+),\s*column:\s*(\d+)" parse-error)]
    (let [line-num (parse-long line-str)
          col-num  (parse-long col-str)
          lines    (clojure.string/split-lines s)
          ;; Show the error line with a pointer
          err-line (when (and line-num (<= line-num (count lines)))
                     (nth lines (dec line-num)))
          pointer  (when (and err-line col-num (> col-num 0))
                     (str (apply str (repeat (min (dec col-num) (count err-line)) " ")) "^"))]
      (when err-line
        (str "\nAt line " line-num ", column " col-num ":\n"
             "  " err-line "\n"
             (when pointer (str "  " pointer "\n")))))))

(defn- diagnose-json-syntax
  "Provide a human-readable diagnosis of common JSON syntax errors.
   Parses the Jackson error message and the raw JSON string to give
   actionable fix instructions to the AI."
  [^String s ^String parse-error]
  (let [pe (clojure.string/lower-case (or parse-error ""))
        ;; ── Parse error pattern matching ──────────────────────────────────
        parse-hints
        (cond-> []
          ;; Expected comma — missing , between array/object elements
          (or (re-find #"expected.*(comma|,)" pe)
              (re-find #"was expecting comma" pe))
          (conj "Missing comma between elements. Add a comma `,` between each value in arrays and between key-value pairs in objects.")

          ;; Expected colon — missing : after object key
          (or (re-find #"expected.*colon" pe)
              (re-find #"was expecting colon" pe))
          (conj "Missing colon after object key. Every key must be followed by `:` then a value, e.g. \"key\": \"value\".")

          ;; Unexpected character / token
          (re-find #"unexpected character|unexpected token|unrecognized token" pe)
          (conj "Unexpected character found. Check for typos, stray characters, or text outside the JSON structure.")

          ;; Unexpected end of input — truncated JSON
          (or (re-find #"unexpected end" pe)
              (re-find #"end.of.input" pe)
              (re-find #"premature end" pe))
          (conj "JSON is truncated — it ends unexpectedly. Make sure all { } and [ ] brackets are properly closed.")

          ;; Unterminated string
          (or (re-find #"unterminated string" pe)
              (re-find #"unexpected end-of-string" pe)
              (re-find #"end of string" pe))
          (conj "Unterminated string — a double quote `\"` is opened but never closed. Check for missing closing `\"` or unescaped quotes inside strings.")

          ;; Unrecognized property / duplicate key
          (re-find #"duplicate" pe)
          (conj "Duplicate key found — each key in a JSON object must be unique.")

          ;; Expected value
          (or (re-find #"expected.*value" pe)
              (re-find #"no value" pe))
          (conj "Expected a value (string, number, boolean, null, array, or object) but found something else.")

          ;; Numeric parsing
          (or (re-find #"not a valid number" pe)
              (re-find #"numeric value" pe)
              (re-find #"leading zero" pe))
          (conj "Invalid number format. JSON numbers must not have leading zeros (except 0.x), use `NaN`, `Infinity`, or hex notation.")

          ;; Expected close bracket/brace
          (or (re-find #"expected.*\]" pe)
              (re-find #"expected close" pe))
          (conj "Missing closing bracket `]` or brace `}`. Check that all opened brackets are properly closed.")

          ;; Expected string for key
          (re-find #"expected.*field name|expected.*string" pe)
          (conj "Expected a double-quoted string for object key. All keys must be in double quotes: \"key\"."))

        ;; ── Static pattern checks on the raw string ──────────────────────
        static-hints
        (cond-> []
          ;; Trailing comma before } or ]
          (re-find #",\s*[}\]]" s)
          (conj "Trailing comma before `}` or `]` — JSON does not allow trailing commas. Remove the last `,` before closing brackets.")

          ;; Single quotes
          (re-find #"(?<![\\])'[^']*'(?=\s*:)" s)
          (conj "Single quotes used for keys/strings — JSON requires double quotes `\"` for all strings and keys.")

          ;; Unescaped newlines in strings
          (re-find #"\"[^\"]*\n[^\"]*\"" s)
          (conj "Literal newline inside a string value — use `\\n` instead of an actual line break inside strings.")

          ;; JS comments
          (re-find #"(?m)^\s*//" s)
          (conj "JavaScript comments `//` found — JSON does not support comments. Remove all comments.")

          (re-find #"/\*" s)
          (conj "Block comments `/* */` found — JSON does not support comments. Remove all comments.")

          ;; Unquoted keys
          (re-find #"(?m)[\{,]\s*[a-zA-Z_]\w*\s*:" s)
          (conj "Unquoted object key — all keys in JSON must be double-quoted, e.g. `\"key\":` not `key:`.")

          ;; undefined / NaN / Infinity
          (re-find #"(?i)\b(undefined|NaN|Infinity)\b" s)
          (conj "`undefined`, `NaN`, or `Infinity` found — these are not valid JSON values. Use `null` for undefined, numbers for others.")

          ;; Escaped single quotes inside strings (valid in JS, invalid in JSON)
          (re-find #"\\'" s)
          (conj "Escaped single quote `\\'` found — this is not valid JSON. Use regular single quote `'` (no escape needed) or double-quote strings properly.")

          ;; Tab characters in strings (should be \t)
          (re-find #"\"[^\"]*\t[^\"]*\"" s)
          (conj "Literal tab character inside a string — use `\\t` instead."))

        all-hints  (into parse-hints static-hints)
        location   (extract-error-location s parse-error)]
    (str "JSON syntax error: " parse-error
         location
         (when (seq all-hints)
           (str "\n\nSpecific issues found:\n"
                (clojure.string/join "\n" (map-indexed (fn [i h] (format "%d. %s" (inc i) h)) all-hints))))
         "\n\nFix: return ONLY a raw JSON object `{\"blocks\": [...], \"suggestions\": [...]}` — "
         "no markdown fences, no text outside JSON, no comments, no trailing commas.")))

(defn- validate-block
  "Validate a single content block. Returns error string or nil."
  [i block]
  (let [valid-types #{"text" "card_link" "card_preview" "dashboard_link"
                       "document_link" "notebook_link" "sql" "table"}
        btype       (:type block)]
    (cond
      (nil? btype)
      (format "Block %d is missing `type` field." i)

      (not (valid-types btype))
      (format "Block %d has unknown type \"%s\". Valid types: %s."
              i btype (clojure.string/join ", " (sort valid-types)))

      ;; ── text ──
      (and (= btype "text") (not (string? (:content block))))
      (format "Block %d (text): `content` must be a string." i)

      (and (= btype "text") (clojure.string/blank? (:content block)))
      (format "Block %d (text): `content` is blank." i)

      ;; ── card_link ──
      (and (= btype "card_link") (not (number? (:card_id block))))
      (format "Block %d (card_link): `card_id` must be a number." i)

      (and (= btype "card_link") (not (string? (:name block))))
      (format "Block %d (card_link): `name` must be a string." i)

      ;; ── card_preview ──
      (and (= btype "card_preview") (not (number? (:card_id block))))
      (format "Block %d (card_preview): `card_id` must be a number." i)

      (and (= btype "card_preview") (not (string? (:name block))))
      (format "Block %d (card_preview): `name` must be a string." i)

      (and (= btype "card_preview") (not (string? (:display block))))
      (format "Block %d (card_preview): `display` must be a string." i)

      ;; ── dashboard_link ──
      (and (= btype "dashboard_link") (not (number? (:dashboard_id block))))
      (format "Block %d (dashboard_link): `dashboard_id` must be a number." i)

      (and (= btype "dashboard_link") (not (string? (:name block))))
      (format "Block %d (dashboard_link): `name` must be a string." i)

      ;; ── notebook_link ──
      (and (= btype "notebook_link") (not (map? (:dataset_query block))))
      (format "Block %d (notebook_link): `dataset_query` must be an object." i)

      (and (= btype "notebook_link") (not (string? (:name block))))
      (format "Block %d (notebook_link): `name` must be a string." i)

      (and (= btype "notebook_link") (not (string? (:display block))))
      (format "Block %d (notebook_link): `display` must be a string." i)

      (and (= btype "notebook_link")
           (map? (:dataset_query block))
           (not (#{"query" "native"} (:type (:dataset_query block)))))
      (format "Block %d (notebook_link): `dataset_query.type` must be \"query\" or \"native\", got \"%s\"."
              i (:type (:dataset_query block)))

      (and (= btype "notebook_link")
           (map? (:dataset_query block))
           (nil? (:database (:dataset_query block))))
      (format "Block %d (notebook_link): `dataset_query.database` is required." i)

      ;; ── document_link ──
      (and (= btype "document_link") (not (number? (:document_id block))))
      (format "Block %d (document_link): `document_id` must be a number." i)

      (and (= btype "document_link") (not (string? (:name block))))
      (format "Block %d (document_link): `name` must be a string." i)

      ;; ── sql ──
      (and (= btype "sql") (not (string? (:content block))))
      (format "Block %d (sql): `content` must be a string." i)

      ;; ── table ──
      (and (= btype "table") (not (sequential? (:columns block))))
      (format "Block %d (table): `columns` must be an array." i)

      (and (= btype "table") (not (sequential? (:rows block))))
      (format "Block %d (table): `rows` must be an array." i)

      (and (= btype "table") (sequential? (:columns block)) (empty? (:columns block)))
      (format "Block %d (table): `columns` array is empty." i))))

(defn- validate-response-json
  "Validate that the AI response content is valid JSON with a `blocks` array.
  Returns a map {:error \"...\" :cleaned \"...\"} if invalid,
  or {:cleaned \"...\"} if valid (cleaned may differ from input if fences were stripped)."
  [content]
  (if (clojure.string/blank? content)
    {:error "Response is empty — expected a JSON object with `blocks` and `suggestions`."}
    (let [cleaned (strip-markdown-fences content)]
      (try
        (let [parsed (json/parse-string cleaned true)]
          (cond
            (not (map? parsed))
            {:error   "Response must be a JSON object with `blocks` and `suggestions` keys, but got a non-object value."
             :cleaned cleaned}

            (not (contains? parsed :blocks))
            {:error   (str "Response JSON is missing the required `blocks` key. Got keys: "
                           (clojure.string/join ", " (map name (keys parsed))))
             :cleaned cleaned}

            (not (sequential? (:blocks parsed)))
            {:error   (str "`blocks` must be an array, but got: " (type (:blocks parsed)))
             :cleaned cleaned}

            (empty? (:blocks parsed))
            {:error   "`blocks` array is empty — you must include at least one content block."
             :cleaned cleaned}

            :else
            (let [block-errors (keep-indexed validate-block (:blocks parsed))]
              (if (seq block-errors)
                {:error   (clojure.string/join "\n" block-errors)
                 :cleaned cleaned}
                ;; All valid
                {:cleaned cleaned}))))
        (catch Exception e
          {:error   (diagnose-json-syntax cleaned (.getMessage e))
           :cleaned cleaned})))))

(def ^:private artifact-tool-names
  "Tool names that create artifacts (questions, dashboards, documents) and accept collection_id.
   When these are called we lazily create the chat sub-collection and inject its ID."
  #{"create_question" "create_dashboard" "create_notebook_question" "create_document"})

(defn- maybe-inject-collection-id
  "If a tool creates an artifact and no explicit collection_id was given,
   lazily ensure the chat sub-collection exists and inject its ID.
   If the AI already specified a collection_id, respect that choice."
  [tool-name arguments ensure-chat-coll!]
  (if (and ensure-chat-coll!
           (artifact-tool-names tool-name)
           (nil? (get arguments "collection_id")))
    (if-let [coll-id (ensure-chat-coll!)]
      (assoc arguments "collection_id" coll-id)
      arguments)
    arguments))

(defn- run-tool-loop
  "Execute the OpenAI → tool-call → tool-result loop until the model
  returns a plain text response (or we hit the iteration limit).

  `emit!` is an optional callback `(fn [event-type data-map])` that streams
  SSE events to the client in real time. When nil, the function behaves
  exactly as before (batch mode).

  Returns:
  ```
  {:response-id  \"resp_...\"
   :content      \"Final assistant text\"
   :tool-calls   [{:name … :args … :result …} …]}
  ```"
  [api-key model initial-opts & {:keys [safe-mode? ensure-chat-coll! emit!] :or {safe-mode? false}}]
  (loop [opts       initial-opts
         iterations 0
         all-calls  []]
    (if (>= iterations max-tool-iterations)
      ;; Graceful fallback: ask AI to summarize what it has so far, WITHOUT tools
      (let [fallback-resp (ai.openai/create-response
                            (assoc opts
                                   :api-key api-key
                                   :model   model
                                   :tools   []
                                   :input   [{:role "user"
                                              :content "You have reached the tool call limit. Summarize your findings and provide the best answer you can based on the data you already collected. Respond in the same language as the user's original question."}]))]
        {:response-id (ai.openai/response-id fallback-resp)
         :content     (ai.openai/extract-text fallback-resp)
         :tool-calls  all-calls})
      (let [response    (ai.openai/create-response (assoc opts
                                                          :api-key api-key
                                                          :model   model
                                                          :tools   (ai.tools/all-tool-definitions safe-mode? api/*current-user-id*)))
            response-id (ai.openai/response-id response)
            _           (when (ai.openai/failed? response)
                          (throw (ex-info (str "OpenAI returned status: " (get response :status))
                                          {:status (get response :status)
                                           :error  (get response :error)})))]
        (if (ai.openai/has-tool-calls? response)
          ;; ── Tool calls: execute each and loop back ─────────────────────────
          (let [tool-calls (ai.openai/extract-tool-calls response)
                _          (log/debug "AI Agent executing tools" {:tools (map :name tool-calls)})
                results    (mapv (fn [{:keys [call-id name arguments]}]
                                   (let [args (maybe-inject-collection-id name arguments ensure-chat-coll!)]
                                     ;; Emit tool_start event
                                     (when emit! (emit! "tool_start" {:name name}))
                                     (let [result (ai.tools/execute-tool name args api/*current-user-id*)]
                                       ;; Emit tool_result event
                                       (when emit! (emit! "tool_result" {:name   name
                                                                         :result result}))
                                       {:name    name
                                        :args    args
                                        :result  result
                                        :call-id call-id})))
                                 tool-calls)
                tool-results (mapv (fn [{:keys [call-id result]}]
                                     {:call-id call-id :output result})
                                   results)]
            (recur {:previous-response-id response-id
                    :tool-results         tool-results}
                   (inc iterations)
                   (into all-calls results)))
          ;; ── Text response: done ────────────────────────────────────────────
          {:response-id response-id
           :content     (ai.openai/extract-text response)
           :tool-calls  all-calls})))))

(defn- validate-and-retry
  "Validate the AI response JSON and retry up to `max-validation-retries` times
  if the response is malformed. On each retry, sends the validation error back
  to the AI as a user message so it can correct itself.

  Also handles auto-cleanup: if the AI wraps JSON in markdown fences or adds
  surrounding text, the cleaned version is used without counting as a retry."
  [api-key model {:keys [response-id content tool-calls] :as result} & {:keys [safe-mode?] :or {safe-mode? false}}]
  (loop [current-content  content
         current-resp-id  response-id
         attempt          0]
    (let [{:keys [error cleaned]} (validate-response-json current-content)]
      (if (nil? error)
        ;; Valid — use cleaned content (stripped fences, extracted JSON)
        (assoc result
               :content     cleaned
               :response-id current-resp-id)
        ;; Invalid — retry if we have attempts left
        (if (>= attempt max-validation-retries)
          (do
            (log/warn "AI Agent response failed JSON validation after" max-validation-retries "retries"
                      {:last-error error})
            (assoc result
                   :content     (str "{\"blocks\":[{\"type\":\"text\",\"content\":\"Sorry, I was unable to format my response correctly after multiple attempts. "
                                     "Validation error: " (clojure.string/replace error "\"" "'") "\"}],"
                                     "\"suggestions\":[\"Try asking again\"]}")
                   :response-id current-resp-id))
          (do
            (log/debug "AI Agent response validation failed, retrying"
                       {:attempt (inc attempt) :error error})
            (let [retry-msg  (str "Your previous response was NOT valid JSON. Error:\n"
                                  error
                                  "\n\nPlease return ONLY a valid JSON object with `blocks` array and `suggestions` array. "
                                  "No markdown code fences, no text outside the JSON. Fix the issue and try again.")
                  retry-resp (ai.openai/create-response
                              {:api-key              api-key
                               :model                model
                               :message              retry-msg
                               :previous-response-id current-resp-id
                               :tools                (ai.tools/all-tool-definitions safe-mode?)})
                  new-id     (ai.openai/response-id retry-resp)
                  new-text   (ai.openai/extract-text retry-resp)]
              (recur new-text
                     new-id
                     (inc attempt)))))))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Structured params → MBQL conversion for notebook_link blocks
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- field-ref [field-id temporal-unit]
  (if temporal-unit
    ["field" field-id {"temporal-unit" temporal-unit}]
    ["field" field-id nil]))

(defn- convert-aggregation [{:strs [type field_id metric_ids scalar]}]
  (let [ops {"divide" "/" "multiply" "*" "subtract" "-" "add" "+"}
        m1  (first metric_ids)
        m2  (second metric_ids)
        agg (case type
              "count"    ["count"]
              "sum"      ["sum" (field-ref field_id nil)]
              "avg"      ["avg" (field-ref field_id nil)]
              "min"      ["min" (field-ref field_id nil)]
              "max"      ["max" (field-ref field_id nil)]
              "distinct" ["distinct" (field-ref field_id nil)]
              "metric"   ["metric" m1]
              (if-let [op (get ops type)]
                [op ["metric" m1] ["metric" m2]]
                ["count"]))]
    (if (and scalar (get ops type))
      ["*" agg scalar]
      agg)))

(defn- convert-filter [{:strs [operator field_id values]}]
  (let [v1 (first values)
        v2 (second values)]
    (case operator
      ("=" "!=" ">" "<" ">=" "<=") [operator (field-ref field_id nil) v1]
      "between"                    ["between" (field-ref field_id nil) v1 v2]
      ("contains" "does-not-contain" "starts-with" "ends-with") [operator (field-ref field_id nil) v1]
      ("is-null" "not-null" "is-empty" "not-empty")             [operator (field-ref field_id nil)]
      "time-interval"              ["time-interval" (field-ref field_id nil) v1 v2]
      ["=" (field-ref field_id nil) v1])))

(defn- structured-dataset-query->mbql
  "Convert structured AI dataset_query params to Metabase MBQL format."
  [{:strs [database_id source_table source_card aggregations breakouts filters order_by limit]
    :as   dq}]
  ;; If already in MBQL format, return as-is
  (if (and (get dq "type") (get dq "query"))
    dq
    (let [query (cond-> {}
                  source_table       (assoc "source-table" source_table)
                  source_card        (assoc "source-card" source_card)
                  (seq aggregations) (assoc "aggregation" (mapv convert-aggregation aggregations))
                  (seq breakouts)    (assoc "breakout" (mapv (fn [{:strs [field_id temporal_unit]}]
                                                               (field-ref field_id temporal_unit))
                                                             breakouts))
                  (seq filters)      (assoc "filter" (if (= 1 (count filters))
                                                       (convert-filter (first filters))
                                                       (into ["and"] (mapv convert-filter filters))))
                  (seq order_by)     (assoc "order-by" (mapv (fn [{:strs [field_id aggregation_index direction]}]
                                                               (let [dir (or direction "asc")]
                                                                 (if aggregation_index
                                                                   [dir ["aggregation" aggregation_index]]
                                                                   [dir (field-ref field_id nil)])))
                                                             order_by))
                  limit              (assoc "limit" limit))]
      {"type" "query" "database" database_id "query" query})))

(defn- unified-block->legacy
  "Convert a unified block {type, content, id, name, display, data, query} to legacy format."
  [{:strs [type content id name display data query]}]
  (case type
    "text"           {"type" "text" "content" (or content "")}
    "sql"            {"type" "sql" "content" (or content "")}
    "card_link"      {"type" "card_link" "card_id" id "name" (or name "")}
    "card_preview"   {"type" "card_preview" "card_id" id "name" (or name "") "display" (or display "table")}
    "dashboard_link" {"type" "dashboard_link" "dashboard_id" id "name" (or name "")}
    "document_link"  {"type" "document_link" "document_id" id "name" (or name "")}
    "notebook_link"  (let [dq (when (map? query)
                                (try (structured-dataset-query->mbql query)
                                     (catch Exception _ nil)))]
                       (cond-> {"type" "notebook_link" "name" (or name "") "display" (or display "table")}
                         dq (assoc "dataset_query" dq)))
    "table"          {"type" "table"
                      "columns" (or (get data "columns") [])
                      "rows"    (or (get data "rows") [])}
    ;; fallback — pass through
    {"type" (or type "text") "content" (or content "")}))

(defn- convert-unified-response
  "Parse AI structured response, convert unified blocks to legacy format for frontend.
   Returns {:content converted-json-string, :title ai-generated-title-or-nil}."
  [content]
  (try
    (let [parsed (json/parse-string content)
          blocks (get parsed "blocks")
          title  (get parsed "title")]
      (if-not (sequential? blocks)
        {:content content :title title}
        {:content (json/generate-string
                    (dissoc (assoc parsed "blocks" (mapv unified-block->legacy blocks))
                            "title"))
         :title   title}))
    (catch Exception _ {:content content :title nil})))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; SSE helpers
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- sse-write!
  "Write a single SSE event to an OutputStream and flush immediately.
  `event` is the event name, `data` is a Clojure map that will be JSON-encoded."
  [^java.io.OutputStream os ^String event data]
  (let [payload (str "event: " event "\n"
                     "data: " (json/generate-string data) "\n\n")
        bytes   (.getBytes payload "UTF-8")]
    (.write os bytes)
    (.flush os)))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Shared chat preparation
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- prepare-chat-params
  "Build all the shared parameters needed by both /chat and /chat-stream."
  [{:keys [message previous-response-id context datasource safe-mode chat-collection-id file]}]
  (let [api-key          (ai.settings/ai-agent-openai-api-key)
        _                (api/check-403 (some? api-key))
        model            (or (ai.settings/ai-agent-openai-model) "gpt-5.4")
        personal-coll-id (try
                           (:id (collection/user->personal-collection api/*current-user-id*))
                           (catch Exception _ nil))
        chat-coll-id-atom (atom chat-collection-id)
        chat-coll-name    (str "AI: "
                               (let [trimmed (clojure.string/trim message)]
                                 (if (> (count trimmed) 60)
                                   (str (subs trimmed 0 57) "...")
                                   trimmed)))
        ensure-chat-coll! (fn []
                            (or @chat-coll-id-atom
                                (when personal-coll-id
                                  (try
                                    (let [coll (t2/insert-returning-instance! :model/Collection
                                                 {:name       chat-coll-name
                                                  :location   (format "/%d/" personal-coll-id)
                                                  :namespace  nil})
                                          cid  (:id coll)]
                                      (reset! chat-coll-id-atom cid)
                                      cid)
                                    (catch Exception e
                                      (log/warn "Failed to create chat collection" (.getMessage e))
                                      nil)))))
        effective-msg  (str (if @chat-coll-id-atom
                              (format "[Chat collection ID: %d — ALWAYS use this as collection_id when creating questions, dashboards, or documents. This keeps all items from this conversation organized together.]\n"
                                      @chat-coll-id-atom)
                              (when personal-coll-id
                                (format "[User's personal collection ID: %d — when creating items, use this as collection_id. A dedicated sub-collection will be auto-created for this chat.]\n"
                                        personal-coll-id)))
                            (when context
                              (str "[Context: "
                                   (name (:model context))
                                   " \""
                                   (:name context)
                                   "\" (id="
                                   (:id context)
                                   (when-let [db-id (:db_id context)]
                                     (str ", db_id=" db-id))
                                   ")]\n"))
                            (when datasource
                              (str "[Datasource: "
                                   (name (:type datasource))
                                   " \""
                                   (:name datasource)
                                   "\" (id="
                                   (:id datasource)
                                   (when-let [db-id (:db_id datasource)]
                                     (str ", db_id=" db-id))
                                   (when (= "database" (name (:type datasource)))
                                     " — use this database_id for all queries, skip list_databases")
                                   (when (= "table" (name (:type datasource)))
                                     " — use this table for queries, call get_table_details to get field IDs")
                                   ")]\n"))
                            message)
        safe-mode?     (boolean safe-mode)
        effective-msg  (if safe-mode?
                         (str "[SAFE MODE: All write/modify tools are disabled. You can only read and analyze data, not create or modify anything. If the user asks to create or modify something, explain that safe mode is on and they need to disable it.]\n"
                              effective-msg)
                         effective-msg)
        opts           (cond-> {:message effective-msg}
                         previous-response-id
                         (assoc :previous-response-id previous-response-id)
                         file
                         (assoc :file (if (:file-data file)
                                        ;; Already processed by multipart handler — pass through as-is
                                        file
                                        ;; JSON path — parse data URL "data:<mime>;base64,<b64>"
                                        (let [raw (:file_data file)
                                              [header b64] (clojure.string/split raw #"," 2)
                                              mime (-> header
                                                       (clojure.string/replace #"^data:" "")
                                                       (clojure.string/replace #";base64$" ""))]
                                          {:filename  (:filename file)
                                           :mime-type mime
                                           :file-data b64}))))]
    {:api-key           api-key
     :model             model
     :opts              opts
     :safe-mode?        safe-mode?
     :ensure-chat-coll! ensure-chat-coll!
     :chat-coll-id-atom chat-coll-id-atom
     :chat-coll-name    chat-coll-name}))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Endpoints
;;; ─────────────────────────────────────────────────────────────────────────────

#_{:clj-kondo/ignore [:metabase/validate-defendpoint-has-response-schema]}
(api.macros/defendpoint :post "/chat"
  "Send a message to the AI Agent.

  Request body:
  - `message`              — user message (required on new/next turn)
  - `previous_response_id` — ID returned from a previous call (optional)

  Response:
  - `response_id`  — pass back on the next turn to continue the conversation
  - `content`      — assistant reply text (may include markdown)
  - `tool_calls`   — list of tool calls the model made, with results"
  [_route-params
   _query-params
   {message              :message
    previous-response-id :previous_response_id
    context              :context
    datasource           :datasource
    safe-mode            :safe_mode
    chat-collection-id   :chat_collection_id
    file                 :file} :- [:map
                                     [:message              ms/NonBlankString]
                                     [:previous_response_id {:optional true} [:maybe :string]]
                                     [:context              {:optional true}
                                      [:maybe [:map
                                               [:id    :int]
                                               [:name  :string]
                                               [:model :string]
                                               [:db_id {:optional true} [:maybe :int]]]]]
                                     [:datasource           {:optional true}
                                      [:maybe [:map
                                               [:type  :string]
                                               [:id    :int]
                                               [:name  :string]
                                               [:db_id {:optional true} [:maybe :int]]]]]
                                     [:safe_mode {:optional true} [:maybe :boolean]]
                                     [:chat_collection_id {:optional true} [:maybe :int]]
                                     [:file {:optional true}
                                      [:maybe [:map
                                               [:filename  :string]
                                               [:file_data :string]]]]]]
  (api/check-403 (ai.settings/ai-agent-enabled))
  (api/check-403 (current-user-in-ai-group?))
  (let [{:keys [api-key model opts safe-mode? ensure-chat-coll!
                chat-coll-id-atom chat-coll-name]}
        (prepare-chat-params {:message              message
                              :previous-response-id previous-response-id
                              :context              context
                              :datasource           datasource
                              :safe-mode            safe-mode
                              :chat-collection-id   chat-collection-id
                              :file                 file})
        result    (run-tool-loop api-key model opts
                                :safe-mode? safe-mode?
                                :ensure-chat-coll! ensure-chat-coll!)
        {:keys [content title]} (convert-unified-response (:content result))
        ;; Rename collection with AI-generated title — always update to latest title
        coll-name (if (and title (not (clojure.string/blank? title)) @chat-coll-id-atom)
                    (let [new-name (str "AI: " title)]
                      (try (t2/update! :model/Collection @chat-coll-id-atom {:name new-name})
                           (catch Exception e (log/warn "Failed to rename chat collection" (.getMessage e))))
                      new-name)
                    chat-coll-name)]
    {:response_id         (:response-id result)
     :content             content
     :chat_collection_id   @chat-coll-id-atom
     :chat_collection_name (when @chat-coll-id-atom coll-name)
     :tool_calls           (mapv (fn [{:keys [name args result]}]
                                   {:name   name
                                    :args   args
                                    :result result})
                                 (:tool-calls result))}))

#_{:clj-kondo/ignore [:metabase/validate-defendpoint-has-response-schema]}
(api.macros/defendpoint :post "/chat-stream"
  "SSE streaming version of /chat. Sends real-time events as tools execute.

  Events:
  - `tool_start`  — `{\"name\": \"tool_name\"}`
  - `tool_result` — `{\"name\": \"tool_name\", \"result\": \"...\"}`
  - `done`        — final response with content, response_id, collection info"
  [_route-params
   _query-params
   {message              :message
    previous-response-id :previous_response_id
    context              :context
    datasource           :datasource
    safe-mode            :safe_mode
    chat-collection-id   :chat_collection_id
    file                 :file} :- [:map
                                     [:message              ms/NonBlankString]
                                     [:previous_response_id {:optional true} [:maybe :string]]
                                     [:context              {:optional true}
                                      [:maybe [:map
                                               [:id    :int]
                                               [:name  :string]
                                               [:model :string]
                                               [:db_id {:optional true} [:maybe :int]]]]]
                                     [:datasource           {:optional true}
                                      [:maybe [:map
                                               [:type  :string]
                                               [:id    :int]
                                               [:name  :string]
                                               [:db_id {:optional true} [:maybe :int]]]]]
                                     [:safe_mode {:optional true} [:maybe :boolean]]
                                     [:chat_collection_id {:optional true} [:maybe :int]]
                                     [:file {:optional true}
                                      [:maybe [:map
                                               [:filename  :string]
                                               [:file_data :string]]]]]]
  (api/check-403 (ai.settings/ai-agent-enabled))
  (api/check-403 (current-user-in-ai-group?))
  (let [params (prepare-chat-params {:message              message
                                     :previous-response-id previous-response-id
                                     :context              context
                                     :datasource           datasource
                                     :safe-mode            safe-mode
                                     :chat-collection-id   chat-collection-id
                                     :file                 file})]
    ;; Use Metabase's streaming-response which writes directly to the Jetty
    ;; servlet OutputStream — bypasses all buffering middleware (gzip, etc.)
    ;; so SSE events are flushed to the client immediately.
    (streaming-response/streaming-response
      {:content-type "text/event-stream; charset=utf-8"
       :headers      {"Cache-Control" "no-cache, no-transform"
                      "Connection"    "keep-alive"
                      "X-Accel-Buffering" "no"}}
      [os _canceled-chan]
      (try
        (let [{:keys [api-key model opts safe-mode? ensure-chat-coll!
                      chat-coll-id-atom chat-coll-name]} params
              emit!      (fn [event data] (sse-write! os event data))
              result (run-tool-loop api-key model opts
                                   :safe-mode? safe-mode?
                                   :ensure-chat-coll! ensure-chat-coll!
                                   :emit! emit!)
              {:keys [content title]} (convert-unified-response (:content result))
              coll-name (if (and title (not (clojure.string/blank? title)) @chat-coll-id-atom)
                          (let [new-name (str "AI: " title)]
                            (try (t2/update! :model/Collection @chat-coll-id-atom {:name new-name})
                                 (catch Exception e (log/warn "Failed to rename chat collection" (.getMessage e))))
                            new-name)
                          chat-coll-name)]
          (sse-write! os "done"
                      {:response_id         (:response-id result)
                       :content             content
                       :chat_collection_id   @chat-coll-id-atom
                       :chat_collection_name (when @chat-coll-id-atom coll-name)
                       :tool_calls           (mapv (fn [{:keys [name args result]}]
                                                     {:name name :args args :result result})
                                                   (:tool-calls result))}))
        (catch Exception e
          (log/error "SSE chat-stream error" (.getMessage e))
          (try (sse-write! os "error" {:message (.getMessage e)}) (catch Exception _)))))))

#_{:clj-kondo/ignore [:metabase/validate-defendpoint-has-response-schema]}
(api.macros/defendpoint :post "/chat-stream-upload"
  "Multipart variant of /chat-stream. Accepts a binary file upload alongside the message.
  The file is read server-side and forwarded to OpenAI as an input_file content block.

  Fields (multipart/form-data):
  - `file`                  — binary file (.md, .txt, .csv, .json, .sql …)
  - `message`               — user message text (may be empty when file is the only content)
  - `previous_response_id`  — optional, for conversation continuity
  - `context`, `datasource`, `safe_mode`, `chat_collection_id` — same as /chat-stream"
  {:multipart true}
  [_route-params
   _query-params
   _body
   {:keys [multipart-params params], :as _request}]
  (api/check-403 (ai.settings/ai-agent-enabled))
  (api/check-403 (current-user-in-ai-group?))
  (let [;; Scalar fields come in as strings from multipart form
        message              (or (get params "message") (get multipart-params "message") " ")
        previous-response-id (or (get params "previous_response_id") (get multipart-params "previous_response_id"))
        context              (when-let [s (or (get params "context") (get multipart-params "context"))]
                               (json/parse-string s keyword))
        datasource           (when-let [s (or (get params "datasource") (get multipart-params "datasource"))]
                               (json/parse-string s keyword))
        safe-mode            (= "true" (or (get params "safe_mode") (get multipart-params "safe_mode")))
        chat-collection-id   (when-let [s (or (get params "chat_collection_id") (get multipart-params "chat_collection_id"))]
                               (parse-long s))
        ;; File from multipart upload — convert to base64 for OpenAI input_file
        file-entry           (get multipart-params "file")
        max-file-bytes       (ai.settings/ai-agent-max-file-bytes)
        file                 (when (and file-entry (:tempfile file-entry))
                               (let [tempfile  ^java.io.File (:tempfile file-entry)
                                     filename  (or (:filename file-entry) "attachment")
                                     mime-type (or (:content-type file-entry) "text/plain")
                                     bytes     (java.nio.file.Files/readAllBytes (.toPath tempfile))]
                                 (when (> (count bytes) max-file-bytes)
                                   (throw (ex-info "File too large" {:status 400 :message (str "File exceeds the 200 KB limit.")})))
                                 (let [b64 (.encodeToString (java.util.Base64/getEncoder) bytes)]
                                   (log/info "File upload:" {:filename filename :mime-type mime-type :bytes (count bytes)})
                                   {:filename  filename
                                    :mime-type mime-type
                                    :file-data b64})))
        params               (prepare-chat-params {:message              message
                                                   :previous-response-id previous-response-id
                                                   :context              context
                                                   :datasource           datasource
                                                   :safe-mode            safe-mode
                                                   :chat-collection-id   chat-collection-id
                                                   :file                 file})]
    (streaming-response/streaming-response
      {:content-type "text/event-stream; charset=utf-8"
       :headers      {"Cache-Control" "no-cache, no-transform"
                      "Connection"    "keep-alive"
                      "X-Accel-Buffering" "no"}}
      [os _canceled-chan]
      (try
        (let [{:keys [api-key model opts safe-mode? ensure-chat-coll!
                      chat-coll-id-atom chat-coll-name]} params
              emit!      (fn [event data] (sse-write! os event data))
              result (run-tool-loop api-key model opts
                                   :safe-mode? safe-mode?
                                   :ensure-chat-coll! ensure-chat-coll!
                                   :emit! emit!)
              {:keys [content title]} (convert-unified-response (:content result))
              coll-name (if (and title (not (clojure.string/blank? title)) @chat-coll-id-atom)
                          (let [new-name (str "AI: " title)]
                            (try (t2/update! :model/Collection @chat-coll-id-atom {:name new-name})
                                 (catch Exception e (log/warn "Failed to rename chat collection" (.getMessage e))))
                            new-name)
                          chat-coll-name)]
          (sse-write! os "done"
                      {:response_id         (:response-id result)
                       :content             content
                       :chat_collection_id   @chat-coll-id-atom
                       :chat_collection_name (when @chat-coll-id-atom coll-name)
                       :tool_calls           (mapv (fn [{:keys [name args result]}]
                                                     {:name name :args args :result result})
                                                   (:tool-calls result))}))
        (catch Exception e
          (log/error "SSE chat-stream-upload error" (.getMessage e))
          (try (sse-write! os "error" {:message (.getMessage e)}) (catch Exception _)))))))

#_{:clj-kondo/ignore [:metabase/validate-defendpoint-has-response-schema]}
(api.macros/defendpoint :get "/settings"
  "Return AI Agent settings visible to authenticated users:
  whether it is configured and which model is active."
  []
  (api/check-403 (ai.settings/ai-agent-enabled))
  (api/check-403 (current-user-in-ai-group?))
  {:configured       (some? (ai.settings/ai-agent-openai-api-key))
   :access           true
   :model            (or (ai.settings/ai-agent-openai-model) "gpt-5.4")
   :enabled          (ai.settings/ai-agent-enabled)
   :max_file_bytes    (ai.settings/ai-agent-max-file-bytes)
   :default_database (when-let [db-id (ai.settings/ai-agent-default-database-id)]
                       (when-let [db (t2/select-one :model/Database :id db-id)]
                         {:id (:id db) :name (:name db)}))
   :available_models [;; ── GPT-5 family (flagship, Mar 2026) ───────────────────────────
                      {:value "gpt-5.4"       :label "GPT-5.4 — flagship, best quality (recommended)" :group "GPT-5"}
                      {:value "gpt-5.4-pro"   :label "GPT-5.4 Pro — max capability, higher cost"      :group "GPT-5"}
                      {:value "gpt-5.3"       :label "GPT-5.3 — conversational, fast"                 :group "GPT-5"}
                      {:value "gpt-5.2"       :label "GPT-5.2 — balanced quality/cost"                :group "GPT-5"}
                      {:value "gpt-5-mini"    :label "GPT-5 Mini — near-frontier, very cheap"         :group "GPT-5"}
                      ;; ── Reasoning / o-series ────────────────────────────────────────
                      {:value "o4-mini"       :label "o4-mini — fast reasoning, coding"               :group "Reasoning"}
                      {:value "o3"            :label "o3 — advanced reasoning"                        :group "Reasoning"}
                      {:value "o3-mini"       :label "o3-mini — reasoning, cost-efficient"            :group "Reasoning"}
                      ;; ── GPT-4.1 family ──────────────────────────────────────────────
                      {:value "gpt-4.1"       :label "GPT-4.1 — 1M context, instruction following"   :group "GPT-4.1"}
                      {:value "gpt-4.1-mini"  :label "GPT-4.1 Mini — faster, lower cost"             :group "GPT-4.1"}
                      {:value "gpt-4.1-nano"  :label "GPT-4.1 Nano — lightest, cheapest"             :group "GPT-4.1"}]})

(defn- load-tips-file []
  (let [path (System/getenv "MB_AI_AGENT_TIPS_FILE")]
    (when (and path (.exists (clojure.java.io/file path)))
      (try (json/parse-string (slurp path) true)
           (catch Exception _ nil)))))

#_{:clj-kondo/ignore [:metabase/validate-defendpoint-has-response-schema]}
(api.macros/defendpoint :get "/tips"
  "Return tips, templates and example prompts for the AI Agent chat UI."
  []
  (or (load-tips-file)
      {:templates [] :examples [] :hint {:en "" :ru ""}}))

#_{:clj-kondo/ignore [:metabase/validate-defendpoint-has-response-schema]}
(api.macros/defendpoint :get "/mcp-servers"
  "Return status of connected MCP servers and their available tools.
   AI-group users see server names and tool lists; superusers also see URLs.
   For OAuth2 servers, includes auth_type and user's authorization status."
  []
  (api/check-403 (ai.settings/ai-agent-enabled))
  (api/check-403 (current-user-in-ai-group?))
  (let [registry    (ai.mcp/ensure-connected)
        su?         api/*is-superuser?*
        user-id     api/*current-user-id*
        oauth-names (ai.mcp-oauth/parse-oauth-servers)
        auth-status (when (seq oauth-names)
                      (try (ai.mcp-oauth/user-auth-status user-id oauth-names)
                           (catch Exception _ {})))]
    {:servers (mapv (fn [[name server]]
                      (let [tools     (try (ai.mcp/list-tools server user-id) (catch Exception _ []))
                            is-oauth? (= :oauth2 (:auth-type server))]
                        (cond-> {:name  name
                                 :tools (mapv (fn [t] {:name (:name t) :description (:description t)})
                                              tools)}
                          su?       (assoc :sse_url          (:sse-url server)
                                           :message_endpoint (:message-endpoint server))
                          is-oauth? (assoc :auth_type  "oauth2"
                                           :authorized (get-in auth-status [name :authorized] false)))))
                    registry)}))

#_{:clj-kondo/ignore [:metabase/validate-defendpoint-has-response-schema]}
(api.macros/defendpoint :post "/mcp-servers/reconnect"
  "Force reconnect all MCP servers. Superuser only."
  []
  (api/check-superuser)
  (let [registry (ai.mcp/reconnect!)]
    {:reconnected (count registry)
     :servers     (keys registry)}))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; MCP OAuth2 endpoints
;;; ─────────────────────────────────────────────────────────────────────────────

#_{:clj-kondo/ignore [:metabase/validate-defendpoint-has-response-schema]}
(api.macros/defendpoint :get "/mcp-oauth/authorize/:server-name"
  "Start the OAuth2 authorization flow for an MCP server.
   Returns a redirect URL that the frontend should open in a popup/new tab."
  [{:keys [server-name]} :- [:map [:server-name ms/NonBlankString]]]
  (api/check-403 (ai.settings/ai-agent-enabled))
  (api/check-403 (current-user-in-ai-group?))
  (let [;; Find the server URL from env
        env-key    (str "MB_AI_MCP_SERVER_"
                        (clojure.string/upper-case (clojure.string/replace server-name #"-" "_"))
                        "_URL")
        server-url (System/getenv env-key)
        _          (when-not server-url
                     (throw (ex-info "MCP server not found" {:server-name server-name})))
        site-url   (or (System/getenv "MB_SITE_URL") "http://localhost:3000")
        callback   (str site-url "/api/ai-agent/mcp-oauth/callback")
        result     (ai.mcp-oauth/build-authorize-url
                     server-name server-url callback api/*current-user-id*)]
    {:authorize_url (:url result)
     :state         (:state result)}))

#_{:clj-kondo/ignore [:metabase/validate-defendpoint-has-response-schema]}
(api.macros/defendpoint :get "/mcp-oauth/callback"
  "OAuth2 callback endpoint. Receives authorization code, exchanges for tokens.
   Renders a minimal HTML page that closes the popup and notifies the opener."
  [_route-params
   {:keys [code state error]} :- [:map
                                   [:code  {:optional true} [:maybe ms/NonBlankString]]
                                   [:state ms/NonBlankString]
                                   [:error {:optional true} [:maybe ms/NonBlankString]]]]
  ;; Note: no auth check here — state param validates the user
  ;; Sanitize values for safe HTML/JS embedding (prevent XSS)
  (letfn [(sanitize [^String s]
            (when s
              (-> s
                  (clojure.string/replace "&" "&amp;")
                  (clojure.string/replace "<" "&lt;")
                  (clojure.string/replace ">" "&gt;")
                  (clojure.string/replace "'" "\\'")
                  (clojure.string/replace "\"" "&quot;"))))]
    (if error
      {:status  200
       :headers {"Content-Type" "text/html"}
       :body    (str "<html><body><script>"
                     "window.opener && window.opener.postMessage({type:'mcp-oauth-error',error:'"
                     (sanitize error) "'},'*'); window.close();"
                     "</script><p>Authorization failed. You can close this window.</p></body></html>")}
      (try
        (let [result (ai.mcp-oauth/handle-callback! code state)]
          ;; Force reconnect the server so it upgrades from placeholder
          (try (ai.mcp/reconnect-server! (:server-name result)) (catch Exception _))
          {:status  200
           :headers {"Content-Type" "text/html"}
           :body    (str "<html><body><script>"
                         "window.opener && window.opener.postMessage({type:'mcp-oauth-success',server:'"
                         (sanitize (:server-name result)) "'},'*'); window.close();"
                         "</script><p>Authorization successful for " (sanitize (:server-name result))
                         ". You can close this window.</p></body></html>")})
        (catch Exception e
          (log/error "MCP OAuth callback error" (.getMessage e))
          {:status  200
           :headers {"Content-Type" "text/html"}
           :body    (str "<html><body><script>"
                         "window.opener && window.opener.postMessage({type:'mcp-oauth-error',error:'token_exchange_failed'},'*'); window.close();"
                         "</script><p>Authorization failed. You can close this window.</p></body></html>")})))))

#_{:clj-kondo/ignore [:metabase/validate-defendpoint-has-response-schema]}
(api.macros/defendpoint :get "/mcp-oauth/status"
  "Return the OAuth authorization status for the current user across all OAuth MCP servers."
  []
  (api/check-403 (ai.settings/ai-agent-enabled))
  (api/check-403 (current-user-in-ai-group?))
  (let [oauth-names (ai.mcp-oauth/parse-oauth-servers)]
    (if (seq oauth-names)
      {:servers (ai.mcp-oauth/user-auth-status api/*current-user-id* oauth-names)}
      {:servers {}})))

#_{:clj-kondo/ignore [:metabase/validate-defendpoint-has-response-schema]}
(api.macros/defendpoint :post "/mcp-oauth/revoke/:server-name"
  "Revoke (delete) stored OAuth tokens for the current user and a specific MCP server."
  [{:keys [server-name]} :- [:map [:server-name ms/NonBlankString]]]
  (api/check-403 (ai.settings/ai-agent-enabled))
  (api/check-403 (current-user-in-ai-group?))
  (ai.mcp-oauth/revoke-token! api/*current-user-id* server-name)
  {:success true :server_name server-name})

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Admin Toolbar — query history
;;; ─────────────────────────────────────────────────────────────────────────────

#_{:clj-kondo/ignore [:metabase/validate-defendpoint-has-response-schema]}
(api.macros/defendpoint :get "/admin/users"
  "List users for the admin toolbar query explorer. Superuser only."
  []
  (api/check-superuser)
  (t2/select [:model/User :id :first_name :last_name :email]
             {:where [:= :is_active true]
              :order-by [[:last_name :asc] [:first_name :asc]]}))

#_{:clj-kondo/ignore [:metabase/validate-defendpoint-has-response-schema
                      :metabase/validate-defendpoint-query-params-use-kebab-case]}
(api.macros/defendpoint :get "/admin/query-history"
  "Fetch recent query executions. Superuser only.
  Params: user_id, date (YYYY-MM-DD), card_id, dashboard_id, limit — all optional."
  [_route-params
   {:keys [user_id date card_id dashboard_id limit before]} :- [:map
                                                         [:user_id      {:optional true} [:maybe ms/PositiveInt]]
                                                         [:date         {:optional true} [:maybe :string]]
                                                         [:card_id      {:optional true} [:maybe ms/PositiveInt]]
                                                         [:dashboard_id {:optional true} [:maybe ms/PositiveInt]]
                                                         [:limit        {:optional true} [:maybe ms/PositiveInt]]
                                                         [:before       {:optional true} [:maybe :string]]]]
  (api/check-superuser)
  (let [limit      (or limit 200)
        ;; When filtering by dashboard, find all card IDs on that dashboard
        dash-cards (when dashboard_id
                     (map :card_id
                          (t2/select [:model/DashboardCard :card_id]
                                     :dashboard_id dashboard_id)))
        wheres     (cond-> [:and [:= 1 1]]
                     user_id      (conj [:= :executor_id user_id])
                     date         (conj [:>= :started_at [:cast (str date " 00:00:00") :timestamp]]
                                        [:<  :started_at [:cast (str date " 23:59:59") :timestamp]])
                     card_id      (conj [:= :qe.card_id card_id])
                     (seq dash-cards) (conj [:in :qe.card_id dash-cards])
                     before       (conj [:< :started_at [:cast before :timestamp]]))]
    (t2/query {:select    [:qe.hash
                           :qe.started_at
                           :qe.running_time
                           :qe.result_rows
                           :qe.executor_id
                           :qe.card_id
                           :qe.dashboard_id
                           :qe.database_id
                           :qe.context
                           :qe.native
                           :qe.error
                           [:q.query :raw_query]
                           [:c.name :card_name]
                           [:d.name :dashboard_name]
                           [:db.name :database_name]
                           [:u.email :user_email]]
               :from      [[:query_execution :qe]]
               :left-join [[:query :q]            [:= :qe.hash :q.query_hash]
                           [:report_card :c]      [:= :qe.card_id :c.id]
                           [:report_dashboard :d] [:= :qe.dashboard_id :d.id]
                           [:metabase_database :db] [:= :qe.database_id :db.id]
                           [:core_user :u]        [:= :qe.executor_id :u.id]]
               :where     wheres
               :order-by  [[:qe.started_at :desc]]
               :limit     limit})))

#_{:clj-kondo/ignore [:metabase/validate-defendpoint-has-response-schema]}
(api.macros/defendpoint :post "/admin/compile-queries"
  "Compile saved questions (by card_id) or ad-hoc queries (by json_query) to SQL.
  Superuser only. Body: {items: [{card_id: N} | {json_query: {...}, label: \"...\"}]}"
  [_route-params
   _query-params
   {items :items} :- [:map [:items [:sequential :map]]]]
  (api/check-superuser)
  (let [compile-fn (requiring-resolve 'metabase.query-processor.compile/compile)]
    (vec
     (for [item items]
       (let [card-id (:card_id item)
             label   (:label item)]
         (cond
           ;; Saved question — fetch dataset_query from card and compile
           card-id
           (let [card (t2/select-one :model/Card :id card-id)]
             {:card_id   card-id
              :card_name (or (:name card) (str "Card " card-id))
              :query     (if card
                           (try
                             (let [compiled (compile-fn (:dataset_query card))]
                               (if (map? compiled) (:query compiled) (str compiled)))
                             (catch Exception e (str "Error: " (.getMessage e))))
                           "Error: card not found")})

           ;; Ad-hoc — raw SQL already available from the query table
           (:raw_query item)
           {:card_id   nil
            :card_name (or label "Ad-hoc query")
            :query     (:raw_query item)}

           :else
           {:card_id nil :card_name "Unknown" :query "Error: no card_id or raw_query provided"}))))))

(def routes (api.macros/ns-handler))
