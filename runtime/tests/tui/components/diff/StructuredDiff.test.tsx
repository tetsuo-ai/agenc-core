import { PassThrough } from 'node:stream'

import type { StructuredPatchHunk } from 'diff'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  colorDiffAvailable: true,
  colorDiffReturnsNull: false,
  colorLines: ['+ rendered line'],
  constructorCalls: [] as Array<{
    fileContent: string | null
    filePath: string
    firstLine: string | null
    patch: StructuredPatchHunk
  }>,
  fullscreen: false,
  renderCalls: [] as Array<{
    dim: boolean
    theme: string
    width: number
  }>,
  settings: {
    syntaxHighlightingDisabled: false,
  },
  sliceCalls: [] as Array<{ end?: number; line: string; start: number }>,
  theme: 'dark-theme',
}))

vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => harness.settings,
}))

vi.mock('../../ink.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../ink.js')>()
  return {
    ...actual,
    RawAnsi: ({
      lines,
      width,
    }: {
      readonly lines: readonly string[]
      readonly width: number
    }) =>
      React.createElement(
        actual.Text,
        null,
        `RawAnsi:${width}:${lines.join('|')}`,
      ),
    useTheme: () => [harness.theme],
  }
})

vi.mock('../../../utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => harness.fullscreen,
}))

vi.mock('../../../utils/sliceAnsi.js', () => ({
  default: (line: string, start: number, end?: number) => {
    harness.sliceCalls.push({ end, line, start })
    return line.slice(start, end)
  },
}))

vi.mock('./StructuredDiff/colorDiff', () => ({
  expectColorDiff: () => {
    if (!harness.colorDiffAvailable) return null
    return class FakeColorDiff {
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

      render(theme: string, width: number, dim: boolean): string[] | null {
        harness.renderCalls.push({ dim, theme, width })
        return harness.colorDiffReturnsNull ? null : harness.colorLines
      }
    }
  },
}))

vi.mock('./StructuredDiff/Fallback', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../../ink.js')
  return {
    StructuredDiffFallback: ({
      dim,
      patch,
      width,
    }: {
      readonly dim: boolean
      readonly patch: StructuredPatchHunk
      readonly width: number
    }) =>
      ReactModule.createElement(
        Text,
        null,
        `Fallback:${patch.oldStart}:${dim ? 'dim' : 'normal'}:${width}`,
      ),
  }
})

import { createRoot } from '../../ink/root.js'
import { StructuredDiff } from './StructuredDiff.js'

function patch(overrides: Partial<StructuredPatchHunk> = {}): StructuredPatchHunk {
  return {
    lines: [' context', '+added'],
    newLines: 2,
    newStart: 1,
    oldLines: 2,
    oldStart: 1,
    ...overrides,
  }
}

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
  stdout.resume()
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

  return { stdin, stdout }
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function renderDiffToText(
  props: Partial<React.ComponentProps<typeof StructuredDiff>> & {
    patch: StructuredPatchHunk
  },
): Promise<string> {
  let output = ''
  const { stdin, stdout } = createStreams()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  root.render(
    <StructuredDiff
      dim={props.dim ?? false}
      fileContent={props.fileContent}
      filePath={props.filePath ?? 'src/app.ts'}
      firstLine={props.firstLine ?? null}
      patch={props.patch}
      skipHighlighting={props.skipHighlighting}
      width={props.width ?? 80}
    />,
  )
  await sleep()
  root.unmount()
  stdin.end()
  stdout.end()
  await sleep()
  return stripAnsi(output)
}

beforeEach(() => {
  harness.colorDiffAvailable = true
  harness.colorDiffReturnsNull = false
  harness.colorLines = ['+ rendered line']
  harness.constructorCalls = []
  harness.fullscreen = false
  harness.renderCalls = []
  harness.settings = { syntaxHighlightingDisabled: false }
  harness.sliceCalls = []
  harness.theme = 'dark-theme'
})

