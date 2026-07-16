import {
  mkdirSync,
  mkdtempSync,
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAgentRoleWorkspace } from '../../../src/agents/role.js'
import { runWithCurrentRuntimeSession } from '../../../src/session/current-session.js'
import type { Session } from '../../../src/session/session.js'
import {
  getAgentMemoryDir,
  loadAgentMemoryPrompt,
} from '../../../src/tools/AgentTool/agentMemory.js'
import {
  __setAgentMemorySnapshotFileOperationForTesting,
  checkAgentMemorySnapshot,
  getSnapshotDirForAgent,
  initializeFromSnapshot,
  replaceFromSnapshot,
} from '../../../src/tools/AgentTool/agentMemorySnapshot.js'
import {
  __setPluginAgentsLoaderForTesting,
  clearAgentDefinitionsCache,
  loadFreshAgentDefinitions,
  requireAgentDefinitionRoleFingerprint,
} from '../../../src/tools/AgentTool/loadAgentsDir.js'
import {
  checkEditableInternalPath,
  checkReadPermissionForTool,
  checkReadableInternalPath,
  checkWritePermissionForTool,
} from '../../../src/utils/permissions/filesystem.js'
import { runWithAgentContext } from '../../../src/utils/agentContext.js'
import type {
  Tool,
  ToolPermissionContext,
} from '../../../src/tools/Tool.js'

const roots: string[] = []
const initialCwd = process.cwd()

beforeEach(() => {
  vi.stubGlobal('MACRO', { VERSION: 'test' })
})

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `agenc-${label}-`))
  roots.push(root)
  return root
}

function fileTool(name: string): Tool {
  return {
    name,
    getPath(input: Record<string, unknown>): string {
      return String(input.file_path ?? '')
    },
  } as unknown as Tool
}

