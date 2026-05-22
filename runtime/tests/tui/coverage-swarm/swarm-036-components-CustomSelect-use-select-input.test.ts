import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { OptionWithDescription } from '../../../src/tui/components/CustomSelect/select.js'
import { useSelectInput } from '../../../src/tui/components/CustomSelect/use-select-input.js'
import type {
  SelectState,
} from '../../../src/tui/components/CustomSelect/use-select-state.js'
import { createRoot } from '../../../src/tui/ink/root.js'

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

vi.mock('../../../src/tui/context/overlayContext.js', () => ({
  useRegisterOverlay: overlayMock.useRegisterOverlay,
}))

vi.mock('../../../src/tui/ink.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/tui/ink.js')>()
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

vi.mock('../../../src/tui/keybindings/useKeybinding.js', () => ({
  useKeybindings: (
    handlers: Record<string, () => void>,
    options: { context?: string; isActive?: boolean },
  ) => {
    keybindingMock.current = { handlers, options }
  },
}))

function createSelectState(
  options: OptionWithDescription<string>[],
  overrides: Partial<SelectState<string>> = {},
): SelectState<string> {
  return {
    focusedValue: options[0]?.value,
    focusedIndex: 1,
    visibleFromIndex: 0,
    visibleToIndex: options.length - 1,
    value: undefined,
    options,
    visibleOptions: options.map((option, index) => ({ ...option, index })),
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
  disableSelection,
  imagesSelected,
  inputValues,
  isDisabled,
  isMultiSelect,
  onDownFromLastItem,
  onEnterImageSelection,
  onInputModeToggle,
  onUpFromFirstItem,
  options,
  state,
}: {
  disableSelection?: boolean | 'numeric'
  imagesSelected?: boolean
  inputValues?: Map<string, string>
  isDisabled?: boolean
  isMultiSelect?: boolean
  onDownFromLastItem?: () => void
  onEnterImageSelection?: () => boolean
  onInputModeToggle?: (value: string) => void
  onUpFromFirstItem?: () => void
  options: OptionWithDescription<string>[]
  state: SelectState<string>
}): null {
  useSelectInput({
    disableSelection,
    imagesSelected,
    inputValues,
    isDisabled,
    isMultiSelect,
    onDownFromLastItem,
    onEnterImageSelection,
    onInputModeToggle,
    onUpFromFirstItem,
    options,
    state,
  })
  return null
}

