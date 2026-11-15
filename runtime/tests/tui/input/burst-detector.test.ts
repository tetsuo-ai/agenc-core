import { beforeEach, describe, expect, it } from 'vitest'

import {
  BURST_DETECTOR_THRESHOLDS,
  consumeSuspectedPaste,
  isSuspectedPaste,
  recordInputBurst,
  resetBurstDetector,
} from './burst-detector.js'
import { INITIAL_STATE, parseMultipleKeypresses } from '../ink/parse-keypress.js'

describe('burst-detector (B-NEW2)', () => {
  beforeEach(() => {
    resetBurstDetector()
  })

  it('does not flag a single short keystroke', () => {
    recordInputBurst(1, false)
    expect(isSuspectedPaste()).toBe(false)
    expect(consumeSuspectedPaste()).toBe(false)
  })

  it('flags a single oversize unbracketed batch', () => {
    recordInputBurst(BURST_DETECTOR_THRESHOLDS.charThreshold + 10, false)
    expect(isSuspectedPaste()).toBe(true)
  })

  it('flags multiple small batches arriving in the same window', () => {
    // Three 25-char batches within the same tick → 75 chars > 50 threshold.
    recordInputBurst(25, false)
    recordInputBurst(25, false)
    recordInputBurst(25, false)
    expect(isSuspectedPaste()).toBe(true)
  })

  it('does not flag BPM-wrapped batches regardless of size', () => {
    recordInputBurst(500, true)
    expect(isSuspectedPaste()).toBe(false)
  })

  it('BPM-marked batches clear pending samples (legitimate paste path)', () => {
    recordInputBurst(40, false)
    // 40 chars alone is under threshold but lingering. A subsequent BPM
    // paste should not retroactively trip the gate by combining with the
    // earlier unbracketed bytes.
    recordInputBurst(200, true)
    recordInputBurst(20, false)
    expect(isSuspectedPaste()).toBe(false)
  })

  it('does not flag batches separated by more than the window', async () => {
    recordInputBurst(30, false)
    await new Promise(resolve =>
      setTimeout(resolve, BURST_DETECTOR_THRESHOLDS.windowMs + 20),
    )
    recordInputBurst(30, false)
    expect(isSuspectedPaste()).toBe(false)
  })

  it('consumeSuspectedPaste clears the flag (one-shot)', () => {
    recordInputBurst(100, false)
    expect(consumeSuspectedPaste()).toBe(true)
    expect(consumeSuspectedPaste()).toBe(false)
    expect(isSuspectedPaste()).toBe(false)
  })

  it('does not count terminal responses as input (the auto theme background poll)', () => {
    // What xterm answers to the two-second background poll: an OSC 11 report
    // and a DA1 report, 61 characters in one stdin chunk.
    const reports = '\x1b]11;rgb:1e1e/1e1e/1e1e\x07\x1b[?64;1;2;6;9;15;16;17;18;21;22;28c'
    expect(reports.length).toBeGreaterThan(BURST_DETECTOR_THRESHOLDS.charThreshold)
    parseMultipleKeypresses(INITIAL_STATE, reports)
    // Two polls answered in the same window, and other report kinds.
    parseMultipleKeypresses(INITIAL_STATE, `${reports}${reports}\x1bP>|xterm(370)\x1b\\\x1b[>41;370;0c\x1b[?2026;2$y\x1b[?1u\x1b[?12;40R`)
    expect(isSuspectedPaste()).toBe(false)
    // Typed characters next to a report still count as themselves only.
    parseMultipleKeypresses(INITIAL_STATE, `ab${reports}c`)
    expect(isSuspectedPaste()).toBe(false)
  })

  it('still flags an unbracketed burst that arrives with a terminal response', () => {
    const reports = '\x1b]11;rgb:1e1e/1e1e/1e1e\x07\x1b[?64;1;2c'
    parseMultipleKeypresses(INITIAL_STATE, `${reports}${'x'.repeat(BURST_DETECTOR_THRESHOLDS.charThreshold + 1)}`)
    expect(consumeSuspectedPaste()).toBe(true)
  })

  it('records nothing when called with zero or negative chars', () => {
    recordInputBurst(0, false)
    recordInputBurst(-5, false)
    expect(isSuspectedPaste()).toBe(false)
  })
})
