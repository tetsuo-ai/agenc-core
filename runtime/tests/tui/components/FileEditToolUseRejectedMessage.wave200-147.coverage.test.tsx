import { PassThrough } from 'node:stream'

import type { StructuredPatchHunk } from 'diff'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, test, vi } from 'vitest'

const childMocks = vi.hoisted(() => ({
  diffs: [] as Array<Record<string, unknown>>,
  highlighted: [] as Array<Record<string, unknown>>,
}))

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 72, rows: 24 }),
}))

vi.mock('../../utils/cwd.js', () => ({
  getCwd: () => '/repo',
}))

vi.mock('./markdown/HighlightedCode.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../ink.js')

  return {
    HighlightedCode: (props: Record<string, unknown>) => {
      childMocks.highlighted.push(props)
      return ReactModule.createElement(
        Text,
        null,
        `code:${props.filePath}:${props.width}:${props.code}`,
      )
    },
  }
})

vi.mock('./diff/StructuredDiffList.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../ink.js')

  return {
    StructuredDiffList: (props: Record<string, unknown>) => {
      childMocks.diffs.push(props)
      return ReactModule.createElement(
        Text,
        null,
        `diff:${props.filePath}:${props.firstLine ?? ''}:${props.width}`,
      )
    },
  }
})

import { createRoot } from '../ink/root.js'
import { FileEditToolUseRejectedMessage } from './FileEditToolUseRejectedMessage.js'

function createStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
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
  ;(stdout as unknown as { columns: number }).columns = 72
  return { stdin, stdout }
}

async function waitForOutput(
  readOutput: () => string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (readOutput().includes(expected)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for rendered output: ${expected}`)
}

describe('FileEditToolUseRejectedMessage wave200-147 coverage', () => {
  test('reuses memoized render branches across identical rerenders', async () => {
    childMocks.diffs = []
    childMocks.highlighted = []

    const patch: StructuredPatchHunk[] = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ['-const old = true', '+const next = true'],
      },
    ]
    const writeContent = Array.from(
      { length: 12 },
      (_, index) => `line ${index + 1}`,
    ).join('\n')
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
    const readOutput = () => stripAnsi(output)

    try {
      const renderTwice = async (node: React.ReactNode, expected: string) => {
        root.render(node)
        await waitForOutput(readOutput, expected)
        root.render(node)
        await waitForOutput(readOutput, expected)
      }

      await renderTwice(
        <FileEditToolUseRejectedMessage
          file_path="/repo/src/condensed.ts"
          firstLine={null}
          operation="update"
          style="condensed"
          verbose={false}
        />,
        'src/condensed.ts',
      )
      await renderTwice(
        <FileEditToolUseRejectedMessage
          content={writeContent}
          file_path="/repo/src/new.ts"
          firstLine={null}
          operation="write"
          verbose={false}
        />,
        '+2 lines',
      )
      await renderTwice(
        <FileEditToolUseRejectedMessage
          file_path="/repo/src/no-patch.ts"
          firstLine={null}
          operation="update"
          patch={[]}
          verbose={false}
        />,
        'src/no-patch.ts',
      )
      await renderTwice(
        <FileEditToolUseRejectedMessage
          fileContent="const old = true"
          file_path="/repo/src/changed.ts"
          firstLine="const old = true"
          operation="update"
          patch={patch}
          verbose={false}
        />,
        'diff:/repo/src/changed.ts:const old = true:60',
      )

      expect(readOutput()).toContain('User rejected write to')
      expect(readOutput()).toContain('code:/repo/src/new.ts:60:line 1')
      expect(readOutput()).toContain('line 10')
      expect(readOutput()).not.toContain('line 12')
      expect(childMocks.highlighted[0]).toMatchObject({
        dim: true,
        filePath: '/repo/src/new.ts',
        width: 60,
      })
      expect(childMocks.diffs[0]).toMatchObject({
        dim: true,
        fileContent: 'const old = true',
        filePath: '/repo/src/changed.ts',
        firstLine: 'const old = true',
        hunks: patch,
        width: 60,
      })
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })
})
