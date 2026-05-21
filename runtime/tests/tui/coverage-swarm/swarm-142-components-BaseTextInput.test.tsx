import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { BaseInputState } from '../../types/textInputTypes.js'
import type { TextHighlight } from '../../utils/textHighlighting.js'
import { createRoot, Text } from '../ink.js'
import { BaseTextInput } from '../components/BaseTextInput.js'

const highlightedInputMock = vi.hoisted(() => ({
  calls: [] as Array<{
    highlights: TextHighlight[]
    text: string
  }>,
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../utils/config.js', () => ({
  getGlobalConfig: () => ({ theme: 'dark' }),
  saveGlobalConfig: vi.fn(),
}))

vi.mock('../../utils/systemTheme.js', () => ({
  getSystemThemeName: () => 'dark',
  resolveThemeSetting: () => 'dark',
}))

vi.mock('../components/PromptInput/ShimmeredInput.js', async () => {
  const ReactModule = await import('react')
  const { Text: InkText } = await import('../ink.js')

  return {
    HighlightedInput: ({
      highlights,
      text,
    }: {
      highlights: TextHighlight[]
      text: string
    }) => {
      highlightedInputMock.calls.push({ highlights, text })
      return ReactModule.createElement(InkText, null, `highlighted:${text}`)
    },
  }
})

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break

    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break

    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) lastFrame = frame
    cursor = end + SYNC_END.length
  }

  return lastFrame ?? output
}

function createStreams(): {
  getOutput: () => string
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  stdout: PassThrough
} {
  let output = ''
  const stdout = new PassThrough()
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
  ;(stdout as unknown as { columns: number }).columns = 80
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  return { getOutput: () => output, stdin, stdout }
}

function createInputState(
  overrides: Partial<BaseInputState> = {},
): BaseInputState {
  return {
    cursorColumn: 0,
    cursorLine: 0,
    offset: 0,
    onInput: vi.fn(),
    renderedValue: '',
    setOffset: vi.fn(),
    setValue: vi.fn(),
    value: '',
    viewportCharEnd: 0,
    viewportCharOffset: 0,
    ...overrides,
  }
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('BaseTextInput coverage swarm row 142', () => {
  beforeEach(() => {
    highlightedInputMock.calls = []
  })

  test('renders the generated placeholder when no placeholder element is supplied', async () => {
    const inputState = createInputState()
    const { getOutput, stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      root.render(
        <BaseTextInput
          columns={80}
          cursorOffset={0}
          focus={true}
          inputState={inputState}
          onChange={vi.fn()}
          onChangeCursorOffset={vi.fn()}
          placeholder="type here"
          showCursor={true}
          terminalFocus={false}
          value=""
        >
          <Text> suffix</Text>
        </BaseTextInput>,
      )
      await sleep()

      const output = stripAnsi(extractLastFrame(getOutput()))
      expect(output).toContain('type here suffix')
      expect(output).not.toContain('custom placeholder')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })

  test('passes highlights through unchanged when the cursor is hidden and viewport starts at zero', async () => {
    const highlights: TextHighlight[] = [
      { color: 'success', end: 5, priority: 1, start: 0 },
      { color: 'error', end: 12, priority: 2, start: 6 },
    ]
    const inputState = createInputState({
      cursorColumn: 2,
      offset: 2,
      renderedValue: '/ship target',
      value: '/ship target',
      viewportCharEnd: 12,
      viewportCharOffset: 0,
    })
    const { getOutput, stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      root.render(
        <BaseTextInput
          argumentHint="<path>"
          columns={80}
          cursorOffset={2}
          focus={true}
          highlights={highlights}
          inputState={inputState}
          onChange={vi.fn()}
          onChangeCursorOffset={vi.fn()}
          showCursor={false}
          terminalFocus={true}
          value="/ship target"
        >
          <Text> tail</Text>
        </BaseTextInput>,
      )
      await sleep()

      const output = stripAnsi(extractLastFrame(getOutput()))
      expect(output).toContain('highlighted:/ship target tail')
      expect(output).not.toContain('<path>')
      expect(highlightedInputMock.calls).toEqual([
        {
          highlights,
          text: '/ship target',
        },
      ])
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })

  test('treats an empty highlight list as the plain text render path', async () => {
    const inputState = createInputState({
      cursorColumn: 4,
      offset: 4,
      renderedValue: 'note',
      value: 'note',
      viewportCharEnd: 4,
    })
    const { getOutput, stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      root.render(
        <BaseTextInput
          argumentHint="<ignored>"
          columns={80}
          cursorOffset={4}
          focus={false}
          highlights={[]}
          inputState={inputState}
          onChange={vi.fn()}
          onChangeCursorOffset={vi.fn()}
          placeholder="fallback"
          showCursor={false}
          terminalFocus={true}
          value="note"
        >
          <Text> tail</Text>
        </BaseTextInput>,
      )
      await sleep()

      const output = stripAnsi(extractLastFrame(getOutput()))
      expect(output).toContain('note tail')
      expect(output).not.toContain('<ignored>')
      expect(output).not.toContain('fallback')
      expect(highlightedInputMock.calls).toEqual([])
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })
})
