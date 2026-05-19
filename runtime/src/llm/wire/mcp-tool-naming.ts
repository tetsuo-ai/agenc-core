/**
 * Bijective MCP tool-name transformation for the strict-regex providers.
 *
 * AgenC's internal tool registry namespaces MCP tools as
 * `mcp.<server>.<tool>` (see `mcp-client/tools.ts:401`). That format is
 * the canonical key used by the dispatcher, the registry, the rollout
 * format, and every command surface that names tools.
 *
 * On the wire, every major provider enforces a strict
 * `^[a-zA-Z0-9_-]{1,64}$` regex on `function.name` (and the response
 * shape echoes the same name back in `tool_calls[].function.name`).
 * Sending `mcp.<server>.<tool>` produces a 400 error from these
 * providers because of the dots.
 *
 * This module performs a bijective encoding so the runtime keeps the
 * dotted form everywhere internally, but the wire layer ships the
 * encoded form to the provider and decodes the model's tool-call
 * responses back to the dotted form before dispatch. The encoded form
 * is `mcp__<server>__<tool>` — `__` is a sentinel separator that MCP
 * server-name conventions (lowercase, single underscores, hyphens) do
 * not produce.
 *
 * Decoding uses `indexOf("__")` rather than `split("__")` so a tool
 * name that itself contains `__` survives the round trip intact:
 * `mcp.memory.do__stuff` → `mcp__memory__do__stuff` →
 * `mcp.memory.do__stuff`. Server names containing `__` are not
 * supported (none observed in practice; an MCP server choosing such a
 * name would have its tools mis-routed).
 */

const INTERNAL_PREFIX = "mcp.";
const WIRE_PREFIX = "mcp__";
const SEP = "__";

/**
 * Convert an internal tool name to the strict-regex wire form.
 *
 * - `mcp.memory.search_nodes` → `mcp__memory__search_nodes`
 * - `mcp.context7.resolve-library-id` → `mcp__context7__resolve-library-id`
 * - `FileEdit` → `FileEdit` (non-MCP, pass-through)
 * - `mcp.server` (no tool segment) → unchanged (treated as pass-through;
 *   this would be malformed and provider-side validation will surface it)
 */
export function encodeMcpToolNameForWire(name: string): string {
  if (!name.startsWith(INTERNAL_PREFIX)) return name;
  const afterPrefix = name.slice(INTERNAL_PREFIX.length);
  const dotIndex = afterPrefix.indexOf(".");
  if (dotIndex === -1) return name;
  const server = afterPrefix.slice(0, dotIndex);
  const tool = afterPrefix.slice(dotIndex + 1);
  // Server names containing `__` would create a decode ambiguity.
  // Pass through unchanged in that case so the malformed name reaches
  // provider-side validation rather than corrupting silently.
  if (server.includes(SEP)) return name;
  return `${WIRE_PREFIX}${server}${SEP}${tool}`;
}

/**
 * Inverse of {@link encodeMcpToolNameForWire}. Returns the original
 * input when it doesn't match the encoded MCP shape, so a non-MCP
 * tool name (e.g. `FileEdit`) round-trips unchanged.
 */
export function decodeMcpToolNameFromWire(name: string): string {
  if (!name.startsWith(WIRE_PREFIX)) return name;
  const afterPrefix = name.slice(WIRE_PREFIX.length);
  const sepIndex = afterPrefix.indexOf(SEP);
  if (sepIndex === -1) return name;
  const server = afterPrefix.slice(0, sepIndex);
  const tool = afterPrefix.slice(sepIndex + SEP.length);
  return `${INTERNAL_PREFIX}${server}.${tool}`;
}
