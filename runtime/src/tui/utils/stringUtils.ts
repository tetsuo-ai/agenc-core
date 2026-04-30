// Cherry-picked from openclaude src/utils/stringUtils.ts.
// plural(n, singular, pluralForm?) — pluralizes a noun based on count.

export function plural(n: number, singular: string, pluralForm?: string): string {
  if (n === 1) return singular;
  return pluralForm ?? `${singular}s`;
}
