import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const resumeToolPoolCapture = vi.hoisted(() => ({ modes: [] as unknown[] }))

vi.mock('../../../src/tools.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/tools.js')>()),
  assembleToolPool: (permissionContext: { readonly mode: unknown }) => {
    resumeToolPoolCapture.modes.push(permissionContext.mode)
    return [{ name: 'Read' }]
  },
}))
import {
  resetStateForTests,
  setOriginalCwd,
  switchSession,
} from '../../../src/bootstrap/state.js'
import { createAgentRoleWorkspace } from '../../../src/agents/role.js'
import { runWithCurrentRuntimeSession } from '../../../src/session/current-session.js'
import type { Session } from '../../../src/session/session.js'
import {
  getAgentMemoryDir,
} from '../../../src/tools/AgentTool/agentMemory.js'
import {
  __setPluginAgentsLoaderForTesting,
  clearAgentDefinitionsCache,
  loadFreshAgentDefinitions,
  requireAgentDefinitionRoleFingerprint,
  type AgentDefinition,
} from '../../../src/tools/AgentTool/loadAgentsDir.js'
import {
  __setResumeAgentLaunchForTesting,
  resolveAgentDefinitionForResume,
  resumeAgentBackground,
  type ResumeAgentLaunchPreflight,
} from '../../../src/tools/AgentTool/resumeAgent.js'
import type { ToolUseContext } from '../../../src/tools/Tool.js'
import { getDefaultAppState } from '../../../src/tui/state/AppStateStore.js'
import {
  getAgentTranscriptPath,
  readAgentMetadata,
  resetProjectForTesting,
  writeAgentMetadata,
} from '../../../src/utils/sessionStorage.js'

const tempRoots: string[] = []
const boundarySessionId = '00000000-0000-4000-8000-000000000223'

afterEach(() => {
  __setPluginAgentsLoaderForTesting(undefined)
  __setResumeAgentLaunchForTesting(undefined)
  resumeToolPoolCapture.modes.length = 0
  clearAgentDefinitionsCache()
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  resetProjectForTesting()
  resetStateForTests()
  vi.unstubAllEnvs()
})

function configureBoundarySession(root: string): Session {
  vi.stubEnv('AGENC_CONFIG_DIR', join(root, 'config'))
  resetStateForTests()
  resetProjectForTesting()
  setOriginalCwd(root)
  switchSession(boundarySessionId as never, null)
  return {
    roleWorkspace: createAgentRoleWorkspace(root),
  } as unknown as Session
}

function writeBoundaryTranscript(agentId: string, cwd: string): void {
  const transcriptPath = getAgentTranscriptPath(agentId as never)
  mkdirSync(dirname(transcriptPath), { recursive: true })
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000001',
      parentUuid: null,
      timestamp: '2026-07-15T00:00:00.000Z',
      cwd,
      userType: 'external',
      sessionId: boundarySessionId,
      version: 'test',
      isSidechain: true,
      isMeta: false,
      agentId,
      message: { role: 'user', content: 'Original delegated task.' },
    })}\n`,
  )
}

function boundaryContext(
  workspace: string,
  activeAgents: AgentDefinition[] = [],
): ToolUseContext {
  const agentDefinitions = {
    agentRoleWorkspaceId: createAgentRoleWorkspace(workspace).id,
    activeAgents,
    allAgents: activeAgents,
  }
  const defaultState = getDefaultAppState()
  const appState = {
    ...defaultState,
    mainLoopModel: 'test-model',
    agentDefinitions,
  }
  return {
    options: {
      agentDefinitions,
      tools: [],
      mainLoopModel: 'test-model',
      mcpClients: [],
    },
    contentReplacementState: undefined,
    getAppState: () => appState,
    setAppState: vi.fn(),
  } as unknown as ToolUseContext
}

function agentDefinition(agentType: string, prompt: string): AgentDefinition {
  return {
    agentType,
    whenToUse: agentType,
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () => prompt,
  }
}

describe('AgentTool resume role provenance', () => {
  it('rejects missing, cross-workspace, and removed role metadata', () => {
    const workspaceA = createAgentRoleWorkspace('/workspace/a')
    const workspaceB = createAgentRoleWorkspace('/workspace/b')
    const agentA = agentDefinition('shared-reviewer', 'workspace A')
    const agentB = agentDefinition('shared-reviewer', 'workspace B')
    const metadataA = {
      agentType: 'shared-reviewer',
      agentRoleWorkspaceId: workspaceA.id,
      agentRoleFingerprint: requireAgentDefinitionRoleFingerprint(agentA),
    }
    const catalogA = {
      agentRoleWorkspaceId: workspaceA.id,
      activeAgents: [agentA],
    }
    const catalogB = {
      agentRoleWorkspaceId: workspaceB.id,
      activeAgents: [agentB],
    }

    expect(() =>
      resolveAgentDefinitionForResume(null, workspaceA, catalogA),
    ).toThrow('role workspace metadata is missing')
    expect(() =>
      resolveAgentDefinitionForResume(
        { agentType: 'shared-reviewer' },
        workspaceA,
        catalogA,
      ),
    ).toThrow('agent role workspace provenance is missing')
    expect(() =>
      resolveAgentDefinitionForResume(metadataA, workspaceB, catalogB),
    ).toThrow('agent role workspace mismatch')
    expect(() =>
      resolveAgentDefinitionForResume(metadataA, workspaceA, {
        agentRoleWorkspaceId: workspaceA.id,
        activeAgents: [],
      }),
    ).toThrow("Cannot resume agent type 'shared-reviewer'")
    expect(() =>
      resolveAgentDefinitionForResume(metadataA, workspaceA, {
        agentRoleWorkspaceId: workspaceA.id,
        activeAgents: [agentB],
      }),
    ).toThrow("Cannot resume changed agent type 'shared-reviewer'")

    expect(
      resolveAgentDefinitionForResume(metadataA, workspaceA, catalogA)
        .selectedAgent,
    ).toBe(agentA)
  })

  it('re-reads an edited same-name role and rejects changed restrictions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenc-resume-role-'))
    tempRoots.push(root)
    const agentsDir = join(root, '.agenc', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    const rolePath = join(agentsDir, 'worker.md')
    writeFileSync(
      rolePath,
      `---
