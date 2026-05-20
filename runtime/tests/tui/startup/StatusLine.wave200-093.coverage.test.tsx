import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../ink/root.js'
import { StatusLine, statusLineShouldDisplay } from './StatusLine.js'

const mocks = vi.hoisted(() => ({
  addNotification: vi.fn(),
  appState: {
    toolPermissionContext: {
      mode: 'acceptEdits',
      additionalWorkingDirectories: new Map([
        ['/workspace/packages/runtime', true],
        ['/tmp/shared-tools', true],
      ]),
    },
    statusLineText: '\u001b[32mseed-status\u001b[0m',
  } as Record<string, unknown>,
  checkHasProjectTrustAcceptedSync: vi.fn(() => false),
  doesMostRecentAssistantMessageExceed200k: vi.fn(() => true),
  executeStatusLineCommand: vi.fn(async () => 'updated-status'),
  feature: vi.fn(() => false),
  getContextWindowForModel: vi.fn(() => 200000),
  getCurrentUsage: vi.fn(() => 4096),
  getKairosActive: vi.fn(() => false),
  getRuntimeMainLoopModel: vi.fn(() => 'runtime-gpt-5'),
  logEvent: vi.fn(),
  logForDebugging: vi.fn(),
}))

vi.mock('bun:bundle', () => ({
  feature: mocks.feature,
}))

vi.mock('../../services/analytics/index.js', () => ({
  logEvent: mocks.logEvent,
}))

vi.mock('../../constants/outputStyles.js', () => ({
  DEFAULT_OUTPUT_STYLE_NAME: 'default-style',
}))

vi.mock('../rate-limits/agenc-ai-limits.js', () => ({
  getRawUtilization: () => ({
    five_hour: {
      utilization: 0.42,
      resets_at: 1710000000,
    },
    seven_day: {
      utilization: 0.7,
      resets_at: 1710500000,
    },
  }),
}))

vi.mock('../../bootstrap/state.js', () => ({
  flushInteractionTime: () => {},
  getActiveTimeCounter: () => 0,
  getIsRemoteMode: () => true,
  getKairosActive: mocks.getKairosActive,
  getMainThreadAgentType: () => 'reviewer',
  getOriginalCwd: () => '/workspace',
  getSdkBetas: () => ['context-window-beta'],
  getSessionId: () => 'session-wave-093',
  updateLastInteractionTime: () => {},
}))

vi.mock('../../cost/tracker.js', () => ({
  getTotalAPIDuration: () => 2345,
  getTotalCost: () => 1.25,
  getTotalDuration: () => 3456,
  getTotalInputTokens: () => 111,
  getTotalLinesAdded: () => 12,
  getTotalLinesRemoved: () => 5,
  getTotalOutputTokens: () => 222,
}))

vi.mock('../hooks/useMainLoopModel.js', () => ({
  useMainLoopModel: () => 'gpt-5',
}))

vi.mock('../hooks/useSettings.js', () => ({
  useSettings: () => ({
    disableAllHooks: true,
    outputStyle: 'compact',
    statusLine: { command: 'statusline --json', padding: 2 },
  }),
}))

vi.mock('../context/notifications.js', () => ({
  useNotifications: () => ({
    addNotification: mocks.addNotification,
  }),
}))

vi.mock('../../permissions/trust/project-trust.js', () => ({
  checkHasProjectTrustAcceptedSync: mocks.checkHasProjectTrustAcceptedSync,
}))

vi.mock('../../utils/config.js', () => ({
  getGlobalConfig: () => ({ tui: { vimMode: true } }),
}))

vi.mock('../../utils/context.js', () => ({
  calculateContextPercentages: () => ({ used: 2, remaining: 98 }),
  getContextWindowForModel: mocks.getContextWindowForModel,
}))

vi.mock('../../utils/cwd.js', () => ({
  getCwd: () => '/workspace/app',
}))

vi.mock('../../utils/debug.js', () => ({
  logForDebugging: mocks.logForDebugging,
}))

vi.mock('../../utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => false,
}))

vi.mock('../../utils/hooks.js', () => ({
  createBaseHookInput: () => ({
    transcript_path: '/workspace/transcript.jsonl',
  }),
  executeStatusLineCommand: mocks.executeStatusLineCommand,
}))

vi.mock('../../utils/messages.js', () => ({
  getLastAssistantMessage: (messages: Array<{ uuid?: string }>) =>
    messages.at(-1),
}))

vi.mock('../../utils/model/model.js', () => ({
  getRuntimeMainLoopModel: mocks.getRuntimeMainLoopModel,
  renderModelName: (model: string) => `Rendered ${model}`,
}))

vi.mock('../../utils/sessionStorage.js', () => ({
  getCurrentSessionTitle: () => 'Wave 093 session',
}))

vi.mock('../../utils/tokens.js', () => ({
  doesMostRecentAssistantMessageExceed200k:
    mocks.doesMostRecentAssistantMessageExceed200k,
  getCurrentUsage: mocks.getCurrentUsage,
}))

vi.mock('../../utils/worktree.js', () => ({
  getCurrentWorktreeSession: () => ({
    worktreeName: 'coverage-worker',
    worktreePath: '/workspace/worktrees/coverage-worker',
    worktreeBranch: 'coverage/statusline',
    originalCwd: '/workspace',
    originalBranch: 'main',
  }),
}))

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

