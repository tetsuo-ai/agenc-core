import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { Ansi } from '../../../src/tui/ink/Ansi.js'
import type { DOMElement } from '../../../src/tui/ink/dom.js'
import instances from '../../../src/tui/ink/instances.js'
import { createRoot } from '../../../src/tui/ink/root.js'
import {
  squashTextNodesToSegments,
  type StyledSegment,
} from '../../../src/tui/ink/squash-text-nodes.js'

vi.mock('../../../src/utils/fullscreen.js', () => ({
  isMouseClicksDisabled: () => false,
}))

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

type TestStdout = PassThrough & {
  columns: number
  isTTY: boolean
  rows: number
}

type AnsiWithRevisionProps = {
  children?: unknown
  dimColor?: boolean
  revision: number
}

const AnsiWithRevision =
  Ansi as unknown as React.ComponentType<AnsiWithRevisionProps>

function createTestStreams(): {
  stdin: TestStdin
  stdout: TestStdout
} {
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough() as TestStdout

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  stdout.columns = 100
  stdout.isTTY = true
  stdout.rows = 24

  return { stdin, stdout }
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)
  if (!instance?.rootNode) throw new Error('Ink root node not found')
  return instance.rootNode
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function withAnsiSegments(
  run: (
    render: (node: React.ReactNode) => Promise<StyledSegment[]>,
  ) => Promise<void>,
): Promise<void> {
  const { stdin, stdout } = createTestStreams()
  const root = await createRoot({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  })

  const render = async (node: React.ReactNode): Promise<StyledSegment[]> => {
    root.render(node)
    await sleep(25)
    return squashTextNodesToSegments(getRootNode(stdout))
  }

  try {
    await run(render)
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await sleep(25)
  }
}

describe('Ansi coverage swarm row 060', () => {
  test('merges adjacent text actions when ignored control actions split them', async () => {
    await withAnsiSegments(async render => {
      await expect(render(<Ansi>{'left\x07right'}</Ansi>)).resolves.toEqual([
        {
          styles: {},
          text: 'leftright',
        },
      ])
    })
  })

  test('renders single-span OSC 8 hyperlinks without adding text styles', async () => {
    const previousForceHyperlink = process.env.FORCE_HYPERLINK
    process.env.FORCE_HYPERLINK = '1'

    try {
      await withAnsiSegments(async render => {
        await expect(
          render(
            <Ansi>
              {'\x1b]8;;https://agenc.test/row-060\x07linked\x1b]8;;\x07'}
            </Ansi>,
          ),
        ).resolves.toEqual([
          {
            hyperlink: 'https://agenc.test/row-060',
            styles: {},
            text: 'linked',
          },
        ])
      })
    } finally {
      if (previousForceHyperlink === undefined) {
        delete process.env.FORCE_HYPERLINK
      } else {
        process.env.FORCE_HYPERLINK = previousForceHyperlink
      }
    }
  })

  test('reuses cached plain string and non-string children across unrelated prop changes', async () => {
    await withAnsiSegments(async render => {
      await expect(
        render(<AnsiWithRevision revision={0}>plain</AnsiWithRevision>),
      ).resolves.toEqual([{ styles: {}, text: 'plain' }])

      await expect(
        render(<AnsiWithRevision revision={1}>plain</AnsiWithRevision>),
      ).resolves.toEqual([{ styles: {}, text: 'plain' }])

      await expect(
        render(<AnsiWithRevision revision={2}>{42}</AnsiWithRevision>),
      ).resolves.toEqual([{ styles: {}, text: '42' }])

      await expect(
        render(<AnsiWithRevision revision={3}>{42}</AnsiWithRevision>),
      ).resolves.toEqual([{ styles: {}, text: '42' }])
    })
  })
})
