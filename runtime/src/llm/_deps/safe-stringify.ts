/**
 * Local _deps stub for the gut/AgenC crossing of
 * `../../tools/types.js` for `safeStringify`. Bigint-safe JSON
 * serialization helper.
 */

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function safeStringify(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}
