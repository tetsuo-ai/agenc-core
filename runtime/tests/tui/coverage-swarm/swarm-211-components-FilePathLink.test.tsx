import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'

import React, { useLayoutEffect, useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { FilePathLink } from '../../../src/tui/components/FilePathLink.js'
import type { DOMElement } from '../../../src/tui/ink/dom.js'
import instances from '../../../src/tui/ink/instances.js'
import { createRoot } from '../../../src/tui/ink/root.js'
import { squashTextNodesToSegments } from '../../../src/tui/ink/squash-text-nodes.js'

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

const previousForceHyperlink = process.env.FORCE_HYPERLINK

afterEach(() => {
  if (previousForceHyperlink === undefined) {
    delete process.env.FORCE_HYPERLINK
  } else {
    process.env.FORCE_HYPERLINK = previousForceHyperlink
  }
})

function createStreams(): {
  readonly stdin: TestStdin
  readonly stdout: TestStdout
} {
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough() as TestStdout

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  stdout.columns = 120
  stdout.rows = 24
  stdout.isTTY = true
  stdout.resume()

  return { stdin, stdout }
}

function getRootNode(stdout: TestStdout): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)
  if (!instance?.rootNode) {
    throw new Error('Ink root node not found')
  }

  return instance.rootNode
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await sleep(10)
  }

  throw new Error(message)
}

async function renderSegments(
  node: React.ReactNode,
  waitForRender: () => Promise<void> = () => sleep(),
): Promise<
  Array<{
    readonly hyperlink?: string
    readonly styles: Record<string, unknown>
    readonly text: string
  }>
> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  try {
    root.render(node)
    await waitForRender()
    return squashTextNodesToSegments(getRootNode(stdout))
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await sleep()
  }
}

function RerenderingFilePathLink({
  onStage,
}: {
  readonly onStage: (stage: number) => void
}) {
  const [stage, setStage] = useState(0)
  const firstPath = '/tmp/agenc coverage/row 211 cached.ts'
  const secondPath = '/tmp/agenc coverage/row 211 cached final.ts'

  useLayoutEffect(() => {
    onStage(stage)
    if (stage < 3) {
      setStage(stage + 1)
    }
  }, [onStage, stage])

  const filePath = stage === 3 ? secondPath : firstPath
  const label = stage < 2 ? 'stable row 211 label' : 'updated row 211 label'

  return <FilePathLink filePath={filePath}>{label}</FilePathLink>
}

describe('FilePathLink coverage swarm row 211', () => {
  test('renders file URLs with default text and falsey non-nullish children', async () => {
    process.env.FORCE_HYPERLINK = '1'
    const defaultPath = '/tmp/agenc coverage/row 211 report.md'
    const zeroLabelPath = '/tmp/agenc coverage/row 211 zero label.ts'

    const segments = await renderSegments(
      <>
        <FilePathLink filePath={defaultPath} />
        <FilePathLink filePath={zeroLabelPath}>{0}</FilePathLink>
      </>,
    )

    expect(
      segments.filter(
        segment => segment.hyperlink === pathToFileURL(defaultPath).href,
      ),
    ).toEqual([
      {
        hyperlink: pathToFileURL(defaultPath).href,
        styles: {},
        text: defaultPath,
      },
    ])
    expect(
      segments.filter(
        segment => segment.hyperlink === pathToFileURL(zeroLabelPath).href,
      ),
    ).toEqual([
      {
        hyperlink: pathToFileURL(zeroLabelPath).href,
        styles: {},
        text: '0',
      },
    ])
  })

  test('rerenders stable and changed props through cached branches', async () => {
    process.env.FORCE_HYPERLINK = '1'
    const onStage = vi.fn()

    const segments = await renderSegments(
      <RerenderingFilePathLink onStage={onStage} />,
      () =>
        waitForCondition(
          () => onStage.mock.calls.some(([stage]) => stage === 3),
          'FilePathLink rerender stages did not complete',
        ),
    )

    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual([0, 1, 2, 3])
    expect(segments).toEqual([
      {
        hyperlink: pathToFileURL(
          '/tmp/agenc coverage/row 211 cached final.ts',
        ).href,
        styles: {},
        text: 'updated row 211 label',
      },
    ])
  })
})
