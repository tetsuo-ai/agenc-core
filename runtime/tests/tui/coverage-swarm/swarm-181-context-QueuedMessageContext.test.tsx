import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test } from 'vitest'

import {
  QueuedMessageProvider,
  useQueuedMessage,
} from '../../../src/tui/context/QueuedMessageContext.js'
import { createRoot, Text } from '../../../src/tui/ink.js'

type QueueSnapshot =
  | {
      readonly isFirst: boolean
      readonly isQueued: boolean
      readonly paddingWidth: number
    }
  | undefined

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

type TestStdout = PassThrough & {
  columns: number
  isTTY: boolean
}

type TestRoot = Awaited<ReturnType<typeof createRoot>>

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

  stdout.columns = 80
  stdout.isTTY = true
  stdout.resume()

  return { stdin, stdout }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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

async function withRoot(
  run: (root: TestRoot) => Promise<void> | void,
): Promise<void> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  try {
    await run(root)
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await sleep()
  }
}

function CaptureQueuedMessage({
  label,
  snapshots,
}: {
  readonly label: string
  readonly snapshots: QueueSnapshot[]
}): React.ReactNode {
  const queuedMessage = useQueuedMessage()

  React.useEffect(() => {
    snapshots.push(
      queuedMessage === undefined
        ? undefined
        : {
            isFirst: queuedMessage.isFirst,
            isQueued: queuedMessage.isQueued,
            paddingWidth: queuedMessage.paddingWidth,
          },
    )
  }, [queuedMessage, snapshots])

  return <Text>{label}</Text>
}

describe('QueuedMessageContext coverage swarm row 181', () => {
  test('returns undefined when the hook is used outside a provider', async () => {
    const snapshots: QueueSnapshot[] = []

    await withRoot(async root => {
      root.render(
        <CaptureQueuedMessage label="outside" snapshots={snapshots} />,
      )

      await waitForCondition(
        () => snapshots.length === 1,
        'Queued message default context was not captured',
      )
    })

    expect(snapshots).toEqual([undefined])
  })

  test('provides normal and brief queued metadata and reuses stable provider output', async () => {
    const normalSnapshots: QueueSnapshot[] = []
    const briefSnapshots: QueueSnapshot[] = []
    const stableChild = (
      <CaptureQueuedMessage label="normal" snapshots={normalSnapshots} />
    )

    await withRoot(async root => {
      root.render(
        <QueuedMessageProvider isFirst={false}>
          {stableChild}
        </QueuedMessageProvider>,
      )

      await waitForCondition(
        () => normalSnapshots.length === 1,
        'Normal queued message context was not captured',
      )

      root.render(
        <QueuedMessageProvider isFirst={false}>
          {stableChild}
        </QueuedMessageProvider>,
      )
      await sleep()

      root.render(
        <QueuedMessageProvider isFirst={true} useBriefLayout={true}>
          <CaptureQueuedMessage label="brief" snapshots={briefSnapshots} />
        </QueuedMessageProvider>,
      )

      await waitForCondition(
        () => briefSnapshots.length === 1,
        'Brief queued message context was not captured',
      )
    })

    expect(normalSnapshots).toEqual([
      {
        isFirst: false,
        isQueued: true,
        paddingWidth: 4,
      },
    ])
    expect(briefSnapshots).toEqual([
      {
        isFirst: true,
        isQueued: true,
        paddingWidth: 0,
      },
    ])
  })
})
