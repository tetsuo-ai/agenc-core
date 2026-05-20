import stripAnsi from 'strip-ansi'
import { describe, expect, test } from 'vitest'

import { __test, ColorDiff, ColorFile, getNativeModule } from './index.js'

describe('color-diff wave200-036 coverage', () => {
  test('renders daltonized narrow diffs and terminal detection edge cases', () => {
    const originalColorTerm = process.env.COLORTERM
    const rocket = '\u{1f680}'

    try {
      process.env.COLORTERM = '24bit'

      expect(__test.detectColorMode('plain')).toBe('truecolor')
      expect(__test.ansi256FromRgb(128, 128, 128)).toBe(244)
      expect(__test.colorToEscape({ r: 200, g: 0, b: 0, a: 0 }, true, 'ansi')).toBe(
        '\x1b[38;5;200m',
      )
      expect(
        __test.colorToEscape(
          { r: 128, g: 128, b: 128, a: 255 },
          false,
          'color256',
        ),
      ).toBe('\x1b[48;5;244m')
      expect(__test.detectLanguage('CMakeLists.txt', null)).toBe('cmake')
      expect(__test.detectLanguage('tool', '\ufeff#!/usr/bin/env node')).toBe(
        'javascript',
      )
      expect(__test.detectLanguage('tool', '#!/usr/bin/perl')).toBe('perl')
      expect(__test.detectLanguage('template', '<?php echo 1')).toBe('php')
      expect(__test.detectLanguage('feed', '<?xml version="1.0"')).toBe('xml')
      expect(getNativeModule()).toBe(getNativeModule())

      const darkLines = new ColorDiff(
        {
          oldStart: 7,
          oldLines: 0,
          newStart: 7,
          newLines: 1,
          lines: [`+a${rocket}`],
        },
        null,
        'note.txt',
        'prefix is accepted for API parity',
      ).render('dark-daltonized', 5, false)

      expect(darkLines).not.toBeNull()
      expect(darkLines!.join('')).toContain('\x1b[48;2;0;27;41m')
      expect(darkLines!.length).toBeGreaterThan(1)
      expect(darkLines!.map(line => stripAnsi(line)).join('\n')).toContain(
        `+${rocket}`,
      )

      const lightLines = new ColorDiff(
        {
          oldStart: 3,
          oldLines: 2,
          newStart: 3,
          newLines: 2,
          lines: ['-alpha beta', '+alpha zeta', ' context'],
        },
        null,
        'patch.txt',
      ).render('light-daltonized', 24, false)

      expect(lightLines).not.toBeNull()
      expect(lightLines!.join('')).toContain('\x1b[48;2;219;237;255m')
      expect(lightLines!.join('')).toContain('\x1b[48;2;179;217;255m')

      const lightPlain = lightLines!.map(line => stripAnsi(line)).join('\n')
      expect(lightPlain).toContain('-alpha beta')
      expect(lightPlain).toContain('+alpha zeta')
      expect(lightPlain).toContain('context')

      const fileLines = new ColorFile(
        '#!/usr/bin/env node\nconst value = 1\nconsole.log(value)',
        'script',
      ).render('light-daltonized', 7, true)

      expect(fileLines).not.toBeNull()
      expect(fileLines!.join('')).toContain('\x1b[0m\x1b[2m')

      const filePlain = fileLines!.map(line => stripAnsi(line)).join('\n')
      const compactFilePlain = filePlain.replace(/\s+/g, '')
      expect(filePlain).toContain('1 #!')
      expect(compactFilePlain).toContain('2constvalue=1')
    } finally {
      if (originalColorTerm === undefined) {
        delete process.env.COLORTERM
      } else {
        process.env.COLORTERM = originalColorTerm
      }
    }
  })
})
