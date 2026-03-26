(ns metabase.ai-agent.mcp
  "MCP (Model Context Protocol) server integration for the AI Agent.

  Supports two modes per server:
  - **native**: OpenAI connects directly via `{:type \"mcp\"}` tool.
    Best for public servers (e.g. Atlassian, Stripe).
  - **proxy**: Our backend connects via JSON-RPC, exposes tools as `{:type \"function\"}`.
    Required for private/internal servers (Docker network, localhost).

  Configuration via environment variables:
  - MB_AI_MCP_SERVER_NAMES:  comma-separated, e.g. \"atlassian,stats\"
  - MB_AI_MCP_SERVER_<NAME>_URL: endpoint URL
  - MB_AI_MCP_SERVER_<NAME>_AUTH: \"oauth2\" for OAuth2 servers
  - MB_AI_MCP_SERVER_<NAME>_MODE: \"native\" or \"proxy\" (default: native for oauth2, proxy otherwise)"
  (:require
   [cheshire.core :as json]
   [clj-http.client :as http]
   [clojure.string :as str]
   [metabase.ai-agent.mcp-oauth :as mcp-oauth]
   [metabase.util.log :as log]))

(set! *warn-on-reflection* true)

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Server configuration from env vars
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- env-get [^String k] (System/getenv k))

