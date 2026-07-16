import { randomUUID } from 'crypto'
import { constants } from 'fs'
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  unlink,
} from 'fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'path'
import type { SettingSource } from '../../../utils/settings/constants.js' // upstream-import: keep target is owned by another Z-PURGE item
import { getManagedFilePath } from '../../../utils/settings/managedPath.js' // upstream-import: keep target is owned by another Z-PURGE item
import type { AgentMemoryScope } from '../../../tools/AgentTool/agentMemory.js'
import {
  type AgentDefinition,
  isBuiltInAgent,
  isPluginAgent,
} from 'src/tools/AgentTool/loadAgentsDir.js'
import type { EffortValue } from '../../../utils/effort.js' // upstream-import: keep target is owned by another Z-PURGE item
import { getAgenCConfigHomeDir } from '../../../utils/envUtils.js'
import { getErrnoCode } from '../../../utils/errors.js' // upstream-import: keep target is owned by another Z-PURGE item
import { AGENT_PATHS } from './types.js'
import {
  assertAgentRoleWorkspaceMatches,
  type AgentRoleWorkspace,
} from '../../../agents/role.js'

export interface AgentFileMutationAuthority {
  readonly roleWorkspace: AgentRoleWorkspace
  readonly catalogWorkspaceId?: string
}

interface AgentDirectoryLocation {
  readonly trustAnchor: string
  readonly tierRoot: string
  readonly directory: string
}

interface DirectoryComponentSnapshot {
  readonly path: string
  readonly canonicalPath: string
  readonly dev: number | bigint
  readonly ino: number | bigint
}

type AgentDirectoryHandle = Awaited<ReturnType<typeof open>>
type AgentDirectoryStream = Awaited<ReturnType<typeof opendir>>

interface PinnedAgentDirectory {
  readonly components: readonly DirectoryComponentSnapshot[]
  readonly canonicalAnchor: string
  readonly canonicalTier: string
  readonly canonicalDirectory: string
  readonly handle: AgentDirectoryHandle | undefined
  readonly stream: AgentDirectoryStream | undefined
  readonly operationPath: string
}

interface ExistingAgentFile {
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly mode: number | bigint
  readonly canonicalPath: string
}

type AgentFileOperationPhase = 'before-commit' | 'before-delete'

let agentFileOperationHookForTesting:
  | ((operation: {
      readonly phase: AgentFileOperationPhase
      readonly directory: string
      readonly filename: string
    }) => void | Promise<void>)
  | undefined

/** Test-only race hook used by deterministic filesystem-swap regressions. */
export function __setAgentFileOperationHookForTesting(
  hook: typeof agentFileOperationHookForTesting,
): void {
  agentFileOperationHookForTesting = hook
}

function requireMutationAuthority(
  authority: AgentFileMutationAuthority,
): AgentRoleWorkspace {
  assertAgentRoleWorkspaceMatches(
    authority.roleWorkspace,
    authority.catalogWorkspaceId,
  )
  return authority.roleWorkspace
}

/**
 * Formats agent data as markdown file content
 */
