import { useEffect, useState } from "react";

import api from "metabase/lib/api";

/**
 * Returns whether the current user has access to the AI Agent feature,
 * i.e. they are a superuser or belong to the "AI" permissions group.
 *
 * Calls /api/ai-agent/settings — a 403 response means no access.
 */
export function useAgentAccess(): { hasAccess: boolean; isLoading: boolean } {
  const [hasAccess, setHasAccess] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    api
      .GET("/api/ai-agent/settings")({})
      .then((data: unknown) => {
        const s = data as { access?: boolean };
        setHasAccess(s?.access ?? false);
      })
      .catch(() => {
        setHasAccess(false);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  return { hasAccess, isLoading };
}
