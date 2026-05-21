import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../../src/utils/staticRender.js'
import { SelectMulti } from '../../../src/tui/components/CustomSelect/SelectMulti.js'
import type {
  MultiSelectState,
  UseMultiSelectStateProps,
} from '../../../src/tui/components/CustomSelect/use-multi-select-state.js'
import type { OptionWithDescription } from '../../../src/tui/components/CustomSelect/select.js'

type TextOption = OptionWithDescription<string>
type InputOption = Extract<OptionWithDescription<string>, { type: 'input' }>

type SelectOptionProps = {
  children: React.ReactNode
  description?: string
  isFocused: boolean
  isSelected: boolean
  shouldShowDownArrow?: boolean
  shouldShowUpArrow?: boolean
}

type InputOptionProps = {
  children: React.ReactNode
  index: number
  inputValue: string
  isFocused: boolean
  isSelected: boolean
  layout: 'compact' | 'expanded'
  maxIndexWidth: number
  onExit?: () => void
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: { width: number; height: number },
    sourcePath?: string,
  ) => void
  onInputChange: (value: string) => void
  onOpenEditor?: (
    currentValue: string,
    setValue: (value: string) => void,
  ) => void
  onRemoveImage?: (id: number) => void
  option: InputOption
  pastedContents?: Record<number, { id: number; content: string; mediaType: string }>
  shouldShowDownArrow: boolean
  shouldShowUpArrow: boolean
}

const harness = vi.hoisted(() => ({
  hookProps: [] as UseMultiSelectStateProps<string>[],
  inputOptionProps: [] as InputOptionProps[],
  selectOptionProps: [] as SelectOptionProps[],
  state: undefined as MultiSelectState<string> | undefined,
}))

vi.mock(
  '../../../src/tui/components/CustomSelect/use-multi-select-state.js',
  () => ({
    useMultiSelectState: (props: UseMultiSelectStateProps<string>) => {
      harness.hookProps.push(props)
      if (!harness.state) {
        throw new Error('missing SelectMulti state test double')
      }
      return harness.state
    },
  }),
)

vi.mock(
  '../../../src/tui/components/CustomSelect/select-option.js',
  () => ({
    SelectOption: (props: SelectOptionProps) => {
      harness.selectOptionProps.push(props)
      return <>{props.children}</>
    },
  }),
)

vi.mock(
  '../../../src/tui/components/CustomSelect/select-input-option.js',
  () => ({
    SelectInputOption: (props: InputOptionProps) => {
      harness.inputOptionProps.push(props)
      return (
        <>
          {props.children}
          <ink-text>{`input:${props.option.value}:${props.inputValue}`}</ink-text>
        </>
      )
    },
  }),
)

function textOption(value: string, index?: number): TextOption & { index?: number } {
  return {
    label: `Option ${value}`,
    value,
    description: `Description ${value}`,
    ...(index === undefined ? {} : { index }),
  }
}

function inputOption(value: string, index?: number): InputOption & { index?: number } {
  return {
    type: 'input',
    label: `Input ${value}`,
    value,
    onChange: vi.fn(),
    ...(index === undefined ? {} : { index }),
  }
}

function options(count: number): TextOption[] {
  return Array.from({ length: count }, (_, index) =>
    textOption(String(index + 1)),
  )
}

function state(
  overrides: Partial<MultiSelectState<string>> = {},
): MultiSelectState<string> {
  const baseOptions = options(3)
  return {
    focusedValue: '1',
    inputValues: new Map(),
    isInInput: false,
    isSubmitFocused: false,
    onCancel: vi.fn(),
    options: baseOptions,
    selectedValues: [],
    updateInputValue: vi.fn(),
    visibleFromIndex: 0,
    visibleOptions: [
      { ...baseOptions[0]!, index: 0 },
      { ...baseOptions[1]!, index: 1 },
    ],
    visibleToIndex: 2,
    ...overrides,
  }
}

