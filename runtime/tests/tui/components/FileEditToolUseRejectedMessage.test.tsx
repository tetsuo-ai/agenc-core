import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { ContentWidthProvider } from '../context/contentWidthContext.js'
import { Text } from '../ink.js'
import { FileEditToolUseRejectedMessage } from './FileEditToolUseRejectedMessage.js'

const renderHarness = vi.hoisted(() => ({
  highlightedCode: [] as Array<Record<string, unknown>>,
  structuredDiffs: [] as Array<Record<string, unknown>>,
}))

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 80, rows: 24 }),
}))

vi.mock('../../utils/cwd.js', () => ({
  getCwd: () => '/repo',
}))

vi.mock('./markdown/HighlightedCode.js', () => ({
  HighlightedCode: (props: {
    code: string
    filePath: string
    width: number
  }) => {
    renderHarness.highlightedCode.push(props)
    return <Text>{`${props.filePath}:${props.code}:${props.width}`}</Text>
  },
}))

vi.mock('./diff/StructuredDiffList.js', () => ({
  StructuredDiffList: (props: {
    filePath: string
    firstLine: string | null
    width: number
  }) => {
    renderHarness.structuredDiffs.push(props)
    return <Text>{`diff:${props.filePath}:${props.firstLine ?? ''}:${props.width}`}</Text>
  },
}))

describe('FileEditToolUseRejectedMessage', () => {
  beforeEach(() => {
    renderHarness.highlightedCode = []
    renderHarness.structuredDiffs = []
  })

  test('renders condensed rejection with a relative path', async () => {
    const output = await renderToString(
      <FileEditToolUseRejectedMessage
        file_path="/repo/src/file.ts"
        firstLine={null}
        operation="update"
        style="condensed"
        verbose={false}
      />,
      80,
    )

    expect(output).toContain('User rejected update to')
    expect(output).toContain('src/file.ts')
  })

  test('renders write previews with truncation and full verbose content', async () => {
    const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')

    const compact = await renderToString(
      <FileEditToolUseRejectedMessage
        content={content}
        file_path="/repo/src/new.ts"
        firstLine={null}
        operation="write"
        verbose={false}
      />,
      80,
    )

    expect(compact).toContain('src/new.ts')
    expect(compact).toContain('line 10')
    expect(compact).toContain('+2 lines')
    expect(compact).not.toContain('line 12')

    const verbose = await renderToString(
      <FileEditToolUseRejectedMessage
        content={content}
        file_path="/repo/src/new.ts"
        firstLine={null}
        operation="write"
        verbose
      />,
      80,
    )

    expect(verbose).toContain('/repo/src/new.ts')
    expect(verbose).toContain('line 12')
    expect(verbose).not.toContain('+2 lines')
  })

  test('renders empty writes, missing patches, and structured diffs', async () => {
    await expect(
      renderToString(
        <FileEditToolUseRejectedMessage
          content=""
          file_path="/repo/empty.ts"
          firstLine={null}
          operation="write"
          verbose={false}
        />,
        80,
      ),
    ).resolves.toContain('(No content)')

    await expect(
      renderToString(
        <FileEditToolUseRejectedMessage
          file_path="/repo/no-patch.ts"
          firstLine={null}
          operation="update"
          patch={[]}
          verbose={false}
        />,
        80,
      ),
    ).resolves.toContain('no-patch.ts')

    await expect(
      renderToString(
        <FileEditToolUseRejectedMessage
          fileContent="old"
          file_path="/repo/changed.ts"
          firstLine="old"
          operation="update"
          patch={[{ lines: ['-old', '+new'] }] as never}
          verbose={false}
        />,
        80,
      ),
    ).resolves.toContain('diff:/repo/changed.ts:old')
  })

  test('sizes rejected write previews from inherited content width', async () => {
    await renderToString(
      <ContentWidthProvider width={64}>
        <FileEditToolUseRejectedMessage
          content="const value = 1"
          file_path="/repo/src/new.ts"
          firstLine={null}
          operation="write"
          verbose={false}
        />
      </ContentWidthProvider>,
      120,
    )

    expect(renderHarness.highlightedCode.at(-1)).toMatchObject({ width: 52 })
  })

  test('sizes rejected update diffs from inherited content width', async () => {
    await renderToString(
      <ContentWidthProvider width={64}>
        <FileEditToolUseRejectedMessage
          fileContent="old"
          file_path="/repo/changed.ts"
          firstLine="old"
          operation="update"
          patch={[{ lines: ['-old', '+new'] }] as never}
          verbose={false}
        />
      </ContentWidthProvider>,
      120,
    )

    expect(renderHarness.structuredDiffs.at(-1)).toMatchObject({ width: 52 })
  })
})
