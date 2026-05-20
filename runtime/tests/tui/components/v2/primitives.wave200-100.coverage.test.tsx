import React from 'react'
import { describe, expect, it } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { DiffInline } from './primitives.js'

describe('v2 primitives coverage', () => {
  it('renders inline diffs with each row kind and optional line numbers', async () => {
    const output = await renderToString(
      <DiffInline
        file="runtime/src/tui/components/v2/primitives.tsx"
        stats="+2 -1"
        lines={[
          { kind: 'hunk', code: '@@ -12,3 +12,4 @@' },
          { kind: 'ctx', oldLine: '12', newLine: '12', code: 'const stable = true' },
          { kind: 'rem', oldLine: '13', code: 'const deleted = true' },
          { kind: 'add', newLine: '13', code: 'const added = true' },
        ]}
      />,
      100,
    )

    expect(output).toContain('DIFF')
    expect(output).toContain('primitives.tsx')
    expect(output).toContain('+2 -1')
    expect(output).toContain('@@ -12,3 +12,4 @@')
    expect(output).toContain('const stable = true')
    expect(output).toContain('const deleted = true')
    expect(output).toContain('const added = true')
  })
})
