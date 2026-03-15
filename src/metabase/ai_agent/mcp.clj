(ns metabase.ai-agent.mcp
  "MCP (Model Context Protocol) client for connecting to external tool servers.

  Supports two transport modes:
  - **SSE transport**: GET <url> → SSE stream with 'endpoint' event, then POST JSON-RPC
  - **Streamable HTTP transport**: POST JSON-RPC directly to <url>

  Auto-detects the transport by probing the URL: if GET returns 200 with SSE stream,
  uses SSE; if GET returns 405, uses Streamable HTTP (direct POST).

  Configuration via environment variables:
  - MB_AI_MCP_SERVER_NAMES:  comma-separated list of server names, e.g. \"slack,github\"
  - MB_AI_MCP_SERVER_<NAME>_URL: endpoint URL for each server, e.g.
    MB_AI_MCP_SERVER_SLACK_URL=http://localhost:8080/sse"
  (:require
   [cheshire.core :as json]
   [clj-http.client :as http]
   [clojure.string :as str]
   [metabase.util.log :as log])
  (:import
   [java.io BufferedReader InputStreamReader]
   [java.net URI URL HttpURLConnection]
   [java.util.concurrent CountDownLatch TimeUnit]))

(set! *warn-on-reflection* true)

;;; ─────────────────────────────────────────────────────────────────────────────
;;; SSE helpers
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- parse-sse-line
  "Parse a single SSE line into [field value] or nil."
  [^String line]
  (when (and line (not (str/blank? line)))
    (let [colon-idx (.indexOf line ":")]
      (if (> colon-idx 0)
        [(subs line 0 colon-idx)
         (str/trim (subs line (inc colon-idx)))]
        nil))))

