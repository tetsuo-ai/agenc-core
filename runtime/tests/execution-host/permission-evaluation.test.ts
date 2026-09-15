import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore } from '../../src/config/store.js'
import { ExecutionConfigFilesystem } from '../../src/config/workspace-filesystem.js'
import { createAgentRoleWorkspace } from '../../src/agents/role.js'
import { runWithCurrentRuntimeSession } from '../../src/session/current-session.js'
import type { Session } from '../../src/session/session.js'
import { getAgentMemoryDir, isAuthorizedAgentMemoryPath } from '../../src/tools/AgentTool/agentMemory.js'
import type { Tool, ToolPermissionContext } from '../../src/tools/Tool.js'
import { runWithAgentMemoryAuthorization } from '../../src/utils/agentContext.js'
import * as hostPaths from '../../src/utils/fsOperations.js'
import { checkReadPermissionForTool, checkWritePermissionForTool, checkReadableInternalPath, checkEditableInternalPath } from '../../src/utils/permissions/filesystem.js'
import { runWithCanonicalSettingsAuthority } from '../../src/utils/settings/canonicalAuthority.js'
import { TaskFiles } from './task-files-fixture.js'
import { checkToolPathPermissionAsync, checkToolPathPermission } from '../../src/permissions/path-validation.js'
import { createFileReadTool } from '../../src/tools/system/file-read.js'
import { createFileWriteTool } from '../../src/tools/system/file-write.js'
import { createFileEditTool, createFileMultiEditTool } from '../../src/tools/system/file-edit.js'
import { createNotebookEditTool } from '../../src/tools/system/notebook-edit.js'
import { createApplyPatchTool } from '../../src/tools/apply-patch/tool.js'
import { SESSION_ALLOWED_ROOTS_ARG, SESSION_ALLOWED_ROOTS_SIG_ARG, verifyAllowedRoots } from '../../src/agents/_deps/filesystem-args.js'
import { buildFileWriteApprovalPreview } from '../../src/permissions/file-write-preview.js'
import * as fileState from '../../src/tools/system/filesystem.js'
import type { ToolInvocation } from '../../src/tools/context.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const tool = { name: 'FileRead', getPath: (input: Record<string, unknown>) => String(input.file_path) } as unknown as Tool
function context(overrides: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {},
    alwaysAskRules: {}, isBypassPermissionsModeAvailable: false, ...overrides } as ToolPermissionContext
}
async function setup(files: TaskFiles, container = 'a', generation = 'b') {
  const home = await mkdtemp(join(tmpdir(), 'agenc-permission-evaluation-')); roots.push(home)
  files.put('/app', '', true); files.put('/home/task', '', true)
  const store = new ConfigStore({ home, cwd: '/app', projectRoot: '/app',
    workspaceFilesystem: new ExecutionConfigFilesystem(files.environment(container, generation), { homePath: '/home/task' }) })
  await store.reload()
  return store
}
function link(files: TaskFiles, path: string, target: string) {
  files.put(path, target)
  const entry = files.entries.get(path)!
  files.entries.set(path, { ...entry, identity: { ...entry.identity, mode: String(0o120777) } })
}
const read = (path: string, permissions = context()) => checkReadPermissionForTool(tool, { file_path: path }, permissions)
const write = (path: string, permissions = context()) => checkWritePermissionForTool(tool, { file_path: path }, permissions)

test('uses task paths, task home, intermediate deny rules and protected working roots without host lookup', async () => {
  const files = new TaskFiles(), store = await setup(files)
  files.put('/app/file', 'task'); files.put('/outside/file', 'outside'); files.put('/home/task/file', 'task home')
  link(files, '/app/alias', '/intermediate'); link(files, '/intermediate', '/outside/file')
  await runWithCanonicalSettingsAuthority(store, async () => {
    vi.spyOn(hostPaths, 'getPathsForPermissionCheck').mockImplementation(() => { throw new Error('host path lookup') })
    vi.spyOn(hostPaths, 'getFsImplementation').mockImplementation(() => { throw new Error('host filesystem lookup') })
    expect((await read('file')).behavior).toBe('allow')
    expect((await write('file', context({ mode: 'acceptEdits' }))).behavior).toBe('allow')
    expect((await read('alias', context({ mode: 'bypassPermissions', alwaysDenyRules: { session: ['FileRead(//intermediate)'] } }))).behavior).toBe('deny')
    expect((await read('~/file', context({ alwaysAllowRules: { session: ['FileRead(~/file)'] } }))).behavior).toBe('allow')
    expect((await read('alias')).behavior).toBe('ask')
    expect((await read('alias', context({ additionalWorkingDirectories: new Map([['/outside', { path: '/outside', source: 'session' }]]) }))).behavior).toBe('ask')
    // Every intermediate path must be in an allowed root, even when its final target is permitted.
    expect((await write('/outside/new', context({ mode: 'acceptEdits', additionalWorkingDirectories: new Map([['/outside', { path: '/outside', source: 'session' }]]) }))).behavior).toBe('allow')
  })
})

