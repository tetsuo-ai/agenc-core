import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAgentRoleWorkspace } from '../../../src/agents/role.js'
import type { ExecutionAdmissionClient } from '../../../src/budget/admission-client.js'
import { runWithCurrentRuntimeSession } from '../../../src/session/current-session.js'
import type { Session } from '../../../src/session/session.js'
import {
  __setAgentMetadataWriterForTesting,
  __setAgentTaskRegistrarsForTesting,
  __setAgentToolLaunchPreflightForTesting,
  __setAgentWorktreeCreatorForTesting,
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
  __setAgentTaskRegistrarsForTesting(undefined)
  __setAgentToolLaunchPreflightForTesting(undefined)
  __setAgentWorktreeCreatorForTesting(undefined)
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

function sessionFor(
  cwd: string,
  executionAdmission?: ExecutionAdmissionClient,
): Session {
  return {
    conversationId: 'parent-session',
    roleWorkspace: createAgentRoleWorkspace(cwd),
    services: executionAdmission === undefined
      ? { admissionRequired: false }
      : {
          executionAdmission,
          admissionRequired: true,
          sandboxExecutionBroker: {
            cwd,
            prepareSpawn: vi.fn(),
          },
        },
  } as unknown as Session
}

function admissionClient(
  order: string[],
  leaseSignal: AbortSignal = new AbortController().signal,
): {
  readonly client: ExecutionAdmissionClient
  readonly acquire: ReturnType<typeof vi.fn>
  readonly markDispatched: ReturnType<typeof vi.fn>
  readonly reconcile: ReturnType<typeof vi.fn>
  readonly holdUnknown: ReturnType<typeof vi.fn>
  readonly voidReservation: ReturnType<typeof vi.fn>
  readonly acknowledgeCompletion: ReturnType<typeof vi.fn>
} {
  const child = {
    scope: {
      runId: 'child-agent',
      workspaceId: 'workspace',
      sessionId: 'child-agent',
      autonomous: false,
    },
  } as ExecutionAdmissionClient
  const acquire = vi.fn(async () => {
    order.push('acquire')
    return {
      decision: 'allow' as const,
      reservation: {
        reservationId: 'spawn-reservation',
        step: { runId: 'parent-run', stepId: 'spawn-step' },
        reservedCostUsd: 0,
        reservedTokens: 0,
        reservedAt: '2026-07-18T00:00:00.000Z',
      },
      request: {} as never,
      signal: leaseSignal,
    }
  })
  const markDispatched = vi.fn(() => order.push('dispatch'))
  const reconcile = vi.fn(() => {
    order.push('commit')
    return { applied: true as const, outcome: 'reconciled' as const }
  })
  const holdUnknown = vi.fn(() => order.push('unknown'))
  const voidReservation = vi.fn(() => order.push('void'))
  const acknowledgeCompletion = vi.fn()
  const client = {
    scope: {
      runId: 'parent-run',
      workspaceId: 'workspace',
      sessionId: 'parent-session',
      autonomous: false,
    },
    acquire,
    markDispatched,
    reconcile,
    holdUnknown,
    void: voidReservation,
    acknowledgeCompletion,
    recordFallback: vi.fn(),
    forSession: vi.fn(() => child),
    subscribe: vi.fn(() => () => {}),
  } satisfies ExecutionAdmissionClient
  return {
    client,
    acquire,
    markDispatched,
    reconcile,
    holdUnknown,
    voidReservation,
    acknowledgeCompletion,
  }
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
      abortController: new AbortController(),
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

  it('accepts a fresh repository role with deny-only authority at the real AgentTool boundary', async () => {
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
        disallowedTools: ['Write'],
      })
      expect(selectedAgent.permissionMode).toBeUndefined()
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
    const order: string[] = []
    const admission = admissionClient(order)
    const persistenceFailure = new Error('simulated metadata fsync failure')
    const writer = vi.fn(async () => {
      order.push('metadata')
      throw persistenceFailure
    })
    __setAgentMetadataWriterForTesting(writer)
    const session = sessionFor(workspace, admission.client)
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
    expect(order).toEqual(['acquire', 'dispatch', 'metadata', 'unknown'])
    expect(admission.reconcile).not.toHaveBeenCalled()
    expect(admission.holdUnknown).toHaveBeenCalledWith(
      'spawn-reservation',
      'legacy_agent_spawn_commit_outcome_unknown',
    )
  })

  it('acquires spawn admission before reversible worktree creation', async () => {
    const workspace = tempRoot('agent-worktree-admission-order')
    __setPluginAgentsLoaderForTesting(async () => [
      {
        agentType: 'worktree-auditor',
        whenToUse: 'Tests pre-publication ordering',
        source: 'plugin',
        plugin: 'atomic-test-plugin',
        baseDir: workspace,
        getSystemPrompt: () => 'Do not start.',
      },
    ])
    const order: string[] = []
    const admission = admissionClient(order)
    const worktreeFailure = new Error('worktree boundary reached')
    __setAgentWorktreeCreatorForTesting(async () => {
      order.push('worktree')
      throw worktreeFailure
    })
    const writer = vi.fn()
    __setAgentMetadataWriterForTesting(writer)
    const session = sessionFor(workspace, admission.client)
    const { context, setAppState } = contextFor(workspace)

    await expect(
      callAgentTool(session, context, undefined, {
        subagent_type: 'worktree-auditor',
        isolation: 'worktree',
      }),
    ).rejects.toBe(worktreeFailure)

    expect(order).toEqual(['acquire', 'worktree', 'void'])
    expect(writer).not.toHaveBeenCalled()
    expect(setAppState).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'async', runInBackground: true },
    { label: 'foreground', runInBackground: false },
  ])(
    'publishes $label task state only after metadata commits under the spawn lease',
    async ({ runInBackground }) => {
      const workspace = tempRoot(`agent-${runInBackground ? 'async' : 'sync'}-commit-order`)
      const agentsDir = join(workspace, '.agenc', 'agents')
      mkdirSync(agentsDir, { recursive: true })
      writeFileSync(
        join(agentsDir, 'ordered-auditor.md'),
        `---
name: ordered-auditor
description: Tests durable task publication ordering
disallowedTools:
  - Write
---
Do not start.
`,
      )
      __setPluginAgentsLoaderForTesting(async () => [])
      const order: string[] = []
      const admission = admissionClient(order)
      __setAgentMetadataWriterForTesting(async () => {
        order.push('metadata')
      })
      const registrationFailure = new Error('task publication boundary reached')
      const registrar = vi.fn(() => {
        order.push('register')
        throw registrationFailure
      })
      __setAgentTaskRegistrarsForTesting(
        runInBackground
          ? { async: registrar }
          : { foreground: registrar },
      )
      const session = sessionFor(workspace, admission.client)
      const { context, setAppState } = contextFor(workspace)

      await expect(
        callAgentTool(session, context, undefined, {
          subagent_type: 'ordered-auditor',
          run_in_background: runInBackground,
        }),
      ).rejects.toBe(registrationFailure)

      expect(order).toEqual([
        'acquire',
        'dispatch',
        'metadata',
        'commit',
        'register',
      ])
      expect(registrar).toHaveBeenCalledWith(
        expect.objectContaining({
          abortController: expect.any(AbortController),
        }),
      )
      expect(setAppState).not.toHaveBeenCalled()
    },
  )

  it('does not retry durable metadata publication when spawn reconciliation faults', async () => {
    const workspace = tempRoot('agent-reconciliation-failure')
    const agentsDir = join(workspace, '.agenc', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      join(agentsDir, 'reconciliation-auditor.md'),
      `---
name: reconciliation-auditor
description: Tests post-publication settlement failure
disallowedTools:
  - Write
---
Do not start.
`,
    )
    __setPluginAgentsLoaderForTesting(async () => [])
    const order: string[] = []
    const admission = admissionClient(order)
    const reconciliationFailure = new Error(
      'simulated reconciliation journal failure',
    )
    admission.reconcile.mockImplementationOnce(() => {
      order.push('reconciliation-fault')
      throw reconciliationFailure
    })
    const writer = vi.fn(async () => {
      order.push('metadata')
    })
    __setAgentMetadataWriterForTesting(writer)
    const publicationBoundary = new Error('task publication boundary reached')
    const registrar = vi.fn(() => {
      order.push('register')
      throw publicationBoundary
    })
    __setAgentTaskRegistrarsForTesting({ async: registrar })
    const session = sessionFor(workspace, admission.client)
    const { context } = contextFor(workspace)
    let retried = false

    const launch = () =>
      callAgentTool(session, context, undefined, {
        subagent_type: 'reconciliation-auditor',
        run_in_background: true,
      })
    const launchWithSettlementRetry = async () => {
      try {
        return await launch()
      } catch (error) {
        if (error !== reconciliationFailure) throw error
        retried = true
        return launch()
      }
    }

    await expect(launchWithSettlementRetry()).rejects.toBe(publicationBoundary)

    expect(retried).toBe(false)
    expect(writer).toHaveBeenCalledOnce()
    expect(registrar).toHaveBeenCalledOnce()
    expect(admission.acquire).toHaveBeenCalledOnce()
    expect(admission.holdUnknown).toHaveBeenCalledWith(
      'spawn-reservation',
      'legacy_agent_spawn_reconciliation_failed_after_commit',
    )
    expect(admission.acknowledgeCompletion).toHaveBeenCalledWith(
      'spawn-reservation',
    )
    expect(order).toEqual([
      'acquire',
      'dispatch',
      'metadata',
      'reconciliation-fault',
      'unknown',
      'register',
    ])
  })

  it('prevents task publication when cancellation wins between acquire and metadata', async () => {
    const workspace = tempRoot('agent-cancel-before-metadata')
    __setPluginAgentsLoaderForTesting(async () => [
      {
        agentType: 'cancelled-auditor',
        whenToUse: 'Tests cancellation ordering',
        source: 'plugin',
        plugin: 'atomic-test-plugin',
        baseDir: workspace,
        getSystemPrompt: () => 'Do not start.',
      },
    ])
    const order: string[] = []
    const leaseAbort = new AbortController()
    leaseAbort.abort(new Error('parent cancelled before metadata'))
    const admission = admissionClient(order, leaseAbort.signal)
    const writer = vi.fn()
    const registrar = vi.fn()
    __setAgentMetadataWriterForTesting(writer)
    __setAgentTaskRegistrarsForTesting({ async: registrar })
    const session = sessionFor(workspace, admission.client)
    const { context, setAppState } = contextFor(workspace)

    await expect(
      callAgentTool(session, context, undefined, {
        subagent_type: 'cancelled-auditor',
        run_in_background: true,
      }),
    ).rejects.toThrow('parent cancelled before metadata')

    expect(order).toEqual(['acquire', 'void'])
    expect(admission.markDispatched).not.toHaveBeenCalled()
    expect(writer).not.toHaveBeenCalled()
    expect(registrar).not.toHaveBeenCalled()
    expect(setAppState).not.toHaveBeenCalled()
  })

  it('reuses one transferred spawn admission across sync-to-background continuation', () => {
    const runtimeRoot = resolve(import.meta.dirname, '../../../src')
    const agentToolSource = readFileSync(
      resolve(runtimeRoot, 'tools/AgentTool/AgentTool.tsx'),
      'utf8',
    )
    const runAgentSource = readFileSync(
      resolve(runtimeRoot, 'tools/AgentTool/runAgent.ts'),
      'utf8',
    )

    expect(
      agentToolSource.match(/await beginLegacyAgentSpawnAdmission\(/g),
    ).toHaveLength(1)
    expect(agentToolSource).toContain('agentMetadataAlreadyPersisted: true')
    expect(agentToolSource).toContain('spawnAdmission,')
    expect(runAgentSource).toContain(
      'transferredSpawnAdmission ??',
    )
    expect(runAgentSource).toContain(
      'executionAdmission: spawnAdmission.childAdmission',
    )
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
