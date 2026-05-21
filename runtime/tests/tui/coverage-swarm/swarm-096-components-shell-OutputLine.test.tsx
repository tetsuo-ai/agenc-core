import React from 'react'
import { afterEach, describe, expect, test } from 'vitest'

import { renderToString } from '../../../src/utils/staticRender.js'
import { InVirtualListContext } from '../../../src/tui/components/messageActions.js'
import {
  ExpandShellOutputProvider,
} from '../../../src/tui/components/shell/ExpandShellOutputContext.js'
import {
  OutputLine,
  linkifyUrlsInText,
  stripUnderlineAnsi,
  tryFormatJson,
  tryJsonFormatContent,
} from '../../../src/tui/components/shell/OutputLine.js'

const previousForceHyperlink = process.env.FORCE_HYPERLINK

afterEach(() => {
  if (previousForceHyperlink === undefined) {
    delete process.env.FORCE_HYPERLINK
  } else {
    process.env.FORCE_HYPERLINK = previousForceHyperlink
  }
})

describe('OutputLine coverage swarm 096', () => {
  test('formats valid JSON while preserving invalid or lossy JSON text', () => {
    expect(tryFormatJson('{"status":"ok","count":2}')).toBe(
      ['{', '  "status": "ok",', '  "count": 2', '}'].join('\n'),
    )

    expect(tryFormatJson('{not valid json')).toBe('{not valid json')

    const largeIntegerJson = '{"id":9007199254740993}'
    expect(tryFormatJson(largeIntegerJson)).toBe(largeIntegerJson)

    expect(tryJsonFormatContent('{"ok":true}\nplain line')).toBe(
      ['{', '  "ok": true', '}', 'plain line'].join('\n'),
    )

    const oversized = `{"payload":"${'x'.repeat(10_100)}"}`
    expect(tryJsonFormatContent(oversized)).toBe(oversized)
  })

  test('linkifies JSON URLs and strips only underline ANSI sequences', () => {
    process.env.FORCE_HYPERLINK = '1'

    const linked = linkifyUrlsInText(
      '{"url":"https://example.test/path?query=1"}',
    )

    expect(linked).toContain(
      '\u001b]8;;https://example.test/path?query=1\u0007',
    )
    expect(linked).toContain('\u001b]8;;\u0007')

    expect(
      stripUnderlineAnsi(
        'a\u001b[4mb\u001b[1;4;31mc\u001b[4;31md',
      ),
    ).toBe('abcd')
    expect(stripUnderlineAnsi('\u001b[31mred\u001b[0m')).toBe(
      '\u001b[31mred\u001b[0m',
    )
  })

  test('truncates ordinary output and suppresses expand hints inside virtual lists', async () => {
    const content = Array.from(
      { length: 7 },
      (_, index) => `line ${index + 1}`,
    ).join('\n')

    const output = await renderToString(
      <InVirtualListContext.Provider value={true}>
        <OutputLine content={content} isWarning={true} linkifyUrls={false} />
      </InVirtualListContext.Provider>,
      { columns: 80, rows: 12 },
    )

    expect(output).toContain('line 1')
    expect(output).toContain('line 3')
    expect(output).toContain('+4 lines')
    expect(output).not.toContain('line 7')
    expect(output).not.toContain('to expand')
  })

  test('shows full formatted output when verbose or expand context is active', async () => {
    process.env.FORCE_HYPERLINK = '1'

    const verboseOutput = await renderToString(
      <OutputLine
        content={
          '{"url":"https://example.test/log","status":"ok"}\n' +
          'plain \u001b[4munderlined'
        }
        isError={true}
        linkifyUrls={true}
        verbose={true}
      />,
      { columns: 40, rows: 12, color: true },
    )

    expect(verboseOutput).toContain('"url": "https://example.test/log"')
    expect(verboseOutput).toContain('"status": "ok"')
    expect(verboseOutput).toContain('plain underlined')
    expect(verboseOutput).not.toContain('to expand')

    const expandedContent = Array.from(
      { length: 6 },
      (_, index) => `expanded ${index + 1}`,
    ).join('\n')
    const expandedOutput = await renderToString(
      <ExpandShellOutputProvider>
        <OutputLine content={expandedContent} linkifyUrls={false} />
      </ExpandShellOutputProvider>,
      { columns: 40, rows: 12 },
    )

    expect(expandedOutput).toContain('expanded 1')
    expect(expandedOutput).toContain('expanded 6')
    expect(expandedOutput).not.toContain('+3 lines')
  })
})
