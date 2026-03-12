(ns metabase.ai-agent.api
  "/api/ai-agent endpoints.

  Provides a thin proxy to the OpenAI Responses API that:
  - Keeps the OpenAI API key server-side (no CSP issues)
  - Executes tool calls under the current user's Metabase session/permissions
  - Uses the Responses API `previous_response_id` for server-managed history"
  (:require
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
                                                 [:model :string]]]]]]
  (api/check-403 (ai.settings/ai-agent-enabled))
  (api/check-403 (current-user-in-ai-group?))
  (let [api-key (ai.settings/ai-agent-openai-api-key)]
    (api/check-403 (some? api-key))
    (let [model          (or (ai.settings/ai-agent-openai-model) "gpt-5.4")
          personal-coll-id (try
                             (collection/user->personal-collection-id api/*current-user-id*)
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
                                     ")]\n"))
                              message)
          opts           (cond-> {:message effective-msg}
                           previous-response-id
                           (assoc :previous-response-id previous-response-id))
          result (run-tool-loop api-key model opts)]
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
