import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  accessibilityEnabled: false,
  baseTextInputCalls: [] as Array<Record<string, unknown>>,
  clipboardImageHint: vi.fn(),
  dim: vi.fn((text: string) => `dim(${text})`),
  feature: vi.fn((flag: string) => flag === 'VOICE_MODE' && harness.voiceMode),
  inverse: vi.fn((text: string) => `inverse(${text})`),
  rgb: vi.fn((r: number, g: number, b: number) => (text: string) => `rgb(${r},${g},${b})(${text})`),
  settings: null as null | { prefersReducedMotion?: boolean },
  terminalFocused: true,
  textInputCalls: [] as Array<Record<string, unknown>>,
  voice: {
    voiceAudioLevels: [] as Array<number | undefined>,
    voiceState: 'idle',
  },
  voiceMode: false,
  voiceStateCalls: [] as string[],
  reset() {
    this.accessibilityEnabled = false
    this.baseTextInputCalls = []
    this.clipboardImageHint.mockClear()
    this.dim.mockClear()
    this.feature.mockClear()
    this.inverse.mockClear()
    this.rgb.mockClear()
    this.settings = null
    this.terminalFocused = true
    this.textInputCalls = []
    this.voice = {
      voiceAudioLevels: [],
      voiceState: 'idle',
    }
    this.voiceMode = false
    this.voiceStateCalls = []
  },
}))

vi.mock('bun:bundle', () => ({
  feature: harness.feature,
}))

vi.mock('chalk', () => ({
  default: {
    dim: harness.dim,
    inverse: harness.inverse,
    rgb: harness.rgb,
  },
}))

vi.mock('../hooks/useClipboardImageHint.js', () => ({
  useClipboardImageHint: harness.clipboardImageHint,
}))

vi.mock('../hooks/useSettings.js', () => ({
  useSettings: () => harness.settings,
}))

vi.mock('../context/voice.js', () => ({
  useVoiceState: (selector: (state: typeof harness.voice) => unknown) => {
    const selected = selector(harness.voice)
    harness.voiceStateCalls.push(
      selected === harness.voice.voiceAudioLevels ? 'voiceAudioLevels' : String(selected),
    )
    return selected
  },
}))

vi.mock('../../utils/envUtils.js', () => ({
  isEnvTruthy: () => harness.accessibilityEnabled,
}))

vi.mock('../ink.js', async () => {
  const ReactModule = await import('react')

  return {
    Box: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    color: (name: string, theme: string) => (text: string) =>
      `color(${name}:${theme}:${text})`,
    useTerminalFocus: () => harness.terminalFocused,
    useTheme: () => ['dark', () => {}] as const,
  }
})

