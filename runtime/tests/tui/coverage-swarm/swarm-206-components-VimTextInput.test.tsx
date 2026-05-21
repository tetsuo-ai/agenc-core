import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  baseTextInputCalls: [] as Array<Record<string, unknown>>,
  clipboardImageHint: vi.fn(),
  inverse: vi.fn((text: string) => `inverse(${text})`),
  setMode: vi.fn(),
  terminalFocused: true,
  theme: 'dark',
  vimInputCalls: [] as Array<Record<string, unknown>>,
  vimMode: 'INSERT' as 'INSERT' | 'NORMAL',
  reset() {
    this.baseTextInputCalls = []
    this.clipboardImageHint.mockClear()
    this.inverse.mockClear()
    this.setMode.mockClear()
    this.terminalFocused = true
    this.theme = 'dark'
    this.vimInputCalls = []
    this.vimMode = 'INSERT'
  },
}))

vi.mock('chalk', () => ({
  default: {
    inverse: harness.inverse,
  },
}))

vi.mock('../hooks/useClipboardImageHint.js', () => ({
  useClipboardImageHint: harness.clipboardImageHint,
}))

vi.mock('../ink.js', async () => {
  const ReactModule = await import('react')

  return {
    Box: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    color: (name: string, theme: string) => (text: string) =>
      `color(${name}:${theme}:${text})`,
    useTerminalFocus: () => harness.terminalFocused,
    useTheme: () => [harness.theme, () => {}] as const,
  }
})

vi.mock('../hooks/useVimInput.js', () => ({
  useVimInput: (props: Record<string, unknown>) => {
    harness.vimInputCalls.push(props)
    return {
      cursorColumn: 0,
      cursorLine: 0,
      mode: harness.vimMode,
      offset: props.externalOffset ?? 0,
      onInput: vi.fn(),
      renderedValue: String(props.value ?? ''),
      setMode: harness.setMode,
      setOffset: vi.fn(),
      setValue: vi.fn(),
      value: String(props.value ?? ''),
      viewportCharEnd: String(props.value ?? '').length,
      viewportCharOffset: 0,
    }
  },
}))

vi.mock('../components/BaseTextInput.js', async () => {
  const ReactModule = await import('react')

  return {
    BaseTextInput: (props: Record<string, unknown>) => {
      harness.baseTextInputCalls.push(props)
      return ReactModule.createElement(ReactModule.Fragment)
    },
  }
})

import { createRoot } from '../ink/root.js'
import VimTextInput from '../components/VimTextInput.js'

type VimTextInputProps = React.ComponentProps<typeof VimTextInput>

function createStreams(): {
  readonly stdout: PassThrough
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
} {
  const stdout = new PassThrough()
  stdout.resume()
  ;(stdout as unknown as { columns: number }).columns = 100

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

  return { stdin, stdout }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function baseProps(
  overrides: Partial<VimTextInputProps> = {},
): VimTextInputProps {
  return {
    columns: 80,
    cursorOffset: 0,
    focus: true,
    onChange: vi.fn(),
    onChangeCursorOffset: vi.fn(),
    showCursor: true,
    value: 'draft',
    ...overrides,
  }
}

async function renderVimTextInput(
  overrides: Partial<VimTextInputProps> = {},
): Promise<void> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  try {
    root.render(<VimTextInput {...baseProps(overrides)} />)
    await sleep()
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await sleep()
  }
}

function latestVimInputProps(): Record<string, unknown> {
  const props = harness.vimInputCalls.at(-1)
  if (!props) throw new Error('useVimInput was not called')
  return props
}

function latestBaseTextInputProps(): Record<string, unknown> {
  const props = harness.baseTextInputCalls.at(-1)
  if (!props) throw new Error('BaseTextInput was not called')
  return props
}

