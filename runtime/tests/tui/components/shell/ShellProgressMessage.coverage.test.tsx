import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { ShellProgressMessage } from './ShellProgressMessage.js'

describe('ShellProgressMessage', () => {
  test('renders compact shell progress with the latest output and aggregate status', async () => {
    const output = [
      '\u001b[31mline 1\u001b[0m',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
    ].join('\n')

    const rendered = await renderToString(
      <ShellProgressMessage
        elapsedTimeSeconds={7}
        fullOutput={`setup\n${output}`}
        output={output}
        timeoutMs={120_000}
        totalBytes={1536}
        totalLines={9}
        verbose={false}
      />,
      80,
    )

    expect(rendered).toContain('line 3')
    expect(rendered).toContain('line 7')
    expect(rendered).not.toContain('line 1')
    expect(rendered).not.toContain('line 2')
    expect(rendered).not.toContain('setup')
    expect(rendered).toContain('~9 lines')
    expect(rendered).toContain('(7s · timeout 2m)')
    expect(rendered).toContain('1.5KB')
  })
})
