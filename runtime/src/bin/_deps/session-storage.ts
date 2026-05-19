/**
 * Per-dir session-storage glue for `runtime/src/bin/**`.
 *
 * Mirrors the AgenC implementation `runtime/src/utils/sessionStorage.ts`
 * surface the bootstrap path consumes:
 *   - `setRemoteIngressUrl(url)` — used by `registerStartupSessionIngress`
 *   - `setInternalEventReader(...)` / `setInternalEventWriter(...)` —
 *     used by the same path
 *
 * The remote-ingress setters stay as permissive no-ops because the gut
 * runtime does not stream transcripts to a remote ingress.
 */

/**
 * No-op remote-ingress URL setter. The bootstrap path calls this to
 * configure the AgenC transcript ingest endpoint; the lean rebuild
 * does not stream transcripts to a remote ingress today.
 */
export function setRemoteIngressUrl(_url: string | null): void {
  /* no-op */
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InternalEventWriter = (...args: any[]) => unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InternalEventReader = (...args: any[]) => unknown;

export function setInternalEventReader(
  _primary: InternalEventReader,
  _subagents: InternalEventReader,
): void {
  /* no-op */
}

export function setInternalEventWriter(_writer: InternalEventWriter): void {
  /* no-op */
}
