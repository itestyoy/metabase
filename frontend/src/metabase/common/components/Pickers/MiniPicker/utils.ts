import { useMemo, useState } from "react";
import { useDeepCompareEffect } from "react-use";
import { t } from "ttag";

import { cardApi, collectionApi, databaseApi, tableApi } from "metabase/api";
import type { DispatchFn } from "metabase/lib/redux";
import { useDispatch } from "metabase/lib/redux";
import type {
  Collection,
  CollectionId,
  CollectionType,
  SchemaName,
} from "metabase-types/api";

import type { DataPickerValue } from "../DataPicker";
import type { TablePickerValue } from "../TablePicker";

import {
  type MiniPickerCollectionItem,
  type MiniPickerFolderItem,
  MiniPickerFolderModel,
  type MiniPickerItem,
  type MiniPickerPickableItem,
} from "./types";

export const getOurAnalytics = (): MiniPickerFolderItem => ({
  model: "collection",
  id: "root" as any, // cmon typescript
  name: t`Our analytics`,
  here: ["card"],
  below: ["card"],
});

export function useGetPathFromValue({
  value,
  opened,
  libraryCollection,
  visibleCollectionIds,
}: {
  value?: DataPickerValue;
  opened: boolean;
  libraryCollection?: MiniPickerCollectionItem;
  visibleCollectionIds?: CollectionId[];
}) {
  const [path, setPath] = useState<MiniPickerFolderItem[]>([]);
  const [isLoadingPath, setIsLoadingPath] = useState(false);
  const dispatch = useDispatch();

  useDeepCompareEffect(() => {
    if (!opened || !value) {
      return;
    }
    setIsLoadingPath(true);

    getPathFromValue(
      value,
      dispatch,
      libraryCollection,
      visibleCollectionIds,
    ).then((newPath) => {
      setPath(newPath);
      setIsLoadingPath(false);
    });
  }, [value, opened, dispatch, libraryCollection, visibleCollectionIds]);

  return [path, setPath, { isLoadingPath }] as const;
}

async function getPathFromValue(
  value: DataPickerValue,
  dispatch: DispatchFn,
  libraryCollection?: MiniPickerCollectionItem,
  visibleCollectionIds?: CollectionId[],
): Promise<MiniPickerFolderItem[]> {
  if (value.model !== "table") {
    return getCollectionPathFromValue(
      value,
      dispatch,
      libraryCollection,
      visibleCollectionIds,
    );
  }

  const table = await dispatch(
    tableApi.endpoints.getTable.initiate({ id: value.id }),
  ).unwrap();
  return table.collection == null
    ? getTablePathFromValue(value, dispatch)
    : getCollectionPathFromValue(value, dispatch, libraryCollection);
}

async function getTablePathFromValue(
  value: TablePickerValue,
  dispatch: DispatchFn,
): Promise<MiniPickerFolderItem[]> {
  // get the list endpoints instead of the single table endpoint
  // so that they'll be in the cache when we navigate
  const dbReq = dispatch(
    databaseApi.endpoints.listDatabases.initiate(),
  ).unwrap();

  const schemaReq = dispatch(
    databaseApi.endpoints.listDatabaseSchemas.initiate({ id: value.db_id }),
  ).unwrap();

  const [dbs, schemas] = await Promise.all([dbReq, schemaReq]);
  const db = dbs.data.find((db) => db.id === value.db_id);
  const schema: SchemaName | undefined =
    schemas?.length > 1
      ? schemas.find((sch) => sch === value.schema)
      : undefined;
  return [
    ...(db ? [{ id: db.id, name: db.name, model: "database" as const }] : []),
    ...(db && schema
      ? [{ id: schema, name: schema, model: "schema" as const, dbId: db.id }]
      : []),
  ];
}

