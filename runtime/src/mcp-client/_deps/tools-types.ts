/**
 * Per-dir tool-shape surface for `runtime/src/mcp-client/**`.
 *
 * The mcp-client modules only need duck-typed `Tool`, `ToolResult`, and
 * `JSONSchema` shapes when bridging MCP server tools into the registry.
 * Carved as a local `_deps/` to cut the gut→AgenC crossing without
 * pulling in the full AgenC `tools/types.ts` PolicyEngine surface.
 */

export type JSONSchema = Record<string, unknown>;

export interface ToolResult {
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

// Permissive Tool shape: only the fields mcp-client actually constructs
// are typed. Bridges may attach extra metadata fields that downstream
// consumers (tool-registry, etc.) understand; we treat the surface as
// `any`-extensible to avoid coupling to the full AgenC shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
} & Record<string, any>;
