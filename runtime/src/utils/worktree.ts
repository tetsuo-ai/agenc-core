import chalk from 'chalk'
import { spawnSync } from 'child_process'
import { mkdir, readdir, stat, symlink, utimes } from 'fs/promises'
import { basename, join } from 'path'
import { saveCurrentProjectConfig } from './config.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage, getErrnoCode } from './errors.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from './execFileNoThrow.js'
import {
  readWorktreeHeadSha,
  resolveGitDir,
  resolveRef,
} from './git/gitFilesystem.js'
import {
  findCanonicalGitRoot,
  findGitRoot,
  getBranch,
  getDefaultBranch,
  gitExe,
} from './git.js'
import {
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
  hasWorktreeCreateHook,
} from './hooks.js'
import { containsPathTraversal } from './path.js'
import { getPlatform } from './platform.js'
import { getExecutionAuthoritySettings } from './settings/settings.js'
import { sleep } from './sleep.js'
import { isInITerm2 } from './swarm/backends/detection.js'
import {
  SandboxExecutionError,
  type SandboxExecutionBrokerLike,
  type SandboxExecutionSurface,
} from '../sandbox/execution-broker.js'
import { scrubEnvForChildProcess } from '../unified-exec/scrub-env.js'
import { gitChildEnvironment } from '../sandbox/git-environment.js'
import { runSupervisedProcess } from './supervisedProcess.js'
import type { AdditionalPermissionProfile } from '../sandbox/engine/index.js'
import {
  hardenGitWorktreeMutationArgs,
  worktreeMutationPermissions,
} from '../sandbox/worktree-permissions.js'

const VALID_WORKTREE_SLUG_SEGMENT = /^[a-zA-Z0-9._-]+$/
const MAX_WORKTREE_SLUG_LENGTH = 64

/**
 * Validates a worktree slug to prevent path traversal and directory escape.
 *
 * The slug is joined into `.agenc/worktrees/<slug>` via path.join, which
 * normalizes `..` segments — so `../../../target` would escape the worktrees
 * directory. Similarly, an absolute path (leading `/` or `C:\`) would discard
 * the prefix entirely.
 *
 * Forward slashes are allowed for nesting (e.g. `asm/feature-foo`); each
 * segment is validated independently against the allowlist, so `.` / `..`
 * segments and drive-spec characters are still rejected.
 *
 * Throws synchronously — callers rely on this running before any side effects
 * (git commands, hook execution, chdir).
 */
export function validateWorktreeSlug(slug: string): void {
  if (slug.length > MAX_WORKTREE_SLUG_LENGTH) {
    throw new Error(
      `Invalid worktree name: must be ${MAX_WORKTREE_SLUG_LENGTH} characters or fewer (got ${slug.length})`,
    )
  }
  // Leading or trailing `/` would make path.join produce an absolute path
  // or a dangling segment. Splitting and validating each segment rejects
  // both (empty segments fail the regex) while allowing `user/feature`.
  for (const segment of slug.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new Error(
        `Invalid worktree name "${slug}": must not contain "." or ".." path segments`,
      )
    }
    if (!VALID_WORKTREE_SLUG_SEGMENT.test(segment)) {
      throw new Error(
        `Invalid worktree name "${slug}": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes`,
      )
    }
  }
}

/**
 * Symlinks directories from the main repository to avoid duplication.
 * This prevents disk bloat from duplicating node_modules and other large directories.
 *
 * @param repoRootPath - Path to the main repository root
 * @param worktreePath - Path to the worktree directory
 * @param dirsToSymlink - Array of directory names to symlink (e.g., ['node_modules'])
 */
async function symlinkDirectories(
  repoRootPath: string,
  worktreePath: string,
  dirsToSymlink: string[],
): Promise<void> {
  for (const dir of dirsToSymlink) {
    // Validate directory doesn't escape repository boundaries
    if (containsPathTraversal(dir)) {
      logForDebugging(
        `Skipping symlink for "${dir}": path traversal detected`,
        { level: 'warn' },
      )
      continue
    }

    const sourcePath = join(repoRootPath, dir)
    const destPath = join(worktreePath, dir)

    try {
      await symlink(sourcePath, destPath, 'dir')
      logForDebugging(
        `Symlinked ${dir} from main repository to worktree to avoid disk bloat`,
      )
    } catch (error) {
      const code = getErrnoCode(error)
      // ENOENT: source doesn't exist yet (expected - skip silently)
      // EEXIST: destination already exists (expected - skip silently)
      if (code !== 'ENOENT' && code !== 'EEXIST') {
        // Unexpected error (e.g., permission denied, unsupported platform)
        logForDebugging(
          `Failed to symlink ${dir} (${code ?? 'unknown'}): ${errorMessage(error)}`,
          { level: 'warn' },
        )
      }
    }
  }
}

export type WorktreeSession = {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  sessionId: string
  tmuxSessionName?: string
  hookBased?: boolean
  /** How long worktree creation took (unset when resuming an existing worktree). */
  creationDurationMs?: number
  /** True if git sparse-checkout was applied via settings.worktree.sparsePaths. */
  usedSparsePaths?: boolean
}

let currentWorktreeSession: WorktreeSession | null = null

export function getCurrentWorktreeSession(): WorktreeSession | null {
  return currentWorktreeSession
}

/**
 * Restore the worktree session on --resume. The caller must have already
 * verified the directory exists (via process.chdir) and set the bootstrap
 * state (cwd, originalCwd).
 */
export function restoreWorktreeSession(session: WorktreeSession | null): void {
  currentWorktreeSession = session
}

export function generateTmuxSessionName(
  repoPath: string,
  branch: string,
): string {
  const repoName = basename(repoPath)
  const combined = `${repoName}_${branch}`
  return combined.replace(/[/.]/g, '_')
}

type WorktreeCreateResult =
  | {
      worktreePath: string
      worktreeBranch: string
      headCommit: string
      existed: true
    }
  | {
      worktreePath: string
      worktreeBranch: string
      headCommit: string
      baseBranch: string
      existed: false
    }

