import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../../src/utils/staticRender.js'
import { HighlightedCode } from '../../../src/tui/components/markdown/HighlightedCode.js'

const harness = vi.hoisted(() => ({
  syntaxHighlightingDisabled: false,
  fullscreen: false,
  colorFileAvailable: true,
  highlightedLines: [] as string[],
  expectColorFileCalls: 0,
  colorFileConstructors: [] as Array<{
    readonly code: string
    readonly filePath: string
  }>,
  renderCalls: [] as Array<{
    readonly width: number
    readonly dim: boolean
  }>,
  fallbackCalls: [] as Array<{
    readonly code: string
    readonly filePath: string
    readonly dim: boolean | undefined
    readonly skipColoring: boolean | undefined
  }>,
  measureCalls: 0,
  measureWidth: 0,
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../../src/tui/hooks/useSettings.js', () => ({
  useSettings: () => ({
    syntaxHighlightingDisabled: harness.syntaxHighlightingDisabled,
  }),
}))

vi.mock('../../../src/utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => harness.fullscreen,
}))

vi.mock('../../../src/tui/ink.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    measureElement: () => {
      harness.measureCalls += 1
      return { width: harness.measureWidth, height: 1 }
    },
  }
})

vi.mock(
  '../../../src/tui/components/markdown/HighlightedCodeFallback.js',
  async () => {
    return {
      HighlightedCodeFallback: (props: {
        readonly code: string
        readonly filePath: string
        readonly dim?: boolean
        readonly skipColoring?: boolean
      }) => {
        harness.fallbackCalls.push({
          code: props.code,
          filePath: props.filePath,
          dim: props.dim,
          skipColoring: props.skipColoring,
        })

        return null
      },
    }
  },
)

vi.mock('../../../src/tui/components/diff/StructuredDiff/colorDiff.js', () => ({
  expectColorFile: () => {
    harness.expectColorFileCalls += 1
    if (!harness.colorFileAvailable) return null

    return class MockColorFile {
      constructor(
        readonly code: string,
        readonly filePath: string,
      ) {
        harness.colorFileConstructors.push({ code, filePath })
      }

      render(_theme: unknown, width: number, dim: boolean): string[] {
        harness.renderCalls.push({ width, dim })
        return harness.highlightedLines
      }
    }
  },
}))

describe('HighlightedCode coverage swarm 038', () => {
  beforeEach(() => {
    harness.syntaxHighlightingDisabled = false
    harness.fullscreen = false
    harness.colorFileAvailable = true
    harness.highlightedLines = ['highlighted line']
    harness.expectColorFileCalls = 0
    harness.colorFileConstructors = []
    harness.renderCalls = []
    harness.fallbackCalls = []
    harness.measureCalls = 0
    harness.measureWidth = 0
  })

  test('uses the plain fallback without loading color helpers when highlighting is disabled', async () => {
    harness.syntaxHighlightingDisabled = true

    await renderToString(
      <HighlightedCode
        code="const disabled = 1"
        filePath="disabled.ts"
        width={60}
        dim
      />,
      80,
    )

    expect(harness.expectColorFileCalls).toBe(0)
    expect(harness.colorFileConstructors).toEqual([])
    expect(harness.fallbackCalls).toEqual([
      {
        code: 'const disabled = 1',
        filePath: 'disabled.ts',
        dim: true,
        skipColoring: true,
      },
    ])
  })

  test('uses the color-capable fallback when color helpers are unavailable', async () => {
    harness.colorFileAvailable = false

    await renderToString(
      <HighlightedCode
        code="let unavailable = 2"
        filePath="unavailable.ts"
        width={52}
      />,
      80,
    )

    expect(harness.expectColorFileCalls).toBe(1)
    expect(harness.colorFileConstructors).toEqual([])
    expect(harness.fallbackCalls).toEqual([
      {
        code: 'let unavailable = 2',
        filePath: 'unavailable.ts',
        dim: false,
        skipColoring: false,
      },
    ])
  })

  test('renders highlighted output without fullscreen gutters', async () => {
    harness.highlightedLines = [
      ' 1  const first = 1',
      '12  const twelfth = 12',
    ]

    const output = await renderToString(
      <HighlightedCode code="const first = 1" filePath="plain.ts" width={37} />,
      80,
    )

    expect(output).toContain(' 1  const first = 1')
    expect(output).toContain('12  const twelfth = 12')
    expect(harness.fallbackCalls).toEqual([])
    expect(harness.renderCalls).toEqual([{ width: 37, dim: false }])
  })

  test('uses the default render width when the width prop is omitted', async () => {
    harness.measureWidth = 62
    harness.highlightedLines = ['measured width line']

    await renderToString(
      <HighlightedCode code="const measured = 3" filePath="measured.ts" />,
      90,
    )

    expect(harness.renderCalls[0]).toEqual({ width: 80, dim: false })
  })
})
