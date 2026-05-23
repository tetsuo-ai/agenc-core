import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../ink/root.js'

const harness = vi.hoisted(() => ({
  addNotification: vi.fn(),
  appState: {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map<string, boolean>(),
    },
    statusLineText: '',
  } as Record<string, unknown>,
  checkHasProjectTrustAcceptedSync: vi.fn(() => true),
  contextPercentages: { used: 13, remaining: 87 },
  currentUsage: 130,
  doesMostRecentAssistantMessageExceed200k: vi.fn(() => false),
  executeStatusLineCommand: vi.fn(async () => 'next-status'),
  feature: vi.fn(() => false),
  fullscreenEnabled: false,
  getCwd: vi.fn(() => '/workspace/fallback'),
  getKairosActive: vi.fn(() => false),
  getMainThreadAgentType: vi.fn(() => undefined as string | undefined),
  getOriginalCwd: vi.fn(() => '/workspace/project'),
  getSessionId: vi.fn(() => 'session-133'),
  isRemoteMode: false,
  logEvent: vi.fn(),
  logForDebugging: vi.fn(),
  mainLoopModel: 'gpt-5',
  rawUtilization: {} as Record<string, unknown>,
  runtimeModel: 'runtime-gpt-5',
  sessionTitle: undefined as string | undefined,
  settings: {
    statusLine: { command: 'statusline', padding: 0 },
  } as Record<string, unknown>,
  setAppState: vi.fn(),
  vimEnabled: false,
  worktreeSession: undefined as
    | undefined
    | {
        worktreeName: string
        worktreePath: string
        worktreeBranch: string
        originalCwd: string
        originalBranch: string
      },
}))

vi.mock('bun:bundle', () => ({
  feature: harness.feature,
}))

vi.mock('../../../src/services/analytics/index.js', () => ({
  logEvent: harness.logEvent,
}))

vi.mock('../../../src/tui/rate-limits/agenc-ai-limits.js', () => ({
  getRawUtilization: () => harness.rawUtilization,
}))

vi.mock('../../../src/bootstrap/state.js', () => ({
  flushInteractionTime: () => {},
  getActiveTimeCounter: () => 0,
  getIsRemoteMode: () => harness.isRemoteMode,
  getKairosActive: harness.getKairosActive,
  getMainThreadAgentType: harness.getMainThreadAgentType,
  getOriginalCwd: harness.getOriginalCwd,
  getSdkBetas: () => ['beta-133'],
  getSessionId: harness.getSessionId,
  updateLastInteractionTime: () => {},
}))

vi.mock('../../../src/constants/outputStyles.js', () => ({
  DEFAULT_OUTPUT_STYLE_NAME: 'default-style',
}))

vi.mock('../../../src/tui/context/notifications.js', () => ({
  useNotifications: () => ({
    addNotification: harness.addNotification,
  }),
}))

vi.mock('../../../src/cost/tracker.js', () => ({
  getTotalAPIDuration: () => 3,
  getTotalCost: () => 1.33,
  getTotalDuration: () => 5,
  getTotalInputTokens: () => 8,
  getTotalLinesAdded: () => 2,
  getTotalLinesRemoved: () => 1,
  getTotalOutputTokens: () => 13,
}))

vi.mock('../../../src/tui/hooks/useMainLoopModel.js', () => ({
  useMainLoopModel: () => harness.mainLoopModel,
}))

vi.mock('../../../src/tui/hooks/useSettings.js', () => ({
  useSettings: () => harness.settings,
}))

vi.mock('../../../src/permissions/trust/project-trust.js', () => ({
  checkHasProjectTrustAcceptedSync: harness.checkHasProjectTrustAcceptedSync,
}))

vi.mock('../../../src/utils/context.js', () => ({
  calculateContextPercentages: () => harness.contextPercentages,
  getContextWindowForModel: () => 1000,
}))

vi.mock('../../../src/utils/cwd.js', () => ({
  getCwd: harness.getCwd,
}))

vi.mock('../../../src/utils/debug.js', () => ({
  logForDebugging: harness.logForDebugging,
}))

vi.mock('../../../src/utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => harness.fullscreenEnabled,
}))

vi.mock('../../../src/utils/hooks.js', () => ({
  createBaseHookInput: () => ({
    transcript_path: '/workspace/transcript.jsonl',
  }),
  executeStatusLineCommand: harness.executeStatusLineCommand,
}))

vi.mock('../../../src/utils/messages.js', () => ({
  getLastAssistantMessage: (messages: Array<{ uuid?: string }>) =>
    messages.at(-1),
}))

vi.mock('../../../src/utils/model/model.js', () => ({
  getRuntimeMainLoopModel: () => harness.runtimeModel,
  renderModelName: (model: string) => `Rendered ${model}`,
}))

