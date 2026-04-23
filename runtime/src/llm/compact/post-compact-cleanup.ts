import { feature } from 'bun:bundle'
import type { QuerySource } from './_deps/query-source.js'
import { clearSystemPromptSections } from './_deps/system-prompt.js';
import { getUserContext, getSystemContext } from '../../session/_deps/system-prompt.js';
import { clearAllResponseIds } from '../grok/incremental.js'
import { clearSpeculativeChecks } from './_deps/no-op.js';
import { clearClassifierApprovals } from './_deps/no-op.js';
import { resetGetMemoryFilesCache } from './_deps/no-op.js';
import { clearBetaTracingState } from './_deps/no-op.js';
import { resetMicrocompactState } from './micro-compact.js'
import type { CompactRuntimeContext } from '../../session/compact-runtime-context.js'

export interface PostCompactCleanupOptions {
  /**
   * Cached micro-compact needs to keep its pending cache_edits block alive
   * until the next API request consumes it. Callers can preserve that state
   * while still running the I-2 cleanup work.
   */
  preserveMicrocompactState?: boolean
}

/**
 * Run cleanup of caches and tracking state after compaction.
 * Call this after both auto-compact and manual /compact to free memory
 * held by tracking structures that are invalidated by compaction.
 *
 * Note: We intentionally do NOT clear invoked skill content here.
 * Skill content must survive across multiple compactions so that
 * createSkillAttachmentIfNeeded() can include the full skill text
 * in subsequent compaction attachments.
 *
 * querySource: pass the compacting query's source so we can skip
 * resets that would clobber main-thread module-level state. Subagents
 * (agent:*) run in the same process and share module-level state
 * (context-collapse store, getMemoryFiles one-shot hook flag,
 * getUserContext cache); resetting those when a SUBAGENT compacts
 * would corrupt the MAIN thread's state. All compaction callers should
 * pass querySource — undefined is only safe for callers that are
 * genuinely main-thread-only (/compact, /clear).
 */
export function runPostCompactCleanup(
  querySource?: QuerySource,
  context?: Pick<CompactRuntimeContext, 'clearProviderResponseId'>,
  opts: PostCompactCleanupOptions = {},
): void {
  // I-2 (docs/plan/invariants.md): clear `previous_response_id` on every
  // compaction. Grok clears through its legacy tracker registry; shared
  // ProviderHttpClient-based Responses adapters clear through the compact
  // runtime context hook.
  clearAllResponseIds()
  context?.clearProviderResponseId?.()

  // Subagents (agent:*) run in the same process and share module-level
  // state with the main thread. Only reset main-thread module-level state
  // (context-collapse, memory file cache) for main-thread compacts.
  // Same startsWith pattern as isMainThread (index.ts:188).
  const isMainThreadCompact =
    querySource === undefined ||
    querySource.startsWith('repl_main_thread') ||
    querySource === 'sdk'

  if (!opts.preserveMicrocompactState) {
    resetMicrocompactState()
  }
  if (feature('CONTEXT_COLLAPSE')) {
    if (isMainThreadCompact) {
      // Openclaude context-collapse subsystem deleted in gut-cleanup; nothing
      // to reset in the lean runtime.
    }
  }
  if (isMainThreadCompact) {
    // getUserContext is a memoized outer layer over project-memory +
    // current-date reads; getSystemContext is a memoized git-status
    // snapshot. Both are stale after compaction. Manual /compact also
    // clears getUserContext at its call sites; this centralizes the
    // clear so auto-compact and reactive-compact behave consistently
    // (and clears the gut-only getSystemContext cache, which upstream
    // does not have as a separate cache layer).
    getUserContext.cache.clear?.()
    getSystemContext.cache.clear?.()
    resetGetMemoryFilesCache('compact')
  }
  clearSystemPromptSections()
  clearClassifierApprovals()
  clearSpeculativeChecks()
  // Intentionally NOT calling resetSentSkillNames(): re-injecting the full
  // skill_listing (~4K tokens) post-compact is pure cache_creation. The
  // model still has SkillTool in schema, invoked_skills preserves used
  // skills, and dynamic additions are handled by skillChangeDetector /
  // cacheUtils resets. See compactConversation() for full rationale.
  clearBetaTracingState()
  if (feature('COMMIT_ATTRIBUTION')) {
    // Openclaude commit-attribution helpers were deleted in gut-cleanup; the
    // feature flag is always false in the lean runtime, so this branch is dead.
  }
  // T5: the legacy `clearSessionMessagesCache` helper cleared a
  // memoized `getSessionMessages` cache in `utils/sessionStorage.ts`
  // consumed only by `doesMessageExistInSession` and `getLastSessionLog`
  // — both legacy openclaude readers. Grep confirms no T5 consumer reads
  // the memoized cache, so the post-compact clear is semantically dead
  // here. The call has been removed along with the legacy import.
}
