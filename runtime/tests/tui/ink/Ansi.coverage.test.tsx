import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { Ansi } from './Ansi.js'
import type { DOMElement } from './dom.ts'
import instances from './instances.ts'
import { createRoot } from './root.ts'
import { squashTextNodesToSegments } from './squash-text-nodes.js'

vi.mock('../../utils/fullscreen.js', () => ({
  isMouseClicksDisabled: () => false,
}))

type TestStdin = PassThrough & {
  isTTY: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}

function createTestStreams(): {
  stdout: PassThrough
  stdin: TestStdin
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStdin

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 80
  ;(stdout as unknown as { rows: number }).rows = 24
  ;(stdout as unknown as { isTTY: boolean }).isTTY = true

  return { stdout, stdin }
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)
  if (!instance?.rootNode) throw new Error('Ink root node not found')
  return instance.rootNode
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('Ansi coverage', () => {
  test('renders ANSI styles, resets, and OSC 8 links as structured text segments', async () => {
    const previousForceHyperlink = process.env.FORCE_HYPERLINK
    process.env.FORCE_HYPERLINK = '1'

    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(
        <Ansi>
          {
            'plain ' +
            '\x1b[1;31mbold-red\x1b[22;39m ' +
            '\x1b[3;4;9;7;38;5;202;48;2;10;20;30mstyled\x1b[0m ' +
            '\x1b]8;;https://example.test/docs\x07linked\x1b]8;;\x07'
          }
        </Ansi>,
      )
      await sleep(25)

      const segments = squashTextNodesToSegments(getRootNode(stdout))

      expect(segments.map(segment => segment.text).join('')).toBe(
        'plain bold-red styled linked',
      )
      expect(segments).toEqual([
        { text: 'plain ', styles: {} },
        { text: 'bold-red', styles: { bold: true, color: 'ansi:red' } },
        { text: ' ', styles: {} },
        {
          text: 'styled',
          styles: {
            backgroundColor: 'rgb(10,20,30)',
            color: 'ansi256(202)',
            inverse: true,
            italic: true,
            strikethrough: true,
            underline: true,
          },
        },
        { text: ' ', styles: {} },
        {
          hyperlink: 'https://example.test/docs',
          text: 'linked',
          styles: {},
        },
      ])
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      if (previousForceHyperlink === undefined) {
        delete process.env.FORCE_HYPERLINK
      } else {
        process.env.FORCE_HYPERLINK = previousForceHyperlink
      }
      await sleep(25)
    }
  })
})
