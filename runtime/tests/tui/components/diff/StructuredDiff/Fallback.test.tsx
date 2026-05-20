import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, test } from 'vitest'

import { createRoot } from '../../../ink.js'
import {
  calculateWordDiffs,
  numberDiffLines,
  processAdjacentLines,
  StructuredDiffFallback,
  transformLinesToObjects,
  type LineObject,
} from './Fallback.js'

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
  return { stdin, stdout }
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function renderFallbackToText(props: {
  readonly dim?: boolean
  readonly lines: string[]
  readonly oldStart?: number
  readonly width?: number
}): Promise<string> {
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
    <StructuredDiffFallback
      dim={props.dim ?? false}
      patch={{
        lines: props.lines,
        newLines: 0,
        newStart: props.oldStart ?? 1,
        oldLines: 0,
        oldStart: props.oldStart ?? 1,
      }}
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

describe('StructuredDiffFallback helpers', () => {
  test('transforms patch lines into typed line objects', () => {
    expect(transformLinesToObjects([' context', '+added', '-removed'])).toEqual([
      {
        code: 'context',
        i: 0,
        originalCode: 'context',
        type: 'nochange',
      },
      {
        code: 'added',
        i: 0,
        originalCode: 'added',
        type: 'add',
      },
      {
        code: 'removed',
        i: 0,
        originalCode: 'removed',
        type: 'remove',
      },
    ])
  })

  test('pairs adjacent remove/add lines and keeps unpaired removals', () => {
    const lines = transformLinesToObjects([
      '-old name',
      '-old extra',
      '+new name',
      ' context',
      '-orphan',
    ])

    const processed = processAdjacentLines(lines)

    expect(processed.map(line => line.type)).toEqual([
      'remove',
      'remove',
      'add',
      'nochange',
      'remove',
    ])
    expect(processed[0]?.wordDiff).toBe(true)
    expect(processed[0]?.matchedLine).toBe(processed[2])
    expect(processed[1]?.wordDiff).toBeUndefined()
    expect(processed[4]?.wordDiff).toBeUndefined()
  })

  test('numbers removals without advancing the following added line too far', () => {
    const diff: LineObject[] = [
      { code: 'same', i: 0, originalCode: 'same', type: 'nochange' },
      { code: 'remove one', i: 0, originalCode: 'remove one', type: 'remove' },
      { code: 'remove two', i: 0, originalCode: 'remove two', type: 'remove' },
      { code: 'add one', i: 0, originalCode: 'add one', type: 'add' },
    ]

    expect(numberDiffLines(diff, 10).map(line => [line.type, line.i])).toEqual([
      ['nochange', 10],
      ['remove', 11],
      ['remove', 12],
      ['add', 11],
    ])
  })

  test('preserves whitespace in word-level diffs', () => {
    const parts = calculateWordDiffs('const value = oldName', 'const value = newName')

    expect(parts.map(part => part.value).join('')).toContain('const value = ')
    expect(parts.some(part => part.removed && part.value === 'oldName')).toBe(true)
    expect(parts.some(part => part.added && part.value === 'newName')).toBe(true)
  })
})

describe('StructuredDiffFallback rendering', () => {
  test('renders word-level add and remove pairs with line numbers', async () => {
    const output = await renderFallbackToText({
      lines: [
        ' function read() {',
        '-  return value.oldName',
        '+  return value.newName',
      ],
      oldStart: 7,
      width: 60,
    })

    expect(output).toContain('7  function read()')
    expect(output).toContain('8 -  return value.oldName')
    expect(output).toContain('8 +  return value.newName')
  })

  test('falls back to standard dim rendering and wraps narrow content', async () => {
    const output = await renderFallbackToText({
      dim: true,
      lines: [
        '-completely different removed line with lots of text',
        '+tiny',
        ' unchanged line that is long enough to wrap',
      ],
      oldStart: 1,
      width: 14,
    })

    expect(output).toContain('1 -complet')
    expect(output).toContain('different')
    expect(output).toContain('1 +tiny')
    expect(output).toContain('2  unchanged')
  })

  test('clamps invalid widths to a safe minimum', async () => {
    const output = await renderFallbackToText({
      lines: ['+x'],
      oldStart: 3,
      width: 0,
    })

    expect(output).toContain('3 +')
    expect(output).toContain('x')
  })
})
