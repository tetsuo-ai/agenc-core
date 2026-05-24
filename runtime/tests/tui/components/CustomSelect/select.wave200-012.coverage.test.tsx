import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../../ink/root.js'
import { Select, type OptionWithDescription } from './select.js'
import type { UseSelectProps } from './use-select-input.js'

type CapturedInputOptionProps = {
  inputValue: string
  onInputChange: (value: string) => void
  option: OptionWithDescription<string> & { index: number }
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

function inputOption(initialValue?: string): OptionWithDescription<string> {
  return {
    type: 'input',
    value: 'prompt',
    label: 'Prompt',
    initialValue,
    onChange: () => {},
  }
}

function latestInputOption(): CapturedInputOptionProps {
  const props = selectInputOptionMock.props.at(-1)
  expect(props).toBeDefined()
  return props!
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

describe('Select input initial value coverage', () => {
  beforeEach(() => {
    selectInputOptionMock.props = []
    selectInputHookMock.props = undefined
  })

  test('syncs changed initial values until the user edits the input', async () => {
    const view = await renderSelect(
      <Select
        options={[inputOption('draft one')]}
        defaultFocusValue="prompt"
      />,
    )

    try {
      expect(latestInputOption().inputValue).toBe('draft one')

      await view.rerender(
        <Select
          options={[inputOption('draft two')]}
          defaultFocusValue="prompt"
        />,
      )
      await waitForRender()
      expect(latestInputOption().inputValue).toBe('draft two')
      expect(selectInputHookMock.props?.inputValues?.get('prompt')).toBe(
        'draft two',
      )

      await view.rerender(
        <Select
          options={[inputOption()]}
          defaultFocusValue="prompt"
        />,
      )
      await waitForRender()
      expect(latestInputOption().inputValue).toBe('')
      expect(selectInputHookMock.props?.inputValues?.get('prompt')).toBe('')

      await view.rerender(
        <Select
          options={[inputOption('draft three')]}
          defaultFocusValue="prompt"
        />,
      )
      await waitForRender()
      expect(latestInputOption().inputValue).toBe('draft three')

      latestInputOption().onInputChange('user override')
      await waitForRender()
      expect(latestInputOption().inputValue).toBe('user override')

      await view.rerender(
        <Select
          options={[inputOption('draft three')]}
          defaultFocusValue="prompt"
        />,
      )
      await waitForRender()
      expect(latestInputOption().inputValue).toBe('user override')
    } finally {
      view.unmount()
    }
  })
})