vi.mock('../hooks/useTextInput.js', () => ({
  useTextInput: (props: Record<string, unknown>) => {
    harness.textInputCalls.push(props)
    return {
      cursorColumn: 0,
      cursorLine: 0,
      offset: props.externalOffset ?? 0,
      onInput: vi.fn(),
      renderedValue: String(props.value ?? ''),
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
import TextInput from '../components/TextInput.js'

type TextInputProps = React.ComponentProps<typeof TextInput>

const originalGlyphMode = process.env.AGENC_TUI_GLYPHS

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

function baseProps(overrides: Partial<TextInputProps> = {}): TextInputProps {
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

async function renderTextInput(
  overrides: Partial<TextInputProps> = {},
): Promise<void> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  try {
    root.render(<TextInput {...baseProps(overrides)} />)
    await sleep()
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await sleep()
  }
}

function latestTextInputProps(): Record<string, unknown> {
  const props = harness.textInputCalls.at(-1)
  if (!props) throw new Error('useTextInput was not called')
  return props
}

function latestBaseTextInputProps(): Record<string, unknown> {
  const props = harness.baseTextInputCalls.at(-1)
  if (!props) throw new Error('BaseTextInput was not called')
  return props
}

describe('TextInput coverage swarm row 052', () => {
  beforeEach(() => {
    harness.reset()
    process.env.AGENC_TUI_GLYPHS = 'ascii'
  })

  afterEach(() => {
    harness.reset()
    if (originalGlyphMode === undefined) {
      delete process.env.AGENC_TUI_GLYPHS
    } else {
      process.env.AGENC_TUI_GLYPHS = originalGlyphMode
    }
  })

  test('uses the standard cursor and forwards input/base props when voice mode is disabled', async () => {
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
    const inputFilter = vi.fn((input: string) => input.toUpperCase())
    const inlineGhostText = {
      fullCommand: 'review',
      insertPosition: 2,
      text: 'view',
    }
    const highlights = [{ color: 'success', end: 2, priority: 1, start: 0 }]

    await renderTextInput({
      columns: 42,
      cursorOffset: 3,
      disableCursorMovementForUpDownKeys: true,
      disableEscapeDoublePress: true,
      focus: true,
      highlightPastedText: true,
      highlights,
      inlineGhostText,
      inputFilter,
      mask: '*',
      maxVisibleLines: 5,
      multiline: true,
      onChange,
      onClearInput,
      onExit,
      onExitMessage,
      onHistoryDown,
      onHistoryReset,
      onHistoryUp,
      onImagePaste,
      onSubmit,
      showCursor: true,
      value: 'ask',
    })

    const textInputProps = latestTextInputProps()
    const baseInputProps = latestBaseTextInputProps()
    const invert = textInputProps.invert as (text: string) => string
    const dim = textInputProps.dim as (text: string) => string
    const themeText = textInputProps.themeText as (text: string) => string

    expect(harness.voiceStateCalls).toEqual([])
    expect(harness.clipboardImageHint).toHaveBeenCalledWith(true, true)
    expect(invert('x')).toBe('inverse(x)')
    expect(dim('x')).toBe('dim(x)')
    expect(themeText('x')).toBe('color(text:dark:x)')
    expect(textInputProps).toMatchObject({
      columns: 42,
      cursorChar: ' ',
      disableCursorMovementForUpDownKeys: true,
      disableEscapeDoublePress: true,
      externalOffset: 3,
      focus: true,
      highlightPastedText: true,
      inlineGhostText,
      inputFilter,
      mask: '*',
      maxVisibleLines: 5,
      multiline: true,
      onChange,
      onClearInput,
      onExit,
      onExitMessage,
      onHistoryDown,
      onHistoryReset,
      onHistoryUp,
      onImagePaste,
      onSubmit,
      value: 'ask',
    })
    expect(textInputProps.onOffsetChange).toBeTypeOf('function')
    expect(baseInputProps).toMatchObject({
      highlights,
      hidePlaceholderText: false,
      terminalFocus: true,
      value: 'ask',
    })
    expect(baseInputProps.invert).toBe(textInputProps.invert)
    expect(baseInputProps.inputState).toMatchObject({
      renderedValue: 'ask',
      value: 'ask',
    })
  })

  test('uses identity cursor inversion when terminal focus or accessibility disables the cursor', async () => {
    harness.terminalFocused = false
    await renderTextInput({
      onImagePaste: undefined,
      showCursor: false,
      value: 'unfocused',
    })

    let textInputProps = latestTextInputProps()
    let invert = textInputProps.invert as (text: string) => string
    expect(harness.clipboardImageHint).toHaveBeenLastCalledWith(false, false)
    expect(textInputProps.cursorChar).toBe('')
    expect(invert('cursor')).toBe('cursor')
    expect(harness.inverse).not.toHaveBeenCalled()

    harness.textInputCalls = []
    harness.baseTextInputCalls = []
    harness.terminalFocused = true
    harness.accessibilityEnabled = true
    await renderTextInput({
      onImagePaste: vi.fn(),
      showCursor: true,
      value: 'accessible',
    })

    textInputProps = latestTextInputProps()
    invert = textInputProps.invert as (text: string) => string
    expect(harness.clipboardImageHint).toHaveBeenLastCalledWith(true, true)
    expect(textInputProps.cursorChar).toBe(' ')
    expect(invert('cursor')).toBe('cursor')
    expect(harness.inverse).not.toHaveBeenCalled()
  })

  test('hides placeholder text and renders silent voice cursor levels while recording', async () => {
    harness.voiceMode = true
    harness.voice = {
      voiceAudioLevels: [],
      voiceState: 'recording',
    }
    harness.settings = { prefersReducedMotion: false }

    await renderTextInput({ value: '' })

    let textInputProps = latestTextInputProps()
    let baseInputProps = latestBaseTextInputProps()
    let invert = textInputProps.invert as (text: string) => string

    expect(harness.voiceStateCalls).toEqual(['recording', 'voiceAudioLevels'])
    expect(baseInputProps.hidePlaceholderText).toBe(true)
    expect(invert('ignored')).toBe('rgb(128,128,128)(.)')

    harness.textInputCalls = []
    harness.baseTextInputCalls = []
    harness.voice = {
      voiceAudioLevels: [undefined],
      voiceState: 'recording',
    }

    await renderTextInput({ value: '' })

    textInputProps = latestTextInputProps()
    baseInputProps = latestBaseTextInputProps()
    invert = textInputProps.invert as (text: string) => string

    expect(baseInputProps.hidePlaceholderText).toBe(true)
    expect(invert('ignored')).toBe('rgb(128,128,128)(.)')
  })

  test('uses colored voice cursor for active audio and falls back to standard inverse for reduced motion', async () => {
    harness.voiceMode = true
    harness.voice = {
      voiceAudioLevels: [0.8],
      voiceState: 'recording',
    }
    harness.settings = { prefersReducedMotion: false }

    await renderTextInput({ value: 'speaking' })

    let textInputProps = latestTextInputProps()
    let baseInputProps = latestBaseTextInputProps()
    let invert = textInputProps.invert as (text: string) => string

    expect(baseInputProps.hidePlaceholderText).toBe(true)
    expect(invert('ignored')).toBe('rgb(82,224,82)(:)')

    harness.textInputCalls = []
    harness.baseTextInputCalls = []
    harness.voice = {
      voiceAudioLevels: [0.8],
      voiceState: 'recording',
    }
    harness.settings = { prefersReducedMotion: true }

    await renderTextInput({ value: 'still speaking' })

    textInputProps = latestTextInputProps()
    baseInputProps = latestBaseTextInputProps()
    invert = textInputProps.invert as (text: string) => string

    expect(baseInputProps.hidePlaceholderText).toBe(true)
    expect(invert('cursor')).toBe('inverse(cursor)')
  })

  test('keeps placeholder visible when voice mode is enabled but not recording', async () => {
    harness.voiceMode = true
    harness.voice = {
      voiceAudioLevels: [0.4],
      voiceState: 'processing',
    }
    harness.settings = { prefersReducedMotion: false }

    await renderTextInput({ value: 'processing' })

    const textInputProps = latestTextInputProps()
    const baseInputProps = latestBaseTextInputProps()
    const invert = textInputProps.invert as (text: string) => string

    expect(baseInputProps.hidePlaceholderText).toBe(false)
    expect(invert('cursor')).toBe('inverse(cursor)')
  })
})
