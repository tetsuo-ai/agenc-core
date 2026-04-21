/**
 * Wave 3-C: canonical in-memory paste buffer.
 *
 * Tracks a burst of bracketed-paste chunks as a single logical paste
 * event and exposes lifecycle signals to subscribers. The store is a
 * process-wide singleton so the TUI composer and any downstream
 * observers agree on a single paste timeline.
 *
 * Lifecycle:
 *   - First `pushChunk(chunk)` after an idle period transitions the
 *     store to "in flight" and emits `paste-start`. Subsequent chunks
 *     while in flight append to the buffer.
 *   - Every `pushChunk` resets a 500 ms idle timer. When the timer
 *     fires the store transitions back out of in-flight and emits
 *     `paste-complete` with the total post-sanitization byte count.
 *   - If any chunks contained stripped C0/C1 control bytes, a
 *     `paste-sanitized` event follows `paste-complete` carrying the
 *     total stripped byte count for the burst.
 *
 * Sanitization (invariant I-67):
 *   - C0 controls (0x00-0x1F) are removed with two exceptions:
 *       * `\n` (0x0A) — line feed, meaningful for multi-line paste.
 *       * `\t` (0x09) — horizontal tab, meaningful for indentation.
 *     DEL (0x7F) is in the C1 range transitional zone; we leave it
 *     alone because printable-friendly renderers already handle it
 *     and some paste sources emit it as part of visible content.
 *   - C1 controls (0x80-0x9F) are removed unconditionally. These are
 *     rarely valid in pasted text and overlap ANSI CSI introducers
 *     when 8-bit encoding is in play.
 *
 * The counter `strippedBytes` is the count of characters removed.
 * We measure in JavaScript string units (UTF-16 code units) rather
 * than true UTF-8 bytes because the store operates on strings and the
 * surface is display-oriented; callers that need true byte accounting
 * should re-encode the consumed buffer.
 */

export interface PasteEvent {
  kind: "paste-start" | "paste-complete" | "paste-sanitized";
  /** Total bytes on `paste-complete`. */
  bytes?: number;
  /** Number of stripped control characters on `paste-sanitized`. */
  strippedBytes?: number;
}

type Subscriber = (event: PasteEvent) => void;

/** Milliseconds of idle time after the last chunk before the burst is
 * considered complete. Tuned so fast typists' individual keystrokes
 * never trigger the paste pipeline but real paste bursts resolve
 * promptly. */
const PASTE_IDLE_MS = 500;

/**
 * Scrub a single chunk of C0 (0x00-0x1F except \n and \t) and C1
 * (0x80-0x9F) control characters. Returns the cleaned string and the
 * count of characters removed.
 */
function sanitizeChunk(chunk: string): { clean: string; stripped: number } {
  let stripped = 0;
  let clean = "";
  for (let i = 0; i < chunk.length; i++) {
    const code = chunk.charCodeAt(i);
    // C0 range: 0x00-0x1F. Preserve \n (0x0A) and \t (0x09).
    if (code <= 0x1f && code !== 0x0a && code !== 0x09) {
      stripped++;
      continue;
    }
    // C1 range: 0x80-0x9F.
    if (code >= 0x80 && code <= 0x9f) {
      stripped++;
      continue;
    }
    clean += chunk.charAt(i);
  }
  return { clean, stripped };
}

export class PasteStore {
  private inFlight = false;
  private buffer = "";
  private strippedTotal = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribers = new Set<Subscriber>();

  /** True while a paste burst is being accumulated. */
  isInFlight(): boolean {
    return this.inFlight;
  }

  /**
   * Accept one chunk of paste input. Sanitizes control characters,
   * tracks the stripped count, and resets the idle timer so the burst
   * only completes after 500 ms without new chunks.
   */
  pushChunk(chunk: string): void {
    const { clean, stripped } = sanitizeChunk(chunk);

    if (!this.inFlight) {
      this.inFlight = true;
      this.buffer = "";
      this.strippedTotal = 0;
      this.emit({ kind: "paste-start" });
    }

    this.buffer += clean;
    this.strippedTotal += stripped;
    this.resetIdleTimer();
  }

  /**
   * Drain the accumulated buffer. Callers typically invoke this
   * synchronously inside their `paste-complete` handler. Does not
   * change in-flight state — the idle timer is the only way to
   * transition out of in-flight.
   */
  consumeBuffer(): string {
    const out = this.buffer;
    this.buffer = "";
    return out;
  }

  /**
   * Subscribe to paste lifecycle events. Returns an unsubscribe
   * callback. Subscriber exceptions are swallowed so one bad listener
   * cannot prevent the rest from seeing events.
   */
  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  private resetIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => this.completeBurst(), PASTE_IDLE_MS);
  }

  private completeBurst(): void {
    if (!this.inFlight) return;
    const totalBytes = this.buffer.length;
    const stripped = this.strippedTotal;
    this.idleTimer = null;
    this.inFlight = false;
    this.emit({ kind: "paste-complete", bytes: totalBytes });
    if (stripped > 0) {
      this.emit({ kind: "paste-sanitized", strippedBytes: stripped });
    }
    this.strippedTotal = 0;
  }

  private emit(event: PasteEvent): void {
    for (const cb of Array.from(this.subscribers)) {
      try {
        cb(event);
      } catch {
        // Swallow subscriber errors so one bad listener cannot prevent
        // the rest from observing paste lifecycle events.
      }
    }
  }
}

let _instance: PasteStore | undefined;

/** Return the process-wide paste store, constructing it on first use. */
export function getPasteStore(): PasteStore {
  return (_instance ??= new PasteStore());
}

/**
 * Test helper: drop the singleton so each test starts fresh.
 *
 * Exported under two names for backwards compatibility with the
 * Wave 3-A fallback store contract (`__resetPasteStoreForTests`) and
 * the current canonical name (`__resetPasteStoreForTesting`). New
 * callers should prefer `__resetPasteStoreForTesting`.
 */
export function __resetPasteStoreForTesting(): void {
  _instance = undefined;
}

export function __resetPasteStoreForTests(): void {
  _instance = undefined;
}