const gitWorktreeMutationLocks = new Map<string, Promise<void>>()

export async function withGitWorktreeMutationLock<T>(
  repoRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = gitWorktreeMutationLocks.get(repoRoot) ?? Promise.resolve()
  let releaseCurrent!: () => void
  const current = new Promise<void>(resolve => {
    releaseCurrent = resolve
  })
  const next = previous.catch(() => {}).then(() => current)
  gitWorktreeMutationLocks.set(repoRoot, next)

  await previous.catch(() => {})

  try {
    return await fn()
  } finally {
    releaseCurrent()
    if (gitWorktreeMutationLocks.get(repoRoot) === next) {
      gitWorktreeMutationLocks.delete(repoRoot)
    }
  }
}

export function _resetGitWorktreeMutationLocksForTesting(): void {
  gitWorktreeMutationLocks.clear()
}

// Env vars to prevent git/SSH from prompting for credentials (which hangs the CLI).
// GIT_TERMINAL_PROMPT=0 prevents git from opening /dev/tty for credential prompts.
// GIT_ASKPASS='' disables askpass GUI programs.
// stdin: 'ignore' closes stdin so interactive prompts can't block.
const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
}

type WorktreeProcessBoundary = {
  sandboxExecutionBroker: SandboxExecutionBrokerLike
  surface: SandboxExecutionSurface
}

async function execWorktreeProcess(
  file: string,
  args: string[],
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
    stdin?: 'ignore' | 'inherit' | 'pipe'
  },
  boundary?: WorktreeProcessBoundary,
  additionalPermissions?: AdditionalPermissionProfile,
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  if (boundary === undefined) {
    return execFileNoThrowWithCwd(file, args, options)
  }
  const command = boundary.sandboxExecutionBroker.prepareSpawn(
    boundary.surface,
    {
    program: file,
    args: file === gitExe() ? hardenGitWorktreeMutationArgs(args) : args,
    cwd: options.cwd,
    env: file === gitExe()
      ? gitChildEnvironment(options.env ?? process.env)
      : scrubEnvForChildProcess(options.env ?? process.env),
    argv0: basename(file),
    ...(additionalPermissions !== undefined
      ? { additionalPermissions }
      : {}),
    trustedExecutable: true,
    },
  )
  const result = await runSupervisedProcess(command, {
    timeoutMs: 60_000,
    maxOutputBytes: 4 * 1024 * 1024,
  })
  return {
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
    code: result.exitCode ?? 1,
    ...(result.error !== undefined
      ? { error: result.error.message }
      : result.stopReason !== undefined
        ? { error: `worktree helper stopped (${result.stopReason})` }
        : {}),
  }
}

function execWorktreeMutation(
  file: string,
  args: string[],
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
    stdin?: 'ignore' | 'inherit' | 'pipe'
  },
  boundary: WorktreeProcessBoundary | undefined,
  repoRoot: string,
  writablePaths: readonly string[] = [],
) {
  return execWorktreeProcess(
    file,
    args,
    options,
    boundary,
    boundary === undefined
      ? undefined
      : worktreeMutationPermissions(repoRoot, writablePaths),
  )
}

function worktreesDir(repoRoot: string): string {
  return join(repoRoot, '.agenc', 'worktrees')
}

// Flatten nested slugs (`user/feature` → `user+feature`) for both the branch
// name and the directory path. Nesting in either location is unsafe:
//   - git refs: `worktree-user` (file) vs `worktree-user/feature` (needs dir)
//     is a D/F conflict that git rejects.
//   - directory: `.agenc/worktrees/user/feature/` lives inside the `user`
//     worktree; `git worktree remove` on the parent deletes children with
//     uncommitted work.
// `+` is valid in git branch names and filesystem paths but NOT in the
// slug-segment allowlist ([a-zA-Z0-9._-]), so the mapping is injective.
function flattenSlug(slug: string): string {
  return slug.replaceAll('/', '+')
}

export function worktreeBranchName(slug: string): string {
  return `worktree-${flattenSlug(slug)}`
}

function worktreePathFor(repoRoot: string, slug: string): string {
  return join(worktreesDir(repoRoot), flattenSlug(slug))
}

/**
 * Creates a new git worktree for the given slug, or resumes it if it already exists.
 * Named worktrees reuse the same path across invocations, so the existence check
 * prevents unconditionally running `git fetch` (which can hang waiting for credentials)
 * on every resume.
 */