test('authorizes only private task memory for the exact role and preserves deny/ask precedence', async () => {
  const files = new TaskFiles(), store = await setup(files)
  const path = getAgentMemoryDir('worker', 'project', '/app') + 'MEMORY.md'
  const sibling = getAgentMemoryDir('other', 'project', '/app') + 'MEMORY.md'
  files.put(path, 'notes'); files.put(sibling, 'private')
  await runWithCanonicalSettingsAuthority(store, () => runWithAgentMemoryAuthorization({ agentType: 'worker', scope: 'project' }, async () => {
    expect((await read(path)).behavior).toBe('allow')
    expect((await write(path)).behavior).toBe('allow')
    expect((await write(path.replace('MEMORY.md', 'new.md'))).behavior).toBe('allow')
    expect((await read(path, context({ alwaysDenyRules: { session: ['FileRead(**/MEMORY.md)'] } }))).behavior).toBe('deny')
    expect((await read(path, context({ alwaysAskRules: { session: ['FileRead(**/MEMORY.md)'] } }))).behavior).toBe('ask')
    expect((await read(sibling, context({ mode: 'bypassPermissions', alwaysAskRules: { session: ['FileRead(**/MEMORY.md)'] } }))).decisionReason?.type).toBe('safetyCheck')
    const entry = files.entries.get(path)!
    files.entries.set(path, { ...entry, identity: { ...entry.identity, nlink: '2' } })
    expect((await read(path, context({ mode: 'bypassPermissions' }))).behavior).toBe('ask')
    expect((await write(path)).behavior).toBe('ask')
    files.entries.set(path, entry)
    link(files, path.replace('MEMORY.md', 'alias.md'), 'MEMORY.md')
    expect((await read(path.replace('MEMORY.md', 'alias.md'))).behavior).toBe('ask')
    expect(() => isAuthorizedAgentMemoryPath(path, '/app', { agentType: 'worker', scope: 'project' })).toThrow(/protected|asynchronous/)
    expect(() => checkReadableInternalPath(path, {})).toThrow(/asynchronous/)
    expect(() => checkEditableInternalPath(path, {})).toThrow(/asynchronous/)
  }))
})

test('does not reuse memory metadata across equal paths in different environments', async () => {
  const left = new TaskFiles(), right = new TaskFiles()
  const first = await setup(left), second = await setup(right, 'd', 'e')
  const path = getAgentMemoryDir('worker', 'project', '/app') + 'MEMORY.md'
  left.put(path, 'private'); right.put(path, 'linked')
  const entry = right.entries.get(path)!
  right.entries.set(path, { ...entry, identity: { ...entry.identity, nlink: '2' } })
  const decide = (store: ConfigStore) => runWithCanonicalSettingsAuthority(store, () =>
    runWithAgentMemoryAuthorization({ agentType: 'worker', scope: 'project' }, () => read(path)))
  expect((await Promise.all([decide(first), decide(second)])).map(result => result.behavior)).toEqual(['allow', 'ask'])
})

test('propagates environment loss and rejects foreign or changed authority before permission settlement', async () => {
  const files = new TaskFiles(), store = await setup(files)
  files.put('/app/file', 'task')
  await runWithCanonicalSettingsAuthority(store, async () => {
    const foreign = { roleWorkspace: createAgentRoleWorkspace('/app', files.environment('d').binding) } as Session
    await expect(runWithCurrentRuntimeSession(foreign, () => read('file'))).rejects.toMatchObject({ code: 'execution_environment_changed' })
    files.unavailable = true
    await expect(read('file', context({ mode: 'bypassPermissions' }))).rejects.toMatchObject({ code: 'environment_dead' })
    files.unavailable = false
    const describe = files.filesystem.describePath
    let reloaded = false
    files.filesystem.describePath = async (path, policy) => {
      const result = await describe(path, policy)
      if (!reloaded && path === '/app/file') { reloaded = true; await store.reload() }
      return result
    }
    await expect(read('file')).rejects.toMatchObject({ code: 'execution_environment_changed' })
  })
})

