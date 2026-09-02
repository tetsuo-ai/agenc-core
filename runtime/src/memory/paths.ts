/**
 * Ports the upstream `src/memdir/paths.ts` resolver onto AgenC's D-13 memory
 * architecture.
 *
 * The public `getAutoMem*` names remain as compatibility aliases for existing
 * callers, but the owned shape is now explicit: global memory is under the
 * AgenC memory base, project memory lives under that same base keyed by the
 * project's canonical git root (`<base>/projects/<sanitized-root>/memory/`),
 * and session memory is kept in conversation state rather than a filesystem
 * path. The memory prompt, relevant-memory recall, permissions and the
 * extraction child all derive the project directory through
 * `buildProjectMemoryDirectory` so a memory written by one of them is found
 * by the others.
 */
import { homedir } from 'os'
import { isAbsolute, join, normalize, sep } from 'path'
import {
  getIsNonInteractiveSession,
  getProjectRoot,
} from '../bootstrap/state.js'
import {
  getAgenCHomeDir,
  isBareMode,
} from '../utils/envUtils.js'
import {
  getSessionCoworkMemoryPathOverride,
  getSessionRemoteMemoryRoot,
  isSessionRemoteMode,
} from '../session/runtime-options.js'
import { findCanonicalGitRoot } from '../utils/git.js'
import { sanitizePath } from '../utils/path.js'
import {
  CanonicalAuthorityCache,
  getCanonicalSettingsAuthority,
} from '../utils/settings/canonicalAuthority.js'
import {
  getExecutionAuthoritySettings,
  getSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * Whether auto-memory features are enabled (memdir, agent memory, past session search).
 * Enabled by default. Priority chain:
 *   1. Typed simple mode selected by --bare → OFF
 *   2. CCR without persistent storage → OFF (no AGENC_REMOTE_MEMORY_DIR)
 *   3. autoMemoryEnabled from the canonical config snapshot
 *   4. Default: enabled
 */
export function isAutoMemoryEnabled(): boolean {
  // --bare: prompts.ts already drops the memory section from the system
  // prompt via its reduced-mode early return; this gate stops the other half
  // (extractMemories turn-end fork, autoDream, /remember, /dream, team sync).
  if (isBareMode()) {
    return false
  }
  if (
    isSessionRemoteMode() &&
    getSessionRemoteMemoryRoot() === undefined
  ) {
    return false
  }
  const settings = getExecutionAuthoritySettings()
  if (settings.autoMemoryEnabled !== undefined) {
    return settings.autoMemoryEnabled
  }
  return true
}

/**
 * Whether the extract-memories background agent will run this session.
 *
 * The main agent's prompt always has full save instructions regardless of
 * this gate — when the main agent writes memories, the background agent
 * skips that range (hasMemoryWritesSince in extractMemories.ts); when it
 * doesn't, the background agent catches anything missed.
 *
 * Callers must also gate on feature('EXTRACT_MEMORIES') — that check cannot
 * live inside this helper because feature() only tree-shakes when used
 * directly in an `if` condition.
 */
export function isExtractModeActive(): boolean {
  return !getIsNonInteractiveSession() || false
}

/**
 * Returns the base directory for persistent memory storage.
 * Resolution order:
 *   1. AGENC_REMOTE_MEMORY_DIR env var (explicit override, set in CCR)
 *   2. ~/.agenc (default config home)
 */
export function getMemoryBaseDir(): string {
  return getSessionRemoteMemoryRoot() ?? getAgenCHomeDir()
}

export const MEMORY_DIRNAME = 'memory'
export const MEMORY_ENTRYPOINT_NAME = 'MEMORY.md'
export const PROJECT_MEMORY_DIR = '.agenc'
export const PROJECT_INSTRUCTION_FILE = 'AGENC.md'

/**
 * Normalize and validate a candidate auto-memory directory path.
 *
 * SECURITY: Rejects paths that would be dangerous as a read-allowlist root
 * or that normalize() doesn't fully resolve:
 * - relative (!isAbsolute): "../foo" — would be interpreted relative to CWD
 * - root/near-root (length < 3): "/" → "" after strip; "/a" too short
 * - Windows drive-root (C: regex): "C:\" → "C:" after strip
 * - UNC paths (\\server\share): network paths — opaque trust boundary
 * - null byte: survives normalize(), can truncate in syscalls
 *
 * Returns the normalized path with exactly one trailing separator,
 * or undefined if the path is unset/empty/rejected.
 */
function validateMemoryPath(
  raw: string | undefined,
  expandTilde: boolean,
): string | undefined {
  if (!raw) {
    return undefined
  }
  let candidate = raw
  // Canonical config paths support ~/ expansion (user-friendly). The env var
  // override does not (it's set programmatically by Cowork/SDK, which should
  // always pass absolute paths). Bare "~", "~/", "~/.", "~/..", etc. are NOT
  // expanded — they would make isAutoMemPath() match all of $HOME or its
  // parent (same class of danger as "/" or "C:\").
  if (
    expandTilde &&
    (candidate.startsWith('~/') || candidate.startsWith('~\\'))
  ) {
    const rest = candidate.slice(2)
    // Reject trivial remainders that would expand to $HOME or an ancestor.
    // normalize('') = '.', normalize('.') = '.', normalize('foo/..') = '.',
    // normalize('..') = '..', normalize('foo/../..') = '..'
    const restNorm = normalize(rest || '.')
    if (restNorm === '.' || restNorm === '..') {
      return undefined
    }
    candidate = join(homedir(), rest)
  }
  // normalize() may preserve a trailing separator; strip before adding
  // exactly one to match the trailing-sep contract of getAutoMemPath()
  const normalized = normalize(candidate).replace(/[/\\]+$/, '')
  if (
    !isAbsolute(normalized) ||
    normalized.length < 3 ||
    /^[A-Za-z]:$/.test(normalized) ||
    normalized.startsWith('\\\\') ||
    normalized.startsWith('//') ||
    normalized.includes('\0')
  ) {
    return undefined
  }
  return (normalized + sep).normalize('NFC')
}

/**
 * Direct override for the full auto-memory directory path via env var.
 * When set, getAutoMemPath()/getAutoMemEntrypoint() return this path directly
 * instead of computing `{base}/projects/{sanitized-cwd}/memory/`.
 *
 * Used by Cowork to redirect memory to a space-scoped mount where the
 * per-session cwd (which contains the VM process name) would otherwise
 * produce a different project-key for every session.
 */
function getAutoMemPathOverride(): string | undefined {
  return validateMemoryPath(
    getSessionCoworkMemoryPathOverride(),
    false,
  )
}

/**
 * Canonical config override for the full auto-memory directory path.
 * Supports ~/ expansion for user convenience.
 *
 * SECURITY: project/local repository settings are intentionally excluded — a malicious repo could otherwise set
 * autoMemoryDirectory: "~/.ssh" and gain silent write access to sensitive
 * directories via the filesystem.ts write carve-out (which fires when
 * isAutoMemPath() matches and hasAutoMemPathOverride() is false). This follows
 * the same trusted-authority pattern as other security-sensitive preferences.
 */
function getAutoMemPathSetting(): string | undefined {
  const dir =
    getSettingsForSource('policySettings')?.autoMemoryDirectory ??
    getSettingsForSource('flagSettings')?.autoMemoryDirectory ??
    getSettingsForSource('userSettings')?.autoMemoryDirectory
  return validateMemoryPath(dir, true)
}

/**
 * Check if AGENC_COWORK_MEMORY_PATH_OVERRIDE is set to a valid override.
 * Use this as a signal that the SDK caller has explicitly opted into
 * the auto-memory mechanics — e.g. to decide whether to inject the
 * memory prompt when a custom system prompt replaces the default.
 */
export function hasAutoMemPathOverride(): boolean {
  return getAutoMemPathOverride() !== undefined
}

/**
 * Returns the canonical git repo root if available, otherwise falls back to
 * the stable project root. Uses findCanonicalGitRoot so all worktrees of the
 * same repo share one auto-memory directory.
 */
function getAutoMemBase(): string {
  return findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot()
}

/**
 * The project root every memory key is built from: the canonical git root
 * when there is one, otherwise the stable project root. Exported so a caller
 * that already knows which memory base it wants can build the same project
 * directory as `getProjectMemoryPath` without re-deriving the root.
 */
export function getMemoryProjectRoot(): string {
  return getAutoMemBase()
}

/**
 * Build the project memory directory for one memory base and one project
 * root: `<baseDir>/projects/<sanitized-project-root>/memory/`. Shared by the
 * prompt/permission resolver below and by the extraction child's
 * `resolveAutoMemoryDirectory`, so every entry point that knows a base
 * directory and a project root lands on the same directory.
 */
export function buildProjectMemoryDirectory(
  baseDir: string,
  projectRoot: string,
): string {
  return (
    join(baseDir, 'projects', sanitizePath(projectRoot), MEMORY_DIRNAME) + sep
  ).normalize('NFC')
}

/**
 * Returns the auto-memory directory path.
 *
 * Resolution order:
 *   1. AGENC_COWORK_MEMORY_PATH_OVERRIDE env var (full-path override, used by Cowork)
 *   2. autoMemoryDirectory in trusted canonical config (policy/flag/user)
 *   3. <memoryBase>/projects/<sanitized-git-root>/memory/, where the base is
 *      AGENC_REMOTE_MEMORY_DIR in remote mode and $AGENC_HOME otherwise. This
 *      keeps memory out of the repository and matches the extraction child.
 *
 * Render-path callers invoke this once per tool-use message per Messages
 * re-render, so results are cached. The cache is partitioned by the exact
 * ConfigStore authority, while its key includes every relevant runtime option
 * and resolved setting that can change the result. Concurrent daemon sessions
 * can therefore share a home/project without sharing memory-path authority.
 */
const projectMemoryPathCache = new CanonicalAuthorityCache<string>()

function resolveProjectMemoryPath(): string {
  const override = getAutoMemPathOverride() ?? getAutoMemPathSetting()
  if (override) {
    return override
  }
  return buildProjectMemoryDirectory(getMemoryBaseDir(), getAutoMemBase())
}

function projectMemoryPathCacheKey(): string {
  return [
    getAgenCHomeDir(),
    getSessionRemoteMemoryRoot() ?? '',
    getAutoMemPathOverride() ?? '',
    getAutoMemPathSetting() ?? '',
    getProjectRoot(),
  ].join('\u0000')
}

export const getProjectMemoryPath = Object.assign(
  function getProjectMemoryPath(): string {
    const authority = getCanonicalSettingsAuthority()
    if (authority === null) return resolveProjectMemoryPath()
    const key = projectMemoryPathCacheKey()
    const cached = projectMemoryPathCache.get(key, authority)
    if (cached !== undefined) return cached
    const resolved = resolveProjectMemoryPath()
    projectMemoryPathCache.set(key, resolved, authority)
    return resolved
  },
  {
    cache: Object.freeze({
      clear: (): void => projectMemoryPathCache.clear(),
    }),
  },
)

export function getAutoMemPath(): string {
  return getProjectMemoryPath()
}

export function getGlobalMemoryPath(): string {
  return (join(getMemoryBaseDir(), MEMORY_DIRNAME) + sep).normalize('NFC')
}

export function getGlobalMemoryEntrypoint(): string {
  return join(getGlobalMemoryPath(), MEMORY_ENTRYPOINT_NAME)
}

export function getProjectMemoryEntrypoint(): string {
  return join(getProjectMemoryPath(), MEMORY_ENTRYPOINT_NAME)
}

export function getProjectInstructionPath(): string {
  return join(getProjectRoot(), PROJECT_INSTRUCTION_FILE)
}

/**
 * Returns the daily log file path for the given date (defaults to today).
 * Shape: <autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md
 *
 * Used by assistant mode (feature('KAIROS')): rather than maintaining
 * MEMORY.md as a live index, the agent appends to a date-named log file
 * as it works. A separate nightly /dream skill distills these logs into
 * topic files + MEMORY.md.
 */
export function getAutoMemDailyLogPath(date: Date = new Date()): string {
  const yyyy = date.getFullYear().toString()
  const mm = (date.getMonth() + 1).toString().padStart(2, '0')
  const dd = date.getDate().toString().padStart(2, '0')
  return join(getAutoMemPath(), 'logs', yyyy, mm, `${yyyy}-${mm}-${dd}.md`)
}

/**
 * Returns the auto-memory entrypoint (MEMORY.md inside the auto-memory dir).
 * Follows the same resolution order as getAutoMemPath().
 */
export function getAutoMemEntrypoint(): string {
  return getProjectMemoryEntrypoint()
}

/**
 * Check if an absolute path is within the auto-memory directory.
 *
 * When AGENC_COWORK_MEMORY_PATH_OVERRIDE is set, this matches against the
 * env-var override directory. Note that a true return here does NOT imply
 * write permission in that case — the filesystem.ts write carve-out is gated
 * on !hasAutoMemPathOverride() (it exists to bypass DANGEROUS_DIRECTORIES).
 *
 * The canonical autoMemoryDirectory DOES get the write carve-out: it is the
 * user's explicit choice from a trusted settings source (projectSettings is
 * excluded — see getAutoMemPathSetting), and hasAutoMemPathOverride() remains
 * false for it.
 */
export function isAutoMemPath(absolutePath: string): boolean {
  // SECURITY: Normalize to prevent path traversal bypasses via .. segments
  const normalizedPath = normalize(absolutePath)
  return normalizedPath.startsWith(getAutoMemPath())
}

export function isGlobalMemoryPath(absolutePath: string): boolean {
  const normalizedPath = normalize(absolutePath)
  return normalizedPath.startsWith(getGlobalMemoryPath())
}

export function isProjectMemoryPath(absolutePath: string): boolean {
  const normalizedPath = normalize(absolutePath)
  return normalizedPath.startsWith(getProjectMemoryPath())
}

export function isDurableMemoryPath(absolutePath: string): boolean {
  return isGlobalMemoryPath(absolutePath) || isProjectMemoryPath(absolutePath)
}

/**
 * The durable memory directories the file tools admit regardless of the
 * workspace boundary: exactly the global and project roots the memory prompt
 * advertises, so a Write to the path the prompt names is never refused as
 * "outside allowed directories". Returns [] when the roots cannot be
 * resolved so the workspace boundary stays as it was.
 */
export function getDurableMemoryRoots(): readonly string[] {
  try {
    return Array.from(new Set([getGlobalMemoryPath(), getProjectMemoryPath()]))
  } catch {
    return []
  }
}