name: guarded-worker
description: Guarded worker
disallowedTools:
  - Write
permissionMode: plan
---
Guarded prompt.
`,
    )
    __setPluginAgentsLoaderForTesting(async () => [])

    const workspace = createAgentRoleWorkspace(root)
    vi.stubEnv('AGENC_CONFIG_DIR', join(root, 'config'))
    resetStateForTests()
    resetProjectForTesting()
    setOriginalCwd(root)
    switchSession('00000000-0000-4000-8000-000000000222' as never, null)
    const firstCatalog = await loadFreshAgentDefinitions(root)
    const first = firstCatalog.activeAgents.find(
      definition => definition.agentType === 'guarded-worker',
    )
    expect(first).toBeDefined()
    const metadata = {
      agentType: 'guarded-worker',
      agentRoleWorkspaceId: workspace.id,
      agentRoleFingerprint: requireAgentDefinitionRoleFingerprint(first!),
    }
    const agentId = 'unchanged-custom-role' as never
    await writeAgentMetadata(agentId, metadata)
    const persistedMetadata = await readAgentMetadata(agentId, { strict: true })
    expect(persistedMetadata).toEqual(metadata)
    expect(
      resolveAgentDefinitionForResume(
        persistedMetadata,
        workspace,
        await loadFreshAgentDefinitions(root),
      )
        .selectedAgent,
    ).toMatchObject({ agentType: 'guarded-worker', disallowedTools: ['Write'] })
    expect(
      resolveAgentDefinitionForResume(
        persistedMetadata,
        workspace,
        await loadFreshAgentDefinitions(root),
      ).selectedAgent,
    ).not.toHaveProperty('permissionMode')

    writeFileSync(
      rolePath,
      `---
name: guarded-worker
description: Guarded worker
disallowedTools: []
permissionMode: acceptEdits
---
Guarded prompt.
`,
    )
    const secondCatalog = await loadFreshAgentDefinitions(root)
    const second = secondCatalog.activeAgents.find(
      definition => definition.agentType === 'guarded-worker',
    )
    expect(second).toBeDefined()
    expect(requireAgentDefinitionRoleFingerprint(second!)).not.toBe(
      metadata.agentRoleFingerprint,
    )
    expect(() =>
      resolveAgentDefinitionForResume(metadata, workspace, secondCatalog),
    ).toThrow("Cannot resume changed agent type 'guarded-worker'")
  })

  it('rejects an edited role at the resume boundary before launch mutation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenc-resume-boundary-edit-'))
    tempRoots.push(root)
    const session = configureBoundarySession(root)
    const agentsDir = join(root, '.agenc', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    const rolePath = join(agentsDir, 'boundary-reviewer.md')
    writeFileSync(
      rolePath,
      `---
