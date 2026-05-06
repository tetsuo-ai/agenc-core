import type {
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
} from '../../types/logs.js'
import {
  getContextCollapseCommits,
  getContextCollapseSnapshot,
  restoreContextCollapseState,
} from './index.js'

export function restoreFromEntries(
  commits: ContextCollapseCommitEntry[] = [],
  snapshot?: ContextCollapseSnapshotEntry,
): void {
  restoreContextCollapseState(commits, snapshot)
}

export function createPersistEntries(): {
  commits: ContextCollapseCommitEntry[]
  snapshot: ContextCollapseSnapshotEntry | undefined
} {
  return {
    commits: getContextCollapseCommits(),
    snapshot: getContextCollapseSnapshot(),
  }
}