export function formatAgentAsMarkdown(
  agentType: string,
  whenToUse: string,
  tools: string[] | undefined,
  systemPrompt: string,
  color?: string,
  model?: string,
  memory?: AgentMemoryScope,
  effort?: EffortValue,
): string {
  // For YAML double-quoted strings, we need to escape:
  // - Backslashes: \ -> \\
  // - Double quotes: " -> \"
  // - Newlines: \n -> \\n (so yaml reads it as literal backslash-n, not newline)
  const escapedWhenToUse = whenToUse
    .replace(/\\/g, '\\\\') // Escape backslashes first
    .replace(/"/g, '\\"') // Escape double quotes
    .replace(/\n/g, '\\\\n') // Escape newlines as \\n so yaml preserves them as \n

  // Omit tools field entirely when tools is undefined or ['*'] (all tools allowed)
  const isAllTools =
    tools === undefined || (tools.length === 1 && tools[0] === '*')
  const toolsLine = isAllTools ? '' : `\ntools: ${tools.join(', ')}`
  const modelLine = model ? `\nmodel: ${model}` : ''
  const effortLine = effort !== undefined ? `\neffort: ${effort}` : ''
  const colorLine = color ? `\ncolor: ${color}` : ''
  const memoryLine = memory ? `\nmemory: ${memory}` : ''

  return `---
name: ${agentType}
description: "${escapedWhenToUse}"${toolsLine}${modelLine}${effortLine}${colorLine}${memoryLine}
---

${systemPrompt}
`
}

/**
 * Gets the directory path for an agent location
 */
function getAgentDirectoryPath(
  location: SettingSource,
  roleWorkspaceCwd: string,
): string {
  switch (location) {
    case 'flagSettings':
      throw new Error(`Cannot get directory path for ${location} agents`)
    case 'userSettings':
      return join(getAgenCConfigHomeDir(), AGENT_PATHS.AGENTS_DIR)
    case 'projectSettings':
      return join(
        roleWorkspaceCwd,
        AGENT_PATHS.FOLDER_NAME,
        AGENT_PATHS.AGENTS_DIR,
      )
    case 'policySettings':
      return join(
        getManagedFilePath(),
        AGENT_PATHS.FOLDER_NAME,
        AGENT_PATHS.AGENTS_DIR,
      )
    case 'localSettings':
      return join(
        roleWorkspaceCwd,
        AGENT_PATHS.FOLDER_NAME,
        AGENT_PATHS.AGENTS_DIR,
      )
  }
}

function getAgentDirectoryLocation(
  source: SettingSource,
  roleWorkspaceCwd: string,
): AgentDirectoryLocation {
  const directory = getAgentDirectoryPath(source, roleWorkspaceCwd)
  switch (source) {
    case 'flagSettings':
      throw new Error(`Cannot get directory authority for ${source} agents`)
    case 'projectSettings':
    case 'localSettings':
      return {
        trustAnchor: roleWorkspaceCwd,
        tierRoot: roleWorkspaceCwd,
        directory,
      }
    case 'userSettings': {
      const tierRoot = getAgenCConfigHomeDir()
      return { trustAnchor: dirname(tierRoot), tierRoot, directory }
    }
    case 'policySettings': {
      const tierRoot = getManagedFilePath()
      return { trustAnchor: dirname(tierRoot), tierRoot, directory }
    }
  }
}

function getRelativeAgentDirectoryPath(
  location: SettingSource,
  roleWorkspaceCwd: string,
): string {
  switch (location) {
    case 'projectSettings':
      return join('.', AGENT_PATHS.FOLDER_NAME, AGENT_PATHS.AGENTS_DIR)
    default:
      return getAgentDirectoryPath(location, roleWorkspaceCwd)
  }
}

/**
 * Gets the file path for a new agent based on its name
 * Used when creating new agent files
 */
export function getNewAgentFilePath(agent: {
  source: SettingSource
  agentType: string
}, roleWorkspaceCwd: string): string {
  const dirPath = getAgentDirectoryPath(agent.source, roleWorkspaceCwd)
  return join(dirPath, `${agent.agentType}.md`)
}

/**
 * Gets the actual file path for an agent (handles filename vs agentType mismatch)
 * Always use this for existing agents to get their real file location
 */
export function getActualAgentFilePath(
  agent: AgentDefinition,
  roleWorkspaceCwd: string,
): string {
  if (agent.source === 'built-in') {
    return 'Built-in'
  }
  if (agent.source === 'plugin') {
    throw new Error('Cannot get file path for plugin agents')
  }

  const dirPath = getAgentDirectoryPath(agent.source, roleWorkspaceCwd)
  const filename = agent.filename || agent.agentType
  return join(dirPath, `${filename}.md`)
}

/**
 * Gets the relative file path for a new agent based on its name
 * Used for displaying where new agent files will be created
 */
export function getNewRelativeAgentFilePath(agent: {
  source: SettingSource | 'built-in'
  agentType: string
}, roleWorkspaceCwd = '.'): string {
  if (agent.source === 'built-in') {
    return 'Built-in'
  }
  const dirPath = getRelativeAgentDirectoryPath(agent.source, roleWorkspaceCwd)
  return join(dirPath, `${agent.agentType}.md`)
}

/**
 * Gets the actual relative file path for an agent (handles filename vs agentType mismatch)
 */
export function getActualRelativeAgentFilePath(
  agent: AgentDefinition,
  roleWorkspaceCwd = '.',
): string {
  if (isBuiltInAgent(agent)) {
    return 'Built-in'
  }
  if (isPluginAgent(agent)) {
    return `Plugin: ${agent.plugin || 'Unknown'}`
  }
  if (agent.source === 'flagSettings') {
    return 'CLI argument'
  }

  const dirPath = getRelativeAgentDirectoryPath(agent.source, roleWorkspaceCwd)
  const filename = agent.filename || agent.agentType
  return join(dirPath, `${filename}.md`)
}

/**
 * Saves an agent to the filesystem
 * @param checkExists - If true, throws error if file already exists
 */
export async function saveAgentToFile(
  authority: AgentFileMutationAuthority,
  source: SettingSource | 'built-in',
  agentType: string,
  whenToUse: string,
  tools: string[] | undefined,
  systemPrompt: string,
  checkExists = true,
  color?: string,
  model?: string,
  memory?: AgentMemoryScope,
  effort?: EffortValue,
): Promise<void> {
  const roleWorkspace = requireMutationAuthority(authority)
  if (source === 'built-in') {
    throw new Error('Cannot save built-in agents')
  }

  const filePath = getNewAgentFilePath(
    { source, agentType },
    roleWorkspace.cwd,
  )

  const content = formatAgentAsMarkdown(
    agentType,
    whenToUse,
    tools,
    systemPrompt,
    color,
    model,
    memory,
    effort,
  )
  try {
    await writeTrustedAgentFile(
      getAgentDirectoryLocation(source, roleWorkspace.cwd),
      `${agentType}.md`,
      content,
      checkExists,
    )
  } catch (e: unknown) {
    if (getErrnoCode(e) === 'EEXIST') {
      throw new Error(`Agent file already exists: ${filePath}`)
    }
    throw e
  }
}

/**
 * Updates an existing agent file
 */
export async function updateAgentFile(
  authority: AgentFileMutationAuthority,
  agent: AgentDefinition,
  newWhenToUse: string,
  newTools: string[] | undefined,
  newSystemPrompt: string,
  newColor?: string,
  newModel?: string,
  newMemory?: AgentMemoryScope,
  newEffort?: EffortValue,
): Promise<void> {
  const roleWorkspace = requireMutationAuthority(authority)
  if (agent.source === 'built-in') {
    throw new Error('Cannot update built-in agents')
  }
  if (agent.source === 'plugin') {
    throw new Error('Cannot get file path for plugin agents')
  }

  const content = formatAgentAsMarkdown(
    agent.agentType,
    newWhenToUse,
    newTools,
    newSystemPrompt,
    newColor,
    newModel,
    newMemory,
    newEffort,
  )

  const filename = agent.filename || agent.agentType
  await writeTrustedAgentFile(
    getAgentDirectoryLocation(agent.source, roleWorkspace.cwd),
    `${filename}.md`,
    content,
    false,
  )
}

/**
 * Deletes an agent file
 */
export async function deleteAgentFromFile(
  authority: AgentFileMutationAuthority,
  agent: AgentDefinition,
): Promise<void> {
  const roleWorkspace = requireMutationAuthority(authority)
  if (agent.source === 'built-in') {
    throw new Error('Cannot delete built-in agents')
  }
  if (agent.source === 'plugin') {
    throw new Error('Cannot get file path for plugin agents')
  }

  const filename = agent.filename || agent.agentType
  await deleteTrustedAgentFile(
    getAgentDirectoryLocation(agent.source, roleWorkspace.cwd),
    `${filename}.md`,
  )
}

function isSameOrChildPath(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child === '' || (
    child !== '..' &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  )
}

function isSameIdentity(
  actual: { readonly dev: number | bigint; readonly ino: number | bigint },
  expected: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino
}

function validateAgentFilename(filename: string): void {
  if (
    filename.length === 0 ||
    filename === '.' ||
    filename === '..' ||
    basename(filename) !== filename ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('\0')
  ) {
    throw new Error('invalid agent filename')
  }
}

async function snapshotTrustedDirectoryComponent(
  path: string,
): Promise<DirectoryComponentSnapshot> {
  const before = await lstat(path)
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`agent directory is not trusted: ${path}`)
  }
  const canonicalPath = await realpath(path)
  const after = await lstat(path)
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    !isSameIdentity(after, before)
  ) {
    throw new Error(`agent directory changed during validation: ${path}`)
  }
  return {
    path,
    canonicalPath,
    dev: after.dev,
    ino: after.ino,
  }
}

