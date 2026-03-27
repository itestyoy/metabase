import { useEffect, useRef, useState } from "react";
import { t } from "ttag";

import { Box, Flex, Icon, Text } from "metabase/ui";

import S from "./MetricSlashMenu.module.css";

export interface MetricItem {
  id: number;
  name: string;
  description?: string | null;
  collection_name?: string | null;
  table_id?: number | null;
}

interface MetricSlashMenuProps {
  /** Search query (text typed after "/") — controlled by parent */
  query: string;
  /** Currently highlighted item index — controlled by parent via arrow keys */
  selectedIndex: number;
  /** Anchor element for positioning */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Called when metrics list updates (parent stores the list for Enter handling) */
  onLoaded: (metrics: MetricItem[]) => void;
  /** Called when user clicks a metric item */
  onSelect: (metric: MetricItem) => void;
  databaseId?: number | null;
  tableIds?: number[];
}

export function MetricSlashMenu({
  query,
  selectedIndex,
  anchorRef,
  onLoaded,
  onSelect,
  databaseId,
  tableIds = [],
}: MetricSlashMenuProps) {
  const [metrics, setMetrics] = useState<MetricItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  // Fetch metrics with pagination — when filtering by table client-side,
  // keep fetching pages until we have 50 filtered results or no more pages.
  useEffect(() => {
    setIsLoading(true);
    let canceled = false;
    const PAGE_SIZE = 50;
    const TARGET = 50;

    const fetchPages = async () => {
      const collected: MetricItem[] = [];
      let offset = 0;
      let hasMore = true;

      const hasTableFilter = tableIds.length > 0;
      while (hasMore && (hasTableFilter ? collected.length < TARGET : offset === 0)) {
        const params = new URLSearchParams({ models: "metric", limit: String(PAGE_SIZE), offset: String(offset) });
        if (query) params.set("q", query);
        if (databaseId) params.set("table_db_id", String(databaseId));

        try {
          const resp = await fetch(`/api/search?${params}`, { headers: { "Content-Type": "application/json" } });
          const data = await resp.json();
          const page: MetricItem[] = (data.data ?? data ?? []).map(
            (m: Record<string, unknown>) => ({
              id: m.id as number,
              name: m.name as string,
              description: m.description as string | null,
              collection_name: (m.collection as Record<string, unknown>)?.name as string | null,
              table_id: m.table_id as number | null,
            }),
          );

          if (canceled) return;

          const tableIdSet = new Set(tableIds);
          const filtered = hasTableFilter ? page.filter(m => m.table_id != null && tableIdSet.has(m.table_id)) : page;
          collected.push(...filtered);
          hasMore = page.length === PAGE_SIZE;
          offset += PAGE_SIZE;
        } catch {
          break;
        }
      }

      if (!canceled) {
        const items = collected.slice(0, TARGET);
        setMetrics(items);
        onLoaded(items);
        setIsLoading(false);
      }
    };

    fetchPages();
    return () => { canceled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, databaseId, tableIds.join(",")]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Position above the anchor
  const rect = anchorRef.current?.getBoundingClientRect();
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
    <Box style={style} className={S.container} data-slash-menu onMouseDown={e => e.preventDefault()}>
      <Text size="xs" fw={600} c="text-tertiary" px="sm" py={4}>
        {t`Metrics`}{query ? ` — "${query}"` : ""}
      </Text>
      <div ref={listRef} className={S.list}>
        {isLoading && (
          <Text size="xs" c="text-tertiary" ta="center" py="sm">{t`Loading…`}</Text>
        )}
        {!isLoading && metrics.length === 0 && (
          <Text size="xs" c="text-tertiary" ta="center" py="sm">{t`No metrics found`}</Text>
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
              style={{ cursor: "pointer" }}
            >
              <Icon name="metric" size={14} className={S.itemIcon} />
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" fw={500} truncate>{m.name}</Text>
                {m.description && (
                  <Text size="xs" c="text-tertiary" truncate>{m.description}</Text>
                )}
              </Box>
              {m.collection_name && (
                <Text size="xs" c="text-tertiary" style={{ flexShrink: 0 }}>{m.collection_name}</Text>
              )}
            </Flex>
          ))}
      </div>
    </Box>
  );
}
