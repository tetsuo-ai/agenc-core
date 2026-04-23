/**
 * Per-dir context-collapse persistence shim for `runtime/src/bin/**`.
 *
 * Delegates to the real subsystem in
 * `session/_deps/context-collapse.ts::restoreContextCollapseState`.
 * The bin shim is preserved as a separate entry point so the bootstrap
 * caller does not need to know about the session-internal module path
 * directly, and so the persisted-entry types can vary independently
 * from the runtime service surface.
 *
 * Bootstrap call sites:
 *   - Fresh session: `restoreFromEntries([], undefined)` clears any
 *     stale process-global state from a prior run in the same node
 *     process (matters for tests sharing a single process).
 *   - Resumed session: `restoreFromEntries(commits, snapshot)` rehydrates
 *     persisted commit + snapshot entries so the live service projects
 *     the same view the prior session committed.
 */

import type {
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
} from "./types-logs.js";
import { restoreContextCollapseState } from "../../session/_deps/context-collapse.js";

export function restoreFromEntries(
  commits: ReadonlyArray<ContextCollapseCommitEntry> = [],
  snapshot?: ContextCollapseSnapshotEntry,
): void {
  restoreContextCollapseState(commits, snapshot);
}
