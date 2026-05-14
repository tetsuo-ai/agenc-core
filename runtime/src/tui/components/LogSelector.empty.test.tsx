import React from 'react'
import { describe, expect, it } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { LogSelectorEmptyState } from './LogSelector.js'

describe('LogSelectorEmptyState', () => {
  it('renders a visible empty state for no resumable sessions', async () => {
    const output = await renderToString(
      <LogSelectorEmptyState exitState={{ pending: false, keyName: 'Esc' }} />,
      80,
    )

    expect(output).toContain('Resume Session')
    expect(output).toContain('No resumable sessions found.')
    expect(output).toContain('Start a conversation to create resume history.')
    expect(output).toContain('Esc')
  })

  it('shows the exit confirmation hint while exit is pending', async () => {
    const output = await renderToString(
      <LogSelectorEmptyState exitState={{ pending: true, keyName: 'Ctrl-C' }} />,
      80,
    )

    expect(output).toContain('Press Ctrl-C again to exit')
  })
})
