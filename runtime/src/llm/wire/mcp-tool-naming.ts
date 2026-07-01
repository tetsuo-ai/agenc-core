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
 * dotted form everywhere internally, but the wire layer ships an encoded
 * form to the provider and decodes the model's tool-call responses back
 * to the dotted form before dispatch. The common short encoded form is
 * `mcp__<server>__<tool>`; for server IDs such as plugin IDs that need
 * escaping, the module falls back to `mcp2__<escaped-server>__<escaped-tool>`.
 */

import { TextDecoder, TextEncoder } from "node:util";

const INTERNAL_PREFIX = "mcp.";
const WIRE_PREFIX = "mcp__";
const ESCAPED_WIRE_PREFIX = "mcp2__";
const GENERIC_ESCAPED_WIRE_PREFIX = "tool2__";
const SEP = "__";
const PROVIDER_FUNCTION_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const WIRE_SAFE_SEGMENT_BYTE_PATTERN = /^[a-zA-Z0-9-]$/;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function isProviderToolNameSafe(name: string): boolean {
  return PROVIDER_FUNCTION_NAME_PATTERN.test(name);
}

function splitInternalMcpToolName(
  name: string,
): { readonly server: string; readonly tool: string } | null {
  if (!name.startsWith(INTERNAL_PREFIX)) return null;
  const afterPrefix = name.slice(INTERNAL_PREFIX.length);
  const dotIndex = afterPrefix.indexOf(".");
  if (dotIndex === -1) return null;
  return {
    server: afterPrefix.slice(0, dotIndex),
    tool: afterPrefix.slice(dotIndex + 1),
  };
}

function encodeMcpNameSegment(segment: string): string {
  let encoded = "";
  for (const byte of textEncoder.encode(segment)) {
    const char = String.fromCharCode(byte);
    if (WIRE_SAFE_SEGMENT_BYTE_PATTERN.test(char)) {
      encoded += char;
    } else if (char === "_") {
      encoded += "_u";
    } else {
      encoded += `_x${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return encoded;
}

function decodeMcpNameSegment(segment: string): string | null {
  const bytes: number[] = [];
  for (let index = 0; index < segment.length;) {
    const char = segment[index]!;
    if (char !== "_") {
      bytes.push(char.charCodeAt(0));
      index += 1;
      continue;
    }

    const escapeKind = segment[index + 1];
    if (escapeKind === "u") {
      bytes.push("_".charCodeAt(0));
      index += 2;
      continue;
    }
    if (escapeKind === "x") {
      const hex = segment.slice(index + 2, index + 4);
      if (!/^[0-9a-f]{2}$/i.test(hex)) return null;
      bytes.push(Number.parseInt(hex, 16));
      index += 4;
      continue;
    }

    return null;
  }

  try {
    return textDecoder.decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

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
  const parts = splitInternalMcpToolName(name);
  if (!parts) {
    if (name.length === 0 || name.startsWith(INTERNAL_PREFIX)) return name;
    if (isProviderToolNameSafe(name)) return name;
    const escaped = `${GENERIC_ESCAPED_WIRE_PREFIX}${encodeMcpNameSegment(name)}`;
    return isProviderToolNameSafe(escaped) ? escaped : name;
  }

  if (!parts.server.includes(SEP)) {
    const legacyWireName = `${WIRE_PREFIX}${parts.server}${SEP}${parts.tool}`;
    if (isProviderToolNameSafe(legacyWireName)) return legacyWireName;
  }

  return `${ESCAPED_WIRE_PREFIX}${encodeMcpNameSegment(parts.server)}${SEP}${encodeMcpNameSegment(parts.tool)}`;
}

/**
 * Inverse of {@link encodeMcpToolNameForWire}. Returns the original
 * input when it doesn't match the encoded MCP shape, so a non-MCP
 * tool name (e.g. `FileEdit`) round-trips unchanged.
 */
export function decodeMcpToolNameFromWire(name: string): string {
  if (name.startsWith(GENERIC_ESCAPED_WIRE_PREFIX)) {
    const decoded = decodeMcpNameSegment(
      name.slice(GENERIC_ESCAPED_WIRE_PREFIX.length),
    );
    return decoded ?? name;
  }

  if (name.startsWith(ESCAPED_WIRE_PREFIX)) {
    const afterPrefix = name.slice(ESCAPED_WIRE_PREFIX.length);
    const sepIndex = afterPrefix.indexOf(SEP);
    if (sepIndex === -1) return name;
    const server = decodeMcpNameSegment(afterPrefix.slice(0, sepIndex));
    const tool = decodeMcpNameSegment(
      afterPrefix.slice(sepIndex + SEP.length),
    );
    if (server === null || tool === null) return name;
    return `${INTERNAL_PREFIX}${server}.${tool}`;
  }

  if (!name.startsWith(WIRE_PREFIX)) return name;
  const afterPrefix = name.slice(WIRE_PREFIX.length);
  const sepIndex = afterPrefix.indexOf(SEP);
  if (sepIndex === -1) return name;
  const server = afterPrefix.slice(0, sepIndex);
  const tool = afterPrefix.slice(sepIndex + SEP.length);
  return `${INTERNAL_PREFIX}${server}.${tool}`;
}