async function getOrCreateWorktree(
  repoRoot: string,
  slug: string,
  options?: {
    prNumber?: number
    processBoundary?: WorktreeProcessBoundary
  },
): Promise<WorktreeCreateResult> {
  const worktreePath = worktreePathFor(repoRoot, slug)
  const worktreeBranch = worktreeBranchName(slug)

  // Fast resume path: if the worktree already exists skip fetch and creation.
  // Read the .git pointer file directly (no subprocess, no upward walk) — a
  // subprocess `rev-parse HEAD` burns ~15ms on spawn overhead even for a 2ms
  // task, and the await yield lets background spawnSyncs pile on (seen at 55ms).
  const existingHead = await readWorktreeHeadSha(worktreePath)
  if (existingHead) {
    return {
      worktreePath,
      worktreeBranch,
      headCommit: existingHead,
      existed: true,
    }
  }

  return withGitWorktreeMutationLock(repoRoot, async () => {
    const lockedExistingHead = await readWorktreeHeadSha(worktreePath)
    if (lockedExistingHead) {
      return {
        worktreePath,
        worktreeBranch,
        headCommit: lockedExistingHead,
        existed: true,
      }
    }

    // New worktree: fetch base branch then add
    await mkdir(worktreesDir(repoRoot), { recursive: true })

    const fetchEnv = { ...process.env, ...GIT_NO_PROMPT_ENV }

    let baseBranch: string
    let baseSha: string | null = null
    if (options?.prNumber) {
      const { code: prFetchCode, stderr: prFetchStderr } =
        await execWorktreeMutation(
          gitExe(),
          ['fetch', 'origin', `pull/${options.prNumber}/head`],
          { cwd: repoRoot, stdin: 'ignore', env: fetchEnv },
          options.processBoundary,
          repoRoot,
        )
      if (prFetchCode !== 0) {
        throw new Error(
          `Failed to fetch PR #${options.prNumber}: ${prFetchStderr.trim() || 'PR may not exist or the repository may not have a remote named "origin"'}`,
        )
      }
      baseBranch = 'FETCH_HEAD'
    } else {
      // Use the locally available remote-tracking branch when present. Worktree
      // creation must not perform an implicit network operation: callers that
      // need a fresher base can fetch explicitly before creating the worktree.
      // resolveRef reads the loose/packed ref directly; when it succeeds we
      // already have the SHA, so the later rev-parse is skipped entirely.
      const [defaultBranch, gitDir] = await Promise.all([
        getDefaultBranch(),
        resolveGitDir(repoRoot),
      ])
      const originRef = `origin/${defaultBranch}`
      const originSha = gitDir
        ? await resolveRef(gitDir, `refs/remotes/origin/${defaultBranch}`)
        : null
      if (originSha) {
        baseBranch = originRef
        baseSha = originSha
      } else {
        baseBranch = 'HEAD'
      }
    }

    // For the fetch/PR-fetch paths we still need the SHA — the fs-only resolveRef
    // above only covers the "origin/<branch> already exists locally" case.
    if (!baseSha) {
      const { stdout, code: shaCode } = await execWorktreeProcess(
        gitExe(),
        ['rev-parse', baseBranch],
        { cwd: repoRoot },
        options?.processBoundary,
      )
      if (shaCode !== 0) {
        throw new Error(
          `Failed to resolve base branch "${baseBranch}": git rev-parse failed`,
        )
      }
      baseSha = stdout.trim()
    }

    const sparsePaths = getExecutionAuthoritySettings().worktree?.sparsePaths
    const addArgs = ['worktree', 'add']
    if (sparsePaths?.length) {
      addArgs.push('--no-checkout')
    }
    // -B (not -b): reset any orphan branch left behind by a removed worktree dir.
    // Saves a `git branch -D` subprocess (~15ms spawn overhead) on every create.
    addArgs.push('-B', worktreeBranch, worktreePath, baseBranch)

    const { code: createCode, stderr: createStderr } =
      await execWorktreeMutation(
        gitExe(),
        addArgs,
        { cwd: repoRoot },
        options?.processBoundary,
        repoRoot,
        [worktreesDir(repoRoot)],
      )
    if (createCode !== 0) {
      throw new Error(`Failed to create worktree: ${createStderr}`)
    }

    if (sparsePaths?.length) {
      // If sparse-checkout or checkout fail after --no-checkout, the worktree
      // is registered and HEAD is set but the working tree is empty. Next run's
      // fast-resume (rev-parse HEAD) would succeed and present a broken worktree
      // as "resumed". Tear it down before propagating the error.
      const tearDown = async (msg: string): Promise<never> => {
        await execWorktreeMutation(
          gitExe(),
          ['worktree', 'remove', '--force', worktreePath],
          { cwd: repoRoot },
          options?.processBoundary,
          repoRoot,
          [worktreePath],
        )
        throw new Error(msg)
      }
      const { code: sparseCode, stderr: sparseErr } =
        await execWorktreeMutation(
          gitExe(),
          ['sparse-checkout', 'set', '--cone', '--', ...sparsePaths],
          { cwd: worktreePath },
          options?.processBoundary,
          repoRoot,
          [worktreePath],
        )
      if (sparseCode !== 0) {
        await tearDown(`Failed to configure sparse-checkout: ${sparseErr}`)
      }
      const { code: coCode, stderr: coErr } = await execWorktreeMutation(
        gitExe(),
        ['checkout', 'HEAD'],
        { cwd: worktreePath },
        options?.processBoundary,
        repoRoot,
        [worktreePath],
      )
      if (coCode !== 0) {
        await tearDown(`Failed to checkout sparse worktree: ${coErr}`)
      }
    }

    return {
      worktreePath,
      worktreeBranch,
      headCommit: baseSha,
      baseBranch,
      existed: false,
    }
  })
}

/**
 * Compatibility shim for the retired repository-controlled
 * `.worktreeinclude` manifest.
 *
 * A tracked manifest could select arbitrary gitignored credentials or other
 * private files and copy them into every agent worktree. Repository content is
 * guidance-only, so it cannot authorize that data movement. Keep the export for
 * callers compiled against older runtime versions, but fail closed.
 */
export async function copyWorktreeIncludeFiles(
  _repoRoot: string,
  _worktreePath: string,
): Promise<string[]> {
  return []
}

/**
 * Post-creation setup for a newly created worktree.
 * Applies only operator-authorized directory sharing.
 */
async function performPostCreationSetup(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  // Git configuration is shared by linked worktrees. Never install a tracked
  // `.husky` directory as `core.hooksPath` here: that would let repository
  // content turn worktree creation into future command execution. Existing
  // operator-configured hooks are inherited by Git without runtime mutation.

  // Symlink directories only when an operator-controlled settings source opts in.
  const settings = getExecutionAuthoritySettings()
  const dirsToSymlink = settings.worktree?.symlinkDirectories ?? []
  if (dirsToSymlink.length > 0) {
    await symlinkDirectories(repoRoot, worktreePath, dirsToSymlink)
  }
}

/**
 * Parses a PR reference from a string.
 * Accepts GitHub-style PR URLs (e.g., https://github.com/owner/repo/pull/123,
 * or GHE equivalents like https://ghe.example.com/owner/repo/pull/123)
 * or `#N` format (e.g., #123).
 * Returns the PR number or null if the string is not a recognized PR reference.
 */
