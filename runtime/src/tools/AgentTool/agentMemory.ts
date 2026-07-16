import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
} from 'fs'
import { mkdir } from 'fs/promises'
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  sep,
} from 'path'
import { peekAmbientRuntimeSession } from '../../session/current-session.js'
import { getAgenCConfigHomeDir } from '../../utils/envUtils.js'

// Persistent agent memory scope: 'user' (~/.agenc/agent-memory/), 'project' (.agenc/agent-memory/), or 'local' (.agenc/agent-memory-local/)
export type AgentMemoryScope = 'user' | 'project' | 'local'
const MEMORY_ENTRYPOINT = 'MEMORY.md'

/**
 * Sanitize an agent type name for use as a directory name.
 * Replaces colons (invalid on Windows, used in plugin-namespaced agent
 * types like "my-plugin:my-agent") with dashes.
 */
export function agentMemoryPathComponent(agentType: string): string {
  const readable = agentType
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^\.+/, '')
    .replace(/[. -]+$/, '')
    .slice(0, 64) || 'agent'
  const digest = createHash('sha256')
    .update(agentType)
    .digest('hex')
    .slice(0, 16)
  return `${readable}-${digest}`
}

function getRoleWorkspaceCwd(): string {
  return peekAmbientRuntimeSession()?.roleWorkspace.cwd ?? process.cwd()
}

