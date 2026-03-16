import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { t } from "ttag";

import { MiniPicker } from "metabase/common/components/Pickers/MiniPicker";
import type { MiniPickerPickableItem } from "metabase/common/components/Pickers/MiniPicker/types";
import { Icon, TextInput } from "metabase/ui";
import * as Lib from "metabase-lib";
import { collectionApi } from "metabase/api/collection";
import { useDispatch, useSelector } from "metabase/lib/redux";
import type { Collection, CollectionId } from "metabase-types/api";

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
  const dispatch = useDispatch();

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
        collectionId?: CollectionId;
      };
      if (info.id != null) {
        metricMap.set(String(info.id), metric);
      }
      const collectionId = info.collectionId;
      if (collectionId != null) {
        collectionIdSet.add(collectionId);
      }
    });

    return {
      metricsById: metricMap,
      metricCollectionIds: Array.from(collectionIdSet),
    };
  }, [metrics, query, stageIndex]);

  const collections = useSelector((state) =>
    metricCollectionIds.map(
      (id) =>
        collectionApi.endpoints.getCollection.select({ id })(state)?.data ??
        null,
    ),
  );

  const missingCollectionIds = useMemo(
    () =>
      metricCollectionIds.filter((id, index) => collections[index] == null),
    [collections, metricCollectionIds],
  );

  const missingCollectionsKey = useMemo(
    () => missingCollectionIds.join("|"),
    [missingCollectionIds],
  );

  const allowedCollectionIdSet = useMemo(() => {
    const allowedIds = new Set<CollectionId>(["root" as CollectionId]);

    metricCollectionIds.forEach((id) => allowedIds.add(id));
    collections.forEach((collection) => {
      if (collection) {
        addAncestorIds(collection, allowedIds);
      }
    });

    return allowedIds;
  }, [collections, metricCollectionIds]);

  const lastMissingKeyRef = useRef<string>();

  useEffect(() => {
    if (missingCollectionsKey === lastMissingKeyRef.current) {
      return;
    }
    lastMissingKeyRef.current = missingCollectionsKey;

    if (!missingCollectionIds.length) {
      return;
    }

    missingCollectionIds.forEach((id) => {
      dispatch(
        collectionApi.endpoints.getCollection.initiate(
          { id },
          { subscribe: false },
        ),
      );
    });
  }, [dispatch, missingCollectionIds, missingCollectionsKey]);

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
          models={["metric", "card"]}
          searchQuery={searchQuery}
          trapFocus={focusPicker}
          onChange={handleMetricSelect}
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
                collection_id?: CollectionId | null;
                collection?: { id?: CollectionId | null };
              };

              if (
                allowedCollectionIdSet.size &&
                !isItemInAllowedCollection(modelItem, allowedCollectionIdSet)
              ) {
                return true;
              }

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

function addAncestorIds(
  collection: Collection,
  target: Set<CollectionId>,
) {
  const location = collection.effective_location ?? collection.location;

  (collection.effective_ancestors ?? []).forEach((ancestor) => {
    if (ancestor.id != null) {
      target.add(ancestor.id as CollectionId);
    }
  });

  if (location) {
    location
      .split("/")
      .filter(Boolean)
      .forEach((part) => {
        const parsed = Number(part);
        if (!Number.isNaN(parsed)) {
          target.add(parsed as CollectionId);
        } else {
          target.add(part as CollectionId);
        }
      });
  }
}

function isItemInAllowedCollection(
  item: {
    model: string;
    id?: number | string | null;
    collection_id?: CollectionId | null;
    collection?: { id?: CollectionId | null };
  },
  allowedCollectionIds: Set<CollectionId>,
) {
  if (!allowedCollectionIds.size) {
    return true;
  }

  if (item.model === "collection") {
    return (
      item.id != null &&
      allowedCollectionIds.has(item.id as CollectionId)
    );
  }

  const collectionId = item.collection_id ?? item.collection?.id ?? null;

  // null collection_id means root collection
  if (collectionId == null) {
    return allowedCollectionIds.has("root" as CollectionId);
  }

  return allowedCollectionIds.has(collectionId);
}
