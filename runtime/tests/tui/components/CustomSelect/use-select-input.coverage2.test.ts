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
  useKeybindings: vi.fn(),
}))

function createSelectState(
  options: OptionWithDescription<string>[],
  overrides: Partial<SelectState<string>> = {},
): SelectState<string> {
  return {
    focusedValue: 'alpha',
    focusedIndex: 1,
    visibleFromIndex: 0,
    visibleToIndex: options.length - 1,
    value: undefined,
    options,
    visibleOptions: [],
    isInInput: false,
    focusNextOption: vi.fn(),
    focusPreviousOption: vi.fn(),
    focusNextPage: vi.fn(),
    focusPreviousPage: vi.fn(),
    focusOption: vi.fn(),
    selectFocusedOption: vi.fn(),
    onChange: vi.fn(),
    ...overrides,
  }
}

function Harness({
  inputValues,
  options,
  state,
}: {
  inputValues: Map<string, string>
  options: OptionWithDescription<string>[]
  state: SelectState<string>
}): null {
  useSelectInput({ inputValues, options, state })
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

describe('useSelectInput numeric shortcuts', () => {
  const options: OptionWithDescription<string>[] = [
    { value: 'alpha', label: 'Alpha' },
    {
      type: 'input',
      value: 'prompt',
      label: 'Prompt',
      onChange: vi.fn(),
    },
    {
      type: 'input',
      value: 'cancel-empty',
      label: 'Cancel empty',
      onChange: vi.fn(),
      allowEmptySubmitToCancel: true,
    },
    {
      type: 'input',
      value: 'empty-prompt',
      label: 'Empty prompt',
      onChange: vi.fn(),
    },
    { value: 'disabled', label: 'Disabled', disabled: true },
  ]

  beforeEach(() => {
    inputMock.current = undefined
    overlayMock.useRegisterOverlay.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  test('routes number keys through input option submit and focus rules', async () => {
    const state = createSelectState(options)
    const inputValues = new Map<string, string>([
      ['prompt', 'ready to submit'],
      ['cancel-empty', ''],
      ['empty-prompt', '   '],
    ])
    const unmount = await renderHarness(
      React.createElement(Harness, { inputValues, options, state }),
    )

    try {
      expect(overlayMock.useRegisterOverlay).toHaveBeenCalledWith(
        'select',
        false,
      )
      expect(inputMock.current?.options.isActive).toBe(true)

      pressKey('5')
      expect(state.onChange).not.toHaveBeenCalled()
      expect(state.focusOption).not.toHaveBeenCalled()

      pressKey('2')
      expect(state.onChange).toHaveBeenCalledWith('prompt')
      expect(state.focusOption).not.toHaveBeenCalled()

      pressKey('3')
      expect(state.onChange).toHaveBeenNthCalledWith(2, 'cancel-empty')
      expect(state.focusOption).not.toHaveBeenCalled()

      pressKey('4')
      expect(state.focusOption).toHaveBeenCalledWith('empty-prompt')
      expect(state.onChange).toHaveBeenCalledTimes(2)

      pressKey('1')
      expect(state.onChange).toHaveBeenNthCalledWith(3, 'alpha')
      expect(state.selectFocusedOption).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })
})