function findCanonicalGitRoot(start: string): string | undefined {
  let current = normalize(start)
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function sanitizeProjectPath(path: string): string {
  return path.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function projectMemoryNamespace(cwd: string): string {
  const canonicalProject = normalize(findCanonicalGitRoot(cwd) ?? cwd)
  const readable = sanitizeProjectPath(canonicalProject).slice(-80) || 'project'
  const digest = createHash('sha256')
    .update(canonicalProject)
    .digest('hex')
    .slice(0, 16)
  return `${readable}-${digest}`
}

/**
 * Returns the local agent memory directory, which is project-specific and not checked into VCS.
 * When AGENC_REMOTE_MEMORY_DIR is set, persists to the mount with project namespacing.
 * Otherwise, uses <cwd>/.agenc/agent-memory-local/<agentType>/.
 */
function getLocalAgentMemoryDir(
  dirName: string,
  cwd: string = getRoleWorkspaceCwd(),
): string {
  if (process.env.AGENC_REMOTE_MEMORY_DIR) {
    return (
      join(
        process.env.AGENC_REMOTE_MEMORY_DIR,
        'projects',
        projectMemoryNamespace(cwd),
        'agent-memory-local',
        dirName,
      ) + sep
    )
  }
  return join(cwd, '.agenc', 'agent-memory-local', dirName) + sep
}

function getMemoryBaseDir(): string {
  return process.env.AGENC_REMOTE_MEMORY_DIR ?? getAgenCConfigHomeDir()
}

function getAgentMemoryScopeRoot(
  scope: AgentMemoryScope,
  cwd: string,
): string {
  if (scope === 'user') return join(getMemoryBaseDir(), 'agent-memory')
  if (scope === 'project') return join(cwd, '.agenc', 'agent-memory')
  if (process.env.AGENC_REMOTE_MEMORY_DIR) {
    return join(
      process.env.AGENC_REMOTE_MEMORY_DIR,
      'projects',
      projectMemoryNamespace(cwd),
      'agent-memory-local',
    )
  }
  return join(cwd, '.agenc', 'agent-memory-local')
}

function getAgentMemoryTrustAnchor(
  scope: AgentMemoryScope,
  cwd: string,
): string {
  if (scope === 'user') return getMemoryBaseDir()
  if (scope === 'local' && process.env.AGENC_REMOTE_MEMORY_DIR) {
    return process.env.AGENC_REMOTE_MEMORY_DIR
  }
  return cwd
}

function legacyAgentMemoryPathComponent(agentType: string): string | null {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(agentType) &&
    agentType !== '.' &&
    agentType !== '..'
    ? agentType
    : null
}

/**
 * Move an unambiguous pre-hash safe-name directory into the hashed namespace.
 * Names that were lossy (`:` replacement), traversal-capable, case-mismatched,
 * symlinked, or outside the trusted tier are deliberately never adopted.
 */
export function migrateLegacyAgentScopedDirectory(
  parentDir: string,
  trustAnchor: string,
  agentType: string,
): string {
  const targetDir = join(parentDir, agentMemoryPathComponent(agentType))
  const legacyComponent = legacyAgentMemoryPathComponent(agentType)
  if (legacyComponent === null || existsSync(targetDir)) return targetDir
  try {
    const canonicalAnchor = realpathSync(trustAnchor)
    const canonicalParent = realpathSync(parentDir)
    if (!isSameOrChildPath(canonicalAnchor, canonicalParent)) return targetDir
    // Exact-case directory enumeration avoids adopting Foo for a requested
    // `foo` on case-insensitive filesystems.
    if (!readdirSync(parentDir).includes(legacyComponent)) return targetDir
    const legacyDir = join(parentDir, legacyComponent)
    const lexicalLegacy = lstatSync(legacyDir)
    if (!lexicalLegacy.isDirectory() || lexicalLegacy.isSymbolicLink()) {
      return targetDir
    }
    const canonicalLegacy = realpathSync(legacyDir)
    if (!isSameOrChildPath(canonicalParent, canonicalLegacy)) return targetDir
    renameSync(legacyDir, targetDir)
  } catch {
    // Another process may win the one-time migration. The hashed target is
    // the only path callers will subsequently trust.
  }
  return targetDir
}

export function ensureAgentMemoryDir(
  agentType: string,
  scope: AgentMemoryScope,
  cwd: string = getRoleWorkspaceCwd(),
): string {
  const directory = migrateLegacyAgentScopedDirectory(
    getAgentMemoryScopeRoot(scope, cwd),
    getAgentMemoryTrustAnchor(scope, cwd),
    agentType,
  )
  assertTrustedAgentScopedDirectory(
    directory,
    getAgentMemoryTrustAnchor(scope, cwd),
  )
  return directory + sep
}

function isSameOrChildPath(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child === '' || (
    child !== '..' &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  )
}

export function assertTrustedAgentScopedDirectory(
  directory: string,
  trustAnchor: string,
): void {
  const canonicalAnchor = realpathSync(trustAnchor)
  let existing = directory
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) {
      throw new Error('agent memory path has no trusted existing ancestor')
    }
    existing = parent
  }
  const lexicalExisting = lstatSync(existing)
  if (existing !== trustAnchor && lexicalExisting.isSymbolicLink()) {
    throw new Error('agent memory path contains a symlinked directory')
  }
  const canonicalExisting = realpathSync(existing)
  if (!isSameOrChildPath(canonicalAnchor, canonicalExisting)) {
    throw new Error('agent memory path escapes its role workspace')
  }
  if (existsSync(directory)) {
    const lexicalDirectory = lstatSync(directory)
    if (!lexicalDirectory.isDirectory() || lexicalDirectory.isSymbolicLink()) {
      throw new Error('agent memory directory is not a trusted directory')
    }
    if (!isSameOrChildPath(canonicalAnchor, realpathSync(directory))) {
      throw new Error('agent memory directory escapes its role workspace')
    }
  }
}

