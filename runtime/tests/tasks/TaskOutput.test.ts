import { describe, expect, it } from 'vitest'

import { TaskOutput } from 'src/utils/task/TaskOutput.js'

type ProgressCall = {
  lastLines: string
  allLines: string
  totalLines: number
  totalBytes: number
  isIncomplete: boolean
}

function makePipeOutput() {
  const calls: ProgressCall[] = []
  const out = new TaskOutput(
    `test-${calls.length}-${calls.push.length}`,
    (lastLines, allLines, totalLines, totalBytes, isIncomplete) => {
      calls.push({ lastLines, allLines, totalLines, totalBytes, isIncomplete })
    },
    // pipe mode (hooks): data flows through writeStdout()
    false,
  )
  return { out, calls }
}

describe('TaskOutput pipe-mode progress (#updateProgress)', () => {
  it('extracts a chunk that is exactly one complete line', () => {
    // Regression: the backward scan only sliced text *between* newlines, so the
    // segment before the first newline (here the entire line) was dropped and
    // onProgress never fired for single-line writes — the common hooks case.
    const { out, calls } = makePipeOutput()
    out.writeStdout('done\n')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.lastLines).toBe('done')
  })

  it('extracts both lines of a two-line chunk in document order', () => {
    const { out, calls } = makePipeOutput()
    out.writeStdout('line1\nline2\n')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.lastLines).toBe('line1\nline2')
  })

  it('extracts a leading complete line plus an unterminated trailing line', () => {
    const { out, calls } = makePipeOutput()
    out.writeStdout('line1\nline2')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.lastLines).toBe('line1\nline2')
  })

  it('extracts a chunk that has no newline at all', () => {
    const { out, calls } = makePipeOutput()
    out.writeStdout('no newline here')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.lastLines).toBe('no newline here')
  })

  it('skips empty and whitespace-only writes (no progress callback)', () => {
    const { out, calls } = makePipeOutput()
    out.writeStdout('\n')
    out.writeStdout('   \n')

    expect(calls).toHaveLength(0)
  })

  it('accumulates totalBytes across writes', () => {
    const { out, calls } = makePipeOutput()
    out.writeStdout('abc\n')
    out.writeStdout('de\n')

    expect(out.totalBytes).toBe(7)
    expect(calls.at(-1)!.totalBytes).toBe(7)
  })
})