describe('StructuredDiff', () => {
  test('falls back when highlighting is unavailable, disabled, skipped, or returns null', async () => {
    harness.colorDiffAvailable = false
    await expect(renderDiffToText({ patch: patch({ oldStart: 4 }) })).resolves.toContain(
      'Fallback:4:normal:80',
    )

    harness.colorDiffAvailable = true
    harness.settings.syntaxHighlightingDisabled = true
    await expect(
      renderDiffToText({ dim: true, patch: patch({ oldStart: 5 }), width: 44 }),
    ).resolves.toContain('Fallback:5:dim:44')

    harness.settings.syntaxHighlightingDisabled = false
    await expect(
      renderDiffToText({
        patch: patch({ oldStart: 6 }),
        skipHighlighting: true,
        width: 30,
      }),
    ).resolves.toContain('Fallback:6:normal:30')

    harness.colorDiffReturnsNull = true
    await expect(renderDiffToText({ patch: patch({ oldStart: 7 }) })).resolves.toContain(
      'Fallback:7:normal:80',
    )
  })

  test('renders a single RawAnsi column with safe floored widths and nullable file content', async () => {
    harness.colorLines = ['+ highlighted', ' context']
    const currentPatch = patch()

    const output = await renderDiffToText({
      dim: true,
      filePath: 'bin/run',
      firstLine: '#!/usr/bin/env node',
      patch: currentPatch,
      width: 20.8,
    })

    expect(output).toContain('RawAnsi:20:+ highlighted| context')
    expect(harness.constructorCalls).toEqual([
      {
        fileContent: null,
        filePath: 'bin/run',
        firstLine: '#!/usr/bin/env node',
        patch: currentPatch,
      },
    ])
    expect(harness.renderCalls).toEqual([
      { dim: true, theme: 'dark-theme', width: 20 },
    ])
    expect(harness.sliceCalls).toEqual([])
  })

  test('splits gutter and content columns in fullscreen mode', async () => {
    harness.fullscreen = true
    harness.colorLines = ['+ 12  added value', '  13  same value']
    const currentPatch = patch({
      newLines: 13,
      newStart: 1,
      oldLines: 13,
      oldStart: 1,
    })

    const output = await renderDiffToText({
      fileContent: 'const value = 1',
      patch: currentPatch,
      width: 24,
    })

    expect(output).toContain('RawAnsi:5:+ 12 |  13 ')
    expect(output).toContain('RawAnsi:19: added value| same value')
    expect(harness.sliceCalls).toEqual([
      { line: '+ 12  added value', start: 0, end: 5 },
      { line: '  13  same value', start: 0, end: 5 },
      { line: '+ 12  added value', start: 5, end: undefined },
      { line: '  13  same value', start: 5, end: undefined },
    ])
  })

  test('keeps single-column output when the computed gutter would consume the width', async () => {
    harness.fullscreen = true
    harness.colorLines = ['+ 999  added value']

    const output = await renderDiffToText({
      patch: patch({ newLines: 999, oldLines: 999 }),
      width: 3,
    })

    expect(output).toContain('RawAnsi:3:+ 999  added value')
    expect(harness.sliceCalls).toEqual([])
  })

  test('reuses cached renders and evicts old width variants after the cap', async () => {
    const currentPatch = patch()
    harness.colorLines = [' cached line']

    await renderDiffToText({ patch: currentPatch, width: 40 })
    await renderDiffToText({ patch: currentPatch, width: 40 })
    expect(harness.renderCalls).toHaveLength(1)

    await renderDiffToText({ patch: currentPatch, width: 41 })
    await renderDiffToText({ patch: currentPatch, width: 42 })
    await renderDiffToText({ patch: currentPatch, width: 43 })
    await renderDiffToText({ patch: currentPatch, width: 44 })
    await renderDiffToText({ patch: currentPatch, width: 40 })

    expect(harness.renderCalls.map(call => call.width)).toEqual([
      40,
      41,
      42,
      43,
      44,
      40,
    ])
  })
})
