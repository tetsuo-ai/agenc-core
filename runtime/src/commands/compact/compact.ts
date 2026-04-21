// @ts-nocheck
import {
  runManualCompact,
  type ManualCompactResult,
} from '../../llm/compact/manual-compact.js'
import type { ManualCompactContext } from '../../llm/compact/manual-compact.js'
import type { LocalCommandCall } from '../../types/command.js'

export { runManualCompact } from '../../llm/compact/manual-compact.js'

export const call: LocalCommandCall = async (
  args,
  context,
): Promise<ManualCompactResult> =>
  runManualCompact(args, context as ManualCompactContext)
