import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

type CapturedTextInputProps = {
  columns: number
  cursorOffset: number
  dimColor: boolean
  focus: boolean
  multiline: boolean
  onChange: (value: string) => void
  onChangeCursorOffset: (offset: number) => void
  showCursor: boolean
  value: string
}

const textInputMock = vi.hoisted(() => ({
  current: undefined as CapturedTextInputProps | undefined,
}))

vi.mock('../TextInput.js', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')

  return {
    default: (props: CapturedTextInputProps) => {
      textInputMock.current = props
      return ReactActual.createElement('ink-text', null, `input:${props.value}`)
    },
  }
})

import { createRoot } from '../../ink/root.js'
import type { DOMElement, DOMNode } from '../../ink/dom.js'
import instances from '../../ink/instances.js'
import HistorySearchInput from './HistorySearchInput.js'

type TestRoot = Awaited<ReturnType<typeof createRoot>>
type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

const mountedRoots: TestRoot[] = []

afterEach(() => {
  textInputMock.current = undefined

  for (const root of mountedRoots.splice(0)) {
    root.unmount()
  }
})

function collectText(node: DOMNode): string {
  if (node.nodeName === '#text') return node.nodeValue
  return node.childNodes.map(collectText).join('')
}

function createStreams(): {
  stdin: TestStdin
  stdout: PassThrough
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStdin

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()
  ;(stdout as unknown as { columns: number; rows: number }).columns = 80
  ;(stdout as unknown as { columns: number; rows: number }).rows = 24

  return { stdin, stdout }
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)
  if (!instance?.rootNode) throw new Error('Ink root node not found')
  return instance.rootNode
}

async function waitForRender(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30))
}

async function mountHistorySearch(
  props: React.ComponentProps<typeof HistorySearchInput>,
): Promise<{
  rerender: (next: React.ComponentProps<typeof HistorySearchInput>) => void
  text: () => string
}> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  mountedRoots.push(root)

  root.render(<HistorySearchInput {...props} />)
  await waitForRender()

  return {
    rerender: next => root.render(<HistorySearchInput {...next} />),
    text: () => collectText(getRootNode(stdout)),
  }
}

describe('HistorySearchInput wave200-127 coverage', () => {
  test('renders search and failed-match states while forwarding input edits', async () => {
    const onChange = vi.fn()
    const onFailedChange = vi.fn()
    const view = await mountHistorySearch({
      historyFailedMatch: false,
      onChange,
      value: 'build',
    })

    expect(view.text()).toContain('search prompts:')
    expect(view.text()).toContain('input:build')
    expect(textInputMock.current).toMatchObject({
      columns: 6,
      cursorOffset: 5,
      dimColor: true,
      focus: true,
      multiline: false,
      showCursor: true,
      value: 'build',
    })
    expect(textInputMock.current?.onChange).toBe(onChange)

    textInputMock.current?.onChange('deploy')
    expect(onChange).toHaveBeenCalledWith('deploy')
    expect(() => textInputMock.current?.onChangeCursorOffset(1)).not.toThrow()

    view.rerender({
      historyFailedMatch: false,
      onChange,
      value: 'build',
    })
    await waitForRender()

    expect(view.text()).toContain('search prompts:')
    expect(view.text()).toContain('input:build')

    view.rerender({
      historyFailedMatch: true,
      onChange: onFailedChange,
      value: 'deploy now',
    })
    await waitForRender()

    expect(view.text()).toContain('no matching prompt:')
    expect(view.text()).toContain('input:deploy now')
    expect(textInputMock.current).toMatchObject({
      columns: 11,
      cursorOffset: 10,
      dimColor: true,
      focus: true,
      multiline: false,
      showCursor: true,
      value: 'deploy now',
    })
    expect(textInputMock.current?.onChange).toBe(onFailedChange)

    textInputMock.current?.onChange('fallback')
    expect(onFailedChange).toHaveBeenCalledWith('fallback')
  })
})
