import { constants } from 'fs'
import {
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
  unlink,
} from 'fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'path'
import { z } from 'zod/v4'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { getAgenCConfigHomeDir } from '../../utils/envUtils.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import {
  agentMemoryPathComponent,
  assertTrustedAgentScopedDirectory,
  ensureAgentMemoryDir,
  type AgentMemoryScope,
  migrateLegacyAgentScopedDirectory,
} from './agentMemory.js'

const SNAPSHOT_BASE = 'agent-memory-snapshots'
const SNAPSHOT_JSON = 'snapshot.json'
const SYNCED_JSON = '.snapshot-synced.json'

type SnapshotFileOperation = 'write' | 'delete'
type SnapshotFileOperationForTesting = (operation: {
  readonly operation: SnapshotFileOperation
  readonly trustedDirectory: string
  readonly filename: string
}) => void | Promise<void>

let snapshotFileOperationForTesting:
  | SnapshotFileOperationForTesting
  | undefined

/** Test-only seam for deterministic validation-to-operation race coverage. */
export function __setAgentMemorySnapshotFileOperationForTesting(
  operation: SnapshotFileOperationForTesting | undefined,
): void {
  snapshotFileOperationForTesting = operation
}

const snapshotMetaSchema = lazySchema(() =>
  z.object({
    updatedAt: z.string().min(1),
  }),
)

const syncedMetaSchema = lazySchema(() =>
  z.object({
    syncedFrom: z.string().min(1),
  }),
)
type SyncedMeta = z.infer<ReturnType<typeof syncedMetaSchema>>

/**
 * Returns the path to the snapshot directory for an agent in the current project.
 * e.g., <cwd>/.agenc/agent-memory-snapshots/<agentType>/
 */
export function getSnapshotDirForAgent(
  agentType: string,
  cwd: string = getCwd(),
): string {
  return join(
    cwd,
    '.agenc',
    SNAPSHOT_BASE,
    agentMemoryPathComponent(agentType),
  )
}

function ensureSnapshotDirForAgent(agentType: string, cwd: string): string {
  const parentDir = join(cwd, '.agenc', SNAPSHOT_BASE)
  const directory = migrateLegacyAgentScopedDirectory(
    parentDir,
    cwd,
    agentType,
  )
  assertTrustedAgentScopedDirectory(directory, cwd)
  return directory
}

function getSyncedJsonPath(
  agentType: string,
  scope: AgentMemoryScope,
  cwd: string,
): string {
  return join(ensureAgentMemoryDir(agentType, scope, cwd), SYNCED_JSON)
}

