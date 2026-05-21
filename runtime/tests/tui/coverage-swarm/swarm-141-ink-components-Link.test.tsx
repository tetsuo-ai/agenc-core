import { PassThrough } from 'node:stream'

import React, { useLayoutEffect, useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import Link from '../../../src/tui/ink/components/Link.js'
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

const envKeys = [
  'FORCE_HYPERLINK',
  'LC_TERMINAL',
  'NO_COLOR',
  'TERM',
  'TERM_PROGRAM',
] as const

const previousEnv = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>

afterEach(() => {
  for (const key of envKeys) {
    const previous = previousEnv[key]

    if (previous === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = previous
    }
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

function setHyperlinksSupported(supported: boolean): void {
  if (supported) {
    process.env.FORCE_HYPERLINK = '1'
    return
  }

  process.env.FORCE_HYPERLINK = '0'
  process.env.TERM = 'xterm-256color'
  delete process.env.LC_TERMINAL
  delete process.env.TERM_PROGRAM
}

function HyperlinkRerenderHarness({
  onStage,
}: {
  readonly onStage: (stage: number) => void
}) {
  const [stage, setStage] = useState(0)

  useLayoutEffect(() => {
    onStage(stage)

    if (stage < 3) {
      setStage(stage + 1)
    }
  }, [onStage, stage])

  const stableProps = stage < 2
  const url = stableProps
    ? 'https://row-141.example/cached'
    : 'https://row-141.example/final'
  const label = stableProps ? 'cached label' : 'final label'

  return <Link url={url}>{label}</Link>
}

function FallbackRerenderHarness({
  onStage,
}: {
  readonly onStage: (stage: number) => void
}) {
  const [stage, setStage] = useState(0)

  useLayoutEffect(() => {
    onStage(stage)

    if (stage < 3) {
      setStage(stage + 1)
    }
  }, [onStage, stage])

  const fallback = stage < 2 ? 'cached fallback' : 'final fallback'

  return (
    <Link fallback={fallback} url="https://row-141.example/no-link">
      ignored label
    </Link>
  )
}

describe('Link coverage swarm row 141', () => {
  test('renders hyperlinks with url fallback content and falsey children', async () => {
    setHyperlinksSupported(true)
    const defaultUrl = 'https://row-141.example/default'
    const zeroChildUrl = 'https://row-141.example/zero'

    const segments = await renderSegments(
      <>
        <Link url={defaultUrl} />
        <Link url={zeroChildUrl}>{0}</Link>
      </>,
    )

    expect(segments).toEqual([
      {
        hyperlink: defaultUrl,
        styles: {},
        text: defaultUrl,
      },
      {
        hyperlink: zeroChildUrl,
        styles: {},
        text: '0',
      },
    ])
  })

  test('renders fallback text when hyperlinks are not supported', async () => {
    setHyperlinksSupported(false)

    const segments = await renderSegments(
      <>
        <Link fallback="plain fallback" url="https://row-141.example/hidden">
          visible label
        </Link>
        <Link fallback={null} url="https://row-141.example/content">
          content label
        </Link>
        <Link url="https://row-141.example/url-only" />
      </>,
    )

    expect(segments).toEqual([
      {
        styles: {},
        text: 'plain fallback',
      },
      {
        styles: {},
        text: 'content label',
      },
      {
        styles: {},
        text: 'https://row-141.example/url-only',
      },
    ])
    expect(segments.every(segment => segment.hyperlink === undefined)).toBe(true)
  })

  test('rerenders stable and changed hyperlink props through cached branches', async () => {
    setHyperlinksSupported(true)
    const onStage = vi.fn()

    const segments = await renderSegments(
      <HyperlinkRerenderHarness onStage={onStage} />,
      () =>
        waitForCondition(
          () => onStage.mock.calls.some(([stage]) => stage === 3),
          'hyperlink rerender stages did not complete',
        ),
    )

    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual([0, 1, 2, 3])
    expect(segments).toEqual([
      {
        hyperlink: 'https://row-141.example/final',
        styles: {},
        text: 'final label',
      },
    ])
  })

  test('rerenders stable and changed fallback props through cached branches', async () => {
    setHyperlinksSupported(false)
    const onStage = vi.fn()

    const segments = await renderSegments(
      <FallbackRerenderHarness onStage={onStage} />,
      () =>
        waitForCondition(
          () => onStage.mock.calls.some(([stage]) => stage === 3),
          'fallback rerender stages did not complete',
        ),
    )

    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual([0, 1, 2, 3])
    expect(segments).toEqual([
      {
        styles: {},
        text: 'final fallback',
      },
    ])
    expect(segments[0]?.hyperlink).toBeUndefined()
  })
})
