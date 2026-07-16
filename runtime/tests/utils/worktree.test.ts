import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'

import {
  _resetGitWorktreeMutationLocksForTesting,
  copyWorktreeIncludeFiles,
  withGitWorktreeMutationLock,
} from '../../src/utils/worktree.ts'

afterEach(() => {
  _resetGitWorktreeMutationLocksForTesting()
})

test('withGitWorktreeMutationLock serializes mutations for the same repo', async () => {
  const order: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve
  })

  const first = withGitWorktreeMutationLock('/repo', async () => {
    order.push('first:start')
    await firstGate
    order.push('first:end')
  })

  const second = withGitWorktreeMutationLock('/repo', async () => {
    order.push('second:start')
    order.push('second:end')
  })

  await Promise.resolve()
  await Promise.resolve()
  expect(order).toEqual(['first:start'])

  releaseFirst()
  await Promise.all([first, second])

  expect(order).toEqual([
    'first:start',
    'first:end',
    'second:start',
    'second:end',
  ])
})

test('withGitWorktreeMutationLock does not serialize different repos', async () => {
  const order: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve
  })

  const first = withGitWorktreeMutationLock('/repo-a', async () => {
    order.push('a:start')
    await firstGate
    order.push('a:end')
  })

  const second = withGitWorktreeMutationLock('/repo-b', async () => {
    order.push('b:start')
    order.push('b:end')
  })

  await Promise.resolve()
  await Promise.resolve()
  expect(order).toEqual(['a:start', 'b:start', 'b:end'])

  releaseFirst()
  await Promise.all([first, second])
})

test('repository .worktreeinclude cannot copy gitignored secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agenc-worktree-boundary-'))
  const repo = join(root, 'repo')
  const worktree = join(root, 'worktree')
  mkdirSync(join(repo, 'secrets'), { recursive: true })
  mkdirSync(worktree, { recursive: true })
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
  writeFileSync(join(repo, '.gitignore'), 'secrets/\n')
  writeFileSync(join(repo, '.worktreeinclude'), 'secrets/api.key\n')
  writeFileSync(join(repo, 'secrets', 'api.key'), 'do-not-copy')
  execFileSync('git', ['add', '.gitignore', '.worktreeinclude'], {
    cwd: repo,
    stdio: 'ignore',
  })

  try {
    await expect(copyWorktreeIncludeFiles(repo, worktree)).resolves.toEqual([])
    expect(existsSync(join(worktree, 'secrets', 'api.key'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
