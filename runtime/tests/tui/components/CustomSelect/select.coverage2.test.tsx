import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../../ink/root.js'
import { Select, type OptionWithDescription } from './select.js'
import type { UseSelectProps } from './use-select-input.js'

type CapturedInputOptionProps = {
  inputValue: string
  imagesSelected: boolean
  onInputChange: (value: string) => void
  onSubmit: (value: string) => void
  option: OptionWithDescription<string> & { index: number }
  selectedImageIndex: number
}

const selectInputOptionMock = vi.hoisted(() => ({
  props: [] as CapturedInputOptionProps[],
}))

const selectInputHookMock = vi.hoisted(() => ({
  props: undefined as UseSelectProps<string> | undefined,
}))

vi.mock('./select-input-option.js', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')

  return {
    SelectInputOption: (props: CapturedInputOptionProps) => {
      selectInputOptionMock.props.push(props)

      return ReactActual.createElement(
        'ink-text',
        null,
        `input:${props.option.value}=${props.inputValue}`,
      )
    },
  }
})

vi.mock('./use-select-input.js', () => ({
  useSelectInput: (props: UseSelectProps<string>) => {
    selectInputHookMock.props = props
  },
}))

vi.mock('../../../utils/debug.js', () => ({
  logForDebugging: () => {},
}))
vi.mock('../../../bootstrap/state.js', () => ({
  flushInteractionTime: () => {},
  getActiveTimeCounter: () => 0,
  markScrollActivity: () => {},
  updateLastInteractionTime: () => {},
}))
vi.mock('../../../utils/earlyInput.js', () => ({
  stopCapturingEarlyInput: () => {},
}))
vi.mock('../../../utils/envUtils.js', () => ({
  isEnvTruthy: () => false,
}))
vi.mock('../../../utils/fullscreen.js', () => ({
  isMouseClicksDisabled: () => true,
}))
vi.mock('../../../utils/log.js', () => ({
  logError: () => {},
}))

async function waitForRender(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30))
}

type RenderedSelect = {
  rerender: (node: React.ReactNode) => Promise<void>
  unmount: () => void
}

async function renderSelect(node: React.ReactNode): Promise<RenderedSelect> {
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
  ;(stdout as unknown as { columns: number }).columns = 100

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(node)
  await waitForRender()

  return {
    rerender: async nextNode => {
      root.render(nextNode)
      await waitForRender()
    },
    unmount: () => {
      root.unmount()
      stdin.end()
      stdout.end()
    },
  }
}

function latestInputOption(): CapturedInputOptionProps {
  const props = selectInputOptionMock.props.at(-1)
  expect(props).toBeDefined()
  return props!
}

describe('Select input option coverage', () => {
  beforeEach(() => {
    selectInputOptionMock.props = []
    selectInputHookMock.props = undefined
  })

  test('wires compact input updates, empty submit cancellation, and image attachment submit state', async () => {
    const onCancel = vi.fn()
    const onChange = vi.fn()
    const options: OptionWithDescription<string>[] = [
      {
        type: 'input',
        value: 'prompt',
        label: 'Prompt',
        initialValue: 'seed',
        onChange: () => {},
      },
    ]

    const view = await renderSelect(
      <Select
        options={options}
        defaultFocusValue="prompt"
        onCancel={onCancel}
        onChange={onChange}
      />,
    )

    try {
      expect(latestInputOption().inputValue).toBe('seed')

      latestInputOption().onInputChange('typed')
      await waitForRender()
      expect(latestInputOption().inputValue).toBe('typed')

      expect(selectInputHookMock.props?.onEnterImageSelection?.()).toBe(false)

      latestInputOption().onSubmit('   ')
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(onChange).not.toHaveBeenCalled()

      latestInputOption().onSubmit('typed')
      expect(onChange).toHaveBeenCalledWith('prompt')

      await view.rerender(
        <Select
          options={options}
          defaultFocusValue="prompt"
          onCancel={onCancel}
          onChange={onChange}
          pastedContents={{
            7: {
              id: 7,
              type: 'image',
              content: 'image-bytes',
            },
            8: {
              id: 8,
              type: 'image',
              content: 'second-image',
            },
          }}
        />,
      )

      expect(selectInputHookMock.props?.onEnterImageSelection?.()).toBe(true)
      await waitForRender()
      expect(latestInputOption().imagesSelected).toBe(true)
      expect(latestInputOption().selectedImageIndex).toBe(1)

      latestInputOption().onSubmit('')
      expect(onChange).toHaveBeenLastCalledWith('prompt')

      await view.rerender(
        <Select
          options={options}
          defaultFocusValue="prompt"
          onCancel={onCancel}
          onChange={onChange}
          pastedContents={{
            7: {
              id: 7,
              type: 'image',
              content: 'image-bytes',
            },
          }}
        />,
      )
      await waitForRender()
      expect(latestInputOption().imagesSelected).toBe(true)
      expect(latestInputOption().selectedImageIndex).toBe(0)

      await view.rerender(
        <Select
          options={options}
          defaultFocusValue="prompt"
          onCancel={onCancel}
          onChange={onChange}
          pastedContents={{}}
        />,
      )
      await waitForRender()
      expect(latestInputOption().imagesSelected).toBe(false)
      expect(latestInputOption().selectedImageIndex).toBe(0)
    } finally {
      view.unmount()
    }
  })

  test('flushes current input option text before selecting on submit', async () => {
    const optionTextChange = vi.fn()
    const onChange = vi.fn()
    const options: OptionWithDescription<string>[] = [
      {
        type: 'input',
        value: 'feedback',
        label: 'Feedback',
        initialValue: 'old feedback',
        onChange: optionTextChange,
      },
    ]

    const view = await renderSelect(
      <Select
        options={options}
        defaultFocusValue="feedback"
        onChange={onChange}
      />,
    )

    try {
      latestInputOption().onSubmit('new feedback')

      expect(optionTextChange).toHaveBeenCalledWith('new feedback')
      expect(onChange).toHaveBeenCalledWith('feedback')
      expect(optionTextChange.mock.invocationCallOrder[0]).toBeLessThan(
        onChange.mock.invocationCallOrder[0]!,
      )
    } finally {
      view.unmount()
    }
  })

  test('drops draft values when an input option leaves the option set', async () => {
    const firstOptions: OptionWithDescription<string>[] = [
      {
        type: 'input',
        value: 'prompt',
        label: 'Prompt',
        initialValue: 'seed',
        onChange: () => {},
      },
    ]
    const textOnlyOptions: OptionWithDescription<string>[] = [
      {
        value: 'other',
        label: 'Other',
      },
    ]
    const reintroducedOptions: OptionWithDescription<string>[] = [
      {
        type: 'input',
        value: 'prompt',
        label: 'Prompt',
        onChange: () => {},
      },
    ]

    const view = await renderSelect(
      <Select
        options={firstOptions}
        defaultFocusValue="prompt"
      />,
    )

    try {
      expect(latestInputOption().inputValue).toBe('seed')

      latestInputOption().onInputChange('draft')
      await waitForRender()
      expect(latestInputOption().inputValue).toBe('draft')

      const inputRenderCount = selectInputOptionMock.props.length
      await view.rerender(
        <Select
          options={textOnlyOptions}
          defaultFocusValue="other"
        />,
      )
      expect(selectInputOptionMock.props).toHaveLength(inputRenderCount)

      await view.rerender(
        <Select
          options={reintroducedOptions}
          defaultFocusValue="prompt"
        />,
      )
      await waitForRender()

      expect(latestInputOption().inputValue).toBe('')
    } finally {
      view.unmount()
    }
  })
})
