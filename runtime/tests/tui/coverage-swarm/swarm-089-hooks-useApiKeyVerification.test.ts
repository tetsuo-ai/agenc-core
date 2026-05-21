import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const authHarness = vi.hoisted(() => {
  const state = {
    authEnabled: true,
    key: undefined as string | undefined,
    nonInteractive: false,
    source: undefined as string | undefined,
    subscriber: false,
  }

  return {
    state,
    getApiKeyFromApiKeyHelper: vi.fn(async () => undefined),
    getAnthropicApiKeyWithSource: vi.fn(
      (_options?: { skipRetrievingKeyFromApiKeyHelper?: boolean }) => ({
        key: state.key,
        source: state.source,
      }),
    ),
    reset() {
      state.authEnabled = true
      state.key = undefined
      state.nonInteractive = false
      state.source = undefined
      state.subscriber = false
      this.getApiKeyFromApiKeyHelper.mockClear()
      this.getAnthropicApiKeyWithSource.mockClear()
      this.verifyApiKey.mockReset()
      this.verifyApiKey.mockResolvedValue(true)
    },
    verifyApiKey: vi.fn(async () => true),
  }
})

vi.mock('../../../src/bootstrap/state', async importOriginal => ({
  ...(await importOriginal()),
  getIsNonInteractiveSession: () => authHarness.state.nonInteractive,
}))

vi.mock('../../../src/services/api/anthropic', () => ({
  verifyApiKey: authHarness.verifyApiKey,
}))

vi.mock('../../../src/utils/auth.js', () => ({
  getAnthropicApiKeyWithSource: authHarness.getAnthropicApiKeyWithSource,
  getApiKeyFromApiKeyHelper: authHarness.getApiKeyFromApiKeyHelper,
  isAgenCAISubscriber: () => authHarness.state.subscriber,
  isAnthropicAuthEnabled: () => authHarness.state.authEnabled,
}))

import { createRoot } from '../../../src/tui/ink/root.js'
import { useApiKeyVerification } from '../../../src/tui/hooks/useApiKeyVerification.js'

type HookResult = ReturnType<typeof useApiKeyVerification>
type Snapshot = {
  readonly errorMessage: string | null
  readonly status: HookResult['status']
}

type TestStreams = {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough & {
    columns: number
    isTTY: boolean
    rows: number
  }
}

function createStreams(): TestStreams {
  const stdout = new PassThrough() as TestStreams['stdout']
  const stdin = new PassThrough() as TestStreams['stdin']

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.columns = 100
  stdout.isTTY = true
  stdout.rows = 30
  stdout.resume()

  return { stdin, stdout }
}

async function sleep(ms = 10): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await sleep()
  }
  throw new Error(message)
}

async function renderVerificationHook(): Promise<{
  readonly cleanup: () => Promise<void>
  readonly getLatest: () => HookResult
  readonly rerender: () => void
  readonly snapshots: Snapshot[]
}> {
  let latest: HookResult | null = null
  const snapshots: Snapshot[] = []

  function Harness(): null {
    const result = useApiKeyVerification()
    latest = result

    React.useEffect(() => {
      snapshots.push({
        errorMessage: result.error?.message ?? null,
        status: result.status,
      })
    }, [result.error, result.status])

    return null
  }

  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  const render = () => root.render(React.createElement(Harness))
  render()

  return {
    async cleanup() {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(0)
    },
    getLatest() {
      if (latest === null) {
        throw new Error('useApiKeyVerification did not render')
      }
      return latest
    },
    rerender: render,
    snapshots,
  }
}

