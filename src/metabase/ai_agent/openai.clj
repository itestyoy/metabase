(ns metabase.ai-agent.openai
  "Client for the OpenAI Responses API.

  Uses the Responses API (POST /v1/responses) instead of Chat Completions so that
  conversation history is managed server-side via `previous_response_id` — no need
  to re-send the full message history on every turn."
  (:require
   [cheshire.core :as json]
   [clj-http.client :as http]
   [metabase.util.log :as log]))

(set! *warn-on-reflection* true)

(def ^:private openai-responses-url "https://api.openai.com/v1/responses")

(def ^:private system-prompt
  "You are a helpful Metabase analyst assistant.
You help users explore data, create saved questions, and find existing reports.

When a user asks you to do something (e.g. \"create a question showing monthly revenue\"):
1. Discover available databases if you don't know them yet.
2. Explore the relevant database schema to understand tables/columns.
3. Write a SQL query and optionally validate it with run_query.
4. Create and save the question with create_question.
5. Always share the URL (/question/<id>) so the user can open it.

Be proactive: if the user doesn't specify a database, list them first and pick the most likely one.
Keep SQL readable with clear aliases.
After completing an action, summarise what was done in plain language.")

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Request helpers
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- auth-headers [api-key]
  {"Authorization" (str "Bearer " api-key)
   "Content-Type"  "application/json"})

(defn- make-request-body
  "Build the request body for the Responses API.

  On the first turn `previous-response-id` is nil and we include the system
  prompt + user message in `input`.  On subsequent turns we pass
  `previous_response_id` and only include the new user input."
  [{:keys [model message previous-response-id tool-results tools]}]
  (let [input (cond
                ;; Submitting tool outputs back to the model
                (seq tool-results)
                (mapv (fn [{:keys [call-id output]}]
                        {:type   "function_call_output"
                         :call_id call-id
                         :output  output})
                      tool-results)

                ;; First turn — include system instructions
                (nil? previous-response-id)
                [{:role    "system"
                  :content system-prompt}
                 {:role    "user"
                  :content message}]

                ;; Subsequent turns — just the new user message
                :else
                [{:role    "user"
                  :content message}])]
    (cond-> {:model input
             :input input}
      previous-response-id (assoc :previous_response_id previous-response-id)
      (seq tools)          (assoc :tools tools)
      ;; Always be explicit about tool choice
      (seq tools)          (assoc :tool_choice "auto"))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Public API
;;; ─────────────────────────────────────────────────────────────────────────────

(defn create-response
  "Call the OpenAI Responses API and return the parsed response map.

  Options:
  - `:api-key`             — OpenAI API key (required)
  - `:model`               — model string, e.g. \"gpt-4o\" (required)
  - `:message`             — user message string (required on first/next user turn)
  - `:previous-response-id`— ID from the previous response (optional)
  - `:tool-results`        — seq of {:call-id … :output …} for tool submissions
  - `:tools`               — vector of tool definition maps"
  [{:keys [api-key model] :as opts}]
  {:pre [(string? api-key) (seq api-key)
         (string? model)   (seq model)]}
  (let [body (-> (make-request-body opts)
                 (assoc :model model)
                 (dissoc :model)) ; make-request-body put model as a dummy key; fix below
        ;; rebuild correctly
        body (cond-> {:model model
                      :input (:input (make-request-body opts))}
               (:previous-response-id opts)
               (assoc :previous_response_id (:previous-response-id opts))

               (seq (:tools opts))
               (assoc :tools (:tools opts)
                      :tool_choice "auto"))]
    (log/debug "OpenAI Responses API request" {:model model :input (count (:input body)) :prev (:previous_response_id body)})
    (let [resp (http/post openai-responses-url
                          {:headers      (auth-headers api-key)
                           :body         (json/generate-string body)
                           :as           :json
                           :content-type :json
                           :throw-exceptions false})]
      (if (= 200 (:status resp))
        (:body resp)
        (throw (ex-info "OpenAI API error"
                        {:status (:status resp)
                         :body   (:body resp)}))))))

(defn response-id [response]
  (get response :id))

(defn extract-text
  "Extract the plain text content from a Responses API response."
  [response]
  (->> (get response :output [])
       (filter #(= "message" (get % :type)))
       (mapcat #(get % :content []))
       (filter #(= "output_text" (get % :type)))
       (map #(get % :text ""))
       (clojure.string/join "")))

(defn extract-tool-calls
  "Return a seq of tool call maps from a Responses API response.
  Each map has :call-id, :name, :arguments (parsed map)."
  [response]
  (->> (get response :output [])
       (filter #(= "function_call" (get % :type)))
       (map (fn [item]
              {:call-id   (get item :call_id)
               :name      (get item :name)
               :arguments (try
                            (json/parse-string (get item :arguments "{}"))
                            (catch Exception _
                              {}))}))))

(defn has-tool-calls?
  "Returns true if the response contains tool calls that need to be executed."
  [response]
  (seq (extract-tool-calls response)))
