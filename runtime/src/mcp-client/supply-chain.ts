/**
 * MCP supply-chain verification.
 *
 * I-74: pin the exact MCP tool catalog a server is allowed to expose
 * by SHA-256 of its canonical JSON. If the server's advertised
 * catalog deviates from the pin, AgenC refuses to load the bridge.
 *
 * Canonicalization rules (must match across runs + platforms):
 *   1. Only `{name, description, inputSchema}` per tool are hashed —
 *      other upstream-added keys are ignored so a permissive server
 *      update that adds annotations cannot break the pin.
 *   2. Tools are sorted by `name` ascending.
 *   3. Fields within each tool entry are emitted in fixed key order:
 *      `name`, `description`, `inputSchema`.
 *   4. `inputSchema` is serialized with *sorted object keys* at every
 *      depth (recursive canonical JSON).
 *   5. Missing `description` / `inputSchema` are emitted as `null`.
 *
 * Hash is SHA-256 over the UTF-8 bytes of the canonical JSON.
 *
 * @module
 */

import { createHash } from "node:crypto";

/** Upper bound on raw tool catalog bytes before we refuse to even
 *  hash it (I-76 — protects against a hostile/huge server). */
export const MAX_CATALOG_JSON_BYTES = 5 * 1024 * 1024;

export interface MCPToolDescriptorLike {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface CatalogHashResult {
  readonly sha256: string;
  readonly canonicalJson: string;
  readonly bytes: number;
}

/**
 * Compute the canonical SHA-256 digest of an MCP tool catalog.
 *
 * Throws when the canonical payload exceeds `MAX_CATALOG_JSON_BYTES`.
 * Returns a hex-encoded digest + the canonical JSON used, so callers
 * can log both on mismatch.
 */
export function computeMCPToolCatalogSha256(
  tools: ReadonlyArray<MCPToolDescriptorLike>,
): CatalogHashResult {
  const canonical = toCanonicalCatalog(tools);
  const json = JSON.stringify(canonical);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_CATALOG_JSON_BYTES) {
    throw new Error(
      `MCP tool catalog canonical JSON (${bytes}B) exceeds I-76 cap ${MAX_CATALOG_JSON_BYTES}B`,
    );
  }
  const sha256 = createHash("sha256").update(json, "utf8").digest("hex");
  return { sha256, canonicalJson: json, bytes };
}

/**
 * Compare a computed digest to an expected pin. Case-insensitive
 * hex; whitespace trimmed.
 */
export function catalogDigestMatches(
  computed: string,
  expected: string | undefined,
): boolean {
  if (!expected) return true;
  return computed.trim().toLowerCase() === expected.trim().toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────
// Internal: canonical-JSON projection
// ─────────────────────────────────────────────────────────────────────

type Canonical =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Canonical>
  | { readonly [k: string]: Canonical };

function toCanonicalCatalog(
  tools: ReadonlyArray<MCPToolDescriptorLike>,
): ReadonlyArray<Canonical> {
  const sorted = [...tools].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return sorted.map((t) => canonicalizeObject({
    name: t.name,
    description: t.description ?? null,
    inputSchema: t.inputSchema === undefined ? null : t.inputSchema,
  }));
}

function canonicalize(value: unknown): Canonical {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) return null;
      return value;
    case "object":
      if (Array.isArray(value)) {
        return (value as unknown[]).map((v) => canonicalize(v));
      }
      return canonicalizeObject(value as Record<string, unknown>);
    default:
      return null;
  }
}

function canonicalizeObject(
  obj: Record<string, unknown>,
): { [k: string]: Canonical } {
  const keys = Object.keys(obj).sort();
  const result: { [k: string]: Canonical } = {};
  for (const k of keys) {
    result[k] = canonicalize(obj[k]);
  }
  return result;
}