describe('VimTextInput coverage swarm row 206', () => {
  beforeEach(() => {
    harness.reset()
  })

  afterEach(() => {
    harness.reset()
  })

  test('forwards vim hook props and focused terminal rendering props', async () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    const onExit = vi.fn()
    const onExitMessage = vi.fn()
    const onHistoryReset = vi.fn()
    const onHistoryUp = vi.fn()
    const onHistoryDown = vi.fn()
    const onClearInput = vi.fn()
    const onImagePaste = vi.fn()
    const onChangeCursorOffset = vi.fn()
    const onModeChange = vi.fn()
    const onUndo = vi.fn()
    const inputFilter = vi.fn((input: string) => input.trimStart())
    const highlights = [{ color: 'success', end: 5, priority: 1, start: 0 }]

    await renderVimTextInput({
      columns: 42,
      cursorOffset: 4,
      disableCursorMovementForUpDownKeys: true,
      disableEscapeDoublePress: true,
      focus: true,
      highlightPastedText: true,
      highlights,
      inputFilter,
      mask: '*',
      maxVisibleLines: 3,
      multiline: true,
      onChange,
      onChangeCursorOffset,
      onClearInput,
      onExit,
      onExitMessage,
      onHistoryDown,
      onHistoryReset,
      onHistoryUp,
      onImagePaste,
      onModeChange,
      onSubmit,
      onUndo,
      showCursor: true,
      value: 'draft',
    })

    const vimInputProps = latestVimInputProps()
    const baseTextInputProps = latestBaseTextInputProps()
    const invert = vimInputProps.invert as (text: string) => string
    const themeText = vimInputProps.themeText as (text: string) => string

    expect(harness.clipboardImageHint).toHaveBeenCalledWith(true, true)
    expect(invert('cursor')).toBe('inverse(cursor)')
    expect(themeText('body')).toBe('color(text:dark:body)')
    expect(vimInputProps).toMatchObject({
      columns: 42,
      cursorChar: ' ',
      disableCursorMovementForUpDownKeys: true,
      disableEscapeDoublePress: true,
      externalOffset: 4,
      focus: true,
      highlightPastedText: true,
      inputFilter,
      mask: '*',
      maxVisibleLines: 3,
      multiline: true,
      onChange,
      onClearInput,
      onExit,
      onExitMessage,
      onHistoryDown,
      onHistoryReset,
      onHistoryUp,
      onImagePaste,
      onModeChange,
      onOffsetChange: onChangeCursorOffset,
      onSubmit,
      onUndo,
      value: 'draft',
    })
    expect(baseTextInputProps).toMatchObject({
      highlights,
      terminalFocus: true,
      value: 'draft',
    })
    expect(baseTextInputProps.inputState).toMatchObject({
      mode: 'INSERT',
      renderedValue: 'draft',
      value: 'draft',
    })
  })

  test('uses identity cursor inversion when the terminal is unfocused and cursor is hidden', async () => {
    harness.terminalFocused = false
    harness.theme = 'light'

    await renderVimTextInput({
      onImagePaste: undefined,
      showCursor: false,
      value: 'unfocused',
    })

    const vimInputProps = latestVimInputProps()
    const baseTextInputProps = latestBaseTextInputProps()
    const invert = vimInputProps.invert as (text: string) => string
    const themeText = vimInputProps.themeText as (text: string) => string

    expect(harness.clipboardImageHint).toHaveBeenCalledWith(false, false)
    expect(vimInputProps.cursorChar).toBe('')
    expect(invert('cursor')).toBe('cursor')
    expect(themeText('body')).toBe('color(text:light:body)')
    expect(harness.inverse).not.toHaveBeenCalled()
    expect(baseTextInputProps.terminalFocus).toBe(false)
  })

  test('applies initial vim mode only when it differs from the current hook mode', async () => {
    harness.vimMode = 'INSERT'

    await renderVimTextInput({
      initialMode: 'NORMAL',
      value: 'modal',
    })

    expect(harness.setMode).toHaveBeenCalledWith('NORMAL')

    harness.setMode.mockClear()
    harness.vimInputCalls = []
    harness.baseTextInputCalls = []
    harness.vimMode = 'NORMAL'

    await renderVimTextInput({
      initialMode: 'NORMAL',
      value: 'already normal',
    })

    expect(harness.setMode).not.toHaveBeenCalled()
  })
})
