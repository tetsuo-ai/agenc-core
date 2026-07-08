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
      this.verifyApiKey.mockClear()
    },
    verifyApiKey: vi.fn(async () => true),
  }
})

vi.mock('../../bootstrap/state', async importOriginal => ({
  ...(await importOriginal()),
  getIsNonInteractiveSession: () => authHarness.state.nonInteractive,
}))

vi.mock('../../services/api/anthropic', () => ({
  verifyApiKey: authHarness.verifyApiKey,
}))

// A live hosted (remote) auth session short-circuits the hook to 'valid'.
// Pin it to absent so these tests stay hermetic against the developer's
// real ~/.agenc/auth.json and keep exercising the anthropic key path.
vi.mock('../../auth/session-state', async importOriginal => ({
  ...(await importOriginal()),
  hasRemoteAuthSessionSync: () => false,
}))

vi.mock('../../utils/auth.js', () => ({
  getAnthropicApiKeyWithSource: authHarness.getAnthropicApiKeyWithSource,
  getApiKeyFromApiKeyHelper: authHarness.getApiKeyFromApiKeyHelper,
  isAgenCAISubscriber: () => authHarness.state.subscriber,
  isAnthropicAuthEnabled: () => authHarness.state.authEnabled,
}))

import { createRoot } from '../ink/root.js'
import { useApiKeyVerification } from './useApiKeyVerification.js'

type HookResult = ReturnType<typeof useApiKeyVerification>
type Snapshot = {
  errorMessage: string | null
  status: HookResult['status']
}

type TestStreams = {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough
}

function createStreams(): TestStreams {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStreams['stdin']

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()
  ;(stdout as unknown as { columns: number }).columns = 100

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

describe('useApiKeyVerification api key helper coverage', () => {
  beforeEach(() => {
    authHarness.reset()
  })

  test('reports a configured helper that warms but does not return a key', async () => {
    authHarness.state.nonInteractive = true
    authHarness.state.source = 'apiKeyHelper'
    const snapshots: Snapshot[] = []
    let latest: HookResult | null = null

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

    try {
      root.render(React.createElement(Harness))

      await waitForCondition(
        () => latest?.status === 'loading',
        'Timed out waiting for initial loading status',
      )

      expect(authHarness.getAnthropicApiKeyWithSource).toHaveBeenCalledWith({
        skipRetrievingKeyFromApiKeyHelper: true,
      })

      await latest?.reverify()

      await waitForCondition(
        () =>
          latest?.status === 'error' &&
          latest.error?.message ===
            'API key helper did not return a valid key',
        'Timed out waiting for helper error status',
      )

      expect(authHarness.getApiKeyFromApiKeyHelper).toHaveBeenCalledWith(true)
      expect(authHarness.getAnthropicApiKeyWithSource).toHaveBeenLastCalledWith()
      expect(authHarness.verifyApiKey).not.toHaveBeenCalled()
      expect(snapshots).toContainEqual({
        errorMessage: 'API key helper did not return a valid key',
        status: 'error',
      })
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })

  test('treats a throwing key source lookup as missing during hook initialization', async () => {
    authHarness.getAnthropicApiKeyWithSource.mockImplementationOnce(() => {
      throw new Error('ANTHROPIC_API_KEY or AGENC_OAUTH_TOKEN env var is required')
    })
    const snapshots: Snapshot[] = []
    let latest: HookResult | null = null

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

    try {
      root.render(React.createElement(Harness))

      await waitForCondition(
        () => latest?.status === 'missing',
        'Timed out waiting for missing status after throwing key lookup',
      )

      expect(authHarness.getAnthropicApiKeyWithSource).toHaveBeenCalledWith({
        skipRetrievingKeyFromApiKeyHelper: true,
      })
      expect(authHarness.verifyApiKey).not.toHaveBeenCalled()
      expect(snapshots).toContainEqual({
        errorMessage: null,
        status: 'missing',
      })
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })
})