async function prepareTrustedDirectoryComponents(
  location: AgentDirectoryLocation,
  create: boolean,
): Promise<readonly DirectoryComponentSnapshot[] | undefined> {
  const trustAnchor = resolve(location.trustAnchor)
  const tierRoot = resolve(location.tierRoot)
  const directory = resolve(location.directory)
  if (
    !isSameOrChildPath(trustAnchor, tierRoot) ||
    !isSameOrChildPath(tierRoot, directory)
  ) {
    throw new Error('agent directory escapes its trusted tier')
  }

  const componentPaths = [trustAnchor]
  let componentPath = trustAnchor
  const child = relative(trustAnchor, directory)
  if (child.length > 0) {
    for (const component of child.split(sep)) {
      componentPath = join(componentPath, component)
      componentPaths.push(componentPath)
    }
  }

  const snapshots: DirectoryComponentSnapshot[] = []
  for (const path of componentPaths) {
    try {
      snapshots.push(await snapshotTrustedDirectoryComponent(path))
      continue
    } catch (error) {
      if (getErrnoCode(error) !== 'ENOENT') throw error
      if (!create) return undefined
      if (path === trustAnchor) {
        throw new Error(`agent directory trust anchor does not exist: ${path}`)
      }
    }

    try {
      await mkdir(path, { mode: 0o700 })
    } catch (error) {
      if (getErrnoCode(error) !== 'EEXIST') throw error
    }
    snapshots.push(await snapshotTrustedDirectoryComponent(path))
  }

  const anchor = snapshots[0]
  const tier = snapshots.find(snapshot => snapshot.path === tierRoot)
  const agentDirectory = snapshots.at(-1)
  if (
    anchor === undefined ||
    tier === undefined ||
    agentDirectory === undefined ||
    !isSameOrChildPath(anchor.canonicalPath, tier.canonicalPath) ||
    !isSameOrChildPath(tier.canonicalPath, agentDirectory.canonicalPath)
  ) {
    throw new Error('agent directory canonical path escapes its trusted tier')
  }
  return snapshots
}

