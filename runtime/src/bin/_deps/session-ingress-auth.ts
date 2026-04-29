/**
 * Per-dir session-ingress auth shim for `runtime/src/bin/**`.
 *
 * Mirrors the AgenC implementation `runtime/src/utils/sessionIngressAuth.ts`
 * `getSessionIngressAuthHeaders` helper used during bootstrap when the
 * `SESSION_INGRESS_URL` env var is set. The lean rebuild does not own
 * an ingest auth surface; this shim returns an empty header bag so the
 * caller's "no auth → skip wiring" branch fires immediately.
 *
 * Carved as a local `_deps/` to cut the gut→AgenC crossing.
 */

export function getSessionIngressAuthHeaders(): Record<string, string> {
  return {};
}
