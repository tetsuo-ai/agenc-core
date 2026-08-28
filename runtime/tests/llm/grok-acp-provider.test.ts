import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { describe, expect, test, vi } from 'vitest'

const { terminationSeam } = vi.hoisted(() => ({
  terminationSeam: {
    failuresRemaining: 0,
    calls: [] as ChildProcess[],
  },
}))

vi.mock('../../src/utils/supervisedProcess.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/utils/supervisedProcess.js')
    >()
  return {
    ...actual,
    terminateProcessTreeAndWait: async (
      ...args: Parameters<typeof actual.terminateProcessTreeAndWait>
    ): Promise<void> => {
      terminationSeam.calls.push(args[0])
      if (terminationSeam.failuresRemaining > 0) {
        terminationSeam.failuresRemaining -= 1
        throw new Error('injected provider cleanup failure')
      }
      await actual.terminateProcessTreeAndWait(...args)
    },
  }
})

import {
  flattenMessagesForAcp,
  GrokAcpProvider,
  isGrokComposerModel,
} from '../../src/llm/providers/grok/acp-adapter.ts'
import {
  createProvider,
  readProviderFactoryOptions,
} from '../../src/llm/provider.ts'
import type { LLMMessage } from '../../src/llm/types.ts'
import { transitionSandboxExecutionBroker } from '../../src/sandbox/execution-lifecycle.ts'
import { explicitDangerBroker } from '../helpers/explicit-danger-boundary.ts'
import {
  createCsvAgentInvocationEnvelope,
  materializeAgentInvocationMessages,
} from '../../src/contracts/agent-invocation-envelope.ts'

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'services',
  'xai',
  'fixtures',
  'fake-acp-agent.mjs',
)
const ACP_TEST_ENV = Object.freeze({ ...process.env })

describe('composer model detection', () => {
  test('matches grok-composer-* only', () => {
    expect(isGrokComposerModel('grok-composer-2.5-fast')).toBe(true)
    expect(isGrokComposerModel('GROK-COMPOSER-3')).toBe(true)
    expect(isGrokComposerModel('grok-4.5')).toBe(false)
    expect(isGrokComposerModel(undefined)).toBe(false)
  })
})

describe('factory routing', () => {
  test('composer models construct the ACP provider without an API key', async () => {
    const provider = createProvider('grok', {
      model: 'grok-composer-2.5-fast',
      extra: {
        sandboxExecutionBroker: explicitDangerBroker,
        grokAcp: { environment: ACP_TEST_ENV },
      },
    })
    try {
      expect(provider.name).toBe('grok')
      expect(provider).toBeInstanceOf(GrokAcpProvider)
    } finally {
      await provider.dispose?.()
    }
  })

  test('composer factory options preserve the exact sandbox broker across recreation', async () => {
    const broker = explicitDangerBroker.forkForCwd(process.cwd())
    const preparedEnvironment = {
      PATH: '/captured/bin',
      HOME: '/captured/home',
      ACP_PUBLIC_SETTING: 'captured-value',
    }
    const provider = createProvider('grok', {
      model: 'grok-composer-2.5-fast',
      extra: {
        sandboxExecutionBroker: broker,
        grokAcp: { environment: preparedEnvironment },
      },
    })
    let recreated: ReturnType<typeof createProvider> | undefined

    try {
      const factoryOptions = readProviderFactoryOptions(provider)
      expect(factoryOptions.extra?.sandboxExecutionBroker).toBe(broker)
      const storedEnvironment = (
        factoryOptions.extra?.grokAcp as {
          environment: NodeJS.ProcessEnv
        }
      ).environment
      expect(storedEnvironment).toEqual(preparedEnvironment)
      expect(Object.isFrozen(storedEnvironment)).toBe(true)

      preparedEnvironment.PATH = '/mutated/bin'

      await provider.dispose?.()
      recreated = createProvider('grok', factoryOptions)
      expect(recreated).toBeInstanceOf(GrokAcpProvider)
      expect(
        readProviderFactoryOptions(recreated).extra?.sandboxExecutionBroker,
      ).toBe(broker)
      expect(
        (
          readProviderFactoryOptions(recreated).extra?.grokAcp as {
            environment: NodeJS.ProcessEnv
          }
        ).environment,
      ).toMatchObject({
        PATH: '/captured/bin',
        HOME: '/captured/home',
        ACP_PUBLIC_SETTING: 'captured-value',
      })
    } finally {
      await provider.dispose?.()
      await recreated?.dispose?.()
    }
  })

  test('non-composer models keep the direct-inference path', () => {
    const provider = createProvider('grok', {
      apiKey: 'xai-key',
      model: 'grok-4.5',
    })
    expect(provider).not.toBeInstanceOf(GrokAcpProvider)
  })
})