async function readJsonFile<T>(
  path: string,
  trustedDirectory: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const content = await readRegularFileWithinDirectory(
      path,
      trustedDirectory,
    )
    if (content === null) return null
    const result = schema.safeParse(jsonParse(content))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

function isSameOrChildPath(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child === '' || (
    child !== '..' &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  )
}

type DirectoryHandle = Awaited<ReturnType<typeof open>>
type DirectoryStream = Awaited<ReturnType<typeof opendir>>

interface PinnedTrustedDirectory {
  readonly path: string
  readonly canonicalPath: string
  readonly canonicalTrustAnchor: string
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly handle: DirectoryHandle | undefined
  readonly stream: DirectoryStream | undefined
  readonly operationPath: string
}

function isSameIdentity(
  actual: { readonly dev: number | bigint; readonly ino: number | bigint },
  expected: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino
}

async function assertPinnedDirectoryCurrent(
  pinned: PinnedTrustedDirectory,
): Promise<void> {
  const [lexical, canonical, opened] = await Promise.all([
    lstat(pinned.path),
    realpath(pinned.path),
    pinned.handle?.stat(),
  ])
  if (
    !lexical.isDirectory() ||
    lexical.isSymbolicLink() ||
    !isSameIdentity(lexical, pinned) ||
    canonical !== pinned.canonicalPath ||
    !isSameOrChildPath(pinned.canonicalTrustAnchor, canonical) ||
    (opened !== undefined &&
      (!opened.isDirectory() || !isSameIdentity(opened, pinned)))
  ) {
    throw new Error('agent memory snapshot directory changed during operation')
  }
}

async function pinTrustedDirectory(
  trustedDirectory: string,
  trustAnchor: string,
): Promise<PinnedTrustedDirectory> {
  const [lexical, canonicalPath, canonicalTrustAnchor] = await Promise.all([
    lstat(trustedDirectory),
    realpath(trustedDirectory),
    realpath(trustAnchor),
  ])
  if (
    !lexical.isDirectory() ||
    lexical.isSymbolicLink() ||
    !isSameOrChildPath(canonicalTrustAnchor, canonicalPath)
  ) {
    throw new Error('agent memory snapshot directory is not trusted')
  }

  let handle: DirectoryHandle | undefined
  let stream: DirectoryStream | undefined
  try {
    handle = await open(
      trustedDirectory,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    )
  } catch (error) {
    // Windows does not consistently permit opening a directory as a file
    // handle. Keep an opendir handle pinned instead of proceeding unpinned.
    if (process.platform !== 'win32') throw error
    stream = await opendir(trustedDirectory)
  }

  try {
    const opened = await handle?.stat()
    if (
      opened !== undefined &&
      (!opened.isDirectory() || !isSameIdentity(opened, lexical))
    ) {
      throw new Error('agent memory snapshot directory changed while opening')
    }

    let operationPath = canonicalPath
    if (handle !== undefined) {
      const descriptorPaths = process.platform === 'linux'
        ? [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]
        : [`/dev/fd/${handle.fd}`]
      for (const descriptorPath of descriptorPaths) {
        try {
          if (await realpath(descriptorPath) === canonicalPath) {
            // Resolve child operations through the pinned directory inode so
            // a pathname replacement cannot redirect them to a symlink target.
            operationPath = descriptorPath
            break
          }
        } catch {
          // Descriptor paths are optional and unavailable on some platforms
          // or in restricted environments. Identity checks remain mandatory.
        }
      }
    }

    const pinned: PinnedTrustedDirectory = {
      path: trustedDirectory,
      canonicalPath,
      canonicalTrustAnchor,
      dev: lexical.dev,
      ino: lexical.ino,
      handle,
      stream,
      operationPath,
    }
    await assertPinnedDirectoryCurrent(pinned)
    return pinned
  } catch (error) {
    await handle?.close().catch(() => {})
    await stream?.close().catch(() => {})
    throw error
  }
}

async function closePinnedDirectory(
  pinned: PinnedTrustedDirectory,
): Promise<void> {
  await pinned.handle?.close().catch(() => {})
  await pinned.stream?.close().catch(() => {})
}

function validateSnapshotFilename(filename: string): void {
  if (basename(filename) !== filename || filename === '.' || filename === '..') {
    throw new Error('invalid agent memory snapshot filename')
  }
}

function getMemoryTrustAnchor(
  scope: AgentMemoryScope,
  cwd: string,
): string {
  const remoteMemoryDirectory = process.env.AGENC_REMOTE_MEMORY_DIR
  if (scope === 'user') {
    return remoteMemoryDirectory ?? getAgenCConfigHomeDir()
  }
  if (scope === 'local' && remoteMemoryDirectory) {
    return remoteMemoryDirectory
  }
  return cwd
}

async function readRegularFileWithinDirectory(
  path: string,
  trustedDirectory: string,
): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const lexical = await lstat(path)
    if (!lexical.isFile() || lexical.isSymbolicLink()) return null
    const canonicalDirectory = await realpath(trustedDirectory)
    const canonicalFile = await realpath(path)
    if (!isSameOrChildPath(canonicalDirectory, canonicalFile)) return null
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    )
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== lexical.dev ||
      opened.ino !== lexical.ino
    ) {
      return null
    }
    const content = await handle.readFile({ encoding: 'utf-8' })
    const [afterRead, canonicalAfterRead] = await Promise.all([
      handle.stat(),
      realpath(path),
    ])
    if (
      afterRead.dev !== opened.dev ||
      afterRead.ino !== opened.ino ||
      canonicalAfterRead !== canonicalFile ||
      !isSameOrChildPath(canonicalDirectory, canonicalAfterRead)
    ) {
      return null
    }
    return content
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function writeRegularFileWithinDirectory(
  trustedDirectory: string,
  trustAnchor: string,
  filename: string,
  content: string,
): Promise<void> {
  validateSnapshotFilename(filename)
  const pinned = await pinTrustedDirectory(trustedDirectory, trustAnchor)
  const path = join(pinned.operationPath, filename)
  let existingIdentity: {
    readonly dev: number | bigint
    readonly ino: number | bigint
  } | undefined
  try {
    try {
      const existing = await lstat(path)
      if (
        !existing.isFile() ||
        existing.isSymbolicLink() ||
        existing.nlink !== 1
      ) {
        throw new Error('snapshot destination is not a private regular file')
      }
      existingIdentity = { dev: existing.dev, ino: existing.ino }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    await snapshotFileOperationForTesting?.({
      operation: 'write',
      trustedDirectory,
      filename,
    })
    await assertPinnedDirectoryCurrent(pinned)

    if (existingIdentity === undefined) {
      try {
        await lstat(path)
        throw new Error('snapshot destination appeared during operation')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    } else {
      const current = await lstat(path)
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.nlink !== 1 ||
        !isSameIdentity(current, existingIdentity)
      ) {
        throw new Error('snapshot destination changed during operation')
      }
    }

    const handle = await open(
      path,
      constants.O_WRONLY |
        (existingIdentity === undefined
          ? constants.O_CREAT | constants.O_EXCL
          : 0) |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      const opened = await handle.stat()
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        (existingIdentity !== undefined &&
          !isSameIdentity(opened, existingIdentity))
      ) {
        throw new Error('snapshot destination is unsafe')
      }
      await assertPinnedDirectoryCurrent(pinned)
      const canonicalFile = await realpath(path)
      if (!isSameOrChildPath(pinned.canonicalPath, canonicalFile)) {
        throw new Error('snapshot destination escapes its memory directory')
      }
      await handle.truncate(0)
      await handle.writeFile(content, { encoding: 'utf-8' })
      const afterWrite = await handle.stat()
      if (!isSameIdentity(afterWrite, opened)) {
        throw new Error('snapshot destination changed while writing')
      }
      await assertPinnedDirectoryCurrent(pinned)
    } finally {
      await handle.close()
    }
  } finally {
    await closePinnedDirectory(pinned)
  }
}