function readRegularMemoryEntrypoint(
  entrypoint: string,
  memoryDir: string,
  scope: AgentMemoryScope,
  cwd: string,
): string {
  let fd: number | undefined
  try {
    const lexical = lstatSync(entrypoint)
    if (!lexical.isFile() || lexical.isSymbolicLink()) return ''
    if (lstatSync(memoryDir).isSymbolicLink()) return ''
    const canonicalAnchor = realpathSync(
      getAgentMemoryTrustAnchor(scope, cwd),
    )
    const canonicalScopeRoot = realpathSync(
      getAgentMemoryScopeRoot(scope, cwd),
    )
    const canonicalDir = realpathSync(memoryDir)
    const canonicalEntrypoint = realpathSync(entrypoint)
    if (
      !isSameOrChildPath(canonicalAnchor, canonicalScopeRoot) ||
      !isSameOrChildPath(canonicalScopeRoot, canonicalDir) ||
      !isSameOrChildPath(canonicalDir, canonicalEntrypoint) ||
      canonicalDir === canonicalEntrypoint
    ) {
      return ''
    }
    fd = openSync(
      entrypoint,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    )
    const opened = fstatSync(fd)
    if (
      !opened.isFile() ||
      opened.dev !== lexical.dev ||
      opened.ino !== lexical.ino
    ) {
      return ''
    }
    const content = readFileSync(fd, 'utf8')
    const afterRead = fstatSync(fd)
    if (afterRead.dev !== opened.dev || afterRead.ino !== opened.ino) return ''
    return content.trim()
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Returns the agent memory directory for a given agent type and scope.
 * - 'user' scope: <memoryBase>/agent-memory/<agentType>/
 * - 'project' scope: <cwd>/.agenc/agent-memory/<agentType>/
 * - 'local' scope: see getLocalAgentMemoryDir()
 */
export function getAgentMemoryDir(
  agentType: string,
  scope: AgentMemoryScope,
  cwd: string = getRoleWorkspaceCwd(),
): string {
  const dirName = agentMemoryPathComponent(agentType)
  switch (scope) {
    case 'project':
      return join(cwd, '.agenc', 'agent-memory', dirName) + sep
    case 'local':
      return getLocalAgentMemoryDir(dirName, cwd)
    case 'user':
      return join(getMemoryBaseDir(), 'agent-memory', dirName) + sep
  }
}

function normalizePathBoundary(path: string): string {
  const normalized = normalize(path)
  const root = parse(normalized).root
  let boundary = normalized
  while (boundary.length > root.length && boundary.endsWith(sep)) {
    boundary = boundary.slice(0, -1)
  }
  return boundary
}

function isWithinPathBoundary(candidate: string, base: string): boolean {
  const normalizedCandidate = normalizePathBoundary(candidate)
  const normalizedBase = normalizePathBoundary(base)
  return normalizedCandidate === normalizedBase ||
    normalizedCandidate.startsWith(normalizedBase + sep)
}

/**
 * Classifies paths under any agent-memory root for privacy/redaction. This is
 * intentionally independent of the current agent identity; it must not be
 * used to grant filesystem permissions.
 */
export function isAnyAgentMemoryPath(
  absolutePath: string,
  roleWorkspaceCwd: string = getRoleWorkspaceCwd(),
): boolean {
  if (
    isWithinPathBoundary(
      absolutePath,
      join(getMemoryBaseDir(), 'agent-memory'),
    ) ||
    isWithinPathBoundary(
      absolutePath,
      join(roleWorkspaceCwd, '.agenc', 'agent-memory'),
    )
  ) {
    return true
  }

  // Project/local memory is a reserved namespace in every workspace, not only
  // the current role workspace. This broader classification is used for
  // privacy and fail-closed permission decisions; exact authorization below
  // still requires the current workspace and agent identity to match.
  const pathSegments = normalizePathBoundary(absolutePath)
    .split(sep)
    .filter(Boolean)
    .map(segment => segment.toLowerCase())
  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    if (
      pathSegments[index] === '.agenc' &&
      (pathSegments[index + 1] === 'agent-memory' ||
        pathSegments[index + 1] === 'agent-memory-local')
    ) {
      return true
    }
  }

  const remoteMemoryDir = process.env.AGENC_REMOTE_MEMORY_DIR
  if (!remoteMemoryDir) {
    return isWithinPathBoundary(
      absolutePath,
      join(roleWorkspaceCwd, '.agenc', 'agent-memory-local'),
    )
  }

  const projectsRoot = join(remoteMemoryDir, 'projects')
  if (!isWithinPathBoundary(absolutePath, projectsRoot)) return false
  const relativePath = relative(
    normalizePathBoundary(projectsRoot),
    normalizePathBoundary(absolutePath),
  )
  const segments = relativePath.split(sep).filter(Boolean)
  return segments.length >= 2 && segments[1] === 'agent-memory-local'
}

/** Check whether a path is in this agent's one authorized memory directory. */
export function isAuthorizedAgentMemoryPath(
  absolutePath: string,
  roleWorkspaceCwd: string | null | undefined = undefined,
  authorization?: {
    readonly agentType: string
    readonly scope: AgentMemoryScope
  },
): boolean {
  if (authorization === undefined) return false
  const scopedCwd = roleWorkspaceCwd === undefined
    ? getRoleWorkspaceCwd()
    : roleWorkspaceCwd
  if (scopedCwd === null && authorization.scope !== 'user') return false
  const memoryDir = normalizePathBoundary(getAgentMemoryDir(
    authorization.agentType,
    authorization.scope,
    scopedCwd ?? process.cwd(),
  ))
  if (!isWithinPathBoundary(absolutePath, memoryDir)) return false

  // The permission carve-out is authority-bearing: an in-boundary hardlink
  // would otherwise grant silent access to the same inode through an external
  // pathname. Missing targets remain eligible so an authorized agent can
  // create new memory files; observable non-regular, symlink, and multiply
  // linked targets fail closed. The permission layer also checks every
  // lexical/resolved path form, closing intermediate-directory symlink cases.
  try {
    const target = lstatSync(absolutePath)
    return target.isFile() && !target.isSymbolicLink() && target.nlink === 1
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/**
 * Returns the agent memory file path for a given agent type and scope.
 */
export function getAgentMemoryEntrypoint(
  agentType: string,
  scope: AgentMemoryScope,
  cwd: string = getRoleWorkspaceCwd(),
): string {
  return join(getAgentMemoryDir(agentType, scope, cwd), 'MEMORY.md')
}

export function getMemoryScopeDisplay(
  memory: AgentMemoryScope | undefined,
): string {
  switch (memory) {
    case 'user':
      return `User (${join(getMemoryBaseDir(), 'agent-memory')}/)`
    case 'project':
      return 'Project (.agenc/agent-memory/)'
    case 'local':
      return `Local (${getLocalAgentMemoryDir('...')})`
    default:
      return 'None'
  }
}

/**
 * Load persistent memory for an agent with memory enabled.
 * Creates the memory directory if needed and returns a prompt with memory contents.
 *
 * @param agentType The agent's type name (used as directory name)
 * @param scope 'user' for ~/.agenc/agent-memory/ or 'project' for .agenc/agent-memory/
 */
export function loadAgentMemoryPrompt(
  agentType: string,
  scope: AgentMemoryScope,
  cwd: string = getRoleWorkspaceCwd(),
): string {
  let scopeNote: string
  switch (scope) {
    case 'user':
      scopeNote =
        '- Since this memory is user-scope, keep learnings general since they apply across all projects'
      break
    case 'project':
      scopeNote =
        '- Since this memory is project-scope and shared with your team via version control, tailor your memories to this project'
      break
    case 'local':
      scopeNote =
        '- Since this memory is local-scope (not checked into version control), tailor your memories to this project and machine'
      break
  }

  let memoryDir: string
  try {
    memoryDir = ensureAgentMemoryDir(agentType, scope, cwd)
  } catch {
    return [
      '# Persistent Agent Memory',
      '',
      'Memory unavailable: the configured directory failed workspace safety checks.',
    ].join('\n')
  }

  void mkdir(memoryDir, { recursive: true }).catch(() => {})

  const coworkExtraGuidelines =
    process.env.AGENC_COWORK_MEMORY_EXTRA_GUIDELINES
  const extraGuidelines =
    coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
      ? [scopeNote, coworkExtraGuidelines]
      : [scopeNote]
  const entrypoint = join(memoryDir, MEMORY_ENTRYPOINT)
  const entrypointContent = readRegularMemoryEntrypoint(
    entrypoint,
    memoryDir,
    scope,
    cwd,
  )

  return [
    '# Persistent Agent Memory',
    '',
    `Memory directory: ${memoryDir}`,
    '',
    ...extraGuidelines,
    '',
    `## ${MEMORY_ENTRYPOINT}`,
    '',
    entrypointContent ||
      `Your ${MEMORY_ENTRYPOINT} is currently empty. When you save new memories, they will appear here.`,
  ].join('\n')
}
