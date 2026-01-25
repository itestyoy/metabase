import { useCallback, useMemo, useState } from "react";
import { t } from "ttag";

import { MiniPicker } from "metabase/common/components/Pickers/MiniPicker";
import type { MiniPickerPickableItem } from "metabase/common/components/Pickers/MiniPicker/types";
import { Box, Text } from "metabase/ui";
import * as Lib from "metabase-lib";

import type { NotebookStepProps } from "../../types";
import { NotebookCell, NotebookCellAdd } from "../NotebookCell";

export function MetricsPickerStep({
  query,
  step,
  color,
  readOnly,
  updateQuery,
}: NotebookStepProps) {
  const { stageIndex } = step;
  const [isOpened, setIsOpened] = useState(false);

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
          updateQuery(nextQuery);
          setIsOpened(false);
        }
      }
    },
    [metricsById, query, stageIndex, updateQuery],
  );

  const handleClose = useCallback(() => {
    setIsOpened(false);
  }, []);

  if (metrics.length === 0 || readOnly) {
    return null;
  }

  return (
    <Box>
      <Text size="sm" fw="bold" c={color} mb="xs">
        {t`Pick a metric`}
      </Text>
      <NotebookCell color={color}>
        <NotebookCellAdd
          color={color}
          initialAddText={t`Browse metrics`}
          onClick={() => setIsOpened(true)}
          data-testid="metrics-picker-step"
        />
        <MiniPicker
          opened={isOpened}
          onClose={handleClose}
          models={["metric"]}
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
      </NotebookCell>
    </Box>
  );
}

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
