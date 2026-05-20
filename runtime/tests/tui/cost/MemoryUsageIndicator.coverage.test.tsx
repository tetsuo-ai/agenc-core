import { PassThrough } from 'node:stream'

import stripAnsi from 'strip-ansi'
import { describe, expect, test, vi } from 'vitest'

const mockUseMemoryUsage = vi.hoisted(() =>
  vi.fn(() => ({
    heapUsed: 3 * 1024 * 1024 * 1024,
    status: 'critical' as const,
  })),
)

vi.mock('../hooks/useMemoryUsage.js', () => ({
  useMemoryUsage: mockUseMemoryUsage,
}))

import { createRoot } from '../ink/root.js'
import { MemoryUsageIndicator } from './MemoryUsageIndicator.js'

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

async function renderToText(): Promise<string> {
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

  try {
    root.render(<MemoryUsageIndicator />)
    await new Promise(resolve => setTimeout(resolve, 30))
    return stripAnsi(output)
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }
}

describe('MemoryUsageIndicator coverage', () => {
  test('does not render or subscribe in external builds', async () => {
    const output = await renderToText()

    expect(mockUseMemoryUsage).not.toHaveBeenCalled()
    expect(output).toBe('')
  })
})