async function assertPinnedAgentDirectoryCurrent(
  pinned: PinnedAgentDirectory,
): Promise<void> {
  const current = await Promise.all(
    pinned.components.map(snapshot =>
      snapshotTrustedDirectoryComponent(snapshot.path),
    ),
  )
  for (const [index, snapshot] of pinned.components.entries()) {
    const currentSnapshot = current[index]
    if (
      currentSnapshot === undefined ||
      !isSameIdentity(currentSnapshot, snapshot) ||
      currentSnapshot.canonicalPath !== snapshot.canonicalPath
    ) {
      throw new Error('agent directory changed during file operation')
    }
  }

  const opened = await pinned.handle?.stat()
  const directory = pinned.components.at(-1)
  if (
    directory === undefined ||
    (opened !== undefined &&
      (!opened.isDirectory() || !isSameIdentity(opened, directory))) ||
    !isSameOrChildPath(pinned.canonicalAnchor, pinned.canonicalTier) ||
    !isSameOrChildPath(pinned.canonicalTier, pinned.canonicalDirectory)
  ) {
    throw new Error('agent directory pin is no longer trusted')
  }
}

async function pinTrustedAgentDirectory(
  location: AgentDirectoryLocation,
  create: boolean,
): Promise<PinnedAgentDirectory | undefined> {
  const components = await prepareTrustedDirectoryComponents(location, create)
  if (components === undefined) return undefined
  const anchor = components[0]
  const tier = components.find(snapshot =>
    snapshot.path === resolve(location.tierRoot),
  )
  const directory = components.at(-1)
  if (anchor === undefined || tier === undefined || directory === undefined) {
    throw new Error('agent directory could not be pinned')
  }

  let handle: AgentDirectoryHandle | undefined
  let stream: AgentDirectoryStream | undefined
  try {
    handle = await open(
      directory.path,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    )
  } catch (error) {
    if (process.platform !== 'win32') throw error
    stream = await opendir(directory.path)
  }

  try {
    const opened = await handle?.stat()
    if (
      opened !== undefined &&
      (!opened.isDirectory() || !isSameIdentity(opened, directory))
    ) {
      throw new Error('agent directory changed while opening')
    }

    let operationPath = directory.canonicalPath
    if (handle !== undefined) {
      const descriptorPaths = process.platform === 'linux'
        ? [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]
        : [`/dev/fd/${handle.fd}`]
      for (const descriptorPath of descriptorPaths) {
        try {
          if (await realpath(descriptorPath) === directory.canonicalPath) {
            operationPath = descriptorPath
            break
          }
        } catch {
          // Descriptor-relative paths are unavailable on some platforms.
          // The directory identity checks below remain mandatory.
        }
      }
    }

    const pinned: PinnedAgentDirectory = {
      components,
      canonicalAnchor: anchor.canonicalPath,
      canonicalTier: tier.canonicalPath,
      canonicalDirectory: directory.canonicalPath,
      handle,
      stream,
      operationPath,
    }
    await assertPinnedAgentDirectoryCurrent(pinned)
    return pinned
  } catch (error) {
    await handle?.close().catch(() => {})
    await stream?.close().catch(() => {})
    throw error
  }
}

