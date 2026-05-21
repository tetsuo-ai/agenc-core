import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'

import React, { useLayoutEffect, useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const componentMocks = vi.hoisted(() => ({
  imagePathById: new Map<number, string>(),
  supportsHyperlinks: vi.fn(() => true),
}))

vi.mock('../../../src/utils/imageStore.js', () => ({
  getStoredImagePath: (imageId: number) =>
    componentMocks.imagePathById.get(imageId) ?? null,
}))

vi.mock('../../../src/tui/ink/supports-hyperlinks.js', () => ({
  supportsHyperlinks: componentMocks.supportsHyperlinks,
}))

import { ClickableImageRef } from '../../../src/tui/components/ClickableImageRef.js'
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

  stdout.columns = 100
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

afterEach(() => {
  componentMocks.imagePathById.clear()
  componentMocks.supportsHyperlinks.mockReset()
  componentMocks.supportsHyperlinks.mockReturnValue(true)
})

function LinkedRerenderProbe({
  onStage,
}: {
  readonly onStage: (stage: number) => void
}): React.ReactElement {
  const [stage, setStage] = useState(0)

  useLayoutEffect(() => {
    onStage(stage)
    if (stage < 2) {
      setStage(stage + 1)
    }
  }, [onStage, stage])

  return (
    <ClickableImageRef
      backgroundColor={stage === 2 ? 'warning' : undefined}
      imageId={12}
      isSelected={stage === 2}
    />
  )
}

function PlainRerenderProbe({
  onStage,
}: {
  readonly onStage: (stage: number) => void
}): React.ReactElement {
  const [stage, setStage] = useState(0)

  useLayoutEffect(() => {
    onStage(stage)
    if (stage < 2) {
      setStage(stage + 1)
    }
  }, [onStage, stage])

  return (
    <ClickableImageRef
      backgroundColor={stage === 2 ? 'error' : undefined}
      imageId={stage === 2 ? 22 : 21}
      isSelected={stage === 2}
    />
  )
}

describe('ClickableImageRef coverage swarm row 156', () => {
  test('renders selected cached images as styled file hyperlinks across rerenders', async () => {
    const imagePath = '/tmp/agenc coverage/row 156 selected image.png'
    componentMocks.imagePathById.set(12, imagePath)
    componentMocks.supportsHyperlinks.mockReturnValue(true)
    const onStage = vi.fn()

    const segments = await renderSegments(
      <LinkedRerenderProbe onStage={onStage} />,
      () =>
        waitForCondition(
          () => onStage.mock.calls.some(([stage]) => stage === 2),
          'ClickableImageRef linked rerenders did not complete',
        ),
    )

    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual([0, 1, 2])
    expect(segments).toEqual([
      {
        hyperlink: pathToFileURL(imagePath).href,
        styles: {
          backgroundColor: expect.any(String),
          bold: true,
          inverse: true,
        },
        text: '[Image #12]',
      },
    ])
    expect(componentMocks.supportsHyperlinks).toHaveBeenCalled()
  })

  test('falls back to styled text when hyperlinks are unsupported or the image is missing', async () => {
    componentMocks.imagePathById.set(
      21,
      '/tmp/agenc coverage/row 156 unsupported image.png',
    )
    componentMocks.supportsHyperlinks.mockReturnValue(false)
    const onStage = vi.fn()

    const unsupportedSegments = await renderSegments(
      <PlainRerenderProbe onStage={onStage} />,
      () =>
        waitForCondition(
          () => onStage.mock.calls.some(([stage]) => stage === 2),
          'ClickableImageRef fallback rerenders did not complete',
        ),
    )

    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual([0, 1, 2])
    expect(unsupportedSegments).toEqual([
      {
        hyperlink: undefined,
        styles: {
          backgroundColor: expect.any(String),
          inverse: true,
        },
        text: '[Image #22]',
      },
    ])

    componentMocks.supportsHyperlinks.mockClear()
    componentMocks.supportsHyperlinks.mockReturnValue(true)
    const missingSegments = await renderSegments(
      <ClickableImageRef imageId={99} />,
    )

    expect(missingSegments).toEqual([
      {
        hyperlink: undefined,
        styles: {},
        text: '[Image #99]',
      },
    ])
    expect(componentMocks.supportsHyperlinks).not.toHaveBeenCalled()
  })
})
