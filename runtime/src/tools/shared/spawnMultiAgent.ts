/**
 * Shared spawn module for teammate creation.
 * Extracted from TeammateTool to allow reuse by AgentTool.
 */

import React from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import {
  assertAgentRoleWorkspaceMatches,
  createAgentRoleWorkspace,
  normalizeAgentRoleWorkspace,
} from '../../agents/role.js'
import { canonicalAgentRoleName } from '../../agents/role-presentation.js'
import type { AgentRoleWorkspace } from '../../agents/role.js'
import { requireCurrentRuntimeSession } from '../../session/current-session.js'
import {
  SandboxExecutionError,
  missingSandboxExecutionBoundary,
} from '../../sandbox/execution-broker.js'
import type { AppState } from '../../tui/state/AppState.js'
import { createTaskStateBase, generateTaskId } from '../../tasks/Task.js'
import type { ToolUseContext } from '../Tool.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { formatAgentId } from '../../utils/agentId.js'
import { quote } from '../../utils/bash/shellQuote.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import { getDenyRuleForAgent } from '../../utils/permissions/permissions.js'
import { isTmuxAvailable } from '../../utils/swarm/backends/detection.js'
import {
  detectAndGetBackend,
  getBackendByType,
  isInProcessEnabled,
  markInProcessFallback,
  resetBackendDetection,
} from '../../utils/swarm/backends/registry.js'
import { getTeammateModeFromSnapshot } from '../../utils/swarm/backends/teammateModeSnapshot.js'
import type { BackendType } from '../../utils/swarm/backends/types.js'
import { isPaneBackend } from '../../utils/swarm/backends/types.js'
import {
  SWARM_SESSION_NAME,
  TEAM_LEAD_NAME,
  TMUX_COMMAND,
} from '../../utils/swarm/constants.js'
import { It2SetupPrompt } from '../../utils/swarm/It2SetupPrompt.js'
import { startInProcessTeammate } from '../../utils/swarm/inProcessRunner.js'
import {
  type InProcessSpawnConfig,
  spawnInProcessTeammate,
} from '../../utils/swarm/spawnInProcess.js'
import {
  buildInheritedCliFlags,
  buildInheritedEnvVars,
  getTeammateCommand,
} from '../../utils/swarm/spawnUtils.js'
import {
  getTeamFilePath,
  readTeamFileAsync,
  registerTeamForSessionCleanup,
  sanitizeAgentName,
  sanitizeName,
  writeTeamFileAsync,
} from '../../utils/swarm/teamHelpers.js'
import {
  assignTeammateColor,
  createTeammatePaneInSwarmView,
  enablePaneBorderStatus,
  isInsideTmux,
  sendCommandToPane,
} from '../../utils/swarm/teammateLayoutManager.js'
import { getHardcodedTeammateModelFallback } from '../../utils/swarm/teammateModel.js'
import { registerTask } from '../../utils/task/framework.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import {
  findAgentDefinitionByType,
  loadFreshAgentDefinitions,
  type AgentDefinition,
} from 'src/tools/AgentTool/loadAgentsDir.js'
import { setAgentColor } from 'src/tools/AgentTool/agentColorManager.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'

function getDefaultTeammateModel(leaderModel: string | null): string {
  const configured = getGlobalConfig().teammateDefaultModel
  if (configured === null) {
    // User picked "Default" in the /config picker — follow the leader.
    return leaderModel ?? getHardcodedTeammateModelFallback()
  }
  if (configured !== undefined) {
    return parseUserSpecifiedModel(configured)
  }
  return getHardcodedTeammateModelFallback()
}

/**
 * Resolve a teammate model value. Handles the 'inherit' alias (from agent
 * frontmatter) by substituting the leader's model. gh-31069: 'inherit' was
 * passed literally to --model, producing "It may not exist or you may not
 * have access". If leader model is null (not yet set), falls through to the
 * default.
 *
 * Exported for testing.
 */
export function resolveTeammateModel(
  inputModel: string | undefined,
  leaderModel: string | null,
): string {
  if (inputModel === 'inherit') {
    return leaderModel ?? getDefaultTeammateModel(leaderModel)
  }
  return inputModel ?? getDefaultTeammateModel(leaderModel)
}

// ============================================================================
// Types
// ============================================================================

export type SpawnOutput = {
  teammate_id: string
  agent_id: string
  agent_type?: string
  model?: string
  name: string
  color?: string
  tmux_session_name: string
  tmux_window_name: string
  tmux_pane_id: string
  team_name?: string
  is_splitpane?: boolean
  plan_mode_required?: boolean
}

