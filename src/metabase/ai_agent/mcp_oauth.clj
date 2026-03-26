(ns metabase.ai-agent.mcp-oauth
  "OAuth2 with Dynamic Client Registration (RFC 7591) for MCP servers.

  Stores per-user OAuth2 tokens in a separate SQLite database.
  The DB path is configured via MB_AI_AGENT_MCP_OAUTH_DB_PATH env var.

  Flow:
  1. Discover OAuth metadata from the MCP server (/.well-known/oauth-authorization-server)
  2. Dynamically register a client (RFC 7591) — cached per server
  3. Redirect user to authorize → callback receives auth code
  4. Exchange code for tokens, store in SQLite per (user-id, server-name)
  5. Inject Bearer token into MCP JSON-RPC requests"
  (:require
   [cheshire.core :as json]
   [clj-http.client :as http]
   [clojure.string :as str]
   [metabase.ai-agent.settings :as ai.settings]
   [metabase.util.log :as log]
   [next.jdbc :as jdbc]
   [next.jdbc.result-set :as rs])
  (:import
   [java.io File]
   [java.nio.charset StandardCharsets]
   [java.security MessageDigest SecureRandom]
   [java.time Instant]
   [java.util Base64]))

(set! *warn-on-reflection* true)

;;; ─────────────────────────────────────────────────────────────────────────────
;;; SQLite connection & schema
;;; ─────────────────────────────────────────────────────────────────────────────

(defonce ^:private ds-atom (atom nil))
(defonce ^:private initialized? (atom false))

(defn- get-datasource []
  (or @ds-atom
      (locking ds-atom
        (or @ds-atom
            (let [db-path (ai.settings/ai-agent-mcp-oauth-db-path)
                  parent  (.getParentFile (File. ^String db-path))]
              ;; Ensure parent directories exist
              (when (and parent (not (.exists parent)))
                (.mkdirs parent)
                (log/info "MCP OAuth: created directory" (.getAbsolutePath parent)))
              (let [ds (jdbc/get-datasource (str "jdbc:sqlite:" db-path))]
                (reset! ds-atom ds)
                ds))))))

