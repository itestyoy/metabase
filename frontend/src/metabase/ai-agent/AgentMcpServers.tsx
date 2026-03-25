import { useCallback, useEffect, useState } from "react";
import { t } from "ttag";

import api from "metabase/lib/api";
import { ActionIcon, Icon, Text, Tooltip } from "metabase/ui";

import S from "./AgentMcpServers.module.css";

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface McpTool {
  name: string;
  description: string;
}

interface McpServer {
  name: string;
  tools: McpTool[];
  auth_type?: "oauth2";
  authorized?: boolean;
}

export function AgentMcpServers() {
  const [servers, setServers] = useState<McpServer[]>([]);

  const fetchServers = useCallback(() => {
    api
      .GET("/api/ai-agent/mcp-servers")({})
      .then((data: unknown) => {
        const d = data as { servers?: McpServer[] };
        if (Array.isArray(d.servers)) {
          setServers(d.servers);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  // Listen for OAuth popup messages
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "mcp-oauth-success") {
        // Re-fetch servers to get updated auth status
        fetchServers();
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [fetchServers]);

  const handleAuthorize = useCallback(async (serverName: string) => {
    try {
      const resp = await api.GET(`/api/ai-agent/mcp-oauth/authorize/${serverName}`)({});
      const data = resp as { authorize_url?: string };
      if (data.authorize_url) {
        // Open OAuth flow in popup
        const w = 600;
        const h = 700;
        const left = window.screenX + (window.innerWidth - w) / 2;
        const top = window.screenY + (window.innerHeight - h) / 2;
        window.open(
          data.authorize_url,
          `mcp-oauth-${serverName}`,
          `width=${w},height=${h},left=${left},top=${top},popup=yes`,
        );
      }
    } catch {
      // ignore
    }
  }, []);

  const handleRevoke = useCallback(
    async (serverName: string) => {
      try {
        await api.POST(`/api/ai-agent/mcp-oauth/revoke/${serverName}`)({});
        fetchServers();
      } catch {
        // ignore
      }
    },
    [fetchServers],
  );

  if (servers.length === 0) {
    return null;
  }

  return (
    <div className={S.mcpBar}>
      <div className={S.mcpChips}>
        {servers.map(server => {
          const isOAuth = server.auth_type === "oauth2";
          const needsAuth = isOAuth && !server.authorized;

          return (
            <Tooltip
              key={server.name}
              label={
                needsAuth
                  ? t`Click to authorize ${capitalize(server.name)}`
                  : isOAuth
                    ? t`${capitalize(server.name)} (authorized)`
                    : capitalize(server.name)
              }
              multiline
              maw={300}
            >
              <div
                className={needsAuth ? S.mcpChipUnauthorized : S.mcpChip}
                onClick={needsAuth ? () => handleAuthorize(server.name) : undefined}
                style={needsAuth ? { cursor: "pointer" } : undefined}
              >
                <Icon
                  name={needsAuth ? "lock" : "bolt"}
                  size={10}
                />
                <Text
                  size="xs"
                  lh={1}
                  component="span"
                  className={needsAuth ? S.mcpChipNameUnauthorized : S.mcpChipName}
                >
                  {capitalize(server.name)}
                </Text>
                {isOAuth && server.authorized && (
                  <Tooltip label={t`Revoke access`}>
                    <ActionIcon
                      variant="transparent"
                      size={14}
                      onClick={e => {
                        e.stopPropagation();
                        handleRevoke(server.name);
                      }}
                    >
                      <Icon name="close" size={8} color="var(--mb-color-success)" />
                    </ActionIcon>
                  </Tooltip>
                )}
              </div>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
