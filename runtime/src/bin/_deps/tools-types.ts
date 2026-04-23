/**
 * Per-dir tool-shape surface for `runtime/src/bin/**`.
 *
 * The CLI delegate-tool wrapper needs a duck-typed `Tool` / `ToolResult`
 * shape and the bigint-safe stringify helper. Carved as a local
 * `_deps/` to cut the gut→openclaude crossing.
 */

export type JSONSchema = Record<string, unknown>;

export interface ToolResult {
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

// Permissive Tool shape — extra fields the parent registry attaches
// flow through `Record<string, any>`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
} & Record<string, any>;

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function safeStringify(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}
