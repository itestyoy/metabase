import { useEffect, useState } from "react";
import { useLocation } from "react-use";

import api from "metabase/lib/api";
import { b64hash_to_utf8 } from "metabase/lib/encoding";

import type { AgentContextValue } from "../AgentContextPicker";

/** Maps URL patterns to entity API paths. */
const ROUTES: Array<{ pattern: RegExp; model: string; apiPath: string }> = [
  { pattern: /^\/question\/(\d+)/, model: "card", apiPath: "/api/card" },
  { pattern: /^\/dashboard\/(\d+)/, model: "dashboard", apiPath: "/api/dashboard" },
  { pattern: /^\/collection\/(\d+)/, model: "collection", apiPath: "/api/collection" },
  // Slugs like "/model/123-some-name" — leading digits are the numeric ID
  { pattern: /^\/model\/(\d+)/, model: "dataset", apiPath: "/api/card" },
  { pattern: /^\/metric\/(\d+)/, model: "metric", apiPath: "/api/card" },
];

/** Parses the current query string into a plain object, or returns undefined if empty. */
function parseSearchParams(search: string): Record<string, string> | undefined {
  const params = new URLSearchParams(search);
  const result: Record<string, string> = {};
  params.forEach((value, key) => {
    result[key] = value;
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Tries to decode an ad-hoc question from the URL hash (base64url-encoded JSON card).
 * Returns null if the hash is absent or cannot be decoded.
 */
interface AdHocCard {
  name?: string;
  database?: number;
  sourceTable?: number;
  type?: string;
  dataset_query?: Record<string, unknown>;
}

function tryDecodeAdHocCard(hash: string): AdHocCard | null {
  if (!hash || hash === "#") {
    return null;
  }
  try {
    const json = b64hash_to_utf8(hash);
    const card = JSON.parse(json);
    return {
      name: card.name ?? undefined,
      database: card.dataset_query?.database ?? undefined,
      sourceTable: card.dataset_query?.query?.["source-table"] ?? undefined,
      type: card.type ?? undefined,
      dataset_query: card.dataset_query ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Detects the current Metabase page context from the URL and returns
 * an AgentContextValue pre-populated from that entity.
 *
 * Supports:
 * - Saved entities: /question/123, /dashboard/42, /collection/5, /model/7, /metric/3
 * - Ad-hoc (unsaved) questions: /question#eyJuYW1lIjoi... (base64url-encoded card JSON)
 *
 * Reacts to SPA navigation (pushState / popstate) via react-use's useLocation.
 * Returns null when on an unrecognised page.
 */
export function usePageContext(): AgentContextValue | null {
  const location = useLocation();
  const [context, setContext] = useState<AgentContextValue | null>(null);

  useEffect(() => {
    const path = location.pathname ?? window.location.pathname;
    const hash = location.hash ?? window.location.hash;
    const urlParams = parseSearchParams(location.search ?? window.location.search);

    // Clear context immediately when navigating away from a known entity page
    setContext(null);

    // ── Saved entities (with numeric ID in the path) ─────────────────────
    for (const { pattern, model, apiPath } of ROUTES) {
      const match = path.match(pattern);
      if (match) {
        const id = parseInt(match[1], 10);
        api
          .GET(`${apiPath}/${id}`)({})
          .then((data: unknown) => {
            const d = data as { name?: string };
            if (d?.name) {
              setContext({ id, model, name: d.name, url_params: urlParams });
            }
          })
          .catch(() => {
            // If entity fetch fails, don't pre-populate
          });
        return;
      }
    }

    // ── Ad-hoc (unsaved) questions: /question#<base64url card> ───────────
    if (/^\/question\/?$/.test(path) && hash) {
      const card = tryDecodeAdHocCard(hash);
      if (!card) {
        return;
      }

      const model = card.type === "model" ? "dataset" : card.type === "metric" ? "metric" : "card";

      const baseContext = {
        model,
        db_id: card.database,
        url_params: urlParams,
        dataset_query: card.dataset_query,
      };

      // If a source table is available, fetch its display name for a richer context label.
      if (typeof card.sourceTable === "number") {
        api
          .GET(`/api/table/${card.sourceTable}`)({})
          .then((data: unknown) => {
            const d = data as { display_name?: string; name?: string };
            const tableName = d?.display_name ?? d?.name;
            const name = card.name
              ? card.name
              : tableName
                ? `Ad-hoc query on ${tableName}`
                : "Ad-hoc question";
            setContext({
              ...baseContext,
              id: card.sourceTable as number,
              name,
            });
          })
          .catch(() => {
            setContext({
              ...baseContext,
              id: 0,
              name: card.name || "Ad-hoc question",
            });
          });
      } else {
        // Native query or no source table — use the card name or a fallback
        setContext({
          ...baseContext,
          id: 0,
          name: card.name || "Ad-hoc question",
        });
      }
    }
  }, [location.pathname, location.search, location.hash]);

  return context;
}
