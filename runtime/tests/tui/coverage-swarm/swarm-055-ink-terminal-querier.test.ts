import { describe, expect, test } from 'vitest'

import type { TerminalResponse } from '../../../src/tui/ink/parse-keypress.js'
import {
  TerminalQuerier,
  cursorPosition,
  da1,
  da2,
  decrqm,
  kittyKeyboard,
  oscColor,
  xtversion,
  type QuerierStdin,
} from '../../../src/tui/ink/terminal-querier.js'

type TestQuery = {
  readonly request: string
  readonly match: (response: TerminalResponse) => boolean
}

function makeStdout(): {
  readonly stdout: NodeJS.WriteStream
  readonly writes: string[]
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

function tick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

describe('TerminalQuerier coverage swarm row 055', () => {
  test('matches terminal query builder responses and rejects near misses', () => {
    const queryCases: readonly {
      readonly query: TestQuery
      readonly request: string | RegExp
      readonly matching: TerminalResponse
      readonly misses: readonly TerminalResponse[]
    }[] = [
      {
        query: decrqm(2026),
        request: '\x1b[?2026$p',
        matching: { type: 'decrpm', mode: 2026, status: 1 },
        misses: [
          { type: 'decrpm', mode: 2027, status: 1 },
          { type: 'da1', params: [] },
        ],
      },
      {
        query: da1(),
        request: '\x1b[c',
        matching: { type: 'da1', params: [1, 2] },
        misses: [{ type: 'da2', params: [1, 2] }],
      },
      {
        query: da2(),
        request: '\x1b[>c',
        matching: { type: 'da2', params: [0, 1, 2] },
        misses: [{ type: 'da1', params: [0, 1, 2] }],
      },
      {
        query: kittyKeyboard(),
        request: '\x1b[?u',
        matching: { type: 'kittyKeyboard', flags: 7 },
        misses: [{ type: 'cursorPosition', row: 4, col: 9 }],
      },
      {
        query: cursorPosition(),
        request: '\x1b[?6n',
        matching: { type: 'cursorPosition', row: 12, col: 34 },
        misses: [{ type: 'kittyKeyboard', flags: 7 }],
      },
      {
        query: oscColor(11),
        request: /^\x1b\]11;\?(?:\x07|\x1b\\)$/u,
        matching: { type: 'osc', code: 11, data: 'rgb:0000/1111/2222' },
        misses: [
          { type: 'osc', code: 10, data: 'rgb:0000/1111/2222' },
          { type: 'xtversion', name: 'test-term(1.0)' },
        ],
      },
      {
        query: xtversion(),
        request: '\x1b[>0q',
        matching: { type: 'xtversion', name: 'test-term(1.0)' },
        misses: [{ type: 'osc', code: 11, data: 'rgb:0000/1111/2222' }],
      },
    ]

    for (const { matching, misses, query, request } of queryCases) {
      if (typeof request === 'string') expect(query.request).toBe(request)
      else expect(query.request).toMatch(request)

      expect(query.match(matching)).toBe(true)
      for (const miss of misses) expect(query.match(miss)).toBe(false)
    }
  })

  test('non-TTY flush drains queries queued before suppression', async () => {
    const { stdout, writes } = makeStdout()
    const stdin: QuerierStdin = { isTTY: true, isRaw: true }
    const querier = new TerminalQuerier(stdout, stdin)

    const pending = querier.send(xtversion())
    expect(writes).toEqual(['\x1b[>0q'])

    stdin.isTTY = false
    await expect(querier.flush()).resolves.toBeUndefined()
    await expect(pending).resolves.toBeUndefined()
  })

  test('non-TTY flush resolves queued sentinels from earlier flush calls', async () => {
    const { stdout, writes } = makeStdout()
    const stdin: QuerierStdin = { isTTY: true, isRaw: true }
    const querier = new TerminalQuerier(stdout, stdin)

    const firstFlush = querier.flush()
    expect(writes).toEqual(['\x1b[c'])

    stdin.isTTY = false
    await expect(querier.flush()).resolves.toBeUndefined()
    await expect(firstFlush).resolves.toBeUndefined()
  })

  test('DA1 without a sentinel is ignored until a matching response arrives', async () => {
    const { stdout } = makeStdout()
    const querier = new TerminalQuerier(stdout, { isTTY: true, isRaw: true })

    const pending = querier.send(xtversion())
    let settled = false
    pending.then(() => {
      settled = true
    })

    querier.onResponse({ type: 'da1', params: [] })
    await tick()
    expect(settled).toBe(false)

    querier.onResponse({ type: 'xtversion', name: 'late-term(2.0)' })
    await expect(pending).resolves.toEqual({
      type: 'xtversion',
      name: 'late-term(2.0)',
    })
  })

  test('unsolicited non-DA1 responses leave pending queries for the flush barrier', async () => {
    const { stdout } = makeStdout()
    const querier = new TerminalQuerier(stdout, { isTTY: true, isRaw: true })

    const pending = querier.send(decrqm(2026))
    querier.onResponse({ type: 'osc', code: 11, data: 'ignored' })

    const flushed = querier.flush()
    querier.onResponse({ type: 'da1', params: [] })

    await expect(flushed).resolves.toBeUndefined()
    await expect(pending).resolves.toBeUndefined()
  })
})
