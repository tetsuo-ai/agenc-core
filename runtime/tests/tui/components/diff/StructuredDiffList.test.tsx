import type { StructuredPatchHunk } from 'diff'
import React from 'react'
import { describe, expect, test, vi } from 'vitest'

vi.mock('../../ink.js', () => {
  const Passthrough = ({ children }: { readonly children?: React.ReactNode }) => (
    <>{children}</>
  )

  return {
    Box: Passthrough,
    NoSelect: Passthrough,
    Text: Passthrough,
  }
})

vi.mock('./StructuredDiff', () => ({
  StructuredDiff: ({
    dim,
    fileContent,
    filePath,
    firstLine,
    patch,
    width,
  }: {
    readonly dim: boolean
    readonly fileContent?: string
    readonly filePath: string
    readonly firstLine: string | null
    readonly patch: StructuredPatchHunk
    readonly width: number
  }) => (
    <span>
      {`diff:${patch.newStart}:${dim ? 'dim' : 'normal'}:${width}:${filePath}:${firstLine ?? 'none'}:${fileContent ?? 'empty'}`}
    </span>
  ),
}))

import { StructuredDiffList } from './StructuredDiffList.js'

function collectText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join('')
  }
  if (React.isValidElement(node)) {
    const element = node as React.ReactElement<{
      readonly children?: React.ReactNode
    }>
    if (typeof element.type === 'function') {
      const Component = element.type as (
        props: typeof element.props,
      ) => React.ReactNode
      return collectText(Component(element.props))
    }
    return collectText(element.props.children)
  }
  return ''
}

describe('StructuredDiffList', () => {
  test('renders each hunk with ellipsis separators', () => {
    const output = collectText(
      <StructuredDiffList
        dim
        fileContent="old file"
        filePath="src/app.ts"
        firstLine="import x"
        hunks={
          [
            { newStart: 10 },
            { newStart: 42 },
          ] as StructuredPatchHunk[]
        }
        width={88}
      />,
    )

    expect(output).toBe(
      'diff:10:dim:88:src/app.ts:import x:old file' +
        '...' +
        'diff:42:dim:88:src/app.ts:import x:old file',
    )
  })

  test('returns no rendered text for an empty hunk list', () => {
    expect(
      collectText(
        <StructuredDiffList
          dim={false}
          filePath="src/app.ts"
          firstLine={null}
          hunks={[]}
          width={80}
        />,
      ),
    ).toBe('')
  })
})