(defn- read-sse-endpoint
  "Open an SSE connection to `url` and block until we receive the 'endpoint' event.
   Returns the absolute message endpoint URL.
   Throws if no endpoint is received within timeout-ms (default 10s)."
  [^String sse-url & {:keys [timeout-ms] :or {timeout-ms 10000}}]
  (let [url-obj    (URL. sse-url)
        ^HttpURLConnection conn (.openConnection url-obj)
        _          (doto conn
                     (.setRequestMethod "GET")
                     (.setRequestProperty "Accept" "text/event-stream")
                     (.setRequestProperty "Cache-Control" "no-cache")
                     (.setConnectTimeout 5000)
                     (.setReadTimeout (int timeout-ms)))
        error      (atom nil)
        result     (atom nil)
        latch      (CountDownLatch. 1)
        reader-fn  (fn []
                     (try
                       ;; Check HTTP status before reading body
                       (let [status (.getResponseCode conn)]
                         (when (not= 200 status)
                           (reset! error (ex-info (str "MCP SSE: server returned HTTP " status)
                                                  {:url sse-url :status status}))
                           (.countDown latch)
                           (throw (ex-info "bad status" {}))))
                       (with-open [is  (.getInputStream conn)
                                   isr (InputStreamReader. is "UTF-8")
                                   br  (BufferedReader. isr)]
                         (let [current-event (atom nil)]
                           (loop []
                             (when-let [line (.readLine br)]
                               (let [parsed (parse-sse-line line)]
                                 (cond
                                   ;; event: field sets the event type
                                   (and parsed (= "event" (first parsed)))
                                   (reset! current-event (second parsed))

                                   ;; data: field with endpoint event type
                                   (and parsed (= "data" (first parsed))
                                        (= "endpoint" @current-event))
                                   (do
                                     (reset! result (second parsed))
                                     (.countDown latch))

                                   :else nil))
                               (when (nil? @result)
                                 (recur))))))
                       (catch Exception e
                         (when (and (nil? @result) (nil? @error))
                           (log/warn "SSE reader error for" sse-url (.getMessage e))
                           (reset! error e)
                           (.countDown latch)))))]
    ;; Read in background thread
    (let [thread (Thread. ^Runnable reader-fn "mcp-sse-init")]
      (.setDaemon thread true)
      (.start thread))
    ;; Wait for endpoint or error
    (if (.await latch timeout-ms TimeUnit/MILLISECONDS)
      (if-let [err @error]
        (do (.disconnect conn)
            (throw err))
        ;; Resolve relative URL against SSE base URL
        (let [endpoint-path @result]
          (.disconnect conn)
          (if (str/starts-with? endpoint-path "http")
            endpoint-path
            ;; Relative path — resolve against base URL
            (let [^URI base-uri (URI. sse-url)]
              (str (.resolve base-uri ^String endpoint-path))))))
      (do
        (.disconnect conn)
        (throw (ex-info "MCP SSE: timed out waiting for endpoint event"
                        {:url sse-url :timeout-ms timeout-ms}))))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Transport detection
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- detect-transport
  "Probe the MCP server URL to detect which transport it supports.
   Returns :sse or :streamable-http.
   - If GET returns 200 with text/event-stream → :sse
   - If GET returns 405 (Method Not Allowed) → :streamable-http
   - Other errors → throws"
  [^String url]
  (let [url-obj (URL. url)
        ^HttpURLConnection conn (.openConnection url-obj)]
    (try
      (doto conn
        (.setRequestMethod "GET")
        (.setRequestProperty "Accept" "text/event-stream")
        (.setConnectTimeout 5000)
        (.setReadTimeout 5000)
        (.setInstanceFollowRedirects false))
      (let [status (.getResponseCode conn)]
        (cond
          (= 200 status) :sse
          (= 405 status) :streamable-http
          :else (throw (ex-info (str "MCP: unexpected HTTP " status " from " url)
                                {:status status :url url}))))
      (finally
        (.disconnect conn)))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; JSON-RPC helpers
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- try-parse-json-rpc
  "Try to parse a string as JSON-RPC response. Returns the parsed map if it
   contains :result or :error, otherwise nil."
  [^String s]
  (try
    (let [parsed (json/parse-string s true)]
      (when (or (:result parsed) (:error parsed))
        parsed))
    (catch Exception _ nil)))

(defn- parse-sse-json-rpc
  "Parse an SSE response body to extract the JSON-RPC result.
   Looks for 'data:' lines containing JSON with a 'result' or 'error' field."
  [^String sse-body]
  (->> (str/split-lines sse-body)
       (filter #(str/starts-with? % "data:"))
       (map #(str/trim (subs % 5)))
       (filter #(and (seq %) (not= % "[DONE]")))
       (some try-parse-json-rpc)))

(defn- json-rpc-request
  "Send a JSON-RPC 2.0 request to `endpoint` and return the result.
   Handles both JSON and SSE response formats (Streamable HTTP transport)."
  [endpoint method params]
  (let [request-id (str (java.util.UUID/randomUUID))
        body       {:jsonrpc "2.0"
                    :id      request-id
                    :method  method
                    :params  (or params {})}
        resp       (http/post endpoint
                     {:headers          {"Content-Type" "application/json"
                                         "Accept"       "application/json, text/event-stream"}
                      :body             (json/generate-string body)
                      :as               :string
                      :throw-exceptions false
                      :socket-timeout   30000
                      :connection-timeout 5000})]
    (if (= 200 (:status resp))
      (let [content-type (get-in resp [:headers "content-type"] "")
            rpc-resp     (if (str/includes? content-type "text/event-stream")
                           ;; SSE response — parse events to find JSON-RPC result
                           (or (parse-sse-json-rpc (:body resp))
                               (throw (ex-info "MCP SSE response contained no JSON-RPC result"
                                               {:body (subs (:body resp) 0
                                                            (min 500 (count (:body resp))))})))
                           ;; JSON response — parse directly
                           (json/parse-string (:body resp) true))]
        (if-let [error (:error rpc-resp)]
          (throw (ex-info (str "MCP JSON-RPC error: " (:message error))
                          {:code (:code error) :data (:data error)}))
          (:result rpc-resp)))
      (throw (ex-info (str "MCP HTTP error " (:status resp))
                      {:status (:status resp) :body (:body resp)})))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; MCP server connection
;;; ─────────────────────────────────────────────────────────────────────────────

(defrecord McpServer [name sse-url message-endpoint transport])

(defn connect-server
  "Connect to an MCP server. Auto-detects transport:
   - SSE: GET /sse → endpoint event → POST JSON-RPC to endpoint
   - Streamable HTTP: POST JSON-RPC directly to the URL
   Returns an McpServer record."
  [server-name server-url]
  (log/info "MCP: connecting to server" server-name "at" server-url)
  (let [transport (detect-transport server-url)
        _         (log/info "MCP: detected transport for" server-name "→" (name transport))
        message-endpoint (case transport
                           :sse             (read-sse-endpoint server-url)
                           :streamable-http server-url)]
    (log/info "MCP: message endpoint for" server-name "→" message-endpoint)
    ;; Initialize the MCP session
    (json-rpc-request message-endpoint "initialize"
                      {:protocolVersion "2024-11-05"
                       :capabilities    {}
                       :clientInfo      {:name    "metabase-ai-agent"
                                         :version "1.0.0"}})
    ;; Send initialized notification (no response expected, but we send via POST)
    (try
      (http/post message-endpoint
        {:headers          {"Content-Type" "application/json"
                            "Accept"       "application/json, text/event-stream"}
         :body             (json/generate-string {:jsonrpc "2.0"
                                                  :method  "notifications/initialized"})
         :throw-exceptions false
         :socket-timeout   5000})
      (catch Exception _ nil))
    (log/info "MCP: initialized session with" server-name)
    (->McpServer server-name server-url message-endpoint transport)))

(defn list-tools
  "List available tools from a connected MCP server.
   Returns a seq of tool maps with :name, :description, :inputSchema."
  [^McpServer server]
  (let [result (json-rpc-request (:message-endpoint server) "tools/list" {})]
    (:tools result)))

(defn call-tool
  "Call a tool on a connected MCP server.
   Returns the tool result as a string."
  [^McpServer server tool-name arguments]
  (let [result (json-rpc-request (:message-endpoint server) "tools/call"
                                  {:name      tool-name
                                   :arguments (or arguments {})})]
    ;; MCP tool results have a `content` array of {type, text} blocks
    (if-let [content (:content result)]
      (->> content
           (filter #(= "text" (:type %)))
           (map :text)
           (str/join "\n"))
      (json/generate-string result))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Server registry (cached connections)
;;; ─────────────────────────────────────────────────────────────────────────────

(defonce server-registry (atom {}))

(defn- env-get
  "Read an environment variable."
  [^String k]
  (System/getenv k))

(defn- parse-server-config
  "Parse MCP server configuration from environment variables.
   Returns a seq of {:name, :url} maps."
  []
  (when-let [names-str (env-get "MB_AI_MCP_SERVER_NAMES")]
    (let [names (map str/trim (str/split names-str #","))]
      (for [n names
            :let [env-key (str "MB_AI_MCP_SERVER_" (str/upper-case (str/replace n #"-" "_")) "_URL")
                  url     (env-get env-key)]
            :when (some? url)]
        {:name n :url url}))))

(defn ensure-connected
  "Ensure all configured MCP servers are connected. Returns the current registry map."
  []
  (let [configs (parse-server-config)]
    (when (seq configs)
      (doseq [{:keys [name url]} configs]
        (when-not (get @server-registry name)
          (try
            (let [server (connect-server name url)]
              (swap! server-registry assoc name server))
            (catch Exception e
              (log/error "MCP: failed to connect to server" name "at" url (.getMessage e)))))))
    @server-registry))

(defn reconnect!
  "Force reconnect all MCP servers (e.g. after config change)."
  []
  (reset! server-registry {})
  (ensure-connected))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Public API for integration with AI agent
;;; ─────────────────────────────────────────────────────────────────────────────

(defn mcp-tool-definitions
  "Return OpenAI-format tool definitions from all connected MCP servers.
   Each tool name is prefixed with the server name to avoid collisions:
   e.g. 'slack__send_message'.

   Caches connections — first call may be slow as it connects to servers."
  []
  (let [registry (ensure-connected)]
    (when (seq registry)
      (->> registry
           vals
           (mapcat (fn [^McpServer server]
                     (try
                       (let [tools (list-tools server)]
                         (map (fn [tool]
                                (let [prefixed-name (str (:name server) "__" (:name tool))]
                                  {:type        "function"
                                   :name        prefixed-name
                                   :description (str "[" (:name server) "] "
                                                     (or (:description tool) ""))
                                   :parameters  (or (:inputSchema tool)
                                                    {:type       "object"
                                                     :properties {}
                                                     :required   []})}))
                              tools))
                       (catch Exception e
                         (log/warn "MCP: failed to list tools from" (:name server) (.getMessage e))
                         nil))))
           (remove nil?)
           vec))))

(defn execute-mcp-tool
  "Execute a prefixed MCP tool call (e.g. 'slack__send_message').
   Splits the prefix to find the right server and calls the tool.
   Returns the result string."
  [prefixed-name arguments]
  (let [parts       (str/split prefixed-name #"__" 2)
        server-name (first parts)
        tool-name   (second parts)]
    (if-let [server (get @server-registry server-name)]
      (try
        (call-tool server tool-name arguments)
        (catch Exception e
          (log/warn "MCP: tool call failed" prefixed-name (.getMessage e))
          (str "Error calling MCP tool " prefixed-name ": " (.getMessage e))))
      (str "MCP server not found: " server-name ". Available: "
           (str/join ", " (keys @server-registry))))))

(defn mcp-tool?
  "Returns true if the tool name is an MCP tool (contains __ prefix separator)."
  [^String tool-name]
  (and tool-name (str/includes? tool-name "__")))