export type SpawnTeammateConfig = {
  name: string
  prompt: string
  team_name?: string
  cwd?: string
  use_splitpane?: boolean
  plan_mode_required?: boolean
  model?: string
  agent_type?: string
  description?: string
  /** Immutable role authority inherited from the parent session. */
  agent_role_workspace_id: string
  agent_role_workspace_cwd: string
  /** request_id of the API call whose response contained the tool_use that
   *  spawned this teammate. Threaded through to TeammateAgentContext for
   *  lineage tracing on tengu_api_* events. */
  invokingRequestId?: string
}

// Internal input type matching TeammateTool's spawn parameters
type SpawnInput = {
  name: string
  prompt: string
  team_name?: string
  cwd?: string
  use_splitpane?: boolean
  plan_mode_required?: boolean
  model?: string
  agent_type?: string
  description?: string
  agent_role_workspace_id: string
  agent_role_workspace_cwd: string
  invokingRequestId?: string
}

export type SpawnTeammateBackend = (
  input: SpawnTeammateConfig,
  context: ToolUseContext,
) => Promise<{ data: SpawnOutput }>

let spawnTeammateBackendForTesting: SpawnTeammateBackend | undefined

/** @internal Injects the post-policy spawn boundary for focused tests. */
export function __setSpawnTeammateBackendForTesting(
  backend: SpawnTeammateBackend | undefined,
): void {
  spawnTeammateBackendForTesting = backend
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Checks if a tmux session exists
 */
async function hasSession(sessionName: string): Promise<boolean> {
  const result = await execFileNoThrow(TMUX_COMMAND, [
    'has-session',
    '-t',
    sessionName,
  ])
  return result.code === 0
}

/**
 * Creates a new tmux session if it doesn't exist
 */
async function ensureSession(sessionName: string): Promise<void> {
  const exists = await hasSession(sessionName)
  if (!exists) {
    const result = await execFileNoThrow(TMUX_COMMAND, [
      'new-session',
      '-d',
      '-s',
      sessionName,
    ])
    if (result.code !== 0) {
      throw new Error(
        `Failed to create tmux session '${sessionName}': ${result.stderr || 'Unknown error'}`,
      )
    }
  }
}

/**
 * Generates a unique teammate name by checking existing team members.
 * If the name already exists, appends a numeric suffix (e.g., tester-2, tester-3).
 * @internal Exported for testing
 */
export async function generateUniqueTeammateName(
  baseName: string,
  teamName: string | undefined,
): Promise<string> {
  if (!teamName) {
    return baseName
  }

  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    return baseName
  }

  const existingNames = new Set(teamFile.members.map(m => m.name.toLowerCase()))

  // If the base name doesn't exist, use it as-is
  if (!existingNames.has(baseName.toLowerCase())) {
    return baseName
  }

  // Find the next available suffix
  let suffix = 2
  while (existingNames.has(`${baseName}-${suffix}`.toLowerCase())) {
    suffix++
  }

  return `${baseName}-${suffix}`
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Ensures a team file exists on disk. If it doesn't (e.g. when a non-AgenC
 * model skips the TeamCreate step), auto-creates a minimal team file so
 * the spawn can proceed.
 */
async function ensureTeamFileExists(
  teamName: string,
  context: ToolUseContext,
): Promise<import('../../utils/swarm/teamHelpers.js').TeamFile> {
  const existing = await readTeamFileAsync(teamName)
  if (existing) return existing

  // Auto-create the team
  const leadAgentId = formatAgentId(TEAM_LEAD_NAME, teamName)

  const teamFile: import('../../utils/swarm/teamHelpers.js').TeamFile = {
    name: teamName,
    description: `Auto-created team for ${teamName}`,
    createdAt: Date.now(),
    leadAgentId,
    leadSessionId: getSessionId(),
    members: [
      {
        agentId: leadAgentId,
        name: TEAM_LEAD_NAME,
        agentType: TEAM_LEAD_NAME,
        joinedAt: Date.now(),
        tmuxPaneId: '',
        cwd: getCwd(),
        subscriptions: [],
      },
    ],
  }

  await writeTeamFileAsync(teamName, teamFile)
  registerTeamForSessionCleanup(teamName)

  // Update AppState so the rest of the session is team-aware
  context.setAppState(prev => ({
    ...prev,
    teamContext: {
      ...prev.teamContext,
      teamName,
      teamFilePath: getTeamFilePath(teamName),
      leadAgentId,
      teammates: {
        ...(prev.teamContext?.teammates || {}),
        [leadAgentId]: {
          name: TEAM_LEAD_NAME,
          agentType: TEAM_LEAD_NAME,
          color: assignTeammateColor(leadAgentId),
          tmuxSessionName: '',
          tmuxPaneId: '',
          cwd: getCwd(),
          spawnedAt: Date.now(),
        },
      },
    },
  }))

  logForDebugging(
    `[spawnMultiAgent] Auto-created team "${teamName}" (team file was missing)`,
  )

  return teamFile
}

