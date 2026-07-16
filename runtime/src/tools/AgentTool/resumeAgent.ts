import { promises as fsp } from 'fs'
import { getSdkAgentProgressSummariesEnabled } from '../../bootstrap/state.js'
import {
  assertAgentRoleWorkspaceMatches,
  type AgentRoleWorkspace,
} from '../../agents/role.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type { CanUseToolFn } from '../../tui/hooks/useCanUseTool.js'
import type { ToolPermissionContext, ToolUseContext } from '../Tool.js'
import type { AdditionalWorkingDirectory } from '../../types/permissions.js'
import { registerAsyncAgent } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { requireCurrentRuntimeSession } from '../../session/current-session.js'
import { assembleToolPool } from '../../tools.js'
import { asAgentId } from '../../types/ids.js'
import {
  getAgentContext,
  runWithAgentContext,
  type SubagentContext,
} from '../../utils/agentContext.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { logForDebugging } from 'src/utils/debug.js'
import {
  createUserMessage,
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
} from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import { getQuerySourceForAgent } from '../../utils/promptCategory.js'
import {
  type AgentMetadata as AgentSidecarMetadata,
  getAgentTranscript,
  readAgentMetadata,
} from '../../utils/sessionStorage.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { getParentSessionId } from '../../utils/teammate.js'
import { reconstructForSubagentResume } from '../../utils/toolResultStorage.js'
import { runAsyncAgentLifecycle } from './agentToolUtils.js'
import { FORK_AGENT, isForkSubagentEnabled } from './forkSubagent.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from 'src/tools/AgentTool/loadAgentsDir.js'
import {
  isBuiltInAgent,
  isRepositoryControlledAgentDefinition,
  loadFreshAgentDefinitions,
  requireAgentDefinitionRoleFingerprint,
} from 'src/tools/AgentTool/loadAgentsDir.js'
import { runAgent } from './runAgent.js'
export type ResumeAgentResult = {
  agentId: string
  description: string
  outputFile: string
}

export type ResumeAgentLaunchPreflight = {
  readonly agentId: string
  readonly selectedAgent: AgentDefinition
  readonly agentContext: SubagentContext
  readonly availableTools: Parameters<typeof runAgent>[0]['availableTools']
  readonly workerPermissionMode: ToolPermissionContext['mode']
}

type ResumeAgentLaunchForTesting = (
  preflight: ResumeAgentLaunchPreflight,
) => Promise<ResumeAgentResult> | ResumeAgentResult

let resumeAgentLaunchForTesting: ResumeAgentLaunchForTesting | undefined

/** @internal Injects the post-policy launch boundary for focused tests. */
export function __setResumeAgentLaunchForTesting(
  launch: ResumeAgentLaunchForTesting | undefined,
): void {
  resumeAgentLaunchForTesting = launch
}

export function resolveAgentDefinitionForResume(
  metadata: AgentSidecarMetadata | null,
  workspace: AgentRoleWorkspace,
  catalog: Pick<
    AgentDefinitionsResult,
    'agentRoleWorkspaceId' | 'activeAgents'
  >,
): { readonly selectedAgent: AgentDefinition; readonly isResumedFork: boolean } {
  if (!metadata) {
    throw new Error(
      'Cannot resume agent: role workspace metadata is missing',
    )
  }

  assertAgentRoleWorkspaceMatches(
    workspace,
    metadata.agentRoleWorkspaceId,
  )
  assertAgentRoleWorkspaceMatches(workspace, catalog.agentRoleWorkspaceId)
  const requireMatchingFingerprint = (
    selectedAgent: AgentDefinition,
  ): AgentDefinition => {
    if (
      metadata.agentRoleFingerprint === undefined ||
      metadata.agentRoleFingerprint !==
        requireAgentDefinitionRoleFingerprint(selectedAgent)
    ) {
      throw new Error(
        `Cannot resume changed agent type '${metadata.agentType}' in workspace ${workspace.id}`,
      )
    }
    return selectedAgent
  }
  if (metadata.agentType === FORK_AGENT.agentType) {
    return {
      selectedAgent: requireMatchingFingerprint(FORK_AGENT),
      isResumedFork: true,
    }
  }
  const selectedAgent = catalog.activeAgents.find(
    agent => agent.agentType === metadata.agentType,
  )
  if (!selectedAgent) {
    throw new Error(
      `Cannot resume agent type '${metadata.agentType}': it is not available in workspace ${workspace.id}`,
    )
  }
  return {
    selectedAgent: requireMatchingFingerprint(selectedAgent),
    isResumedFork: false,
  }
}

