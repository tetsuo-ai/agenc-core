import { afterEach, describe, expect, it, vi } from 'vitest'

async function importAdapter() {
  vi.resetModules()
  return import('./messagesOptionalModules.js')
}

afterEach(() => {
  vi.doUnmock('node:module')
  vi.resetModules()
})

describe('Messages optional module adapter', () => {
  it('falls back when optional proactive and file-delivery modules are absent', async () => {
    const {
      getMessagesSendUserFileToolName,
      isMessagesProactiveActive,
    } = await importAdapter()

    expect(() => isMessagesProactiveActive()).not.toThrow()
    expect(() => getMessagesSendUserFileToolName()).not.toThrow()

    expect(isMessagesProactiveActive()).toBe(false)
    expect(getMessagesSendUserFileToolName()).toBeNull()
  })

  it('returns null for the exact missing optional module', async () => {
    const missing = new Error(
      "Cannot find module '../../proactive/index.js'",
    ) as NodeJS.ErrnoException
    missing.code = 'MODULE_NOT_FOUND'
    vi.doMock('node:module', () => ({
      createRequire: () => () => {
        throw missing
      },
    }))

    const { isMessagesProactiveActive } = await importAdapter()

    expect(isMessagesProactiveActive()).toBe(false)
  })

  it('rethrows optional module evaluation failures', async () => {
    const broken = new Error('proactive module exploded')
    vi.doMock('node:module', () => ({
      createRequire: () => () => {
        throw broken
      },
    }))

    const { isMessagesProactiveActive } = await importAdapter()

    expect(() => isMessagesProactiveActive()).toThrow(
      'proactive module exploded',
    )
  })

  it('rethrows nested missing dependency failures', async () => {
    const nestedMissing = new Error(
      "Cannot find module 'nested-proactive-dependency'",
    ) as NodeJS.ErrnoException
    nestedMissing.code = 'MODULE_NOT_FOUND'
    vi.doMock('node:module', () => ({
      createRequire: () => () => {
        throw nestedMissing
      },
    }))

    const { isMessagesProactiveActive } = await importAdapter()

    expect(() => isMessagesProactiveActive()).toThrow(
      'nested-proactive-dependency',
    )
  })
})
