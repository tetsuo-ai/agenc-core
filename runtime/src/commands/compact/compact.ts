// @ts-nocheck
import {
  finalizeManualCompactHistory,
  runManualCompact,
  type ManualCompactContext,
} from '../../session/manual-compact.js'
import type { LocalCommandCall } from '../../types/command.js'

export { runManualCompact } from '../../session/manual-compact.js'

export const call: LocalCommandCall = async (
  args,
  context,
): Promise<{ type: 'skip' }> => {
  const result = await runManualCompact(args, context as ManualCompactContext)
  const finalized = finalizeManualCompactHistory(
    args,
    result.displayText ?? 'Compaction complete.',
    result.compactionResult,
  )
  context.setMessages(() => finalized.messages)
  return { type: 'skip' }
}
