import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAgentRoleWorkspace } from '../../../src/agents/role.js'
import { runWithCurrentRuntimeSession } from '../../../src/session/current-session.js'
import type { Session } from '../../../src/session/session.js'
import {
  __setPluginAgentsLoaderForTesting,
  clearAgentDefinitionsCache,
  type AgentDefinition,
} from '../../../src/tools/AgentTool/loadAgentsDir.js'
import {
  __setSpawnTeammateBackendForTesting,
  assertTeammateSpawnRoleWorkspace,
  spawnTeammate,
  type SpawnTeammateBackend,
  type SpawnTeammateConfig,
} from '../../../src/tools/shared/spawnMultiAgent.js'
import type { ToolUseContext } from '../../../src/tools/Tool.js'
import { getDefaultAppState } from '../../../src/tui/state/AppStateStore.js'
import { setIsInteractive } from '../../../src/bootstrap/state.js'
import {
  SandboxExecutionBroker,
  type SandboxExecutionBrokerLike,
} from '../../../src/sandbox/execution-broker.js'
import { explicitDangerBroker } from '../../helpers/explicit-danger-boundary.js'
import {
  captureTeammateModeSnapshot,
  clearCliTeammateModeOverride,
  setCliTeammateModeOverride,
} from '../../../src/utils/swarm/backends/teammateModeSnapshot.js'
import {
  isInProcessEnabled,
  resetBackendDetection,
} from '../../../src/utils/swarm/backends/registry.js'
import { resetDetectionCache } from '../../../src/utils/swarm/backends/detection.js'

const roots: string[] = []

afterEach(() => {
  __setSpawnTeammateBackendForTesting(undefined)
  __setPluginAgentsLoaderForTesting(undefined)
  clearAgentDefinitionsCache()
  clearCliTeammateModeOverride('auto')
  setIsInteractive(false)
  vi.unstubAllEnvs()
  resetBackendDetection()
  resetDetectionCache()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempWorkspace(label: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `agenc-${label}-`))
  roots.push(workspace)
  return workspace
}

function contextFor(
  workspace: string,
  activeAgents: AgentDefinition[] = [],
  deniedAgentTypes: string[] = [],
): ToolUseContext {
  const agentDefinitions = {
    agentRoleWorkspaceId: createAgentRoleWorkspace(workspace).id,
    activeAgents,
    allAgents: activeAgents,
  }
  const defaultState = getDefaultAppState()
  const appState = {
    ...defaultState,
    mainLoopModel: 'leader-model',
    agentDefinitions,
    toolPermissionContext: {
      ...defaultState.toolPermissionContext,
      alwaysDenyRules: deniedAgentTypes.length === 0
        ? {}
        : {
            projectSettings: deniedAgentTypes.map(
              agentType => `spawn_agent(${agentType})`,
            ),
          },
    },
  }
  return {
    options: {
      agentDefinitions,
      tools: [],
      mainLoopModel: 'leader-model',
      mcpClients: [],
    },
    getAppState: () => appState,
    setAppState: vi.fn(),
  } as unknown as ToolUseContext
}

function configFor(
  workspace: string,
  agentType: string,
): SpawnTeammateConfig {
  const roleWorkspace = createAgentRoleWorkspace(workspace)
  return {
    name: 'boundary-worker',
    prompt: 'Exercise the public teammate spawn boundary.',
    team_name: 'boundary-team',
    cwd: workspace,
    agent_type: agentType,
    agent_role_workspace_id: roleWorkspace.id,
    agent_role_workspace_cwd: roleWorkspace.cwd,
  }
}

function sessionFor(
  workspace: string,
  sandboxExecutionBroker: SandboxExecutionBrokerLike = explicitDangerBroker,
): Session {
  return {
    roleWorkspace: createAgentRoleWorkspace(workspace),
    services: { admissionRequired: false, sandboxExecutionBroker },
  } as unknown as Session
}

function successfulBackend(
  inspect: (
    config: SpawnTeammateConfig,
    context: ToolUseContext,
  ) => void,
): SpawnTeammateBackend {
  return async (config, context) => {
    inspect(config, context)
    return {
      data: {
        teammate_id: 'boundary-worker@boundary-team',
        agent_id: 'boundary-worker@boundary-team',
        agent_type: config.agent_type,
        model: config.model,
        name: config.name,
        tmux_session_name: 'test',
        tmux_window_name: 'test',
        tmux_pane_id: 'test',
      },
    }
  }
}