(defn- parse-server-config
  "Parse MCP server configuration from environment variables.
   Returns a seq of {:name, :url, :auth-type, :mode} maps.
   Mode: :native (OpenAI connects) or :proxy (our client connects)."
  []
  (when-let [names-str (env-get "MB_AI_MCP_SERVER_NAMES")]
    (let [names (map str/trim (str/split names-str #","))]
      (for [n names
            :let [env-prefix (str "MB_AI_MCP_SERVER_" (str/upper-case (str/replace n #"-" "_")))
                  url        (env-get (str env-prefix "_URL"))
                  auth-str   (env-get (str env-prefix "_AUTH"))
                  auth-type  (when (= "oauth2" auth-str) :oauth2)
                  mode-str   (env-get (str env-prefix "_MODE"))
                  mode       (cond
                               (= "native" mode-str) :native
                               (= "proxy" mode-str)  :proxy
                               (= :oauth2 auth-type) :native  ;; default: oauth → native
                               :else                  :proxy)] ;; default: no auth → proxy
            :when (some? url)]
        {:name n :url url :auth-type auth-type :mode mode}))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Native mode — OpenAI connects to MCP servers directly
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- native-tool-definitions
  "Return `{:type \"mcp\"}` tool entries for native-mode servers.
   OpenAI handles transport, tool discovery, and execution.
   OAuth servers without a valid token are EXCLUDED to prevent 401 errors
   that would break the entire OpenAI request."
  [user-id]
  (let [configs (filter #(= :native (:mode %)) (parse-server-config))]
    (when (seq configs)
      (->> configs
           (keep (fn [{:keys [name url auth-type]}]
                   (if (= :oauth2 auth-type)
                     ;; OAuth server — only include if user has a valid token
                     (when-let [token (when user-id
                                        (try (mcp-oauth/get-access-token user-id name)
                                             (catch Exception _ nil)))]
                       (log/info "MCP native:" name "— including with OAuth token")
                       {:type             "mcp"
                        :server_label     name
                        :server_url       url
                        :require_approval "never"
                        :authorization    token})
                     ;; No auth — always include
                     (do (log/info "MCP native:" name "— including (no auth)")
                         {:type             "mcp"
                          :server_label     name
                          :server_url       url
                          :require_approval "never"}))))
           vec))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Proxy mode — our backend connects via Streamable HTTP / SSE
;;; ─────────────────────────────────────────────────────────────────────────────

(defonce ^:private session-headers (atom {}))

(defn- try-parse-json-rpc
  "Try to parse a string as JSON-RPC response."
  [^String s]
  (try
    (let [parsed (json/parse-string s true)]
      (when (or (:result parsed) (:error parsed))
        parsed))
    (catch Exception _ nil)))

(defn- parse-sse-json-rpc
  "Parse an SSE response body to extract the JSON-RPC result."
  [^String sse-body]
  (->> (str/split-lines sse-body)
       (filter #(str/starts-with? % "data:"))
       (map #(str/trim (subs % 5)))
       (filter #(and (seq %) (not= % "[DONE]")))
       (some try-parse-json-rpc)))

(defn- json-rpc-request
  "Send a JSON-RPC 2.0 POST to `endpoint`. Returns the :result or throws.
   Handles both JSON and SSE response formats.
   Tracks Mcp-Session-Id header for Streamable HTTP sessions."
  [endpoint method params]
  (let [body     {:jsonrpc "2.0"
                  :id      (str (java.util.UUID/randomUUID))
                  :method  method
                  :params  (or params {})}
        extra    (get @session-headers endpoint)
        resp     (http/post endpoint
                   {:headers          (merge {"Content-Type" "application/json"
                                              "Accept"       "application/json, text/event-stream"}
                                             extra)
                    :body             (json/generate-string body)
                    :as               :string
                    :throw-exceptions false
                    :socket-timeout   30000
                    :connection-timeout 5000})]
    ;; Store session ID if server returns one
    (when-let [sid (get-in resp [:headers "mcp-session-id"])]
      (swap! session-headers assoc endpoint {"Mcp-Session-Id" sid}))
    (let [status (:status resp)]
      (cond
        (= 200 status)
        (let [content-type (get-in resp [:headers "content-type"] "")
              rpc-resp     (if (str/includes? content-type "text/event-stream")
                             ;; SSE response — parse events to find JSON-RPC result
                             (or (parse-sse-json-rpc (:body resp))
                                 (do (log/warn "MCP proxy: SSE response had no JSON-RPC result for" method)
                                     nil))
                             ;; JSON response — parse directly
                             (json/parse-string (:body resp) true))]
          (when rpc-resp
            (if-let [error (:error rpc-resp)]
              (throw (ex-info (str "MCP JSON-RPC error: " (:message error))
                              {:code (:code error) :data (:data error)}))
              (:result rpc-resp))))

        (= 202 status)
        (do (log/debug "MCP proxy: 202 Accepted for" method)
            nil)

        :else
        (do (log/warn "MCP proxy: HTTP" status "for" method "on" endpoint)
            nil)))))

(defrecord ProxyServer [name url endpoint])

(defonce ^:private proxy-registry (atom {}))

(defn- connect-proxy-server
  "Connect to a proxy-mode MCP server via Streamable HTTP (POST).
   Returns a ProxyServer record."
  [server-name server-url]
  (log/info "MCP proxy: connecting to" server-name "at" server-url)
  ;; For Streamable HTTP, the endpoint IS the URL
  (json-rpc-request server-url "initialize"
                    {:protocolVersion "2024-11-05"
                     :capabilities    {}
                     :clientInfo      {:name "metabase-ai-agent" :version "1.0.0"}})
  (try
    (http/post server-url
      {:headers          {"Content-Type" "application/json"}
       :body             (json/generate-string {:jsonrpc "2.0" :method "notifications/initialized"})
       :throw-exceptions false
       :socket-timeout   5000})
    (catch Exception _ nil))
  (log/info "MCP proxy: initialized" server-name)
  (->ProxyServer server-name server-url server-url))

(defn- ensure-proxy-connected
  "Ensure all proxy-mode servers are connected."
  []
  (doseq [{:keys [name url]} (filter #(= :proxy (:mode %)) (parse-server-config))]
    (when-not (get @proxy-registry name)
      (try
        (swap! proxy-registry assoc name (connect-proxy-server name url))
        (catch Exception e
          (log/error "MCP proxy: failed to connect" name (.getMessage e)))))))

(defn- proxy-list-tools
  "List tools from a proxy server."
  [^ProxyServer server]
  (let [result (json-rpc-request (:endpoint server) "tools/list" {})]
    (log/info "MCP proxy: tools/list raw result for" (:name server) "→"
              (if (nil? result) "nil" (str (count (:tools result)) " tools")))
    (:tools result)))

(defn- proxy-call-tool
  "Call a tool on a proxy server. Returns result string."
  [^ProxyServer server tool-name arguments]
  (let [result (json-rpc-request (:endpoint server) "tools/call"
                                  {:name tool-name :arguments (or arguments {})})]
    (if-let [content (:content result)]
      (->> content
           (filter #(= "text" (:type %)))
           (map :text)
           (str/join "\n"))
      (json/generate-string result))))

(defn- proxy-tool-definitions
  "Return `{:type \"function\"}` tool entries from all proxy servers.
   Each tool name is prefixed: server__tool."
  []
  (ensure-proxy-connected)
  (when (seq @proxy-registry)
    (->> @proxy-registry
         vals
         (mapcat (fn [server]
                   (try
                     (let [tools (proxy-list-tools server)]
                       (log/info "MCP proxy:" (:name server) "→" (count tools) "tools")
                       (map (fn [tool]
                              {:type        "function"
                               :name        (str (:name server) "__" (:name tool))
                               :description (str "[" (:name server) "] "
                                                 (or (:description tool) ""))
                               :parameters  (or (:inputSchema tool)
                                                {:type "object" :properties {} :required []})})
                            tools))
                     (catch Exception e
                       (log/warn "MCP proxy: list-tools failed for" (:name server) (.getMessage e))
                       nil))))
         (remove nil?)
         vec)))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Public API
;;; ─────────────────────────────────────────────────────────────────────────────

(defn mcp-tool-definitions
  "Return all MCP tool definitions (both native and proxy).
   Native servers → {:type \"mcp\"} entries (OpenAI connects directly).
   Proxy servers → {:type \"function\"} entries (our backend connects)."
  ([] (mcp-tool-definitions nil))
  ([user-id]
   (let [native (try (native-tool-definitions user-id) (catch Exception _ nil))
         proxy  (try (proxy-tool-definitions) (catch Exception _ nil))]
     (into (vec (or native [])) (or proxy [])))))

(defn execute-proxy-tool
  "Execute a prefixed proxy MCP tool call (e.g. 'stats__get_experiments').
   Only for proxy-mode servers."
  [prefixed-name arguments]
  (let [[server-name tool-name] (str/split prefixed-name #"__" 2)]
    (if-let [server (get @proxy-registry server-name)]
      (try
        (proxy-call-tool server tool-name arguments)
        (catch Exception e
          (log/warn "MCP proxy: tool call failed" prefixed-name (.getMessage e))
          (str "Error: " (.getMessage e))))
      (str "MCP proxy server not found: " server-name))))

(defn proxy-tool?
  "Returns true if the tool name is a proxy MCP tool (contains __ separator)."
  [^String tool-name]
  (and tool-name (str/includes? tool-name "__")))

(defn server-configs
  "Return parsed server configurations for the UI."
  []
  (or (parse-server-config) []))

(defn oauth-server-names
  "Return a set of server names that require OAuth2."
  []
  (set (map :name (filter #(= :oauth2 (:auth-type %)) (server-configs)))))
