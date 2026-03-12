import { useEffect, useState } from "react";
import { useLocation } from "react-use";

import api from "metabase/lib/api";

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

/**
 * Detects the current Metabase page context from the URL and returns
 * an AgentContextValue pre-populated from that entity.
 *
 * Reacts to SPA navigation (pushState / popstate) via react-use's useLocation.
 * Returns null when on an unrecognised page.
 */
/** Parses the current query string into a plain object, or returns undefined if empty. */
function parseSearchParams(search: string): Record<string, string> | undefined {
  const params = new URLSearchParams(search);
  const result: Record<string, string> = {};
  params.forEach((value, key) => {
    result[key] = value;
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

export function usePageContext(): AgentContextValue | null {
  const location = useLocation();
  const [context, setContext] = useState<AgentContextValue | null>(null);

  useEffect(() => {
    const path = location.pathname ?? window.location.pathname;
    const urlParams = parseSearchParams(location.search ?? window.location.search);

    // Clear context immediately when navigating away from a known entity page
    setContext(null);

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
        break;
      }
    }
  }, [location.pathname, location.search]);

  return context;
}
