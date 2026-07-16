import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

type CapturedDialogProps = {
  children: React.ReactNode
  onCancel: () => void
  subtitle?: React.ReactNode
  title: React.ReactNode
}

type CapturedSelectProps = {
  defaultFocusValue?: string
  onChange?: (value: string) => void | Promise<void>
  options: Array<{
    description?: string
    label: React.ReactNode
    value: string
  }>
}

type WorktreeSession = {
  originalCwd: string
  originalHeadCommit?: string
  sessionId: string
  tmuxSessionName?: string
  worktreeBranch?: string
  worktreeName: string
  worktreePath: string
}

const harness = vi.hoisted(() => ({
  chdir: vi.fn(),
  cleanupWorktree: vi.fn(),
  clearPlansCache: vi.fn(),
  dialogProps: undefined as CapturedDialogProps | undefined,
  execFileNoThrow: vi.fn(),
  keepWorktree: vi.fn(),
  killTmuxSession: vi.fn(),
  logForDebugging: vi.fn(),
  saveWorktreeState: vi.fn(),
  selectProps: undefined as CapturedSelectProps | undefined,
  session: null as WorktreeSession | null,
  setCwd: vi.fn(),
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('src/utils/debug.js', () => ({
  logForDebugging: harness.logForDebugging,
}))

vi.mock('../../utils/debug.js', () => ({
  logForDebugging: harness.logForDebugging,
}))

vi.mock('../../utils/execFileNoThrow.js', () => ({
  execFileNoThrow: harness.execFileNoThrow,
}))

vi.mock('../../utils/plans.js', () => {
  const getPlansDirectory = () => '/tmp/agenc-plans'
  ;(
    getPlansDirectory as typeof getPlansDirectory & {
      cache: { clear: () => void }
    }
  ).cache = { clear: harness.clearPlansCache }

  return { getPlansDirectory }
})

vi.mock('../../utils/Shell.js', () => ({
  setCwd: harness.setCwd,
}))

vi.mock('../../utils/sessionStorage', () => ({
  saveWorktreeState: harness.saveWorktreeState,
  writeAgentMetadata: vi.fn(async () => undefined),
}))

vi.mock('../../utils/sessionStorage.js', () => ({
  saveWorktreeState: harness.saveWorktreeState,
  writeAgentMetadata: vi.fn(async () => undefined),
}))

vi.mock('../../utils/worktree.js', () => ({
  cleanupWorktree: harness.cleanupWorktree,
  getCurrentWorktreeSession: () => harness.session,
  keepWorktree: harness.keepWorktree,
  killTmuxSession: harness.killTmuxSession,
}))

vi.mock('./spinner/Spinner.js', () => ({
  Spinner: () => null,
}))

vi.mock('./design-system/Dialog', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react')
  const { Box, Text } =
    await vi.importActual<typeof import('../ink.js')>('../ink.js')

  return {
    Dialog: (props: CapturedDialogProps) => {
      harness.dialogProps = props
      return ReactModule.createElement(
        Box,
        { flexDirection: 'column' },
        ReactModule.createElement(Text, null, props.title),
        props.subtitle
          ? ReactModule.createElement(Text, null, props.subtitle)
          : null,
        props.children,
      )
    },
  }
})

vi.mock('./CustomSelect/select', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react')
  const { Box, Text } =
    await vi.importActual<typeof import('../ink.js')>('../ink.js')

  return {
    Select: (props: CapturedSelectProps) => {
      harness.selectProps = props
      return ReactModule.createElement(
        Box,
        { flexDirection: 'column' },
        ReactModule.createElement(
          Text,
          { key: 'focus' },
          `focus:${props.defaultFocusValue ?? ''}`,
        ),
        ...props.options.map(option =>
          ReactModule.createElement(
            Text,
            { key: option.value },
            `${option.label} ${option.description ?? ''}`,
          ),
        ),
      )
    },
  }
})

import { createRoot } from '../ink/root.js'
import { renderToString } from '../../utils/staticRender.js'
import { WorktreeExitDialog } from './WorktreeExitDialog.js'

function baseSession(
  overrides: Partial<WorktreeSession> = {},
): WorktreeSession {
  return {
    originalCwd: '/workspace/main',
    originalHeadCommit: 'abc123',
    sessionId: 'session-1',
    worktreeBranch: 'agenc/worktree-test',
    worktreeName: 'worktree-test',
    worktreePath: '/workspace/.agenc/worktrees/worktree-test',
    ...overrides,
  }
}

function mockGitState({
  commitCount,
  statusLines,
}: {
  commitCount: number
  statusLines: string[]
}) {
  harness.execFileNoThrow.mockImplementation(
    async (file: string, args: string[]) => {
      expect(file).toBe('git')

      if (args[0] === 'status') {
        expect(args).toEqual(['status', '--porcelain'])
        return {
          code: 0,
          stderr: '',
          stdout:
            statusLines.length > 0 ? `${statusLines.join('\n')}\n` : '',
        }
      }

      if (args[0] === 'rev-list') {
        expect(args).toEqual([
          'rev-list',
          '--count',
          `${harness.session?.originalHeadCommit}..HEAD`,
        ])
        return { code: 0, stderr: '', stdout: `${commitCount}\n` }
      }

      throw new Error(`Unexpected execFileNoThrow call: ${file} ${args.join(' ')}`)
    },
  )
}

function createStreams(): {
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  stdout: PassThrough
  output: () => string
} {
  let rendered = ''
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    rendered += chunk.toString()
  })
  ;(stdout as unknown as { columns: number; rows: number }).columns = 120
  ;(stdout as unknown as { columns: number; rows: number }).rows = 30
  stdout.resume()

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  return {
    stdin,
    stdout,
    output: () => stripAnsi(rendered),
  }
}