vi.mock('../../../src/utils/sessionStorage.js', () => ({
  getCurrentSessionTitle: () => harness.sessionTitle,
}))

vi.mock('../../../src/utils/tokens.js', () => ({
  doesMostRecentAssistantMessageExceed200k:
    harness.doesMostRecentAssistantMessageExceed200k,
  getCurrentUsage: () => harness.currentUsage,
}))

vi.mock('../../../src/utils/worktree.js', () => ({
  getCurrentWorktreeSession: () => harness.worktreeSession,
}))

vi.mock('../../../src/tui/components/PromptInput/utils.js', () => ({
  formatVimModeIndicator: (mode?: string) => `-- ${mode ?? 'INSERT'} --`,
  isVimModeEnabled: () => harness.vimEnabled,
}))

vi.mock('../../../src/tui/state/AppState.js', () => ({
  useAppState: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(harness.appState),
  useSetAppState: () => (next: unknown) => {
    harness.setAppState(next)
    harness.appState =
      typeof next === 'function'
        ? (next as (state: Record<string, unknown>) => Record<string, unknown>)(
            harness.appState,
          )
        : (next as Record<string, unknown>)
  },
}))

import {
  StatusLine,
  statusLineShouldDisplay,
} from '../../../src/tui/startup/StatusLine.js'

function createStreams(): {
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for StatusLine update')
}

function resetHarness(): void {
  harness.addNotification.mockClear()
  harness.appState = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map<string, boolean>(),
    },
    statusLineText: '',
  }
  harness.checkHasProjectTrustAcceptedSync.mockReset()
  harness.checkHasProjectTrustAcceptedSync.mockReturnValue(true)
  harness.contextPercentages = { used: 13, remaining: 87 }
  harness.currentUsage = 130
  harness.doesMostRecentAssistantMessageExceed200k.mockReset()
  harness.doesMostRecentAssistantMessageExceed200k.mockReturnValue(false)
  harness.executeStatusLineCommand.mockReset()
  harness.executeStatusLineCommand.mockResolvedValue('next-status')
  harness.feature.mockReset()
  harness.feature.mockReturnValue(false)
  harness.fullscreenEnabled = false
  harness.getCwd.mockReset()
  harness.getCwd.mockReturnValue('/workspace/fallback')
  harness.getKairosActive.mockReset()
  harness.getKairosActive.mockReturnValue(false)
  harness.getMainThreadAgentType.mockReset()
  harness.getMainThreadAgentType.mockReturnValue(undefined)
  harness.getOriginalCwd.mockReset()
  harness.getOriginalCwd.mockReturnValue('/workspace/project')
  harness.getSessionId.mockReset()
  harness.getSessionId.mockReturnValue('session-133')
  harness.isRemoteMode = false
  harness.logEvent.mockClear()
  harness.logForDebugging.mockClear()
  harness.mainLoopModel = 'gpt-5'
  harness.rawUtilization = {}
  harness.runtimeModel = 'runtime-gpt-5'
  harness.sessionTitle = undefined
  harness.settings = {
    statusLine: { command: 'statusline', padding: 0 },
  }
  harness.setAppState.mockClear()
  harness.vimEnabled = false
  harness.worktreeSession = undefined
}

