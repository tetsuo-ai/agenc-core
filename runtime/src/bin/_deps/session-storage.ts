/**
 * Per-dir transcript-loader + session-storage glue for
 * `runtime/src/bin/**`.
 *
 * Mirrors the openclaude-port `runtime/src/utils/sessionStorage.ts`
 * surface the bootstrap path consumes:
 *   - `loadTranscriptFile(path)` — used during context-collapse rehydration
 *   - `setRemoteIngressUrl(url)` — used by `registerStartupSessionIngress`
 *   - `setInternalEventReader(...)` / `setInternalEventWriter(...)` —
 *     used by the same path
 *
 * The lean rebuild does not yet own these surfaces. Each function is a
 * permissive no-op / null-return stub so the bin entry point stays
 * decoupled from the openclaude session-storage module. Carved as a
 * local `_deps/` to cut the gut→openclaude crossing.
 */

import type {
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
} from "../../types/logs.js";

export interface LoadedTranscript {
  readonly contextCollapseCommits: ContextCollapseCommitEntry[];
  readonly contextCollapseSnapshot?: ContextCollapseSnapshotEntry;
  // The full openclaude shape carries many more maps; the lean caller
  // only needs the two collapse fields. Permissive `unknown` allows the
  // shape to grow without breaking callers.
  readonly [extra: string]: unknown;
}

/**
 * No-op transcript loader. The lean rebuild does not parse openclaude
 * `.jsonl` transcripts; rehydration is handled by `RolloutStore`. The
 * bootstrap caller treats throwing reads as "no transcript here", so we
 * always throw `ENOENT` to keep the same semantics.
 */
export async function loadTranscriptFile(
  path: string,
  _opts?: { keepAllLeaves?: boolean },
): Promise<LoadedTranscript> {
  const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
  (err as NodeJS.ErrnoException).code = "ENOENT";
  throw err;
}

/**
 * No-op remote-ingress URL setter. The bootstrap path calls this to
 * configure the openclaude transcript ingest endpoint; the lean rebuild
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