async function closePinnedAgentDirectory(
  pinned: PinnedAgentDirectory,
): Promise<void> {
  await pinned.handle?.close().catch(() => {})
  await pinned.stream?.close().catch(() => {})
}

async function inspectTrustedAgentFile(
  path: string,
  pinned: PinnedAgentDirectory,
): Promise<ExistingAgentFile | undefined> {
  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(path)
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return undefined
    throw error
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1
  ) {
    throw new Error('agent file must be a regular single-link file')
  }

  const canonicalPath = await realpath(path)
  const after = await lstat(path)
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1 ||
    !isSameIdentity(after, before) ||
    canonicalPath === pinned.canonicalDirectory ||
    !isSameOrChildPath(pinned.canonicalDirectory, canonicalPath) ||
    !isSameOrChildPath(pinned.canonicalTier, canonicalPath)
  ) {
    throw new Error('agent file is outside its trusted directory')
  }
  return {
    dev: after.dev,
    ino: after.ino,
    mode: after.mode,
    canonicalPath,
  }
}

function throwAgentFileExists(path: string): never {
  const error = new Error(`agent file already exists: ${path}`) as NodeJS.ErrnoException
  error.code = 'EEXIST'
  throw error
}

async function syncPinnedDirectory(pinned: PinnedAgentDirectory): Promise<void> {
  if (pinned.handle === undefined) return
  try {
    await pinned.handle.sync()
  } catch (error) {
    if (
      process.platform === 'win32' ||
      ['EBADF', 'EINVAL', 'ENOTSUP'].includes(getErrnoCode(error) ?? '')
    ) {
      return
    }
    throw error
  }
}

