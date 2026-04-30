// Cherry-picked from openclaude src/utils/slowOperations.ts.
// Only jsonStringify (with sort + stable formatting) is consumed here.

export function jsonStringify(value: unknown, indent: number = 2): string {
  return JSON.stringify(value, null, indent);
}

export function jsonParse<T = unknown>(value: string): T {
  return JSON.parse(value) as T;
}