// ============================================================================
// Spawn Handlers
// ============================================================================

/**
 * Handle spawn operation using split-pane view (default).
 * When inside tmux: Creates teammates in a shared window with leader on left, teammates on right.
 * When outside tmux: Creates a agenc-swarm session with all teammates in a tiled layout.
 */
async function handleSpawnSplitPane(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, cwd, plan_mode_required } = input

  // Resolve model: 'inherit' → leader's model; undefined → default Opus
  const model = resolveTeammateModel(input.model, getAppState().mainLoopModel)

  if (!name || !prompt) {
    throw new Error('name and prompt are required for spawn operation')
  }

  // Get team name from input or inherit from leader's team context
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'team_name is required for spawn operation. Either provide team_name in input or call spawnTeam first to establish team context.',
    )
  }

  // Generate unique name if duplicate exists in team
  const uniqueName = await generateUniqueTeammateName(name, teamName)

  // Sanitize the name to prevent @ in agent IDs (would break agentName@teamName format)
  const sanitizedName = sanitizeAgentName(uniqueName)

  // Generate deterministic agent ID from name and team
  const teammateId = formatAgentId(sanitizedName, teamName)
  const workingDir = cwd || getCwd()

  // Detect the appropriate backend and check if setup is needed
  let detectionResult = await detectAndGetBackend()

  // If in iTerm2 but it2 isn't set up, prompt the user
  if (detectionResult.needsIt2Setup && context.setToolJSX) {
    const tmuxAvailable = await isTmuxAvailable()

    // Show the setup prompt and wait for user decision
    const setupResult = await new Promise<
      'installed' | 'use-tmux' | 'cancelled'
    >(resolve => {
      context.setToolJSX!({
        jsx: React.createElement(It2SetupPrompt, {
          onDone: resolve,
          tmuxAvailable,
        }),
        shouldHidePromptInput: true,
      })
    })

    // Clear the JSX
    context.setToolJSX(null)

    if (setupResult === 'cancelled') {
      throw new Error('Teammate spawn cancelled - iTerm2 setup required')
    }

    // If they installed it2 or chose tmux, clear cached detection and re-fetch
    // so the local detectionResult matches the backend that will actually
    // spawn the pane.
    // - 'installed': re-detect to pick up the ITermBackend (it2 is now available)
    // - 'use-tmux': re-detect so needsIt2Setup is false (preferTmux is now saved)
    //   and subsequent spawns skip this prompt
    if (setupResult === 'installed' || setupResult === 'use-tmux') {
      resetBackendDetection()
      detectionResult = await detectAndGetBackend()
    }
  }

  // Check if we're inside tmux to determine session naming
  const insideTmux = await isInsideTmux()

  // Assign a unique color to this teammate
  const teammateColor = assignTeammateColor(teammateId)

  // Create a pane in the swarm view
  // - Inside tmux: splits current window (leader on left, teammates on right)
  // - In iTerm2 with it2: uses native iTerm2 split panes
  // - Outside both: creates agenc-swarm session with tiled teammates
  const { paneId, isFirstTeammate } = await createTeammatePaneInSwarmView(
    sanitizedName,
    teammateColor,
  )

  // Enable pane border status on first teammate when inside tmux
  // (outside tmux, this is handled in createTeammatePaneInSwarmView)
  if (isFirstTeammate && insideTmux) {
    await enablePaneBorderStatus()
  }

  // Build the command to spawn AgenC with teammate identity
  // Note: We spawn without a prompt - initial instructions are sent via mailbox
  const binaryPath = getTeammateCommand()

  // Build teammate identity CLI args (replaces AGENC_* env vars)
  const teammateArgs = [
    `--agent-id ${quote([teammateId])}`,
    `--agent-name ${quote([sanitizedName])}`,
    `--team-name ${quote([teamName])}`,
    `--agent-color ${quote([teammateColor])}`,
    `--parent-session-id ${quote([getSessionId()])}`,
    plan_mode_required ? '--plan-mode-required' : '',
    agent_type ? `--agent-type ${quote([agent_type])}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  // Build CLI flags to propagate to teammate
  // Pass plan_mode_required to prevent inheriting bypass permissions
  const inheritedFlags = buildInheritedCliFlags({
    planModeRequired: plan_mode_required,
    permissionMode: appState.toolPermissionContext.mode,
    model,
  })

  const flagsStr = inheritedFlags ? ` ${inheritedFlags}` : ''
  // Propagate env vars that teammates need but may not inherit from tmux split-window shells.
  // Includes AGENCCODE, AGENC_EXPERIMENTAL_AGENT_TEAMS, and API provider vars.
  const envStr = buildInheritedEnvVars()
  const spawnCommand = `cd ${quote([workingDir])} && env ${envStr} ${quote([binaryPath])} ${teammateArgs}${flagsStr}`

  // Send the command to the new pane
  // Use swarm socket when running outside tmux (external swarm session)
  await sendCommandToPane(paneId, spawnCommand, !insideTmux)

  // Determine session/window names for output
  const sessionName = insideTmux ? 'current' : SWARM_SESSION_NAME
  const windowName = insideTmux ? 'current' : 'swarm-view'

  // Track the teammate in AppState's teamContext with color
  // If spawning without spawnTeam, set up the leader as team lead
  setAppState(prev => ({
    ...prev,
    teamContext: {
      ...prev.teamContext,
      teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
      teamFilePath: prev.teamContext?.teamFilePath ?? '',
      leadAgentId: prev.teamContext?.leadAgentId ?? '',
      teammates: {
        ...(prev.teamContext?.teammates || {}),
        [teammateId]: {
          name: sanitizedName,
          agentType: agent_type,
          color: teammateColor,
          tmuxSessionName: sessionName,
          tmuxPaneId: paneId,
          cwd: workingDir,
          spawnedAt: Date.now(),
        },
      },
    },
  }))

  // Register background task so teammates appear in the tasks pill/dialog
  registerOutOfProcessTeammateTask(setAppState, {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux,
    backendType: detectionResult.backend.type,
    toolUseId: context.toolUseId,
  })

  // Register agent in the team file (auto-create if missing)
  const teamFile = await ensureTeamFileExists(teamName, context)
  teamFile.members.push({
    agentId: teammateId,
    name: sanitizedName,
    agentType: agent_type,
    model,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required,
    joinedAt: Date.now(),
    tmuxPaneId: paneId,
    cwd: workingDir,
    subscriptions: [],
    backendType: detectionResult.backend.type,
  })
  await writeTeamFileAsync(teamName, teamFile)

  // Send initial instructions to teammate via mailbox
  // The teammate's inbox poller will pick this up and submit it as their first turn
  await writeToMailbox(
    sanitizedName,
    {
      from: TEAM_LEAD_NAME,
      text: prompt,
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: sessionName,
      tmux_window_name: windowName,
      tmux_pane_id: paneId,
      team_name: teamName,
      is_splitpane: true,
      plan_mode_required,
    },
  }
}

/**
 * Handle spawn operation using separate windows (compatibility behavior).
 * Creates each teammate in its own tmux window.
 */
async function handleSpawnSeparateWindow(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, cwd, plan_mode_required } = input

  // Resolve model: 'inherit' → leader's model; undefined → default Opus
  const model = resolveTeammateModel(input.model, getAppState().mainLoopModel)

  if (!name || !prompt) {
    throw new Error('name and prompt are required for spawn operation')
  }

  // Get team name from input or inherit from leader's team context
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'team_name is required for spawn operation. Either provide team_name in input or call spawnTeam first to establish team context.',
    )
  }

  // Generate unique name if duplicate exists in team
  const uniqueName = await generateUniqueTeammateName(name, teamName)

  // Sanitize the name to prevent @ in agent IDs (would break agentName@teamName format)
  const sanitizedName = sanitizeAgentName(uniqueName)

  // Generate deterministic agent ID from name and team
  const teammateId = formatAgentId(sanitizedName, teamName)
  const windowName = `teammate-${sanitizeName(sanitizedName)}`
  const workingDir = cwd || getCwd()

  // Ensure the swarm session exists
  await ensureSession(SWARM_SESSION_NAME)

  // Assign a unique color to this teammate
  const teammateColor = assignTeammateColor(teammateId)

  // Create a new window for this teammate
  const createWindowResult = await execFileNoThrow(TMUX_COMMAND, [
    'new-window',
    '-t',
    SWARM_SESSION_NAME,
    '-n',
    windowName,
    '-P',
    '-F',
    '#{pane_id}',
  ])

  if (createWindowResult.code !== 0) {
    throw new Error(
      `Failed to create tmux window: ${createWindowResult.stderr}`,
    )
  }

  const paneId = createWindowResult.stdout.trim()

  // Build the command to spawn AgenC with teammate identity
  // Note: We spawn without a prompt - initial instructions are sent via mailbox
  const binaryPath = getTeammateCommand()

  // Build teammate identity CLI args (replaces AGENC_* env vars)
  const teammateArgs = [
    `--agent-id ${quote([teammateId])}`,
    `--agent-name ${quote([sanitizedName])}`,
    `--team-name ${quote([teamName])}`,
    `--agent-color ${quote([teammateColor])}`,
    `--parent-session-id ${quote([getSessionId()])}`,
    plan_mode_required ? '--plan-mode-required' : '',
    agent_type ? `--agent-type ${quote([agent_type])}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  // Build CLI flags to propagate to teammate
  // Pass plan_mode_required to prevent inheriting bypass permissions
  const inheritedFlags = buildInheritedCliFlags({
    planModeRequired: plan_mode_required,
    permissionMode: appState.toolPermissionContext.mode,
    model,
  })

  const flagsStr = inheritedFlags ? ` ${inheritedFlags}` : ''
  // Propagate env vars that teammates need but may not inherit from tmux split-window shells.
  // Includes AGENCCODE, AGENC_EXPERIMENTAL_AGENT_TEAMS, and API provider vars.
  const envStr = buildInheritedEnvVars()
  const spawnCommand = `cd ${quote([workingDir])} && env ${envStr} ${quote([binaryPath])} ${teammateArgs}${flagsStr}`

  // Send the command to the new window
  const sendKeysResult = await execFileNoThrow(TMUX_COMMAND, [
    'send-keys',
    '-t',
    `${SWARM_SESSION_NAME}:${windowName}`,
    spawnCommand,
    'Enter',
  ])

  if (sendKeysResult.code !== 0) {
    throw new Error(
      `Failed to send command to tmux window: ${sendKeysResult.stderr}`,
    )
  }

  // Track the teammate in AppState's teamContext
  setAppState(prev => ({
    ...prev,
    teamContext: {
      ...prev.teamContext,
      teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
      teamFilePath: prev.teamContext?.teamFilePath ?? '',
      leadAgentId: prev.teamContext?.leadAgentId ?? '',
      teammates: {
        ...(prev.teamContext?.teammates || {}),
        [teammateId]: {
          name: sanitizedName,
          agentType: agent_type,
          color: teammateColor,
          tmuxSessionName: SWARM_SESSION_NAME,
          tmuxPaneId: paneId,
          cwd: workingDir,
          spawnedAt: Date.now(),
        },
      },
    },
  }))

  // Register background task so tmux teammates appear in the tasks pill/dialog
  // Separate window spawns are always outside tmux (external swarm session)
  registerOutOfProcessTeammateTask(setAppState, {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux: false,
    backendType: 'tmux',
    toolUseId: context.toolUseId,
  })

  // Register agent in the team file (auto-create if missing)
  const teamFile = await ensureTeamFileExists(teamName, context)
  teamFile.members.push({
    agentId: teammateId,
    name: sanitizedName,
    agentType: agent_type,
    model,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required,
    joinedAt: Date.now(),
    tmuxPaneId: paneId,
    cwd: workingDir,
    subscriptions: [],
    backendType: 'tmux', // This handler always uses tmux directly
  })
  await writeTeamFileAsync(teamName, teamFile)

  // Send initial instructions to teammate via mailbox
  // The teammate's inbox poller will pick this up and submit it as their first turn
  await writeToMailbox(
    sanitizedName,
    {
      from: TEAM_LEAD_NAME,
      text: prompt,
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: SWARM_SESSION_NAME,
      tmux_window_name: windowName,
      tmux_pane_id: paneId,
      team_name: teamName,
      is_splitpane: false,
      plan_mode_required,
    },
  }
}

