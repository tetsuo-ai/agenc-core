import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAgentRoleWorkspace } from '../../../src/agents/role.js'
import { runWithCurrentRuntimeSession } from '../../../src/session/current-session.js'
import type { Session } from '../../../src/session/session.js'
import {
  __setAgentMetadataWriterForTesting,
  __setAgentToolLaunchPreflightForTesting,
  AgentTool,
} from '../../../src/tools/AgentTool/AgentTool.js'
import {
  __setPluginAgentsLoaderForTesting,
  clearAgentDefinitionsCache,
} from '../../../src/tools/AgentTool/loadAgentsDir.js'
import type { ToolUseContext } from '../../../src/tools/Tool.js'
import { getDefaultAppState } from '../../../src/tui/state/AppStateStore.js'
import { runWithCwdOverride } from '../../../src/utils/cwd.js'

const roots: string[] = []

afterEach(() => {
  __setPluginAgentsLoaderForTesting(undefined)
  __setAgentMetadataWriterForTesting(undefined)
  __setAgentToolLaunchPreflightForTesting(undefined)
  clearAgentDefinitionsCache()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `agenc-${label}-`))
  roots.push(root)
  return root
}

function sessionFor(cwd: string): Session {
  return {
    roleWorkspace: createAgentRoleWorkspace(cwd),
  } as unknown as Session
}

function contextFor(
  catalogWorkspace: string,
  options: { readonly deniedAgentType?: string } = {},
): {
  readonly context: ToolUseContext
  readonly setAppState: ReturnType<typeof vi.fn>
} {
  const agentDefinitions = {
    agentRoleWorkspaceId: createAgentRoleWorkspace(catalogWorkspace).id,
    activeAgents: [],
    allAgents: [],
  }
  const defaultState = getDefaultAppState()
  const appState = {
    ...defaultState,
    agentDefinitions,
    toolPermissionContext: {
      ...defaultState.toolPermissionContext,
      alwaysDenyRules: options.deniedAgentType === undefined
        ? defaultState.toolPermissionContext.alwaysDenyRules
        : {
            projectSettings: [
              `spawn_agent(${options.deniedAgentType})`,
            ],
          },
    },
  }
  const setAppState = vi.fn()
  return {
    setAppState,
    context: {
      options: {
        agentDefinitions,
        tools: [],
        mainLoopModel: 'test-model',
        mcpClients: [],
      },
      getAppState: () => appState,
      setAppState,
    } as unknown as ToolUseContext,
  }
}

async function callAgentTool(
  session: Session,
  context: ToolUseContext,
  cwd: string | undefined,
  input: Record<string, unknown> = {},
): Promise<unknown> {
  const call = () => runWithCurrentRuntimeSession(session, () =>
      (AgentTool.call as unknown as (
        input: Record<string, unknown>,
        context: ToolUseContext,
        canUseTool: () => Promise<{ behavior: 'allow' }>,
      ) => Promise<unknown>)(
        {
          description: 'workspace preflight',
          prompt: 'do not execute',
          subagent_type: 'missing-role',
          ...(cwd !== undefined ? { cwd } : {}),
          ...input,
        },
        context,
        async () => ({ behavior: 'allow' }),
      ))
  return cwd === undefined
    ? runWithCwdOverride(session.roleWorkspace.cwd, call)
    : call()
}

