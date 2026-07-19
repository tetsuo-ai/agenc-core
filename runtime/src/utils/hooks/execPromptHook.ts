// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { AdmissionDeniedError } from '../../budget/admission-client.js'
import type { ToolUseContext } from '../../tools/Tool.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from 'src/utils/debug.js'
import type { HookResult } from '../hooks.js'
import type { PromptHook } from '../settings/types.js'

const PROMPT_HOOK_ADMISSION_REASON = 'legacy_prompt_hook_model_path_disabled'

/**
 * Prompt hooks used a legacy provider shortcut that could not participate in
 * the daemon-owned execution-admission lifecycle. Until prompt hooks are
 * migrated onto the admitted provider surface, fail closed before any model
 * client is created: a policy hook that cannot run must never silently allow
 * the operation it was meant to guard.
 */
export async function execPromptHook(
  hook: PromptHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  messages?: Message[],
  toolUseID?: string,
): Promise<HookResult> {
  void hookEvent
  void jsonInput
  void signal
  void toolUseContext
  void messages
  void toolUseID

  const denial = new AdmissionDeniedError(PROMPT_HOOK_ADMISSION_REASON)
  const denialPayload = JSON.stringify({
    code: denial.code,
    decision: denial.decision,
    reason: denial.reason,
  })
  logForDebugging(`Hooks: Blocking prompt hook ${hookName}: ${denialPayload}`)
  return {
    hook,
    outcome: 'blocking',
    blockingError: {
      blockingError: denialPayload,
      command: hook.prompt,
    },
    preventContinuation: true,
    stopReason: denialPayload,
  }
}