async function renderHarness(
  props: React.ComponentProps<typeof Harness>,
): Promise<() => void> {
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

  root.render(React.createElement(Harness, props))
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

function keybinding(name: string): () => void {
  const handler = keybindingMock.current?.handlers[name]
  expect(handler).toBeDefined()
  return handler!
}

describe('useSelectInput coverage swarm row 036', () => {
  beforeEach(() => {
    inputMock.current = undefined
    keybindingMock.current = undefined
    overlayMock.useRegisterOverlay.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  test('registers inactive input and keybinding handlers without cancel or navigation handlers', async () => {
    const options: OptionWithDescription<string>[] = [
      { value: 'alpha', label: 'Alpha' },
      { type: 'input', value: 'prompt', label: 'Prompt', onChange: vi.fn() },
    ]
    const state = createSelectState(options, {
      focusedValue: 'prompt',
      onCancel: undefined,
    })
    const unmount = await renderHarness({
      isDisabled: true,
      options,
      state,
    })

    try {
      expect(overlayMock.useRegisterOverlay).toHaveBeenCalledWith(
        'select',
        false,
      )
      expect(keybindingMock.current).toEqual({
        handlers: {},
        options: { context: 'Select', isActive: false },
      })
      expect(inputMock.current?.options).toEqual({ isActive: false })
    } finally {
      unmount()
    }
  })

  test('drives keybinding navigation, boundary callbacks, accept guards, and cancel', async () => {
    const options: OptionWithDescription<string>[] = [
      { value: 'alpha', label: 'Alpha' },
      { value: 'disabled', label: 'Disabled', disabled: true },
      { value: 'omega', label: 'Omega' },
    ]
    const state = createSelectState(options, {
      focusedValue: 'alpha',
    })
    const onDownFromLastItem = vi.fn()
    const onUpFromFirstItem = vi.fn()
    const unmount = await renderHarness({
      onDownFromLastItem,
      onUpFromFirstItem,
      options,
      state,
    })

    try {
      keybinding('select:next')()
      expect(state.focusNextOption).toHaveBeenCalledTimes(1)

      state.focusedValue = 'omega'
      keybinding('select:next')()
      expect(onDownFromLastItem).toHaveBeenCalledTimes(1)
      expect(state.focusNextOption).toHaveBeenCalledTimes(1)

      state.visibleFromIndex = 1
      keybinding('select:previous')()
      expect(state.focusPreviousOption).toHaveBeenCalledTimes(1)

      state.visibleFromIndex = 0
      state.focusedValue = 'alpha'
      keybinding('select:previous')()
      expect(onUpFromFirstItem).toHaveBeenCalledTimes(1)
      expect(state.focusPreviousOption).toHaveBeenCalledTimes(1)

      state.focusedValue = 'disabled'
      keybinding('select:accept')()
      expect(state.selectFocusedOption).not.toHaveBeenCalled()
      expect(state.onChange).not.toHaveBeenCalled()

      state.focusedValue = undefined
      keybinding('select:accept')()
      expect(state.selectFocusedOption).not.toHaveBeenCalled()
      expect(state.onChange).not.toHaveBeenCalled()

      state.focusedValue = 'alpha'
      keybinding('select:accept')()
      expect(state.selectFocusedOption).toHaveBeenCalledTimes(1)
      expect(state.onChange).toHaveBeenCalledWith('alpha')

      keybinding('select:cancel')()
      expect(state.onCancel).toHaveBeenCalledTimes(1)
    } finally {
      unmount()
    }
  })

  test('does not accept from keybindings when selection is fully disabled', async () => {
    const options: OptionWithDescription<string>[] = [
      { value: 'alpha', label: 'Alpha' },
    ]
    const state = createSelectState(options)
    const unmount = await renderHarness({
      disableSelection: true,
      options,
      state,
    })

    try {
      keybinding('select:accept')()
      expect(state.selectFocusedOption).not.toHaveBeenCalled()
      expect(state.onChange).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  test('handles input-mode tab, image handoff, arrow navigation, and edge callbacks', async () => {
    const options: OptionWithDescription<string>[] = [
      {
        type: 'input',
        value: 'first',
        label: 'First',
        onChange: vi.fn(),
      },
      {
        type: 'input',
        value: 'prompt',
        label: 'Prompt',
        onChange: vi.fn(),
      },
      {
        type: 'input',
        value: 'last',
        label: 'Last',
        onChange: vi.fn(),
      },
    ]
    const state = createSelectState(options, {
      focusedValue: 'prompt',
      isInInput: true,
    })
    const onDownFromLastItem = vi.fn()
    const onEnterImageSelection = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false)
    const onInputModeToggle = vi.fn()
    const onUpFromFirstItem = vi.fn()
    const unmount = await renderHarness({
      onDownFromLastItem,
      onEnterImageSelection,
      onInputModeToggle,
      onUpFromFirstItem,
      options,
      state,
    })

    try {
      pressInput('', { tab: true })
      expect(onInputModeToggle).toHaveBeenCalledWith('prompt')

      const imageEvent = pressInput('', { downArrow: true })
      expect(onEnterImageSelection).toHaveBeenCalledTimes(1)
      expect(imageEvent.stopImmediatePropagation).toHaveBeenCalledTimes(1)
      expect(state.focusNextOption).not.toHaveBeenCalled()

      const downEvent = pressInput('', { downArrow: true })
      expect(state.focusNextOption).toHaveBeenCalledTimes(1)
      expect(downEvent.stopImmediatePropagation).toHaveBeenCalledTimes(1)

      const ctrlNEvent = pressInput('n', { ctrl: true })
      expect(state.focusNextOption).toHaveBeenCalledTimes(2)
      expect(ctrlNEvent.stopImmediatePropagation).toHaveBeenCalledTimes(1)

      state.focusedValue = 'last'
      const lastEvent = pressInput('', { downArrow: true })
      expect(onDownFromLastItem).toHaveBeenCalledTimes(1)
      expect(lastEvent.stopImmediatePropagation).toHaveBeenCalledTimes(1)
      expect(state.focusNextOption).toHaveBeenCalledTimes(2)

      state.focusedValue = 'prompt'
      const ctrlPEvent = pressInput('p', { ctrl: true })
      expect(state.focusPreviousOption).toHaveBeenCalledTimes(1)
      expect(ctrlPEvent.stopImmediatePropagation).toHaveBeenCalledTimes(1)

      state.focusedValue = 'first'
      const firstEvent = pressInput('', { upArrow: true })
      expect(onUpFromFirstItem).toHaveBeenCalledTimes(1)
      expect(firstEvent.stopImmediatePropagation).toHaveBeenCalledTimes(1)
      expect(state.focusPreviousOption).toHaveBeenCalledTimes(1)

      const digitEvent = pressInput('7')
      expect(digitEvent.stopImmediatePropagation).not.toHaveBeenCalled()
      expect(state.onChange).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  test('suppresses input handling while image selection is active', async () => {
    const options: OptionWithDescription<string>[] = [
      { type: 'input', value: 'prompt', label: 'Prompt', onChange: vi.fn() },
    ]
    const state = createSelectState(options, {
      focusedValue: 'prompt',
      isInInput: true,
    })
    const onEnterImageSelection = vi.fn()
    const unmount = await renderHarness({
      imagesSelected: true,
      onEnterImageSelection,
      options,
      state,
    })

    try {
      const event = pressInput('', { downArrow: true })
      expect(onEnterImageSelection).not.toHaveBeenCalled()
      expect(state.focusNextOption).not.toHaveBeenCalled()
      expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  test('handles non-input paging, multi-select spaces, and numeric shortcut targets', async () => {
    const options: OptionWithDescription<string>[] = [
      { value: 'alpha', label: 'Alpha' },
      { value: 'disabled', label: 'Disabled', disabled: true },
      {
        type: 'input',
        value: 'ready',
        label: 'Ready',
        onChange: vi.fn(),
      },
      {
        type: 'input',
        value: 'cancel',
        label: 'Cancel',
        onChange: vi.fn(),
        allowEmptySubmitToCancel: true,
      },
      {
        type: 'input',
        value: 'empty',
        label: 'Empty',
        onChange: vi.fn(),
      },
      { value: 'omega', label: 'Omega' },
    ]
    const state = createSelectState(options, {
      focusedValue: 'alpha',
    })
    const inputValues = new Map<string, string>([
      ['ready', ' submit '],
      ['cancel', ''],
      ['empty', '   '],
    ])
    const unmount = await renderHarness({
      inputValues,
      isMultiSelect: true,
      options,
      state,
    })

    try {
      pressInput('', { pageDown: true })
      expect(state.focusNextPage).toHaveBeenCalledTimes(1)

      pressInput('', { pageUp: true })
      expect(state.focusPreviousPage).toHaveBeenCalledTimes(1)

      pressInput('\u3000')
      expect(state.selectFocusedOption).toHaveBeenCalledTimes(1)
      expect(state.onChange).toHaveBeenCalledWith('alpha')

      state.focusedValue = 'disabled'
      pressInput(' ')
      expect(state.selectFocusedOption).toHaveBeenCalledTimes(1)
      expect(state.onChange).toHaveBeenCalledTimes(1)

      state.focusedValue = undefined
      pressInput(' ')
      expect(state.selectFocusedOption).toHaveBeenCalledTimes(1)
      expect(state.onChange).toHaveBeenCalledTimes(1)

      pressInput('0')
      pressInput('9')
      expect(state.onChange).toHaveBeenCalledTimes(1)

      pressInput('2')
      expect(state.onChange).toHaveBeenCalledTimes(1)

      pressInput('3')
      expect(state.onChange).toHaveBeenNthCalledWith(2, 'ready')

      pressInput('4')
      expect(state.onChange).toHaveBeenNthCalledWith(3, 'cancel')

      pressInput('5')
      expect(state.focusOption).toHaveBeenCalledWith('empty')
      expect(state.onChange).toHaveBeenCalledTimes(3)

      pressInput('\uff16')
      expect(state.onChange).toHaveBeenNthCalledWith(4, 'omega')
    } finally {
      unmount()
    }
  })

  test('keeps page navigation but suppresses selection input when selection is disabled', async () => {
    const options: OptionWithDescription<string>[] = [
      { value: 'alpha', label: 'Alpha' },
      { value: 'omega', label: 'Omega' },
    ]
    const state = createSelectState(options)
    const unmount = await renderHarness({
      disableSelection: true,
      isMultiSelect: true,
      options,
      state,
    })

    try {
      pressInput('', { pageDown: true })
      expect(state.focusNextPage).toHaveBeenCalledTimes(1)

      pressInput(' ')
      pressInput('1')
      expect(state.selectFocusedOption).not.toHaveBeenCalled()
      expect(state.onChange).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  test('allows multi-select spaces but suppresses numeric shortcuts in numeric-only disabled mode', async () => {
    const options: OptionWithDescription<string>[] = [
      { value: 'alpha', label: 'Alpha' },
      { value: 'omega', label: 'Omega' },
    ]
    const state = createSelectState(options)
    const unmount = await renderHarness({
      disableSelection: 'numeric',
      isMultiSelect: true,
      options,
      state,
    })

    try {
      pressInput('1')
      expect(state.onChange).not.toHaveBeenCalled()

      pressInput(' ')
      expect(state.selectFocusedOption).toHaveBeenCalledTimes(1)
      expect(state.onChange).toHaveBeenCalledWith('alpha')
    } finally {
      unmount()
    }
  })
})
