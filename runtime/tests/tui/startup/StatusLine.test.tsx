import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../ink/root.js'
import { TEST_REMOTE_AUTH_SESSION_CONTEXT } from '../remoteAuthSessionContext.fixture.js'
import { StatusLine } from './StatusLine.js'
import { SessionUsageContext } from '../context/sessionUsageContext.js'
import { StatusLineExecutionContext, type DaemonStatusLineExecutor } from '../context/statusLineExecutionContext.js'

const mocks = vi.hoisted(() => ({
  appState: {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
    },
    statusLineText: '',
  } as Record<string, unknown>,
  executeStatusLineCommand: vi.fn(async () => 'custom-status'),
  getTotalCost: vi.fn(() => 9),
  addNotification: vi.fn(),
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../constants/outputStyles.js', () => ({
  DEFAULT_OUTPUT_STYLE_NAME: 'default',
}))

vi.mock('src/utils/debug.js', () => ({
  logForDebugging: () => {},
}))

vi.mock('../../bootstrap/state.js', () => ({
  flushInteractionTime: () => {},
  getIsRemoteMode: () => false,
  getKairosActive: () => false,
  getMainThreadAgentType: () => undefined,
  getOriginalCwd: () => '/workspace',
  getSessionId: () => 'session-statusline-test',
  updateLastInteractionTime: () => {},
}))

vi.mock('../../cost/tracker.js', () => ({
  getTotalAPIDuration: () => 0,
  getTotalCost: mocks.getTotalCost,
  getTotalDuration: () => 0,
  getTotalInputTokens: () => 0,
  getTotalLinesAdded: () => 0,
  getTotalLinesRemoved: () => 0,
  getTotalOutputTokens: () => 0,
}))

vi.mock('../hooks/useMainLoopModel.js', () => ({
  useMainLoopModel: () => 'gpt-5',
}))

vi.mock('../hooks/useSettings.js', () => ({
  useSettings: () => ({
    statusLine: { command: 'statusline', padding: 0 },
  }),
}))

vi.mock('../context/notifications.js', () => ({
  useNotifications: () => ({
    addNotification: mocks.addNotification,
  }),
}))

vi.mock('../../permissions/trust/project-trust.js', () => ({
  checkHasProjectTrustAcceptedSync: () => true,
}))

vi.mock('../../utils/config.js', () => ({
  getRuntimeState: () => ({ tui: { vimMode: true } }),
}))

vi.mock('../../utils/settings/canonicalAuthority.js', () => ({
  getCanonicalSettingsAuthority: () => ({
    current: () => ({ tui: { vimMode: true } }),
  }),
}))

vi.mock('../../utils/context.js', () => ({
  calculateContextPercentages: () => ({ used: 0, remaining: 100 }),
  getContextWindowForModelForContext: () => 100000,
}))

vi.mock('../../utils/cwd.js', () => ({
  getCwd: () => '/workspace',
}))

vi.mock('../../utils/debug.js', () => ({
  logForDebugging: () => {},
}))

vi.mock('../context/fullscreenModeContext.js', () => ({
  useFullscreenMode: () => false,
}))

vi.mock('../../utils/hooks.js', () => ({
  createBaseHookInput: () => ({}),
  executeStatusLineCommand: mocks.executeStatusLineCommand,
}))

vi.mock('../../utils/messages.js', () => ({
  getLastAssistantMessage: () => null,
}))

vi.mock('../../utils/model/model.js', () => ({
  renderModelName: (model: string) => model,
}))

vi.mock('../../utils/sessionStorage.js', () => ({
  getCurrentSessionTitle: () => undefined,
}))

vi.mock('../../utils/tokens.js', () => ({
  doesMostRecentAssistantMessageExceed200k: () => false,
  getCurrentUsage: () => 0,
}))

vi.mock('../../utils/worktree.js', () => ({
  getCurrentWorktreeSession: () => undefined,
}))

vi.mock('../ink.js', async importOriginal => {
  return await importOriginal<typeof import('../ink.js')>()
})

vi.mock('../state/AppState.js', () => ({
  useAppState: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(mocks.appState),
  useSetAppState: () => (next: unknown) => {
    mocks.appState =
      typeof next === 'function'
        ? (next as (state: Record<string, unknown>) => Record<string, unknown>)(
            mocks.appState,
          )
        : (next as Record<string, unknown>)
  },
}))

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  output: () => string
} {
  let rendered = ''
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    rendered += chunk.toString()
  })
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.resume()

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}

  return { stdout, stdin, output: () => rendered }
}

