import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test } from 'vitest'

import useInput from '../../../../src/tui/ink/hooks/use-input.js'
import { createRoot } from '../../../../src/tui/ink/root.js'

type FakeStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

function createStreams(): {
  readonly stdin: FakeStdin
  readonly stdout: PassThrough & { columns: number; isTTY: boolean; rows: number }
} {
  const stdin = new PassThrough() as FakeStdin
  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  const stdout = new PassThrough() as PassThrough & {
    columns: number
    isTTY: boolean
    rows: number
  }
  stdout.columns = 80
  stdout.rows = 24
  stdout.isTTY = false
  stdout.resume()
  return { stdin, stdout }
}

/** Busy-waits so the render outlasts the scheduler's 5 ms time slice. */
function spin(ms: number): void {
  const end = performance.now() + ms
  while (performance.now() < end) {
    // hold the thread
  }
}

/**
 * Returns false until a state change made after an await. Outside a React
 * event that is a default-lane update: it commits inside a scheduler task, not
 * inside the discrete update that keys run in.
 */
function useFlipAfterAwait(): boolean {
  const [flipped, setFlipped] = React.useState(false)
  React.useEffect(() => {
    void (async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      setFlipped(true)
    })()
  }, [])
  return flipped
}

/**
 * Sends one real stdin key from the layout phase of the commit that applied
 * the flip. The render spins past the scheduler's time slice first, so React
 * yields before it runs the commit's passive effects. The key is then read
 * after the commit but before the next macrotask: the window in which a
 * passive-effect handler refresh has not happened yet.
 */
function useKeyAfterFlipCommit(flipped: boolean, stdin: FakeStdin): void {
  if (flipped) spin(12)
  React.useLayoutEffect(() => {
    if (flipped) {
      process.nextTick(() => {
        stdin.write('x')
      })
    }
  }, [flipped, stdin])
}

function StateProbe({
  seen,
  stdin,
}: {
  readonly seen: string[]
  readonly stdin: FakeStdin
}): null {
  const flipped = useFlipAfterAwait()
  useInput(input => {
    seen.push(`${flipped ? 'after' : 'before'}:${input}`)
  })
  useKeyAfterFlipCommit(flipped, stdin)
  return null
}

function GateProbe({
  arrived,
  delivered,
  stdin,
}: {
  readonly arrived: string[]
  readonly delivered: string[]
  readonly stdin: FakeStdin
}): null {
  const flipped = useFlipAfterAwait()
  useInput(
    input => {
      delivered.push(input)
    },
    { isActive: !flipped },
  )
  // Always active, so the test can tell the key was dispatched at all.
  useInput(input => {
    arrived.push(input)
  })
  useKeyAfterFlipCommit(flipped, stdin)
  return null
}

async function withRoot(
  element: (stdin: FakeStdin) => React.ReactNode,
  run: () => Promise<void>,
): Promise<void> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  try {
    root.render(element(stdin))
    await run()
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }
}

describe('useInput handler freshness', () => {
  test('a key read right after an async state change reaches the handler from that commit', async () => {
    const seen: string[] = []

    await withRoot(
      stdin => <StateProbe seen={seen} stdin={stdin} />,
      async () => {
        await expect
          .poll(() => seen, { timeout: 5_000, interval: 5 })
          .toHaveLength(1)
      },
    )

    expect(seen).toEqual(['after:x'])
  })

  test('isActive false takes effect before the next key, not a turn later', async () => {
    const arrived: string[] = []
    const delivered: string[] = []

    await withRoot(
      stdin => <GateProbe arrived={arrived} delivered={delivered} stdin={stdin} />,
      async () => {
        await expect
          .poll(() => arrived, { timeout: 5_000, interval: 5 })
          .toHaveLength(1)
      },
    )

    expect(arrived).toEqual(['x'])
    expect(delivered).toEqual([])
  })
})
