import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  ADDITIONAL_HYPERLINK_TERMINALS,
  supportsHyperlinks,
} from '../../../src/tui/ink/supports-hyperlinks.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('supportsHyperlinks coverage swarm row 194', () => {
  test('treats disabling env values as hard opt-outs before stdout support', () => {
    expect(
      supportsHyperlinks({
        env: {
          NO_COLOR: '1',
          TERM: 'dumb',
        },
        stdoutSupported: true,
      }),
    ).toBe(false)
    expect(
      supportsHyperlinks({
        env: {
          FORCE_HYPERLINK: '0',
        },
        stdoutSupported: true,
      }),
    ).toBe(false)
  })

  test('uses FORCE_HYPERLINK and disabling env values in default stdout detection', () => {
    expect(supportsHyperlinks({ env: { FORCE_HYPERLINK: '1' } })).toBe(true)
    expect(supportsHyperlinks({ env: { FORCE_HYPERLINK: '0' } })).toBe(false)
    expect(supportsHyperlinks({ env: { NO_COLOR: '1' } })).toBe(false)
  })

  test('detects extra terminal allowlist entries from TERM_PROGRAM and LC_TERMINAL', () => {
    expect(ADDITIONAL_HYPERLINK_TERMINALS).toContain('ghostty')

    expect(
      supportsHyperlinks({
        env: {
          TERM_PROGRAM: 'ghostty',
        },
      }),
    ).toBe(true)

    expect(
      supportsHyperlinks({
        env: {
          LC_TERMINAL: 'iTerm2',
          TERM_PROGRAM: 'tmux',
        },
      }),
    ).toBe(true)
  })

  test('detects kitty from TERM and rejects unrelated terminal env', () => {
    expect(
      supportsHyperlinks({
        env: {
          TERM: 'xterm-kitty',
        },
      }),
    ).toBe(true)

    expect(
      supportsHyperlinks({
        env: {
          LC_TERMINAL: 'screen',
          TERM: 'xterm-256color',
          TERM_PROGRAM: 'tmux',
        },
      }),
    ).toBe(false)
  })

  test('falls back to process env when no options are supplied', () => {
    vi.stubEnv('NO_COLOR', '')
    vi.stubEnv('FORCE_HYPERLINK', '1')

    expect(supportsHyperlinks()).toBe(true)
  })
})
