/**
 * Per-dir session-id retag helper for `runtime/src/bin/**`.
 *
 * Mirrors the openclaude-port `runtime/src/bridge/sessionIdCompat.ts`
 * `toInfraSessionId` helper used by the bootstrap path when building
 * the legacy code-session ingest URL. Carved as a local `_deps/` to
 * cut the gut→openclaude crossing.
 */

/**
 * Re-tag a `session_*` ID to `cse_*` for the legacy infra-layer URL.
 * No-op for IDs that don't carry the `session_` prefix.
 */
export function toInfraSessionId(id: string): string {
  if (!id.startsWith("session_")) return id;
  return "cse_" + id.slice("session_".length);
}
