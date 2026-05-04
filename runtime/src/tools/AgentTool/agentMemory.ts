import { existsSync, readFileSync } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname, join, normalize, sep } from 'path'
import { getAgenCConfigHomeDir } from '../../utils/envUtils.js'

// Persistent agent memory scope: 'user' (~/.agenc/agent-memory/), 'project' (.agenc/agent-memory/), or 'local' (.agenc/agent-memory-local/)
export type AgentMemoryScope = 'user' | 'project' | 'local'
const MEMORY_ENTRYPOINT = 'MEMORY.md'

/**
 * Sanitize an agent type name for use as a directory name.
 * Replaces colons (invalid on Windows, used in plugin-namespaced agent
 * types like "my-plugin:my-agent") with dashes.
 */
function sanitizeAgentTypeForPath(agentType: string): string {
  return agentType.replace(/:/g, '-')
}

function getCwd(): string {
  return process.cwd()
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

/**
 * Returns the local agent memory directory, which is project-specific and not checked into VCS.
 * When AGENC_REMOTE_MEMORY_DIR is set, persists to the mount with project namespacing.
 * Otherwise, uses <cwd>/.agenc/agent-memory-local/<agentType>/.
 */
function getLocalAgentMemoryDir(dirName: string): string {
  if (process.env.AGENC_REMOTE_MEMORY_DIR) {
    return (
      join(
        process.env.AGENC_REMOTE_MEMORY_DIR,
        'projects',
        sanitizeProjectPath(findCanonicalGitRoot(getCwd()) ?? getCwd()),
        'agent-memory-local',
        dirName,
      ) + sep
    )
  }
  return join(getCwd(), '.agenc', 'agent-memory-local', dirName) + sep
}

function getMemoryBaseDir(): string {
  return process.env.AGENC_REMOTE_MEMORY_DIR ?? getAgenCConfigHomeDir()
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
): string {
  const dirName = sanitizeAgentTypeForPath(agentType)
  switch (scope) {
    case 'project':
      return join(getCwd(), '.agenc', 'agent-memory', dirName) + sep
    case 'local':
      return getLocalAgentMemoryDir(dirName)
    case 'user':
      return join(getMemoryBaseDir(), 'agent-memory', dirName) + sep
  }
}

// Check if file is within an agent memory directory (any scope).
export function isAgentMemoryPath(absolutePath: string): boolean {
  // SECURITY: Normalize to prevent path traversal bypasses via .. segments
  const normalizedPath = normalize(absolutePath)
  const memoryBase = getMemoryBaseDir()

  // User scope: check memory base (may be custom dir or config home)
  if (normalizedPath.startsWith(join(memoryBase, 'agent-memory') + sep)) {
    return true
  }

  // Project scope: always cwd-based (not redirected)
  if (
    normalizedPath.startsWith(join(getCwd(), '.agenc', 'agent-memory') + sep)
  ) {
    return true
  }

  // Local scope: persisted to mount when AGENC_REMOTE_MEMORY_DIR is set, otherwise cwd-based
  if (process.env.AGENC_REMOTE_MEMORY_DIR) {
    if (
      normalizedPath.includes(sep + 'agent-memory-local' + sep) &&
      normalizedPath.startsWith(
        join(process.env.AGENC_REMOTE_MEMORY_DIR, 'projects') + sep,
      )
    ) {
      return true
    }
  } else if (
    normalizedPath.startsWith(
      join(getCwd(), '.agenc', 'agent-memory-local') + sep,
    )
  ) {
    return true
  }

  return false
}

/**
 * Returns the agent memory file path for a given agent type and scope.
 */
export function getAgentMemoryEntrypoint(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  return join(getAgentMemoryDir(agentType, scope), 'MEMORY.md')
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

  const memoryDir = getAgentMemoryDir(agentType, scope)

  void mkdir(memoryDir, { recursive: true }).catch(() => {})

  const coworkExtraGuidelines =
    process.env.AGENC_COWORK_MEMORY_EXTRA_GUIDELINES
  const extraGuidelines =
    coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
      ? [scopeNote, coworkExtraGuidelines]
      : [scopeNote]
  const entrypoint = join(memoryDir, MEMORY_ENTRYPOINT)
  let entrypointContent = ''
  try {
    entrypointContent = readFileSync(entrypoint, 'utf8').trim()
  } catch {
    entrypointContent = ''
  }

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