describe('message flattening', () => {
  test('flattens roles and content parts to a text transcript', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', image_url: { url: 'data:...' } } as never,
        ],
      },
    ]
    const flattened = flattenMessagesForAcp(messages, 'system rules')
    expect(flattened).toContain('system rules')
    expect(flattened).toContain('be brief')
    expect(flattened).toContain('User: hello')
    expect(flattened).toContain('Assistant: hi there')
    expect(flattened).toContain('look at this')
    expect(flattened).toContain('[image_url]')
  })

  test('refuses to flatten authenticated invocation authorities', () => {
    const messages = materializeAgentInvocationMessages(
      createCsvAgentInvocationEnvelope({
        jobId: 'acp-job',
        itemId: 'acp-item',
        rowIndex: 0,
        rowSha256: `sha256:${'b'.repeat(64)}`,
        instruction: 'classify the input',
        row: { value: 'untrusted' },
      }),
    )

    expect(() => flattenMessagesForAcp(messages)).toThrow(
      'ACP transport cannot preserve authenticated agent invocation authorities',
    )
  })
})

describe('GrokAcpProvider end to end (fake agent)', () => {
  test('does not reinterpret child env as CLI or permission authority', async () => {
    const unresolved = new GrokAcpProvider({
      model: 'grok-composer-2.5-fast',
      env: {
        AGENC_GROK_CLI: '/daemon/bin/grok',
        AGENC_GROK_ACP_PERMISSIONS: 'allow',
      },
    })
    const permissionProbe = new GrokAcpProvider({
      model: 'grok-composer-2.5-fast',
      binaryPath: FIXTURE,
      env: {
        PATH: process.env.PATH,
        AGENC_GROK_ACP_PERMISSIONS: 'allow',
        FAKE_ACP_REQUEST_PERMISSION: '1',
      },
      sandboxExecutionBroker: explicitDangerBroker,
    })

    try {
      expect(
        (
          unresolved as unknown as {
            resolveBinary(): string | undefined
          }
        ).resolveBinary(),
      ).toBeUndefined()
      const response = await permissionProbe.chat([
        { role: 'user', content: 'request permission' },
      ])
      expect(response.content).toContain('perm=selected:reject')
    } finally {
      await Promise.all([unresolved.dispose(), permissionProbe.dispose()])
    }
  })

  test('rejects a managed invocation before starting the ACP transport', async () => {
    const provider = new GrokAcpProvider({
      model: 'grok-composer-2.5-fast',
      env: ACP_TEST_ENV,
      binaryPath: '/definitely/not/a/grok/binary',
      sandboxExecutionBroker: explicitDangerBroker,
    })
    const messages = materializeAgentInvocationMessages(
      createCsvAgentInvocationEnvelope({
        jobId: 'managed-acp-job',
        itemId: 'managed-acp-item',
        rowIndex: 1,
        rowSha256: `sha256:${'c'.repeat(64)}`,
        instruction: 'run the managed task',
        row: { value: 'untrusted' },
      }),
    )

    try {
      await expect(provider.chat(messages)).rejects.toThrow(
        'ACP transport cannot preserve authenticated agent invocation authorities',
      )
    } finally {
      await provider.dispose()
    }
  })

  test('close drains a replacement client created during an earlier disposal', async () => {
    const provider = new GrokAcpProvider({
      model: 'grok-composer-2.5-fast',
      env: ACP_TEST_ENV,
      binaryPath: FIXTURE,
      sandboxExecutionBroker: explicitDangerBroker,
    })
    let releaseFirst!: () => void
    const firstClosed = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = { dispose: vi.fn(() => firstClosed) }
    const replacement = { dispose: vi.fn(async () => {}) }
    const state = provider as unknown as {
      client: { dispose(): Promise<void> } | null
      closeClient(): Promise<void>
    }

    try {
      state.client = first
      const closing = state.closeClient()
      await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledOnce())
      state.client = replacement
      releaseFirst()
      await closing

      expect(replacement.dispose).toHaveBeenCalledOnce()
      expect(state.client).toBeNull()
    } finally {
      releaseFirst()
      await provider.dispose()
    }
  })

  test('chat selects the model and returns the streamed text', async () => {
    const provider = new GrokAcpProvider({
      model: 'grok-composer-2.5-fast',
      env: ACP_TEST_ENV,
      binaryPath: FIXTURE,
      sandboxExecutionBroker: explicitDangerBroker,
    })
    try {
      const response = await provider.chat([{ role: 'user', content: 'hi' }])
      expect(response.content).toBe('[grok-composer-2.5-fast] Hello world')
      expect(response.model).toBe('grok-composer-2.5-fast')
      expect(response.finishReason).toBe('stop')
      expect(response.toolCalls).toEqual([])
      expect(response.usage).toMatchObject({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        availability: 'unknown',
        provenance: 'synthetic',
      })
      await expect(provider.getExecutionProfile()).resolves.toMatchObject({
        usageReporting: 'unavailable',
        supportsMaxOutputTokens: false,
      })
    } finally {
      await provider.dispose()
    }
  })

  test('chatStream streams deltas and ends with a done chunk', async () => {
    const provider = new GrokAcpProvider({
      model: 'grok-composer-2.5-fast',
      env: ACP_TEST_ENV,
      binaryPath: FIXTURE,
      sandboxExecutionBroker: explicitDangerBroker,
    })
    try {
      const chunks: Array<{ content: string; done: boolean }> = []
      const response = await provider.chatStream(
        [{ role: 'user', content: 'hi' }],
        (chunk) => chunks.push({ content: chunk.content, done: chunk.done }),
      )
      expect(response.content).toBe('[grok-composer-2.5-fast] Hello world')
      expect(chunks.at(-1)).toEqual({ content: '', done: true })
      expect(
        chunks
          .filter((chunk) => !chunk.done)
          .map((chunk) => chunk.content)
          .join(''),
      ).toBe(response.content)
    } finally {
      await provider.dispose()
    }
  })

  test('reuses one CLI process across chats but a fresh session per chat', async () => {
    const provider = new GrokAcpProvider({
      model: 'grok-composer-2.5-fast',
      env: ACP_TEST_ENV,
      binaryPath: FIXTURE,
      sandboxExecutionBroker: explicitDangerBroker,
    })
    try {
      await provider.chat([{ role: 'user', content: 'first' }])
      const second = await provider.chat([{ role: 'user', content: 'second' }])
      // The fixture numbers sessions per process; a second chat on the same
      // process gets mock-session-2 and keeps the selected model.
      expect(second.content).toBe('[grok-composer-2.5-fast] Hello world')
    } finally {
      await provider.dispose()
    }
  })

  test('missing Grok CLI surfaces the executable boundary error', async () => {
    const provider = new GrokAcpProvider({
      model: 'grok-composer-2.5-fast',
      env: ACP_TEST_ENV,
      binaryPath: 'definitely-not-a-real-grok-binary',
      sandboxExecutionBroker: explicitDangerBroker,
    })
    try {
      await expect(
        provider.chat([{ role: 'user', content: 'hi' }]),
      ).rejects.toMatchObject({
        name: 'SandboxExecutionError',
        code: 'sandbox_transform_failed',
        message: expect.stringContaining('executable not found'),
      })
      expect(await provider.healthCheck()).toBe(false)
    } finally {
      await provider.dispose()
    }
  })

  test('uses the broker cwd and restarts lazily after a broker transition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agenc-acp-provider-cwd-'))
    const initialCwd = join(root, 'initial')
    const rebasedCwd = join(root, 'rebased')
    const staleCwd = join(root, 'stale-config')
    await Promise.all([mkdir(initialCwd), mkdir(rebasedCwd), mkdir(staleCwd)])
    const broker = explicitDangerBroker.forkForCwd(initialCwd)
    const prepareSpawn = vi.spyOn(broker, 'prepareSpawn')
    const provider = new GrokAcpProvider({
      model: 'grok-composer-2.5-fast',
      env: ACP_TEST_ENV,
      binaryPath: FIXTURE,
      cwd: staleCwd,
      sandboxExecutionBroker: broker,
    })

    try {
      await provider.chat([{ role: 'user', content: 'before transition' }])
      expect(prepareSpawn).toHaveBeenCalledTimes(1)
      expect(prepareSpawn.mock.calls[0]?.[1].cwd).toBe(initialCwd)
      expect(prepareSpawn.mock.calls[0]?.[2]).toEqual({
        lifecycleParticipant: 'grok-acp-provider',
      })

      await transitionSandboxExecutionBroker(broker, rebasedCwd)
      // Resume is intentionally lazy: a workspace transition does not launch
      // a provider process until the next model call.
      expect(prepareSpawn).toHaveBeenCalledTimes(1)

      await provider.chat([{ role: 'user', content: 'after transition' }])
      expect(prepareSpawn).toHaveBeenCalledTimes(2)
      expect(prepareSpawn.mock.calls[1]?.[1].cwd).toBe(rebasedCwd)
      expect(prepareSpawn.mock.calls[1]?.[2]).toEqual({
        lifecycleParticipant: 'grok-acp-provider',
      })
    } finally {
      await provider.dispose()
      prepareSpawn.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('failed transition retries the retained client before any replacement spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agenc-acp-provider-retry-'))
    const initialCwd = join(root, 'initial')
    const rebasedCwd = join(root, 'rebased')
    await Promise.all([mkdir(initialCwd), mkdir(rebasedCwd)])
    const broker = explicitDangerBroker.forkForCwd(initialCwd)
    const prepareSpawn = vi.spyOn(broker, 'prepareSpawn')
    const provider = new GrokAcpProvider({
      model: 'grok-composer-2.5-fast',
      env: ACP_TEST_ENV,
      binaryPath: FIXTURE,
      sandboxExecutionBroker: broker,
    })

    try {
      await provider.chat([{ role: 'user', content: 'before failure' }])
      terminationSeam.calls = []
      terminationSeam.failuresRemaining = 1

      await expect(
        transitionSandboxExecutionBroker(broker, rebasedCwd),
      ).rejects.toThrow('quiesce failed; old authority restored')
      expect(broker.cwd).toBe(initialCwd)
      expect(prepareSpawn).toHaveBeenCalledTimes(1)
      expect(terminationSeam.calls).toHaveLength(1)
      const retainedChild = terminationSeam.calls[0]

      await provider.chat([{ role: 'user', content: 'retry cleanup' }])
      expect(terminationSeam.calls).toHaveLength(2)
      expect(terminationSeam.calls[1]).toBe(retainedChild)
      expect(prepareSpawn).toHaveBeenCalledTimes(2)
      expect(prepareSpawn.mock.calls[1]?.[1].cwd).toBe(initialCwd)
    } finally {
      terminationSeam.failuresRemaining = 0
      await provider.dispose()
      prepareSpawn.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('forkForSession creates an independently brokered provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agenc-acp-provider-fork-'))
    const parentCwd = join(root, 'parent')
    const childCwd = join(root, 'child')
    await Promise.all([mkdir(parentCwd), mkdir(childCwd)])
    const parentBroker = explicitDangerBroker.forkForCwd(parentCwd)
    const childBroker = explicitDangerBroker.forkForCwd(childCwd)
    const parentSpawn = vi.spyOn(parentBroker, 'prepareSpawn')
    const childSpawn = vi.spyOn(childBroker, 'prepareSpawn')
    const priorAmbientSentinel = process.env.ACP_AMBIENT_SENTINEL
    process.env.ACP_AMBIENT_SENTINEL = 'daemon-only-value'
    const parent = new GrokAcpProvider({
      model: 'grok-composer-2.5-fast',
      env: { ...ACP_TEST_ENV, ACP_PUBLIC_SETTING: 'session-value' },
      binaryPath: FIXTURE,
      sandboxExecutionBroker: parentBroker,
    })
    const child = parent.forkForSession({
      cwd: childCwd,
      sandboxExecutionBroker: childBroker,
    })

    try {
      await Promise.all([
        parent.chat([{ role: 'user', content: 'parent' }]),
        child.chat([{ role: 'user', content: 'child' }]),
      ])
      expect(parentSpawn).toHaveBeenCalledTimes(1)
      expect(parentSpawn.mock.calls[0]?.[1].cwd).toBe(parentCwd)
      expect(parentSpawn.mock.calls[0]?.[1].env?.ACP_PUBLIC_SETTING).toBe(
        'session-value',
      )
      expect(
        parentSpawn.mock.calls[0]?.[1].env?.ACP_AMBIENT_SENTINEL,
      ).toBeUndefined()
      expect(childSpawn).toHaveBeenCalledTimes(1)
      expect(childSpawn.mock.calls[0]?.[1].cwd).toBe(childCwd)
      expect(childSpawn.mock.calls[0]?.[1].env?.ACP_PUBLIC_SETTING).toBe(
        'session-value',
      )
      expect(
        childSpawn.mock.calls[0]?.[1].env?.ACP_AMBIENT_SENTINEL,
      ).toBeUndefined()
    } finally {
      await Promise.all([parent.dispose(), child.dispose()])
      parentSpawn.mockRestore()
      childSpawn.mockRestore()
      if (priorAmbientSentinel === undefined) {
        delete process.env.ACP_AMBIENT_SENTINEL
      } else {
        process.env.ACP_AMBIENT_SENTINEL = priorAmbientSentinel
      }
      await rm(root, { recursive: true, force: true })
    }
  })
})
