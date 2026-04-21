import { feature } from 'bun:bundle'
import chalk from 'chalk'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getUserContext } from '../../context.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { notifyCompaction } from '../../services/api/promptCacheBreakDetection.js'
import {
  compactConversation,
  ERROR_MESSAGE_INCOMPLETE_RESPONSE,
  ERROR_MESSAGE_NOT_ENOUGH_MESSAGES,
  type CompactionResult,
} from './compact.js'
import type { CompactRuntimeContext } from './context.js'
import { suppressCompactWarning } from './compact-warning-state.js'
import { microcompactMessages } from './micro-compact.js'
import { runPostCompactCleanup } from './post-compact-cleanup.js'
import { buildCompactCacheSafeParams } from './runtime-context.js'
import { trySessionMemoryCompaction } from './session-memory-compact.js'
import { setLastSummarizedMessageId } from '../../services/SessionMemory/sessionMemoryUtils.js'
import type { Message } from '../../types/message.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { getUpgradeMessage } from '../../utils/model/contextWindowUpgradeCheck.js'

export interface ManualCompactResult {
  readonly type: 'compact'
  readonly compactionResult: CompactionResult
  readonly displayText: string
}

export type ManualCompactContext = CompactRuntimeContext & {
  messages: Message[]
}

export async function runManualCompact(
  args: string,
  context: ManualCompactContext,
): Promise<ManualCompactResult> {
  const { abortController } = context
  let { messages } = context

  // REPL keeps snipped messages for UI scrollback — project so the compact
  // model doesn't summarize content that was intentionally removed.
  messages = getMessagesAfterCompactBoundary(messages)

  if (messages.length === 0) {
    throw new Error('No messages to compact')
  }

  const customInstructions = args.trim()

  try {
    // Try session memory compaction first if no custom instructions
    // (session memory compaction doesn't support custom instructions)
    if (!customInstructions) {
      const sessionMemoryResult = await trySessionMemoryCompaction(
        messages,
        context.agentId,
      )
      if (sessionMemoryResult) {
        getUserContext.cache.clear?.()
        runPostCompactCleanup()
        // Reset cache read baseline so the post-compact drop isn't flagged
        // as a break. compactConversation does this internally; SM-compact doesn't.
        if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
          notifyCompaction(
            context.options.querySource ?? 'compact',
            context.agentId,
          )
        }
        markPostCompaction()
        // Suppress warning immediately after successful compaction
        suppressCompactWarning()

        return {
          type: 'compact',
          compactionResult: sessionMemoryResult,
          displayText: buildDisplayText(context),
        }
      }
    }

    // Fall back to traditional compaction
    // Run microcompact first to reduce tokens before summarization
    const microcompactResult = await microcompactMessages(messages, context)
    const messagesForCompact = microcompactResult.messages

    const result = await compactConversation(
      messagesForCompact,
      context,
      await buildCompactCacheSafeParams(context, messagesForCompact),
      false,
      customInstructions,
      false,
    )

    // Reset lastSummarizedMessageId since legacy compaction replaces all messages
    // and the old message UUID will no longer exist in the new messages array
    setLastSummarizedMessageId(undefined)

    // Suppress the "Context left until auto-compact" warning after successful compaction
    suppressCompactWarning()

    getUserContext.cache.clear?.()
    runPostCompactCleanup()

    return {
      type: 'compact',
      compactionResult: result,
      displayText: buildDisplayText(context, result.userDisplayMessage),
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error('Compaction canceled.')
    } else if (hasExactErrorMessage(error, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)) {
      throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
    } else if (hasExactErrorMessage(error, ERROR_MESSAGE_INCOMPLETE_RESPONSE)) {
      throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
    } else {
      logError(error)
      throw new Error(`Error during compaction: ${error}`)
    }
  }
}

function buildDisplayText(
  context: CompactRuntimeContext,
  userDisplayMessage?: string,
): string {
  const upgradeMessage = getUpgradeMessage('tip')
  const expandShortcut = getShortcutDisplay(
    'app:toggleTranscript',
    'Global',
    'ctrl+o',
  )
  const dimmed = [
    ...(context.options.verbose
      ? []
      : [`(${expandShortcut} to see full summary)`]),
    ...(userDisplayMessage ? [userDisplayMessage] : []),
    ...(upgradeMessage ? [upgradeMessage] : []),
  ]
  return chalk.dim('Compacted ' + dimmed.join('\n'))
}
