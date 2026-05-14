import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: (name: string) => name === 'TRANSCRIPT_CLASSIFIER',
}))

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break

    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break

    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) {
      lastFrame = frame
    }
    cursor = end + SYNC_END.length
  }

  return lastFrame ?? output
}

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  getOutput: () => string
} {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  return {
    stdout,
    stdin,
    getOutput: () => output,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('RecentDenialsTab', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('updates while mounted when auto mode records a new denial', async () => {
    const { createRoot } = await import('../../../ink.js')
    const { RecentDenialsTab } = await import('./RecentDenialsTab.js')
    const { recordAutoModeDenial } = await import(
      '../../../../utils/autoModeDenials.js'
    )
    const { stdout, stdin, getOutput } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(<RecentDenialsTab onStateChange={() => {}} />)
      await sleep(50)
      expect(stripAnsi(extractLastFrame(getOutput()))).toContain(
        'No recent denials',
      )

      recordAutoModeDenial({
        toolName: 'Bash',
        display: 'npm test -- --watch',
        reason: 'classifier denied command',
        timestamp: 1,
      })
      await sleep(50)

      const output = stripAnsi(extractLastFrame(getOutput()))
      expect(output).toContain('Commands recently denied')
      expect(output).toContain('npm test -- --watch')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })
})
