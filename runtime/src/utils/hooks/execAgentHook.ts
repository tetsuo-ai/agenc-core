// @ts-nocheck
import { randomUUID } from 'crypto'
import { dirname } from 'path'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { logEvent } from '../../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/metadata.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createAbortController } from '../abortController.js'
import { createAttachmentMessage } from '../attachments.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import type { HookResult } from '../hooks.js'
import { createUserMessage } from '../messages.js'
import { getAgentTranscriptPath, getTranscriptPath } from '../sessionStorage.js'
import type { AgentHook } from '../settings/types.js'
import { jsonStringify } from '../slowOperations.js'
import { addArgumentsToPrompt } from './hookHelpers.js'
import { runRuntimeSubagent } from '../runtimeSubagent.js'

function parseHookResult(
  rawResult: string,
): { ok: boolean; reason?: string } | null {
  try {
    const parsed = JSON.parse(rawResult)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    if (typeof parsed.ok !== 'boolean') {
      return null
    }
    if (parsed.ok) {
      return { ok: true }
    }
    return {
      ok: false,
      ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
    }
  } catch {
    return null
  }
}

/**
 * Execute an agent-based hook on the codex runtime child-session path.
 */
export async function execAgentHook(
  hook: AgentHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  toolUseID: string | undefined,
  _messages: Message[],
  agentName?: string,
): Promise<HookResult> {
  const effectiveToolUseID = toolUseID || `hook-${randomUUID()}`
  const transcriptPath = toolUseContext.agentId
    ? getAgentTranscriptPath(toolUseContext.agentId)
    : getTranscriptPath()
  const hookStartTime = Date.now()

  try {
    const processedPrompt = addArgumentsToPrompt(hook.prompt, jsonInput)
    logForDebugging(
      `Hooks: Processing agent hook with prompt: ${processedPrompt}`,
    )

    const hookTimeoutMs = hook.timeout ? hook.timeout * 1000 : 60000
    const hookAbortController = createAbortController()
    const { signal: parentTimeoutSignal, cleanup: cleanupCombinedSignal } =
      createCombinedAbortSignal(signal, { timeoutMs: hookTimeoutMs })
    const onParentTimeout = () => hookAbortController.abort()
    parentTimeoutSignal.addEventListener('abort', onParentTimeout)
    const combinedSignal = hookAbortController.signal

    try {
      const runtimePrompt = `${processedPrompt}

You are verifying a stop condition in Claude Code.
The conversation transcript is available at:
${transcriptPath}

Use the available tools to inspect the workspace and the transcript if needed.
Reply with JSON only using one of these shapes:
{"ok": true}
{"ok": false, "reason": "short reason"}`

      const result = await runRuntimeSubagent({
        initialMessages: [createUserMessage({ content: runtimePrompt })],
        taskPrompt: runtimePrompt,
        legacyTools: toolUseContext.options.tools,
        extraAllowedRoots: [dirname(transcriptPath)],
        externalSignal: combinedSignal,
        onMessage(message) {
          if (message.type !== 'assistant') {
            return
          }
          const content = message.message.content
          const added =
            typeof content === 'string'
              ? content.length
              : content
                  .filter(block => block.type === 'text')
                  .reduce((sum, block) => sum + block.text.length, 0)
          if (added > 0) {
            toolUseContext.setResponseLength(length => length + added)
          }
        },
      })
      if (result.error) {
        throw result.error
      }

      parentTimeoutSignal.removeEventListener('abort', onParentTimeout)
      cleanupCombinedSignal()

      const rawResult = result.finalMessage?.trim() ?? ''
      const parsedResult = rawResult ? parseHookResult(rawResult) : null
      if (parsedResult) {
        logForDebugging(
          `Hooks: Parsed hook result ${jsonStringify(parsedResult)}`,
        )
      }

      if (!parsedResult) {
        logForDebugging(`Hooks: Agent hook did not return valid JSON`)
        logEvent('tengu_agent_stop_hook_error', {
          durationMs: Date.now() - hookStartTime,
          turnCount: result.toolCallCount,
          errorType: 1,
          agentName:
            agentName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {
          hook,
          outcome: 'cancelled',
        }
      }

      if (!parsedResult.ok) {
        logForDebugging(
          `Hooks: Agent hook condition was not met: ${parsedResult.reason}`,
        )
        return {
          hook,
          outcome: 'blocking',
          blockingError: {
            blockingError: `Agent hook condition was not met: ${parsedResult.reason}`,
            command: hook.prompt,
          },
        }
      }

      logForDebugging(`Hooks: Agent hook condition was met`)
      logEvent('tengu_agent_stop_hook_success', {
        durationMs: Date.now() - hookStartTime,
        turnCount: result.toolCallCount,
        agentName:
          agentName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return {
        hook,
        outcome: 'success',
        message: createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
          content: '',
        }),
      }
    } catch (error) {
      parentTimeoutSignal.removeEventListener('abort', onParentTimeout)
      cleanupCombinedSignal()

      if (combinedSignal.aborted) {
        return {
          hook,
          outcome: 'cancelled',
        }
      }
      throw error
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Hooks: Agent hook error: ${errorMsg}`)
    logEvent('tengu_agent_stop_hook_error', {
      durationMs: Date.now() - hookStartTime,
      errorType: 2,
      agentName:
        agentName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return {
      hook,
      outcome: 'non_blocking_error',
      message: createAttachmentMessage({
        type: 'hook_non_blocking_error',
        hookName,
        toolUseID: effectiveToolUseID,
        hookEvent,
        stderr: `Error executing agent hook: ${errorMsg}`,
        stdout: '',
        exitCode: 1,
      }),
    }
  }
}
