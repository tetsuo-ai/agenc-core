import { describe, expect, test } from 'bun:test'
import { computeGithub429WaitMs } from '../../../src/services/api/openaiShim.ts'

// core-todo.md openaiShim:2242 — the GitHub/Copilot 429 retry slept a fixed
// exponential backoff and IGNORED the server's Retry-After header (it only
// decorated the final error). The wait now honors max(Retry-After, backoff),
// capped so a hostile header cannot stall the request.

describe('computeGithub429WaitMs — honors Retry-After', () => {
  test('with no header falls back to exponential backoff', () => {
    // attempt 0: base 1s * 2^0 = 1s.
    expect(computeGithub429WaitMs(0, null)).toBe(1_000)
    // attempt 2: 1s * 2^2 = 4s.
    expect(computeGithub429WaitMs(2, null)).toBe(4_000)
  })

  test('honors a Retry-After (seconds) longer than the backoff', () => {
    // Server says 30s; backoff at attempt 0 is 1s. Must wait the server's 30s.
    expect(computeGithub429WaitMs(0, '30')).toBe(30_000)
  })

  test('keeps the backoff when it exceeds a tiny Retry-After', () => {
    // attempt 3 backoff = min(8, 32) = 8s; server says 1s -> take the larger 8s.
    expect(computeGithub429WaitMs(3, '1')).toBe(8_000)
  })

  test('caps a pathological Retry-After', () => {
    // 999999s would stall forever; clamp to the 60s ceiling.
    expect(computeGithub429WaitMs(0, '999999')).toBe(60_000)
  })

  test('parses an HTTP-date Retry-After relative to now', () => {
    const now = 1_000_000_000_000
    // 25 seconds in the future.
    const future = new Date(now + 25_000).toUTCString()
    expect(computeGithub429WaitMs(0, future, now)).toBe(25_000)
  })

  test('a past HTTP-date yields no extra wait beyond the backoff', () => {
    const now = 1_000_000_000_000
    const past = new Date(now - 60_000).toUTCString()
    // Retry-After resolves to 0ms -> backoff (1s at attempt 0) wins.
    expect(computeGithub429WaitMs(0, past, now)).toBe(1_000)
  })

  test('ignores an unparseable header and uses the backoff', () => {
    expect(computeGithub429WaitMs(1, 'soon-ish')).toBe(2_000)
    expect(computeGithub429WaitMs(0, '   ')).toBe(1_000)
  })
})
