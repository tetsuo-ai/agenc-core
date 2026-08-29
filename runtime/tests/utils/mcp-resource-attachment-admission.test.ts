import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AdmissionDeniedError,
  type AdmissionAcquireInput,
  type ExecutionAdmissionClient,
} from '../../src/budget/admission-client.js'
import type { AdmissionLease } from '../../src/budget/admission-types.js'
import type { GetAttachmentsOptions } from '../../src/prompts/attachments/orchestrator.js'
import { mcpResourcesProducer } from '../../src/prompts/attachments/mcp-resources.js'
import {
  clearCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from '../../src/session/current-session.js'
import type { AttachmentTrackingState } from '../../src/session/attachment-state.js'
import type { Session } from '../../src/session/session.js'
import { createTestEffectJournal } from '../helpers/test-effect-journal.js'

function leaseFor(
  input: AdmissionAcquireInput,
  reservationId: string,
  signal = new AbortController().signal,
): AdmissionLease {
  return {
    decision: 'allow',
    reservation: {
      reservationId,
      step: { runId: 'run-resource', stepId: input.stepId },
      reservedCostUsd: input.maxCostUsd ?? 0,
      reservedTokens: input.maxInputTokens + input.maxOutputTokens,
      reservedAt: '2026-07-18T00:00:00.000Z',
    },
    request: {
      step: { runId: 'run-resource', stepId: input.stepId },
      kind: input.kind,
      estimate: {
        maxInputTokens: input.maxInputTokens,
        maxOutputTokens: input.maxOutputTokens,
        maxCostUsd: input.maxCostUsd,
      },
      workspaceId: 'workspace-resource',
      sessionId: 'session-resource',
      autonomous: false,
    },
    signal,
  }
}

function admissionHarness(options: {
  acquire?: (
    input: AdmissionAcquireInput,
    signal?: AbortSignal,
  ) => Promise<AdmissionLease>
} = {}) {
  const acquire = vi.fn(
    options.acquire ??
      (async (input: AdmissionAcquireInput) =>
        leaseFor(input, 'resource-reservation')),
  )
  const admission = {
    scope: {
      runId: 'run-resource',
      workspaceId: 'workspace-resource',
      sessionId: 'session-resource',
      autonomous: false,
    },
    acquire,
    markDispatched: vi.fn(),
    reconcile: vi.fn(() => ({
      applied: true as const,
      outcome: 'reconciled' as const,
    })),
    holdUnknown: vi.fn(),
    void: vi.fn(),
    acknowledgeCompletion: vi.fn(),
    recordFallback: vi.fn(),
    forSession: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as unknown as ExecutionAdmissionClient
  return { admission, acquire }
}

type ManagerHarness = {
  readonly getConnectedServers?: ReturnType<typeof vi.fn>
  readonly getResourcesByServer?: ReturnType<typeof vi.fn>
  readonly readResource?: ReturnType<typeof vi.fn>
}

function installSession(
  admission?: ExecutionAdmissionClient,
  manager?: ManagerHarness,
): Session {
  const session = {
    ...createTestEffectJournal(),
    conversationId: 'session-resource',
    services: {
      ...(admission ? { executionAdmission: admission } : {}),
      ...(manager
        ? {
            mcpManager: {
              getConnectedServers: vi.fn(() => ['docs']),
              ...manager,
            },
          }
        : {}),
      admissionRequired: true,
    },
  } as unknown as Session
  setCurrentRuntimeSession(session)
  return session
}

interface ReadMentionOptions {
  readonly signal?: AbortSignal
  readonly userInput?: string
  readonly rootText?: string
  readonly turnId?: string
  readonly rootTurnId?: string | null
  readonly includeProvenance?: boolean
  readonly trackingState?: AttachmentTrackingState
}

function attachmentOptions(
  sessionKey: object,
  options: ReadMentionOptions = {},
): GetAttachmentsOptions {
  const userInput = options.userInput ?? 'read @docs:guide'
  const turnId = options.turnId ?? 'turn-resource'
  const rootTurnId = options.rootTurnId === undefined
    ? turnId
    : options.rootTurnId
  return {
    sessionKey,
    userInput,
    loadedTools: [],
    messages: [],
    permissionContext: { mode: 'default' } as never,
    cwd: '/tmp/agenc-mcp-resource-admission-test',
    subagentDepth: 0,
    signal: options.signal ?? new AbortController().signal,
    agencHome: '/tmp/agenc-mcp-resource-admission-home',
    ...(options.includeProvenance === false
      ? {}
      : {
          turnProvenance: {
            turnId,
            rootHumanTurn: rootTurnId === null
              ? null
              : {
                  turnId: rootTurnId,
                  text: options.rootText ?? userInput,
                },
          },
        }),
  }
}

function descriptor(uri = 'guide', serverName = 'docs') {
  return {
    serverName,
    uri,
    namespacedName: `mcp.${serverName}.${uri}`,
    name: 'Project guide',
    description: 'Useful docs',
  }
}

function resourceContent(text = 'resource text') {
  return {
    contents: [
      {
        uri: 'guide',
        text,
        truncated: false,
        bytesReturned: Buffer.byteLength(text, 'utf8'),
      },
    ],
    truncated: false,
    bytesReturned: Buffer.byteLength(text, 'utf8'),
  }
}

async function readMention(
  session: object,
  options: ReadMentionOptions = {},
) {
  return mcpResourcesProducer(
    attachmentOptions(session, options),
    options.trackingState ?? ({} as AttachmentTrackingState),
  )
}

describe('MCP resource attachment admission', () => {
  beforeEach(() => {
    clearCurrentRuntimeSession()
  })

  afterEach(() => {
    clearCurrentRuntimeSession()
    vi.useRealTimers()
  })

  it('gates both canonical catalog and read RPCs behind one admitted effect', async () => {
    const allow = Promise.withResolvers<void>()
    const state = admissionHarness({
      acquire: async input => {
        await allow.promise
        return leaseFor(input, 'resource-reservation')
      },
    })
    const getResourcesByServer = vi.fn(async () => [descriptor()])
    const readResource = vi.fn(async () => resourceContent())
    const session = installSession(state.admission, {
      getResourcesByServer,
      readResource,
    })

    const attachments = readMention(session)
    await vi.waitFor(() => expect(state.acquire).toHaveBeenCalledOnce())
    expect(getResourcesByServer).not.toHaveBeenCalled()
    expect(readResource).not.toHaveBeenCalled()

    allow.resolve()
    await expect(attachments).resolves.toEqual([
      {
        kind: 'mcp_resource',
        server: 'docs',
        uri: 'guide',
        name: 'Project guide',
        description: 'Useful docs',
        content: resourceContent(),
      },
    ])

    const acquireInput = state.acquire.mock.calls[0]?.[0]
    expect(acquireInput).toMatchObject({
      kind: 'tool_exec',
      maxInputTokens: 0,
      maxOutputTokens: 0,
      maxCostUsd: 0,
      sessionId: 'session-resource',
    })
    expect(acquireInput?.stepId).toMatch(
      /^tool:legacy-direct:session-resource:[0-9a-f-]{36}$/,
    )
    expect(state.admission.markDispatched).toHaveBeenCalledWith(
      'resource-reservation',
      expect.objectContaining({
        boundary: 'tool_effect',
        details: expect.objectContaining({
          toolName: 'mcp.preflight.resource_attachment',
          recoveryCategory: 'idempotent',
          maxCostUsd: 0,
        }),
      }),
    )
    expect(state.admission.reconcile).toHaveBeenCalledWith(
      'resource-reservation',
      { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    )
    expect(state.admission.acknowledgeCompletion).toHaveBeenCalledWith(
      'resource-reservation',
    )
    expect(getResourcesByServer).toHaveBeenCalledWith(
      'docs',
      expect.any(AbortSignal),
    )
    expect(readResource).toHaveBeenCalledWith(
      'mcp.docs.guide',
      getResourcesByServer.mock.calls[0]?.[1],
    )
  })

  it('fails closed before either canonical RPC when admission is denied', async () => {
    const state = admissionHarness({
      acquire: async () => {
        throw new AdmissionDeniedError('budget_exhausted')
      },
    })
    const getResourcesByServer = vi.fn()
    const readResource = vi.fn()
    const session = installSession(state.admission, {
      getResourcesByServer,
      readResource,
    })

    await expect(readMention(session)).resolves.toEqual([])
    expect(getResourcesByServer).not.toHaveBeenCalled()
    expect(readResource).not.toHaveBeenCalled()
    expect(state.admission.markDispatched).not.toHaveBeenCalled()
  })

  it('fails closed before either canonical RPC when the required kernel is missing', async () => {
    const getResourcesByServer = vi.fn()
    const readResource = vi.fn()
    const session = installSession(undefined, {
      getResourcesByServer,
      readResource,
    })

    await expect(readMention(session)).resolves.toEqual([])
    expect(getResourcesByServer).not.toHaveBeenCalled()
    expect(readResource).not.toHaveBeenCalled()
  })

  it('does not admit or read when the canonical manager boundary is unavailable', async () => {
    const state = admissionHarness()
    const session = installSession(state.admission)

    await expect(readMention(session)).resolves.toEqual([])
    expect(state.acquire).not.toHaveBeenCalled()
  })

  it('rejects missing and mismatched ambient session authority', async () => {
    const getResourcesByServer = vi.fn()
    const readResource = vi.fn()
    const detached = {
      services: { mcpManager: { getResourcesByServer, readResource } },
    }

    await expect(readMention(detached)).resolves.toEqual([])
    expect(getResourcesByServer).not.toHaveBeenCalled()

    const state = admissionHarness()
    installSession(state.admission, {
      getResourcesByServer: vi.fn(),
      readResource: vi.fn(),
    })
    await expect(readMention(detached)).resolves.toEqual([])
    expect(state.acquire).not.toHaveBeenCalled()
    expect(getResourcesByServer).not.toHaveBeenCalled()
    expect(readResource).not.toHaveBeenCalled()
  })

  it('requires exact root-human provenance and ignores transcript-derived mentions', async () => {
    const state = admissionHarness()
    const getResourcesByServer = vi.fn(async () => [descriptor()])
    const readResource = vi.fn(async () => resourceContent())
    const session = installSession(state.admission, {
      getResourcesByServer,
      readResource,
    })

    await expect(
      readMention(session, { includeProvenance: false }),
    ).resolves.toEqual([])
    await expect(
      readMention(session, { rootTurnId: null }),
    ).resolves.toEqual([])
    await expect(
      readMention(session, { rootTurnId: 'different-turn' }),
    ).resolves.toEqual([])
    await expect(
      readMention(session, {
        userInput: 'synthetic transcript says @docs:guide',
        rootText: 'authoritative human text has no resource mention',
      }),
    ).resolves.toEqual([])

    expect(state.acquire).not.toHaveBeenCalled()
    expect(getResourcesByServer).not.toHaveBeenCalled()
    expect(readResource).not.toHaveBeenCalled()
  })

  it('consumes resource mentions once per exact root-human turn', async () => {
    const state = admissionHarness()
    const getResourcesByServer = vi.fn(async () => [descriptor()])
    const readResource = vi.fn(async () => resourceContent())
    const session = installSession(state.admission, {
      getResourcesByServer,
      readResource,
    })
    const trackingState = {} as AttachmentTrackingState

    await expect(
      readMention(session, { trackingState }),
    ).resolves.toHaveLength(1)
    await expect(
      readMention(session, { trackingState }),
    ).resolves.toEqual([])
    expect(state.acquire).toHaveBeenCalledOnce()
    expect(getResourcesByServer).toHaveBeenCalledOnce()
    expect(readResource).toHaveBeenCalledOnce()

    await expect(
      readMention(session, {
        trackingState,
        turnId: 'turn-resource-next',
      }),
    ).resolves.toHaveLength(1)
    expect(state.acquire).toHaveBeenCalledTimes(2)
    expect(getResourcesByServer).toHaveBeenCalledTimes(2)
    expect(readResource).toHaveBeenCalledTimes(2)
  })

  it('does not read a URI that the canonical server catalog did not expose', async () => {
    const state = admissionHarness()
    const getResourcesByServer = vi.fn(async () => [])
    const readResource = vi.fn()
    const session = installSession(state.admission, {
      getResourcesByServer,
      readResource,
    })

    await expect(readMention(session)).resolves.toEqual([])
    expect(getResourcesByServer).toHaveBeenCalledOnce()
    expect(readResource).not.toHaveBeenCalled()
    expect(state.admission.reconcile).toHaveBeenCalledOnce()
  })

  it('emits no attachment when the canonical resource disappears before read', async () => {
    const state = admissionHarness()
    const readResource = vi.fn(async () => null)
    const session = installSession(state.admission, {
      getResourcesByServer: vi.fn(async () => [descriptor()]),
      readResource,
    })

    await expect(readMention(session)).resolves.toEqual([])
    expect(readResource).toHaveBeenCalledOnce()
    expect(state.admission.reconcile).toHaveBeenCalledOnce()
    expect(state.admission.acknowledgeCompletion).toHaveBeenCalledOnce()
  })

  it('preserves dots, colons, and a terminal slash in the canonical resource identity', async () => {
    const state = admissionHarness()
    const serverName = 'plugin:sample:docs'
    const uri = 'resource://guide.v1:section/'
    const getResourcesByServer = vi.fn(async () => [
      descriptor(uri, serverName),
    ])
    const readResource = vi.fn(async () => resourceContent())
    const session = installSession(state.admission, {
      getConnectedServers: vi.fn(() => ['plugin', serverName]),
      getResourcesByServer,
      readResource,
    })

    await expect(
      readMention(session, { userInput: `read @${serverName}:${uri}` }),
    ).resolves.toHaveLength(1)
    expect(getResourcesByServer).toHaveBeenCalledWith(
      serverName,
      expect.any(AbortSignal),
    )
    expect(readResource).toHaveBeenCalledWith(
      `mcp.${serverName}.${uri}`,
      expect.any(AbortSignal),
    )
  })

  it('bounds the number of admitted resource mentions per turn', async () => {
    const state = admissionHarness()
    const resources = Array.from({ length: 11 }, (_value, index) => ({
      serverName: 'docs',
      uri: `guide-${index}`,
      namespacedName: `mcp.docs.guide-${index}`,
      name: `Guide ${index}`,
    }))
    const getResourcesByServer = vi.fn(async () => resources)
    const readResource = vi.fn(async (name: string) =>
      resourceContent(name),
    )
    const session = installSession(state.admission, {
      getResourcesByServer,
      readResource,
    })
    const input = resources
      .map(resource => `@docs:${resource.uri}`)
      .join(' ')

    await expect(
      readMention(session, { userInput: input }),
    ).resolves.toHaveLength(10)
    expect(state.acquire).toHaveBeenCalledTimes(10)
    expect(getResourcesByServer).toHaveBeenCalledTimes(10)
    expect(readResource).toHaveBeenCalledTimes(10)
    expect(readResource).not.toHaveBeenCalledWith(
      'mcp.docs.guide-10',
      expect.any(AbortSignal),
    )
  })

  it('bounds aggregate retained bytes using encoded blob size', async () => {
    const state = admissionHarness()
    const resources = [descriptor('guide'), descriptor('appendix')]
    const encodedBlob = 'A'.repeat(3 * 1024 * 1024)
    const decodedBytes = (encodedBlob.length / 4) * 3
    const readResource = vi.fn(async (name: string) => ({
      contents: [
        {
          uri: name,
          mimeType: 'application/octet-stream',
          blob: encodedBlob,
          truncated: false,
          bytesReturned: decodedBytes,
        },
      ],
      truncated: false,
      bytesReturned: decodedBytes,
    }))
    const session = installSession(state.admission, {
      getResourcesByServer: vi.fn(async () => resources),
      readResource,
    })

    const attachments = await readMention(session, {
      userInput: 'read @docs:guide and @docs:appendix',
    })

    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      kind: 'mcp_resource',
      uri: 'guide',
    })
    expect(state.acquire).toHaveBeenCalledTimes(2)
    expect(readResource).toHaveBeenCalledTimes(2)
  })

  it('forwards lease cancellation and reconciles only after physical settlement', async () => {
    const leaseController = new AbortController()
    const state = admissionHarness({
      acquire: async input =>
        leaseFor(input, 'resource-cancelled', leaseController.signal),
    })
    const invoked = Promise.withResolvers<AbortSignal>()
    const getResourcesByServer = vi.fn(async () => [descriptor()])
    const readResource = vi.fn(
      async (_name: string, signal: AbortSignal) => {
        invoked.resolve(signal)
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          })
        })
      },
    )
    const session = installSession(state.admission, {
      getResourcesByServer,
      readResource,
    })

    const attachments = readMention(session)
    const managerSignal = await invoked.promise
    const cancellation = new AdmissionDeniedError(
      'run_cancelled',
      'cancelled',
    )
    leaseController.abort(cancellation)

    await expect(attachments).resolves.toEqual([])
    expect(managerSignal.aborted).toBe(true)
    expect(managerSignal.reason).toBe(cancellation)
    expect(state.admission.reconcile).toHaveBeenCalledWith(
      'resource-cancelled',
      { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    )
    expect(state.admission.acknowledgeCompletion).toHaveBeenCalledWith(
      'resource-cancelled',
    )
    expect(state.admission.holdUnknown).not.toHaveBeenCalled()
  })

  it('honors caller cancellation even when the admission lease has its own signal', async () => {
    const state = admissionHarness()
    const caller = new AbortController()
    const invoked = Promise.withResolvers<AbortSignal>()
    const getResourcesByServer = vi.fn(async () => [descriptor()])
    const readResource = vi.fn(
      async (_name: string, signal: AbortSignal) => {
        invoked.resolve(signal)
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          })
        })
      },
    )
    const session = installSession(state.admission, {
      getResourcesByServer,
      readResource,
    })

    const attachments = readMention(session, { signal: caller.signal })
    const managerSignal = await invoked.promise
    const cancellation = new Error('caller cancelled resource attachment')
    caller.abort(cancellation)

    await expect(attachments).rejects.toBe(cancellation)
    expect(managerSignal.aborted).toBe(true)
    expect(managerSignal.reason).toBe(cancellation)
  })

  it('shares one deadline across mentions, waits for settlement, and suppresses late content', async () => {
    vi.useFakeTimers()
    const state = admissionHarness()
    const invoked = Promise.withResolvers<AbortSignal>()
    const physical = Promise.withResolvers<ReturnType<typeof resourceContent>>()
    const getResourcesByServer = vi.fn(async () => [
      descriptor(),
      descriptor('appendix'),
    ])
    const readResource = vi.fn(
      async (name: string, signal: AbortSignal) => {
        if (name !== 'mcp.docs.guide') return resourceContent('second result')
        invoked.resolve(signal)
        return physical.promise
      },
    )
    const session = installSession(state.admission, {
      getResourcesByServer,
      readResource,
    })

    const attachments = readMention(
      session,
      { userInput: 'read @docs:guide and @docs:appendix' },
    )
    let settled = false
    void attachments.then(() => {
      settled = true
    })
    const managerSignal = await invoked.promise

    await vi.advanceTimersByTimeAsync(999)
    expect(managerSignal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(managerSignal.aborted).toBe(true)
    expect(managerSignal.reason).toBeInstanceOf(DOMException)
    expect((managerSignal.reason as DOMException).name).toBe('AbortError')
    expect(settled).toBe(false)
    expect(state.admission.reconcile).not.toHaveBeenCalled()

    physical.resolve(resourceContent('must not escape after timeout'))
    await expect(attachments).resolves.toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(state.acquire).toHaveBeenCalledOnce()
    expect(readResource).toHaveBeenCalledOnce()
    expect(state.admission.reconcile).toHaveBeenCalledOnce()
    expect(state.admission.acknowledgeCompletion).toHaveBeenCalledOnce()
  })

  it('cleans up the timeout immediately after an early canonical result', async () => {
    vi.useFakeTimers()
    const state = admissionHarness()
    const session = installSession(state.admission, {
      getResourcesByServer: vi.fn(async () => [descriptor()]),
      readResource: vi.fn(async () => resourceContent()),
    })

    await expect(readMention(session)).resolves.toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
