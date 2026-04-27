/**
 * Per-dir transcript-loader + session-storage glue for
 * `runtime/src/bin/**`.
 *
 * Mirrors the AgenC implementation `runtime/src/utils/sessionStorage.ts`
 * surface the bootstrap path consumes:
 *   - `loadTranscriptFile(path)` — used during context-collapse rehydration
 *   - `setRemoteIngressUrl(url)` — used by `registerStartupSessionIngress`
 *   - `setInternalEventReader(...)` / `setInternalEventWriter(...)` —
 *     used by the same path
 *
 * Only `loadTranscriptFile` carries a real implementation today. The
 * three remote-ingress setters stay as permissive no-ops because the
 * gut runtime does not stream transcripts to a remote ingress.
 */

import { readFile } from "node:fs/promises";

import type {
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
} from "./types-logs.js";

export interface LoadedTranscript {
  readonly contextCollapseCommits: ContextCollapseCommitEntry[];
  readonly contextCollapseSnapshot?: ContextCollapseSnapshotEntry;
  // The full AgenC shape carries many more maps; the lean caller
  // only needs the two collapse fields. Permissive `unknown` allows the
  // shape to grow without breaking callers.
  readonly [extra: string]: unknown;
}

/**
 * Parse a JSONL transcript file and surface the marble-origami
 * context-collapse entries the bootstrap rehydrator consumes.
 *
 * Behaviour:
 *  - Reads `path` as UTF-8; propagates ENOENT (and other open errors)
 *    so the caller can treat missing transcripts as "no context-collapse
 *    state to restore".
 *  - Iterates non-empty lines, tries `JSON.parse` on each. Lines that
 *    fail to parse are skipped silently (a corrupt tail can sit at the
 *    end of an in-flight log; we never abort the whole load over one
 *    bad row).
 *  - Collects `type: "marble-origami-commit"` entries into
 *    `contextCollapseCommits` (commit order matters — nested collapses
 *    must be replayed in arrival order, mirroring the AgenC
 *    semantics in `runtime/src/utils/sessionStorage.ts::loadTranscriptFile`).
 *  - Collects `type: "marble-origami-snapshot"` entries last-wins:
 *    later entries supersede earlier ones, again mirroring the
 *    AgenC shape.
 *  - All other entry types (rollout `event_msg`, plain Claude
 *    transcript messages, `summary`, etc.) are ignored. The rollout
 *    history reconstruction path lives in
 *    `session/rollout-reconstruction.ts` and is invoked directly by
 *    bootstrap from `RolloutStore.readAll()`; we deliberately do not
 *    duplicate that work here.
 */
export async function loadTranscriptFile(
  path: string,
  _opts?: { keepAllLeaves?: boolean },
): Promise<LoadedTranscript> {
  // `readFile` throws an ENOENT-tagged error when the path is missing;
  // bootstrap callers catch + treat it as "no transcript here", so the
  // rejection is intentional rather than swallowed.
  const raw = await readFile(path, "utf8");

  const contextCollapseCommits: ContextCollapseCommitEntry[] = [];
  let contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let entry: { readonly type?: string } | null;
    try {
      entry = JSON.parse(trimmed) as { readonly type?: string } | null;
    } catch {
      // Best-effort: a partial trailing line from a crashed writer must
      // not poison the whole load.
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    if (entry.type === "marble-origami-commit") {
      contextCollapseCommits.push(entry as unknown as ContextCollapseCommitEntry);
    } else if (entry.type === "marble-origami-snapshot") {
      contextCollapseSnapshot =
        entry as unknown as ContextCollapseSnapshotEntry;
    }
  }

  return {
    contextCollapseCommits,
    ...(contextCollapseSnapshot !== undefined
      ? { contextCollapseSnapshot }
      : {}),
  };
}

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