export function parsePRReference(input: string): number | null {
  // GitHub-style PR URL: https://<host>/owner/repo/pull/123 (with optional trailing slash, query, hash)
  // The /pull/N path shape is specific to GitHub — GitLab uses /-/merge_requests/N,
  // Bitbucket uses /pull-requests/N — so matching any host here is safe.
  const urlMatch = input.match(
    /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)\/?(?:[?#].*)?$/i,
  )
  if (urlMatch?.[1]) {
    return parseInt(urlMatch[1], 10)
  }

  // #N format
  const hashMatch = input.match(/^#(\d+)$/)
  if (hashMatch?.[1]) {
    return parseInt(hashMatch[1], 10)
  }

  return null
}

export async function isTmuxAvailable(): Promise<boolean> {
  const { code } = await execFileNoThrow('tmux', ['-V'])
  return code === 0
}

export function getTmuxInstallInstructions(): string {
  const platform = getPlatform()
  switch (platform) {
    case 'macos':
      return 'Install tmux with: brew install tmux'
    case 'linux':
    case 'wsl':
      return 'Install tmux with: sudo apt install tmux (Debian/Ubuntu) or sudo dnf install tmux (Fedora/RHEL)'
    case 'windows':
      return 'tmux is not natively available on Windows. Consider using WSL or Cygwin.'
    default:
      return 'Install tmux using your system package manager.'
  }
}

export async function createTmuxSessionForWorktree(
  sessionName: string,
  worktreePath: string,
): Promise<{ created: boolean; error?: string }> {
  const { code, stderr } = await execFileNoThrow('tmux', [
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-c',
    worktreePath,
  ])

  if (code !== 0) {
    return { created: false, error: stderr }
  }

  return { created: true }
}

export async function killTmuxSession(
  sessionName: string,
  sandboxExecutionBroker?: SandboxExecutionBrokerLike,
): Promise<boolean> {
  const { code } = await execWorktreeProcess(
    'tmux',
    ['kill-session', '-t', sessionName],
    { cwd: getCwd() },
    sandboxExecutionBroker === undefined
      ? undefined
      : { sandboxExecutionBroker, surface: 'tool' },
  )
  return code === 0
}

export async function createWorktreeForSession(
  sessionId: string,
  slug: string,
  tmuxSessionName?: string,
  options?: {
    prNumber?: number
    sandboxExecutionBroker?: SandboxExecutionBrokerLike
  },
): Promise<WorktreeSession> {
  // Must run before the hook branch below — hooks receive the raw slug as an
  // argument, and the git branch builds a path from it via path.join.
  validateWorktreeSlug(slug)

  const originalCwd = getCwd()

  // Try hook-based worktree creation first (allows user-configured VCS)
  if (hasWorktreeCreateHook()) {
    const hookResult = await executeWorktreeCreateHook(slug)
    logForDebugging(
      `Created hook-based worktree at: ${hookResult.worktreePath}`,
    )

    currentWorktreeSession = {
      originalCwd,
      worktreePath: hookResult.worktreePath,
      worktreeName: slug,
      sessionId,
      tmuxSessionName,
      hookBased: true,
    }
  } else {
    // Fall back to git worktree
    const gitRoot = findGitRoot(getCwd())
    if (!gitRoot) {
      throw new Error(
        'Cannot create a worktree: not in a git repository and no WorktreeCreate hooks are configured. ' +
          'Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktree isolation with other VCS systems.',
      )
    }

    const originalBranch = await getBranch()

    const createStart = Date.now()
    const { worktreePath, worktreeBranch, headCommit, existed } =
      await getOrCreateWorktree(gitRoot, slug, {
        ...(options?.prNumber !== undefined
          ? { prNumber: options.prNumber }
          : {}),
        ...(options?.sandboxExecutionBroker !== undefined
          ? {
              processBoundary: {
                sandboxExecutionBroker: options.sandboxExecutionBroker,
                surface: 'tool',
              },
            }
          : {}),
      })

    let creationDurationMs: number | undefined
    if (existed) {
      logForDebugging(`Resuming existing worktree at: ${worktreePath}`)
    } else {
      logForDebugging(
        `Created worktree at: ${worktreePath} on branch: ${worktreeBranch}`,
      )
      await performPostCreationSetup(gitRoot, worktreePath)
      creationDurationMs = Date.now() - createStart
    }

    currentWorktreeSession = {
      originalCwd,
      worktreePath,
      worktreeName: slug,
      worktreeBranch,
      originalBranch,
      originalHeadCommit: headCommit,
      sessionId,
      tmuxSessionName,
      creationDurationMs,
      usedSparsePaths:
        (getExecutionAuthoritySettings().worktree?.sparsePaths?.length ?? 0) >
        0,
    }
  }

  // Save to project config for persistence
  saveCurrentProjectConfig(current => ({
    ...current,
    activeWorktreeSession: currentWorktreeSession ?? undefined,
  }))

  return currentWorktreeSession
}

export async function keepWorktree(): Promise<void> {
  if (!currentWorktreeSession) {
    return
  }

  try {
    const { worktreePath, originalCwd, worktreeBranch } = currentWorktreeSession

    // Change back to original directory first
    process.chdir(originalCwd)

    // Clear the session but keep the worktree intact
    currentWorktreeSession = null

    // Update config
    saveCurrentProjectConfig(current => ({
      ...current,
      activeWorktreeSession: undefined,
    }))

    logForDebugging(
      `Linked worktree preserved at: ${worktreePath}${worktreeBranch ? ` on branch: ${worktreeBranch}` : ''}`,
    )
    logForDebugging(
      `You can continue working there by running: cd ${worktreePath}`,
    )
  } catch (error) {
    logForDebugging(`Error keeping worktree: ${error}`, {
      level: 'error',
    })
  }
}

export async function cleanupWorktree(
  sandboxExecutionBroker?: SandboxExecutionBrokerLike,
): Promise<void> {
  if (!currentWorktreeSession) {
    return
  }

  try {
    const { worktreePath, originalCwd, worktreeBranch, hookBased } =
      currentWorktreeSession
    const cleanupSandboxExecutionBroker =
      sandboxExecutionBroker?.forkForCwd(originalCwd)

    // Change back to original directory first
    process.chdir(originalCwd)

    if (hookBased) {
      // Hook-based worktree: delegate cleanup to WorktreeRemove hook
      const hookRan = await executeWorktreeRemoveHook(worktreePath)
      if (hookRan) {
        logForDebugging(`Removed hook-based worktree at: ${worktreePath}`)
      } else {
        logForDebugging(
          `No WorktreeRemove hook configured, hook-based worktree left at: ${worktreePath}`,
          { level: 'warn' },
        )
      }
    } else {
      // Git-based worktree: use git worktree remove.
      // Explicit cwd: process.chdir above does NOT update getCwd() (the state
      // CWD that execFileNoThrow defaults to). If the model cd'd to a non-repo
      // dir, the bare execFileNoThrow variant would fail silently here.
      const { code: removeCode, stderr: removeError } =
        await execWorktreeMutation(
          gitExe(),
          ['worktree', 'remove', '--force', worktreePath],
          { cwd: originalCwd },
          cleanupSandboxExecutionBroker === undefined
            ? undefined
            : {
                sandboxExecutionBroker: cleanupSandboxExecutionBroker,
                surface: 'tool',
              },
          originalCwd,
          [worktreePath],
        )

      if (removeCode !== 0) {
        logForDebugging(`Failed to remove linked worktree: ${removeError}`, {
          level: 'error',
        })
      } else {
        logForDebugging(`Removed linked worktree at: ${worktreePath}`)
      }
    }

    // Clear the session
    currentWorktreeSession = null

    // Update config
    saveCurrentProjectConfig(current => ({
      ...current,
      activeWorktreeSession: undefined,
    }))

    // Delete the short-lived worktree branch (git-based only)
    if (!hookBased && worktreeBranch) {
      // Wait a bit to ensure git has released all locks
      await sleep(100)

      const { code: deleteBranchCode, stderr: deleteBranchError } =
        await execWorktreeMutation(
          gitExe(),
          ['branch', '-D', worktreeBranch],
          { cwd: originalCwd },
          cleanupSandboxExecutionBroker === undefined
            ? undefined
            : {
                sandboxExecutionBroker: cleanupSandboxExecutionBroker,
                surface: 'tool',
              },
          originalCwd,
        )

      if (deleteBranchCode !== 0) {
        logForDebugging(
          `Could not delete worktree branch: ${deleteBranchError}`,
          { level: 'error' },
        )
      } else {
        logForDebugging(`Deleted worktree branch: ${worktreeBranch}`)
      }
    }

    logForDebugging('Linked worktree cleaned up completely')
  } catch (error) {
    if (error instanceof SandboxExecutionError) throw error
    logForDebugging(`Error cleaning up worktree: ${error}`, {
      level: 'error',
    })
  }
}

/**
 * Create a lightweight worktree for a subagent.
 * Reuses getOrCreateWorktree/performPostCreationSetup but does NOT touch
 * global session state (currentWorktreeSession, process.chdir, project config).
 * Falls back to hook-based creation if not in a git repository.
 */
export async function createAgentWorktree(
  slug: string,
  sandboxExecutionBroker?: SandboxExecutionBrokerLike,
): Promise<{
  worktreePath: string
  worktreeBranch?: string
  headCommit?: string
  gitRoot?: string
  hookBased?: boolean
}> {
  validateWorktreeSlug(slug)

  // Try hook-based worktree creation first (allows user-configured VCS)
  if (hasWorktreeCreateHook()) {
    const hookResult = await executeWorktreeCreateHook(slug)
    logForDebugging(
      `Created hook-based agent worktree at: ${hookResult.worktreePath}`,
    )

    return { worktreePath: hookResult.worktreePath, hookBased: true }
  }

  // Fall back to git worktree
  // findCanonicalGitRoot (not findGitRoot) so agent worktrees always land in
  // the main repo's .agenc/worktrees/ even when spawned from inside a session
  // worktree — otherwise they nest at <worktree>/.agenc/worktrees/ and the
  // periodic cleanup (which scans the canonical root) never finds them.
  const gitRoot = findCanonicalGitRoot(getCwd())
  if (!gitRoot) {
    throw new Error(
      'Cannot create agent worktree: not in a git repository and no WorktreeCreate hooks are configured. ' +
        'Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktree isolation with other VCS systems.',
    )
  }

  const { worktreePath, worktreeBranch, headCommit, existed } =
    await getOrCreateWorktree(gitRoot, slug, {
      ...(sandboxExecutionBroker !== undefined
        ? {
            processBoundary: {
              sandboxExecutionBroker,
              surface: 'child_agent' as const,
            },
          }
        : {}),
    })

  if (!existed) {
    logForDebugging(
      `Created agent worktree at: ${worktreePath} on branch: ${worktreeBranch}`,
    )
    await performPostCreationSetup(gitRoot, worktreePath)
  } else {
    // Bump mtime so the periodic stale-worktree cleanup doesn't consider this
    // worktree stale — the fast-resume path is read-only and leaves the original
    // creation-time mtime intact, which can be past the 30-day cutoff.
    const now = new Date()
    await utimes(worktreePath, now, now)
    logForDebugging(`Resuming existing agent worktree at: ${worktreePath}`)
  }

  return { worktreePath, worktreeBranch, headCommit, gitRoot }
}

/**
 * Remove a worktree created by createAgentWorktree.
 * For git-based worktrees, removes the worktree directory and deletes the short-lived branch.
 * For hook-based worktrees, delegates to the WorktreeRemove hook.
 * Must be called with the main repo's git root (for git worktrees), not the worktree path,
 * since the worktree directory is deleted during this operation.
 */
export async function removeAgentWorktree(
  worktreePath: string,
  worktreeBranch?: string,
  gitRoot?: string,
  hookBased?: boolean,
  sandboxExecutionBroker?: SandboxExecutionBrokerLike,
): Promise<boolean> {
  if (hookBased) {
    const hookRan = await executeWorktreeRemoveHook(worktreePath)
    if (hookRan) {
      logForDebugging(`Removed hook-based agent worktree at: ${worktreePath}`)
    } else {
      logForDebugging(
        `No WorktreeRemove hook configured, hook-based agent worktree left at: ${worktreePath}`,
        { level: 'warn' },
      )
    }
    return hookRan
  }

  if (!gitRoot) {
    logForDebugging('Cannot remove agent worktree: no git root provided', {
      level: 'error',
    })
    return false
  }

  return withGitWorktreeMutationLock(gitRoot, async () => {
    // Run from the main repo root, not the worktree (which we're about to delete)
    const { code: removeCode, stderr: removeError } =
      await execWorktreeMutation(
        gitExe(),
        ['worktree', 'remove', '--force', worktreePath],
        { cwd: gitRoot },
        sandboxExecutionBroker === undefined
          ? undefined
          : { sandboxExecutionBroker, surface: 'child_agent' },
        gitRoot,
        [worktreePath],
      )

    if (removeCode !== 0) {
      logForDebugging(`Failed to remove agent worktree: ${removeError}`, {
        level: 'error',
      })
      return false
    }
    logForDebugging(`Removed agent worktree at: ${worktreePath}`)

    if (!worktreeBranch) {
      return true
    }

    // Delete the short-lived worktree branch from the main repo
    const { code: deleteBranchCode, stderr: deleteBranchError } =
      await execWorktreeMutation(
        gitExe(),
        ['branch', '-D', worktreeBranch],
        { cwd: gitRoot },
        sandboxExecutionBroker === undefined
          ? undefined
          : { sandboxExecutionBroker, surface: 'child_agent' },
        gitRoot,
      )

    if (deleteBranchCode !== 0) {
      logForDebugging(
        `Could not delete agent worktree branch: ${deleteBranchError}`,
        { level: 'error' },
      )
    }
    return true
  })
}

/**
 * Slug patterns for throwaway worktrees created by AgentTool (`agent-a<7hex>`,
 * from earlyAgentId.slice(0,8)), WorkflowTool (`wf_<runId>-<idx>` where runId
 * is randomUUID().slice(0,12) = 8 hex + `-` + 3 hex), and bridgeMain
 * (`bridge-<safeFilenameId>`). These leak when the parent process is killed
 * (Ctrl+C, ESC, crash) before their in-process cleanup runs. Exact-shape
 * patterns avoid sweeping user-named EnterWorktree slugs like `wf-myfeature`.
 */
const EPHEMERAL_WORKTREE_PATTERNS = [
  /^agent-a[0-9a-f]{7}$/,
  /^wf_[0-9a-f]{8}-[0-9a-f]{3}-\d+$/,
  // Compatibility wf-<idx> slugs from before workflowRunId disambiguation — kept so
  // the 30-day sweep still cleans up worktrees leaked by older builds.
  /^wf-\d+$/,
  // Real bridge slugs are `bridge-${safeFilenameId(sessionId)}`.
  /^bridge-[A-Za-z0-9_]+(-[A-Za-z0-9_]+)*$/,
  // Template job worktrees: job-<templateName>-<8hex>. Prefix distinguishes
  // from user-named EnterWorktree slugs that happen to end in 8 hex.
  /^job-[a-zA-Z0-9._-]{1,55}-[0-9a-f]{8}$/,
]

/**
 * Remove stale agent/workflow worktrees older than cutoffDate.
 *
 * Safety:
 * - Only touches slugs matching ephemeral patterns (never user-named worktrees)
 * - Skips the current session's worktree
 * - Fail-closed: skips if git status fails or shows tracked changes
 *   (-uno: untracked files in a 30-day-old crashed agent worktree are build
 *   artifacts; skipping the untracked scan is 5-10× faster on large repos)
 * - Fail-closed: skips if any commits aren't reachable from a remote
 *
 * `git worktree remove --force` handles both the directory and git's internal
 * worktree tracking. If git doesn't recognize the path as a worktree (orphaned
 * dir), it's left in place — a later readdir finding it stale again is harmless.
 */
export async function cleanupStaleAgentWorktrees(
  cutoffDate: Date,
): Promise<number> {
  const gitRoot = findCanonicalGitRoot(getCwd())
  if (!gitRoot) {
    return 0
  }

  const dir = worktreesDir(gitRoot)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return 0
  }

  const cutoffMs = cutoffDate.getTime()
  const currentPath = currentWorktreeSession?.worktreePath
  let removed = 0

  for (const slug of entries) {
    if (!EPHEMERAL_WORKTREE_PATTERNS.some(p => p.test(slug))) {
      continue
    }

    const worktreePath = join(dir, slug)
    if (currentPath === worktreePath) {
      continue
    }

    let mtimeMs: number
    try {
      mtimeMs = (await stat(worktreePath)).mtimeMs
    } catch {
      continue
    }
    if (mtimeMs >= cutoffMs) {
      continue
    }

    // Both checks must succeed with empty output. Non-zero exit (corrupted
    // worktree, git not recognizing it, etc.) means skip — we don't know
    // what's in there.
    const [status, unpushed] = await Promise.all([
      execFileNoThrowWithCwd(
        gitExe(),
        ['--no-optional-locks', 'status', '--porcelain', '-uno'],
        { cwd: worktreePath },
      ),
      execFileNoThrowWithCwd(
        gitExe(),
        ['rev-list', '--max-count=1', 'HEAD', '--not', '--remotes'],
        { cwd: worktreePath },
      ),
    ])
    if (status.code !== 0 || status.stdout.trim().length > 0) {
      continue
    }
    if (unpushed.code !== 0 || unpushed.stdout.trim().length > 0) {
      continue
    }

    if (
      await removeAgentWorktree(worktreePath, worktreeBranchName(slug), gitRoot)
    ) {
      removed++
    }
  }

  if (removed > 0) {
    await execFileNoThrowWithCwd(gitExe(), ['worktree', 'prune'], {
      cwd: gitRoot,
    })
    logForDebugging(
      `cleanupStaleAgentWorktrees: removed ${removed} stale worktree(s)`,
    )
  }
  return removed
}

/**
 * Check whether a worktree has uncommitted changes or new commits since creation.
 * Returns true if there are uncommitted changes (dirty working tree), if commits
 * were made on the worktree branch since `headCommit`, or if git commands fail
 * — callers use this to decide whether to remove a worktree, so fail-closed.
 */
export async function hasWorktreeChanges(
  worktreePath: string,
  headCommit: string,
  sandboxExecutionBroker?: SandboxExecutionBrokerLike,
): Promise<boolean> {
  const { code: statusCode, stdout: statusOutput } =
    await execWorktreeProcess(
      gitExe(),
      ['status', '--porcelain'],
      { cwd: worktreePath },
      sandboxExecutionBroker === undefined
        ? undefined
        : { sandboxExecutionBroker, surface: 'child_agent' },
    )
  if (statusCode !== 0) {
    return true
  }
  if (statusOutput.trim().length > 0) {
    return true
  }

  const { code: revListCode, stdout: revListOutput } =
    await execWorktreeProcess(
      gitExe(),
      ['rev-list', '--count', `${headCommit}..HEAD`],
      { cwd: worktreePath },
      sandboxExecutionBroker === undefined
        ? undefined
        : { sandboxExecutionBroker, surface: 'child_agent' },
    )
  if (revListCode !== 0) {
    return true
  }
  if (parseInt(revListOutput.trim(), 10) > 0) {
    return true
  }

  return false
}

/**
 * Fast-path handler for --worktree --tmux.
 * Creates the worktree and execs into tmux running AgenC inside.
 * This is called early in cli.tsx before loading the full CLI.
 */
export async function execIntoTmuxWorktree(args: string[]): Promise<{
  handled: boolean
  error?: string
}> {
  // Check platform - tmux doesn't work on Windows
  if (process.platform === 'win32') {
    return {
      handled: false,
      error: 'Error: --tmux is not supported on Windows',
    }
  }

  // Check if tmux is available
  const tmuxCheck = spawnSync('tmux', ['-V'], { encoding: 'utf-8' })
  if (tmuxCheck.status !== 0) {
    const installHint =
      process.platform === 'darwin'
        ? 'Install tmux with: brew install tmux'
        : 'Install tmux with: sudo apt install tmux'
    return {
      handled: false,
      error: `Error: tmux is not installed. ${installHint}`,
    }
  }

  // Parse worktree name and tmux mode from args
  let worktreeName: string | undefined
  let forceClassicTmux = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '-w' || arg === '--worktree') {
      // Check if next arg exists and isn't another flag
      const next = args[i + 1]
      if (next && !next.startsWith('-')) {
        worktreeName = next
      }
    } else if (arg.startsWith('--worktree=')) {
      worktreeName = arg.slice('--worktree='.length)
    } else if (arg === '--tmux=classic') {
      forceClassicTmux = true
    }
  }

  // Check if worktree name is a PR reference
  let prNumber: number | null = null
  if (worktreeName) {
    prNumber = parsePRReference(worktreeName)
    if (prNumber !== null) {
      worktreeName = `pr-${prNumber}`
    }
  }

  // Generate a slug if no name provided
  if (!worktreeName) {
    const adjectives = ['swift', 'bright', 'calm', 'keen', 'bold']
    const nouns = ['fox', 'owl', 'elm', 'oak', 'ray']
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
    const noun = nouns[Math.floor(Math.random() * nouns.length)]
    const suffix = Math.random().toString(36).slice(2, 6)
    worktreeName = `${adj}-${noun}-${suffix}`
  }

  // worktreeName is joined into worktreeDir via path.join below; apply the
  // same allowlist used by the in-session worktree tool so the constraint
  // holds uniformly regardless of entry point.
  try {
    validateWorktreeSlug(worktreeName)
  } catch (e) {
    return {
      handled: false,
      error: `Error: ${(e as Error).message}`,
    }
  }

  // Mirror createWorktreeForSession(): hook takes precedence over git so the
  // WorktreeCreate hook substitutes the VCS backend for this fast-path too
  // (tetsuo-ai/agenc-core#39281). Git path below runs only when no hook.
  let worktreeDir: string
  let repoName: string
  if (hasWorktreeCreateHook()) {
    try {
      const hookResult = await executeWorktreeCreateHook(worktreeName)
      worktreeDir = hookResult.worktreePath
    } catch (error) {
      return {
        handled: false,
        error: `Error: ${errorMessage(error)}`,
      }
    }
    repoName = basename(findCanonicalGitRoot(getCwd()) ?? getCwd())
    // biome-ignore lint/suspicious/noConsole: intentional console output
    console.log(`Using worktree via hook: ${worktreeDir}`)
  } else {
    // Get main git repo root (resolves through worktrees)
    const repoRoot = findCanonicalGitRoot(getCwd())
    if (!repoRoot) {
      return {
        handled: false,
        error: 'Error: --worktree requires a git repository',
      }
    }

    repoName = basename(repoRoot)
    worktreeDir = worktreePathFor(repoRoot, worktreeName)

    // Create or resume worktree
    try {
      const result = await getOrCreateWorktree(
        repoRoot,
        worktreeName,
        prNumber !== null ? { prNumber } : undefined,
      )
      if (!result.existed) {
        // biome-ignore lint/suspicious/noConsole: intentional console output
        console.log(
          `Created worktree: ${worktreeDir} (based on ${result.baseBranch})`,
        )
        await performPostCreationSetup(repoRoot, worktreeDir)
      }
    } catch (error) {
      return {
        handled: false,
        error: `Error: ${errorMessage(error)}`,
      }
    }
  }

  // Sanitize for tmux session name (replace / and . with _)
  const tmuxSessionName =
    `${repoName}_${worktreeBranchName(worktreeName)}`.replace(/[/.]/g, '_')

  // Build new args without --tmux and --worktree (we're already in the worktree)
  const newArgs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--tmux' || arg === '--tmux=classic') continue
    if (arg === '-w' || arg === '--worktree') {
      // Skip the flag and its value if present
      const next = args[i + 1]
      if (next && !next.startsWith('-')) {
        i++ // Skip the value too
      }
      continue
    }
    if (arg.startsWith('--worktree=')) continue
    newArgs.push(arg)
  }

  // Get tmux prefix for user guidance
  let tmuxPrefix = 'C-b' // default
  const prefixResult = spawnSync('tmux', ['show-options', '-g', 'prefix'], {
    encoding: 'utf-8',
  })
  if (prefixResult.status === 0 && prefixResult.stdout) {
    const match = prefixResult.stdout.match(/prefix\s+(\S+)/)
    if (match?.[1]) {
      tmuxPrefix = match[1]
    }
  }

  // Check if tmux prefix conflicts with AgenC keybindings
  // AgenC binds: ctrl+b (task:background), ctrl+c, ctrl+d, ctrl+t, ctrl+o, ctrl+r, ctrl+s, ctrl+g, ctrl+e
  const agencBindings = [
    'C-b',
    'C-c',
    'C-d',
    'C-t',
    'C-o',
    'C-r',
    'C-s',
    'C-g',
    'C-e',
  ]
  const prefixConflicts = agencBindings.includes(tmuxPrefix)

  // Set env vars for the inner AgenC to display tmux info in welcome message
  const tmuxEnv = {
    ...process.env,
    AGENC_TMUX_SESSION: tmuxSessionName,
    AGENC_TMUX_PREFIX: tmuxPrefix,
    AGENC_TMUX_PREFIX_CONFLICTS: prefixConflicts ? '1' : '',
  }

  // Check if session already exists
  const hasSessionResult = spawnSync(
    'tmux',
    ['has-session', '-t', tmuxSessionName],
    { encoding: 'utf-8' },
  )
  const sessionExists = hasSessionResult.status === 0

  // Check if we're already inside a tmux session
  const isAlreadyInTmux = Boolean(process.env.TMUX)

  // Use tmux control mode (-CC) for native iTerm2 tab/pane integration
  // This lets users use iTerm2's UI instead of learning tmux keybindings
  // Use --tmux=classic to force traditional tmux even in iTerm2
  // Control mode doesn't make sense when already in tmux (would need to switch-client)
  const useControlMode = isInITerm2() && !forceClassicTmux && !isAlreadyInTmux
  const tmuxGlobalArgs = useControlMode ? ['-CC'] : []

  // Print hint about iTerm2 preferences when using control mode
  if (useControlMode && !sessionExists) {
    const y = chalk.yellow
    // biome-ignore lint/suspicious/noConsole: intentional user guidance
    console.log(
      `\n${y('╭─ iTerm2 Tip ────────────────────────────────────────────────────────╮')}\n` +
        `${y('│')} To open as a tab instead of a new window:                           ${y('│')}\n` +
        `${y('│')} iTerm2 > Settings > General > tmux > "Tabs in attaching window"     ${y('│')}\n` +
        `${y('╰─────────────────────────────────────────────────────────────────────╯')}\n`,
    )
  }

  // For ants in agenc-cli-internal, set up dev panes (watch + start)
  const isAnt = process.env.USER_TYPE === 'ant'
  const isAgenCCliInternal = repoName === 'agenc-cli-internal'
  const shouldSetupDevPanes = isAnt && isAgenCCliInternal && !sessionExists

  if (shouldSetupDevPanes) {
    // Create detached session with AgenC in first pane
    spawnSync(
      'tmux',
      [
        'new-session',
        '-d', // detached
        '-s',
        tmuxSessionName,
        '-c',
        worktreeDir,
        '--',
        process.execPath,
        ...newArgs,
      ],
      { cwd: worktreeDir, env: tmuxEnv },
    )

    // Split horizontally and run watch
    spawnSync(
      'tmux',
      ['split-window', '-h', '-t', tmuxSessionName, '-c', worktreeDir],
      { cwd: worktreeDir },
    )
    spawnSync(
      'tmux',
      ['send-keys', '-t', tmuxSessionName, 'bun run watch', 'Enter'],
      { cwd: worktreeDir },
    )

    // Split vertically and run start
    spawnSync(
      'tmux',
      ['split-window', '-v', '-t', tmuxSessionName, '-c', worktreeDir],
      { cwd: worktreeDir },
    )
    spawnSync('tmux', ['send-keys', '-t', tmuxSessionName, 'bun run start'], {
      cwd: worktreeDir,
    })

    // Select the first pane (AgenC)
    spawnSync('tmux', ['select-pane', '-t', `${tmuxSessionName}:0.0`], {
      cwd: worktreeDir,
    })

    // Attach or switch to the session
    if (isAlreadyInTmux) {
      // Switch to sibling session (avoid nesting)
      spawnSync('tmux', ['switch-client', '-t', tmuxSessionName], {
        stdio: 'inherit',
      })
    } else {
      // Attach to the session
      spawnSync(
        'tmux',
        [...tmuxGlobalArgs, 'attach-session', '-t', tmuxSessionName],
        {
          stdio: 'inherit',
          cwd: worktreeDir,
        },
      )
    }
  } else {
    // Standard behavior: create or attach
    if (isAlreadyInTmux) {
      // Already in tmux - create detached session, then switch to it (sibling)
      // Check if session already exists first
      if (sessionExists) {
        // Just switch to existing session
        spawnSync('tmux', ['switch-client', '-t', tmuxSessionName], {
          stdio: 'inherit',
        })
      } else {
        // Create new detached session
        spawnSync(
          'tmux',
          [
            'new-session',
            '-d', // detached
            '-s',
            tmuxSessionName,
            '-c',
            worktreeDir,
            '--',
            process.execPath,
            ...newArgs,
          ],
          { cwd: worktreeDir, env: tmuxEnv },
        )

        // Switch to the new session
        spawnSync('tmux', ['switch-client', '-t', tmuxSessionName], {
          stdio: 'inherit',
        })
      }
    } else {
      // Not in tmux - create and attach (original behavior)
      const tmuxArgs = [
        ...tmuxGlobalArgs,
        'new-session',
        '-A', // Attach if exists, create if not
        '-s',
        tmuxSessionName,
        '-c',
        worktreeDir,
        '--', // Separator before command
        process.execPath,
        ...newArgs,
      ]

      spawnSync('tmux', tmuxArgs, {
        stdio: 'inherit',
        cwd: worktreeDir,
        env: tmuxEnv,
      })
    }
  }

  return { handled: true }
}
