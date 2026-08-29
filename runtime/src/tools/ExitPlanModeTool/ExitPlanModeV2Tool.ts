import { feature } from 'bun:bundle'
import { writeFile } from 'fs/promises'
import { z } from 'zod/v4'
import {
  getAllowedChannels,
  setHasExitedPlanMode,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from '../../bootstrap/state.js'
import {
  buildTool,
  type Tool,
  type ToolDef,
  type ToolUseContext,
  toolMatchesName,
} from '../Tool.js'
import { formatAgentId, generateRequestId } from '../../utils/agentId.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from 'src/utils/debug.js'
import {
  findInProcessTeammateTaskId,
  setAwaitingPlanApproval,
} from '../../utils/inProcessTeammateHelpers.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import {
  getPlan,
  getPlanFilePath,
  persistFileSnapshotIfRemote,
} from '../../utils/plans.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getAgentName,
  getTeamName,
  isPlanModeRequired,
  isTeammate,
} from '../../utils/teammate.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '../TeamCreateTool/constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from './constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'
import * as autoModeState from '../../utils/permissions/autoModeState.js'
import {
  isAutoModeGateEnabled,
  transitionPermissionMode,
} from '../../permissions/permission-mode.js'
import { getCwd } from '../../utils/cwd.js'

const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? autoModeState
  : null

const PLAN_EXIT_PERMISSION_CAS_ATTEMPTS = 3
const PLAN_EXIT_PERMISSION_CAS_TIMEOUT_MS = 250

type AppStateSnapshot = ReturnType<ToolUseContext['getAppState']>
type PermissionCasOutcome =
  | { readonly status: 'applied' }
  | { readonly status: 'mismatch'; readonly appState: AppStateSnapshot }
  | { readonly status: 'timeout' }

async function compareAndSetPlanPermissionContext(
  context: Pick<ToolUseContext, 'setAppState'>,
  expected: AppStateSnapshot,
  nextPermissionContext: AppStateSnapshot['toolPermissionContext'],
): Promise<PermissionCasOutcome> {
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let acknowledge!: (outcome: PermissionCasOutcome) => void
  const acknowledged = new Promise<PermissionCasOutcome>(resolve => {
    acknowledge = resolve
  })

  context.setAppState(prev => {
    if (!active) return prev
    if (prev.toolPermissionContext !== expected.toolPermissionContext) {
      acknowledge({ status: 'mismatch', appState: prev })
      return prev
    }
    acknowledge({ status: 'applied' })
    return {
      ...prev,
      toolPermissionContext: nextPermissionContext,
    }
  })

  const timedOut = new Promise<PermissionCasOutcome>(resolve => {
    timer = setTimeout(
      () => resolve({ status: 'timeout' }),
      PLAN_EXIT_PERMISSION_CAS_TIMEOUT_MS,
    )
  })
  const outcome = await Promise.race([acknowledged, timedOut])
  active = false
  if (timer !== undefined) clearTimeout(timer)
  return outcome
}

/**
 * Schema for prompt-based permission requests.
 * Used by AgenC to request semantic permissions when exiting plan mode.
 */
const allowedPromptSchema = lazySchema(() =>
  z.object({
    tool: z.enum(['system.bash']).describe('The tool this prompt applies to'),
    prompt: z
      .string()
      .describe(
        'Semantic description of the action, e.g. "run tests", "install dependencies"',
      ),
  }),
)

export type AllowedPrompt = z.infer<ReturnType<typeof allowedPromptSchema>>

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      // Prompt-based permissions requested by the plan
      allowedPrompts: z
        .array(allowedPromptSchema())
        .optional()
        .describe(
          'Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.',
        ),
    })
    .passthrough(),
)
type InputSchema = ReturnType<typeof inputSchema>

/**
 * SDK-facing input schema - includes fields injected by normalizeToolInput.
 * The internal inputSchema doesn't have these fields because plan is read from disk,
 * but the SDK/hooks see the normalized version with plan and file path included.
 */
