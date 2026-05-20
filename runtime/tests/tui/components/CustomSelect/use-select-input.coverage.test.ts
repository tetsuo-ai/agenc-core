import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../../ink/root.js'
import type { OptionWithDescription } from './select.js'
import { useSelectInput } from './use-select-input.js'
import type { SelectState } from './use-select-state.js'

type InputKey = Partial<{
  ctrl: boolean
  downArrow: boolean
  pageDown: boolean
  pageUp: boolean
  tab: boolean
  upArrow: boolean
}>

type InputEventStub = {
  stopImmediatePropagation: () => void
}

type CapturedInput = {
  handler: (input: string, key: InputKey, event: InputEventStub) => void
  options: { isActive?: boolean }
}

const inputMock = vi.hoisted(() => ({
  current: undefined as CapturedInput | undefined,
}))

const keybindingMock = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | {
        handlers: Record<string, () => void>
        options: { context?: string; isActive?: boolean }
      },
}))

const overlayMock = vi.hoisted(() => ({
  useRegisterOverlay: vi.fn(),
}))

vi.mock('../../context/overlayContext.js', () => ({
  useRegisterOverlay: overlayMock.useRegisterOverlay,
}))

vi.mock('../../ink.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../ink.js')>()
  return {
    ...actual,
    useInput: (
      handler: CapturedInput['handler'],
      options: CapturedInput['options'],
    ) => {
      inputMock.current = { handler, options }
    },
  }
})

vi.mock('../../keybindings/useKeybinding.js', () => ({
  useKeybindings: (
    handlers: Record<string, () => void>,
    options: { context?: string; isActive?: boolean },
  ) => {
    keybindingMock.current = { handlers, options }
  },
}))

function createSelectState(
  overrides: Partial<SelectState<string>> = {},
): SelectState<string> {
  return {
    focusedValue: 'prompt',
    focusedIndex: 2,
    visibleFromIndex: 0,
    visibleToIndex: 3,
    value: undefined,
    options: [],
    visibleOptions: [],
    isInInput: true,
    focusNextOption: vi.fn(),
    focusPreviousOption: vi.fn(),
    focusNextPage: vi.fn(),
    focusPreviousPage: vi.fn(),
    focusOption: vi.fn(),
    selectFocusedOption: vi.fn(),
    onChange: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }
}

function Harness({
  options,
  state,
}: {
  options: OptionWithDescription<string>[]
  state: SelectState<string>
}): null {
  useSelectInput({ options, state })
  return null
}

async function renderHarness(node: React.ReactNode): Promise<() => void> {
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

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(node)
  await new Promise(resolve => setTimeout(resolve, 30))

  return () => {
    root.unmount()
    stdin.end()
    stdout.end()
  }
}

function pressKey(input: string, key: InputKey = {}): InputEventStub {
  const event = {
    stopImmediatePropagation: vi.fn(),
  }

  expect(inputMock.current).toBeDefined()
  inputMock.current!.handler(input, key, event)
  return event
}

describe('useSelectInput', () => {
  const options: OptionWithDescription<string>[] = [
    { value: 'alpha', label: 'Alpha' },
    { type: 'input', value: 'prompt', label: 'Prompt', onChange: vi.fn() },
    { value: 'omega', label: 'Omega' },
  ]

  beforeEach(() => {
    inputMock.current = undefined
    keybindingMock.current = undefined
    overlayMock.useRegisterOverlay.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  test('lets focused input options keep typed digits while arrow keys still move selection', async () => {
    const state = createSelectState({ options })
    const unmount = await renderHarness(
      React.createElement(Harness, { options, state }),
    )

    try {
      expect(overlayMock.useRegisterOverlay).toHaveBeenCalledWith(
        'select',
        true,
      )
      expect(keybindingMock.current?.options).toEqual({
        context: 'Select',
        isActive: true,
      })
      expect(keybindingMock.current?.handlers).toEqual({
        'select:cancel': expect.any(Function),
      })
      expect(inputMock.current?.options.isActive).toBe(true)

      const digitEvent = pressKey('1')
      expect(state.onChange).not.toHaveBeenCalled()
      expect(state.focusOption).not.toHaveBeenCalled()
      expect(state.selectFocusedOption).not.toHaveBeenCalled()
      expect(digitEvent.stopImmediatePropagation).not.toHaveBeenCalled()

      const downEvent = pressKey('', { downArrow: true })
      expect(state.focusNextOption).toHaveBeenCalledTimes(1)
      expect(downEvent.stopImmediatePropagation).toHaveBeenCalledTimes(1)
    } finally {
      unmount()
    }
  })
})
