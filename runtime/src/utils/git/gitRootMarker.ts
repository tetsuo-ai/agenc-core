import { readFileSync, statSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'

const GITDIR_PREFIX = 'gitdir:'

/**
 * True when `gitPath` is Git metadata: a git directory, or a `gitdir:` file
 * whose target is a git directory or a linked-worktree private dir.
 * Empty, malformed, and dangling `.git` entries are rejected.
 */
export function isValidGitMarker(gitPath: string): boolean {
  const kind = pathKind(gitPath)
  if (kind === 'directory') {
    return isGitDirectory(gitPath)
  }
  if (kind === 'file') {
    return isGitFilePointer(gitPath)
  }
  return false
}

/**
 * True when `dir` itself is a git directory and is not a checkout's `.git`.
 * Bare repos (`*.git`) match. `repo/.git` does not, so the checkout root wins.
 */
export function isBareGitDirectory(dir: string): boolean {
  return basename(dir) !== '.git' && isGitDirectory(dir)
}

function isGitDirectory(dir: string): boolean {
  return (
    pathKind(join(dir, 'HEAD')) === 'file' &&
    pathKind(join(dir, 'objects')) === 'directory' &&
    pathKind(join(dir, 'refs')) === 'directory'
  )
}

function isGitFilePointer(gitFile: string): boolean {
  try {
    const trimmed = readFileSync(gitFile, 'utf8').trim()
    if (!trimmed.startsWith(GITDIR_PREFIX)) {
      return false
    }
    const raw = trimmed.slice(GITDIR_PREFIX.length).trim()
    if (raw.length === 0) {
      return false
    }
    const target = resolve(dirname(gitFile), raw)
    return isGitDirectory(target) || isWorktreePrivateGitDir(target)
  } catch {
    return false
  }
}

function isWorktreePrivateGitDir(dir: string): boolean {
  return (
    pathKind(join(dir, 'commondir')) === 'file' &&
    pathKind(join(dir, 'gitdir')) === 'file'
  )
}

function pathKind(path: string): 'file' | 'directory' | null {
  try {
    const st = statSync(path)
    if (st.isFile()) {
      return 'file'
    }
    if (st.isDirectory()) {
      return 'directory'
    }
    return null
  } catch {
    return null
  }
}
