import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../ink/root.js'
import { StatusLine } from './StatusLine.js'

const mocks = vi.hoisted(() => ({
  appState: {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
    },
    statusLineText: '',
  } as Record<string, unknown>,
  executeStatusLineCommand: vi.fn(async () => 'custom-status'),
  logEvent: vi.fn(),
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../services/analytics/index.js', () => ({
  logEvent: mocks.logEvent,
}))

vi.mock('../../constants/outputStyles.js', () => ({
  DEFAULT_OUTPUT_STYLE_NAME: 'default',
}))

vi.mock('src/utils/debug.js', () => ({
  logForDebugging: () => {},
}))

vi.mock('../rate-limits/agenc-ai-limits.js', () => ({
  getRawUtilization: () => ({}),
}))

vi.mock('../../bootstrap/state.js', () => ({
  flushInteractionTime: () => {},
  getIsRemoteMode: () => false,
  getKairosActive: () => false,
  getMainThreadAgentType: () => undefined,
  getOriginalCwd: () => '/workspace',
  getSdkBetas: () => [],
  getSessionId: () => 'session-statusline-test',
  updateLastInteractionTime: () => {},
}))

vi.mock('../../cost/tracker.js', () => ({
  getTotalAPIDuration: () => 0,
  getTotalCost: () => 0,
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
    addNotification: vi.fn(),
  }),
}))

vi.mock('../../permissions/trust/project-trust.js', () => ({
  checkHasProjectTrustAcceptedSync: () => true,
}))

vi.mock('../../utils/config.js', () => ({
  getGlobalConfig: () => ({ tui: { vimMode: true } }),
}))

vi.mock('../../utils/context.js', () => ({
  calculateContextPercentages: () => ({ used: 0, remaining: 100 }),
  getContextWindowForModel: () => 100000,
}))

vi.mock('../../utils/cwd.js', () => ({
  getCwd: () => '/workspace',
}))

vi.mock('../../utils/debug.js', () => ({
  logForDebugging: () => {},
}))

vi.mock('../../utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => false,
}))

vi.mock('../../utils/hooks.js', () => ({
  createBaseHookInput: () => ({}),
  executeStatusLineCommand: mocks.executeStatusLineCommand,
}))

vi.mock('../../utils/messages.js', () => ({
  getLastAssistantMessage: () => null,
}))

vi.mock('../../utils/model/model.js', () => ({
  getRuntimeMainLoopModel: () => 'gpt-5',
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
  beforeEach(() => {
    mocks.appState = {
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Map(),
      },
      statusLineText: '',
    }
    mocks.executeStatusLineCommand.mockClear()
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
})