describe('teammate role workspace preflight', () => {
  const workspaceA = createAgentRoleWorkspace('/workspace/a')

  it.each([
    { label: 'in-process', mode: 'in-process' as const },
    { label: 'pane', mode: 'tmux' as const },
  ])(
    'fails closed before the retired $label spawn backend under required admission',
    async ({ mode }) => {
      const workspace = tempWorkspace(`teammate-admission-${mode}`)
      setCliTeammateModeOverride(mode)
      captureTeammateModeSnapshot()
      const backend = vi.fn(successfulBackend(() => {
        throw new Error('legacy teammate backend must not run under admission')
      }))
      __setSpawnTeammateBackendForTesting(backend)
      const session = sessionFor(workspace)
      Object.assign(session.services, {
        admissionRequired: true,
        executionAdmission: {},
      })

      await expect(
        runWithCurrentRuntimeSession(session, () =>
          spawnTeammate(
            configFor(workspace, 'general-purpose'),
            contextFor(workspace),
          ),
        ),
      ).rejects.toMatchObject({
        code: 'ADMISSION_DENIED',
        decision: 'deny',
        reason: 'legacy_team_spawn_admission_unsupported',
      })
      expect(backend).not.toHaveBeenCalled()
    },
  )

  it('rejects a pane teammate before spawn when execution cwd changes authority', () => {
    expect(() =>
      assertTeammateSpawnRoleWorkspace({
        parentWorkspace: workspaceA,
        suppliedWorkspaceId: workspaceA.id,
        suppliedWorkspaceCwd: workspaceA.cwd,
        catalogWorkspaceId: workspaceA.id,
        executionCwd: '/workspace/b',
        inProcess: false,
      }),
    ).toThrow('does not match role workspace')
  })

  it('allows in-process execution to inherit the validated parent authority', () => {
    expect(() =>
      assertTeammateSpawnRoleWorkspace({
        parentWorkspace: workspaceA,
        suppliedWorkspaceId: workspaceA.id,
        suppliedWorkspaceCwd: workspaceA.cwd,
        catalogWorkspaceId: workspaceA.id,
        executionCwd: '/workspace/b',
        inProcess: true,
      }),
    ).not.toThrow()
  })

  it('rejects a foreign or unscoped catalog for every backend', () => {
    for (const catalogWorkspaceId of ['/workspace/b', undefined]) {
      expect(() =>
        assertTeammateSpawnRoleWorkspace({
          parentWorkspace: workspaceA,
          suppliedWorkspaceId: workspaceA.id,
          suppliedWorkspaceCwd: workspaceA.cwd,
          catalogWorkspaceId,
          executionCwd: workspaceA.cwd,
          inProcess: true,
        }),
      ).toThrow(/workspace (mismatch|provenance is missing)/)
    }
  })

  it('fresh-loads repository role guidance and deny restrictions without authority fields', async () => {
    const workspace = tempWorkspace('teammate-fresh-model')
    const agentsDir = join(workspace, '.agenc', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    const rolePath = join(agentsDir, 'boundary-worker.md')
    writeFileSync(
      rolePath,
      `---
name: boundary-worker
description: Stale cached definition
model: stale-model
permissionMode: default
---
Stale prompt.
`,
    )
    __setPluginAgentsLoaderForTesting(async () => [])
    const staleDefinition: AgentDefinition = {
      agentType: 'boundary-worker',
      whenToUse: 'Stale cached role',
      source: 'projectSettings',
      baseDir: agentsDir,
      model: 'stale-model',
      permissionMode: 'default',
      getSystemPrompt: () => 'Stale prompt.',
    }
    const context = contextFor(workspace, [staleDefinition])
    writeFileSync(
      rolePath,
      `---
name: boundary-worker
description: Fresh restrictive definition
model: fresh-role-model
permissionMode: plan
disallowedTools:
  - Write
---
Fresh restrictive prompt.
`,
    )

    const backend = vi.fn(successfulBackend((config, effectiveContext) => {
      expect(config.model).toBeUndefined()
      const selected = effectiveContext.options.agentDefinitions.activeAgents.find(
        agent => agent.agentType === 'boundary-worker',
      )
      expect(selected).toMatchObject({
        source: 'projectSettings',
        disallowedTools: ['Write'],
      })
      expect(selected).not.toHaveProperty('model')
      expect(selected).not.toHaveProperty('permissionMode')
      expect(selected?.getSystemPrompt()).toBe('Fresh restrictive prompt.')
    }))
    __setSpawnTeammateBackendForTesting(backend)

    await runWithCurrentRuntimeSession(sessionFor(workspace), () =>
      spawnTeammate(
        configFor(workspace, 'boundary-worker'),
        context,
      ),
    )
    expect(backend).toHaveBeenCalledOnce()
  })

  it('rejects a validated role-bearing pane spawn before any backend mutation', async () => {
    const workspace = tempWorkspace('teammate-pane-role')
    const agentsDir = join(workspace, '.agenc', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      join(agentsDir, 'boundary-worker.md'),
      `---
name: boundary-worker
description: Exact pane boundary role
permissionMode: plan
---
Do not execute without exact role provenance.
`,
    )
    __setPluginAgentsLoaderForTesting(async () => [])
    setCliTeammateModeOverride('tmux')
    captureTeammateModeSnapshot()
    setIsInteractive(true)
    const backend = vi.fn(successfulBackend(() => {
      throw new Error('pane backend must not run for a role-bearing spawn')
    }))
    __setSpawnTeammateBackendForTesting(backend)

    try {
      await expect(
        runWithCurrentRuntimeSession(sessionFor(workspace), () =>
          spawnTeammate(
            configFor(workspace, 'boundary-worker'),
            contextFor(workspace),
          ),
        ),
      ).rejects.toThrow(
        "requires in-process teammate mode; pane teammates cannot enforce exact agent-role provenance",
      )
      expect(backend).not.toHaveBeenCalled()
    } finally {
      setIsInteractive(false)
    }
  })

  it('rejects a pane backend before mutation when required isolation is unavailable', async () => {
    const workspace = tempWorkspace('teammate-pane-sandbox')
    setCliTeammateModeOverride('tmux')
    captureTeammateModeSnapshot()
    setIsInteractive(true)
    const backend = vi.fn(successfulBackend(() => {
      throw new Error('pane backend must not run without a healthy boundary')
    }))
    __setSpawnTeammateBackendForTesting(backend)
    const broker = new SandboxExecutionBroker({
      mode: 'workspace_write',
      cwd: workspace,
      platform: 'linux',
      probe: () => ({
        kind: 'unavailable',
        mode: 'workspace_write',
        platform: 'linux',
        reason: 'probe: forced unavailable for pane boundary test',
        remediation: 'repair the test sandbox',
      }),
    })

    try {
      await expect(
        runWithCurrentRuntimeSession(sessionFor(workspace, broker), () =>
          spawnTeammate(
            configFor(workspace, 'general-purpose'),
            contextFor(workspace),
          ),
        ),
      ).rejects.toMatchObject({
        code: 'sandbox_probe_failed',
        surface: 'pane_agent',
      })
      expect(backend).not.toHaveBeenCalled()
    } finally {
      setIsInteractive(false)
    }
  })

  it('selects the sandboxable in-process backend for restricted auto mode', async () => {
    const workspace = tempWorkspace('teammate-auto-sandbox')
    setCliTeammateModeOverride('auto')
    captureTeammateModeSnapshot()
    setIsInteractive(true)
    vi.stubEnv('TERM_PROGRAM', 'iTerm.app')
    resetBackendDetection()
    resetDetectionCache()
    expect(isInProcessEnabled()).toBe(false)

    const broker = new SandboxExecutionBroker({
      mode: 'workspace_write',
      cwd: workspace,
      platform: process.platform,
      probe: ({ mode, platform }) => ({
        kind: 'ready',
        mode,
        platform,
      }),
    })
    const backend = vi.fn(successfulBackend(() => {
      expect(isInProcessEnabled()).toBe(true)
    }))
    __setSpawnTeammateBackendForTesting(backend)
    const { agent_type: _agentType, ...config } = configFor(
      workspace,
      'general-purpose',
    )

    await runWithCurrentRuntimeSession(sessionFor(workspace, broker), () =>
      spawnTeammate(config, contextFor(workspace)),
    )

    expect(backend).toHaveBeenCalledOnce()
  })

  it.each([
    {
      label: 'requested exact plugin role',
      requested: 'security-plugin:auditor',
      denied: 'security-plugin:auditor',
      pluginAgent: {
        agentType: 'security-plugin:auditor',
        whenToUse: 'Plugin auditor',
        source: 'plugin' as const,
        plugin: 'security-plugin',
        getSystemPrompt: () => 'Audit safely.',
      },
    },
    {
      label: 'selected canonical alias',
      requested: 'scanner',
      denied: 'explorer',
      pluginAgent: undefined,
    },
  ])('rejects a denied $label before any backend call', async ({
    requested,
    denied,
    pluginAgent,
  }) => {
    const workspace = tempWorkspace('teammate-deny')
    __setPluginAgentsLoaderForTesting(async () =>
      pluginAgent === undefined ? [] : [pluginAgent],
    )
    const context = contextFor(workspace, [], [denied])
    const backend = vi.fn(successfulBackend(() => {
      throw new Error('backend must not run after denial')
    }))
    __setSpawnTeammateBackendForTesting(backend)

    await expect(
      runWithCurrentRuntimeSession(sessionFor(workspace), () =>
        spawnTeammate(configFor(workspace, requested), context),
      ),
    ).rejects.toThrow(`Agent type '${requested}' has been denied`)
    expect(backend).not.toHaveBeenCalled()
  })
})
