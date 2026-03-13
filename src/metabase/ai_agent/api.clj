(ns metabase.ai-agent.api
  "/api/ai-agent endpoints.

  Provides a thin proxy to the OpenAI Responses API that:
  - Keeps the OpenAI API key server-side (no CSP issues)
  - Executes tool calls under the current user's Metabase session/permissions
  - Uses the Responses API `previous_response_id` for server-managed history"
  (:require
   [cheshire.core :as json]
   [metabase.ai-agent.openai :as ai.openai]
   [metabase.ai-agent.settings :as ai.settings]
   [metabase.ai-agent.tools :as ai.tools]
   [metabase.api.common :as api]
   [metabase.api.macros :as api.macros]
   [metabase.collections.models.collection :as collection]
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

(def ^:private max-tool-iterations 10)
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
                       "notebook_link" "sql" "table"}
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

(defn- run-tool-loop
  "Execute the OpenAI → tool-call → tool-result loop until the model
  returns a plain text response (or we hit the iteration limit).

  Returns:
  ```
  {:response-id  \"resp_...\"
   :content      \"Final assistant text\"
   :tool-calls   [{:name … :args … :result …} …]}
  ```"
  [api-key model initial-opts]
  (loop [opts       initial-opts
         iterations 0
         all-calls  []]
    (if (>= iterations max-tool-iterations)
      {:response-id  nil
       :content      "Reached maximum tool iteration limit. Please try a more specific request."
       :tool-calls   all-calls}
      (let [response    (ai.openai/create-response (assoc opts
                                                          :api-key api-key
                                                          :model   model
                                                          :tools   ai.tools/tool-definitions))
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
                                   (let [result (ai.tools/execute-tool name arguments)]
                                     {:name    name
                                      :args    arguments
                                      :result  result
                                      :call-id call-id}))
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
  [api-key model {:keys [response-id content tool-calls] :as result}]
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
                               :tools                ai.tools/tool-definitions})
                  new-id     (ai.openai/response-id retry-resp)
                  new-text   (ai.openai/extract-text retry-resp)]
              (recur new-text
                     new-id
                     (inc attempt)))))))))

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
    context              :context} :- [:map
                                       [:message              ms/NonBlankString]
                                       [:previous_response_id {:optional true} [:maybe :string]]
                                       [:context              {:optional true}
                                        [:maybe [:map
                                                 [:id    :int]
                                                 [:name  :string]
                                                 [:model :string]
                                                 [:db_id {:optional true} [:maybe :int]]]]]]]
  (api/check-403 (ai.settings/ai-agent-enabled))
  (api/check-403 (current-user-in-ai-group?))
  (let [api-key (ai.settings/ai-agent-openai-api-key)]
    (api/check-403 (some? api-key))
    (let [model          (or (ai.settings/ai-agent-openai-model) "gpt-5.4")
          personal-coll-id (try
                             (:id (collection/user->personal-collection api/*current-user-id*))
                             (catch Exception _ nil))
          ;; Prepend context hints: personal collection + optional entity context
          effective-msg  (str (when personal-coll-id
                                (format "[User's personal collection ID: %d — ALWAYS use this as collection_id when creating questions or dashboards]\n"
                                        personal-coll-id))
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
                              message)
          opts           (cond-> {:message effective-msg}
                           previous-response-id
                           (assoc :previous-response-id previous-response-id))
          raw-result (run-tool-loop api-key model opts)
          result     (validate-and-retry api-key model raw-result)]
      {:response_id (:response-id result)
       :content     (:content result)
       :tool_calls  (mapv (fn [{:keys [name args result]}]
                            {:name   name
                             :args   args
                             :result result})
                          (:tool-calls result))})))

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

(def routes (api.macros/ns-handler))
