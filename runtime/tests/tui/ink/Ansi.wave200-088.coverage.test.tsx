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

describe('Ansi wave200 coverage', () => {
  test('renders coercion, empty parses, dim plain text, and dim styled links', async () => {
    const previousForceHyperlink = process.env.FORCE_HYPERLINK
    process.env.FORCE_HYPERLINK = '1'

    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    const render = async (node: React.ReactNode) => {
      root.render(node)
      await sleep(25)
      return squashTextNodesToSegments(getRootNode(stdout))
    }

    try {
      await expect(
        render(
          React.createElement(
            Ansi as unknown as React.ComponentType<{
              children: unknown
              dimColor?: boolean
            }>,
            { dimColor: true },
            42,
          ),
        ),
      ).resolves.toEqual([{ text: '42', styles: { dim: true } }])

      await expect(render(<Ansi>{''}</Ansi>)).resolves.toEqual([])
      await expect(render(<Ansi>{'\x1b[31m'}</Ansi>)).resolves.toEqual([])

      await expect(render(<Ansi dimColor={true}>plain</Ansi>)).resolves.toEqual(
        [{ text: 'plain', styles: { dim: true } }],
      )

      await expect(
        render(
          <Ansi dimColor={true}>
            {
              '\x1b]8;;https://example.test/ansi\x07' +
              '\x1b[1;31mlink\x1b[22;39m' +
              '\x1b]8;;\x07'
            }
          </Ansi>,
        ),
      ).resolves.toEqual([
        {
          hyperlink: 'https://example.test/ansi',
          text: 'link',
          styles: {
            color: 'ansi:red',
            dim: true,
          },
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