async function writeTrustedAgentFile(
  location: AgentDirectoryLocation,
  filename: string,
  content: string,
  checkExists: boolean,
): Promise<void> {
  validateAgentFilename(filename)
  const pinned = await pinTrustedAgentDirectory(location, true)
  if (pinned === undefined) throw new Error('agent directory is unavailable')
  const targetPath = join(pinned.operationPath, filename)
  const displayPath = join(resolve(location.directory), filename)
  const temporaryFilename = `.${filename}.${process.pid}.${randomUUID()}.tmp`
  const temporaryPath = join(pinned.operationPath, temporaryFilename)
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined
  let renamed = false
  try {
    const existing = await inspectTrustedAgentFile(targetPath, pinned)
    if (checkExists && existing !== undefined) throwAgentFileExists(displayPath)
    await assertPinnedAgentDirectoryCurrent(pinned)

    const targetMode = existing === undefined
      ? 0o600
      : Number(existing.mode) & 0o777
    temporaryHandle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      targetMode,
    )
    // open(2) applies umask even when replacing an existing file. Restore the
    // intended private/new mode or the exact existing mode on the temporary
    // inode before it can be published.
    await temporaryHandle.chmod(targetMode)
    const opened = await temporaryHandle.stat()
    const canonicalTemporary = await realpath(temporaryPath)
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !isSameOrChildPath(pinned.canonicalDirectory, canonicalTemporary)
    ) {
      throw new Error('temporary agent file is unsafe')
    }

    await temporaryHandle.writeFile(content, { encoding: 'utf-8' })
    await temporaryHandle.datasync()
    const afterWrite = await temporaryHandle.stat()
    if (
      !afterWrite.isFile() ||
      afterWrite.nlink !== 1 ||
      !isSameIdentity(afterWrite, opened)
    ) {
      throw new Error('temporary agent file changed while writing')
    }

    await agentFileOperationHookForTesting?.({
      phase: 'before-commit',
      directory: resolve(location.directory),
      filename,
    })
    await assertPinnedAgentDirectoryCurrent(pinned)
    const current = await inspectTrustedAgentFile(targetPath, pinned)
    if (
      (existing === undefined && current !== undefined) ||
      (existing !== undefined &&
        (current === undefined ||
          !isSameIdentity(current, existing) ||
          current.canonicalPath !== existing.canonicalPath))
    ) {
      throw new Error('agent file changed during update')
    }
    const currentTemporary = await inspectTrustedAgentFile(
      temporaryPath,
      pinned,
    )
    if (
      currentTemporary === undefined ||
      !isSameIdentity(currentTemporary, opened) ||
      currentTemporary.canonicalPath !== canonicalTemporary
    ) {
      throw new Error('temporary agent file changed before commit')
    }

    await rename(temporaryPath, targetPath)
    renamed = true
    const committed = await inspectTrustedAgentFile(targetPath, pinned)
    if (committed === undefined || !isSameIdentity(committed, opened)) {
      throw new Error('agent file changed while committing')
    }
    await assertPinnedAgentDirectoryCurrent(pinned)
    await syncPinnedDirectory(pinned)
  } finally {
    await temporaryHandle?.close().catch(() => {})
    if (!renamed) await unlink(temporaryPath).catch(() => {})
    await closePinnedAgentDirectory(pinned)
  }
}

async function deleteTrustedAgentFile(
  location: AgentDirectoryLocation,
  filename: string,
): Promise<void> {
  validateAgentFilename(filename)
  const pinned = await pinTrustedAgentDirectory(location, false)
  if (pinned === undefined) return
  const targetPath = join(pinned.operationPath, filename)
  try {
    const existing = await inspectTrustedAgentFile(targetPath, pinned)
    if (existing === undefined) return
    await agentFileOperationHookForTesting?.({
      phase: 'before-delete',
      directory: resolve(location.directory),
      filename,
    })
    await assertPinnedAgentDirectoryCurrent(pinned)
    const current = await inspectTrustedAgentFile(targetPath, pinned)
    if (
      current === undefined ||
      !isSameIdentity(current, existing) ||
      current.canonicalPath !== existing.canonicalPath
    ) {
      throw new Error('agent file changed during deletion')
    }
    await unlink(targetPath)
    if (await inspectTrustedAgentFile(targetPath, pinned) !== undefined) {
      throw new Error('agent file still exists after deletion')
    }
    await assertPinnedAgentDirectoryCurrent(pinned)
    await syncPinnedDirectory(pinned)
  } finally {
    await closePinnedAgentDirectory(pinned)
  }
}