name: boundary-reviewer
description: Original guarded reviewer
permissionMode: plan
disallowedTools:
  - Write
---
Review without mutation.
`,
    )
    __setPluginAgentsLoaderForTesting(async () => [])
    const initialCatalog = await loadFreshAgentDefinitions(root)
    const initialRole = initialCatalog.activeAgents.find(
      definition => definition.agentType === 'boundary-reviewer',
    )
    expect(initialRole).toBeDefined()
    const agentId = 'resume-boundary-edited-role'
    await writeAgentMetadata(agentId as never, {
      agentType: 'boundary-reviewer',
      agentRoleWorkspaceId: session.roleWorkspace.id,
      agentRoleFingerprint: requireAgentDefinitionRoleFingerprint(initialRole!),
    })
    writeBoundaryTranscript(agentId, root)

    writeFileSync(
      rolePath,
      `---
name: boundary-reviewer
description: Changed permissive reviewer
permissionMode: acceptEdits
disallowedTools: []
---
Review and mutate freely.
`,
    )
    const launch = vi.fn(() => ({
      agentId,
      description: 'must not launch',
      outputFile: '/must-not-launch',
    }))
    __setResumeAgentLaunchForTesting(launch)

    await expect(
      runWithCurrentRuntimeSession(session, () =>
        resumeAgentBackground({
          agentId,
          prompt: 'Continue the review.',
          toolUseContext: boundaryContext(
            root,
            initialCatalog.activeAgents,
          ),
          canUseTool: async () => ({ behavior: 'allow' }),
        }),
      ),
    ).rejects.toThrow("Cannot resume changed agent type 'boundary-reviewer'")
    expect(launch).not.toHaveBeenCalled()
  })

  it('does not let repository role metadata authorize memory or resume capabilities', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenc-resume-boundary-memory-'))
    tempRoots.push(root)
    const session = configureBoundarySession(root)
    const agentsDir = join(root, '.agenc', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      join(agentsDir, 'memory-reviewer.md'),
      `---
name: memory-reviewer
description: Project-memory reviewer
memory: project
permissionMode: plan
---
Use only this role's project memory.
`,
    )
    __setPluginAgentsLoaderForTesting(async () => [])
    const catalog = await loadFreshAgentDefinitions(root)
    const selectedRole = catalog.activeAgents.find(
      definition => definition.agentType === 'memory-reviewer',
    )
    expect(selectedRole).toBeDefined()
    const agentId = 'resume-boundary-memory-role'
    await writeAgentMetadata(agentId as never, {
      agentType: 'memory-reviewer',
      agentRoleWorkspaceId: session.roleWorkspace.id,
      agentRoleFingerprint: requireAgentDefinitionRoleFingerprint(selectedRole!),
    })
    writeBoundaryTranscript(agentId, root)
    const memoryDir = getAgentMemoryDir('memory-reviewer', 'project', root)
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(
      join(memoryDir, 'MEMORY.md'),
      'memory written by the running agent before resume',
    )
    const launch = vi.fn((preflight: ResumeAgentLaunchPreflight) => {
      expect(preflight.selectedAgent.agentType).toBe('memory-reviewer')
      expect(preflight.selectedAgent.getSystemPrompt()).toBe(
        "Use only this role's project memory.",
      )
      expect(preflight.selectedAgent).not.toHaveProperty('memory')
      expect(preflight.selectedAgent).not.toHaveProperty('permissionMode')
      expect(preflight.agentContext.memoryAuthorization).toBeUndefined()
      expect(preflight.workerPermissionMode).toBe('default')
      expect(preflight.availableTools).toEqual([])
      return {
        agentId,
        description: 'resumed memory reviewer',
        outputFile: '/test/resume-output',
      }
    })
    __setResumeAgentLaunchForTesting(launch)

    await expect(
      runWithCurrentRuntimeSession(session, () =>
        resumeAgentBackground({
          agentId,
          prompt: 'Continue using your own memory.',
          toolUseContext: boundaryContext(root, catalog.activeAgents),
          canUseTool: async () => ({ behavior: 'allow' }),
          invokingRequestId: 'resume-request',
        }),
      ),
    ).resolves.toMatchObject({ agentId })
    expect(launch).toHaveBeenCalledOnce()
    expect(resumeToolPoolCapture.modes).toEqual([])
  })
})
