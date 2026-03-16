import { useEffect, useState } from "react";
import { t } from "ttag";

import api from "metabase/lib/api";
import { Icon, Text, Tooltip } from "metabase/ui";

import S from "./AgentMcpServers.module.css";

interface McpTool {
  name: string;
  description: string;
}

interface McpServer {
  name: string;
  tools: McpTool[];
}

export function AgentMcpServers() {
  const [servers, setServers] = useState<McpServer[]>([]);

  useEffect(() => {
    api
      .GET("/api/ai-agent/mcp-servers")({})
      .then((data: unknown) => {
        const d = data as { servers?: McpServer[] };
        if (Array.isArray(d.servers)) {
          setServers(d.servers);
        }
      })
      .catch(() => {
        // No access or not configured — ignore
      });
  }, []);

  if (servers.length === 0) {
    return null;
  }

  return (
    <div className={S.mcpBar}>
      <Text size="xs" c="text-tertiary" lh={1} className={S.mcpLabel}>
        {t`Tools:`}
      </Text>
      <div className={S.mcpChips}>
        {servers.map(server => (
          <Tooltip
            key={server.name}
            label={server.name}
            multiline
            maw={300}
          >
            <div className={S.mcpChip}>
              <Icon name="bolt" size={10} />
              <Text size="xs" lh={1} className={S.mcpChipName}>
                {server.name}
              </Text>
            </div>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