async function getCollectionPathFromValue(
  value: DataPickerValue,
  dispatch: DispatchFn,
  libraryCollection?: MiniPickerCollectionItem,
  visibleCollectionIds?: CollectionId[],
): Promise<MiniPickerFolderItem[]> {
  const table =
    value.model === "table"
      ? await dispatch(
          tableApi.endpoints.getTable.initiate({ id: value.id }),
        ).unwrap()
      : null;
  const card =
    value.model !== "table"
      ? await dispatch(
          cardApi.endpoints.getCard.initiate({ id: value.id }),
        ).unwrap()
      : null;

  const collection = table?.collection ?? card?.collection;

  const location = collection?.effective_location ?? collection?.location;

  if (!location) {
    return [getOurAnalytics()];
  }

  const locationPath = [getOurAnalytics()];

  const collectionIds = [
    "root",
    ...(location?.split("/") ?? []).map((id) => parseInt(id, 10)),
    collection?.id,
  ].filter(Boolean);

  if (collectionIds.includes(libraryCollection?.id)) {
    collectionIds.shift(); // pretend the library is at the top level
    locationPath.shift();
  }

  for (let i = 0; i < collectionIds.length; i++) {
    const collectionId = collectionIds[i];

    if (!collectionId) {
      break;
    }

    const collectionItems = await dispatch(
      collectionApi.endpoints.listCollectionItems.initiate({
        id: collectionId,
      }),
    ).unwrap();

    if (!collectionItems?.data) {
      break;
    }

    const nextItem = collectionItems.data.find(
      (item) => item.model === "collection" && item.id === collectionIds[i + 1],
    );

    if (!nextItem) {
      break;
    }

    locationPath.push({
      id: nextItem.id,
      name: nextItem.name,
      model: "collection",
      here: nextItem.here,
      below: nextItem.below,
    });
  }

  return filterPathByVisibleCollections(locationPath, visibleCollectionIds);
}

// not a factory
export function getFolderAndHiddenFunctions(
  models: MiniPickerPickableItem["model"][],
  shouldHide?: (item: MiniPickerItem | unknown) => boolean,
  visibleCollectionIds?: CollectionId[],
  requestedCollectionIds?: CollectionId[],
) {
  const modelSet = new Set(models);
  const visibleCollectionIdSet = new Set(visibleCollectionIds ?? []);
  const requestedCollectionIdSet = new Set(
    requestedCollectionIds ?? visibleCollectionIds ?? [],
  );

  const isCollectionVisible = (item: MiniPickerItem | unknown) => {
    if (!visibleCollectionIds?.length) {
      return true;
    }

    if (!item || typeof item !== "object") {
      return false;
    }

    const collectionId = getCollectionId(item);

    if (collectionId == null) {
      return false;
    }

    if (
      "model" in item &&
      item.model === MiniPickerFolderModel.Collection &&
      visibleCollectionIdSet.has(collectionId)
    ) {
      return true;
    }

    return requestedCollectionIdSet.has(collectionId);
  };
  const isFolder = (
    item: MiniPickerItem | unknown,
  ): item is MiniPickerFolderItem => {
    if (!item || typeof item !== "object" || !("model" in item)) {
      return false;
    }

    if (
      item.model === MiniPickerFolderModel.Database ||
      item.model === MiniPickerFolderModel.Schema
    ) {
      return true;
    }

    if (item.model !== MiniPickerFolderModel.Collection) {
      return false;
    }

    if (!("here" in item) && !("below" in item)) {
      return false;
    }

    if (!isCollectionVisible(item)) {
      return false;
    }

    const hereBelowSet = Array.from(
      new Set([
        ...("here" in item && Array.isArray(item.here) ? item.here : []),
        ...("below" in item && Array.isArray(item.below) ? item.below : []),
      ]),
    );
    return (
      item.model === "collection" &&
      hereBelowSet.some((hereBelowModel) => modelSet.has(hereBelowModel))
    );
  };

  const isHidden = (item: MiniPickerItem | unknown): item is unknown => {
    if (!item || typeof item !== "object" || !("model" in item)) {
      return true;
    }

    if (shouldHide && shouldHide(item)) {
      return true;
    }

    if (!isCollectionVisible(item)) {
      return true;
    }

    return (
      !modelSet.has(item.model as MiniPickerPickableItem["model"]) &&
      !isFolder(item)
    );
  };
  return { isFolder, isHidden };
}