export const _sdkInputSchema = lazySchema(() =>
  inputSchema().extend({
    plan: z
      .string()
      .optional()
      .describe('The plan content (injected by normalizeToolInput from disk)'),
    planFilePath: z
      .string()
      .optional()
      .describe('The plan file path (injected by normalizeToolInput)'),
  }),
)

export const outputSchema = lazySchema(() =>
  z.object({
    plan: z
      .string()
      .nullable()
      .describe('The plan that was presented to the user'),
    isAgent: z.boolean(),
    filePath: z
      .string()
      .optional()
      .describe('The file path where the plan was saved'),
    hasTaskTool: z
      .boolean()
      .optional()
      .describe('Whether the Agent tool is available in the current context'),
    planWasEdited: z
      .boolean()
      .optional()
      .describe(
        'True when the user edited the plan (CCR web UI or Ctrl+G); determines whether the plan is echoed back in tool_result',
      ),
    awaitingLeaderApproval: z
      .boolean()
      .optional()
      .describe(
        'When true, the teammate has sent a plan approval request to the team leader',
      ),
    requestId: z
      .string()
      .optional()
      .describe('Unique identifier for the plan approval request'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const ExitPlanModeV2Tool: Tool<InputSchema, Output> = buildTool({
  name: EXIT_PLAN_MODE_V2_TOOL_NAME,
  searchHint: 'present plan for approval and start coding (plan mode only)',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Prompts the user to exit plan mode and start coding'
  },
  async prompt() {
    return EXIT_PLAN_MODE_V2_TOOL_PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return ''
  },
  isEnabled() {
    // When --channels is active the user is likely on Telegram/Discord, not
    // watching the TUI. The plan-approval dialog would hang. Paired with the
    // same gate on EnterPlanMode so plan mode isn't a trap.
    if (
      (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
      getAllowedChannels().length > 0
    ) {
      return false
    }
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false // Now writes to disk
  },
  requiresUserInteraction() {
    // For ALL teammates, no local user interaction needed:
    // - If isPlanModeRequired(): team lead approves via mailbox
    // - Otherwise: exits locally without approval (voluntary plan mode)
    if (isTeammate()) {
      return false
    }
    // For non-teammates, require user confirmation to exit plan mode
    return true
  },
  async validateInput(_input, { getAppState }) {
    // Teammate AppState may show leader's mode (runAgent.ts skips override in
    // acceptEdits/bypassPermissions/auto); isPlanModeRequired() is the real source
    if (isTeammate()) {
      return { result: true }
    }
    // The deferred-tool list announces this tool regardless of mode, so the
    // model can call it after plan approval (fresh delta on compact/clear).
    // Reject before checkPermissions to avoid showing the approval dialog.
    const mode = getAppState().toolPermissionContext.mode
    if (mode !== 'plan') {
      return {
        result: false,
        message:
          'You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async checkPermissions(input, _context) {
    // For ALL teammates, bypass the permission UI to avoid sending permission_request
    // The call() method handles the appropriate behavior:
    // - If isPlanModeRequired(): sends plan_approval_request to leader
    // - Otherwise: exits plan mode locally (voluntary plan mode)
    if (isTeammate()) {
      return {
        behavior: 'allow' as const,
        updatedInput: input,
      }
    }

    // For non-teammates, require user confirmation to exit plan mode
    return {
      behavior: 'ask' as const,
      message: 'Exit plan mode?',
      updatedInput: input,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  async call(input, context) {
    const isAgent = !!context.agentId

    const filePath = getPlanFilePath(context.agentId)
    // CCR web UI may send an edited plan via permissionResult.updatedInput.
    // queryHelpers.ts full-replaces finalInput, so when CCR sends {} (no edit)
    // input.plan is undefined -> disk fallback. The internal inputSchema omits
    // `plan` (normally injected by normalizeToolInput), hence the narrowing.
    const inputPlan =
      'plan' in input && typeof input.plan === 'string' ? input.plan : undefined
    const plan = inputPlan ?? getPlan(context.agentId)

    // Sync disk so VerifyPlanExecution / Read see the edit. Re-snapshot
    // after: the only other persistFileSnapshotIfRemote call (api.ts) runs
    // in normalizeToolInput, pre-permission — it captured the old plan.
    if (inputPlan !== undefined && filePath) {
      await writeFile(filePath, inputPlan, 'utf-8').catch(e => logError(e))
      void persistFileSnapshotIfRemote()
    }

    // Check if this is a teammate that requires leader approval
    if (isTeammate() && isPlanModeRequired()) {
      // Plan is required for plan_mode_required teammates
      if (!plan) {
        throw new Error(
          `No plan file found at ${filePath}. Please write your plan to this file before calling ExitPlanMode.`,
        )
      }
      const agentName = getAgentName() || 'unknown'
      const teamName = getTeamName()
      const requestId = generateRequestId(
        'plan_approval',
        formatAgentId(agentName, teamName || 'default'),
      )

      const approvalRequest = {
        type: 'plan_approval_request',
        from: agentName,
        timestamp: new Date().toISOString(),
        planFilePath: filePath,
        planContent: plan,
        requestId,
      }

      await writeToMailbox(
        'team-lead',
        {
          from: agentName,
          text: jsonStringify(approvalRequest),
          timestamp: new Date().toISOString(),
        },
        teamName,
      )

      // Update task state to show awaiting approval (for in-process teammates)
      const appState = context.getAppState()
      const agentTaskId = findInProcessTeammateTaskId(agentName, appState)
      if (agentTaskId) {
        setAwaitingPlanApproval(agentTaskId, context.setAppState, true)
      }

      return {
        data: {
          plan,
          isAgent: true,
          filePath,
          awaitingLeaderApproval: true,
          requestId,
        },
      }
    }

    // Note: Background verification hook is registered in REPL.tsx AFTER context clear
    // via registerPlanVerificationHook(). Registering here would be cleared during context clear.

    // Ensure mode is changed when exiting plan mode.
    // This handles cases where permission flow didn't set the mode
    // (e.g., when PermissionRequest hook auto-approves without providing updatedPermissions).
    let appState = context.getAppState()
    let appliedRestore:
      | {
          readonly restoreMode: AppStateSnapshot['toolPermissionContext']['mode']
          readonly gateFallbackNotification: string | null
        }
      | undefined

    for (
      let attempt = 0;
      attempt < PLAN_EXIT_PERMISSION_CAS_ATTEMPTS;
      attempt += 1
    ) {
      if (appState.toolPermissionContext.mode !== 'plan') break

      let restoreMode =
        appState.toolPermissionContext.prePlanMode ?? 'default'
      // Circuit breaker defense: if prePlanMode was auto but the gate is now
      // off, restore default instead of reactivating auto behind the gate.
      let gateFallbackNotification: string | null = null
      if (
        feature('TRANSCRIPT_CLASSIFIER') &&
        restoreMode === 'auto' &&
        !isAutoModeGateEnabled()
      ) {
        restoreMode = 'default'
        gateFallbackNotification =
          'auto mode is unavailable because the classifier gate is closed'
        logForDebugging(
          '[auto-mode gate @ ExitPlanModeV2Tool] prePlanMode=auto ' +
            'but gate is off (reason=classifier-unavailable) — falling back to default on plan exit',
          { level: 'warn' },
        )
      }

      const transitioned = transitionPermissionMode(
        'plan',
        restoreMode,
        appState.toolPermissionContext,
        { workspacePath: getCwd() },
      )
      if ('error' in transitioned) {
        const message =
          'Cannot exit plan mode: restoring bypassPermissions requires exact cwd consent. Run /permissions accept-bypass and try again.'
        context.addNotification?.({
          key: 'bypass-consent-required-plan-restore',
          text: message,
          priority: 'immediate',
          color: 'warning',
          timeoutMs: 10000,
        })
        throw new Error(message)
      }

      const outcome = await compareAndSetPlanPermissionContext(
        context,
        appState,
        {
          ...transitioned,
          mode: restoreMode,
        },
      )
      if (outcome.status === 'applied') {
        appliedRestore = { restoreMode, gateFallbackNotification }
        break
      }
      appState =
        outcome.status === 'mismatch'
          ? outcome.appState
          : context.getAppState()
    }

    if (appliedRestore === undefined) {
      const message =
        'Cannot exit plan mode because the permission state changed concurrently. Try ExitPlanMode again.'
      context.addNotification?.({
        key: 'plan-exit-permission-state-conflict',
        text: message,
        priority: 'immediate',
        color: 'warning',
        timeoutMs: 10000,
      })
      throw new Error(message)
    }

    if (appliedRestore.gateFallbackNotification !== null) {
      context.addNotification?.({
        key: 'auto-mode-gate-plan-exit-fallback',
        text: `plan exit → default · ${appliedRestore.gateFallbackNotification}`,
        priority: 'immediate',
        color: 'warning',
        timeoutMs: 10000,
      })
    }

    setHasExitedPlanMode(true)
    setNeedsPlanModeExitAttachment(true)
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      const finalRestoringAuto = appliedRestore.restoreMode === 'auto'
      const autoWasUsedDuringPlan =
        autoModeStateModule?.isAutoModeActive() ?? false
      autoModeStateModule?.setAutoModeActive(finalRestoringAuto)
      if (autoWasUsedDuringPlan && !finalRestoringAuto) {
        setNeedsAutoModeExitAttachment(true)
      }
    }

    const hasTaskTool =
      isAgentSwarmsEnabled() &&
      context.options.tools.some(t => toolMatchesName(t, AGENT_TOOL_NAME))

    return {
      data: {
        plan,
        isAgent,
        filePath,
        hasTaskTool: hasTaskTool || undefined,
        planWasEdited: inputPlan !== undefined || undefined,
      },
    }
  },
  mapToolResultToToolResultBlockParam(
    {
      isAgent,
      plan,
      filePath,
      hasTaskTool,
      planWasEdited,
      awaitingLeaderApproval,
      requestId,
    },
    toolUseID,
  ) {
    // Handle teammate awaiting leader approval
    if (awaitingLeaderApproval) {
      return {
        type: 'tool_result',
        content: `Your plan has been submitted to the team lead for approval.

Plan file: ${filePath}

**What happens next:**
1. Wait for the team lead to review your plan
2. You will receive a message in your inbox with approval/rejection
3. If approved, you can proceed with implementation
4. If rejected, refine your plan based on the feedback

**Important:** Do NOT proceed until you receive approval. Check your inbox for response.

Request ID: ${requestId}`,
        tool_use_id: toolUseID,
      }
    }

    if (isAgent) {
      return {
        type: 'tool_result',
        content:
          'User has approved the plan. There is nothing else needed from you now. Please respond with "ok"',
        tool_use_id: toolUseID,
      }
    }

    // Handle empty plan
    if (!plan || plan.trim() === '') {
      return {
        type: 'tool_result',
        content: 'User has approved exiting plan mode. You can now proceed.',
        tool_use_id: toolUseID,
      }
    }

    const teamHint = hasTaskTool
      ? `\n\nIf this plan can be broken down into multiple independent tasks, consider using the ${TEAM_CREATE_TOOL_NAME} tool to create a team and parallelize the work.`
      : ''

    // Always include the plan so downstream plan consumers can parse the
    // tool_result and retrieve the approved text.
    // Label edited plans so the model knows the user changed something.
    const planLabel = planWasEdited
      ? 'Approved Plan (edited by user)'
      : 'Approved Plan'

    return {
      type: 'tool_result',
      content: `User has approved your plan. You can now start coding. Start with updating your todo list if applicable
Your plan has been saved to: ${filePath}
You can refer back to it if needed during implementation.${teamHint}
## ${planLabel}:
${plan}`,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
