/**
 * MCP tool-name transformation for strict-regex providers.
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
 * This module performs a reversible encoding for names that fit the limit and
 * a collision-resistant request-scoped alias for longer names. The runtime
 * keeps the dotted form everywhere internally, while the wire layer ships an
 * encoded form and resolves the model's echoed tool calls against the exact
 * advertised catalog before dispatch. The common short encoded form is
 * `mcp__<server>__<tool>`; for server IDs such as plugin IDs that need
 * escaping, the module uses `mcp2__<escaped-server>__<escaped-tool>`. Encoded
 * names that would exceed 64 characters use `toolh__<sha256-base64url>`.
 */

import { createHash } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";

const INTERNAL_PREFIX = "mcp.";
const WIRE_PREFIX = "mcp__";
const ESCAPED_WIRE_PREFIX = "mcp2__";
const GENERIC_ESCAPED_WIRE_PREFIX = "tool2__";
const HASHED_WIRE_PREFIX = "toolh__";
const SEP = "__";
const PROVIDER_FUNCTION_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const WIRE_SAFE_SEGMENT_BYTE_PATTERN = /^[a-zA-Z0-9-]$/;
const HASHED_WIRE_NAME_PATTERN = /^toolh__[a-zA-Z0-9_-]{43}$/;

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

function hashedProviderToolName(name: string): string {
  // A complete SHA-256 digest encoded as unpadded base64url is 43 characters;
  // with the reserved prefix this is 50 characters and remains inside Qwen's
  // 64-character function-name limit. The full digest is retained rather than
  // truncating a readable prefix so two long plugin names that share all of
  // their human-readable prefix still receive independent aliases.
  return `${HASHED_WIRE_PREFIX}${createHash("sha256")
    .update(name, "utf8")
    .digest("base64url")}`;
}

function isHashedProviderToolName(name: string): boolean {
  return HASHED_WIRE_NAME_PATTERN.test(name);
}

/**
 * Build the request-scoped reverse lookup used for hashed aliases.
 *
 * Short names remain self-describing and decode without this table. A name
 * whose reversible escaped form would exceed 64 characters cannot carry its
 * original bytes on the wire, so response parsing must resolve it against the
 * exact catalog advertised on that request. Any alias collision is rejected
 * before the request is sent; dispatch is never allowed to guess.
 */
export function createProviderToolNameWireLookup(
  canonicalNames: readonly string[],
): ReadonlyMap<string, string> {
  const lookup = new Map<string, string>();
  for (const canonicalName of canonicalNames) {
    const wireName = encodeMcpToolNameForWire(canonicalName);
    if (!isProviderToolNameSafe(wireName)) {
      throw new Error(
        `Tool name ${JSON.stringify(canonicalName)} cannot be represented by the provider function-name contract`,
      );
    }
    const existing = lookup.get(wireName);
    if (existing !== undefined && existing !== canonicalName) {
      throw new Error(
        `Provider tool-name collision: ${JSON.stringify(existing)} and ${JSON.stringify(canonicalName)} both map to ${JSON.stringify(wireName)}`,
      );
    }
    lookup.set(wireName, canonicalName);
  }
  return lookup;
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
    return isProviderToolNameSafe(escaped)
      ? escaped
      : hashedProviderToolName(name);
  }

  if (!parts.server.includes(SEP)) {
    const legacyWireName = `${WIRE_PREFIX}${parts.server}${SEP}${parts.tool}`;
    if (isProviderToolNameSafe(legacyWireName)) return legacyWireName;
  }

  const escaped = `${ESCAPED_WIRE_PREFIX}${encodeMcpNameSegment(parts.server)}${SEP}${encodeMcpNameSegment(parts.tool)}`;
  return isProviderToolNameSafe(escaped)
    ? escaped
    : hashedProviderToolName(name);
}

/**
 * Inverse of {@link encodeMcpToolNameForWire}. Hashed aliases require the
 * request's advertised canonical names; self-describing encodings and
 * non-MCP names (for example `FileEdit`) continue to decode directly.
 */
export function decodeMcpToolNameFromWire(
  name: string,
  advertisedCanonicalNames?: readonly string[],
): string {
  if (isHashedProviderToolName(name)) {
    if (advertisedCanonicalNames === undefined) {
      throw new Error(
        `Hashed provider tool name ${JSON.stringify(name)} cannot be decoded without the request tool catalog`,
      );
    }
    const canonicalName = createProviderToolNameWireLookup(
      advertisedCanonicalNames,
    ).get(name);
    if (canonicalName === undefined) {
      throw new Error(
        `Provider returned unknown hashed tool name ${JSON.stringify(name)}`,
      );
    }
    return canonicalName;
  }

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
