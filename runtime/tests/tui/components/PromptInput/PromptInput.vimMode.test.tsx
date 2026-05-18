import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../../ink/root.js'
import type {
  BaseTextInputProps,
  VimMode,
} from '../../../types/textInputTypes.js'
import { ConfiguredPromptTextInput } from './ConfiguredPromptTextInput.js'

const configMock = vi.hoisted(() => ({
  globalConfig: {
    editorMode: 'normal',
    tui: { vimMode: true },
  } as { editorMode?: string; tui?: { vimMode?: boolean } },
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('src/tools.js', () => ({}))
vi.mock('../../../tools.js', () => ({}))

vi.mock('../../../utils/config.js', () => ({
  getGlobalConfig: () => configMock.globalConfig,
}))

vi.mock('../../hooks/useClipboardImageHint.js', () => ({
  useClipboardImageHint: () => {},
}))

vi.mock('../../context/notifications.js', () => ({
  useNotifications: () => ({
    addNotification: () => {},
    removeNotification: () => {},
  }),
}))

vi.mock('../../../commands/terminalSetup/terminalSetup.js', () => ({
  markBackslashReturnUsed: () => {},
}))

vi.mock('../../history/history.js', () => ({
  addToHistory: () => {},
}))

vi.mock('../../../utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => false,
}))

vi.mock('../../../utils/env.js', () => ({
  env: {},
}))

vi.mock('../../../utils/envUtils.js', () => ({
  isEnvTruthy: () => false,
}))

vi.mock('../../../utils/modifiers.js', () => ({
  isModifierPressed: () => false,
  prewarmModifiers: () => {},
}))

vi.mock('../../hooks/useSettings.js', () => ({
  useSettings: () => ({ prefersReducedMotion: true }),
}))

vi.mock('../../context/voice.js', () => ({
  useVoiceState: () => 'idle',
}))

vi.mock('../../ink.js', async () => {
  const ReactModule = await import('react')
  const { default: useInput } = await import('../../ink/hooks/use-input.js')
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

vi.mock('../BaseTextInput.js', async () => {
  const ReactModule = await import('react')
  const { default: useInput } = await import('../../ink/hooks/use-input.js')
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

async function writeKeys(
  stdin: PassThrough,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    stdin.write(key)
    await sleep(10)
  }
}

function ConfiguredComposerHarness(props: {
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

  return (
    <ConfiguredPromptTextInput
      baseProps={baseProps}
      vimMode={vimMode}
      onVimModeChange={mode => {
        setVimMode(mode)
        props.onModeChange(mode)
      }}
    />
  )
}

async function renderAndSubmitWithKeys(
  vimModeEnabled: boolean,
  keys: readonly string[],
): Promise<string> {
  configMock.globalConfig = {
    editorMode: 'normal',
    tui: { vimMode: vimModeEnabled },
  }
  const { stdout, stdin } = createTestStreams()
  const submitted: string[] = []
  const modes: VimMode[] = []
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  try {
    root.render(
      <ConfiguredComposerHarness
        onSubmit={value => submitted.push(value)}
        onModeChange={mode => modes.push(mode)}
      />,
    )
    if (vimModeEnabled) {
      await waitFor(() => modes.includes('NORMAL'), 'NORMAL mode')
    }
    await sleep(50)
    await writeKeys(stdin, keys)
    stdin.write('\r')
    await waitFor(() => submitted.length === 1, 'configured composer submit')
    return submitted[0]!
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }
}

describe('PromptInput configured vim mode composer path', () => {
  beforeEach(() => {
    configMock.globalConfig = {
      editorMode: 'normal',
      tui: { vimMode: true },
    }
  })

  test('routes modal-edited composer text when tui.vimMode is true', async () => {
    await expect(
      renderAndSubmitWithKeys(true, ['5', 'd', 'w', 'j', 'x']),
    ).resolves.toBe('six\next line')
  })

  test('keeps normal text input behavior when tui.vimMode is false', async () => {
    await expect(
      renderAndSubmitWithKeys(false, ['5', 'd', 'w', 'j', 'x']),
    ).resolves.toBe('5dwjxone two three four five six\nnext line')
  })
})