describe('useApiKeyVerification coverage swarm row 089', () => {
  beforeEach(() => {
    authHarness.reset()
  })

  test.each([
    {
      name: 'disabled auth',
      patch: { authEnabled: false },
    },
    {
      name: 'subscriber auth',
      patch: { subscriber: true },
    },
  ])('treats $name as already valid', async ({ patch }) => {
    Object.assign(authHarness.state, patch)
    const rendered = await renderVerificationHook()

    try {
      await waitForCondition(
        () => rendered.getLatest().status === 'valid',
        'Timed out waiting for valid initial status',
      )

      await rendered.getLatest().reverify()

      expect(rendered.getLatest().status).toBe('valid')
      expect(authHarness.getApiKeyFromApiKeyHelper).not.toHaveBeenCalled()
      expect(authHarness.getAnthropicApiKeyWithSource).not.toHaveBeenCalled()
      expect(authHarness.verifyApiKey).not.toHaveBeenCalled()
    } finally {
      await rendered.cleanup()
    }
  })

  test.each([
    { expectedStatus: 'valid' as const, verifierResult: true },
    { expectedStatus: 'invalid' as const, verifierResult: false },
  ])(
    'sets $expectedStatus after rechecking an existing key',
    async ({ expectedStatus, verifierResult }) => {
      authHarness.state.key = 'sk-ant-test'
      authHarness.state.nonInteractive = true
      authHarness.state.source = 'environment'
      authHarness.verifyApiKey.mockResolvedValueOnce(verifierResult)
      const rendered = await renderVerificationHook()

      try {
        await waitForCondition(
          () => rendered.getLatest().status === 'loading',
          'Timed out waiting for loading initial status',
        )

        expect(
          authHarness.getAnthropicApiKeyWithSource,
        ).toHaveBeenCalledWith({
          skipRetrievingKeyFromApiKeyHelper: true,
        })

        await rendered.getLatest().reverify()

        await waitForCondition(
          () => rendered.getLatest().status === expectedStatus,
          `Timed out waiting for ${expectedStatus} status`,
        )

        expect(authHarness.getApiKeyFromApiKeyHelper).toHaveBeenCalledWith(
          true,
        )
        expect(authHarness.getAnthropicApiKeyWithSource).toHaveBeenLastCalledWith()
        expect(authHarness.verifyApiKey).toHaveBeenCalledWith(
          'sk-ant-test',
          false,
        )
        expect(rendered.getLatest().error).toBeNull()
      } finally {
        await rendered.cleanup()
      }
    },
  )

  test('keeps missing status when no key source can provide a key', async () => {
    const rendered = await renderVerificationHook()

    try {
      await waitForCondition(
        () => rendered.getLatest().status === 'missing',
        'Timed out waiting for missing initial status',
      )

      await rendered.getLatest().reverify()

      await waitForCondition(
        () => rendered.getLatest().status === 'missing',
        'Timed out waiting for missing reverify status',
      )

      expect(authHarness.getApiKeyFromApiKeyHelper).toHaveBeenCalledWith(false)
      expect(authHarness.getAnthropicApiKeyWithSource).toHaveBeenLastCalledWith()
      expect(authHarness.verifyApiKey).not.toHaveBeenCalled()
      expect(rendered.getLatest().error).toBeNull()
    } finally {
      await rendered.cleanup()
    }
  })

  test('records verifier errors and clears them when auth becomes disabled', async () => {
    authHarness.state.key = 'sk-ant-test'
    authHarness.state.source = 'environment'
    authHarness.verifyApiKey.mockRejectedValueOnce(new Error('network failed'))
    const rendered = await renderVerificationHook()

    try {
      await waitForCondition(
        () => rendered.getLatest().status === 'loading',
        'Timed out waiting for loading initial status',
      )

      await rendered.getLatest().reverify()

      await waitForCondition(
        () =>
          rendered.getLatest().status === 'error' &&
          rendered.getLatest().error?.message === 'network failed',
        'Timed out waiting for verifier error status',
      )

      expect(rendered.snapshots).toContainEqual({
        errorMessage: 'network failed',
        status: 'error',
      })

      authHarness.state.authEnabled = false
      rendered.rerender()

      await waitForCondition(
        () =>
          rendered.getLatest().status === 'valid' &&
          rendered.getLatest().error === null,
        'Timed out waiting for disabled auth to clear verifier error',
      )
    } finally {
      await rendered.cleanup()
    }
  })
})