export function useVisibleCollections(
  collectionIds: CollectionId[] | undefined,
  models: MiniPickerPickableItem["model"][],
) {
  const dispatch = useDispatch();
  const [collections, setCollections] = useState<MiniPickerCollectionItem[]>(
    [],
  );
  const [resolvedVisibleCollectionIds, setResolvedVisibleCollectionIds] =
    useState<CollectionId[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const uniqueCollectionIds = useMemo(
    () => Array.from(new Set(collectionIds ?? [])),
    [collectionIds],
  );

  useDeepCompareEffect(() => {
    let isCancelled = false;

    if (!uniqueCollectionIds.length) {
      setCollections([]);
      setResolvedVisibleCollectionIds([]);
      setIsLoading(false);
      return;
    }

    const fetchCollectionsByIds = async (ids: CollectionId[]) => {
      const subscriptions = ids.map((id) =>
        dispatch(
          collectionApi.endpoints.getCollection.initiate(
            { id, ignore_error: true },
            { subscribe: false },
          ),
        ),
      );

      const responses = await Promise.all(
        subscriptions.map((subscription) => subscription.unwrap().catch(() => null)),
      );

      subscriptions.forEach((subscription) => {
        subscription?.unsubscribe?.();
      });

      return responses.filter(
        (collection): collection is Collection => Boolean(collection),
      );
    };

    const collectAncestors = (collection: Collection) => {
      const location = collection.effective_location ?? collection.location;
      const locationIds = (location ?? "")
        .split("/")
        .map((part) => normalizeCollectionId(part))
        .filter(Boolean) as CollectionId[];
      const ancestorIds =
        collection.effective_ancestors?.map((ancestor) => ancestor.id) ?? [];

      const combinedIds = new Set<CollectionId>([
        "root",
        ...locationIds,
        ...ancestorIds,
      ]);

      combinedIds.delete(collection.id as CollectionId);

      return Array.from(combinedIds).filter(
        (id): id is CollectionId => Boolean(id),
      );
    };

    setIsLoading(true);

    (async () => {
      const primaryCollections = await fetchCollectionsByIds(
        uniqueCollectionIds,
      );

      const ancestorIds = Array.from(
        new Set(
          primaryCollections.flatMap((collection) => collectAncestors(collection)),
        ),
      );

      const missingAncestorIds = ancestorIds.filter(
        (id) => !uniqueCollectionIds.includes(id),
      );

      const ancestorCollections = missingAncestorIds.length
        ? await fetchCollectionsByIds(missingAncestorIds)
        : [];

      if (isCancelled) {
        return;
      }

      const allCollections = [...primaryCollections, ...ancestorCollections];
      const resolvedIds = Array.from(
        new Set([
          ...uniqueCollectionIds,
          ...ancestorIds,
          ...allCollections.map((collection) => collection.id as CollectionId),
        ]),
      );

      setCollections(
        allCollections.map((collection) => ({
          id: collection.id,
          name: collection.name,
          model: "collection",
          here: collection.here ?? models,
          below: collection.below,
          type: collection.type as CollectionType,
        })),
      );
      setResolvedVisibleCollectionIds(resolvedIds);
      setIsLoading(false);
    })();

    return () => {
      isCancelled = true;
    };
  }, [dispatch, models, uniqueCollectionIds]);

  return { collections, resolvedVisibleCollectionIds, isLoading };
}

const getCollectionId = (
  item: MiniPickerItem | unknown,
): CollectionId | null => {
  if (!item || typeof item !== "object" || !("model" in item)) {
    return null;
  }

  if ((item as { model: string }).model === MiniPickerFolderModel.Collection) {
    return (item as MiniPickerItem).id as CollectionId;
  }

  return (
    (item as { collection_id?: CollectionId })?.collection_id ??
    (item as { collection?: { id?: CollectionId } })?.collection?.id ??
    null
  );
};

const filterPathByVisibleCollections = (
  path: MiniPickerFolderItem[],
  visibleCollectionIds?: CollectionId[],
) => {
  if (!visibleCollectionIds?.length) {
    return path;
  }

  const allowedCollectionIds = new Set(visibleCollectionIds ?? []);
  const hasAnyCollection = path.some(
    (item) => item.model === MiniPickerFolderModel.Collection,
  );

  if (!hasAnyCollection) {
    return path;
  }

  const filteredPath = path.filter(
    (item) =>
      item.model !== MiniPickerFolderModel.Collection ||
      allowedCollectionIds.has(item.id),
  );

  const hasAllowedCollection = filteredPath.some(
    (item) =>
      item.model === MiniPickerFolderModel.Collection &&
      allowedCollectionIds.has(item.id),
  );

  return hasAllowedCollection ? filteredPath : [];
};

const normalizeCollectionId = (
  value: string | number | null | undefined,
): CollectionId | null => {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return value as CollectionId;
  }

  const numericValue = Number(value);

  if (!Number.isNaN(numericValue)) {
    return numericValue as CollectionId;
  }

  return value as CollectionId;
};

export const focusFirstMiniPickerItem = () => {
  // any time the path changes, focus the first item
  setTimeout(() => {
    // dirty, but let's wait for a render
    const firstItem = document.querySelector(
      '[data-testid="mini-picker"] [role="menuitem"]',
    );
    if (firstItem) {
      (firstItem as HTMLElement)?.focus?.();
    }
  }, 10);
};
