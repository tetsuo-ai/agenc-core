/**
 * Pure sort comparator for slash-typeahead suggestion ranking.
 *
 * Extracted from commandSuggestions.ts so it can be unit-tested in
 * isolation — the source module's transitive import chain pulls in
 * the full ink/tools tree which makes vitest setup brittle. Both
 * call sites import from here.
 *
 * Priority order (highest to lowest):
 *   1. Exact name match
 *   2. Exact alias match
 *   3. Prefix name match (shorter name wins among prefix matches)
 *   4. Prefix alias match (shorter alias wins)
 *   5. Fuse score (lower is better; difference must exceed 0.1)
 *   6. Usage score (higher is better, prompt-type only)
 */

export interface RankableMeta {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly usage: number;
  readonly score?: number;
}

export function hasNameOrAliasPrefixMatch(
  item: Pick<RankableMeta, "name" | "aliases">,
  query: string,
): boolean {
  if (query === "") return true;
  return (
    item.name.startsWith(query) ||
    item.aliases.some((alias) => alias.startsWith(query))
  );
}

export function compareSuggestionsByPriority(
  a: RankableMeta,
  b: RankableMeta,
  query: string,
): number {
  const aName = a.name;
  const bName = b.name;
  const aAliases = a.aliases;
  const bAliases = b.aliases;

  const aExactName = aName === query;
  const bExactName = bName === query;
  if (aExactName && !bExactName) return -1;
  if (bExactName && !aExactName) return 1;

  const aExactAlias = aAliases.some((alias) => alias === query);
  const bExactAlias = bAliases.some((alias) => alias === query);
  if (aExactAlias && !bExactAlias) return -1;
  if (bExactAlias && !aExactAlias) return 1;

  const aPrefixName = aName.startsWith(query);
  const bPrefixName = bName.startsWith(query);
  if (aPrefixName && !bPrefixName) return -1;
  if (bPrefixName && !aPrefixName) return 1;
  if (aPrefixName && bPrefixName && aName.length !== bName.length) {
    return aName.length - bName.length;
  }

  const aPrefixAlias = aAliases.find((alias) => alias.startsWith(query));
  const bPrefixAlias = bAliases.find((alias) => alias.startsWith(query));
  if (aPrefixAlias && !bPrefixAlias) return -1;
  if (bPrefixAlias && !aPrefixAlias) return 1;
  if (
    aPrefixAlias &&
    bPrefixAlias &&
    aPrefixAlias.length !== bPrefixAlias.length
  ) {
    return aPrefixAlias.length - bPrefixAlias.length;
  }

  const scoreDiff = (a.score ?? 0) - (b.score ?? 0);
  if (Math.abs(scoreDiff) > 0.1) {
    return scoreDiff;
  }
  return b.usage - a.usage;
}
