import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { ShellProgressMessage } from './ShellProgressMessage.js'

describe('ShellProgressMessage wave200 coverage', () => {
  test('renders running, extra-line, and verbose shell output states', async () => {
    const running = await renderToString(
      <ShellProgressMessage
        elapsedTimeSeconds={undefined}
        fullOutput={'   \n'}
        output={'   \n\u001b[33m\u001b[0m   '}
        timeoutMs={90_000}
        verbose={false}
      />,
      80,
    )

    expect(running).toContain('Running')
    expect(running).toContain('(timeout 1m 30s)')
    expect(running).not.toContain('lines')

    const compact = await renderToString(
      <ShellProgressMessage
        elapsedTimeSeconds={3}
        fullOutput={'hidden setup\nalpha\nbeta\ngamma'}
        output={'alpha\nbeta\ngamma'}
        totalLines={8}
        verbose={false}
      />,
      80,
    )

    expect(compact).toContain('alpha')
    expect(compact).toContain('gamma')
    expect(compact).toContain('+3 lines')
    expect(compact).toContain('(3s)')
    expect(compact).not.toContain('hidden setup')

    const verbose = await renderToString(
      <ShellProgressMessage
        elapsedTimeSeconds={12}
        fullOutput={'\u001b[32mfirst full line\u001b[0m\nsecond full line\nlast full line'}
        output={'tail only 1\ntail only 2'}
        totalLines={12}
        verbose={true}
      />,
      80,
    )

    expect(verbose).toContain('first full line')
    expect(verbose).toContain('last full line')
    expect(verbose).toContain('(12s)')
    expect(verbose).not.toContain('tail only')
    expect(verbose).not.toContain('+7 lines')
    expect(verbose).not.toContain('~12 lines')
  })
})
