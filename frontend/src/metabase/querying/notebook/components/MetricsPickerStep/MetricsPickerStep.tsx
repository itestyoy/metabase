import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "ttag";

import { collectionApi } from "metabase/api";
import { MiniPicker } from "metabase/common/components/Pickers/MiniPicker";
import type { MiniPickerPickableItem } from "metabase/common/components/Pickers/MiniPicker/types";
import { useDispatch } from "metabase/lib/redux";
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

  const dispatch = useDispatch();

  const { metricsById, metricCollectionIds } = useMemo(() => {
    const metricMap = new Map<string, Lib.MetricMetadata>();
    const collectionIds = new Set<number>();
    metrics.forEach((metric) => {
      const displayInfo = Lib.displayInfo(query, stageIndex, metric);
      const info = displayInfo as unknown as {
        id?: number;
        collectionId?: number | null;
      };
      if (info.id != null) {
        metricMap.set(String(info.id), metric);
        if (info.collectionId != null) {
          collectionIds.add(info.collectionId);
        }
      }
    });
    return { metricsById: metricMap, metricCollectionIds: collectionIds };
  }, [metrics, query, stageIndex]);

  // Fetch collections to get full hierarchy (location paths)
  const [validCollectionIds, setValidCollectionIds] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    if (metricCollectionIds.size === 0) {
      setValidCollectionIds(new Set());
      return;
    }

    const fetchCollectionHierarchy = async () => {
      const allCollectionIds = new Set<string>();

      // Fetch each collection to get its location
      const collectionPromises = Array.from(metricCollectionIds).map(
        async (collectionId) => {
          try {
            const collection = await dispatch(
              collectionApi.endpoints.getCollection.initiate({
                id: collectionId,
              }),
            ).unwrap();

            // Add the collection itself
            allCollectionIds.add(String(collectionId));

            // Parse location to get ancestor collection IDs
            // Location format: "/1/5/10/" means ancestors are 1, 5, 10
            const location =
              collection.effective_location || collection.location;
            if (location) {
              const ancestorIds = location
                .split("/")
                .filter((id: string) => id && id !== "");
              ancestorIds.forEach((id: string) => allCollectionIds.add(id));
            }
          } catch {
            // If fetch fails, just add the collection ID
            allCollectionIds.add(String(collectionId));
          }
        },
      );

      await Promise.all(collectionPromises);
      setValidCollectionIds(allCollectionIds);
    };

    fetchCollectionHierarchy();
  }, [metricCollectionIds, dispatch]);

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

              // Only show metrics and collections
              if (modelItem.model === "metric") {
                return !metricsById.has(String(modelItem.id));
              }
              if (modelItem.model === "collection") {
                // Hide collections that don't contain valid metrics
                return !validCollectionIds.has(String(modelItem.id));
              }
              // Hide all other entity types
              return true;
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