export async function resumeAgentBackground({
  agentId,
  prompt,
  toolUseContext,
  canUseTool,
  invokingRequestId,
}: {
  agentId: string
  prompt: string
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  invokingRequestId?: string
}): Promise<ResumeAgentResult> {
  const startTime = Date.now()
  const appState = toolUseContext.getAppState()
  // In-process teammates get a no-op setAppState; setAppStateForTasks
  // reaches the root store so task registration/progress/kill stay visible.
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
  const permissionMode = appState.toolPermissionContext.mode
  const parentSession = requireCurrentRuntimeSession('subagent resume')
  assertAgentRoleWorkspaceMatches(
    parentSession.roleWorkspace,
    toolUseContext.options.agentDefinitions.agentRoleWorkspaceId,
  )
  assertAgentRoleWorkspaceMatches(
    parentSession.roleWorkspace,
    appState.agentDefinitions.agentRoleWorkspaceId,
  )
  const freshCatalog = await loadFreshAgentDefinitions(
    parentSession.roleWorkspace.cwd,
  )

  const [transcript, meta] = await Promise.all([
    getAgentTranscript(asAgentId(agentId)),
    readAgentMetadata(asAgentId(agentId), { strict: true }),
  ])
  if (!transcript) {
    throw new Error(`No transcript found for agent ID: ${agentId}`)
  }
  const { selectedAgent, isResumedFork } = resolveAgentDefinitionForResume(
    meta,
    parentSession.roleWorkspace,
    freshCatalog,
  )
  const repositoryControlledAgent =
    isRepositoryControlledAgentDefinition(selectedAgent)
  const resumedMessages = filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(
      filterUnresolvedToolUses(transcript.messages),
    ),
  )
  const resumedReplacementState = reconstructForSubagentResume(
    toolUseContext.contentReplacementState,
    resumedMessages,
    transcript.contentReplacements,
  )
  // Best-effort: if the original worktree was removed externally, fall back
  // to parent cwd rather than crashing on chdir later.
  const resumedWorktreePath = meta?.worktreePath
    ? await fsp.stat(meta.worktreePath).then(
        s => (s.isDirectory() ? meta.worktreePath : undefined),
        () => {
          logForDebugging(
            `Resumed worktree ${meta.worktreePath} no longer exists; falling back to parent cwd`,
          )
          return undefined
        },
      )
    : undefined
  if (resumedWorktreePath) {
    // Bump mtime so stale-worktree cleanup doesn't delete a just-resumed worktree (#22355)
    const now = new Date()
    await fsp.utimes(resumedWorktreePath, now, now)
  }

  const uiDescription = meta?.description ?? '(resumed)'

  const asyncAgentContext: SubagentContext = {
    agentId,
    parentSessionId: getParentSessionId(),
    agentType: 'subagent' as const,
    subagentName: selectedAgent.agentType,
    isBuiltIn: isBuiltInAgent(selectedAgent),
    invokingRequestId,
    invocationKind: 'resume' as const,
    invocationEmitted: false,
    ...(!repositoryControlledAgent && selectedAgent.memory !== undefined
      ? {
          memoryAuthorization: {
            agentType: selectedAgent.agentType,
            scope: selectedAgent.memory,
          },
        }
      : {}),
  }

  let forkParentSystemPrompt: SystemPrompt | undefined
  if (isResumedFork) {
    if (toolUseContext.renderedSystemPrompt) {
      forkParentSystemPrompt = toolUseContext.renderedSystemPrompt
    } else {
      const mainThreadAgentDefinition = appState.agent
        ? appState.agentDefinitions.activeAgents.find(
            a => a.agentType === appState.agent,
          )
        : undefined
      // DeepImmutable flattens the ReadonlyMap's method signatures into
      // non-callable {} property shapes. The runtime value is a real Map, so
      // view it as a ReadonlyMap to call .keys() (read-only, no behavior
      // change). The DeepImmutable shape doesn't structurally overlap a Map,
      // so route the cast through unknown (mirrors runAgent.ts).
      const additionalWorkingDirectories = Array.from(
        (
          appState.toolPermissionContext
            .additionalWorkingDirectories as unknown as ReadonlyMap<
            string,
            AdditionalWorkingDirectory
          >
        ).keys(),
      )
      const defaultSystemPrompt = await getSystemPrompt(
        toolUseContext.options.tools,
        toolUseContext.options.mainLoopModel,
        additionalWorkingDirectories,
        toolUseContext.options.mcpClients,
      )
      forkParentSystemPrompt = buildEffectiveSystemPrompt({
        mainThreadAgentDefinition,
        toolUseContext,
        customSystemPrompt: toolUseContext.options.customSystemPrompt,
        defaultSystemPrompt,
        appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
      })
    }
    if (!forkParentSystemPrompt) {
      throw new Error(
        'Cannot resume fork agent: unable to reconstruct parent system prompt',
      )
    }
  }

  // Resolve model for request metadata (runAgent resolves its own internally).
  const resolvedAgentModel = getAgentModel(
    repositoryControlledAgent ? undefined : selectedAgent.model,
    toolUseContext.options.mainLoopModel,
    undefined,
    permissionMode,
  )

  // `selectedAgent.permissionMode` is typed with the permissions/types.ts
  // `PermissionMode` union, which carries the internal-only `"unattended"`
  // member absent from the `InternalPermissionMode` that assembleToolPool's
  // ToolPermissionContext requires. The runtime value is unchanged; this
  // assertion only bridges the two near-identical mode unions (mirrors the
  // identical construct in AgentTool.tsx).
  const workerPermissionContext = repositoryControlledAgent
    ? appState.toolPermissionContext
    : {
        ...appState.toolPermissionContext,
        mode: selectedAgent.permissionMode ?? 'acceptEdits',
      } as ToolPermissionContext
  const workerTools = isResumedFork
    ? toolUseContext.options.tools
    : repositoryControlledAgent
      ? toolUseContext.options.tools
      : assembleToolPool(workerPermissionContext, appState.mcp.tools)

  const runAgentParams: Parameters<typeof runAgent>[0] = {
    agentDefinition: selectedAgent,
    promptMessages: [
      ...resumedMessages,
      createUserMessage({ content: prompt }),
    ],
    toolUseContext,
    canUseTool,
    isAsync: true,
    querySource: getQuerySourceForAgent(
      selectedAgent.agentType,
      isBuiltInAgent(selectedAgent),
    ),
    model: undefined,
    // Fork resume: pass parent's system prompt (cache-identical prefix).
    // Non-fork: undefined → runAgent recomputes under wrapWithCwd so
    // getCwd() sees resumedWorktreePath.
    override: isResumedFork
      ? { systemPrompt: forkParentSystemPrompt }
      : undefined,
    availableTools: workerTools,
    // Transcript already contains the parent context slice from the
    // original fork. Re-supplying it would cause duplicate tool_use IDs.
    forkContextMessages: undefined,
    ...(isResumedFork && { useExactTools: true }),
    // Re-persist so metadata survives runAgent's writeAgentMetadata overwrite
    worktreePath: resumedWorktreePath,
    description: meta?.description,
    contentReplacementState: resumedReplacementState,
  }

  if (resumeAgentLaunchForTesting !== undefined) {
    return runWithAgentContext(asyncAgentContext, () => {
      const ambientContext = getAgentContext()
      if (ambientContext?.agentType !== 'subagent') {
        throw new Error('resume launch is missing its subagent context')
      }
      return resumeAgentLaunchForTesting!({
        agentId,
        selectedAgent,
        agentContext: ambientContext,
        availableTools: runAgentParams.availableTools,
        workerPermissionMode: workerPermissionContext.mode,
      })
    })
  }

  // Skip name-registry write — original entry persists from the initial spawn
  const agentBackgroundTask = registerAsyncAgent({
    agentId,
    description: uiDescription,
    prompt,
    selectedAgent,
    setAppState: rootSetAppState,
    toolUseId: toolUseContext.toolUseId,
  })

  const metadata = {
    prompt,
    resolvedAgentModel,
    isBuiltInAgent: isBuiltInAgent(selectedAgent),
    startTime,
    agentType: selectedAgent.agentType,
    isAsync: true,
  }

  const wrapWithCwd = <T>(fn: () => T): T =>
    resumedWorktreePath ? runWithCwdOverride(resumedWorktreePath, fn) : fn()
  void runWithAgentContext(asyncAgentContext, () =>
    wrapWithCwd(() =>
      runAsyncAgentLifecycle({
        taskId: agentBackgroundTask.agentId,
        abortController: agentBackgroundTask.abortController!,
        makeStream: onCacheSafeParams =>
          runAgent({
            ...runAgentParams,
            override: {
              ...runAgentParams.override,
              agentId: asAgentId(agentBackgroundTask.agentId),
              abortController: agentBackgroundTask.abortController!,
            },
            onCacheSafeParams,
          }),
        metadata,
        description: uiDescription,
        toolUseContext,
        rootSetAppState,
        agentIdForCleanup: agentId,
        enableSummarization:
          isCoordinatorMode() ||
          isForkSubagentEnabled() ||
          getSdkAgentProgressSummariesEnabled(),
        getWorktreeResult: async () =>
          resumedWorktreePath ? { worktreePath: resumedWorktreePath } : {},
      }),
    ),
  )
  return {
    agentId,
    description: uiDescription,
    outputFile: getTaskOutputPath(agentId),
  }
}
