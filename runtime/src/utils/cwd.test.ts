import { describe, expect, test, vi } from 'vitest'

vi.mock('../bootstrap/state.js', () => ({
  getCwdState: vi.fn(),
  getOriginalCwd: vi.fn(),
}))

describe('cwd', () => {
  test('getCwd falls back to process.cwd() when bootstrap state returns a non-string stub value', async () => {
    const { getCwdState, getOriginalCwd } = await import('../bootstrap/state.js')
    vi.mocked(getCwdState).mockReturnValue(() => {})
    vi.mocked(getOriginalCwd).mockReturnValue(() => {})

    const { getCwd } = await import('./cwd.js')

    expect(getCwd()).toBe(process.cwd())
  })
})
