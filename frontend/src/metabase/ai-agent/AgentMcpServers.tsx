import { useCallback, useEffect, useState } from "react";
import { t } from "ttag";

import api from "metabase/lib/api";
import { ActionIcon, Icon, Menu, Text, Tooltip } from "metabase/ui";

import S from "./AgentMcpServers.module.css";

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface McpServer {
  name: string;
  auth_type?: "oauth2";
  authorized?: boolean;
}

interface AgentMcpServersProps {
  /** "items" renders only Menu.Label + Menu.Items for embedding in a parent Menu */
  variant?: "icon" | "items";
}

export function AgentMcpServers({ variant = "icon" }: AgentMcpServersProps = {}) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [isOpen, setIsOpen] = useState(false);

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

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "mcp-oauth-success") {
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
        const w = 600, h = 700;
        const left = window.screenX + (window.innerWidth - w) / 2;
        const top = window.screenY + (window.innerHeight - h) / 2;
        window.open(data.authorize_url, `mcp-oauth-${serverName}`, `width=${w},height=${h},left=${left},top=${top},popup=yes`);
      }
    } catch { /* ignore */ }
  }, []);

  const handleRevoke = useCallback(async (serverName: string) => {
    try {
      await api.POST(`/api/ai-agent/mcp-oauth/revoke/${serverName}`)({});
      fetchServers();
    } catch { /* ignore */ }
  }, [fetchServers]);

  if (servers.length === 0) {
    return null;
  }

  const needsAttention = servers.some(s => s.auth_type === "oauth2" && !s.authorized);

  // ── "items" variant: just Menu.Label + Menu.Items for parent Menu ──
  if (variant === "items") {
    return (
      <>
        <Menu.Label>{t`MCP Servers`}</Menu.Label>
        {servers.map(server => {
          const isOAuth = server.auth_type === "oauth2";
          const authorized = !isOAuth || server.authorized;
          return (
            <Menu.Item
              key={server.name}
              leftSection={
                <Icon
                  name={authorized ? "bolt" : "lock"}
                  size={14}
                  color={authorized ? "var(--mb-color-success)" : "var(--mb-color-warning)"}
                />
              }
              rightSection={
                isOAuth && authorized ? (
                  <ActionIcon
                    variant="transparent"
                    size={18}
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleRevoke(server.name); }}
                  >
                    <Icon name="close" size={10} color="var(--mb-color-text-tertiary)" />
                  </ActionIcon>
                ) : undefined
              }
              onClick={!authorized ? () => handleAuthorize(server.name) : undefined}
            >
              <div>
                <Text size="xs" fw={500}>{capitalize(server.name)}</Text>
                <Text size="xs" c={authorized ? "text-tertiary" : "warning"}>
                  {authorized ? t`Connected` : t`Click to authorize`}
                </Text>
              </div>
            </Menu.Item>
          );
        })}
      </>
    );
  }

  // ── "icon" variant: standalone Menu with icon trigger ──
  return (
    <Menu opened={isOpen} onChange={setIsOpen} position="top-start" shadow="md" width={260}>
      <Menu.Target>
        <Tooltip label={t`MCP`} position="top" withArrow>
          <ActionIcon
            variant="transparent"
            size="sm"
            onClick={() => setIsOpen(o => !o)}
            aria-label={t`MCP`}
            className={needsAttention ? S.mcpIconAttention : undefined}
          >
            <Icon name="bolt" size={14} color="var(--mb-color-success)" />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>

      <Menu.Dropdown>
        <Menu.Label>{t`MCP Servers`}</Menu.Label>
        {servers.map(server => {
          const isOAuth = server.auth_type === "oauth2";
          const authorized = !isOAuth || server.authorized;
          return (
            <Menu.Item
              key={server.name}
              leftSection={
                <Icon
                  name={authorized ? "bolt" : "lock"}
                  size={14}
                  color={authorized ? "var(--mb-color-success)" : "var(--mb-color-warning)"}
                />
              }
              rightSection={
                isOAuth && authorized ? (
                  <ActionIcon
                    variant="transparent"
                    size={18}
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleRevoke(server.name); }}
                  >
                    <Icon name="close" size={10} color="var(--mb-color-text-tertiary)" />
                  </ActionIcon>
                ) : undefined
              }
              onClick={!authorized ? () => handleAuthorize(server.name) : undefined}
            >
              <div>
                <Text size="xs" fw={500}>{capitalize(server.name)}</Text>
                <Text size="xs" c={authorized ? "text-tertiary" : "warning"}>
                  {authorized ? t`Connected` : t`Click to authorize`}
                </Text>
              </div>
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
}
