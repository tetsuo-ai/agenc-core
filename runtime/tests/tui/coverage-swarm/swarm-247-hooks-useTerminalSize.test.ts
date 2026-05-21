import { afterEach, describe, expect, test, vi } from 'vitest'

import type { TerminalSize } from '../../../src/tui/ink/components/TerminalSizeContext.js'

async function loadHookWithTerminalSize(size: TerminalSize | null): Promise<{
  readonly useContext: ReturnType<typeof vi.fn>
  readonly useTerminalSize: () => TerminalSize
}> {
  const useContext = vi.fn(() => size)

  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof import('react')>('react')
    return {
      ...actual,
      useContext,
    }
  })

  const { useTerminalSize } = await import(
    '../../../src/tui/hooks/useTerminalSize.js'
  )

  return { useContext, useTerminalSize }
}

afterEach(() => {
  vi.doUnmock('react')
  vi.resetModules()
})

describe('useTerminalSize coverage swarm row 247', () => {
  test('returns the terminal size from context', async () => {
    const size = { columns: 132, rows: 43 }
    const { useContext, useTerminalSize } = await loadHookWithTerminalSize(size)

    expect(useTerminalSize()).toBe(size)
    expect(useContext).toHaveBeenCalledTimes(1)
  })

  test('rejects usage without a terminal size provider', async () => {
    const { useContext, useTerminalSize } = await loadHookWithTerminalSize(null)

    expect(() => useTerminalSize()).toThrow(
      'useTerminalSize must be used within an Ink App component',
    )
    expect(useContext).toHaveBeenCalledTimes(1)
  })
})
