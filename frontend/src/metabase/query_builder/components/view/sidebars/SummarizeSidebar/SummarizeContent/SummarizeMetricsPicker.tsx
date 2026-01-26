import { type ChangeEvent, useCallback, useMemo, useState } from "react";
import { t } from "ttag";

import Input from "metabase/common/components/Input";
import { MiniPicker } from "metabase/common/components/Pickers/MiniPicker";
import type { MiniPickerPickableItem } from "metabase/common/components/Pickers/MiniPicker/types";
import type { UpdateQueryHookProps } from "metabase/query_builder/hooks/types";
import { Box, Space, Stack, type StackProps, Title } from "metabase/ui";
import * as Lib from "metabase-lib";
import type { CollectionId } from "metabase-types/api";

type SummarizeMetricsPickerProps = UpdateQueryHookProps & StackProps;

export const SummarizeMetricsPicker = ({
  query,
  onQueryChange,
  stageIndex,
  ...containerProps
}: SummarizeMetricsPickerProps) => {
  const [isOpened, setIsOpened] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [focusPicker, setFocusPicker] = useState(false);

  const metrics = useMemo(
    () => Lib.availableMetrics(query, stageIndex),
    [query, stageIndex],
  );

  const { metricsById, metricCollectionIds } = useMemo(() => {
    const metricMap = new Map<string, Lib.MetricMetadata>();
    const collectionIdSet = new Set<CollectionId>();

    metrics.forEach((metric) => {
      const displayInfo = Lib.displayInfo(query, stageIndex, metric);
      const info = displayInfo as unknown as {
        id?: number | string;
        "collection-id"?: CollectionId;
        collection_id?: CollectionId;
      };
      if (info.id != null) {
        metricMap.set(String(info.id), metric);
      }
      const collectionId = info["collection-id"] ?? info.collection_id;
      if (collectionId != null) {
        collectionIdSet.add(collectionId);
      }
    });

    return {
      metricsById: metricMap,
      metricCollectionIds: Array.from(collectionIdSet),
    };
  }, [metrics, query, stageIndex]);

  const visibleCollectionIds = metricCollectionIds.length
    ? metricCollectionIds
    : undefined;

  const handleMetricSelect = useCallback(
    (item: MiniPickerPickableItem) => {
      if (isMetricItem(item)) {
        const metric = metricsById.get(String(item.id));
        const metricAggregable = metric ?? createMetricClauseFromItem(item);

        if (metricAggregable) {
          const nextQuery = Lib.aggregate(query, stageIndex, metricAggregable);
          onQueryChange(nextQuery);
          setIsOpened(false);
          setSearchQuery("");
        }
      }
    },
    [metricsById, query, stageIndex, onQueryChange],
  );

  const handleClose = useCallback(() => {
    setIsOpened(false);
  }, []);

  const handleChangeSearchQuery = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(event.target.value);
      setIsOpened(true);
      setFocusPicker(false);
    },
    [],
  );

  const handleResetSearch = useCallback(() => setSearchQuery(""), []);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        setFocusPicker(true);
      }
    },
    [],
  );

  const handleInputFocus = useCallback(() => {
    setIsOpened(true);
    setFocusPicker(false);
  }, []);

  if (metrics.length === 0) {
    return null;
  }

  return (
    <Stack gap="0" {...containerProps}>
      <Title order={5} fw={900}>{t`Pick a metric`}</Title>
      <Space my="sm" />
      <Box mb="md">
        <MiniPicker
          opened={isOpened}
          onClose={handleClose}
          models={["metric", "card"]}
          searchQuery={searchQuery}
          trapFocus={focusPicker}
          onChange={handleMetricSelect}
          visibleCollectionIds={visibleCollectionIds}
          shouldHide={(item) => {
            if (
              typeof item === "object" &&
              item != null &&
              "model" in item
            ) {
              const modelItem = item as {
                model: string;
                id?: number | string;
                type?: string;
                card_type?: string;
              };

              // Check if this is a metric (can be model "metric" or "card" with type/card_type "metric")
              const isMetric =
                modelItem.model === "metric" ||
                (modelItem.model === "card" &&
                  (modelItem.type === "metric" ||
                    modelItem.card_type === "metric"));

              if (isMetric) {
                return !metricsById.has(String(modelItem.id));
              }
              // Always show collections for navigation
              if (modelItem.model === "collection") {
                return false;
              }
              // Hide all other entity types (questions, dashboards, etc.)
              return true;
            }
            return false;
          }}
        />
        <Input
          fullWidth
          placeholder={t`Find...`}
          value={searchQuery}
          leftIcon="search"
          onResetClick={handleResetSearch}
          onChange={handleChangeSearchQuery}
          onKeyDown={handleInputKeyDown}
          onFocus={handleInputFocus}
          data-testid="metrics-picker-search"
        />
      </Box>
    </Stack>
  );
};

function createMetricClauseFromItem(
  item: MiniPickerPickableItem,
): Lib.AggregationClause | null {
  if (!isMetricItem(item) || item.id == null) {
    return null;
  }

  const name = item.name;
  const options =
    name != null
      ? {
          name,
          "display-name": name,
          "long-display-name": name,
        }
      : {};

  return ["metric", options, item.id] as unknown as Lib.AggregationClause;
}

function isMetricItem(item: MiniPickerPickableItem) {
  return (
    item.model === "metric" ||
    (item.model === "card" &&
      typeof item === "object" &&
      item != null &&
      "type" in item &&
      ((item as { type?: string }).type === "metric" ||
        (item as { card_type?: string }).card_type === "metric"))
  );
}
