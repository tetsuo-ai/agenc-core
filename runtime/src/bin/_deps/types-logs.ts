/**
 * Per-dir transcript-log type shims for `runtime/src/bin/**`.
 *
 * Mirrors the agenc `runtime/src/types/logs.ts` shapes that
 * bin/bootstrap actually uses (just the two collapse entry
 * types). Carved as a local `_deps/` so the bin entry points stay
 * resolvable after the AgenC umbrella `src/types/` directory is
 * removed.
 */

export type ContextCollapseCommitEntry = {
  type: "marble-origami-commit";
  sessionId: string;
  collapseId: string;
  summaryUuid: string;
  summaryContent: string;
  summary: string;
  firstArchivedUuid: string;
  lastArchivedUuid: string;
};

export type ContextCollapseSnapshotEntry = {
  type: "marble-origami-snapshot";
  sessionId: string;
  staged: Array<{
    startUuid: string;
    endUuid: string;
    summary: string;
    risk: number;
    stagedAt: number;
  }>;
  armed: boolean;
  lastSpawnTokens: number;
};
