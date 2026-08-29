import { getRegisteredHooks } from '../../bootstrap/state.js'
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage } from '../errors.js'
import {
  executeCwdChangedHooks,
  type HookOutsideReplResult,
} from '../hooks.js'
import { clearCwdEnvFiles } from '../sessionEnvironment.js'
import { isHookExecutionSuppressed } from '../../hooks/runtime-policy.js'

let notifyCallback: ((text: string, isError: boolean) => void) | null = null

export function setEnvHookNotifier(
  cb: ((text: string, isError: boolean) => void) | null,
): void {
  notifyCallback = cb
}

export async function onCwdChangedForHooks(
  oldCwd: string,
  newCwd: string,
): Promise<void> {
  if (isHookExecutionSuppressed()) return
  if (oldCwd === newCwd) return

  if ((getRegisteredHooks()?.CwdChanged?.length ?? 0) === 0) return

  await clearCwdEnvFiles()
  const hookResult = await executeCwdChangedHooks(oldCwd, newCwd).catch(e => {
    const msg = errorMessage(e)
    logForDebugging(`CwdChanged hook failed: ${msg}`, {
      level: 'error',
    })
    notifyCallback?.(msg, true)
    return {
      results: [] as HookOutsideReplResult[],
      watchPaths: [] as string[],
      systemMessages: [] as string[],
    }
  })
  for (const msg of hookResult.systemMessages) {
    notifyCallback?.(msg, false)
  }
  for (const r of hookResult.results) {
    if (!r.succeeded && r.output) {
      notifyCallback?.(r.output, true)
    }
  }
}
