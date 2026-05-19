/**
 * Query the terminal and await responses without timeouts.
 *
 * Terminal queries (DECRQM, DA1, OSC 11, etc.) share the stdin stream
 * with keyboard input. Response sequences are syntactically
 * distinguishable from key events, so the input parser recognizes them
 * and dispatches them here.
 *
 * To avoid timeouts, each query batch is terminated by a DA1 sentinel
 * (CSI c) — every terminal since VT100 responds to DA1, and terminals
 * answer queries in order. So: if your query's response arrives before
 * DA1's, the terminal supports it; if DA1 arrives first, it doesn't.
 *
 * Usage:
 *   const [sync, grapheme] = await Promise.all([
 *     querier.send(decrqm(2026)),
 *     querier.send(decrqm(2027)),
 *     querier.flush(),
 *   ])
 *   // sync and grapheme are DECRPM responses or undefined if unsupported
 */

import type { TerminalResponse } from './parse-keypress.js'
import { csi } from './termio/csi.js'
import { osc } from './termio/osc.js'

/** A terminal query: an outbound request sequence paired with a matcher
 *  that recognizes the expected inbound response. Built by `decrqm()`,
 *  `oscColor()`, `kittyKeyboard()`, etc. */
export type TerminalQuery<T extends TerminalResponse = TerminalResponse> = {
  /** Escape sequence to write to stdout */
  request: string
  /** Recognizes the expected response in the inbound stream */
  match: (r: TerminalResponse) => r is T
}

type DecrpmResponse = Extract<TerminalResponse, { type: 'decrpm' }>
type Da1Response = Extract<TerminalResponse, { type: 'da1' }>
type Da2Response = Extract<TerminalResponse, { type: 'da2' }>
type KittyResponse = Extract<TerminalResponse, { type: 'kittyKeyboard' }>
type CursorPosResponse = Extract<TerminalResponse, { type: 'cursorPosition' }>
type OscResponse = Extract<TerminalResponse, { type: 'osc' }>
type XtversionResponse = Extract<TerminalResponse, { type: 'xtversion' }>

// -- Query builders --

/** DECRQM: request DEC private mode status (CSI ? mode $ p).
 *  Terminal replies with DECRPM (CSI ? mode ; status $ y) or ignores. */
export function decrqm(mode: number): TerminalQuery<DecrpmResponse> {
  return {
    request: csi(`?${mode}$p`),
    match: (r): r is DecrpmResponse => r.type === 'decrpm' && r.mode === mode,
  }
}

/** Primary Device Attributes query (CSI c). Every terminal answers this —
 *  used internally by flush() as a universal sentinel. Call directly if
 *  you want the DA1 params. */
export function da1(): TerminalQuery<Da1Response> {
  return {
    request: csi('c'),
    match: (r): r is Da1Response => r.type === 'da1',
  }
}

/** Secondary Device Attributes query (CSI > c). Returns terminal version. */
export function da2(): TerminalQuery<Da2Response> {
  return {
    request: csi('>c'),
    match: (r): r is Da2Response => r.type === 'da2',
  }
}

/** Query current Kitty keyboard protocol flags (CSI ? u).
 *  Terminal replies with CSI ? flags u or ignores. */
export function kittyKeyboard(): TerminalQuery<KittyResponse> {
  return {
    request: csi('?u'),
    match: (r): r is KittyResponse => r.type === 'kittyKeyboard',
  }
}

/** DECXCPR: request cursor position with DEC-private marker (CSI ? 6 n).
 *  Terminal replies with CSI ? row ; col R. The `?` marker is critical —
 *  the plain DSR form (CSI 6 n → CSI row;col R) is ambiguous with
 *  modified F3 keys (Shift+F3 = CSI 1;2 R, etc.). */
export function cursorPosition(): TerminalQuery<CursorPosResponse> {
  return {
    request: csi('?6n'),
    match: (r): r is CursorPosResponse => r.type === 'cursorPosition',
  }
}

/** OSC dynamic color query (e.g. OSC 11 for bg color, OSC 10 for fg).
 *  The `?` data slot asks the terminal to reply with the current value. */
export function oscColor(code: number): TerminalQuery<OscResponse> {
  return {
    request: osc(code, '?'),
    match: (r): r is OscResponse => r.type === 'osc' && r.code === code,
  }
}

/** XTVERSION: request terminal name/version (CSI > 0 q).
 *  Terminal replies with DCS > | name ST (e.g. "xterm.js(5.5.0)") or ignores.
 *  This survives SSH — the query goes through the pty, not the environment,
 *  so it identifies the *client* terminal even when TERM_PROGRAM isn't
 *  forwarded. Used to detect xterm.js for wheel-scroll compensation. */
export function xtversion(): TerminalQuery<XtversionResponse> {
  return {
    request: csi('>0q'),
    match: (r): r is XtversionResponse => r.type === 'xtversion',
  }
}

// -- Querier --

/** Sentinel request sequence (DA1). Kept internal; flush() writes it. */
const SENTINEL = csi('c')

type Pending =
  | {
      kind: 'query'
      match: (r: TerminalResponse) => boolean
      resolve: (r: TerminalResponse | undefined) => void
    }
  | { kind: 'sentinel'; resolve: () => void }

/**
 * Minimal stdin shape needed for the raw-mode / TTY gating below. Avoids
 * importing NodeJS.ReadStream so tests can pass simple stubs.
 */
export type QuerierStdin = {
  isTTY?: boolean
  isRaw?: boolean
}

