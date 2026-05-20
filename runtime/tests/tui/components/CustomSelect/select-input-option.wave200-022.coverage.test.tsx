import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../../ink/root.js'
import { SelectInputOption } from './select-input-option.js'

const textInputMock = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | {
        columns: number
        cursorOffset: number
        onChange: (value: string) => void
        onChangeCursorOffset: (offset: number) => void
        onPaste: (value: string) => void
        placeholder?: string
        value: string
      },
}))

vi.mock('../../keybindings/useKeybinding.js', () => ({
  useKeybinding: () => {},
  useKeybindings: () => {},
}))

vi.mock('../TextInput.js', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')

  return {
    default: (props: typeof textInputMock.current) => {
      textInputMock.current = props
      return ReactActual.createElement(
        'ink-text',
        null,
        props?.value || props?.placeholder || '',
      )
    },
  }
})

type TestRoot = Awaited<ReturnType<typeof createRoot>>

const mountedRoots: TestRoot[] = []

async function waitForRender(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30))
}

async function renderOption(node: React.ReactNode): Promise<TestRoot> {
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
  ;(stdout as unknown as { columns: number }).columns = 80

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  mountedRoots.push(root)

  root.render(node)
  await waitForRender()

  return root
}

describe('SelectInputOption unlabeled input coverage', () => {
  afterEach(() => {
    textInputMock.current = undefined
    for (const root of mountedRoots.splice(0)) {
      root.unmount()
    }
  })

  test('routes unlabeled edits and cursor-positioned paste through both change callbacks', async () => {
    const optionOnChange = vi.fn()
    const onInputChange = vi.fn()

    await renderOption(
      <SelectInputOption
        option={{
          label: 'Prompt fallback',
          onChange: optionOnChange,
          type: 'input',
        }}
        isFocused
        isSelected={false}
        shouldShowDownArrow={false}
        shouldShowUpArrow={false}
        maxIndexWidth={2}
        index={4}
        inputValue="abc"
        onInputChange={onInputChange}
        onSubmit={() => {}}
        layout="compact"
      />,
    )

    expect(textInputMock.current).toMatchObject({
      cursorOffset: 3,
      placeholder: 'Prompt fallback',
      value: 'abc',
    })

    textInputMock.current?.onChange('typed')
    expect(onInputChange).toHaveBeenCalledWith('typed')
    expect(optionOnChange).toHaveBeenCalledWith('typed')

    textInputMock.current?.onChangeCursorOffset(1)
    await waitForRender()

    expect(textInputMock.current?.cursorOffset).toBe(1)

    textInputMock.current?.onPaste('!')
    expect(onInputChange).toHaveBeenLastCalledWith('a!bc')
    expect(optionOnChange).toHaveBeenLastCalledWith('a!bc')
  })
})