(defn init-db!
  "Create tables if they don't exist. Idempotent — skips if already initialized."
  []
  (when-not @initialized?
   (let [ds (get-datasource)]
    ;; Per-server dynamic client registrations (shared across users)
    (jdbc/execute! ds
      ["CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
          server_name    TEXT PRIMARY KEY,
          client_id      TEXT NOT NULL,
          client_secret  TEXT,
          registered_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )"])
    ;; Per-user tokens
    (jdbc/execute! ds
      ["CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
          user_id        INTEGER NOT NULL,
          server_name    TEXT    NOT NULL,
          access_token   TEXT    NOT NULL,
          refresh_token  TEXT,
          token_type     TEXT    NOT NULL DEFAULT 'Bearer',
          expires_at     TEXT,
          scope          TEXT,
          updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, server_name)
        )"])
    ;; PKCE state tracking (short-lived)
    (jdbc/execute! ds
      ["CREATE TABLE IF NOT EXISTS mcp_oauth_state (
          state          TEXT PRIMARY KEY,
          user_id        INTEGER NOT NULL,
          server_name    TEXT    NOT NULL,
          code_verifier  TEXT    NOT NULL,
          created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
        )"])
    (reset! initialized? true)
    (log/info "MCP OAuth: SQLite DB initialized at" (ai.settings/ai-agent-mcp-oauth-db-path)))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; OAuth metadata discovery
;;; ─────────────────────────────────────────────────────────────────────────────

(defonce ^:private metadata-cache (atom {}))

(defn- discover-oauth-metadata
  "Fetch OAuth2 authorization server metadata from the MCP server.
   Tries /.well-known/oauth-authorization-server first, falls back to manual config."
  [server-url]
  (if-let [cached (get @metadata-cache server-url)]
    cached
    (let [;; Extract base URL (strip path like /sse, /mcp, etc.)
          base-url  (let [u (java.net.URI. server-url)]
                      (str (.getScheme u) "://" (.getAuthority u)))
          well-known (str base-url "/.well-known/oauth-authorization-server")
          resp       (try
                       (http/get well-known
                         {:as               :json
                          :throw-exceptions false
                          :socket-timeout   5000
                          :connection-timeout 5000})
                       (catch Exception e
                         (log/warn "MCP OAuth: failed to fetch metadata from" well-known (.getMessage e))
                         nil))]
      (if (and resp (= 200 (:status resp)))
        (let [meta (:body resp)]
          (swap! metadata-cache assoc server-url meta)
          (log/info "MCP OAuth: discovered metadata for" server-url
                    "authorization_endpoint:" (:authorization_endpoint meta))
          meta)
        ;; Fallback: try env vars for manual OAuth config
        (let [name-upper (-> server-url
                             (java.net.URI.)
                             (.getAuthority)
                             (str/replace #"[.:-]" "_")
                             str/upper-case)
              auth-ep  (System/getenv (str "MB_AI_MCP_OAUTH_" name-upper "_AUTHORIZATION_ENDPOINT"))
              token-ep (System/getenv (str "MB_AI_MCP_OAUTH_" name-upper "_TOKEN_ENDPOINT"))
              reg-ep   (System/getenv (str "MB_AI_MCP_OAUTH_" name-upper "_REGISTRATION_ENDPOINT"))]
          (when (and auth-ep token-ep)
            (let [meta {:authorization_endpoint auth-ep
                        :token_endpoint         token-ep
                        :registration_endpoint  reg-ep}]
              (swap! metadata-cache assoc server-url meta)
              meta)))))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Dynamic Client Registration (RFC 7591)
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- get-registered-client
  "Get cached dynamic client registration for a server from SQLite."
  [server-name]
  (jdbc/execute-one! (get-datasource)
    ["SELECT client_id, client_secret FROM mcp_oauth_clients WHERE server_name = ?" server-name]
    {:builder-fn rs/as-unqualified-kebab-maps}))

(defn- save-client-registration!
  "Save dynamic client registration to SQLite."
  [server-name client-id client-secret]
  (jdbc/execute! (get-datasource)
    ["INSERT OR REPLACE INTO mcp_oauth_clients (server_name, client_id, client_secret, registered_at)
      VALUES (?, ?, ?, datetime('now'))"
     server-name client-id client-secret]))

(defn- register-client!
  "Perform OAuth2 Dynamic Client Registration (RFC 7591).
   Returns {:client-id, :client-secret} or nil on failure."
  [server-name metadata callback-url]
  (if-let [reg-endpoint (:registration_endpoint metadata)]
    (let [resp (http/post reg-endpoint
                 {:content-type     :json
                  :body             (json/generate-string
                                     {:client_name    (str "Metabase AI Agent (" server-name ")")
                                      :redirect_uris  [callback-url]
                                      :grant_types    ["authorization_code" "refresh_token"]
                                      :response_types ["code"]
                                      :token_endpoint_auth_method "client_secret_post"})
                  :as               :json
                  :throw-exceptions false
                  :socket-timeout   10000
                  :connection-timeout 5000})]
      (if (#{200 201} (:status resp))
        (let [{:keys [client_id client_secret]} (:body resp)]
          (save-client-registration! server-name client_id client_secret)
          (log/info "MCP OAuth: registered client for" server-name "→" client_id)
          {:client-id client_id :client-secret client_secret})
        (do
          (log/error "MCP OAuth: DCR failed for" server-name
                     "status:" (:status resp) "body:" (:body resp))
          nil)))
    (do
      (log/warn "MCP OAuth: no registration_endpoint in metadata for" server-name
                "— set client_id/secret via env vars")
      ;; Allow manual client config via env
      (let [env-prefix (str "MB_AI_MCP_SERVER_"
                            (str/upper-case (str/replace server-name #"-" "_")))
            cid  (System/getenv (str env-prefix "_OAUTH_CLIENT_ID"))
            csec (System/getenv (str env-prefix "_OAUTH_CLIENT_SECRET"))]
        (when cid
          (save-client-registration! server-name cid csec)
          {:client-id cid :client-secret csec})))))

(defn ensure-client!
  "Ensure we have a registered OAuth client for the server.
   Returns {:client-id, :client-secret} or nil."
  [server-name server-url callback-url]
  (or (get-registered-client server-name)
      (when-let [metadata (discover-oauth-metadata server-url)]
        (register-client! server-name metadata callback-url))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; PKCE helpers
;;; ─────────────────────────────────────────────────────────────────────────────

(defn- random-string
  "Generate a URL-safe random string of n bytes."
  ^String [n]
  (let [bytes (byte-array n)
        _     (.nextBytes (SecureRandom.) bytes)
        ^java.util.Base64$Encoder encoder (Base64/getUrlEncoder)]
    (.encodeToString encoder bytes)))

(defn- sha256-base64url
  "SHA-256 hash, base64url-encoded (no padding)."
  ^String [^String s]
  (let [digest (.digest (MessageDigest/getInstance "SHA-256") (.getBytes s "UTF-8"))]
    (-> (Base64/getUrlEncoder)
        (.withoutPadding)
        (.encodeToString digest))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Authorization flow
;;; ─────────────────────────────────────────────────────────────────────────────

(defn build-authorize-url
  "Build the OAuth2 authorization URL with PKCE.
   Returns {:url, :state} — state is persisted in SQLite for callback validation."
  [server-name server-url callback-url user-id & {:keys [scopes]}]
  (init-db!)
  (let [metadata      (discover-oauth-metadata server-url)
        _             (when-not metadata
                        (throw (ex-info "Cannot discover OAuth metadata for server"
                                        {:server-name server-name :server-url server-url})))
        client        (ensure-client! server-name server-url callback-url)
        _             (when-not client
                        (throw (ex-info "Cannot register OAuth client for server"
                                        {:server-name server-name})))
        state         (random-string 32)
        code-verifier (random-string 32)
        code-challenge (sha256-base64url code-verifier)
        auth-endpoint (:authorization_endpoint metadata)
        params        (cond-> {"response_type"         "code"
                               "client_id"             (:client-id client)
                               "redirect_uri"          callback-url
                               "state"                 state
                               "code_challenge"        code-challenge
                               "code_challenge_method" "S256"}
                        scopes (assoc "scope" (str/join " " scopes)))
        query-string  (str/join "&" (map (fn [[k v]] (str k "=" (java.net.URLEncoder/encode (str v) StandardCharsets/UTF_8)))
                                         params))
        url           (str auth-endpoint "?" query-string)]
    ;; Save state for callback validation
    (jdbc/execute! (get-datasource)
      ["INSERT OR REPLACE INTO mcp_oauth_state (state, user_id, server_name, code_verifier, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))"
       state user-id server-name code-verifier])
    {:url url :state state}))

(defn handle-callback!
  "Handle the OAuth2 callback. Exchange code for tokens and store them.
   Returns {:success true, :server-name} or throws."
  [code state]
  (init-db!)
  (let [ds    (get-datasource)
        ;; Look up state
        row   (jdbc/execute-one! ds
                ["SELECT user_id, server_name, code_verifier FROM mcp_oauth_state WHERE state = ?" state]
                {:builder-fn rs/as-unqualified-kebab-maps})
        _     (when-not row
                (throw (ex-info "Invalid or expired OAuth state" {:state state})))
        {:keys [user-id server-name code-verifier]} row
        ;; Find server URL from env
        env-key    (str "MB_AI_MCP_SERVER_"
                        (str/upper-case (str/replace server-name #"-" "_"))
                        "_URL")
        server-url (System/getenv env-key)
        _          (when-not server-url
                     (throw (ex-info "Server URL not found" {:server-name server-name :env-key env-key})))
        metadata   (discover-oauth-metadata server-url)
        client     (get-registered-client server-name)
        callback-url (str (System/getenv "MB_SITE_URL") "/api/ai-agent/mcp-oauth/callback")
        ;; Exchange code for tokens
        resp       (http/post (:token_endpoint metadata)
                     {:form-params      {"grant_type"    "authorization_code"
                                         "code"          code
                                         "redirect_uri"  callback-url
                                         "client_id"     (:client-id client)
                                         "client_secret" (:client-secret client)
                                         "code_verifier" code-verifier}
                      :as               :json
                      :throw-exceptions false
                      :socket-timeout   10000
                      :connection-timeout 5000})]
    ;; Clean up state
    (jdbc/execute! ds ["DELETE FROM mcp_oauth_state WHERE state = ?" state])
    ;; Clean up old states (>10 min)
    (jdbc/execute! ds ["DELETE FROM mcp_oauth_state WHERE created_at < datetime('now', '-10 minutes')"])

    (if (= 200 (:status resp))
      (let [{:keys [access_token refresh_token token_type expires_in scope]} (:body resp)
            expires-at (when expires_in
                         (str (.plusSeconds (Instant/now) (long expires_in))))]
        (jdbc/execute! ds
          ["INSERT OR REPLACE INTO mcp_oauth_tokens
            (user_id, server_name, access_token, refresh_token, token_type, expires_at, scope, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))"
           user-id server-name access_token refresh_token
           (or token_type "Bearer") expires-at scope])
        (log/info "MCP OAuth: stored tokens for user" user-id "server" server-name)
        {:success true :server-name server-name :user-id user-id})
      (throw (ex-info "Token exchange failed"
                      {:status (:status resp) :body (:body resp)
                       :server-name server-name})))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Token access & refresh
;;; ─────────────────────────────────────────────────────────────────────────────

(defn get-access-token
  "Get the current access token for a user + server. Refreshes if expired.
   Returns the access token string, or nil if not authorized."
  [user-id server-name]
  (init-db!)
  (let [ds  (get-datasource)
        row (jdbc/execute-one! ds
              ["SELECT access_token, refresh_token, expires_at FROM mcp_oauth_tokens
                WHERE user_id = ? AND server_name = ?"
               user-id server-name]
              {:builder-fn rs/as-unqualified-kebab-maps})]
    (when row
      (let [expired? (and (:expires-at row)
                          (.isBefore (Instant/parse (:expires-at row))
                                     (.plusSeconds (Instant/now) 30)))]
        (if (and expired? (:refresh-token row))
          ;; Try refresh
          (let [env-key    (str "MB_AI_MCP_SERVER_"
                                (str/upper-case (str/replace server-name #"-" "_"))
                                "_URL")
                server-url (System/getenv env-key)
                metadata   (when server-url (discover-oauth-metadata server-url))
                client     (get-registered-client server-name)]
            (if (and metadata client)
              (let [resp (http/post (:token_endpoint metadata)
                           {:form-params      {"grant_type"    "refresh_token"
                                               "refresh_token" (:refresh-token row)
                                               "client_id"     (:client-id client)
                                               "client_secret" (:client-secret client)}
                            :as               :json
                            :throw-exceptions false
                            :socket-timeout   10000})]
                (if (= 200 (:status resp))
                  (let [{:keys [access_token refresh_token expires_in]} (:body resp)
                        expires-at (when expires_in
                                     (str (.plusSeconds (Instant/now) (long expires_in))))]
                    (jdbc/execute! ds
                      ["UPDATE mcp_oauth_tokens
                        SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
                            expires_at = ?, updated_at = datetime('now')
                        WHERE user_id = ? AND server_name = ?"
                       access_token refresh_token expires-at user-id server-name])
                    (log/info "MCP OAuth: refreshed token for user" user-id "server" server-name)
                    access_token)
                  (do
                    (log/warn "MCP OAuth: token refresh failed for" server-name
                              "status:" (:status resp))
                    ;; Delete stale token so user re-authorizes
                    (jdbc/execute! ds
                      ["DELETE FROM mcp_oauth_tokens WHERE user_id = ? AND server_name = ?"
                       user-id server-name])
                    nil)))
              ;; Can't refresh — return expired token (server will 401)
              (:access-token row)))
          ;; Not expired or no refresh token — return as-is
          (:access-token row))))))

(defn revoke-token!
  "Delete stored tokens for a user + server."
  [user-id server-name]
  (init-db!)
  (jdbc/execute! (get-datasource)
    ["DELETE FROM mcp_oauth_tokens WHERE user_id = ? AND server_name = ?"
     user-id server-name])
  (log/info "MCP OAuth: revoked tokens for user" user-id "server" server-name))

(defn user-auth-status
  "Check which OAuth MCP servers a user has authorized.
   Returns a map of server-name → {:authorized true/false, :expires-at ...}"
  [user-id server-names]
  (init-db!)
  (let [ds (get-datasource)]
    (into {}
          (map (fn [sn]
                 (let [row (jdbc/execute-one! ds
                             ["SELECT expires_at FROM mcp_oauth_tokens WHERE user_id = ? AND server_name = ?"
                              user-id sn]
                             {:builder-fn rs/as-unqualified-kebab-maps})]
                   [sn {:authorized (some? row)
                        :expires_at (:expires-at row)}]))
               server-names))))

;;; ─────────────────────────────────────────────────────────────────────────────
;;; Server auth type detection
;;; ─────────────────────────────────────────────────────────────────────────────

(defn parse-oauth-servers
  "Parse MCP server auth config from env vars.
   Returns a set of server names that require OAuth2.
   Configured via MB_AI_MCP_SERVER_<NAME>_AUTH=oauth2"
  []
  (when-let [names-str (System/getenv "MB_AI_MCP_SERVER_NAMES")]
    (let [names (map str/trim (str/split names-str #","))]
      (set
        (filter (fn [n]
                  (let [env-key (str "MB_AI_MCP_SERVER_"
                                     (str/upper-case (str/replace n #"-" "_"))
                                     "_AUTH")
                        auth-type (System/getenv env-key)]
                    (= "oauth2" auth-type)))
                names)))))
