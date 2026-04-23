import { feature } from 'bun:bundle'
import type { QuerySource } from '../../constants/querySource.js'
import { clearSystemPromptSections } from './_deps/system-prompt.js';
import { getUserContext } from './_deps/no-op.js';
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
  // compaction. Calls into the T5 grok incremental tracker registry.
  // Other providers register their trackers the same way; T13 extends
  // with per-adapter normalizers.
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
      /* eslint-disable @typescript-eslint/no-require-imports */
      ;(
        require('../../services/contextCollapse/index.js') as typeof import('../../services/contextCollapse/index.js')
      ).resetContextCollapse()
      /* eslint-enable @typescript-eslint/no-require-imports */
    }
  }
  if (isMainThreadCompact) {
    // getUserContext is a memoized outer layer wrapping getClaudeMds() →
    // getMemoryFiles(). If only the inner getMemoryFiles cache is cleared,
    // the next turn hits the getUserContext cache and never reaches
    // getMemoryFiles(), so the armed InstructionsLoaded hook never fires.
    // Manual /compact already clears this explicitly at its call sites;
    // auto-compact and reactive-compact did not — this centralizes the
    // clear so all compaction paths behave consistently.
    getUserContext.cache.clear?.()
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
    void import('../../utils/attributionHooks.js').then(m =>
      m.sweepFileContentCache(),
    )
  }
  // T5: the legacy `clearSessionMessagesCache` helper cleared a
  // memoized `getSessionMessages` cache in `utils/sessionStorage.ts`
  // consumed only by `doesMessageExistInSession` and `getLastSessionLog`
  // — both legacy openclaude readers. Grep confirms no T5 consumer reads
  // the memoized cache, so the post-compact clear is semantically dead
  // here. The call has been removed along with the legacy import.
}