describe('SelectMulti coverage swarm row 134', () => {
  beforeEach(() => {
    harness.hookProps = []
    harness.inputOptionProps = []
    harness.selectOptionProps = []
    harness.state = state()
  })

  test('passes uncommon configuration through to the state hook', async () => {
    const onCancel = vi.fn()
    const onChange = vi.fn()
    const onDownFromLastItem = vi.fn()
    const onFocus = vi.fn()
    const onSubmit = vi.fn()
    const onUpFromFirstItem = vi.fn()
    const selectOptions = options(2)

    await renderToString(
      <SelectMulti
        defaultValue={['2']}
        focusValue="2"
        hideIndexes={true}
        initialFocusLast={true}
        isDisabled={true}
        onCancel={onCancel}
        onChange={onChange}
        onDownFromLastItem={onDownFromLastItem}
        onFocus={onFocus}
        onSubmit={onSubmit}
        onUpFromFirstItem={onUpFromFirstItem}
        options={selectOptions}
        submitButtonText="Apply"
        visibleOptionCount={7}
      />,
      120,
    )

    expect(harness.hookProps.at(-1)).toMatchObject({
      defaultValue: ['2'],
      focusValue: '2',
      hideIndexes: true,
      initialFocusLast: true,
      isDisabled: true,
      onCancel,
      onChange,
      onDownFromLastItem,
      onFocus,
      onSubmit,
      onUpFromFirstItem,
      options: selectOptions,
      submitButtonText: 'Apply',
      visibleOptionCount: 7,
    })
  })

  test('renders high-index text rows and keeps option focus off while submit is focused', async () => {
    const allOptions = options(12)
    harness.state = state({
      focusedValue: '10',
      isSubmitFocused: true,
      selectedValues: ['9'],
      visibleFromIndex: 8,
      visibleOptions: [
        { ...textOption('9'), index: 8 },
        { ...textOption('10'), index: 9 },
      ],
      visibleToIndex: 10,
    })

    const output = await renderToString(
      <SelectMulti
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        options={allOptions}
        submitButtonText="Apply"
        visibleOptionCount={2}
      />,
      120,
    )

    expect(output).toContain('9.')
    expect(output).toContain('10.')
    expect(output).toContain('Option 9')
    expect(output).toContain('Option 10')
    expect(output).toContain('Apply')
    expect(harness.selectOptionProps).toMatchObject([
      {
        isFocused: false,
        isSelected: false,
        shouldShowDownArrow: false,
        shouldShowUpArrow: true,
      },
      {
        isFocused: false,
        isSelected: false,
        shouldShowDownArrow: true,
        shouldShowUpArrow: false,
      },
    ])
  })

  test('renders input rows with empty fallback values and forwards helper callbacks', async () => {
    const updateInputValue = vi.fn()
    const onCancel = vi.fn()
    const onImagePaste = vi.fn()
    const onOpenEditor = vi.fn()
    const onRemoveImage = vi.fn()
    const typedOption = inputOption('typed', 9)
    const pastedContents = {
      4: { id: 4, content: 'image-data', mediaType: 'image/png' },
    }

    harness.state = state({
      focusedValue: 'typed',
      inputValues: new Map(),
      selectedValues: ['typed'],
      updateInputValue,
      visibleFromIndex: 9,
      visibleOptions: [typedOption],
      visibleToIndex: 10,
    })

    const output = await renderToString(
      <SelectMulti
        onCancel={onCancel}
        onImagePaste={onImagePaste}
        onOpenEditor={onOpenEditor}
        onRemoveImage={onRemoveImage}
        options={[...options(9), typedOption, ...options(2)]}
        pastedContents={pastedContents}
      />,
      120,
    )

    expect(output).toContain('input:typed:')
    expect(harness.inputOptionProps).toHaveLength(1)
    expect(harness.inputOptionProps[0]).toMatchObject({
      index: 10,
      inputValue: '',
      isFocused: true,
      isSelected: false,
      layout: 'compact',
      maxIndexWidth: 2,
      onImagePaste,
      onOpenEditor,
      onRemoveImage,
      option: typedOption,
      pastedContents,
      shouldShowDownArrow: true,
      shouldShowUpArrow: true,
    })

    harness.inputOptionProps[0]!.onInputChange('new value')
    expect(updateInputValue).toHaveBeenCalledWith('typed', 'new value')

    harness.inputOptionProps[0]!.onExit?.()
    expect(onCancel).toHaveBeenCalledOnce()
  })

  test('does not render a submit button unless both label and handler are present', async () => {
    harness.state = state()
    const withTextOnly = await renderToString(
      <SelectMulti
        onCancel={vi.fn()}
        options={options(1)}
        submitButtonText="Apply"
      />,
      120,
    )

    harness.state = state()
    const withHandlerOnly = await renderToString(
      <SelectMulti
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        options={options(1)}
      />,
      120,
    )

    expect(withTextOnly).not.toContain('Apply')
    expect(withHandlerOnly).not.toContain('Apply')
  })
})
