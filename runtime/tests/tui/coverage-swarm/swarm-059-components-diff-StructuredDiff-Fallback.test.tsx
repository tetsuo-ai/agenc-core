import type { StructuredPatchHunk } from 'diff'
import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../../src/utils/staticRender.js'
import {
  processAdjacentLines,
  StructuredDiffFallback,
  type LineObject,
} from '../../../src/tui/components/diff/StructuredDiff/Fallback.js'

function hunk(lines: string[], oldStart = 1): StructuredPatchHunk {
  return {
    lines,
    newLines: 0,
    newStart: oldStart,
    oldLines: 0,
    oldStart,
  } as StructuredPatchHunk
}

function renderFallback(options: {
  readonly dim?: boolean
  readonly lines: string[]
  readonly oldStart?: number
  readonly width?: number
}): Promise<string> {
  return renderToString(
    <StructuredDiffFallback
      dim={options.dim ?? false}
      patch={hunk(options.lines, options.oldStart)}
      width={options.width ?? 80}
    />,
    { columns: options.width ?? 80 },
  )
}

describe('StructuredDiffFallback coverage swarm 059', () => {
  test('skips sparse rows while pairing later remove and add candidates', () => {
    const sparse = [] as LineObject[]
    sparse.length = 3
    sparse[1] = {
      code: 'const label = oldName',
      i: 0,
      originalCode: 'const label = oldName',
      type: 'remove',
    }
    sparse[2] = {
      code: 'const label = newName',
      i: 0,
      originalCode: 'const label = newName',
      type: 'add',
    }

    const processed = processAdjacentLines(sparse)

    expect(processed).toHaveLength(2)
    expect(processed[0]?.wordDiff).toBe(true)
    expect(processed[0]?.matchedLine).toBe(processed[1])
    expect(processed[1]?.matchedLine).toBe(processed[0])
  })

  test('renders an empty hunk without emitting placeholder rows', async () => {
    const output = await renderFallback({ lines: [], width: 30 })

    expect(output.trim()).toBe('')
  })

  test('wraps word-level diff parts when the content column is narrow', async () => {
    const output = await renderFallback({
      lines: [
        '-prefixAlphaBetaGammaDelta old tail',
        '+prefixAlphaBetaGammaDelta new tail',
      ],
      oldStart: 12,
      width: 18,
    })

    expect(output).toContain('12 -prefixAlpha')
    expect(output).toContain('taGammaDelta')
    expect(output).toContain('old')
    expect(output).toContain('12 +prefixAlpha')
    expect(output).toContain('new')
  })

  test('uses standard rendering for dimmed minor changes and major changes', async () => {
    const dimOutput = await renderFallback({
      dim: true,
      lines: ['-prefix old tail', '+prefix new tail'],
      oldStart: 4,
      width: 50,
    })

    expect(dimOutput).toContain('4 -prefix old tail')
    expect(dimOutput).toContain('4 +prefix new tail')

    const majorChangeOutput = await renderFallback({
      lines: ['-short', '+a completely different replacement'],
      oldStart: 9,
      width: 40,
    })

    expect(majorChangeOutput).toContain('9 -short')
    expect(majorChangeOutput).toContain('9 +a completely different replacement')
  })
})
