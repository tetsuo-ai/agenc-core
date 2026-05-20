import { PassThrough } from 'node:stream'

import type { StructuredPatchHunk } from 'diff'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { createRoot } from '../ink/root.js'
import { FileEditToolUpdatedMessage } from './FileEditToolUpdatedMessage.js'

const structuredDiffMock = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}))

vi.mock('../hooks/useTerminalSize', () => ({
  useTerminalSize: () => ({ columns: 72, rows: 24 }),
}))

vi.mock('./diff/StructuredDiffList', async () => {
  const ReactModule = await import('react')
  return {
    StructuredDiffList: (props: Record<string, unknown>) => {
      structuredDiffMock.calls.push(props)
      return ReactModule.createElement(ReactModule.Fragment)
    },
  }
})

const mixedHunk: StructuredPatchHunk = {
  oldStart: 1,
  oldLines: 2,
  newStart: 1,
  newLines: 3,
  lines: [' context', '-old', '+new', '+newer'],
}

function renderUpdated(
  overrides: Partial<React.ComponentProps<typeof FileEditToolUpdatedMessage>> = {},
): Promise<string> {
  return renderToString(
    <FileEditToolUpdatedMessage
      filePath="/repo/src/file.ts"
      structuredPatch={[mixedHunk]}
      firstLine="const old = true"
      fileContent={'const old = true\n'}
      verbose={false}
      {...overrides}
    />,
    100,
  )
}

function createStreams(): {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()
  ;(stdout as unknown as { columns: number }).columns = 100
  return { stdin, stdout }
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('FileEditToolUpdatedMessage', () => {
  beforeEach(() => {
    structuredDiffMock.calls = []
  })

  test('renders addition/removal summary and passes diff props', async () => {
    const output = await renderUpdated()

    expect(output).toContain('Added 2 lines, removed 1 line')
    expect(structuredDiffMock.calls).toHaveLength(1)
    expect(structuredDiffMock.calls[0]).toMatchObject({
      dim: false,
      fileContent: 'const old = true\n',
      filePath: '/repo/src/file.ts',
      firstLine: 'const old = true',
      hunks: [mixedHunk],
      width: 60,
    })
  })

  test('renders singular additions without removals', async () => {
    const output = await renderUpdated({
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ['+new', ' context'],
        },
      ],
    })

    expect(output).toContain('Added 1 line')
    expect(output).not.toContain('removed')
  })

  test('capitalizes removal-only summaries and pluralizes removed lines', async () => {
    const output = await renderUpdated({
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 0,
          lines: ['-old', '-older', ' context'],
        },
      ],
    })

    expect(output).toContain('Removed 2 lines')
    expect(output).not.toContain('Added')
  })

  test('uses the preview hint instead of rendering the diff in brief expanded style', async () => {
    const output = await renderUpdated({ previewHint: '/plan to preview' })

    expect(output).toContain('/plan to preview')
    expect(structuredDiffMock.calls).toHaveLength(0)
  })

  test('condensed brief mode returns only the summary when there is no preview hint', async () => {
    const output = await renderUpdated({ style: 'condensed' })

    expect(output).toContain('Added 2 lines, removed 1 line')
    expect(structuredDiffMock.calls).toHaveLength(0)
  })

  test('verbose mode ignores preview hints and renders empty diffs', async () => {
    const output = await renderUpdated({
      structuredPatch: [],
      fileContent: undefined,
      firstLine: null,
      previewHint: '/plan to preview',
      verbose: true,
    })

    expect(output).not.toContain('/plan to preview')
    expect(structuredDiffMock.calls).toHaveLength(1)
    expect(structuredDiffMock.calls[0]).toMatchObject({
      fileContent: undefined,
      firstLine: null,
      hunks: [],
    })
  })

  test('reuses memoized render parts across identical rerenders', async () => {
    const { stdin, stdout } = createStreams()
    const structuredPatch = [mixedHunk]
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })
    const renderNode = () => (
        <FileEditToolUpdatedMessage
          filePath="/repo/src/file.ts"
          structuredPatch={structuredPatch}
          firstLine="const old = true"
          fileContent={'const old = true\n'}
          verbose={false}
      />
    )

    try {
      root.render(renderNode())
      await sleep()
      root.render(renderNode())
      await sleep()

      expect(stripAnsi(output)).toContain('Added 2 lines, removed 1 line')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })

  test('reuses memoized preview hints across identical rerenders', async () => {
    const { stdin, stdout } = createStreams()
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })
    const renderNode = () => (
      <FileEditToolUpdatedMessage
        filePath="/repo/src/file.ts"
        structuredPatch={[mixedHunk]}
        firstLine="const old = true"
        fileContent={'const old = true\n'}
        previewHint="/plan to preview"
        verbose={false}
      />
    )

    try {
      root.render(renderNode())
      await sleep()
      root.render(renderNode())
      await sleep()

      expect(stripAnsi(output)).toContain('/plan to preview')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })
})
