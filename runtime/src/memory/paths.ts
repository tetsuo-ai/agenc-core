/**
 * Ports the upstream `src/memdir/paths.ts` resolver onto AgenC's D-13 memory
 * architecture.
 *
 * The public `getAutoMem*` names remain as compatibility aliases for existing
 * callers, but the owned shape is now explicit: global memory is under the
 * AgenC memory base, project memory belongs to the current project, and
 * session memory is kept in conversation state rather than a filesystem path.
 */
import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { isAbsolute, join, normalize, sep } from 'path'
import {
  getIsNonInteractiveSession,
  getProjectRoot,
} from '../bootstrap/state.js'
import {
  getAgenCConfigHomeDir,
  isEnvDefinedFalsy,
  isEnvTruthy,
} from '../utils/envUtils.js'
import { findCanonicalGitRoot } from '../utils/git.js'
import { sanitizePath } from '../utils/path.js'
import {
  getExecutionAuthoritySettings,
  getSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * Whether auto-memory features are enabled (memdir, agent memory, past session search).
 * Enabled by default. Priority chain (first defined wins):
 *   1. AGENC_DISABLE_AUTO_MEMORY env var (1/true → OFF, 0/false → ON)
 *   2. AGENC_SIMPLE (--bare) → OFF
 *   3. CCR without persistent storage → OFF (no AGENC_REMOTE_MEMORY_DIR)
 *   4. autoMemoryEnabled in settings.json (supports project-level opt-out)
 *   5. Default: enabled
 */
export function isAutoMemoryEnabled(): boolean {
  const envVal = process.env.AGENC_DISABLE_AUTO_MEMORY
  if (isEnvTruthy(envVal)) {
    return false
  }
  if (isEnvDefinedFalsy(envVal)) {
    return true
  }
  // --bare / SIMPLE: prompts.ts already drops the memory section from the
  // system prompt via its SIMPLE early-return; this gate stops the other half
  // (extractMemories turn-end fork, autoDream, /remember, /dream, team sync).
  if (isEnvTruthy(process.env.AGENC_SIMPLE)) {
    return false
  }
  if (
    isEnvTruthy(process.env.AGENC_REMOTE) &&
    !process.env.AGENC_REMOTE_MEMORY_DIR
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
  if (process.env.AGENC_REMOTE_MEMORY_DIR) {
    return process.env.AGENC_REMOTE_MEMORY_DIR
  }
  return getAgenCConfigHomeDir()
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
  // Settings.json paths support ~/ expansion (user-friendly). The env var
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
    process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE,
    false,
  )
}

/**
 * Settings.json override for the full auto-memory directory path.
 * Supports ~/ expansion for user convenience.
 *
 * SECURITY: project/local repository settings are intentionally excluded — a malicious repo could otherwise set
 * autoMemoryDirectory: "~/.ssh" and gain silent write access to sensitive
 * directories via the filesystem.ts write carve-out (which fires when
 * isAutoMemPath() matches and hasAutoMemPathOverride() is false). This follows
 * the same pattern as hasSkipDangerousModePermissionPrompt() etc.
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
 * Returns the auto-memory directory path.
 *
 * Resolution order:
 *   1. AGENC_COWORK_MEMORY_PATH_OVERRIDE env var (full-path override, used by Cowork)
 *   2. autoMemoryDirectory in settings.json (trusted sources only: policy/flag/user)
 *   3. In remote mode, <memoryBase>/projects/<sanitized-git-root>/memory/
 *   4. Otherwise, <projectRoot>/.agenc/memory/
 *
 * Memoized: render-path callers (collapseReadSearchGroups → isAutoManagedMemoryFile)
 * fire per tool-use message per Messages re-render; each miss costs
 * getSettingsForSource × 4 → parseSettingsFile (realpathSync + readFileSync).
 * Keyed on projectRoot so tests that change its mock mid-block recompute;
 * env vars / settings.json / AGENC_CONFIG_DIR are session-stable in
 * production and covered by per-test cache.clear.
 */
export const getProjectMemoryPath = memoize(
  (): string => {
    const override = getAutoMemPathOverride() ?? getAutoMemPathSetting()
    if (override) {
      return override
    }
    if (process.env.AGENC_REMOTE_MEMORY_DIR) {
      const projectsDir = join(getMemoryBaseDir(), 'projects')
      return (
        join(projectsDir, sanitizePath(getAutoMemBase()), MEMORY_DIRNAME) + sep
      ).normalize('NFC')
    }
    return (
      join(getProjectRoot(), PROJECT_MEMORY_DIR, MEMORY_DIRNAME) + sep
    ).normalize('NFC')
  },
  () => getProjectRoot(),
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
 * The settings.json autoMemoryDirectory DOES get the write carve-out: it's the
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
