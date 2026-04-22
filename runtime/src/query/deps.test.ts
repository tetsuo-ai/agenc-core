import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queryModelWithStreaming: vi.fn(),
  autoCompactIfNeeded: vi.fn(),
  microcompactMessages: vi.fn(),
}))

vi.mock('../services/api/claude.js', () => ({
  queryModelWithStreaming: mocks.queryModelWithStreaming,
}))

vi.mock('../llm/compact/auto-compact.js', () => ({
  autoCompactIfNeeded: mocks.autoCompactIfNeeded,
}))

vi.mock('../llm/compact/micro-compact.js', () => ({
  microcompactMessages: mocks.microcompactMessages,
}))

describe('productionDeps', () => {
  it('captures explicit ladder selections for the live query factory', async () => {
    const { productionDeps } = await import('./deps.js')

    const deps = productionDeps({
      AGENC_TRANSPORT: 'hybrid',
    } as NodeJS.ProcessEnv)

    expect(deps.callModel).toBe(mocks.queryModelWithStreaming)
    expect(deps.transportMode).toBe('hybrid')
    expect(deps.microcompact).toBe(mocks.microcompactMessages)
    expect(deps.autocompact).toBe(mocks.autoCompactIfNeeded)
    expect(typeof deps.uuid).toBe('function')
  })

  it('preserves the openclaude fallback ordering when no explicit override is set', async () => {
    const { productionDeps } = await import('./deps.js')

    expect(
      productionDeps({
        CLAUDE_CODE_USE_CCR_V2: '1',
      } as NodeJS.ProcessEnv).transportMode,
    ).toBe('sse')
    expect(
      productionDeps({
        CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2: '1',
      } as NodeJS.ProcessEnv).transportMode,
    ).toBe('hybrid')
    expect(productionDeps({} as NodeJS.ProcessEnv).transportMode).toBeUndefined()
  })
})
