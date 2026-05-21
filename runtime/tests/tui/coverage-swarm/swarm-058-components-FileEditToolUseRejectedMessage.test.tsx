import { PassThrough } from 'node:stream'

import type { StructuredPatchHunk } from 'diff'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const childMocks = vi.hoisted(() => ({
  diffs: [] as Array<Record<string, unknown>>,
  highlighted: [] as Array<Record<string, unknown>>,
}))

vi.mock('../../../src/tui/hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 100, rows: 24 }),
}))

vi.mock('../../../src/utils/cwd.js', () => ({
  getCwd: () => '/workspace',
}))

vi.mock('../../../src/tui/components/markdown/HighlightedCode.js', async () => {
  const ReactModule = await import('react')
  const { default: Text } = await import('../../../src/tui/ink/components/Text.js')

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

vi.mock('../../../src/tui/components/diff/StructuredDiffList.js', async () => {
  const ReactModule = await import('react')
  const { default: Text } = await import('../../../src/tui/ink/components/Text.js')

  return {
    StructuredDiffList: (props: Record<string, unknown>) => {
      childMocks.diffs.push(props)
      return ReactModule.createElement(
        Text,
        null,
        `diff:${props.filePath}:${props.firstLine ?? 'null'}:${props.width}`,
      )
    },
  }
})

import { renderToString } from '../../../src/utils/staticRender.js'
import { createRoot, Text } from '../../../src/tui/ink.js'
import { FileEditToolUseRejectedMessage } from '../../../src/tui/components/FileEditToolUseRejectedMessage.js'

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
  ;(stdout as unknown as { columns: number }).columns = 100

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

type Scenario = 'write' | 'missingPatch' | 'diff' | 'condensed'

function MemoHarness({
  patch,
  scenario,
  tick,
}: {
  patch: StructuredPatchHunk[]
  scenario: Scenario
  tick: number
}): React.ReactElement {
  const shared = {
    file_path: '/workspace/src/row058.ts',
    firstLine: null,
    verbose: false,
  } as const

  let message: React.ReactElement
  if (scenario === 'write') {
    message = (
      <FileEditToolUseRejectedMessage
        {...shared}
        content="alpha"
        operation="write"
      />
    )
  } else if (scenario === 'missingPatch') {
    message = (
      <FileEditToolUseRejectedMessage
        {...shared}
        operation="update"
      />
    )
  } else if (scenario === 'diff') {
    message = (
      <FileEditToolUseRejectedMessage
        {...shared}
        fileContent="before"
        operation="update"
        patch={patch}
      />
    )
  } else {
    message = (
      <FileEditToolUseRejectedMessage
        {...shared}
        operation="update"
        style="condensed"
      />
    )
  }

  return (
    <>
      <Text>{`tick:${tick}`}</Text>
      {message}
    </>
  )
}

describe('FileEditToolUseRejectedMessage coverage swarm row 058', () => {
  beforeEach(() => {
    childMocks.diffs = []
    childMocks.highlighted = []
  })

  test('reuses memoized write, missing-patch, and diff render branches', async () => {
    const patch: StructuredPatchHunk[] = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ['-before', '+after'],
      },
    ]
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
      const renderScenario = async (scenario: Scenario, tick: number) => {
        root.render(<MemoHarness patch={patch} scenario={scenario} tick={tick} />)
        await waitForOutput(readOutput, `tick:${tick}`)
      }

      await renderScenario('write', 1)
      await renderScenario('write', 2)
      await renderScenario('missingPatch', 3)
      await renderScenario('missingPatch', 4)
      await renderScenario('diff', 5)
      await renderScenario('diff', 6)
      await renderScenario('condensed', 7)
      await renderScenario('condensed', 8)

      expect(readOutput()).toContain('User rejected write to')
      expect(readOutput()).toContain('User rejected update to')
      expect(readOutput()).toContain('src/row058.ts')
      expect(readOutput()).toContain('code:/workspace/src/row058.ts:88:alpha')
      expect(readOutput()).toContain('diff:/workspace/src/row058.ts:null:88')
      expect(childMocks.highlighted).toHaveLength(1)
      expect(childMocks.diffs).toHaveLength(1)
      expect(childMocks.diffs[0]).toMatchObject({
        dim: true,
        fileContent: 'before',
        filePath: '/workspace/src/row058.ts',
        firstLine: null,
        hunks: patch,
        width: 88,
      })
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })

  test('treats condensed verbose output as a normal verbose rejection', async () => {
    const output = await renderToString(
      <FileEditToolUseRejectedMessage
        file_path="/workspace/src/verbose.ts"
        firstLine={null}
        operation="update"
        patch={[]}
        style="condensed"
        verbose={true}
      />,
      100,
    )

    expect(output).toContain('User rejected update to')
    expect(output).toContain('/workspace/src/verbose.ts')
  })
})
