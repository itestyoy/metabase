import { useCallback, useMemo, useState } from "react";
import { t } from "ttag";

import { MiniPicker } from "metabase/common/components/Pickers/MiniPicker";
import type { MiniPickerPickableItem } from "metabase/common/components/Pickers/MiniPicker/types";
import type { UpdateQueryHookProps } from "metabase/query_builder/hooks/types";
import { Box, type BoxProps, Icon, Text, TextInput } from "metabase/ui";
import * as Lib from "metabase-lib";

type SummarizeMetricsPickerProps = UpdateQueryHookProps & BoxProps;

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

  const metricsById = useMemo(() => {
    const metricMap = new Map<string, Lib.MetricMetadata>();
    metrics.forEach((metric) => {
      const metricId = getMetricId(metric);
      if (metricId != null) {
        metricMap.set(String(metricId), metric);
      }
    });
    return metricMap;
  }, [metrics]);

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

  if (metrics.length === 0) {
    return null;
  }

  return (
    <Box {...containerProps}>
      <Text fw="bold" mb="sm" c="text-medium">
        {t`Pick a metric`}
      </Text>
      <Box pos="relative">
        <MiniPicker
          opened={isOpened}
          onClose={handleClose}
          models={["metric"]}
          searchQuery={searchQuery}
          trapFocus={focusPicker}
          onChange={handleMetricSelect}
          shouldHide={(item) => {
            if (
              typeof item === "object" &&
              item != null &&
              "model" in item &&
              (item.model === "database" || item.model === "schema")
            ) {
              return true;
            }
            return false;
          }}
        />
        <TextInput
          placeholder={t`Search for metrics...`}
          value={searchQuery}
          leftSection={<Icon name="search" />}
          onChange={(e) => setSearchQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "Tab") {
              e.preventDefault();
              e.stopPropagation();
              setFocusPicker(true);
            }
          }}
          onFocus={() => {
            setIsOpened(true);
            setFocusPicker(false);
          }}
          data-testid="metrics-picker-search"
        />
      </Box>
    </Box>
  );
};

function getMetricId(
  metric: Lib.MetricMetadata,
): number | string | undefined {
  if (metric && typeof metric === "object" && "id" in metric) {
    return (metric as { id?: number | string }).id;
  }
  if (
    metric &&
    typeof metric === "object" &&
    "metric_id" in metric &&
    (metric as { metric_id?: number | string }).metric_id != null
  ) {
    return (metric as { metric_id?: number | string }).metric_id;
  }
  return undefined;
}

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
      (item as { type?: string }).type === "metric")
  );
}