async function deleteRegularFileWithinDirectory(
  trustedDirectory: string,
  trustAnchor: string,
  filename: string,
): Promise<void> {
  validateSnapshotFilename(filename)
  const pinned = await pinTrustedDirectory(trustedDirectory, trustAnchor)
  const path = join(pinned.operationPath, filename)
  try {
    const existing = await lstat(path)
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1
    ) {
      throw new Error('snapshot deletion target is not a private regular file')
    }

    await snapshotFileOperationForTesting?.({
      operation: 'delete',
      trustedDirectory,
      filename,
    })
    await assertPinnedDirectoryCurrent(pinned)

    const current = await lstat(path)
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      !isSameIdentity(current, existing)
    ) {
      throw new Error('snapshot deletion target changed during operation')
    }
    const canonicalFile = await realpath(path)
    if (!isSameOrChildPath(pinned.canonicalPath, canonicalFile)) {
      throw new Error('snapshot deletion target escapes its memory directory')
    }
    await unlink(path)
    await assertPinnedDirectoryCurrent(pinned)
  } finally {
    await closePinnedDirectory(pinned)
  }
}

async function copySnapshotToLocal(
  agentType: string,
  scope: AgentMemoryScope,
  cwd: string,
): Promise<void> {
  const snapshotMemDir = ensureSnapshotDirForAgent(agentType, cwd)
  const localMemDir = ensureAgentMemoryDir(agentType, scope, cwd)

  await mkdir(localMemDir, { recursive: true })
  ensureAgentMemoryDir(agentType, scope, cwd)

  try {
    const files = await readdir(snapshotMemDir, { withFileTypes: true })
    for (const dirent of files) {
      if (!dirent.isFile() || dirent.name === SNAPSHOT_JSON) continue
      const content = await readRegularFileWithinDirectory(
        join(snapshotMemDir, dirent.name),
        snapshotMemDir,
      )
      if (content === null) continue
      await writeRegularFileWithinDirectory(
        localMemDir,
        getMemoryTrustAnchor(scope, cwd),
        dirent.name,
        content,
      )
    }
  } catch (e) {
    logForDebugging(`Failed to copy snapshot to local agent memory: ${e}`)
  }
}