/**
 * Register a background task entry for an out-of-process (tmux/iTerm2) teammate.
 * This makes tmux teammates visible in the background tasks pill and dialog,
 * matching how in-process teammates are tracked.
 */
function registerOutOfProcessTeammateTask(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux,
    backendType,
    toolUseId,
  }: {
    teammateId: string
    sanitizedName: string
    teamName: string
    teammateColor: string
    prompt: string
    plan_mode_required?: boolean
    paneId: string
    insideTmux: boolean
    backendType: BackendType
    toolUseId?: string
  },
): void {
  const taskId = generateTaskId('in_process_teammate')
  const description = `${sanitizedName}: ${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}`

  const abortController = new AbortController()

  const taskState: InProcessTeammateTaskState = {
    ...createTaskStateBase(
      taskId,
      'in_process_teammate',
      description,
      toolUseId,
    ),
    type: 'in_process_teammate',
    status: 'running',
    identity: {
      agentId: teammateId,
      agentName: sanitizedName,
      teamName,
      color: teammateColor,
      planModeRequired: plan_mode_required ?? false,
      parentSessionId: getSessionId(),
    },
    prompt,
    abortController,
    awaitingPlanApproval: false,
    permissionMode: plan_mode_required ? 'plan' : 'default',
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    pendingUserMessages: [],
  }

  registerTask(taskState, setAppState)

  // When abort is signaled, kill the pane using the backend that created it
  // (tmux kill-pane for tmux panes, it2 session close for iTerm2 native panes).
  // SDK task_notification bookend is emitted by killInProcessTeammate (the
  // sole abort trigger for this controller).
  abortController.signal.addEventListener(
    'abort',
    () => {
      if (isPaneBackend(backendType)) {
        void getBackendByType(backendType).killPane(paneId, !insideTmux)
      }
    },
    { once: true },
  )
}

