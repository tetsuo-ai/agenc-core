import type { Color } from "../ink/styles.js";
import { theme } from "../theme.js";
import type { ComposerHistorySearchState } from "./useComposerState.js";

export function buildHistorySearchStatusLine(
  search: ComposerHistorySearchState | null,
  keys: {
    readonly accept: string;
    readonly cancel: string;
  },
): { readonly color: Color; readonly text: string } | null {
  if (search === null) return null;

  let suffix = "";
  if (search.status === "match") {
    suffix = `  ${keys.accept} accept  ${keys.cancel} cancel`;
  } else if (search.status === "no-match") {
    suffix = "  no match";
  }

  return {
    color:
      search.status === "no-match"
        ? (theme.colors.warning as Color)
        : (theme.colors.primary as Color),
    text: `reverse-i-search: ${search.query}${suffix}`,
  };
}