describe('StatusLine vim mode display', () => {
  afterEach(() => vi.unstubAllGlobals())
  beforeEach(() => {
    vi.stubGlobal('MACRO', { VERSION: '99.0.0-test' })
    mocks.appState = {
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Map(),
      },
      statusLineText: '',
    }
    mocks.executeStatusLineCommand.mockClear()
    mocks.getTotalCost.mockClear()
    mocks.addNotification.mockClear()
  })

  test.each(['NORMAL', 'INSERT'] as const)(
    'renders current %s vim mode when vim mode is active',
    async vimMode => {
      const { stdout, stdin, output } = createTestStreams()
      const root = await createRoot({
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        patchConsole: false,
      })

      try {
        root.render(
          <StatusLine
            messagesRef={{ current: [] }}
            lastAssistantMessageId={null}
            providerContext={TEST_REMOTE_AUTH_SESSION_CONTEXT}
            vimMode={vimMode}
          />,
        )
        await sleep(25)
      } finally {
        root.unmount()
        stdin.end()
        stdout.end()
      }

      expect(output()).toContain(`-- ${vimMode} --`)
    },
  )

  test.each([
    [{ costUsd: 0, hasUnknownCost: false }, 0, false],
    [{ costUsd: 1.25, hasUnknownCost: true }, 1.25, true],
    [null, 0, true],
  ] as const)('passes scoped cost and unknown pricing for %j', async (usage, costUsd, unknown) => {
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })
    try {
      root.render(
        <SessionUsageContext value={usage}>
          <StatusLine messagesRef={{ current: [] }} lastAssistantMessageId={null}
            providerContext={TEST_REMOTE_AUTH_SESSION_CONTEXT} />
        </SessionUsageContext>,
      )
      await sleep(25)
      expect(mocks.executeStatusLineCommand).toHaveBeenCalledWith(
        expect.objectContaining({ cost: expect.objectContaining({ total_cost_usd: costUsd, has_unknown_cost: unknown }) }),
        expect.any(AbortSignal), undefined, true,
      )
      expect(mocks.getTotalCost).not.toHaveBeenCalled()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })

  test('refreshes child-only usage changes without a new assistant message', async () => {
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })
    const statusLine = <StatusLine messagesRef={{ current: [] }} lastAssistantMessageId={null}
      providerContext={TEST_REMOTE_AUTH_SESSION_CONTEXT} />
    try {
      root.render(<SessionUsageContext value={{ costUsd: 0.25, hasUnknownCost: false }}>{statusLine}</SessionUsageContext>)
      await sleep(25)
      mocks.executeStatusLineCommand.mockClear()
      root.render(<SessionUsageContext value={{ costUsd: 0.75, hasUnknownCost: true }}>{statusLine}</SessionUsageContext>)
      await sleep(350)
      expect(mocks.executeStatusLineCommand).toHaveBeenCalledWith(
        expect.objectContaining({ cost: expect.objectContaining({ total_cost_usd: 0.75, has_unknown_cost: true }) }),
        expect.any(AbortSignal), undefined, expect.any(Boolean),
      )
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })

  test('executes only the daemon command with presentation, never local identity or cost', async () => {
    const execute = vi.fn<DaemonStatusLineExecutor>(async () => ({ status: 'rendered', text: 'daemon-status' }))
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({ stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false })
    try {
      root.render(<StatusLineExecutionContext value={execute}>
        <StatusLine messagesRef={{ current: [] }} lastAssistantMessageId={null}
          providerContext={TEST_REMOTE_AUTH_SESSION_CONTEXT} vimMode="NORMAL" />
      </StatusLineExecutionContext>)
      await sleep(25)
      expect(execute).toHaveBeenCalledWith({ vimMode: 'NORMAL' }, expect.any(AbortSignal))
      expect(mocks.appState.statusLineText).toBe('daemon-status')
      expect(mocks.executeStatusLineCommand).not.toHaveBeenCalled()
      expect(mocks.getTotalCost).not.toHaveBeenCalled()
      expect(mocks.addNotification).not.toHaveBeenCalled()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })

  test.each(['disabled', 'blocked', 'unavailable', 'error', 'rejected'] as const)(
    'clears stale text without local fallback when daemon status is %s', async status => {
      mocks.appState.statusLineText = 'stale-status'
      const execute = vi.fn<DaemonStatusLineExecutor>(async () => {
        if (status === 'rejected') throw new Error('transport failed')
        return { status, reason: 'not_available', text: 'must-not-render' }
      })
      const { stdout, stdin } = createTestStreams()
      const root = await createRoot({ stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false })
      try {
        root.render(<StatusLineExecutionContext value={execute}>
          <StatusLine messagesRef={{ current: [] }} lastAssistantMessageId={null}
            providerContext={TEST_REMOTE_AUTH_SESSION_CONTEXT} />
        </StatusLineExecutionContext>)
        await sleep(25)
        expect(execute).toHaveBeenCalledOnce()
        expect(mocks.appState.statusLineText).toBe('')
        expect(mocks.executeStatusLineCommand).not.toHaveBeenCalled()
      } finally {
        root.unmount()
        stdin.end()
        stdout.end()
      }
    },
  )

  test('cancels superseded daemon renders and ignores late settlement after unmount', async () => {
    let resolvePrevious: ((value: { status: 'rendered'; text: string }) => void) | undefined
    const previous = vi.fn<DaemonStatusLineExecutor>(() => new Promise(resolve => { resolvePrevious = resolve }))
    let currentSignal: AbortSignal | undefined
    const current = vi.fn<DaemonStatusLineExecutor>(async (_presentation, signal) => {
      currentSignal = signal
      return { status: 'rendered', text: 'current-session' }
    })
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({ stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false })
    const child = <StatusLine messagesRef={{ current: [] }} lastAssistantMessageId={null}
      providerContext={TEST_REMOTE_AUTH_SESSION_CONTEXT} />
    try {
      root.render(<StatusLineExecutionContext value={previous}>{child}</StatusLineExecutionContext>)
      await sleep(25)
      const previousSignal = previous.mock.calls[0]?.[1]
      expect(previousSignal?.aborted).toBe(false)
      root.render(<StatusLineExecutionContext value={current}>{child}</StatusLineExecutionContext>)
      await sleep(25)
      expect(previousSignal?.aborted).toBe(true)
      expect(mocks.appState.statusLineText).toBe('current-session')
      root.unmount()
      expect(currentSignal?.aborted).toBe(true)
      resolvePrevious?.({ status: 'rendered', text: 'stale-session' })
      await sleep(10)
      expect(mocks.appState.statusLineText).toBe('current-session')
      expect(mocks.executeStatusLineCommand).not.toHaveBeenCalled()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })

  test('refreshes the daemon on child cost settlement with no assistant-message change', async () => {
    const execute = vi.fn<DaemonStatusLineExecutor>(async () => ({ status: 'rendered', text: 'aggregate' }))
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({ stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false })
    const child = <StatusLine messagesRef={{ current: [] }} lastAssistantMessageId={null}
      providerContext={TEST_REMOTE_AUTH_SESSION_CONTEXT} />
    try {
      root.render(<StatusLineExecutionContext value={execute}>
        <SessionUsageContext value={{ costUsd: 0, hasUnknownCost: false }}>{child}</SessionUsageContext>
      </StatusLineExecutionContext>)
      await sleep(25)
      expect(execute).toHaveBeenCalledOnce()
      root.render(<StatusLineExecutionContext value={execute}>
        <SessionUsageContext value={{ costUsd: 1.25, hasUnknownCost: true }}>{child}</SessionUsageContext>
      </StatusLineExecutionContext>)
      await sleep(350)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(mocks.executeStatusLineCommand).not.toHaveBeenCalled()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })

  test('never reports a stale daemon policy decision after the renderer unmounts', async () => {
    let resolve: ((value: { status: 'blocked'; reason: string }) => void) | undefined
    const execute = vi.fn<DaemonStatusLineExecutor>(() => new Promise(settle => { resolve = settle }))
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({ stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false })
    try {
      root.render(<StatusLineExecutionContext value={execute}>
        <StatusLine messagesRef={{ current: [] }} lastAssistantMessageId={null}
          providerContext={TEST_REMOTE_AUTH_SESSION_CONTEXT} />
      </StatusLineExecutionContext>)
      await sleep(25)
      root.unmount()
      resolve?.({ status: 'blocked', reason: 'untrusted_workspace' })
      await sleep(10)
      expect(execute.mock.calls[0]?.[1]?.aborted).toBe(true)
      expect(mocks.addNotification).not.toHaveBeenCalled()
      expect(mocks.executeStatusLineCommand).not.toHaveBeenCalled()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })

  test('waits for the previous daemon process to drain without blanking the current status', async () => {
    mocks.appState.statusLineText = 'last-valid-status'
    const execute = vi.fn<DaemonStatusLineExecutor>()
      .mockResolvedValueOnce({ status: 'unavailable', reason: 'busy' })
      .mockResolvedValue({ status: 'rendered', text: 'drained-status' })
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({ stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false })
    try {
      root.render(<StatusLineExecutionContext value={execute}>
        <StatusLine messagesRef={{ current: [] }} lastAssistantMessageId={null}
          providerContext={TEST_REMOTE_AUTH_SESSION_CONTEXT} />
      </StatusLineExecutionContext>)
      await sleep(25)
      expect(execute).toHaveBeenCalledOnce()
      expect(mocks.appState.statusLineText).toBe('last-valid-status')
      await sleep(550)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(mocks.appState.statusLineText).toBe('drained-status')
      expect(mocks.executeStatusLineCommand).not.toHaveBeenCalled()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })

  test('stops the bounded busy retry when the status line unmounts', async () => {
    const execute = vi.fn<DaemonStatusLineExecutor>(async () => ({ status: 'unavailable', reason: 'busy' }))
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({ stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false })
    try {
      root.render(<StatusLineExecutionContext value={execute}>
        <StatusLine messagesRef={{ current: [] }} lastAssistantMessageId={null}
          providerContext={TEST_REMOTE_AUTH_SESSION_CONTEXT} />
      </StatusLineExecutionContext>)
      await sleep(25)
      root.unmount()
      await sleep(550)
      expect(execute).toHaveBeenCalledOnce()
      expect(execute.mock.calls[0]?.[1]?.aborted).toBe(true)
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })

  test('caps busy retries and keeps the last valid output', async () => {
    mocks.appState.statusLineText = 'last-valid-status'
    const execute = vi.fn<DaemonStatusLineExecutor>(async () => ({ status: 'unavailable', reason: 'busy' }))
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({ stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      root.render(<StatusLineExecutionContext value={execute}>
        <StatusLine messagesRef={{ current: [] }} lastAssistantMessageId={null}
          providerContext={TEST_REMOTE_AUTH_SESSION_CONTEXT} />
      </StatusLineExecutionContext>)
      await vi.advanceTimersByTimeAsync(5150)
      expect(execute).toHaveBeenCalledTimes(10)
      expect(mocks.appState.statusLineText).toBe('last-valid-status')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      vi.useRealTimers()
    }
  })

  test.each([
    [{ status: 'blocked', reason: 'untrusted_workspace' }, 'status line command blocked by session hook policy'],
    [{ status: 'blocked', reason: 'sandbox_policy_unexpressible' }, 'status line command blocked: the session sandbox cannot represent this policy; on Linux, provide a trusted bubblewrap directory in the session PATH and run agenc doctor'],
    [{ status: 'blocked', reason: 'sandbox_probe_failed' }, 'status line command blocked: session sandbox unavailable; run agenc doctor'],
    [{ status: 'error', reason: 'timeout' }, 'status line command timed out'],
    [{ status: 'unavailable', reason: 'unsupported_method' }, 'status line command is not supported by this daemon'],
  ] as const)('shows a static notice for daemon result %j', async (result, text) => {
    const execute = vi.fn<DaemonStatusLineExecutor>(async () => result)
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({ stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false })
    try {
      root.render(<StatusLineExecutionContext value={execute}>
        <StatusLine messagesRef={{ current: [] }} lastAssistantMessageId={null}
          providerContext={TEST_REMOTE_AUTH_SESSION_CONTEXT} />
      </StatusLineExecutionContext>)
      await sleep(25)
      expect(mocks.addNotification).toHaveBeenCalledOnce()
      expect(mocks.addNotification).toHaveBeenCalledWith(expect.objectContaining({ text }))
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })

  test('retains legacy sidecar cost when no usage context exists', async () => {
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })
    try {
      root.render(<StatusLine messagesRef={{ current: [] }} lastAssistantMessageId={null}
        providerContext={TEST_REMOTE_AUTH_SESSION_CONTEXT} />)
      await sleep(25)
      expect(mocks.executeStatusLineCommand).toHaveBeenCalledWith(
        expect.objectContaining({ cost: expect.objectContaining({ total_cost_usd: 9 }) }),
        expect.any(AbortSignal), undefined, true,
      )
      expect(mocks.getTotalCost).toHaveBeenCalled()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })
})
