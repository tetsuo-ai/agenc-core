import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { HighlightedCode } from './HighlightedCode.js'

const harness = vi.hoisted(() => ({
  renderCalls: [] as Array<{
    readonly theme: unknown
    readonly width: number
    readonly dim: boolean
  }>,
  reset() {
    harness.renderCalls = []
  },
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../../utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => true,
}))

vi.mock('../../hooks/useSettings.js', () => ({
  useSettings: () => ({
    syntaxHighlightingDisabled: false,
  }),
}))

vi.mock('../diff/StructuredDiff/colorDiff.js', () => ({
  expectColorFile: () =>
    class {
      render(theme: unknown, width: number, dim: boolean): string[] {
        harness.renderCalls.push({ theme, width, dim })
        return [' 1  const first = 1', '12  const twelfth = 12']
      }
    },
}))

describe('HighlightedCode wave200-121 coverage', () => {
  test('splits fullscreen line gutters from highlighted code output', async () => {
    harness.reset()
    const code = Array.from(
      { length: 12 },
      (_, index) => `const line${index + 1} = ${index + 1}`,
    ).join('\n')

    const output = await renderToString(
      <HighlightedCode code={code} filePath="fixture.ts" width={44} dim />,
      80,
    )

    expect(output).toContain(' 1  const first = 1')
    expect(output).toContain('12  const twelfth = 12')
    expect(harness.renderCalls).toEqual([
      expect.objectContaining({ width: 44, dim: true }),
    ])
  })
})