function permissionContext(
  workingDirectories: readonly string[] = [],
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(
      workingDirectories.map(path => [path, { path, source: 'session' }]),
    ),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

afterEach(() => {
  process.chdir(initialCwd)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  __setPluginAgentsLoaderForTesting(undefined)
  __setAgentMemorySnapshotFileOperationForTesting(undefined)
  clearAgentDefinitionsCache()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('agent memory workspace authority', () => {
  it('uses role workspace A under ambient cwd B and rejects B/symlink carve-outs', () => {
    const workspaceA = tempRoot('memory-workspace-a')
    const workspaceB = tempRoot('memory-workspace-b')
    const outside = tempRoot('memory-outside')
    const memoryA = getAgentMemoryDir('worker', 'project', workspaceA)
    const memoryB = getAgentMemoryDir('worker', 'project', workspaceB)
    const siblingMemoryA = getAgentMemoryDir(
      'sibling-worker',
      'project',
      workspaceA,
    )
    mkdirSync(memoryA, { recursive: true })
    mkdirSync(memoryB, { recursive: true })
    mkdirSync(siblingMemoryA, { recursive: true })
    const entryA = join(memoryA, 'MEMORY.md')
    const entryB = join(memoryB, 'MEMORY.md')
    const siblingEntryA = join(siblingMemoryA, 'MEMORY.md')
    const outsideFile = join(outside, 'outside.md')
    const outsideHardlinkedFile = join(outside, 'hardlinked.md')
    const inMemoryHardlink = join(memoryA, 'hardlinked.md')
    writeFileSync(entryA, 'workspace-a-memory')
    writeFileSync(entryB, 'workspace-b-memory')
    writeFileSync(siblingEntryA, 'sibling-workspace-a-memory')
    writeFileSync(outsideFile, 'outside-memory')
    writeFileSync(outsideHardlinkedFile, 'external-hardlink-memory')
    linkSync(outsideHardlinkedFile, inMemoryHardlink)
    const escapedLink = join(memoryA, 'escaped.md')
    symlinkSync(outsideFile, escapedLink)
    process.chdir(workspaceB)

    const session = {
      roleWorkspace: createAgentRoleWorkspace(workspaceA),
      sessionConfiguration: { cwd: workspaceB },
    } as unknown as Session
    runWithCurrentRuntimeSession(session, () => {
      const prompt = loadAgentMemoryPrompt('worker', 'project')
      expect(prompt).toContain('workspace-a-memory')
      expect(prompt).not.toContain('workspace-b-memory')

      // No agent identity means no implicit memory permission.
      expect(checkEditableInternalPath(entryA, {}).behavior).toBe('passthrough')
      expect(checkReadableInternalPath(entryA, {}).behavior).toBe('passthrough')

      const allowedWorkspaceContext = permissionContext([
        workspaceA,
        workspaceB,
      ])
      expect(
        checkReadPermissionForTool(
          fileTool('FileRead'),
          { file_path: entryA },
          allowedWorkspaceContext,
        ).behavior,
      ).not.toBe('allow')

      runWithAgentContext(
        {
          agentId: 'memory-worker-test',
          agentType: 'subagent',
          subagentName: 'worker',
          memoryAuthorization: {
            agentType: 'worker',
            scope: 'project',
          },
        },
        () => {
          expect(checkEditableInternalPath(entryA, {}).behavior).toBe('allow')
          expect(checkReadableInternalPath(entryA, {}).behavior).toBe('allow')
          expect(checkEditableInternalPath(entryB, {}).behavior).toBe(
            'passthrough',
          )
          expect(checkReadableInternalPath(entryB, {}).behavior).toBe(
            'passthrough',
          )
          expect(checkEditableInternalPath(siblingEntryA, {}).behavior).toBe(
            'passthrough',
          )
          expect(checkReadableInternalPath(siblingEntryA, {}).behavior).toBe(
            'passthrough',
          )
          expect(checkEditableInternalPath(escapedLink, {}).behavior).toBe(
            'passthrough',
          )
          expect(checkReadableInternalPath(escapedLink, {}).behavior).toBe(
            'passthrough',
          )
          expect(checkEditableInternalPath(inMemoryHardlink, {}).behavior).toBe(
            'passthrough',
          )
          expect(checkReadableInternalPath(inMemoryHardlink, {}).behavior).toBe(
            'passthrough',
          )
          expect(readFileSync(outsideHardlinkedFile, 'utf8')).toBe(
            'external-hardlink-memory',
          )

          const context = allowedWorkspaceContext
          expect(
            checkReadPermissionForTool(
              fileTool('FileRead'),
              { file_path: entryA },
              context,
            ).behavior,
          ).toBe('allow')
          expect(
            checkWritePermissionForTool(
              fileTool('Write'),
              { file_path: entryA },
              context,
            ).behavior,
          ).toBe('allow')
          expect(
            checkReadPermissionForTool(
              fileTool('FileRead'),
              { file_path: inMemoryHardlink },
              context,
            ).behavior,
          ).not.toBe('allow')
          expect(
            checkWritePermissionForTool(
              fileTool('Write'),
              { file_path: inMemoryHardlink },
              context,
            ).behavior,
          ).not.toBe('allow')
          expect(
            checkReadPermissionForTool(
              fileTool('FileRead'),
              { file_path: entryB },
              context,
            ).behavior,
          ).not.toBe('allow')
          expect(
            checkReadPermissionForTool(
              fileTool('FileRead'),
              { file_path: siblingEntryA },
              context,
            ).behavior,
          ).not.toBe('allow')
        },
      )

      unlinkSync(entryA)
      symlinkSync(entryB, entryA)
      const symlinkedPrompt = loadAgentMemoryPrompt('worker', 'project')
      expect(symlinkedPrompt).not.toContain('workspace-b-memory')
      expect(symlinkedPrompt).toContain('currently empty')

      const memoryALink = memoryA.endsWith(sep)
        ? memoryA.slice(0, -1)
        : memoryA
      rmSync(memoryALink, { recursive: true, force: true })
      symlinkSync(memoryB, memoryALink, 'dir')
      const symlinkedDirectoryPrompt = loadAgentMemoryPrompt(
        'worker',
        'project',
      )
      expect(symlinkedDirectoryPrompt).not.toContain('workspace-b-memory')
      expect(symlinkedDirectoryPrompt).toContain('Memory unavailable')
    })
  })

  it('uses collision-resistant components for workspaces and agent names', () => {
    const remote = tempRoot('remote-memory')
    vi.stubEnv('AGENC_REMOTE_MEMORY_DIR', remote)
    const collidingWorkspaceA = '/tmp/a-b/c'
    const collidingWorkspaceB = '/tmp/a/b-c'
    expect(
      getAgentMemoryDir('worker', 'local', collidingWorkspaceA),
    ).not.toBe(getAgentMemoryDir('worker', 'local', collidingWorkspaceB))

    const workspace = tempRoot('memory-components')
    const agentDirs = [
      getAgentMemoryDir('x:y', 'project', workspace),
      getAgentMemoryDir('x-y', 'project', workspace),
      getAgentMemoryDir('Foo', 'project', workspace),
      getAgentMemoryDir('foo', 'project', workspace),
      getAgentMemoryDir('../../../../tmp/leak', 'project', workspace),
      getAgentMemoryDir('CON', 'project', workspace),
    ]
    expect(new Set(agentDirs).size).toBe(agentDirs.length)
    const projectMemoryRoot = join(workspace, '.agenc', 'agent-memory')
    for (const dir of agentDirs) {
      const fromRoot = relative(projectMemoryRoot, dir)
      expect(fromRoot.startsWith('..')).toBe(false)
      expect(fromRoot).not.toBe('')
    }
    expect(dirname(getSnapshotDirForAgent('../../../../tmp/leak', workspace)))
      .toBe(join(workspace, '.agenc', 'agent-memory-snapshots'))
  })

  it('migrates only an unambiguous safe-name legacy memory directory', () => {
    const workspace = tempRoot('memory-legacy-safe')
    const projectMemoryRoot = join(workspace, '.agenc', 'agent-memory')
    const legacyDir = join(projectMemoryRoot, 'worker')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'MEMORY.md'), 'preserved-legacy-memory')

    const prompt = loadAgentMemoryPrompt('worker', 'project', workspace)
    const hashedDir = getAgentMemoryDir('worker', 'project', workspace)
    expect(prompt).toContain('preserved-legacy-memory')
    expect(() => lstatSync(legacyDir)).toThrow()
    expect(readFileSync(join(hashedDir, 'MEMORY.md'), 'utf8')).toBe(
      'preserved-legacy-memory',
    )

    const external = tempRoot('memory-legacy-external')
    writeFileSync(join(external, 'MEMORY.md'), 'must-not-adopt-symlink')
    const linkedLegacy = join(projectMemoryRoot, 'linked-worker')
    symlinkSync(external, linkedLegacy, 'dir')
    expect(
      loadAgentMemoryPrompt('linked-worker', 'project', workspace),
    ).not.toContain('must-not-adopt-symlink')
  })

  it('does not auto-adopt the old non-injective remote workspace namespace', () => {
    const remote = tempRoot('memory-remote-legacy')
    vi.stubEnv('AGENC_REMOTE_MEMORY_DIR', remote)
    const workspace = '/tmp/a-b/c'
    const legacyDir = join(
      remote,
      'projects',
      '-tmp-a-b-c',
      'agent-memory-local',
      'worker',
    )
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'MEMORY.md'), 'ambiguous-legacy-remote')

    expect(loadAgentMemoryPrompt('worker', 'local', workspace)).not.toContain(
      'ambiguous-legacy-remote',
    )
    expect(getAgentMemoryDir('worker', 'local', workspace)).not.toContain(
      `${sep}-tmp-a-b-c${sep}`,
    )
  })

  it('rejects snapshot directory symlinks and ignores snapshot file symlinks', async () => {
    const workspace = tempRoot('snapshot-symlink-workspace')
    const configDir = tempRoot('snapshot-symlink-config')
    const external = tempRoot('snapshot-symlink-external')
    vi.stubEnv('AGENC_CONFIG_DIR', configDir)
    writeFileSync(
      join(external, 'snapshot.json'),
      JSON.stringify({ updatedAt: '2026-07-15T00:00:00.000Z' }),
    )
    writeFileSync(join(external, 'MEMORY.md'), 'external-snapshot-secret')

    const linkedSnapshotDir = getSnapshotDirForAgent(
      'linked-snapshot',
      workspace,
    )
    mkdirSync(dirname(linkedSnapshotDir), { recursive: true })
    symlinkSync(external, linkedSnapshotDir, 'dir')
    await expect(
      checkAgentMemorySnapshot('linked-snapshot', 'user', workspace),
    ).rejects.toThrow(/trusted directory|symlinked directory/)

    const fileLinkedSnapshotDir = getSnapshotDirForAgent(
      'file-linked-snapshot',
      workspace,
    )
    mkdirSync(fileLinkedSnapshotDir, { recursive: true })
    writeFileSync(
      join(fileLinkedSnapshotDir, 'snapshot.json'),
      JSON.stringify({ updatedAt: '2026-07-15T00:00:00.000Z' }),
    )
    symlinkSync(
      join(external, 'MEMORY.md'),
      join(fileLinkedSnapshotDir, 'MEMORY.md'),
    )
    const decision = await checkAgentMemorySnapshot(
      'file-linked-snapshot',
      'user',
      workspace,
    )
    expect(decision.action).toBe('initialize')
    await initializeFromSnapshot(
      'file-linked-snapshot',
      'user',
      decision.snapshotTimestamp ?? '',
      workspace,
    )
    expect(
      loadAgentMemoryPrompt('file-linked-snapshot', 'user', workspace),
    ).not.toContain('external-snapshot-secret')
  })

  it('fails closed when the local memory directory is swapped before a snapshot write', async () => {
    const workspace = tempRoot('snapshot-write-race-workspace')
    const configDir = tempRoot('snapshot-write-race-config')
    const external = tempRoot('snapshot-write-race-external')
    vi.stubEnv('AGENC_CONFIG_DIR', configDir)

    const agentType = 'snapshot-write-race'
    const snapshotDir = getSnapshotDirForAgent(agentType, workspace)
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(join(snapshotDir, 'MEMORY.md'), 'snapshot-memory')

    const localMemoryDir = getAgentMemoryDir(agentType, 'user', workspace)
    const localMemoryPath = localMemoryDir.endsWith(sep)
      ? localMemoryDir.slice(0, -1)
      : localMemoryDir
    const pinnedMemoryPath = `${localMemoryPath}.pinned`
    mkdirSync(localMemoryPath, { recursive: true })
    writeFileSync(join(external, 'MEMORY.md'), 'external-memory')

    let hookCalls = 0
    __setAgentMemorySnapshotFileOperationForTesting(operation => {
      if (operation.operation !== 'write' || operation.filename !== 'MEMORY.md') {
        return
      }
      hookCalls += 1
      renameSync(localMemoryPath, pinnedMemoryPath)
      symlinkSync(external, localMemoryPath, 'dir')
    })

    await expect(
      initializeFromSnapshot(
        agentType,
        'user',
        '2026-07-15T00:00:00.000Z',
        workspace,
      ),
    ).rejects.toThrow(/trusted directory|symlinked directory/)
    expect(hookCalls).toBe(1)
    expect(readFileSync(join(external, 'MEMORY.md'), 'utf8')).toBe(
      'external-memory',
    )
    expect(() => lstatSync(join(pinnedMemoryPath, 'MEMORY.md'))).toThrow()
    expect(() => lstatSync(join(external, '.snapshot-synced.json'))).toThrow()
  })

  it('fails closed when the local memory directory is swapped before snapshot deletion', async () => {
    const workspace = tempRoot('snapshot-delete-race-workspace')
    const configDir = tempRoot('snapshot-delete-race-config')
    const external = tempRoot('snapshot-delete-race-external')
    vi.stubEnv('AGENC_CONFIG_DIR', configDir)

    const agentType = 'snapshot-delete-race'
    const snapshotDir = getSnapshotDirForAgent(agentType, workspace)
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(join(snapshotDir, 'MEMORY.md'), 'replacement-memory')

    const localMemoryDir = getAgentMemoryDir(agentType, 'user', workspace)
    const localMemoryPath = localMemoryDir.endsWith(sep)
      ? localMemoryDir.slice(0, -1)
      : localMemoryDir
    const pinnedMemoryPath = `${localMemoryPath}.pinned`
    mkdirSync(localMemoryPath, { recursive: true })
    writeFileSync(join(localMemoryPath, 'MEMORY.md'), 'local-memory')
    writeFileSync(join(external, 'MEMORY.md'), 'external-memory')

    let hookCalls = 0
    __setAgentMemorySnapshotFileOperationForTesting(operation => {
      if (operation.operation !== 'delete' || operation.filename !== 'MEMORY.md') {
        return
      }
      hookCalls += 1
      renameSync(localMemoryPath, pinnedMemoryPath)
      symlinkSync(external, localMemoryPath, 'dir')
    })

    await expect(
      replaceFromSnapshot(
        agentType,
        'user',
        '2026-07-15T00:00:00.000Z',
        workspace,
      ),
    ).rejects.toThrow(/trusted directory|symlinked directory/)
    expect(hookCalls).toBe(1)
    expect(readFileSync(join(external, 'MEMORY.md'), 'utf8')).toBe(
      'external-memory',
    )
    expect(readFileSync(join(pinnedMemoryPath, 'MEMORY.md'), 'utf8')).toBe(
      'local-memory',
    )
  })

  it('still replaces regular local memory and records the synced snapshot', async () => {
    const workspace = tempRoot('snapshot-replace-workspace')
    const configDir = tempRoot('snapshot-replace-config')
    vi.stubEnv('AGENC_CONFIG_DIR', configDir)

    const agentType = 'snapshot-replace'
    const snapshotDir = getSnapshotDirForAgent(agentType, workspace)
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(join(snapshotDir, 'MEMORY.md'), 'replacement-memory')
    writeFileSync(join(snapshotDir, 'NOTES.md'), 'replacement-notes')

    const localMemoryDir = getAgentMemoryDir(agentType, 'user', workspace)
    mkdirSync(localMemoryDir, { recursive: true })
    writeFileSync(join(localMemoryDir, 'MEMORY.md'), 'old-memory')
    writeFileSync(join(localMemoryDir, 'ORPHAN.md'), 'orphan-memory')
    writeFileSync(join(localMemoryDir, 'keep.txt'), 'keep-me')

    const snapshotTimestamp = '2026-07-15T00:00:00.000Z'
    await replaceFromSnapshot(
      agentType,
      'user',
      snapshotTimestamp,
      workspace,
    )

    expect(readFileSync(join(localMemoryDir, 'MEMORY.md'), 'utf8')).toBe(
      'replacement-memory',
    )
    expect(readFileSync(join(localMemoryDir, 'NOTES.md'), 'utf8')).toBe(
      'replacement-notes',
    )
    expect(() => lstatSync(join(localMemoryDir, 'ORPHAN.md'))).toThrow()
    expect(readFileSync(join(localMemoryDir, 'keep.txt'), 'utf8')).toBe(
      'keep-me',
    )
    expect(
      JSON.parse(
        readFileSync(join(localMemoryDir, '.snapshot-synced.json'), 'utf8'),
      ),
    ).toEqual({ syncedFrom: snapshotTimestamp })
  })

  it('does not replace or delete a multiply-linked memory file', async () => {
    const workspace = tempRoot('snapshot-hardlink-workspace')
    const configDir = tempRoot('snapshot-hardlink-config')
    const external = tempRoot('snapshot-hardlink-external')
    vi.stubEnv('AGENC_CONFIG_DIR', configDir)

    const agentType = 'snapshot-hardlink'
    const snapshotDir = getSnapshotDirForAgent(agentType, workspace)
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(join(snapshotDir, 'MEMORY.md'), 'replacement-memory')

    const externalMemory = join(external, 'outside-memory.md')
    writeFileSync(externalMemory, 'external-memory')
    const localMemoryDir = getAgentMemoryDir(agentType, 'user', workspace)
    mkdirSync(localMemoryDir, { recursive: true })
    const linkedMemory = join(localMemoryDir, 'MEMORY.md')
    linkSync(externalMemory, linkedMemory)

    await replaceFromSnapshot(
      agentType,
      'user',
      '2026-07-15T00:00:00.000Z',
      workspace,
    )

    expect(readFileSync(externalMemory, 'utf8')).toBe('external-memory')
    expect(readFileSync(linkedMemory, 'utf8')).toBe('external-memory')
  })

  it('does not let a project role enable user memory before binding its prompt fingerprint', async () => {
    const workspaceA = tempRoot('snapshot-workspace-a')
    const workspaceB = tempRoot('snapshot-workspace-b')
    const configDir = tempRoot('snapshot-config')
    vi.stubEnv('AGENC_CONFIG_DIR', configDir)
    __setPluginAgentsLoaderForTesting(async () => [])

    const agentsDir = join(workspaceA, '.agenc', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      join(agentsDir, 'snapshot-worker.md'),
      `---
name: snapshot-worker
description: Snapshot worker
memory: user
---
Snapshot role prompt.
`,
    )
    const snapshotDir = getSnapshotDirForAgent('snapshot-worker', workspaceA)
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(
      join(snapshotDir, 'snapshot.json'),
      JSON.stringify({ updatedAt: '2026-07-15T00:00:00.000Z' }),
    )
    writeFileSync(join(snapshotDir, 'MEMORY.md'), 'workspace-a-snapshot')
    process.chdir(workspaceB)

    const firstCatalog = await loadFreshAgentDefinitions(workspaceA)
    const first = firstCatalog.activeAgents.find(
      definition => definition.agentType === 'snapshot-worker',
    )
    expect(first).toBeDefined()
    expect(first?.source).toBe('projectSettings')
    expect(first?.memory).toBeUndefined()
    expect(first?.getSystemPrompt()).toBe('Snapshot role prompt.')
    expect(() =>
      readFileSync(
        join(
          getAgentMemoryDir('snapshot-worker', 'user', workspaceA),
          'MEMORY.md',
        ),
        'utf8',
      ),
    ).toThrow()
    const fingerprint = requireAgentDefinitionRoleFingerprint(first!)

    const secondCatalog = await loadFreshAgentDefinitions(workspaceA)
    const second = secondCatalog.activeAgents.find(
      definition => definition.agentType === 'snapshot-worker',
    )
    expect(second).toBeDefined()
    expect(requireAgentDefinitionRoleFingerprint(second!)).toBe(fingerprint)
  })
})
