import type { ReactElement, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

type CommandResultOptions = {
  readonly display?: string
}

type WorktreeSession = {
  readonly originalCwd: string
  readonly originalHeadCommit: string
  readonly sessionId: string
  readonly tmuxSessionName?: string
  readonly worktreeBranch: string
  readonly worktreeName: string
  readonly worktreePath: string
}

type SelectProps = {
  readonly defaultFocusValue?: string
  readonly onChange: (value: string) => void | Promise<void>
  readonly options: Array<{
    readonly description?: string
    readonly label: string
    readonly value: string
  }>
}

type DialogElementProps = {
  readonly children: ReactElement<SelectProps>
  readonly onCancel: () => void
  readonly subtitle?: ReactNode
  readonly title: ReactNode
}

const harness = vi.hoisted(() => ({
  cleanupWorktree: vi.fn(),
  clearPlansCache: vi.fn(),
  execFileNoThrow: vi.fn(),
  keepWorktree: vi.fn(),
  killTmuxSession: vi.fn(),
  logForDebugging: vi.fn(),
  saveWorktreeState: vi.fn(),
  session: {
    originalCwd: '/workspace/main',
    originalHeadCommit: 'abc123',
    sessionId: 'session-1',
    worktreeBranch: 'feature/clean-worktree',
    worktreeName: 'clean-worktree',
    worktreePath: '/workspace/.agenc/worktrees/clean-worktree',
  } as WorktreeSession | null,
  setChanges: vi.fn(),
  setCommitCount: vi.fn(),
  setCwd: vi.fn(),
  setInspectionFailed: vi.fn(),
  setResultMessage: vi.fn(),
  setStatus: vi.fn(),
  useEffect: vi.fn(),
  useState: vi.fn(),
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')

  return {
    ...actual,
    useEffect: harness.useEffect,
    useState: harness.useState,
  }
})

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('src/utils/debug.js', () => ({
  logForDebugging: harness.logForDebugging,
}))

vi.mock('src/utils/execFileNoThrow.js', () => ({
  execFileNoThrow: harness.execFileNoThrow,
}))

vi.mock('src/utils/plans.js', () => {
  const getPlansDirectory = () => '/workspace/.agenc/plans'
  ;(
    getPlansDirectory as typeof getPlansDirectory & {
      cache: { clear: () => void }
    }
  ).cache = { clear: harness.clearPlansCache }

  return { getPlansDirectory }
})

vi.mock('src/utils/Shell.js', () => ({
  setCwd: harness.setCwd,
}))

vi.mock('src/utils/sessionStorage.js', () => ({
  saveWorktreeState: harness.saveWorktreeState,
  writeAgentMetadata: vi.fn(async () => undefined),
}))

vi.mock('src/utils/worktree.js', () => ({
  cleanupWorktree: harness.cleanupWorktree,
  getCurrentWorktreeSession: () => harness.session,
  keepWorktree: harness.keepWorktree,
  killTmuxSession: harness.killTmuxSession,
}))

vi.mock('../../../src/tui/components/CustomSelect/select.js', () => ({
  Select: () => null,
}))

vi.mock('../../../src/tui/components/design-system/Dialog.js', () => ({
  Dialog: () => null,
}))

vi.mock('../../../src/tui/components/spinner/Spinner.js', () => ({
  Spinner: () => null,
}))

function seedDialogState(): void {
  const states: Array<readonly [unknown, (value: unknown) => void]> = [
    ['asking', harness.setStatus],
    [[], harness.setChanges],
    [0, harness.setCommitCount],
    [undefined, harness.setResultMessage],
    [false, harness.setInspectionFailed],
  ]
  let index = 0

  harness.useState.mockImplementation(() => {
    const state = states[index]
    index += 1
    if (!state) throw new Error('Unexpected WorktreeExitDialog state slot')
    return state
  })
}

async function callDialog(): Promise<ReactElement<DialogElementProps>> {
  const { WorktreeExitDialog } = await import(
    '../../../src/tui/components/WorktreeExitDialog.js'
  )

  return WorktreeExitDialog({
    onDone: (_result?: string, _options?: CommandResultOptions) => {},
  }) as ReactElement<DialogElementProps>
}

describe('WorktreeExitDialog coverage swarm row 187', () => {
  let chdirSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    harness.cleanupWorktree.mockReset().mockResolvedValue(undefined)
    harness.clearPlansCache.mockClear()
    harness.execFileNoThrow.mockReset()
    harness.keepWorktree.mockReset().mockResolvedValue(undefined)
    harness.killTmuxSession.mockReset().mockResolvedValue(undefined)
    harness.logForDebugging.mockClear()
    harness.saveWorktreeState.mockClear()
    harness.setChanges.mockClear()
    harness.setCommitCount.mockClear()
    harness.setCwd.mockClear()
    harness.setInspectionFailed.mockClear()
    harness.setResultMessage.mockClear()
    harness.setStatus.mockClear()
    harness.session = {
      originalCwd: '/workspace/main',
      originalHeadCommit: 'abc123',
      sessionId: 'session-1',
      worktreeBranch: 'feature/clean-worktree',
      worktreeName: 'clean-worktree',
      worktreePath: '/workspace/.agenc/worktrees/clean-worktree',
    }
    harness.useEffect.mockReset()
    harness.useState.mockReset()
    seedDialogState()
    chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => undefined)
  })

  afterEach(() => {
    chdirSpy.mockRestore()
    vi.resetModules()
  })

  test('renders the clean asking branch and reports clean manual removal', async () => {
    const dialog = await callDialog()

    expect(dialog.props.title).toBe('Exiting worktree session')
    expect(dialog.props.subtitle).toBe(
      'You are working in a worktree. Keep it to continue working there, or remove it to clean up.',
    )
    expect(dialog.props.children.props).toMatchObject({
      defaultFocusValue: 'keep',
      options: [
        {
          description:
            'Stays at /workspace/.agenc/worktrees/clean-worktree',
          label: 'Keep worktree',
          value: 'keep',
        },
        {
          description: 'Clean up the worktree directory.',
          label: 'Remove worktree',
          value: 'remove',
        },
      ],
    })

    await dialog.props.children.props.onChange('remove')

    expect(harness.killTmuxSession).not.toHaveBeenCalled()
    expect(harness.cleanupWorktree).toHaveBeenCalledOnce()
    expect(chdirSpy).toHaveBeenCalledWith('/workspace/main')
    expect(harness.setCwd).toHaveBeenCalledWith('/workspace/main')
    expect(harness.saveWorktreeState).toHaveBeenCalledWith(null)
    expect(harness.clearPlansCache).toHaveBeenCalledOnce()
    expect(harness.setResultMessage).toHaveBeenCalledWith('Worktree removed.')
    expect(harness.setStatus).toHaveBeenLastCalledWith('done')
  })
})
