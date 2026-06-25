// Moved-source note: this moved utility still imports not-yet-absorbed upstream subsystems.
import { randomUUID } from 'crypto'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { requireCurrentRuntimeSession } from '../../session/current-session.js'
import {
  createTurnCompatSession,
  structuredOutputFromToolResult,
} from '../../session/turn-compat.js'
import type { ToolUseContext } from '../../tools/Tool.js'
import { type Tool, toolMatchesName } from '../../tools/Tool.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { ALL_AGENT_DISALLOWED_TOOLS } from '../../tools.js'
import { asAgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { createAbortController } from '../abortController.js'
import { createAttachmentMessage } from '../attachments.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage } from '../errors.js'
import type { HookResult } from '../hooks.js'
import { createUserMessage } from '../messages.js'
import { getSmallFastModel } from '../model/model.js'
import { hasPermissionsToUseTool } from '../permissions/permissions.js'
import { getAgentTranscriptPath, getTranscriptPath } from '../sessionStorage.js'
import type { AgentHook } from '../settings/types.js'
import { jsonStringify } from '../slowOperations.js'
import { asSystemPrompt } from '../systemPromptType.js'
import {
  addArgumentsToPrompt,
  createStructuredOutputTool,
  hookResponseSchema,
  registerStructuredOutputEnforcement,
} from './hookHelpers.js'
import { clearSessionHooks } from './sessionHooks.js'

/**
 * Execute an agent-based hook using a multi-turn LLM query
 */
export async function execAgentHook(
  hook: AgentHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  toolUseID: string | undefined,
  // Kept for signature stability with the other exec*Hook functions.
  // Was used by hook.prompt(messages) before the .transform() was removed
  // (CC-79) — the only consumer of that was ExitPlanModeV2Tool's
  // programmatic construction, since refactored into VerifyPlanExecutionTool.
  _messages: Message[],
  _agentName?: string,
): Promise<HookResult> {
  const effectiveToolUseID = toolUseID || `hook-${randomUUID()}`

  // Get transcript path from context
  const transcriptPath = toolUseContext.agentId
    ? getAgentTranscriptPath(toolUseContext.agentId)
    : getTranscriptPath()
  try {
    // Replace $ARGUMENTS with the JSON input
    const processedPrompt = addArgumentsToPrompt(hook.prompt, jsonInput)
    logForDebugging(
      `Hooks: Processing agent hook with prompt: ${processedPrompt}`,
    )

    // Create user message directly - no need for prompt input dispatch, which would
    // trigger UserPromptSubmit hooks and cause infinite recursion
    const userMessage = createUserMessage({ content: processedPrompt })
    const agentMessages = [userMessage]

    logForDebugging(
      `Hooks: Starting agent query with ${agentMessages.length} messages`,
    )

    // Setup timeout and combine with parent signal
    const hookTimeoutMs = hook.timeout ? hook.timeout * 1000 : 60000
    const hookAbortController = createAbortController()

    // Combine parent signal with timeout, and have it abort our controller
    const { signal: parentTimeoutSignal, cleanup: cleanupCombinedSignal } =
      createCombinedAbortSignal(signal, { timeoutMs: hookTimeoutMs })
    const onParentTimeout = () => hookAbortController.abort()
    if (parentTimeoutSignal.aborted) {
      hookAbortController.abort()
    } else {
      parentTimeoutSignal.addEventListener('abort', onParentTimeout)
    }

    // Combined signal is just our controller's signal now
    const combinedSignal = hookAbortController.signal

    // Set once the per-agent Stop hook is registered, so the finally below can
    // always remove it — the success path alone used to clear it, leaking the
    // hook-agent-<uuid> entry on every throw/abort.
    let hookAgentIdForCleanup: ReturnType<typeof asAgentId> | undefined

    try {
      // Create StructuredOutput tool with our schema
      const structuredOutputTool = createStructuredOutputTool()

      // Filter out any existing StructuredOutput tool to avoid duplicates with different schemas
      // (e.g., when parent context has a StructuredOutput tool from --json-schema flag)
      const filteredTools = toolUseContext.options.tools.filter(
        tool => !toolMatchesName(tool, SYNTHETIC_OUTPUT_TOOL_NAME),
      )

      // Use all available tools plus our structured output tool
      // Filter out disallowed agent tools to prevent stop hook agents from spawning subagents
      // or entering plan mode, and filter out duplicate StructuredOutput tools
      const tools: Tool[] = [
        ...filteredTools.filter(
          tool => !ALL_AGENT_DISALLOWED_TOOLS.has(tool.name),
        ),
        structuredOutputTool,
      ]

      const systemPrompt = asSystemPrompt([
        `You are verifying a stop condition in AgenC. Your task is to verify that the agent completed the given plan. The conversation transcript is available at: ${transcriptPath}\nYou can read this file to analyze the conversation history if needed.

Use the available tools to inspect the codebase and verify the condition.
Use as few steps as possible - be efficient and direct.

When done, return your result using the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool with:
- ok: true if the condition is met
- ok: false with reason if the condition is not met`,
      ])

      const model = hook.model ?? getSmallFastModel()
      const MAX_AGENT_TURNS = 50

      // Create unique agentId for this hook agent
      const hookAgentId = asAgentId(`hook-agent-${randomUUID()}`)

      // Create a modified toolUseContext for the agent
      const agentToolUseContext: ToolUseContext = {
        ...toolUseContext,
        agentId: hookAgentId,
        abortController: hookAbortController,
        options: {
          ...toolUseContext.options,
          tools,
          mainLoopModel: model,
          isNonInteractiveSession: true,
          thinkingConfig: { type: 'disabled' as const },
        },
        setInProgressToolUseIDs: () => {},
        getAppState() {
          const appState = toolUseContext.getAppState()
          // Add session rule to allow reading transcript file
          const existingSessionRules =
            appState.toolPermissionContext.alwaysAllowRules.session ?? []
          return {
            ...appState,
            toolPermissionContext: {
              ...appState.toolPermissionContext,
              mode: 'dontAsk' as const,
              alwaysAllowRules: {
                ...appState.toolPermissionContext.alwaysAllowRules,
                session: [...existingSessionRules, `Read(/${transcriptPath})`],
              },
            },
          }
        },
      }

      // Register a session-level stop hook to enforce structured output
      registerStructuredOutputEnforcement(
        toolUseContext.setAppState,
        hookAgentId,
        'SubagentStop',
      )
      hookAgentIdForCleanup = hookAgentId

      let structuredOutputResult: { ok: boolean; reason?: string } | null = null
      let turnCount = 0

      const parentSession = requireCurrentRuntimeSession('agent hook')
      const turn = await createTurnCompatSession(
        parentSession,
        {
          messages: agentMessages,
          systemPrompt,
          userContext: {},
          systemContext: {},
          canUseTool: hasPermissionsToUseTool,
          toolUseContext: agentToolUseContext,
          querySource: 'hook_agent',
          maxTurns: MAX_AGENT_TURNS,
        },
        { conversationId: hookAgentId },
      )
      let lastAssistantLength = 0
      for await (const event of turn.session.runTurn(turn.userMessage, {
        history: turn.history,
        systemPrompt: turn.systemPrompt,
        signal: combinedSignal,
        querySource: 'hook_agent',
        configOverrides: { maxTurns: MAX_AGENT_TURNS },
      })) {
        if (event.type === 'assistant_text') {
          const delta = event.content.slice(lastAssistantLength)
          lastAssistantLength = event.content.length
          if (delta.length > 0) {
            toolUseContext.setResponseLength(length => length + delta.length)
            toolUseContext.setStreamMode?.('responding')
          }
          continue
        }

        if (
          event.type === 'tool_result' &&
          toolMatchesName(structuredOutputTool, event.toolCall.name)
        ) {
          const output = structuredOutputFromToolResult(event.result)
          const parsed = hookResponseSchema().safeParse(output)
          if (parsed.success) {
            structuredOutputResult = parsed.data
            logForDebugging(
              `Hooks: Got structured output: ${jsonStringify(structuredOutputResult)}`,
            )
            // Got structured output, abort and exit
            hookAbortController.abort()
            break
          }
          continue
        }

        if (event.type === 'turn_complete') {
          turnCount++
          if (event.stopReason === 'error') {
            throw new Error(event.error?.message ?? 'Agent hook turn failed')
          }
          if (event.stopReason === 'max_turns') {
            throw new Error(`Agent hook exceeded maxTurns (${MAX_AGENT_TURNS})`)
          }
          if (event.stopReason === 'no_progress') {
            throw new Error(
              'Agent hook stopped by the no-progress backstop (semantic non-termination)',
            )
          }
        }
      }

      parentTimeoutSignal.removeEventListener('abort', onParentTimeout)
      cleanupCombinedSignal()

      // Check if we got a result
      if (!structuredOutputResult) {
        logForDebugging(`Hooks: Agent hook did not return structured output`)
        if (combinedSignal.aborted) {
          return {
            hook,
            outcome: 'cancelled',
          }
        }
        throw new Error('Agent hook did not return structured output')
      }

      // Return result based on structured output
      if (!structuredOutputResult.ok) {
        logForDebugging(
          `Hooks: Agent hook condition was not met: ${structuredOutputResult.reason}`,
        )
        return {
          hook,
          outcome: 'blocking',
          blockingError: {
            blockingError: `Agent hook condition was not met: ${structuredOutputResult.reason}`,
            command: hook.prompt,
          },
        }
      }

      // Condition was met
      logForDebugging(`Hooks: Agent hook condition was met`)
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
    } finally {
      // Always remove the per-agent Stop hook, regardless of
      // success/abort/throw. Idempotent Map.delete, and only runs once the
      // hook was actually registered.
      if (hookAgentIdForCleanup) {
        clearSessionHooks(toolUseContext.setAppState, hookAgentIdForCleanup)
      }
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Hooks: Agent hook error: ${errorMsg}`)
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
