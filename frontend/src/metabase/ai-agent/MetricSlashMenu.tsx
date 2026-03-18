import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "ttag";

import { Box, Flex, Icon, Text, TextInput } from "metabase/ui";

import S from "./MetricSlashMenu.module.css";

export interface MetricItem {
  id: number;
  name: string;
  description?: string | null;
  collection_name?: string | null;
}

interface MetricSlashMenuProps {
  /** Anchor element for positioning the popup */
  anchorRef: React.RefObject<HTMLElement | null>;
  onSelect: (metric: MetricItem) => void;
  onClose: () => void;
  datasourceId?: number | null;
}

function apiHeaders(): Record<string, string> {
  return { "Content-Type": "application/json" };
}

export function MetricSlashMenu({
  anchorRef,
  onSelect,
  onClose,
  datasourceId,
}: MetricSlashMenuProps) {
  const [query, setQuery] = useState("");
  const [metrics, setMetrics] = useState<MetricItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Fetch metrics
  useEffect(() => {
    setIsLoading(true);
    const params = new URLSearchParams({ models: "metric", limit: "50" });
    if (query) {
      params.set("q", query);
    }
    if (datasourceId) {
      params.set("table_db_id", String(datasourceId));
    }
    fetch(`/api/search?${params}`, { headers: apiHeaders() })
      .then(r => r.json())
      .then(data => {
        const items: MetricItem[] = (data.data ?? data ?? []).map(
          (m: Record<string, unknown>) => ({
            id: m.id as number,
            name: m.name as string,
            description: m.description as string | null,
            collection_name: (m.collection as Record<string, unknown>)?.name as string | null,
          }),
        );
        setMetrics(items);
        setSelectedIndex(0);
      })
      .catch(() => setMetrics([]))
      .finally(() => setIsLoading(false));
  }, [query, datasourceId]);

  // Auto-focus search
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex(i => (i < metrics.length - 1 ? i + 1 : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(i => (i > 0 ? i - 1 : metrics.length - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (metrics[selectedIndex]) {
          onSelect(metrics[selectedIndex]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [metrics, selectedIndex, onSelect, onClose],
  );

  // Position above the textarea
  const anchor = anchorRef.current;
  const rect = anchor?.getBoundingClientRect();
  const style: React.CSSProperties = rect
    ? {
        position: "fixed",
        bottom: window.innerHeight - rect.top + 4,
        left: rect.left,
        width: Math.min(rect.width, 400),
        zIndex: 300,
      }
    : { display: "none" };

  return (
    <Box style={style} className={S.container}>
      <TextInput
        ref={inputRef}
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t`Search metrics…`}
        size="xs"
        variant="unstyled"
        className={S.searchInput}
        leftSection={<Icon name="metric" size={14} />}
      />
      <div ref={listRef} className={S.list}>
        {isLoading && (
          <Text size="xs" c="text-tertiary" ta="center" py="sm">
            {t`Loading…`}
          </Text>
        )}
        {!isLoading && metrics.length === 0 && (
          <Text size="xs" c="text-tertiary" ta="center" py="sm">
            {t`No metrics found`}
          </Text>
        )}
        {!isLoading &&
          metrics.map((m, i) => (
            <Flex
              key={m.id}
              className={`${S.item} ${i === selectedIndex ? S.itemSelected : ""}`}
              align="center"
              gap="xs"
              px="sm"
              py={6}
              onClick={() => onSelect(m)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <Icon name="metric" size={14} className={S.itemIcon} />
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" fw={500} truncate>
                  {m.name}
                </Text>
                {m.description && (
                  <Text size="xs" c="text-tertiary" truncate>
                    {m.description}
                  </Text>
                )}
              </Box>
              {m.collection_name && (
                <Text size="xs" c="text-tertiary" style={{ flexShrink: 0 }}>
                  {m.collection_name}
                </Text>
              )}
            </Flex>
          ))}
      </div>
    </Box>
  );
}

