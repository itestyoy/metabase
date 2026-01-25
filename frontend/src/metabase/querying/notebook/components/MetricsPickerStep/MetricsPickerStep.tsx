import { useCallback, useMemo, useState } from "react";
import { t } from "ttag";

import { MiniPicker } from "metabase/common/components/Pickers/MiniPicker";
import type { MiniPickerPickableItem } from "metabase/common/components/Pickers/MiniPicker/types";
import { Icon, TextInput } from "metabase/ui";
import * as Lib from "metabase-lib";

import type { NotebookStepProps } from "../../types";
import { NotebookCell } from "../NotebookCell";

export function MetricsPickerStep({
  query,
  step,
  color,
  readOnly,
  updateQuery,
}: NotebookStepProps) {
  const { stageIndex } = step;
  const [isOpened, setIsOpened] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [focusPicker, setFocusPicker] = useState(false);

  const metrics = useMemo(
    () => Lib.availableMetrics(query, stageIndex),
    [query, stageIndex],
  );

  const metricsById = useMemo(() => {
    const metricMap = new Map<string, Lib.MetricMetadata>();
    console.log("[MetricsPickerStep] metrics count:", metrics.length);
    metrics.forEach((metric) => {
      const displayInfo = Lib.displayInfo(query, stageIndex, metric);
      console.log("[MetricsPickerStep] displayInfo:", displayInfo);
      const metricId = (displayInfo as unknown as { id?: number }).id;
      console.log("[MetricsPickerStep] metricId:", metricId);
      if (metricId != null) {
        metricMap.set(String(metricId), metric);
      }
    });
    console.log("[MetricsPickerStep] metricsById keys:", [...metricMap.keys()]);
    return metricMap;
  }, [metrics, query, stageIndex]);

  const handleMetricSelect = useCallback(
    (item: MiniPickerPickableItem) => {
      if (isMetricItem(item)) {
        const metric = metricsById.get(String(item.id));
        const metricAggregable = metric ?? createMetricClauseFromItem(item);

        if (metricAggregable) {
          const nextQuery = Lib.aggregate(query, stageIndex, metricAggregable);
          updateQuery(nextQuery);
          setIsOpened(false);
          setSearchQuery("");
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
    <NotebookCell color={color}>
      <>
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
              "model" in item
            ) {
              const modelItem = item as { model: string; id?: number | string };
              const shouldHide = !metricsById.has(String(modelItem.id));
              console.log("[MetricsPickerStep] shouldHide item:", modelItem.id, modelItem.model, "hide:", shouldHide);
              return shouldHide;
            }
            return false;
          }}
        />
        <TextInput
          placeholder={t`Pick a metric...`}
          value={searchQuery}
          variant="unstyled"
          styles={{
            input: { background: "transparent", border: "none", p: 0 },
          }}
          leftSection={<Icon name="search" />}
          onChange={(e) => setSearchQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "Tab") {
              e.preventDefault();
              e.stopPropagation();
              setFocusPicker(true);
            }
          }}
          onClickCapture={(e) => {
            e.stopPropagation();
            setIsOpened(true);
            setFocusPicker(false);
          }}
          miw="12rem"
          autoFocus={isOpened}
          data-testid="metrics-picker-step"
        />
      </>
    </NotebookCell>
  );
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
      ((item as { type?: string }).type === "metric" ||
        (item as { card_type?: string }).card_type === "metric"))
  );
}