describe('StatusLine coverage swarm row 133', () => {
  beforeEach(() => {
    vi.stubGlobal('MACRO', { VERSION: '133-test' })
    resetHarness()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('display guard allows configured status lines unless Kairos is active', () => {
    expect(statusLineShouldDisplay({} as never)).toBe(false)
    expect(
      statusLineShouldDisplay({
        statusLine: { command: 'statusline' },
      } as never),
    ).toBe(true)

    harness.feature.mockReturnValue(true)
    harness.getKairosActive.mockReturnValue(false)
    expect(
      statusLineShouldDisplay({
        statusLine: { command: 'statusline' },
      } as never),
    ).toBe(true)

    harness.getKairosActive.mockReturnValue(true)
    expect(
      statusLineShouldDisplay({
        statusLine: { command: 'statusline' },
      } as never),
    ).toBe(false)
  })

  test('builds sparse command input and keeps identical status text stable', async () => {
    const stateBefore = {
      toolPermissionContext: {
        mode: 'plan',
        additionalWorkingDirectories: new Map<string, boolean>(),
      },
      statusLineText: 'same-status',
    }
    harness.appState = stateBefore
    harness.executeStatusLineCommand.mockResolvedValue('same-status')
    harness.getOriginalCwd.mockReturnValue('')

    const { stdin, stdout, output } = createStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(
        <StatusLine messagesRef={{ current: [] }} lastAssistantMessageId={null} />,
      )
      await waitFor(() => harness.setAppState.mock.calls.length === 1)
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }

    expect(output()).toContain('same-status')
    expect(harness.appState).toBe(stateBefore)
    expect(harness.checkHasProjectTrustAcceptedSync).toHaveBeenCalledWith({
      cwd: '/workspace/fallback',
    })

    const [input, signal, timeout, logResult] =
      harness.executeStatusLineCommand.mock.calls[0]!
    expect(signal.aborted).toBe(true)
    expect(timeout).toBeUndefined()
    expect(logResult).toBe(true)
    expect(input).toMatchObject({
      transcript_path: '/workspace/transcript.jsonl',
      model: {
        id: 'runtime-gpt-5',
        display_name: 'Rendered runtime-gpt-5',
      },
      workspace: {
        current_dir: '/workspace/fallback',
        project_dir: '',
        added_dirs: [],
      },
      version: '133-test',
      output_style: {
        name: 'default-style',
      },
      cost: {
        total_cost_usd: 1.33,
        total_duration_ms: 5,
        total_api_duration_ms: 3,
        total_lines_added: 2,
        total_lines_removed: 1,
      },
      context_window: {
        total_input_tokens: 8,
        total_output_tokens: 13,
        context_window_size: 1000,
        current_usage: 130,
        used_percentage: 13,
        remaining_percentage: 87,
      },
      exceeds_200k_tokens: false,
    })
    expect(input).not.toHaveProperty('session_name')
    expect(input).not.toHaveProperty('rate_limits')
    expect(input).not.toHaveProperty('vim')
    expect(input).not.toHaveProperty('agent')
    expect(input).not.toHaveProperty('remote')
    expect(input).not.toHaveProperty('worktree')
  })

  test('reruns with result logging when the status line command changes', async () => {
    const messages = [{ uuid: 'assistant-133' }]
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(
        <StatusLine
          messagesRef={{ current: messages }}
          lastAssistantMessageId={null}
        />,
      )
      await waitFor(() => harness.executeStatusLineCommand.mock.calls.length === 1)

      harness.settings = {
        statusLine: { command: 'statusline --changed', padding: 1 },
      }
      root.render(
        <StatusLine
          messagesRef={{ current: messages }}
          lastAssistantMessageId={null}
        />,
      )
      await waitFor(() => harness.executeStatusLineCommand.mock.calls.length === 2)
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }

    expect(harness.doesMostRecentAssistantMessageExceed200k).toHaveBeenCalledOnce()
    expect(harness.executeStatusLineCommand.mock.calls[0]![3]).toBe(true)
    expect(harness.executeStatusLineCommand.mock.calls[1]![3]).toBe(true)
    expect(harness.logEvent).toHaveBeenCalledWith('agenc_status_line_mount', {
      command_length: 'statusline'.length,
      padding: 0,
    })
  })

  test('cancels the mount debounce when the initial status update starts', async () => {
    const messages = [{ uuid: 'assistant-before' }]
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(
        <StatusLine
          messagesRef={{ current: messages }}
          lastAssistantMessageId="assistant-before"
        />,
      )
      await waitFor(() => harness.executeStatusLineCommand.mock.calls.length === 1)
      await new Promise(resolve => setTimeout(resolve, 350))
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }

    expect(harness.executeStatusLineCommand).toHaveBeenCalledTimes(1)
    expect(harness.executeStatusLineCommand.mock.calls[0]![3]).toBe(true)
  })

  test('reports trust-blocked status lines and swallows command failures', async () => {
    harness.appState = {
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Map<string, boolean>(),
      },
      statusLineText: 'before-error',
    }
    harness.checkHasProjectTrustAcceptedSync.mockReturnValue(false)
    harness.executeStatusLineCommand.mockRejectedValue(new Error('status failed'))
    harness.settings = {
      disableAllHooks: true,
      statusLine: { command: 'statusline --failing', padding: 4 },
    }

    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(
        <StatusLine messagesRef={{ current: [] }} lastAssistantMessageId={null} />,
      )
      await waitFor(() => harness.executeStatusLineCommand.mock.calls.length === 1)
      await new Promise(resolve => setTimeout(resolve, 0))
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }

    expect(harness.appState.statusLineText).toBe('before-error')
    expect(harness.setAppState).not.toHaveBeenCalled()
    expect(harness.addNotification).toHaveBeenCalledWith({
      key: 'statusline-trust-blocked',
      text: 'statusline skipped until project trust is accepted',
      color: 'warning',
      priority: 'low',
    })
    expect(harness.logForDebugging).toHaveBeenCalledWith(
      'Status line is configured but disableAllHooks is true',
      { level: 'warn' },
    )
    expect(harness.logForDebugging).toHaveBeenCalledWith(
      'Status line command skipped: workspace trust not accepted',
      { level: 'warn' },
    )
  })
})
