import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../ink/root.js'
import { TEST_REMOTE_AUTH_SESSION_CONTEXT } from '../remoteAuthSessionContext.fixture.js'
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
  hookExecutionDecision: vi.fn(() => ({
    allowed: false,
    reason: 'untrusted_workspace',
  })),
  doesMostRecentAssistantMessageExceed200k: vi.fn(() => true),
  executeStatusLineCommand: vi.fn(async () => 'updated-status'),
  feature: vi.fn(() => false),
  getContextWindowForModel: vi.fn(() => 200000),
  getCurrentUsage: vi.fn(() => 4096),
  getKairosActive: vi.fn(() => false),
  logForDebugging: vi.fn(),
}))

vi.mock('bun:bundle', () => ({
  feature: mocks.feature,
}))

vi.mock('../../constants/outputStyles.js', () => ({
  DEFAULT_OUTPUT_STYLE_NAME: 'default-style',
}))

vi.mock('../../bootstrap/state.js', () => ({
  flushInteractionTime: () => {},
  getActiveTimeCounter: () => 0,
  getIsRemoteMode: () => true,
  getKairosActive: mocks.getKairosActive,
  getMainThreadAgentType: () => 'reviewer',
  getOriginalCwd: () => '/workspace',
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

vi.mock('../../hooks/execution-authority.js', () => ({
  resolveAmbientHookExecutionDecision: mocks.hookExecutionDecision,
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
  calculateContextPercentages: () => ({ used: 2, remaining: 98 }),
  getContextWindowForModelForContext: mocks.getContextWindowForModel,
}))

vi.mock('../../utils/cwd.js', () => ({
  getCwd: () => '/workspace/app',
}))

vi.mock('../../utils/debug.js', () => ({
  logForDebugging: mocks.logForDebugging,
}))

vi.mock('../context/fullscreenModeContext.js', () => ({
  useFullscreenMode: () => false,
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
    mocks.hookExecutionDecision.mockClear()
    mocks.doesMostRecentAssistantMessageExceed200k.mockClear()
    mocks.executeStatusLineCommand.mockClear()
    mocks.feature.mockReset()
    mocks.feature.mockReturnValue(false)
    mocks.getContextWindowForModel.mockClear()
    mocks.getCurrentUsage.mockClear()
    mocks.getKairosActive.mockReset()
    mocks.getKairosActive.mockReturnValue(false)
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
          providerContext={TEST_REMOTE_AUTH_SESSION_CONTEXT}
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
    expect(mocks.logForDebugging).toHaveBeenCalledWith(
      'Status line is configured but disableAllHooks is true',
      { level: 'warn' },
    )
    expect(mocks.addNotification).toHaveBeenCalledWith({
      key: 'statusline-trust-blocked',
      text: 'status line command blocked by session hook policy',
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
        id: 'gpt-5',
        display_name: 'Rendered gpt-5',
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
    expect(mocks.getContextWindowForModel).toHaveBeenCalledWith(
      'gpt-5',
      TEST_REMOTE_AUTH_SESSION_CONTEXT,
    )
    expect(mocks.appState.statusLineText).toBe('updated-status')
  })
})
