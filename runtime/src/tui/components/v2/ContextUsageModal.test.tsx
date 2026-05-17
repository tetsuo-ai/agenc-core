import React from 'react'
import { describe, expect, it } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { ContextUsageModal } from './ContextUsageModal.js'

describe('ContextUsageModal', () => {
  it('renders structured context usage in the v2 modal shell', async () => {
    const output = await renderToString(
      <ContextUsageModal
        text={[
          'Context: 22,841 / 200,000 tokens (11% of hard limit)',
          '  • messages: 12,625 tokens',
          '  • tool catalog: 1,402 tokens',
          '  • compaction threshold: 187,000 tokens (164,159 until auto-compact fires)',
          '  • prompt cache: 75% hit (7,500 / 10,000 prompt tokens served from cache)',
        ].join('\n')}
        onDone={() => {}}
        active={false}
      />,
      100,
    )

    expect(output).toContain('CONTEXT')
    expect(output).toContain('22,841 / 200,000')
    expect(output).toContain('HISTORY')
    expect(output).toContain('12,625 tok')
    expect(output).toContain('TOOLS')
    expect(output).toContain('COMPACT AT')
    expect(output).toContain('PROMPT CACHE')
  })

  it('falls back to raw rows when context text is unstructured', async () => {
    const output = await renderToString(
      <ContextUsageModal
        text={'context · 22,841 / 200,000\nhistory · 12,625 tok'}
        onDone={() => {}}
        active={false}
      />,
      100,
    )

    expect(output).toContain('CONTEXT')
    expect(output).toContain('context · 22,841 / 200,000')
    expect(output).toContain('history · 12,625 tok')
  })
})
