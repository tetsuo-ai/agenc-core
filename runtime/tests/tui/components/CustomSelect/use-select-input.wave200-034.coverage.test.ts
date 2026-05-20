import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

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

type CapturedKeybindings = {
  handlers: Record<string, () => void>
  options: { context?: string; isActive?: boolean }
}

const inputMock = vi.hoisted(() => ({
  current: undefined as CapturedInput | undefined,
}))

const keybindingMock = vi.hoisted(() => ({
  current: undefined as CapturedKeybindings | undefined,
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

const options: OptionWithDescription<string>[] = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'disabled', label: 'Disabled', disabled: true },
  { value: 'omega', label: 'Omega' },
]

function createSelectState(
  overrides: Partial<SelectState<string>> = {},
): SelectState<string> {
  return {
    focusedValue: 'omega',
    focusedIndex: 2,
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
    onCancel: vi.fn(),
    ...overrides,
  }
}

function Harness({
  state,
  onDownFromLastItem,
  onUpFromFirstItem,
}: {
  state: SelectState<string>
  onDownFromLastItem: () => void
  onUpFromFirstItem: () => void
}): null {
  useSelectInput({
    disableSelection: 'numeric',
    isMultiSelect: true,
    onDownFromLastItem,
    onUpFromFirstItem,
    options,
    state,
  })
  return null
}

async function renderHarness(node: React.ReactNode): Promise<() => void> {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
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

function pressInput(input: string, key: InputKey = {}): InputEventStub {
  const event = {
    stopImmediatePropagation: vi.fn(),
  }

  expect(inputMock.current).toBeDefined()
  inputMock.current!.handler(input, key, event)
  return event
}

function handler(name: string): () => void {
  const fn = keybindingMock.current?.handlers[name]
  expect(fn).toBeDefined()
  return fn!
}

describe('useSelectInput keybinding and non-input input coverage', () => {
  beforeEach(() => {
    inputMock.current = undefined
    keybindingMock.current = undefined
    overlayMock.useRegisterOverlay.mockClear()
  })

  test('handles boundary keybindings, accept states, pages, spaces, and numeric suppression', async () => {
    const state = createSelectState()
    const onDownFromLastItem = vi.fn()
    const onUpFromFirstItem = vi.fn()

    const unmount = await renderHarness(
      React.createElement(Harness, {
        onDownFromLastItem,
        onUpFromFirstItem,
        state,
      }),
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
      expect(inputMock.current?.options).toEqual({ isActive: true })

      handler('select:next')()
      expect(onDownFromLastItem).toHaveBeenCalledTimes(1)
      expect(state.focusNextOption).not.toHaveBeenCalled()

      state.focusedValue = 'alpha'
      handler('select:previous')()
      expect(onUpFromFirstItem).toHaveBeenCalledTimes(1)
      expect(state.focusPreviousOption).not.toHaveBeenCalled()

      state.focusedValue = 'disabled'
      handler('select:accept')()
      expect(state.selectFocusedOption).not.toHaveBeenCalled()
      expect(state.onChange).not.toHaveBeenCalled()

      state.focusedValue = undefined
      handler('select:accept')()
      expect(state.selectFocusedOption).not.toHaveBeenCalled()
      expect(state.onChange).not.toHaveBeenCalled()

      state.focusedValue = 'alpha'
      handler('select:accept')()
      expect(state.selectFocusedOption).toHaveBeenCalledTimes(1)
      expect(state.onChange).toHaveBeenCalledWith('alpha')

      handler('select:cancel')()
      expect(state.onCancel).toHaveBeenCalledTimes(1)

      pressInput('', { pageDown: true })
      expect(state.focusNextPage).toHaveBeenCalledTimes(1)

      pressInput('', { pageUp: true })
      expect(state.focusPreviousPage).toHaveBeenCalledTimes(1)

      vi.mocked(state.selectFocusedOption).mockClear()
      vi.mocked(state.onChange).mockClear()
      pressInput('\u3000')
      expect(state.selectFocusedOption).toHaveBeenCalledTimes(1)
      expect(state.onChange).toHaveBeenCalledWith('alpha')

      vi.mocked(state.selectFocusedOption).mockClear()
      vi.mocked(state.onChange).mockClear()
      pressInput('2')
      expect(state.selectFocusedOption).not.toHaveBeenCalled()
      expect(state.onChange).not.toHaveBeenCalled()

      state.focusedValue = 'disabled'
      pressInput(' ')
      expect(state.selectFocusedOption).not.toHaveBeenCalled()
      expect(state.onChange).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })
})
