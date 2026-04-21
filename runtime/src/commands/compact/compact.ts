// @ts-nocheck
import {
  runManualCompact,
  type ManualCompactResult,
  type ManualCompactContext,
} from '../../session/manual-compact.js'
import type { LocalCommandCall } from '../../types/command.js'

export { runManualCompact } from '../../session/manual-compact.js'

export const call: LocalCommandCall = async (
  args,
  context,
): Promise<ManualCompactResult> =>
  runManualCompact(args, context as ManualCompactContext)
