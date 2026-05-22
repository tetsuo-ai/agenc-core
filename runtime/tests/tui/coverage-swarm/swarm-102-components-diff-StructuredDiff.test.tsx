import { PassThrough } from 'node:stream'

import type { StructuredPatchHunk } from 'diff'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  colorLines: ['+ highlighted line'],
  constructorCalls: [] as Array<{
    readonly fileContent: string | null
    readonly filePath: string
    readonly firstLine: string | null
    readonly patch: StructuredPatchHunk
  }>,
  fallbackCalls: [] as Array<{
    readonly dim: boolean
    readonly patch: StructuredPatchHunk
    readonly width: unknown
  }>,
  fullscreen: false,
  rawAnsiCalls: [] as Array<{
    readonly lines: readonly string[]
    readonly width: number
  }>,
  renderCalls: [] as Array<{
    readonly dim: boolean
    readonly theme: string
    readonly width: number
  }>,
  settings: {
    syntaxHighlightingDisabled: false,
  },
  sliceCalls: [] as Array<{ readonly end?: number; readonly line: string; readonly start: number }>,
  theme: 'dark-theme',
}))

vi.mock('../../../src/tui/hooks/useSettings.js', () => ({
  useSettings: () => harness.settings,
}))

vi.mock('../../../src/tui/ink.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/tui/ink.js')>()
  return {
    ...actual,
    RawAnsi: ({
      lines,
      width,
    }: {
      readonly lines: readonly string[]
      readonly width: number
    }) => {
      harness.rawAnsiCalls.push({ lines, width })
      return React.createElement(
        actual.Text,
        null,
        `RawAnsi:${width}:${lines.join('|')}`,
      )
    },
    useTheme: () => [harness.theme],
  }
})

vi.mock('../../../src/utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => harness.fullscreen,
}))

vi.mock('../../../src/utils/sliceAnsi.js', () => ({
  default: (line: string, start: number, end?: number) => {
    harness.sliceCalls.push({ end, line, start })
    return line.slice(start, end)
  },
}))

vi.mock('../../../src/tui/components/diff/StructuredDiff/colorDiff.js', () => ({
  expectColorDiff: () =>
    class FakeColorDiff {
      constructor(
        patch: StructuredPatchHunk,
        firstLine: string | null,
        filePath: string,
        fileContent: string | null,
      ) {
        harness.constructorCalls.push({
          fileContent,
          filePath,
          firstLine,
          patch,
        })
      }

      render(theme: string, width: number, dim: boolean): string[] {
        harness.renderCalls.push({ dim, theme, width })
        return harness.colorLines
      }
    },
}))

vi.mock('../../../src/tui/components/diff/StructuredDiff/Fallback.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../../../src/tui/ink.js')
  return {
    StructuredDiffFallback: ({
      dim,
      patch,
      width,
    }: {
      readonly dim: boolean
      readonly patch: StructuredPatchHunk
      readonly width: unknown
    }) => {
      harness.fallbackCalls.push({ dim, patch, width })
      return ReactModule.createElement(
        Text,
        null,
        `Fallback:${patch.oldStart}:${dim ? 'dim' : 'normal'}:${String(width)}`,
      )
    },
  }
})

import { createRoot } from '../../../src/tui/ink/root.js'
import { StructuredDiff } from '../../../src/tui/components/diff/StructuredDiff.js'

function patch(overrides: Partial<StructuredPatchHunk> = {}): StructuredPatchHunk {
  return {
    lines: [' context', '-old value', '+new value'],
    newLines: 3,
    newStart: 1,
    oldLines: 3,
    oldStart: 1,
    ...overrides,
  }
}

function widthObject(value: number): number {
  return new Number(value) as unknown as number
}

async function sleep(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 25))
}

async function createTestRoot(): Promise<{
  readonly cleanup: () => Promise<void>
  readonly output: () => string
  readonly render: (
    props: Partial<React.ComponentProps<typeof StructuredDiff>> & {
      readonly patch: StructuredPatchHunk
      readonly width: number
    },
  ) => Promise<void>
}> {
  let output = ''
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  ;(stdout as unknown as { columns: number; rows: number }).columns = 120
  ;(stdout as unknown as { columns: number; rows: number }).rows = 30

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

  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  return {
    cleanup: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
    output: () => stripAnsi(output),
    render: async props => {
      root.render(
        <StructuredDiff
          dim={props.dim ?? false}
          fileContent={props.fileContent}
          filePath={props.filePath ?? 'src/example.ts'}
          firstLine={props.firstLine ?? null}
          patch={props.patch}
          skipHighlighting={props.skipHighlighting}
          width={props.width}
        />,
      )
      await sleep()
    },
  }
}

