import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../../../src/tui/ink/root.js'
import { Text } from '../../../src/tui/ink.js'
import {
  Select,
  type OptionWithDescription,
} from '../../../src/tui/components/CustomSelect/select.js'
import type { UseSelectProps } from '../../../src/tui/components/CustomSelect/use-select-input.js'

type CapturedSelectOptionProps = {
  children: React.ReactNode
  isFocused: boolean
  isSelected: boolean
  shouldShowDownArrow?: boolean
  shouldShowUpArrow?: boolean
}

type CapturedInputOptionProps = {
  imagesSelected?: boolean
  hideIndex?: boolean
  inputValue: string
  isFocused: boolean
  isSelected: boolean
  layout: 'compact' | 'expanded'
  maxIndexWidth: number
  onInputChange: (value: string) => void
  onSubmit: (value: string) => void
  option: Extract<OptionWithDescription<string>, { type: 'input' }> & {
    index: number
  }
  selectedImageIndex?: number
  shouldShowDownArrow: boolean
  shouldShowUpArrow: boolean
  showLabel?: boolean
}

const harness = vi.hoisted(() => ({
  inputOptionProps: [] as CapturedInputOptionProps[],
  selectInputProps: undefined as UseSelectProps<string> | undefined,
  selectOptionProps: [] as CapturedSelectOptionProps[],
}))

vi.mock('../../../src/tui/components/CustomSelect/select-option.js', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')

  return {
    SelectOption: (props: CapturedSelectOptionProps) => {
      harness.selectOptionProps.push(props)

      return ReactActual.createElement(
        'ink-text',
        null,
        [
          'option',
          props.isFocused ? 'focused' : 'blurred',
          props.isSelected ? 'selected' : 'unselected',
          props.shouldShowUpArrow ? 'up' : 'no-up',
          props.shouldShowDownArrow ? 'down' : 'no-down',
        ].join(':'),
      )
    },
  }
})

vi.mock(
  '../../../src/tui/components/CustomSelect/select-input-option.js',
  async () => {
    const ReactActual = await vi.importActual<typeof import('react')>('react')

    return {
      SelectInputOption: (props: CapturedInputOptionProps) => {
        harness.inputOptionProps.push(props)

        return ReactActual.createElement(
          'ink-text',
          null,
          [
            'input',
            props.option.value,
            props.layout,
            props.inputValue,
            props.showLabel ? 'label' : 'placeholder',
            props.shouldShowUpArrow ? 'up' : 'no-up',
            props.shouldShowDownArrow ? 'down' : 'no-down',
            props.imagesSelected ? `image-${props.selectedImageIndex}` : 'no-image',
          ].join(':'),
        )
      },
    }
  },
)

vi.mock('../../../src/tui/components/CustomSelect/use-select-input.js', () => ({
  useSelectInput: (props: UseSelectProps<string>) => {
    harness.selectInputProps = props
  },
}))

vi.mock('../../../src/utils/debug.js', () => ({
  logForDebugging: () => {},
}))
vi.mock('../../../src/bootstrap/state.js', () => ({
  flushInteractionTime: () => {},
  getActiveTimeCounter: () => 0,
  markScrollActivity: () => {},
  updateLastInteractionTime: () => {},
}))
vi.mock('../../../src/utils/earlyInput.js', () => ({
  stopCapturingEarlyInput: () => {},
}))
vi.mock('../../../src/utils/envUtils.js', () => ({
  isEnvTruthy: () => false,
}))
vi.mock('../../../src/utils/fullscreen.js', () => ({
  isMouseClicksDisabled: () => true,
}))
vi.mock('../../../src/utils/log.js', () => ({
  logError: () => {},
}))

type RenderedSelect = {
  dispose: () => Promise<void>
  output: () => string
  rerender: (node: React.ReactNode) => Promise<void>
}

async function sleep(ms = 30): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function renderSelect(node: React.ReactNode): Promise<RenderedSelect> {
  let output = ''
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

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
  ;(stdout as unknown as { columns: number }).columns = 120

  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  root.render(node)
  await sleep()

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(5)
    },
    output: () => stripAnsi(output),
    rerender: async nextNode => {
      root.render(nextNode)
      await sleep()
    },
  }
}

function latestInputOption(): CapturedInputOptionProps {
  const props = harness.inputOptionProps.at(-1)
  expect(props).toBeDefined()
  return props!
}