test('canonical file-tool permission entrypoints use the task filesystem and every patch target', async () => {
  const files = new TaskFiles(), store = await setup(files)
  files.put('/app/file', 'task'); files.put('/outside/secret', 'outside')
  link(files, '/app/alias', '../middle'); link(files, '/middle', '/outside/secret')
  await runWithCanonicalSettingsAuthority(store, async () => {
    const policy = context({ mode: 'acceptEdits', alwaysDenyRules: { session: ['FileRead(/middle)', 'Write(/middle)'] } })
    const toolContext = { getAppState: () => ({ toolPermissionContext: policy }) } as Parameters<NonNullable<ReturnType<typeof createFileReadTool>['checkPermissions']>>[1]
    const tools = [createFileReadTool({ allowedPaths: ['/app'] }), createFileWriteTool({ allowedPaths: ['/app'] }),
      createFileEditTool({ allowedPaths: ['/app'] }), createFileMultiEditTool({ allowedPaths: ['/app'] }),
      createNotebookEditTool({ workspaceRoot: '/app' })]
    for (const selected of tools) {
      const allowed = await selected.checkPermissions!({ file_path: '/app/file', notebook_path: '/app/file' }, toolContext)
      expect(allowed.behavior, selected.name).toBe('allow')
      const denied = await selected.checkPermissions!({ file_path: '/app/alias', notebook_path: '/app/alias' }, toolContext)
      expect(denied.behavior, selected.name).toBe('deny')
    }
    const patch = createApplyPatchTool({ cwd: '/app', allowedPaths: ['/app'] })
    const result = await patch.checkPermissions!({ input: '*** Begin Patch\n*** Add File: /app/new\n+new\n*** Delete File: /app/alias\n*** End Patch' }, toolContext)
    expect(result.behavior).toBe('deny')
    expect(files.reads).toEqual([])
    expect(() => checkToolPathPermission({ toolName: 'FileRead', input: {}, path: '/app/file', cwd: '/app', context: policy, operationType: 'read' })).toThrow(/asynchronous/)
  })
})

test('canonical permissions preserve explicit cwd, task home, signed outside roots and private role origin', async () => {
  const files = new TaskFiles(), store = await setup(files)
  files.put('/other/file', 'other'); files.put('/outside/file', 'outside'); files.put('/home/task/file', 'home')
  files.put('/app/literal$file', 'literal')
  files.put("/app/'quoted'", 'quoted')
  files.put('/app/[private]', 'private')
  const memory = getAgentMemoryDir('worker', 'project', '/app') + 'MEMORY.md'; files.put(memory, 'private')
  const decide = (path: string, policy = context(), cwd = '/app', operationType: 'read' | 'write' = 'read') =>
    checkToolPathPermissionAsync({ toolName: 'FileRead', input: { file_path: path }, path, cwd, context: policy, operationType })
  await runWithCanonicalSettingsAuthority(store, async () => {
    expect((await decide('file', context(), '/other')).behavior).toBe('allow')
    const outside = await decide('/outside/file', context({ mode: 'bypassPermissions' }))
    expect(outside.behavior).toBe('allow')
    const input = outside.updatedInput as Record<string, unknown>
    expect(verifyAllowedRoots(input[SESSION_ALLOWED_ROOTS_ARG], input[SESSION_ALLOWED_ROOTS_SIG_ARG])).toContain('/outside')
    expect((await decide('~/file', context({ alwaysAllowRules: { session: ['FileRead(~/file)'] } }))).behavior).toBe('allow')
    expect((await decide('/app/literal$file', context({ mode: 'bypassPermissions' }))).behavior).toBe('allow')
    expect((await decide('/app/literal$file', context({ mode: 'bypassPermissions', alwaysDenyRules: { session: ['FileRead(/app/literal$file)'] } }))).behavior).toBe('deny')
    expect((await decide("/app/'quoted'", context({ mode: 'bypassPermissions', alwaysDenyRules: { session: ["FileRead(/app/'quoted')"] } }))).behavior).toBe('deny')
    expect((await decide('/app/[private]', context({ mode: 'bypassPermissions', alwaysDenyRules: { session: ['FileRead(/app/[private])'] } }))).behavior).toBe('deny')
    await runWithAgentMemoryAuthorization({ agentType: 'worker', scope: 'project' }, async () => {
      expect((await decide(memory, context(), '/other', 'write')).behavior).toBe('allow')
      expect((await decide(memory, context({ alwaysAskRules: { session: ['FileRead(**/MEMORY.md)'] } }))).behavior).toBe('ask')
      const entry = files.entries.get(memory)!
      files.entries.set(memory, { ...entry, identity: { ...entry.identity, nlink: '2' } })
      expect((await decide(memory, context({ mode: 'bypassPermissions' }))).decisionReason?.type).toBe('safetyCheck')
    })
    files.unavailable = true
    await expect(decide('/app/file', context({ mode: 'bypassPermissions' }))).rejects.toMatchObject({ code: 'environment_dead' })
  })
})

test('a task approval preview cannot read a controller shadow or an unbound read cache', async () => {
  const files = new TaskFiles(), store = await setup(files)
  files.put('/app/file', 'task file')
  fileState.recordSessionRead('task-preview', '/app/file', { content: 'controller shadow', rawContent: 'controller shadow', viewKind: 'full' })
  const safe = vi.spyOn(fileState, 'safePath')
  const snapshot = vi.spyOn(fileState, 'getSessionReadSnapshot')
  const invocation = { turn: { cwd: '/app' }, session: { conversationId: 'task-preview',
    services: { permissionModeRegistry: { current: () => context() } } } } as unknown as ToolInvocation
  await runWithCanonicalSettingsAuthority(store, async () => {
    expect(await buildFileWriteApprovalPreview(invocation, { file_path: '/app/file' })).toMatchObject({ kind: 'unavailable' })
    expect(safe).not.toHaveBeenCalled(); expect(snapshot).toHaveBeenCalledWith('task-preview', '/app/file')
  })
  fileState.clearSessionReadState('task-preview')
})