async function sleep(ms = 0): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await sleep(10)
  }

  throw new Error(message)
}

function deferred<T = void>(): {
  promise: Promise<T>
  reject: (reason?: unknown) => void
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })

  return { promise, reject, resolve }
}

async function mountDialog(props: {
  onCancel?: () => void
  onDone?: (result?: string, options?: { display?: string }) => void
} = {}) {
  const onDone = props.onDone ?? vi.fn()
  const { stdin, stdout, output } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  root.render(
    <WorktreeExitDialog onCancel={props.onCancel} onDone={onDone} />,
  )

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(25)
    },
    onDone,
    output,
  }
}

async function mountAskingDialog({
  commitCount,
  onCancel,
  statusLines,
}: {
  commitCount: number
  onCancel?: () => void
  statusLines: string[]
}) {
  harness.session = baseSession()
  mockGitState({ commitCount, statusLines })

  const mounted = await mountDialog({ onCancel })
  await waitFor(
    () => harness.selectProps !== undefined,
    'WorktreeExitDialog did not render choices',
  )

  return mounted
}

function selectProps(): CapturedSelectProps {
  if (!harness.selectProps) {
    throw new Error('Select props were not captured')
  }

  return harness.selectProps
}

function dialogProps(): CapturedDialogProps {
  if (!harness.dialogProps) {
    throw new Error('Dialog props were not captured')
  }

  return harness.dialogProps
}

