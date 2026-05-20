import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { AlternateScreen } from './AlternateScreen.js'
import Text from './Text.js'
import { TerminalSizeContext } from './TerminalSizeContext.js'
import type { DOMElement } from '../dom.ts'
import {
  deleteInkInstance,
  getInkInstance,
  setInkInstance,
} from '../instances.js'
import { createRoot } from '../root.js'
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
} from '../termio/dec.js'
import { TerminalWriteProvider } from '../useTerminalNotification.js'

type TestStdout = PassThrough & {
  columns: number
  rows: number
  isTTY: boolean
}

type TestStdin = PassThrough & {
  isTTY: boolean
}

function createTestStreams(): {
  stdout: TestStdout
  stdin: TestStdin
} {
  const stdout = new PassThrough() as TestStdout
  const stdin = new PassThrough() as TestStdin

  stdout.columns = 80
  stdout.rows = 24
  stdout.isTTY = false
  stdout.resume()
  stdin.isTTY = false

  return { stdout, stdin }
}

function findAltScreenBox(node: DOMElement): DOMElement | undefined {
  if (
    node.nodeName === 'ink-box' &&
    node.style.flexDirection === 'column' &&
    node.style.height === 7 &&
    node.style.width === '100%'
  ) {
    return node
  }

  for (const child of node.childNodes) {
    if (child.nodeName === '#text') continue
    const found = findAltScreenBox(child)
    if (found) return found
  }

  return undefined
}

function getRootNode(stdout: TestStdout): DOMElement {
  const instance = getInkInstance(stdout as unknown as NodeJS.WriteStream)
  if (!instance?.rootNode) throw new Error('Ink root node not found')
  return instance.rootNode
}

function renderHarness(mouseTracking: boolean | undefined, writeRaw: (data: string) => void) {
  return (
    <TerminalWriteProvider value={writeRaw}>
      <TerminalSizeContext.Provider value={{ columns: 80, rows: 7 }}>
        <AlternateScreen mouseTracking={mouseTracking}>
          <Text>fullscreen body</Text>
        </AlternateScreen>
      </TerminalSizeContext.Provider>
    </TerminalWriteProvider>
  )
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('AlternateScreen coverage', () => {
  test('enters, updates, and exits the alternate screen with viewport-bounded layout', async () => {
    const previousProcessStdoutInk = getInkInstance(process.stdout)
    const fakeInk = {
      clearTextSelection: vi.fn(),
      setAltScreenActive: vi.fn(),
    }
    const writeRaw = vi.fn()
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })
    let mounted = true

    setInkInstance(process.stdout, fakeInk as never)

    try {
      root.render(renderHarness(undefined, writeRaw))

      expect(writeRaw).toHaveBeenCalledWith(
        `${ENTER_ALT_SCREEN}\x1B[2J\x1B[H${ENABLE_MOUSE_TRACKING}`,
      )
      expect(fakeInk.setAltScreenActive).toHaveBeenCalledWith(true, true)
      expect(findAltScreenBox(getRootNode(stdout))?.style).toMatchObject({
        flexDirection: 'column',
        flexShrink: 0,
        height: 7,
        width: '100%',
      })

      root.render(renderHarness(false, writeRaw))

      expect(writeRaw.mock.calls.map(([value]) => value)).toEqual([
        `${ENTER_ALT_SCREEN}\x1B[2J\x1B[H${ENABLE_MOUSE_TRACKING}`,
        `${DISABLE_MOUSE_TRACKING}${EXIT_ALT_SCREEN}`,
        `${ENTER_ALT_SCREEN}\x1B[2J\x1B[H`,
      ])
      expect(fakeInk.setAltScreenActive.mock.calls).toEqual([
        [true, true],
        [false],
        [true, false],
      ])
      expect(fakeInk.clearTextSelection).toHaveBeenCalledTimes(1)

      root.unmount()
      mounted = false

      expect(writeRaw.mock.calls.map(([value]) => value)).toEqual([
        `${ENTER_ALT_SCREEN}\x1B[2J\x1B[H${ENABLE_MOUSE_TRACKING}`,
        `${DISABLE_MOUSE_TRACKING}${EXIT_ALT_SCREEN}`,
        `${ENTER_ALT_SCREEN}\x1B[2J\x1B[H`,
        EXIT_ALT_SCREEN,
      ])
      expect(fakeInk.setAltScreenActive.mock.calls).toEqual([
        [true, true],
        [false],
        [true, false],
        [false],
      ])
      expect(fakeInk.clearTextSelection).toHaveBeenCalledTimes(2)
    } finally {
      if (mounted) root.unmount()
      stdin.end()
      stdout.end()
      deleteInkInstance(process.stdout)
      if (previousProcessStdoutInk) {
        setInkInstance(process.stdout, previousProcessStdoutInk)
      }
      await sleep(25)
    }
  })
})