beforeEach(() => {
  harness.colorLines = ['+ highlighted line']
  harness.constructorCalls = []
  harness.fallbackCalls = []
  harness.fullscreen = false
  harness.rawAnsiCalls = []
  harness.renderCalls = []
  harness.settings = { syntaxHighlightingDisabled: false }
  harness.sliceCalls = []
  harness.theme = 'dark-theme'
})

describe('StructuredDiff coverage swarm 102', () => {
  test('reuses the single-column highlighted element when only raw width identity changes', async () => {
    harness.colorLines = ['+ tiny terminal line']
    const currentPatch = patch({ oldStart: 8 })
    const root = await createTestRoot()

    try {
      await root.render({
        fileContent: undefined,
        filePath: 'bin/run',
        firstLine: '#!/usr/bin/env node',
        patch: currentPatch,
        width: widthObject(0.2),
      })
      await root.render({
        fileContent: undefined,
        filePath: 'bin/run',
        firstLine: '#!/usr/bin/env node',
        patch: currentPatch,
        width: widthObject(0.8),
      })

      expect(root.output()).toContain('RawAnsi:1:+ tiny terminal line')
      expect(harness.constructorCalls).toEqual([
        {
          fileContent: null,
          filePath: 'bin/run',
          firstLine: '#!/usr/bin/env node',
          patch: currentPatch,
        },
      ])
      expect(harness.renderCalls).toEqual([
        { dim: false, theme: 'dark-theme', width: 1 },
      ])
      expect(harness.rawAnsiCalls).toHaveLength(1)
      expect(harness.sliceCalls).toEqual([])
    } finally {
      await root.cleanup()
    }
  })

  test('reuses pre-split gutter columns on same-safe-width rerenders', async () => {
    harness.fullscreen = true
    harness.colorLines = ['+ 1001 added value', '  1002 same value']
    const currentPatch = patch({
      newLines: 2,
      newStart: 1000,
      oldLines: 3,
      oldStart: 998,
    })
    const root = await createTestRoot()

    try {
      await root.render({ patch: currentPatch, width: widthObject(30.1) })
      await root.render({ patch: currentPatch, width: widthObject(30.9) })

      expect(root.output()).toContain('RawAnsi:7:+ 1001 |  1002 ')
      expect(root.output()).toContain('RawAnsi:23:added value|same value')
      expect(harness.renderCalls).toEqual([
        { dim: false, theme: 'dark-theme', width: 30 },
      ])
      expect(harness.rawAnsiCalls).toHaveLength(2)
      expect(harness.sliceCalls).toEqual([
        { end: 7, line: '+ 1001 added value', start: 0 },
        { end: 7, line: '  1002 same value', start: 0 },
        { end: undefined, line: '+ 1001 added value', start: 7 },
        { end: undefined, line: '  1002 same value', start: 7 },
      ])
    } finally {
      await root.cleanup()
    }
  })

  test('reuses the fallback element when skipped highlighting rerenders with a new file path', async () => {
    const currentPatch = patch({ oldStart: 21 })
    const root = await createTestRoot()

    try {
      await root.render({
        dim: true,
        filePath: 'src/first.ts',
        patch: currentPatch,
        skipHighlighting: true,
        width: 44,
      })
      await root.render({
        dim: true,
        filePath: 'src/second.ts',
        patch: currentPatch,
        skipHighlighting: true,
        width: 44,
      })

      expect(root.output()).toContain('Fallback:21:dim:44')
      expect(harness.renderCalls).toEqual([])
      expect(harness.rawAnsiCalls).toEqual([])
      expect(harness.fallbackCalls).toEqual([
        {
          dim: true,
          patch: currentPatch,
          width: 44,
        },
      ])
    } finally {
      await root.cleanup()
    }
  })
})
