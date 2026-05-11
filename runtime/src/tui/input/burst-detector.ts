/**
 * Burst input detector — flags stdin bursts that look like raw pastes
 * arriving without bracketed-paste-mode (BPM) envelopes.
 *
 * Security context (B-NEW2): when a terminal does not advertise BPM, or
 * the user pastes via a path that strips the `\x1b[200~` / `\x1b[201~`
 * markers, raw bytes land in the composer as if the user had typed them
 * one character at a time. If the user then submits in bash mode (`! …`)
 * or in `--yolo` mode, the pasted content executes without any rate or
 * intent guard.
 *
 * This detector tracks recent byte arrivals in a small sliding window.
 * When more than `BURST_CHAR_THRESHOLD` characters arrive within
 * `BURST_WINDOW_MS` and none of those arrivals carried a BPM marker, the
 * next submission is flagged as `suspectedPaste`. Downstream consumers
 * (e.g. `processBashCommand`) read the flag via `consumeSuspectedPaste`
 * and surface a confirmation dialog instead of executing immediately.
 */

const BURST_CHAR_THRESHOLD = 50
const BURST_WINDOW_MS = 50

type Sample = { time: number; chars: number }

class BurstDetector {
  private samples: Sample[] = []
  private flagged = false

  /**
   * Record one batch of stdin bytes.
   *
   * @param chars  Number of characters in the batch.
   * @param hasBpmMarker  True if the batch was delimited by bracketed-paste
   *                      markers (\x1b[200~/\x1b[201~). When true the batch
   *                      is NOT counted as burst input — BPM-wrapped pastes
   *                      are already labelled `isPasted` upstream and the
   *                      composer can route them safely.
   */
  record(chars: number, hasBpmMarker: boolean): void {
    if (chars <= 0) return
    if (hasBpmMarker) {
      // BPM-wrapped input is the legitimate paste path; do not arm the gate.
      // Drain stale samples so a BPM paste does not retroactively trip
      // adjacent unbracketed input.
      this.samples = []
      return
    }
    const now = Date.now()
    this.samples.push({ time: now, chars })
    this.prune(now)
    const total = this.samples.reduce((sum, s) => sum + s.chars, 0)
    if (total > BURST_CHAR_THRESHOLD) {
      this.flagged = true
    }
  }

  /**
   * One-shot read of the suspected-paste flag.
   *
   * Always clears the flag after reading so a single confirmed/rejected
   * submission does not poison subsequent unrelated submissions.
   */
  consumeSuspectedPaste(): boolean {
    const was = this.flagged
    this.flagged = false
    this.samples = []
    return was
  }

  /**
   * Peek at the current flag without clearing it. Used by tests and by
   * the composer when it wants to render a hint without committing.
   */
  isSuspected(): boolean {
    return this.flagged
  }

  /** Reset all internal state. Test helper. */
  reset(): void {
    this.samples = []
    this.flagged = false
  }

  private prune(now: number): void {
    const cutoff = now - BURST_WINDOW_MS
    while (this.samples.length > 0 && this.samples[0]!.time < cutoff) {
      this.samples.shift()
    }
  }
}

const detector = new BurstDetector()

/** Record a batch of stdin bytes; see {@link BurstDetector.record}. */
export function recordInputBurst(chars: number, hasBpmMarker: boolean): void {
  detector.record(chars, hasBpmMarker)
}

/** One-shot read of the suspected-paste flag. */
export function consumeSuspectedPaste(): boolean {
  return detector.consumeSuspectedPaste()
}

/** Non-consuming peek; useful for UI hints and tests. */
export function isSuspectedPaste(): boolean {
  return detector.isSuspected()
}

/** Reset detector state. Test-only. */
export function resetBurstDetector(): void {
  detector.reset()
}

export const BURST_DETECTOR_THRESHOLDS = {
  charThreshold: BURST_CHAR_THRESHOLD,
  windowMs: BURST_WINDOW_MS,
} as const
