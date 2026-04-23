/**
 * Per-dir context-collapse persistence shim for `runtime/src/bin/**`.
 *
 * The openclaude-port `runtime/src/services/contextCollapse/persist.ts`
 * owns the process-global context-collapse runtime state. The lean
 * rebuild does not yet wire context-collapse, so this shim exposes the
 * `restoreFromEntries` surface bootstrap calls and treats it as a
 * no-op. Carved as a local `_deps/` to cut the gut→openclaude
 * crossing.
 */

export function restoreFromEntries(
  _commits: ReadonlyArray<unknown> = [],
  _snapshot?: unknown,
): void {
  /* no-op until the lean rebuild reintroduces context-collapse */
}
