import { t } from "ttag";

import type { SearchFilterToggle } from "metabase/search/types";

export const PersonalCollectionsFilter: SearchFilterToggle = {
  label: () => t`Search personal collections`,
  type: "toggle",
  fromUrl: (value) => (value === "true" ? "all" : undefined),
  toUrl: (value: boolean) => (value ? "all" : null),
};