/**
 * Handle spawn operation for in-process teammates.
 * In-process teammates run in the same Node.js process using AsyncLocalStorage.
 */
async function handleSpawnInProcess(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, plan_mode_required } = input

  // Resolve model: 'inherit' → leader's model; undefined → default Opus
  const model = resolveTeammateModel(input.model, getAppState().mainLoopModel)

  if (!name || !prompt) {
    throw new Error('name and prompt are required for spawn operation')
  }

  // Get team name from input or inherit from leader's team context
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'team_name is required for spawn operation. Either provide team_name in input or call spawnTeam first to establish team context.',
    )
  }

  // Generate unique name if duplicate exists in team
  const uniqueName = await generateUniqueTeammateName(name, teamName)

  // Sanitize the name to prevent @ in agent IDs
  const sanitizedName = sanitizeAgentName(uniqueName)

  // Generate deterministic agent ID from name and team
  const teammateId = formatAgentId(sanitizedName, teamName)

  // Assign a unique color to this teammate
  const teammateColor = assignTeammateColor(teammateId)

  // Look up the already workspace-validated definition if agent_type is provided.
  let agentDefinition: AgentDefinition | undefined
  if (agent_type) {
    const allAgents = context.options.agentDefinitions.activeAgents
    agentDefinition = findAgentDefinitionByType(allAgents, agent_type)
    if (agentDefinition === undefined) {
      throw new Error(`Agent type '${agent_type}' not found for teammate spawn`)
    }
    logForDebugging(
      `[handleSpawnInProcess] agent_type=${agent_type}, found=${!!agentDefinition}`,
    )
  }

  // Spawn in-process teammate
  const config: InProcessSpawnConfig = {
    name: sanitizedName,
    teamName,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required ?? false,
    model,
    permissionMode: agentDefinition?.permissionMode,
  }

  const result = await spawnInProcessTeammate(config, context)

  if (!result.success) {
    throw new Error(result.error ?? 'Failed to spawn in-process teammate')
  }

  // Debug: log what spawn returned
  logForDebugging(
    `[handleSpawnInProcess] spawn result: taskId=${result.taskId}, hasContext=${!!result.teammateContext}, hasAbort=${!!result.abortController}`,
  )

  // Start the agent execution loop (fire-and-forget)
  if (result.taskId && result.teammateContext && result.abortController) {
    startInProcessTeammate({
      identity: {
        agentId: teammateId,
        agentName: sanitizedName,
        teamName,
        color: teammateColor,
        planModeRequired: plan_mode_required ?? false,
        parentSessionId: result.teammateContext.parentSessionId,
      },
      taskId: result.taskId,
      prompt,
      description: input.description,
      model,
      agentDefinition,
      teammateContext: result.teammateContext,
      // Strip messages: the teammate never reads toolUseContext.messages
      // (it builds its own history via allMessages in inProcessRunner).
      // Passing the parent's full conversation here would pin it for the
      // teammate's lifetime, surviving /clear and auto-compact.
      toolUseContext: { ...context, messages: [] },
      abortController: result.abortController,
      invokingRequestId: input.invokingRequestId,
    })
    logForDebugging(
      `[handleSpawnInProcess] Started agent execution for ${teammateId}`,
    )
  }

  // Track the teammate in AppState's teamContext
  // Auto-register leader if spawning without prior spawnTeam call
  setAppState(prev => {
    const needsLeaderSetup = !prev.teamContext?.leadAgentId
    const leadAgentId = needsLeaderSetup
      ? formatAgentId(TEAM_LEAD_NAME, teamName)
      : prev.teamContext!.leadAgentId

    // Build teammates map, including leader if needed for inbox polling
    const existingTeammates = prev.teamContext?.teammates || {}
    const leadEntry = needsLeaderSetup
      ? {
          [leadAgentId]: {
            name: TEAM_LEAD_NAME,
            agentType: TEAM_LEAD_NAME,
            color: assignTeammateColor(leadAgentId),
            tmuxSessionName: 'in-process',
            tmuxPaneId: 'leader',
            cwd: getCwd(),
            spawnedAt: Date.now(),
          },
        }
      : {}

    return {
      ...prev,
      teamContext: {
        ...prev.teamContext,
        teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
        teamFilePath: prev.teamContext?.teamFilePath ?? '',
        leadAgentId,
        teammates: {
          ...existingTeammates,
          ...leadEntry,
          [teammateId]: {
            name: sanitizedName,
            agentType: agent_type,
            color: teammateColor,
            tmuxSessionName: 'in-process',
            tmuxPaneId: 'in-process',
            cwd: getCwd(),
            spawnedAt: Date.now(),
          },
        },
      },
    }
  })

  // Register agent in the team file (auto-create if missing)
  const teamFile = await ensureTeamFileExists(teamName, context)
  teamFile.members.push({
    agentId: teammateId,
    name: sanitizedName,
    agentType: agent_type,
    model,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required,
    joinedAt: Date.now(),
    tmuxPaneId: 'in-process',
    cwd: getCwd(),
    subscriptions: [],
    backendType: 'in-process',
  })
  await writeTeamFileAsync(teamName, teamFile)

  // Note: Do NOT send the prompt via mailbox for in-process teammates.
  // In-process teammates receive the prompt directly via startInProcessTeammate().
  // The mailbox is only needed for tmux-based teammates which poll for their initial message.
  // Sending via both paths would cause duplicate welcome messages.

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: 'in-process',
      tmux_window_name: 'in-process',
      tmux_pane_id: 'in-process',
      team_name: teamName,
      is_splitpane: false,
      plan_mode_required,
    },
  }
}