/** Max `setImmediate` ticks to wait for raw mode before writing anyway.
 *  Raw mode is set synchronously by the renderer right before the first
 *  send(), so the typical path sees `isRaw === true` on the first tick.
 *  The cap exists only to guarantee the queue can't deadlock if a caller
 *  misconfigures the stdin handle. */
const RAW_MODE_POLL_LIMIT = 50

export class TerminalQuerier {
  /**
   * Interleaved queue of queries and sentinels in send order. Terminals
   * respond in order, so each flush() barrier only drains queries queued
   * before it — concurrent batches from independent callers stay isolated.
   */
  private queue: Pending[] = []

  /**
   * Optional stdin handle used to gate writes:
   *   - When `isTTY === false`, queries are suppressed entirely (resolve
   *     with `undefined`). This avoids leaking CSI bytes to recorders
   *     and CI pipelines where stdout is not interpreting escape codes.
   *   - When `isRaw === false`, writes are deferred until raw mode is
   *     claimed by the renderer, so the terminal's response can't be
   *     echoed back to stdout by the tty line discipline.
   *
   * When stdin is omitted, behavior is the legacy "write immediately"
   * path — preserved for callers that construct the querier without a
   * stdin handle (unit tests of unrelated code paths).
   */
  constructor(
    private stdout: NodeJS.WriteStream,
    private stdin?: QuerierStdin,
  ) {}

  /**
   * Send a query and wait for its response.
   *
   * Resolves with the response when `query.match` matches an incoming
   * TerminalResponse, or with `undefined` when a flush() sentinel arrives
   * before any matching response (meaning the terminal ignored the query).
   *
   * Never rejects; never times out on its own. If you never call flush()
   * and the terminal doesn't respond, the promise remains pending.
   */
  send<T extends TerminalResponse>(
    query: TerminalQuery<T>,
  ): Promise<T | undefined> {
    return new Promise(resolve => {
      if (this.shouldSuppressWrite()) {
        resolve(undefined)
        return
      }
      this.queue.push({
        kind: 'query',
        match: query.match,
        resolve: r => resolve(r as T | undefined),
      })
      this.writeWhenRawModeReady(query.request)
    })
  }

  /**
   * Send the DA1 sentinel. Resolves when DA1's response arrives.
   *
   * As a side effect, all queries still pending when DA1 arrives are
   * resolved with `undefined` (terminal didn't respond → doesn't support
   * the query). This is the barrier that makes send() timeout-free.
   *
   * Safe to call with no pending queries — still waits for a round-trip.
   *
   * When stdin is a non-TTY, resolves immediately and drains any queries
   * that were enqueued before suppression took effect.
   */
  flush(): Promise<void> {
    return new Promise(resolve => {
      if (this.shouldSuppressWrite()) {
        const pending = this.queue.splice(0, this.queue.length)
        for (const p of pending) {
          if (p.kind === 'query') p.resolve(undefined)
          else p.resolve()
        }
        resolve()
        return
      }
      this.queue.push({ kind: 'sentinel', resolve })
      this.writeWhenRawModeReady(SENTINEL)
    })
  }

  private shouldSuppressWrite(): boolean {
    return this.stdin?.isTTY === false
  }

  private isRawModeReady(): boolean {
    // No stdin handle → legacy callers; assume the caller knows what
    // they're doing. Otherwise raw mode is ready unless explicitly false.
    return this.stdin === undefined || this.stdin.isRaw !== false
  }

  /** Write `data` to stdout, deferring until stdin enters raw mode if a
   *  handle was provided. Polls with `setImmediate` up to RAW_MODE_POLL_LIMIT
   *  ticks before falling back to a direct write so the queue can't
   *  deadlock on a misconfigured caller. */
  private writeWhenRawModeReady(data: string): void {
    if (this.isRawModeReady()) {
      this.stdout.write(data)
      return
    }
    let attempts = 0
    const tryWrite = (): void => {
      if (this.isRawModeReady() || ++attempts >= RAW_MODE_POLL_LIMIT) {
        this.stdout.write(data)
        return
      }
      setImmediate(tryWrite)
    }
    setImmediate(tryWrite)
  }

  /**
   * Dispatch a response parsed from stdin. Called by App.tsx's
   * processKeysInBatch for every `kind: 'response'` item.
   *
   * Matching strategy:
   * - First, try to match a pending query (FIFO, first match wins).
   *   This lets callers send(da1()) explicitly if they want the DA1
   *   params — a separate DA1 write means the terminal sends TWO DA1
   *   responses. The first matches the explicit query; the second
   *   (unmatched) fires the sentinel.
   * - Otherwise, if this is a DA1, fire the FIRST pending sentinel:
   *   resolve any queries queued before that sentinel with undefined
   *   (the terminal answered DA1 without answering them → unsupported)
   *   and signal its flush() completion. Only draining up to the first
   *   sentinel keeps later batches intact when multiple callers have
   *   concurrent queries in flight.
   * - Unsolicited responses (no match, no sentinel) are silently dropped.
   */
  onResponse(r: TerminalResponse): void {
    const idx = this.queue.findIndex(p => p.kind === 'query' && p.match(r))
    if (idx !== -1) {
      const [q] = this.queue.splice(idx, 1)
      if (q?.kind === 'query') q.resolve(r)
      return
    }

    if (r.type === 'da1') {
      const s = this.queue.findIndex(p => p.kind === 'sentinel')
      if (s === -1) return
      for (const p of this.queue.splice(0, s + 1)) {
        if (p.kind === 'query') p.resolve(undefined)
        else p.resolve()
      }
    }
  }
}
