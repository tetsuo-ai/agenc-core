import { beforeEach, describe, expect, it } from 'vitest'

import {
  BURST_DETECTOR_THRESHOLDS,
  consumeSuspectedPaste,
  isSuspectedPaste,
  recordInputBurst,
  resetBurstDetector,
} from './burst-detector.js'

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

  it('records nothing when called with zero or negative chars', () => {
    recordInputBurst(0, false)
    recordInputBurst(-5, false)
    expect(isSuspectedPaste()).toBe(false)
  })
})