describe('WorktreeExitDialog', () => {
  let chdirSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    harness.chdir.mockClear()
    harness.cleanupWorktree.mockReset()
    harness.cleanupWorktree.mockResolvedValue(undefined)
    harness.clearPlansCache.mockClear()
    harness.dialogProps = undefined
    harness.execFileNoThrow.mockReset()
    harness.keepWorktree.mockReset()
    harness.keepWorktree.mockResolvedValue(undefined)
    harness.killTmuxSession.mockReset()
    harness.killTmuxSession.mockResolvedValue(true)
    harness.logForDebugging.mockClear()
    harness.saveWorktreeState.mockClear()
    harness.selectProps = undefined
    harness.session = null
    harness.setCwd.mockClear()

    chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(directory => {
      harness.chdir(directory)
    })
  })

  afterEach(() => {
    chdirSpy.mockRestore()
  })

  it('finishes with a system result when no worktree session is active', async () => {
    const onDone = vi.fn()
    harness.execFileNoThrow.mockResolvedValue({
      code: 0,
      stderr: '',
      stdout: '',
    })

    await renderToString(<WorktreeExitDialog onDone={onDone} />, 100)

    expect(onDone).toHaveBeenCalledWith('No active worktree session found', {
      display: 'system',
    })
  })

  it('auto-removes a clean worktree before finishing', async () => {
    const cleanup = deferred()
    harness.session = baseSession()
    harness.cleanupWorktree.mockReturnValue(cleanup.promise)
    mockGitState({ commitCount: 0, statusLines: [] })

    const mounted = await mountDialog()

    await waitFor(
      () => mounted.output().includes('Removing worktree...'),
      'clean worktree did not render removing state',
    )

    cleanup.resolve(undefined)
    await waitFor(
      () => mounted.onDone.mock.calls.length > 0,
      'clean worktree did not finish',
    )

    expect(harness.cleanupWorktree).toHaveBeenCalledOnce()
    expect(harness.chdir).toHaveBeenCalledWith('/workspace/main')
    expect(harness.setCwd).toHaveBeenCalledWith('/workspace/main')
    expect(harness.saveWorktreeState).toHaveBeenCalledWith(null)
    expect(harness.clearPlansCache).toHaveBeenCalledOnce()
    expect(mounted.onDone).toHaveBeenCalledWith('Worktree removed (no changes)')
    expect(harness.selectProps).toBeUndefined()

    await mounted.dispose()
  })

  it('reports a clean-worktree cleanup failure and exits anyway', async () => {
    harness.session = baseSession()
    harness.cleanupWorktree.mockRejectedValue(new Error('remove failed'))
    mockGitState({ commitCount: 0, statusLines: [] })

    const mounted = await mountDialog()

    await waitFor(
      () => mounted.onDone.mock.calls.length > 0,
      'cleanup failure did not finish',
    )

    expect(harness.logForDebugging).toHaveBeenCalledWith(
      expect.stringContaining('Failed to clean up worktree: Error: remove failed'),
      { level: 'error' },
    )
    expect(mounted.onDone).toHaveBeenCalledWith(
      'Worktree cleanup failed, exiting anyway',
    )

    await mounted.dispose()
  })

  it.each([
    {
      failedCommand: 'status',
      mockGit: () => {
        harness.execFileNoThrow.mockImplementation(
          async (file: string, args: string[]) => {
            expect(file).toBe('git')
            if (args[0] === 'status') {
              return {
                code: 128,
                error: 'not a git repository',
                stderr: 'fatal: not a git repository',
                stdout: '',
              }
            }
            if (args[0] === 'rev-list') {
              return { code: 0, stderr: '', stdout: '0\n' }
            }
            throw new Error(
              `Unexpected execFileNoThrow call: ${file} ${args.join(' ')}`,
            )
          },
        )
      },
    },
    {
      failedCommand: 'rev-list',
      mockGit: () => {
        harness.execFileNoThrow.mockImplementation(
          async (file: string, args: string[]) => {
            expect(file).toBe('git')
            if (args[0] === 'status') {
              return { code: 0, stderr: '', stdout: '' }
            }
            if (args[0] === 'rev-list') {
              return {
                code: 128,
                error: 'bad revision',
                stderr: 'fatal: bad revision',
                stdout: '',
              }
            }
            throw new Error(
              `Unexpected execFileNoThrow call: ${file} ${args.join(' ')}`,
            )
          },
        )
      },
    },
  ])(
    'fails closed instead of auto-removing when $failedCommand inspection fails',
    async ({ mockGit }) => {
      harness.session = baseSession()
      mockGit()

      const mounted = await mountDialog()
      await waitFor(
        () =>
          harness.selectProps !== undefined ||
          harness.cleanupWorktree.mock.calls.length > 0,
        'inspection failure did not settle',
      )

      expect(harness.cleanupWorktree).not.toHaveBeenCalled()
      expect(harness.logForDebugging).toHaveBeenCalledWith(
        expect.stringContaining('Failed to inspect worktree status:'),
        { level: 'error' },
      )
      expect(harness.selectProps).toBeDefined()
      expect(dialogProps().subtitle).toBe(
        'Unable to inspect worktree status. Keep the worktree unless you have verified it is safe to remove.',
      )
      expect(selectProps().defaultFocusValue).toBe('keep')

      await mounted.dispose()
    },
  )

  it('fails closed instead of auto-removing when the baseline commit is missing', async () => {
    harness.session = baseSession({ originalHeadCommit: undefined })
    harness.execFileNoThrow.mockImplementation(
      async (file: string, args: string[]) => {
        expect(file).toBe('git')
        if (args[0] === 'status') {
          return { code: 0, stderr: '', stdout: '' }
        }
        throw new Error(
          `Unexpected execFileNoThrow call: ${file} ${args.join(' ')}`,
        )
      },
    )

    const mounted = await mountDialog()
    await waitFor(
      () => harness.selectProps !== undefined,
      'missing baseline did not render choices',
    )

    expect(harness.cleanupWorktree).not.toHaveBeenCalled()
    expect(harness.logForDebugging).toHaveBeenCalledWith(
      'Failed to inspect worktree status: missing original head commit',
      { level: 'error' },
    )
    expect(selectProps().defaultFocusValue).toBe('keep')
    expect(dialogProps().subtitle).toBe(
      'Unable to inspect worktree status. Keep the worktree unless you have verified it is safe to remove.',
    )

    await mounted.dispose()
  })

  it.each([
    {
      commitCount: 0,
      expectedSubtitle:
        'You have 1 uncommitted file. These will be lost if you remove the worktree.',
      statusLines: [' M runtime/src/tui/index.ts'],
    },
    {
      commitCount: 2,
      expectedSubtitle:
        'You have 2 commits on agenc/worktree-test. The branch will be deleted if you remove the worktree.',
      statusLines: [],
    },
    {
      commitCount: 1,
      expectedSubtitle:
        'You have 2 uncommitted files and 1 commit on agenc/worktree-test. All will be lost if you remove.',
      statusLines: [
        ' M runtime/src/tui/index.ts',
        '?? runtime/tests/tui/new.test.ts',
      ],
    },
  ])(
    'renders the prompt subtitle for $expectedSubtitle',
    async ({ commitCount, expectedSubtitle, statusLines }) => {
      const mounted = await mountAskingDialog({ commitCount, statusLines })

      expect(dialogProps().title).toBe('Exiting worktree session')
      expect(dialogProps().subtitle).toBe(expectedSubtitle)
      expect(selectProps().defaultFocusValue).toBe('keep')
      expect(selectProps().options).toEqual([
        {
          description: 'Stays at /workspace/.agenc/worktrees/worktree-test',
          label: 'Keep worktree',
          value: 'keep',
        },
        {
          description:
            commitCount > 0 || statusLines.length > 0
              ? 'All changes and commits will be lost.'
              : 'Clean up the worktree directory.',
          label: 'Remove worktree',
          value: 'remove',
        },
      ])

      await mounted.dispose()
    },
  )

  it('renders tmux-specific choices with keep-and-reattach focused', async () => {
    harness.session = baseSession({ tmuxSessionName: 'agenc-worktree-tmux' })
    mockGitState({ commitCount: 1, statusLines: [' M package.json'] })

    const mounted = await mountDialog()
    await waitFor(
      () => harness.selectProps !== undefined,
      'tmux choices did not render',
    )

    expect(selectProps().defaultFocusValue).toBe('keep-with-tmux')
    expect(selectProps().options).toEqual([
      {
        description:
          'Stays at /workspace/.agenc/worktrees/worktree-test. Reattach with: tmux attach -t agenc-worktree-tmux',
        label: 'Keep worktree and tmux session',
        value: 'keep-with-tmux',
      },
      {
        description:
          'Keeps worktree at /workspace/.agenc/worktrees/worktree-test, terminates tmux session.',
        label: 'Keep worktree, kill tmux session',
        value: 'keep-kill-tmux',
      },
      {
        description: 'All changes and commits will be lost.',
        label: 'Remove worktree and tmux session',
        value: 'remove-with-tmux',
      },
    ])

    await mounted.dispose()
  })

  it('uses the explicit cancel callback when one is provided', async () => {
    const onCancel = vi.fn()
    const mounted = await mountAskingDialog({
      commitCount: 0,
      onCancel,
      statusLines: [' M runtime/src/tui/index.ts'],
    })

    dialogProps().onCancel()

    expect(onCancel).toHaveBeenCalledOnce()
    expect(harness.keepWorktree).not.toHaveBeenCalled()

    await mounted.dispose()
  })

  it('keeps the worktree when cancel is pressed without a cancel callback', async () => {
    const mounted = await mountAskingDialog({
      commitCount: 1,
      statusLines: [],
    })

    dialogProps().onCancel()
    await waitFor(
      () => mounted.onDone.mock.calls.length > 0,
      'fallback keep did not finish',
    )

    expect(harness.keepWorktree).toHaveBeenCalledOnce()
    expect(mounted.onDone).toHaveBeenCalledWith(
      'Worktree kept. Your work is saved at /workspace/.agenc/worktrees/worktree-test on branch agenc/worktree-test',
    )

    await mounted.dispose()
  })

  it('reports keep action failures instead of rejecting the select action', async () => {
    const restoreError = new Error('original cwd vanished')
    const mounted = await mountAskingDialog({
      commitCount: 1,
      statusLines: [],
    })
    chdirSpy.mockImplementationOnce(() => {
      throw restoreError
    })

    try {
      await expect(Promise.resolve(selectProps().onChange?.('keep'))).resolves.toBeUndefined()
      await waitFor(
        () => mounted.onDone.mock.calls.length > 0,
        'keep failure did not finish',
      )

      expect(harness.logForDebugging).toHaveBeenCalledWith(
        expect.stringContaining(
          'Failed to keep worktree: Error: original cwd vanished',
        ),
        { level: 'error' },
      )
      expect(mounted.onDone).toHaveBeenCalledWith(
        'Worktree keep failed, exiting anyway',
      )
    } finally {
      await mounted.dispose()
    }
  })

  it('keeps a tmux-backed worktree and preserves the reattach instruction', async () => {
    const keep = deferred()
    harness.session = baseSession({ tmuxSessionName: 'agenc-worktree-tmux' })
    harness.keepWorktree.mockReturnValue(keep.promise)
    mockGitState({ commitCount: 3, statusLines: [' M README.md'] })

    const mounted = await mountDialog()
    await waitFor(
      () => harness.selectProps !== undefined,
      'keep choices did not render',
    )

    const change = selectProps().onChange?.('keep-with-tmux')
    await waitFor(
      () => mounted.output().includes('Keeping worktree...'),
      'keep action did not render keeping state',
    )

    keep.resolve(undefined)
    await change
    await waitFor(
      () => mounted.onDone.mock.calls.length > 0,
      'keep action did not finish',
    )

    expect(harness.killTmuxSession).not.toHaveBeenCalled()
    expect(harness.keepWorktree).toHaveBeenCalledOnce()
    expect(harness.chdir).toHaveBeenCalledWith('/workspace/main')
    expect(harness.setCwd).toHaveBeenCalledWith('/workspace/main')
    expect(harness.saveWorktreeState).toHaveBeenCalledWith(null)
    expect(harness.clearPlansCache).toHaveBeenCalledOnce()
    expect(mounted.onDone).toHaveBeenCalledWith(
      'Worktree kept. Your work is saved at /workspace/.agenc/worktrees/worktree-test on branch agenc/worktree-test. Reattach to tmux session with: tmux attach -t agenc-worktree-tmux',
    )

    await mounted.dispose()
  })

  it('kills tmux before keeping when requested', async () => {
    harness.session = baseSession({ tmuxSessionName: 'agenc-worktree-tmux' })
    mockGitState({ commitCount: 0, statusLines: [' M README.md'] })

    const mounted = await mountDialog()
    await waitFor(
      () => harness.selectProps !== undefined,
      'keep-kill choices did not render',
    )

    await selectProps().onChange?.('keep-kill-tmux')
    await waitFor(
      () => mounted.onDone.mock.calls.length > 0,
      'keep-kill action did not finish',
    )

    expect(harness.killTmuxSession).toHaveBeenCalledWith('agenc-worktree-tmux')
    expect(harness.keepWorktree).toHaveBeenCalledOnce()
    expect(mounted.onDone).toHaveBeenCalledWith(
      'Worktree kept at /workspace/.agenc/worktrees/worktree-test on branch agenc/worktree-test. Tmux session terminated.',
    )

    await mounted.dispose()
  })

  it('reports tmux removal failures instead of rejecting the select action', async () => {
    harness.session = baseSession({ tmuxSessionName: 'agenc-worktree-tmux' })
    harness.killTmuxSession.mockRejectedValue(new Error('tmux kill failed'))
    mockGitState({ commitCount: 0, statusLines: [' M README.md'] })

    const mounted = await mountDialog()
    await waitFor(
      () => harness.selectProps !== undefined,
      'tmux remove choices did not render',
    )

    try {
      await expect(
        Promise.resolve(selectProps().onChange?.('remove-with-tmux')),
      ).resolves.toBeUndefined()
      await waitFor(
        () => mounted.onDone.mock.calls.length > 0,
        'tmux remove failure did not finish',
      )

      expect(harness.cleanupWorktree).not.toHaveBeenCalled()
      expect(harness.logForDebugging).toHaveBeenCalledWith(
        expect.stringContaining(
          'Failed to clean up worktree: Error: tmux kill failed',
        ),
        { level: 'error' },
      )
      expect(mounted.onDone).toHaveBeenCalledWith(
        'Worktree cleanup failed, exiting anyway',
      )
    } finally {
      await mounted.dispose()
    }
  })

  it('removes a tmux-backed worktree and reports discarded commits plus changes', async () => {
    const cleanup = deferred()
    harness.session = baseSession({ tmuxSessionName: 'agenc-worktree-tmux' })
    harness.cleanupWorktree.mockReturnValue(cleanup.promise)
    mockGitState({ commitCount: 2, statusLines: [' M package.json'] })

    const mounted = await mountDialog()
    await waitFor(
      () => harness.selectProps !== undefined,
      'remove choices did not render',
    )

    const change = selectProps().onChange?.('remove-with-tmux')
    await waitFor(
      () => mounted.output().includes('Removing worktree...'),
      'remove action did not render removing state',
    )

    cleanup.resolve(undefined)
    await change
    await waitFor(
      () => mounted.onDone.mock.calls.length > 0,
      'remove action did not finish',
    )

    expect(harness.killTmuxSession).toHaveBeenCalledWith('agenc-worktree-tmux')
    expect(harness.cleanupWorktree).toHaveBeenCalledOnce()
    expect(harness.chdir).toHaveBeenCalledWith('/workspace/main')
    expect(harness.setCwd).toHaveBeenCalledWith('/workspace/main')
    expect(harness.saveWorktreeState).toHaveBeenCalledWith(null)
    expect(harness.clearPlansCache).toHaveBeenCalledOnce()
    expect(mounted.onDone).toHaveBeenCalledWith(
      'Worktree removed. 2 commits and uncommitted changes were discarded. Tmux session terminated.',
    )

    await mounted.dispose()
  })

  it.each([
    {
      commitCount: 1,
      expected:
        'Worktree removed. 1 commit on agenc/worktree-test was discarded.',
      statusLines: [],
    },
    {
      commitCount: 0,
      expected: 'Worktree removed. Uncommitted changes were discarded.',
      statusLines: [' M README.md'],
    },
  ])(
    'reports the remove result for $expected',
    async ({ commitCount, expected, statusLines }) => {
      const mounted = await mountAskingDialog({ commitCount, statusLines })

      await selectProps().onChange?.('remove')
      await waitFor(
        () => mounted.onDone.mock.calls.length > 0,
        'remove action did not finish',
      )

      expect(mounted.onDone).toHaveBeenCalledWith(expected)

      await mounted.dispose()
    },
  )

  it('reports remove cleanup failures without clearing the session locally', async () => {
    harness.session = baseSession()
    harness.cleanupWorktree.mockRejectedValue(new Error('cleanup exploded'))
    mockGitState({ commitCount: 0, statusLines: [' M README.md'] })

    const mounted = await mountDialog()
    await waitFor(
      () => harness.selectProps !== undefined,
      'remove failure choices did not render',
    )

    await selectProps().onChange?.('remove')
    await waitFor(
      () => mounted.onDone.mock.calls.length > 0,
      'remove failure did not finish',
    )

    expect(harness.logForDebugging).toHaveBeenCalledWith(
      expect.stringContaining(
        'Failed to clean up worktree: Error: cleanup exploded',
      ),
      { level: 'error' },
    )
    expect(harness.chdir).not.toHaveBeenCalled()
    expect(harness.setCwd).not.toHaveBeenCalled()
    expect(harness.saveWorktreeState).not.toHaveBeenCalled()
    expect(mounted.onDone).toHaveBeenCalledWith(
      'Worktree cleanup failed, exiting anyway',
    )

    await mounted.dispose()
  })
})
