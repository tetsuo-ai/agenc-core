import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../../../utils/staticRender.js'
import { PreviewBox } from './PreviewBox.js'

vi.mock('../../../hooks/useSettings.js', () => ({
  useSettings: () => ({ syntaxHighlightingDisabled: true }),
}))

vi.mock('../../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 10, rows: 8 }),
}))

vi.mock('../../../ink.js', async () => {
  const actual = await vi.importActual<typeof import('../../../ink.js')>(
    '../../../ink.js',
  )
  return {
    ...actual,
    useTheme: () => ['dark'],
  }
})

describe('PreviewBox', () => {
  it('clamps tiny maxWidth values so borders never use negative repeat counts', async () => {
    const output = await renderToString(
      <PreviewBox content="abcdef" maxWidth={-20} minWidth={40} />,
      10,
    )

    expect(output).toContain('┌──┐')
    expect(output).toContain('└──┘')
    expect(output).not.toContain('ERROR')
  })
})
