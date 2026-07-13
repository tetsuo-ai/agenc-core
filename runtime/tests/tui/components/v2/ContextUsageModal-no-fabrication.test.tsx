import React from 'react'
import { describe, expect, it } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { ContextUsageModal } from './ContextUsageModal.js'

// M-TUI-3 / ContextUsageModal:187 (core-todo.md): the /context modal fabricated a
// per-file breakdown (hardcoded lib.rs/pool.rs/math.rs split by magic ratios) even
// though only an aggregate `files: N` number exists, and divided by hardLimit without
// guarding zero (auto-compact at Infinity%). Both are fixed.

describe('ContextUsageModal — no fabricated per-file rows', () => {
  it('does not render invented filenames when only aggregate file tokens exist', async () => {
    const output = await renderToString(
      <ContextUsageModal
        text={[
          'Context: 22,841 / 200,000 tokens (11% of hard limit)',
          '  • messages: 12,625 tokens',
          '  • files: 5,000 tokens',
          '  • tool catalog: 1,402 tokens',
        ].join('\n')}
        onDone={() => {}}
        active={false}
      />,
      100,
    )
    const upper = output.toUpperCase()
    expect(upper).not.toContain('LIB.RS')
    expect(upper).not.toContain('POOL.RS')
    expect(upper).not.toContain('MATH.RS')
    // The real aggregate is still shown.
    expect(upper).toContain('FILES')
  })

  it('does not render Infinity% when the hard limit is zero', async () => {
    const output = await renderToString(
      <ContextUsageModal
        text={[
          'Context: 0 / 0 tokens (0% of hard limit)',
          '  • compaction threshold: 187,000 tokens',
        ].join('\n')}
        onDone={() => {}}
        active={false}
      />,
      100,
    )
    expect(output).not.toContain('Infinity')
  })
})
