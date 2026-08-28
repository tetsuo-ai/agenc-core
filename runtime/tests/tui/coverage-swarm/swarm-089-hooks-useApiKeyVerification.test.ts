import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { TEST_REMOTE_AUTH_SESSION_CONTEXT } from '../remoteAuthSessionContext.fixture.js'
import { defaultConfig } from '../../../src/config/schema.js'

const TEST_CONFIG = defaultConfig()

const authHarness = vi.hoisted(() => {
  const state = {
    authEnabled: true,
    key: undefined as string | undefined,
    remoteSession: false,
    source: undefined as string | undefined,
    subscriber: false,
    remoteAuthContexts: [] as unknown[],
  }

  return {
    state,
    getAnthropicApiKeyWithSource: vi.fn(() => ({
        key: state.key,
        source: state.source,
      })),
    reset() {
      state.authEnabled = true
      state.key = undefined
      state.remoteSession = false
      state.source = undefined
      state.subscriber = false
      state.remoteAuthContexts = []
      this.getAnthropicApiKeyWithSource.mockClear()
      this.verifyApiKey.mockReset()
      this.verifyApiKey.mockResolvedValue({ status: 'valid' })
    },
    verifyApiKey: vi.fn(async () => ({ status: 'valid' })),
  }
})

vi.mock('../../../src/onboarding/useApiKeyVerification', () => ({
  verifyApiKey: authHarness.verifyApiKey,
}))

// The hook treats a live hosted (remote) auth session as already-valid and
// never touches the anthropic key sources. Keep it harness-controlled so the
// tests are hermetic against the developer's real ~/.agenc/auth.json.
vi.mock('../../../src/auth/session-state', async importOriginal => ({
  ...(await importOriginal()),
  hasRemoteAuthSessionSync: (context: unknown) => {
    authHarness.state.remoteAuthContexts.push(context)
    return authHarness.state.remoteSession
  },
}))

vi.mock('../../../src/utils/auth.js', () => ({
  getAnthropicApiKeyWithSourceForContext:
    authHarness.getAnthropicApiKeyWithSource,
  isAgenCAISubscriberForContext: () => authHarness.state.subscriber,
  isAnthropicAuthEnabledForContext: () => authHarness.state.authEnabled,
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

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly reject: (error: unknown) => void
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })

  return { promise, reject, resolve }
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

  test('passes the session-owned auth context to every remote-session read', async () => {
    const rendered = await renderVerificationHook()

    try {
      await waitForCondition(
        () => authHarness.state.remoteAuthContexts.length > 0,
        'Timed out waiting for a remote-session read',
      )

      expect(
        authHarness.state.remoteAuthContexts.every(
          context => context === TEST_REMOTE_AUTH_SESSION_CONTEXT,
        ),
      ).toBe(true)
    } finally {
      await rendered.cleanup()
    }
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
    {
      name: 'remote auth session',
      patch: { remoteSession: true },
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
      expect(authHarness.getAnthropicApiKeyWithSource).not.toHaveBeenCalled()
      expect(authHarness.verifyApiKey).not.toHaveBeenCalled()
    } finally {
      await rendered.cleanup()
    }
  })

  test.each([
    { expectedStatus: 'valid' as const, verifierStatus: 'valid' as const },
    { expectedStatus: 'invalid' as const, verifierStatus: 'invalid' as const },
  ])(
    'sets $expectedStatus after rechecking an existing key',
    async ({ expectedStatus, verifierStatus }) => {
      authHarness.state.key = 'sk-ant-test'
      authHarness.state.source = 'environment'
      authHarness.verifyApiKey.mockResolvedValueOnce({ status: verifierStatus })
      const rendered = await renderVerificationHook()

      try {
        await waitForCondition(
          () => rendered.getLatest().status === 'loading',
          'Timed out waiting for loading initial status',
        )

        expect(authHarness.getAnthropicApiKeyWithSource).toHaveBeenCalledWith(
          TEST_REMOTE_AUTH_SESSION_CONTEXT,
        )

        await rendered.getLatest().reverify()

        await waitForCondition(
          () => rendered.getLatest().status === expectedStatus,
          `Timed out waiting for ${expectedStatus} status`,
        )

        expect(authHarness.getAnthropicApiKeyWithSource).toHaveBeenLastCalledWith(
          TEST_REMOTE_AUTH_SESSION_CONTEXT,
        )
        expect(authHarness.verifyApiKey).toHaveBeenCalledWith(
          {
            provider: 'anthropic',
            apiKey: 'sk-ant-test',
            config: TEST_CONFIG,
            env: TEST_REMOTE_AUTH_SESSION_CONTEXT.environment,
          },
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

      expect(authHarness.getAnthropicApiKeyWithSource).toHaveBeenLastCalledWith(
        TEST_REMOTE_AUTH_SESSION_CONTEXT,
      )
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

      await waitForCondition(
        () =>
          rendered.snapshots.some(
            snapshot =>
              snapshot.errorMessage === 'network failed' &&
              snapshot.status === 'error',
          ),
        'Timed out waiting for verifier error effect snapshot',
      )

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

  test('keeps the newest verifier result when rechecks resolve out of order', async () => {
    authHarness.state.key = 'sk-ant-test'
    authHarness.state.source = 'environment'
    const stale = deferred<{ status: 'invalid' }>()
    const latest = deferred<{ status: 'valid' }>()
    authHarness.verifyApiKey
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(latest.promise)
    const rendered = await renderVerificationHook()

    try {
      await waitForCondition(
        () => rendered.getLatest().status === 'loading',
        'Timed out waiting for loading initial status',
      )

      const staleRun = rendered.getLatest().reverify()
      await waitForCondition(
        () => authHarness.verifyApiKey.mock.calls.length === 1,
        'Timed out waiting for first verifier call',
      )
      const latestRun = rendered.getLatest().reverify()
      await waitForCondition(
        () => authHarness.verifyApiKey.mock.calls.length === 2,
        'Timed out waiting for second verifier call',
      )

      latest.resolve({ status: 'valid' })
      await latestRun
      await waitForCondition(
        () => rendered.getLatest().status === 'valid',
        'Timed out waiting for latest verifier status',
      )

      stale.resolve({ status: 'invalid' })
      await staleRun
      await sleep()

      expect(rendered.getLatest().status).toBe('valid')
      expect(rendered.getLatest().error).toBeNull()
    } finally {
      await rendered.cleanup()
    }
  })

  test('clears a previous verifier error when a later recheck succeeds', async () => {
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

      authHarness.verifyApiKey.mockResolvedValueOnce({ status: 'valid' })
      await rendered.getLatest().reverify()

      await waitForCondition(
        () => rendered.getLatest().status === 'valid',
        'Timed out waiting for recovered verifier status',
      )

      expect(rendered.getLatest().error).toBeNull()
    } finally {
      await rendered.cleanup()
    }
  })
})
