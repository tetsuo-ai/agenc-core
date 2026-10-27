/**
 * Type-to-search for the model picker: which models match what a person
 * typed, best matches first. Matching ignores case and reads the ids a model
 * answers to, each id without its vendor prefix (`gemma-4-31b-it:free` in
 * `google/gemma-4-31b-it:free`), and the catalog label ("Google: Gemma 4 31B").
 *
 * Matches come in four groups: exact, prefix, substring, then the typed
 * letters in order with gaps (`gpt5mini` finds `openai/gpt-5-mini`). Within a
 * group the list keeps its own order.
 *
 * @module
 */

export type ModelSearchFields = {
  /** The ids the model answers to: the one the picker shows, then the catalog id. */
  readonly ids: readonly string[];
  /** The catalog's name for the model, when it has one. */
  readonly label?: string;
};

const EXACT = 0;
const PREFIX = 1;
const SUBSTRING = 2;
const FUZZY = 3;

/** The id without its vendor prefix: the text after the last "/". */
function withoutVendor(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

/** Every character of `needle` appears in `haystack`, in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  let found = 0;
  for (const char of haystack) {
    if (char === needle[found]) found += 1;
    if (found === needle.length) return true;
  }
  return found === needle.length;
}

/** Which group a model falls in for a lowercase query, or undefined for no match. */
function matchGroup(fields: ModelSearchFields, needle: string): number | undefined {
  const ids = fields.ids.map((id) => id.toLowerCase());
  const label = fields.label?.toLowerCase();
  const whole = [...ids, ...(label === undefined ? [] : [label])];
  const names = [...whole, ...ids.map(withoutVendor)];
  if (names.some((name) => name === needle)) return EXACT;
  if (names.some((name) => name.startsWith(needle))) return PREFIX;
  if (names.some((name) => name.includes(needle))) return SUBSTRING;
  // Spaces carry no meaning between the letters of a fuzzy match.
  const letters = needle.replace(/\s+/gu, "");
  if (letters.length > 0 && whole.some((name) => isSubsequence(letters, name))) return FUZZY;
  return undefined;
}

/**
 * The items that match `query`, best group first, each group in list order.
 * An empty query returns the list as it is.
 */
export function searchModels<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => ModelSearchFields,
): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return items;
  const groups: T[][] = [[], [], [], []];
  for (const item of items) {
    const group = matchGroup(fields(item), needle);
    if (group !== undefined) groups[group]!.push(item);
  }
  return groups.flat();
}
