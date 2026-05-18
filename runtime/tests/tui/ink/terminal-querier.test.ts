import { describe, expect, test } from 'vitest'

import {
  TerminalQuerier,
  da1,
  xtversion,
  type QuerierStdin,
} from './terminal-querier.ts'
import type { TerminalResponse } from './parse-keypress.ts'

/** Minimal writable stub: records every chunk written. */
function makeStdout(): {
  stdout: NodeJS.WriteStream
  writes: string[]
} {
  const writes: string[] = []
  const stdout = {
    write: (chunk: string | Uint8Array): boolean => {
      writes.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
      )
      return true
    },
  } as unknown as NodeJS.WriteStream
  return { stdout, writes }
}

/** Yield to the macrotask queue so setImmediate callbacks can run. */
function nextTick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

describe('TerminalQuerier write gating', () => {
  test('writes immediately when no stdin handle is provided (legacy path)', () => {
    const { stdout, writes } = makeStdout()
    const q = new TerminalQuerier(stdout)
    void q.send(xtversion())
    expect(writes).toEqual(['\x1b[>0q'])
  })

  test('suppresses writes entirely when stdin.isTTY is false', async () => {
    const { stdout, writes } = makeStdout()
    const stdin: QuerierStdin = { isTTY: false, isRaw: false }
    const q = new TerminalQuerier(stdout, stdin)

    const result = await q.send(xtversion())
    await q.flush()

    expect(writes).toEqual([])
    expect(result).toBeUndefined()
  })

  test('flush() drains pending queries when stdin is non-TTY', async () => {
    const { stdout, writes } = makeStdout()
    const stdin: QuerierStdin = { isTTY: false, isRaw: false }
    const q = new TerminalQuerier(stdout, stdin)

    const send1 = q.send(xtversion())
    const send2 = q.send(da1())
    await q.flush()

    expect(writes).toEqual([])
    await expect(send1).resolves.toBeUndefined()
    await expect(send2).resolves.toBeUndefined()
  })

  test('defers writes until stdin enters raw mode', async () => {
    const { stdout, writes } = makeStdout()
    const stdin: QuerierStdin = { isTTY: true, isRaw: false }
    const q = new TerminalQuerier(stdout, stdin)

    void q.send(xtversion())

    // Before raw mode is set, no bytes should be on the wire even after
    // several event-loop ticks.
    await nextTick()
    await nextTick()
    expect(writes).toEqual([])

    // Renderer claims raw mode; the deferred write should land on the next
    // setImmediate cycle.
    stdin.isRaw = true
    await nextTick()
    await nextTick()
    expect(writes).toEqual(['\x1b[>0q'])
  })

  test('writes immediately when stdin is already in raw mode', () => {
    const { stdout, writes } = makeStdout()
    const stdin: QuerierStdin = { isTTY: true, isRaw: true }
    const q = new TerminalQuerier(stdout, stdin)

    void q.send(xtversion())
    expect(writes).toEqual(['\x1b[>0q'])
  })

  test('falls back to direct write if raw mode never arrives', async () => {
    // Polling has a hard cap (RAW_MODE_POLL_LIMIT). After the cap, the
    // querier writes anyway so callers don't deadlock on a misconfigured
    // pipeline. Spin the loop long enough to exceed the limit.
    const { stdout, writes } = makeStdout()
    const stdin: QuerierStdin = { isTTY: true, isRaw: false }
    const q = new TerminalQuerier(stdout, stdin)

    void q.send(xtversion())

    for (let i = 0; i < 80; i++) {
      await nextTick()
    }

    expect(writes).toEqual(['\x1b[>0q'])
  })

  test('onResponse still dispatches matching queries after deferred write', async () => {
    const { stdout, writes } = makeStdout()
    const stdin: QuerierStdin = { isTTY: true, isRaw: true }
    const q = new TerminalQuerier(stdout, stdin)

    const promise = q.send(xtversion())
    expect(writes).toEqual(['\x1b[>0q'])

    const fakeResponse: TerminalResponse = {
      type: 'xtversion',
      name: 'fake-term(1.0)',
    } as TerminalResponse
    q.onResponse(fakeResponse)

    await expect(promise).resolves.toMatchObject({
      type: 'xtversion',
      name: 'fake-term(1.0)',
    })
  })

  test('flush() resolves pending queries with undefined when DA1 arrives', async () => {
    const { stdout } = makeStdout()
    const stdin: QuerierStdin = { isTTY: true, isRaw: true }
    const q = new TerminalQuerier(stdout, stdin)

    const xtPromise = q.send(xtversion())
    const flushPromise = q.flush()

    // Terminal answers DA1 only (ignored xtversion); flush should fire and
    // resolve xtversion with undefined.
    q.onResponse({ type: 'da1', params: [] } as unknown as TerminalResponse)

    await expect(flushPromise).resolves.toBeUndefined()
    await expect(xtPromise).resolves.toBeUndefined()
  })

  test('multiple concurrent batches stay isolated across flush boundaries', async () => {
    const { stdout, writes } = makeStdout()
    const stdin: QuerierStdin = { isTTY: true, isRaw: true }
    const q = new TerminalQuerier(stdout, stdin)

    const batch1 = Promise.all([q.send(xtversion()), q.flush()])
    const batch2 = Promise.all([q.send(xtversion()), q.flush()])

    expect(writes.length).toBe(4)

    q.onResponse({ type: 'da1', params: [] } as unknown as TerminalResponse)
    const [r1] = await batch1
    expect(r1).toBeUndefined()

    q.onResponse({ type: 'da1', params: [] } as unknown as TerminalResponse)
    const [r2] = await batch2
    expect(r2).toBeUndefined()
  })
})