function createStreams(): {
  readonly stdout: PassThrough
  readonly stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  readonly output: () => string
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

async function waitForCommand(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (mocks.executeStatusLineCommand.mock.calls.length > 0) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('StatusLine wave200-093 coverage', () => {
  beforeEach(() => {
    vi.stubGlobal('MACRO', { VERSION: '99.0.0-test' })
    mocks.addNotification.mockClear()
    mocks.appState = {
      toolPermissionContext: {
        mode: 'acceptEdits',
        additionalWorkingDirectories: new Map([
          ['/workspace/packages/runtime', true],
          ['/tmp/shared-tools', true],
        ]),
      },
      statusLineText: '\u001b[32mseed-status\u001b[0m',
    }
    mocks.checkHasProjectTrustAcceptedSync.mockClear()
    mocks.doesMostRecentAssistantMessageExceed200k.mockClear()
    mocks.executeStatusLineCommand.mockClear()
    mocks.feature.mockReset()
    mocks.feature.mockReturnValue(false)
    mocks.getContextWindowForModel.mockClear()
    mocks.getCurrentUsage.mockClear()
    mocks.getKairosActive.mockReset()
    mocks.getKairosActive.mockReturnValue(false)
    mocks.getRuntimeMainLoopModel.mockClear()
    mocks.logEvent.mockClear()
    mocks.logForDebugging.mockClear()
  })

  test('builds the rich command input and mount notices from current TUI state', async () => {
    expect(
      statusLineShouldDisplay({ statusLine: { command: 'statusline' } } as any),
    ).toBe(true)
    expect(statusLineShouldDisplay({} as any)).toBe(false)

    mocks.feature.mockReturnValue(true)
    mocks.getKairosActive.mockReturnValue(true)
    expect(
      statusLineShouldDisplay({ statusLine: { command: 'statusline' } } as any),
    ).toBe(false)
    mocks.feature.mockReturnValue(false)
    mocks.getKairosActive.mockReturnValue(false)

    const { stdin, stdout, output } = createStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(
        <StatusLine
          messagesRef={{ current: [{ uuid: 'assistant-093' }] as any[] }}
          lastAssistantMessageId="assistant-093"
          vimMode="NORMAL"
        />,
      )
      await waitForCommand()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }

    expect(output()).toContain('-- NORMAL --')
    expect(output()).toContain('seed-status')
    expect(mocks.logEvent).toHaveBeenCalledWith('agenc_status_line_mount', {
      command_length: 'statusline --json'.length,
      padding: 2,
    })
    expect(mocks.logForDebugging).toHaveBeenCalledWith(
      'Status line is configured but disableAllHooks is true',
      { level: 'warn' },
    )
    expect(mocks.addNotification).toHaveBeenCalledWith({
      key: 'statusline-trust-blocked',
      text: 'statusline skipped until project trust is accepted',
      color: 'warning',
      priority: 'low',
    })

    expect(mocks.executeStatusLineCommand).toHaveBeenCalledTimes(1)
    const [input, signal, timeout, logResult] =
      mocks.executeStatusLineCommand.mock.calls[0]!
    expect(signal.aborted).toBe(true)
    expect(timeout).toBeUndefined()
    expect(logResult).toBe(true)
    expect(input).toMatchObject({
      transcript_path: '/workspace/transcript.jsonl',
      session_name: 'Wave 093 session',
      model: {
        id: 'runtime-gpt-5',
        display_name: 'Rendered runtime-gpt-5',
      },
      workspace: {
        current_dir: '/workspace/app',
        project_dir: '/workspace',
        added_dirs: ['/workspace/packages/runtime', '/tmp/shared-tools'],
      },
      output_style: {
        name: 'compact',
      },
      cost: {
        total_cost_usd: 1.25,
        total_duration_ms: 3456,
        total_api_duration_ms: 2345,
        total_lines_added: 12,
        total_lines_removed: 5,
      },
      context_window: {
        total_input_tokens: 111,
        total_output_tokens: 222,
        context_window_size: 200000,
        current_usage: 4096,
        used_percentage: 2,
        remaining_percentage: 98,
      },
      exceeds_200k_tokens: true,
      rate_limits: {
        five_hour: {
          used_percentage: 42,
          resets_at: 1710000000,
        },
        seven_day: {
          used_percentage: 70,
          resets_at: 1710500000,
        },
      },
      vim: {
        mode: 'NORMAL',
      },
      agent: {
        name: 'reviewer',
      },
      remote: {
        session_id: 'session-wave-093',
      },
      worktree: {
        name: 'coverage-worker',
        path: '/workspace/worktrees/coverage-worker',
        branch: 'coverage/statusline',
        original_cwd: '/workspace',
        original_branch: 'main',
      },
    })
    expect(mocks.getRuntimeMainLoopModel).toHaveBeenCalledWith({
      permissionMode: 'acceptEdits',
      mainLoopModel: 'gpt-5',
      exceeds200kTokens: true,
    })
    expect(mocks.getContextWindowForModel).toHaveBeenCalledWith(
      'runtime-gpt-5',
      ['context-window-beta'],
    )
    expect(mocks.appState.statusLineText).toBe('updated-status')
  })
})
