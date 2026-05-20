import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { DiagnosticsDisplay } from './DiagnosticsDisplay.js'

const diagnostic = {
  severity: 'Info' as const,
  range: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  },
  message: 'Unused value',
}

describe('DiagnosticsDisplay wave200-120 coverage', () => {
  test('renders compact empty, singular, and plural diagnostic states', async () => {
    const empty = await renderToString(
      <DiagnosticsDisplay
        attachment={{
          type: 'diagnostics',
          isNew: true,
          files: [],
        }}
        verbose={false}
      />,
      100,
    )
    const singular = await renderToString(
      <DiagnosticsDisplay
        attachment={{
          type: 'diagnostics',
          isNew: true,
          files: [
            {
              uri: 'file:///repo/src/single.ts',
              diagnostics: [diagnostic],
            },
          ],
        }}
        verbose={false}
      />,
      100,
    )
    const plural = await renderToString(
      <DiagnosticsDisplay
        attachment={{
          type: 'diagnostics',
          isNew: true,
          files: [
            {
              uri: 'file:///repo/src/first.ts',
              diagnostics: [diagnostic],
            },
            {
              uri: 'file:///repo/src/second.ts',
              diagnostics: [diagnostic, diagnostic],
            },
          ],
        }}
        verbose={false}
      />,
      100,
    )

    expect(empty.trim()).toBe('')
    expect(stripAnsi(singular)).toContain(
      'Found 1 new diagnostic issue in 1 file',
    )
    expect(stripAnsi(plural)).toContain(
      'Found 3 new diagnostic issues in 2 files',
    )
  })
})
