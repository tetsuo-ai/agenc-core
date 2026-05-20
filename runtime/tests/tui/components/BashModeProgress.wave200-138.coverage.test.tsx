import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { BashModeProgress } from './BashModeProgress.js'

describe('BashModeProgress wave200-138 coverage', () => {
  test('renders shell input with pending, compact, and verbose progress states', async () => {
    const pending = await renderToString(
      <BashModeProgress input="npm test -- --runInBand" progress={null} verbose={false} />,
      100,
    )

    expect(pending).toContain('! npm test -- --runInBand')
    expect(pending).toContain('Running')

    const compact = await renderToString(
      <BashModeProgress
        input="npm test -- --runInBand"
        progress={{
          elapsedTimeSeconds: 9,
          fullOutput: 'setup line\nline one\nline two\nline three\nline four\nline five',
          output: 'line one\nline two\nline three\nline four\nline five',
          totalLines: 9,
        }}
        verbose={false}
      />,
      100,
    )

    expect(compact).toContain('! npm test -- --runInBand')
    expect(compact).toContain('line one')
    expect(compact).toContain('line five')
    expect(compact).toContain('+4 lines')
    expect(compact).toContain('(9s)')
    expect(compact).not.toContain('setup line')

    const verbose = await renderToString(
      <BashModeProgress
        input="npm test -- --runInBand"
        progress={{
          elapsedTimeSeconds: 12,
          fullOutput: 'setup line\nfull detail\nfinal full line',
          output: 'tail detail only',
          totalLines: 3,
        }}
        verbose={true}
      />,
      100,
    )

    expect(verbose).toContain('setup line')
    expect(verbose).toContain('final full line')
    expect(verbose).toContain('(12s)')
    expect(verbose).not.toContain('tail detail only')
  })
})
