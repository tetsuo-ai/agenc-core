import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../ink/root.js'
import type {
  BaseTextInputProps,
  VimMode,
} from '../../types/textInputTypes.js'
import { ConfiguredPromptTextInput } from '../components/PromptInput/ConfiguredPromptTextInput.js'
import { processTextPrompt } from './processTextPrompt.js'

const configMock = vi.hoisted(() => ({
  globalConfig: {
    editorMode: 'normal',
    tui: { vimMode: true },
  } as { editorMode?: string; tui?: { vimMode?: boolean } },
}))

const mocks = vi.hoisted(() => ({
  createUserMessage: vi.fn((input: { content: unknown }) => ({
    type: 'user',
    message: { role: 'user', content: input.content },
    ...input,
  })),
  logEvent: vi.fn(),
  logOTelEvent: vi.fn(),
  setPromptId: vi.fn(),
  startInteractionSpan: vi.fn(),
}))

vi.mock('../../bootstrap/state.js', () => ({
  flushInteractionTime: vi.fn(),
  setPromptId: mocks.setPromptId,
  updateLastInteractionTime: vi.fn(),
}))

vi.mock('../../services/analytics/index.js', () => ({
  logEvent: mocks.logEvent,
}))

vi.mock('../../utils/messages.js', () => ({
  createUserMessage: mocks.createUserMessage,
}))

vi.mock('../../utils/telemetry/events.js', () => ({
  logOTelEvent: mocks.logOTelEvent,
  redactIfDisabled: vi.fn((value: string) => value),
}))

vi.mock('../../utils/telemetry/sessionTracing.js', () => ({
  startInteractionSpan: mocks.startInteractionSpan,
}))

vi.mock('../../utils/config.js', () => ({
  getGlobalConfig: () => configMock.globalConfig,
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('src/tools.js', () => ({}))
vi.mock('../../tools.js', () => ({}))

vi.mock('../hooks/useClipboardImageHint.js', () => ({
  useClipboardImageHint: () => {},
}))

vi.mock('../context/notifications.js', () => ({
  useNotifications: () => ({
    addNotification: () => {},
    removeNotification: () => {},
  }),
}))

vi.mock('../../commands/terminalSetup/terminalSetup.js', () => ({
  markBackslashReturnUsed: () => {},
}))

vi.mock('../history/history.js', () => ({
  addToHistory: () => {},
}))

vi.mock('../../utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => false,
}))

vi.mock('../../utils/env.js', () => ({
  env: {},
}))

vi.mock('../../utils/envUtils.js', () => ({
  isEnvTruthy: () => false,
}))

vi.mock('../../utils/modifiers.js', () => ({
  isModifierPressed: () => false,
  prewarmModifiers: () => {},
}))

vi.mock('../hooks/useSettings.js', () => ({
  useSettings: () => ({ prefersReducedMotion: true }),
}))

vi.mock('../context/voice.js', () => ({
  useVoiceState: () => 'idle',
}))

vi.mock('../ink.js', async () => {
  const ReactModule = await import('react')
  const { default: useInput } = await import('../ink/hooks/use-input.js')
  return {
    Box: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    color: () => (text: string) => text,
    useAnimationFrame: () => [() => {}, 0] as const,
    useInput,
    useTerminalFocus: () => true,
    useTheme: () => ['dark', () => {}] as const,
  }
})

vi.mock('../components/BaseTextInput.js', async () => {
  const ReactModule = await import('react')
  const { default: useInput } = await import('../ink/hooks/use-input.js')
  return {
    BaseTextInput: ({
      inputState,
      focus,
    }: {
      inputState: { onInput: (input: string, key: unknown) => void }
      focus?: boolean
    }) => {
      useInput(
        (input, key) => {
          inputState.onInput(input, key)
        },
        { isActive: focus ?? true },
      )
      return ReactModule.createElement('mock-prompt-input')
    },
  }
})

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
} {
  const stdout = new PassThrough()
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
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.resume()

  return { stdout, stdin }
}

async function waitFor(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 1000) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function ConfiguredProcessPromptHarness(props: {
  onSubmit: (value: string) => void
  onModeChange: (mode: VimMode) => void
}): React.ReactNode {
  const [value, setValue] = React.useState(
    'one two three four five six\nnext line',
  )
  const [cursorOffset, setCursorOffset] = React.useState(0)
  const [vimMode, setVimMode] = React.useState<VimMode>('NORMAL')
  const baseProps: BaseTextInputProps = {
    value,
    onChange: setValue,
    onSubmit: props.onSubmit,
    columns: 80,
    cursorOffset,
    onChangeCursorOffset: setCursorOffset,
    focus: true,
    showCursor: true,
    multiline: true,
  }

  return React.createElement(ConfiguredPromptTextInput, {
    baseProps,
    vimMode,
    onVimModeChange(nextMode: VimMode) {
      setVimMode(nextMode)
      props.onModeChange(nextMode)
    },
  })
}

describe('processTextPrompt with vim-aware composer input', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configMock.globalConfig = {
      editorMode: 'normal',
      tui: { vimMode: true },
    }
  })

  test('processes finalized text after configured vim composer movement', async () => {
    const { stdout, stdin } = createTestStreams()
    const modes: VimMode[] = []
    const results: ReturnType<typeof processTextPrompt>[] = []
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(
        React.createElement(ConfiguredProcessPromptHarness, {
          onSubmit(value: string) {
            results.push(processTextPrompt(value, [], [], []))
          },
          onModeChange: mode => modes.push(mode),
        }),
      )

      await waitFor(() => modes.includes('NORMAL'), 'NORMAL mode')
      await sleep(50)
      for (const key of ['5', 'd', 'w', 'j', 'x']) {
        stdin.write(key)
        await sleep(10)
      }
      stdin.write('\r')

      await waitFor(
        () => results.length === 1 && mocks.createUserMessage.mock.calls.length === 1,
        'processed vim prompt',
      )
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }

    expect(results[0]?.shouldQuery).toBe(true)
    expect(configMock.globalConfig.tui?.vimMode).toBe(true)
    expect(mocks.createUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'six\next line' }),
    )
  })

  test('can finalize vim routing keys before prompt message construction', () => {
    const result = processTextPrompt(
      '/help status',
      [],
      [],
      [],
      undefined,
      undefined,
      undefined,
      {
        enabled: true,
        mode: 'NORMAL',
        keys: ['x'],
      },
    )

    expect(result.shouldQuery).toBe(true)
    expect(mocks.createUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'help status' }),
    )
  })
})