describe('Select coverage swarm row 011', () => {
  beforeEach(() => {
    harness.inputOptionProps = []
    harness.selectInputProps = undefined
    harness.selectOptionProps = []
  })

  test('renders expanded text options with selected state, descriptions, and upward scroll affordance', async () => {
    const options: OptionWithDescription<string>[] = [
      {
        value: 'alpha',
        label: 'Alpha choice',
        description: 'Hidden above the viewport',
      },
      {
        value: 'beta',
        label: 'Beta choice',
        description: 'Selected expanded description',
      },
      {
        value: 'gamma',
        label: 'Gamma choice',
        description: 'Focused expanded description',
        dimDescription: false,
      },
    ]

    const rendered = await renderSelect(
      <Select
        options={options}
        defaultFocusValue="gamma"
        defaultValue="beta"
        highlightText="Beta"
        layout="expanded"
        visibleOptionCount={2}
      />,
    )

    try {
      expect(rendered.output()).toContain('Selected expanded description')
      expect(rendered.output()).toContain('Focused expanded description')
      expect(rendered.output()).not.toContain('Hidden above the viewport')
      expect(harness.selectOptionProps).toMatchObject([
        {
          isFocused: false,
          isSelected: true,
          shouldShowUpArrow: true,
          shouldShowDownArrow: false,
        },
        {
          isFocused: true,
          isSelected: false,
          shouldShowUpArrow: false,
          shouldShowDownArrow: false,
        },
      ])
    } finally {
      await rendered.dispose()
    }
  })

  test('wires compact-vertical input rows through value changes and empty submit', async () => {
    const onCancel = vi.fn()
    const onChange = vi.fn()
    const options: OptionWithDescription<string>[] = [
      {
        value: 'alpha',
        label: 'Alpha choice',
        description: 'Visible text description',
      },
      {
        type: 'input',
        value: 'prompt',
        label: 'Prompt',
        initialValue: 'draft',
        allowEmptySubmitToCancel: true,
        onChange: () => {},
      },
      {
        value: 'omega',
        label: 'Omega choice',
      },
    ]

    const rendered = await renderSelect(
      <Select
        options={options}
        defaultFocusValue="prompt"
        inlineDescriptions={true}
        layout="compact-vertical"
        onCancel={onCancel}
        onChange={onChange}
        visibleOptionCount={2}
      />,
    )

    try {
      expect(rendered.output()).toContain('Visible text description')
      expect(latestInputOption()).toMatchObject({
        inputValue: 'draft',
        isFocused: true,
        isSelected: false,
        layout: 'compact',
        maxIndexWidth: 1,
        shouldShowDownArrow: true,
        shouldShowUpArrow: false,
        showLabel: true,
      })

      latestInputOption().onInputChange('edited')
      await sleep()
      expect(latestInputOption().inputValue).toBe('edited')

      latestInputOption().onSubmit('')
      expect(onChange).toHaveBeenCalledWith('prompt')
      expect(onCancel).not.toHaveBeenCalled()
      expect(harness.selectInputProps).toMatchObject({
        disableSelection: false,
        isDisabled: false,
        isMultiSelect: false,
      })
    } finally {
      await rendered.dispose()
    }
  })

  test('renders compact two-column descriptions with nested labels and hidden indexes', async () => {
    const options: OptionWithDescription<string>[] = [
      {
        value: 'node-label',
        label: (
          <>
            Node <Text>label</Text>
          </>
        ),
        description: 'Description beside nested label',
      },
      {
        value: 'plain',
        label: 'Plain option',
        description: 'Selected description beside plain label',
        disabled: true,
      },
    ]

    const rendered = await renderSelect(
      <Select
        options={options}
        defaultFocusValue="node-label"
        defaultValue="plain"
        hideIndexes={true}
      />,
    )

    try {
      const output = rendered.output()
      expect(output).toContain('Node label')
      expect(output).toContain('Description beside nested label')
      expect(output).toContain('Plain option')
      expect(output).toContain('Selected description beside plain label')
      expect(output).not.toContain('1.')
      expect(output).not.toContain('2.')
    } finally {
      await rendered.dispose()
    }
  })

  test('enters image selection mode from compact input rows with pasted images', async () => {
    const options: OptionWithDescription<string>[] = [
      {
        type: 'input',
        value: 'prompt',
        label: 'Prompt',
        onChange: () => {},
      },
    ]

    const rendered = await renderSelect(
      <Select
        options={options}
        defaultFocusValue="prompt"
        pastedContents={{
          1: { id: 1, type: 'image', content: 'first' },
          2: { id: 2, type: 'text', content: 'ignored' },
          3: { id: 3, type: 'image', content: 'second' },
        }}
      />,
    )

    try {
      expect(harness.selectInputProps?.onEnterImageSelection?.()).toBe(true)
      await sleep()
      expect(latestInputOption()).toMatchObject({
        imagesSelected: true,
        selectedImageIndex: 1,
      })
    } finally {
      await rendered.dispose()
    }
  })

  test('propagates hidden indexes to compact input rows', async () => {
    const options: OptionWithDescription<string>[] = [
      {
        type: 'input',
        value: 'prompt',
        label: 'Prompt',
        initialValue: 'draft',
        onChange: () => {},
      },
      {
        value: 'plain',
        label: 'Plain option',
      },
    ]

    const rendered = await renderSelect(
      <Select
        options={options}
        defaultFocusValue="prompt"
        hideIndexes={true}
      />,
    )

    try {
      expect(latestInputOption()).toMatchObject({
        hideIndex: true,
        inputValue: 'draft',
        isFocused: true,
      })
      expect(harness.selectInputProps).toMatchObject({
        disableSelection: 'numeric',
      })
    } finally {
      await rendered.dispose()
    }
  })
})