async function saveSyncedMeta(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
  cwd: string,
): Promise<void> {
  const localMemDir = ensureAgentMemoryDir(agentType, scope, cwd)
  await mkdir(localMemDir, { recursive: true })
  ensureAgentMemoryDir(agentType, scope, cwd)
  const meta: SyncedMeta = { syncedFrom: snapshotTimestamp }
  try {
    await writeRegularFileWithinDirectory(
      localMemDir,
      getMemoryTrustAnchor(scope, cwd),
      SYNCED_JSON,
      jsonStringify(meta),
    )
  } catch (e) {
    logForDebugging(`Failed to save snapshot sync metadata: ${e}`)
  }
}

/**
 * Check if a snapshot exists and whether it's newer than what we last synced.
 */
export async function checkAgentMemorySnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  cwd: string = getCwd(),
): Promise<{
  action: 'none' | 'initialize' | 'prompt-update'
  snapshotTimestamp?: string
}> {
  const snapshotDir = ensureSnapshotDirForAgent(agentType, cwd)
  const snapshotMeta = await readJsonFile(
    join(snapshotDir, SNAPSHOT_JSON),
    snapshotDir,
    snapshotMetaSchema(),
  )

  if (!snapshotMeta) {
    return { action: 'none' }
  }

  const localMemDir = ensureAgentMemoryDir(agentType, scope, cwd)

  let hasLocalMemory = false
  try {
    const dirents = await readdir(localMemDir, { withFileTypes: true })
    hasLocalMemory = dirents.some(d => d.isFile() && d.name.endsWith('.md'))
  } catch {
    // Directory doesn't exist
  }

  if (!hasLocalMemory) {
    return { action: 'initialize', snapshotTimestamp: snapshotMeta.updatedAt }
  }

  const syncedMeta = await readJsonFile(
    getSyncedJsonPath(agentType, scope, cwd),
    localMemDir,
    syncedMetaSchema(),
  )

  if (
    !syncedMeta ||
    new Date(snapshotMeta.updatedAt) > new Date(syncedMeta.syncedFrom)
  ) {
    return {
      action: 'prompt-update',
      snapshotTimestamp: snapshotMeta.updatedAt,
    }
  }

  return { action: 'none' }
}

/**
 * Initialize local agent memory from a snapshot (first-time setup).
 */
export async function initializeFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
  cwd: string = getCwd(),
): Promise<void> {
  logForDebugging(
    `Initializing agent memory for ${agentType} from project snapshot`,
  )
  await copySnapshotToLocal(agentType, scope, cwd)
  await saveSyncedMeta(agentType, scope, snapshotTimestamp, cwd)
}

/**
 * Replace local agent memory with the snapshot.
 */
export async function replaceFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
  cwd: string = getCwd(),
): Promise<void> {
  logForDebugging(
    `Replacing agent memory for ${agentType} with project snapshot`,
  )
  // Remove existing .md files before copying to avoid orphans
  const localMemDir = ensureAgentMemoryDir(agentType, scope, cwd)
  try {
    const existing = await readdir(localMemDir, { withFileTypes: true })
    for (const dirent of existing) {
      if (dirent.isFile() && dirent.name.endsWith('.md')) {
        await deleteRegularFileWithinDirectory(
          localMemDir,
          getMemoryTrustAnchor(scope, cwd),
          dirent.name,
        )
      }
    }
  } catch {
    // Directory may not exist yet
  }
  await copySnapshotToLocal(agentType, scope, cwd)
  await saveSyncedMeta(agentType, scope, snapshotTimestamp, cwd)
}

/**
 * Mark the current snapshot as synced without changing local memory.
 */
export async function markSnapshotSynced(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
  cwd: string = getCwd(),
): Promise<void> {
  await saveSyncedMeta(agentType, scope, snapshotTimestamp, cwd)
}