describe('AgentTool workspace authority', () => {
  it('rejects a same-named foreign catalog before task or spawn mutation', async () => {
    const session = sessionFor('/workspace/a')
    const { context, setAppState } = contextFor('/workspace/b')

    await expect(
      callAgentTool(session, context, '/workspace/a'),
    ).rejects.toThrow('agent role workspace mismatch')
    expect(setAppState).not.toHaveBeenCalled()
  })

  it('keeps role authority in workspace A when execution cwd is workspace B', async () => {
    const session = sessionFor('/workspace/a')
    const { context, setAppState } = contextFor('/workspace/a')

    await expect(
      callAgentTool(session, context, '/workspace/b'),
    ).rejects.toThrow("Agent type 'missing-role' not found")
    expect(setAppState).not.toHaveBeenCalled()
  })

  it('enforces an alias deny before falling back from scanner to explorer', async () => {
    const workspace = tempRoot('agent-alias-deny')
    __setPluginAgentsLoaderForTesting(async () => [])
    const session = sessionFor(workspace)
    const { context, setAppState } = contextFor(workspace, {
      deniedAgentType: 'scanner',
    })

    await expect(
      callAgentTool(session, context, workspace, {
        subagent_type: 'scanner',
      }),
    ).rejects.toThrow("Agent type 'scanner' has been denied")
    expect(setAppState).not.toHaveBeenCalled()
  })

  it('does not fall back to explorer when an exact custom scanner is denied', async () => {
    const workspace = tempRoot('agent-exact-deny')
    const agentsDir = join(workspace, '.agenc', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      join(agentsDir, 'scanner.md'),
      `---
name: scanner
description: Restrictive exact scanner
disallowedTools:
  - Write
permissionMode: plan
---
Never mutate files.
`,
    )
    __setPluginAgentsLoaderForTesting(async () => [])
    const session = sessionFor(workspace)
    const { context, setAppState } = contextFor(workspace, {
      deniedAgentType: 'scanner',
    })

    await expect(
      callAgentTool(session, context, workspace, {
        subagent_type: 'scanner',
      }),
    ).rejects.toThrow("Agent type 'scanner' has been denied")
    expect(setAppState).not.toHaveBeenCalled()
  })

  it('accepts an unchanged fresh custom role at the real AgentTool boundary', async () => {
    const workspace = tempRoot('agent-fresh-custom')
    const agentsDir = join(workspace, '.agenc', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      join(agentsDir, 'auditor.md'),
      `---
name: exact-auditor
description: Exact restrictive auditor
disallowedTools:
  - Write
permissionMode: plan
---
Audit without mutations.
`,
    )
    __setPluginAgentsLoaderForTesting(async () => [])
    const session = sessionFor(workspace)
    const { context } = contextFor(workspace)
    const preflight = vi.fn(({ selectedAgent, agentRoleFingerprint }) => {
      expect(selectedAgent).toMatchObject({
        agentType: 'exact-auditor',
        permissionMode: 'plan',
        disallowedTools: ['Write'],
      })
      expect(agentRoleFingerprint).toMatch(/^[a-f0-9]{64}$/)
      throw new Error('test launch boundary reached')
    })
    __setAgentToolLaunchPreflightForTesting(preflight)

    await expect(
      callAgentTool(session, context, undefined, {
        subagent_type: 'exact-auditor',
      }),
    ).rejects.toThrow('test launch boundary reached')
    expect(preflight).toHaveBeenCalledOnce()
  })

  it('does not publish or start an async agent when durable metadata persistence fails', async () => {
    const workspace = tempRoot('agent-metadata-failure')
    __setPluginAgentsLoaderForTesting(async () => [
      {
        agentType: 'atomic-auditor',
        whenToUse: 'Tests durable launch ordering',
        source: 'plugin',
        plugin: 'atomic-test-plugin',
        baseDir: workspace,
        getSystemPrompt: () => 'Do not start.',
      },
    ])
    const persistenceFailure = new Error('simulated metadata fsync failure')
    const writer = vi.fn(async () => {
      throw persistenceFailure
    })
    __setAgentMetadataWriterForTesting(writer)
    const session = sessionFor(workspace)
    const { context, setAppState } = contextFor(workspace)

    await expect(
      callAgentTool(session, context, undefined, {
        subagent_type: 'atomic-auditor',
        run_in_background: true,
      }),
    ).rejects.toBe(persistenceFailure)

    expect(writer).toHaveBeenCalledOnce()
    expect(writer).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        agentType: 'atomic-auditor',
        agentRoleWorkspaceId: session.roleWorkspace.id,
        agentRoleFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    )
    // registerAsyncAgent publishes through the root AppState setter. It must
    // remain untouched when persistence fails.
    expect(setAppState).not.toHaveBeenCalled()
  })

  it('prefers an exact restrictive plugin alias on the immediate call path', async () => {
    const workspace = tempRoot('agent-fresh-plugin')
    __setPluginAgentsLoaderForTesting(async () => [
      {
        agentType: 'scanner',
        whenToUse: 'Exact plugin scanner',
        source: 'plugin',
        plugin: 'security-plugin',
        baseDir: workspace,
        requiredMcpServers: ['exact-plugin-server'],
        disallowedTools: ['Write'],
        permissionMode: 'plan',
        getSystemPrompt: () => 'Exact plugin scanner prompt.',
      },
    ])
    const session = sessionFor(workspace)
    const { context } = contextFor(workspace)

    await expect(
      callAgentTool(session, context, undefined, {
        subagent_type: 'scanner',
        isolation: 'worktree',
      }),
    ).rejects.toThrow(
      "Agent 'scanner' requires MCP servers matching: exact-plugin-server",
    )
  })
})
