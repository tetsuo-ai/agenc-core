import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { TEST_REMOTE_AUTH_SESSION_CONTEXT } from '../remoteAuthSessionContext.fixture.js'
import { defaultConfig } from '../../config/schema.js'

const TEST_CONFIG = defaultConfig()

const authHarness = vi.hoisted(() => {
  const state = {
    authEnabled: true,
    key: undefined as string | undefined,
    source: undefined as string | undefined,
    subscriber: false,
    remoteAuthContexts: [] as unknown[],
  }

  return {
    state,
    getAnthropicApiKeyWithSource: vi.fn(
      () => ({
        key: state.key,
        source: state.source,
      }),
    ),
    reset() {
      state.authEnabled = true
      state.key = undefined
      state.source = undefined
      state.subscriber = false
      state.remoteAuthContexts = []
      this.getAnthropicApiKeyWithSource.mockClear()
      this.verifyApiKey.mockClear()
    },
    verifyApiKey: vi.fn(async () => ({ status: 'valid' })),
  }
})

vi.mock('../../onboarding/useApiKeyVerification', () => ({
  verifyApiKey: authHarness.verifyApiKey,
}))

// A live hosted (remote) auth session short-circuits the hook to 'valid'.
// Pin it to absent so these tests stay hermetic against the developer's
// real ~/.agenc/auth.json and keep exercising the anthropic key path.
vi.mock('../../auth/session-state', async importOriginal => ({
  ...(await importOriginal()),
  hasRemoteAuthSessionSync: (context: unknown) => {
    authHarness.state.remoteAuthContexts.push(context)
    return false
  },
}))

vi.mock('../../utils/auth.js', () => ({
  getAnthropicApiKeyWithSourceForContext:
    authHarness.getAnthropicApiKeyWithSource,
  isAgenCAISubscriberForContext: () => authHarness.state.subscriber,
  isAnthropicAuthEnabledForContext: () => authHarness.state.authEnabled,
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

  test('treats a source label without an actual key as missing', async () => {
    authHarness.state.source = 'apiKeyHelper'
    const snapshots: Snapshot[] = []
    let latest: HookResult | null = null

    function Harness(): null {
      const result = useApiKeyVerification(
        TEST_REMOTE_AUTH_SESSION_CONTEXT,
        TEST_CONFIG,
      )
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
        'Timed out waiting for missing status',
      )

      expect(authHarness.getAnthropicApiKeyWithSource).toHaveBeenCalledWith(
        TEST_REMOTE_AUTH_SESSION_CONTEXT,
      )
      expect(authHarness.state.remoteAuthContexts.length).toBeGreaterThan(0)
      expect(
        authHarness.state.remoteAuthContexts.every(
          context => context === TEST_REMOTE_AUTH_SESSION_CONTEXT,
        ),
      ).toBe(true)

      await latest?.reverify()

      await waitForCondition(
        () => latest?.status === 'missing',
        'Timed out waiting for missing reverify status',
      )

      expect(authHarness.getAnthropicApiKeyWithSource).toHaveBeenLastCalledWith(
        TEST_REMOTE_AUTH_SESSION_CONTEXT,
      )
      expect(authHarness.verifyApiKey).not.toHaveBeenCalled()

      await waitForCondition(
        () =>
          snapshots.some(
            snapshot =>
              snapshot.status === 'missing' && snapshot.errorMessage === null,
          ),
        'Timed out waiting for the missing effect snapshot',
      )
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

  test('treats a throwing key source lookup as missing during hook initialization', async () => {
    authHarness.getAnthropicApiKeyWithSource.mockImplementationOnce(() => {
      throw new Error('ANTHROPIC_API_KEY or AGENC_OAUTH_TOKEN env var is required')
    })
    const snapshots: Snapshot[] = []
    let latest: HookResult | null = null

    function Harness(): null {
      const result = useApiKeyVerification(
        TEST_REMOTE_AUTH_SESSION_CONTEXT,
        TEST_CONFIG,
      )
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

      expect(authHarness.getAnthropicApiKeyWithSource).toHaveBeenCalledWith(
        TEST_REMOTE_AUTH_SESSION_CONTEXT,
      )
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