/**
 * Handle spawn operation - creates a new AgenC instance.
 * Uses in-process mode when enabled, otherwise uses tmux/iTerm2 split-pane view.
 * Falls back to in-process if pane backend detection fails (e.g., iTerm2 without
 * it2 CLI or tmux installed).
 */
async function handleSpawn(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  // Check if in-process mode is enabled via feature flag
  if (isInProcessEnabled()) {
    return handleSpawnInProcess(input, context)
  }

  // Pre-flight: ensure a pane backend is available before attempting pane-based spawn.
  // This handles auto-mode cases like iTerm2 without it2 or tmux installed, where
  // isInProcessEnabled() returns false but detectAndGetBackend() has no viable backend.
  // Narrowly scoped so user cancellation and other spawn errors propagate normally.
  try {
    await detectAndGetBackend()
  } catch (error) {
    // Only fall back silently in auto mode. If the user explicitly configured
    // teammateMode: 'tmux', let the error propagate so they see the actionable
    // install instructions from getTmuxInstallInstructions().
    if (getTeammateModeFromSnapshot() !== 'auto') {
      throw error
    }
    logForDebugging(
      `[handleSpawn] No pane backend available, falling back to in-process: ${errorMessage(error)}`,
    )
    // Record the fallback so isInProcessEnabled() reflects the actual mode
    // (fixes banner and other UI that would otherwise show tmux attach commands).
    markInProcessFallback()
    return handleSpawnInProcess(input, context)
  }

  // Backend is available (and now cached) - proceed with pane spawning.
  // Any errors here (user cancellation, validation, etc.) propagate to the caller.
  const useSplitPane = input.use_splitpane !== false
  if (useSplitPane) {
    return handleSpawnSplitPane(input, context)
  }
  return handleSpawnSeparateWindow(input, context)
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Spawns a new teammate with the given configuration.
 * This is the main entry point for teammate spawning, used by both TeammateTool and AgentTool.
 */
export async function spawnTeammate(
  config: SpawnTeammateConfig,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  let effectiveContext = context
  let effectiveConfig = config
  const parentSession = requireCurrentRuntimeSession('teammate spawn')
  let inProcess = isInProcessEnabled()
  const sandboxExecutionBroker = parentSession.services.sandboxExecutionBroker
  if (sandboxExecutionBroker === undefined) {
    throw missingSandboxExecutionBoundary(
      inProcess ? 'child_agent' : 'pane_agent',
    )
  }
  if (
    sandboxExecutionBroker.required &&
    !inProcess &&
    getTeammateModeFromSnapshot() === 'auto'
  ) {
    // Restricted auto mode has a safe backend available. Select it before
    // workspace/provenance validation rather than rejecting a pane backend
    // that the operator never explicitly requested.
    markInProcessFallback()
    inProcess = true
  }
  const readiness = sandboxExecutionBroker.assertReady(
    inProcess ? 'child_agent' : 'pane_agent',
  )
  if (sandboxExecutionBroker.required && !inProcess) {
    throw new SandboxExecutionError({
      code: 'sandbox_surface_uncovered',
      surface: 'pane_agent',
      status: {
        ...readiness,
        reason:
          'pane-backed teammates launch through a terminal server outside the session sandbox',
        remediation:
          'Use in-process teammate mode while restricted sandboxing is enabled, or select danger-full-access explicitly when host pane execution is intended.',
      },
    })
  }
  assertTeammateSpawnRoleWorkspace({
    parentWorkspace: parentSession.roleWorkspace,
    suppliedWorkspaceId: config.agent_role_workspace_id,
    suppliedWorkspaceCwd: config.agent_role_workspace_cwd,
    catalogWorkspaceId:
      context.options.agentDefinitions.agentRoleWorkspaceId,
    executionCwd: config.cwd ?? getCwd(),
    inProcess,
  })
  assertAgentRoleWorkspaceMatches(
    parentSession.roleWorkspace,
    context.getAppState().agentDefinitions.agentRoleWorkspaceId,
  )
  if (config.agent_type) {
    const freshCatalog = await loadFreshAgentDefinitions(
      parentSession.roleWorkspace.cwd,
    )
    assertAgentRoleWorkspaceMatches(
      parentSession.roleWorkspace,
      freshCatalog.agentRoleWorkspaceId,
    )
    const selected = findAgentDefinitionByType(
      freshCatalog.activeAgents,
      config.agent_type,
    )
    if (selected === undefined) {
      throw new Error(`Agent type '${config.agent_type}' not found for teammate spawn`)
    }
    const allowedAgentTypes =
      context.options.agentDefinitions.allowedAgentTypes
    if (
      allowedAgentTypes !== undefined &&
      !allowedAgentTypes.some(allowedType =>
        allowedType === selected.agentType ||
        (selected.agentType !== config.agent_type &&
          canonicalAgentRoleName(allowedType) ===
            canonicalAgentRoleName(selected.agentType)),
      )
    ) {
      throw new Error(`Agent type '${config.agent_type}' not found for teammate spawn`)
    }
    const permissionContext = context.getAppState().toolPermissionContext
    const denyRule =
      getDenyRuleForAgent(
        permissionContext,
        AGENT_TOOL_NAME,
        config.agent_type,
      ) ??
      (selected.agentType !== config.agent_type
        ? getDenyRuleForAgent(
            permissionContext,
            AGENT_TOOL_NAME,
            selected.agentType,
          )
        : null)
    if (denyRule !== null) {
      throw new Error(
        `Agent type '${config.agent_type}' has been denied by permission rule '${AGENT_TOOL_NAME}(${denyRule.ruleValue.ruleContent ?? config.agent_type})' from ${denyRule.source ?? 'settings'}.`,
      )
    }
    // Pane processes currently have no startup protocol that carries the
    // immutable role workspace, exact definition fingerprint, prompt, tool
    // restrictions, permission mode, and memory policy. `--agent-type` is not
    // a supported bootstrap contract, so allowing this path would validate one
    // role in the parent and execute an unrestricted/default role in the child.
    // Fail closed until the complete provenance envelope can be consumed by
    // the spawned process. In-process teammates inherit the validated catalog.
    if (!isInProcessEnabled()) {
      throw new Error(
        `Agent type '${config.agent_type}' requires in-process teammate mode; pane teammates cannot enforce exact agent-role provenance`,
      )
    }
    if (selected.color) {
      setAgentColor(selected.agentType, selected.color)
    }
    effectiveConfig = {
      ...config,
      model: config.model ?? selected.model,
    }
    effectiveContext = {
      ...context,
      options: {
        ...context.options,
        agentDefinitions: {
          ...context.options.agentDefinitions,
          activeAgents: freshCatalog.activeAgents,
        },
      },
    }
  }
  return (spawnTeammateBackendForTesting ?? handleSpawn)(
    effectiveConfig,
    effectiveContext,
  )
}

export function assertTeammateSpawnRoleWorkspace(opts: {
  readonly parentWorkspace: AgentRoleWorkspace
  readonly suppliedWorkspaceId: string
  readonly suppliedWorkspaceCwd: string
  readonly catalogWorkspaceId?: string
  readonly executionCwd: string
  readonly inProcess: boolean
}): void {
  const suppliedWorkspace = normalizeAgentRoleWorkspace({
    id: opts.suppliedWorkspaceId,
    cwd: opts.suppliedWorkspaceCwd,
  })
  assertAgentRoleWorkspaceMatches(opts.parentWorkspace, suppliedWorkspace.id)
  assertAgentRoleWorkspaceMatches(
    opts.parentWorkspace,
    opts.catalogWorkspaceId,
  )

  // Pane teammates bootstrap role authority from their process cwd. Until the
  // daemon protocol has a separate role-workspace field, reject a pane spawn
  // whose execution cwd would select a different trust domain. In-process
  // teammates inherit the already-validated parent context.
  const executionWorkspace = createAgentRoleWorkspace(opts.executionCwd)
  if (!opts.inProcess && executionWorkspace.id !== suppliedWorkspace.id) {
    throw new Error(
      `teammate execution cwd ${executionWorkspace.cwd} does not match role workspace ${suppliedWorkspace.cwd}`,
    )
  }
}
