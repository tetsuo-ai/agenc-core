import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AdmissionDeniedError,
  type AdmissionAcquireInput,
  type ExecutionAdmissionClient,
} from '../../src/budget/admission-client.js'
import type { AdmissionLease } from '../../src/budget/admission-types.js'
import {
  clearCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from '../../src/session/current-session.js'
import type { Session } from '../../src/session/session.js'
import { createTestEffectJournal } from '../helpers/test-effect-journal.js'
import type { MCPServerConnection } from '../../src/services/mcp/types.js'
import {
  clearSlackChannelCache,
  getSlackChannelSuggestions,
} from '../../src/utils/suggestions/slackChannelSuggestions.js'

function leaseFor(
  input: AdmissionAcquireInput,
  reservationId: string,
  signal = new AbortController().signal,
): AdmissionLease {
  return {
    decision: 'allow',
    reservation: {
      reservationId,
      step: { runId: 'run-slack', stepId: input.stepId },
      reservedCostUsd: input.maxCostUsd ?? 0,
      reservedTokens: input.maxInputTokens + input.maxOutputTokens,
      reservedAt: '2026-07-18T00:00:00.000Z',
    },
    request: {
      step: { runId: 'run-slack', stepId: input.stepId },
      kind: input.kind,
      estimate: {
        maxInputTokens: input.maxInputTokens,
        maxOutputTokens: input.maxOutputTokens,
        maxCostUsd: input.maxCostUsd,
      },
      workspaceId: 'workspace-slack',
      sessionId: 'session-slack',
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
  let reservationSequence = 0
  const acquire = vi.fn(
    options.acquire ??
      (async (input: AdmissionAcquireInput) =>
        leaseFor(input, `slack-reservation-${++reservationSequence}`)),
  )
  const admission = {
    scope: {
      runId: 'run-slack',
      workspaceId: 'workspace-slack',
      sessionId: 'session-slack',
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

function installSession(
  admission?: ExecutionAdmissionClient,
  callTool?: ReturnType<typeof vi.fn>,
): void {
  setCurrentRuntimeSession({
    ...createTestEffectJournal(),
    conversationId: 'session-slack',
    services: {
      ...(admission ? { executionAdmission: admission } : {}),
      mcpManager: callTool === undefined ? {} : { callTool },
      admissionRequired: true,
    },
  } as unknown as Session)
}

function slackConnection(callTool: ReturnType<typeof vi.fn>): MCPServerConnection {
  return {
    name: 'workspace-slack',
    type: 'connected',
    capabilities: { tools: {} },
    config: {
      type: 'stdio',
      command: 'workspace-slack-server',
      scope: 'dynamic',
    },
    client: { callTool },
    cleanup: async () => {},
  } as unknown as MCPServerConnection
}

describe('Slack typeahead MCP admission', () => {
  beforeEach(() => {
    clearCurrentRuntimeSession()
    clearSlackChannelCache()
  })

  afterEach(() => {
    clearCurrentRuntimeSession()
    clearSlackChannelCache()
    vi.useRealTimers()
  })

  it('does not issue the canonical RPC until allowed and propagates the admitted call identity', async () => {
    const allow = Promise.withResolvers<void>()
    let reservationSequence = 0
    const state = admissionHarness({
      acquire: async input => {
        await allow.promise
        return leaseFor(input, `slack-reservation-${++reservationSequence}`)
      },
    })
    const managerCallTool = vi.fn(async () => ({
      content: 'Name: #general',
    }))
    const rawCallTool = vi.fn()
    installSession(state.admission, managerCallTool)
    const clients = [slackConnection(rawCallTool)]

    const first = getSlackChannelSuggestions(clients, 'gen')
    await vi.waitFor(() => expect(state.acquire).toHaveBeenCalledOnce())
    expect(managerCallTool).not.toHaveBeenCalled()
    expect(rawCallTool).not.toHaveBeenCalled()

    allow.resolve()
    await expect(first).resolves.toEqual([
      { id: 'slack-channel-general', displayText: '#general' },
    ])
    await getSlackChannelSuggestions(clients, 'ran')

    const acquireInputs = state.acquire.mock.calls.map(call => call[0])
    expect(acquireInputs).toHaveLength(2)
    expect(acquireInputs[0]).toMatchObject({
      kind: 'tool_exec',
      maxInputTokens: 0,
      maxOutputTokens: 0,
      maxCostUsd: 0,
      sessionId: 'session-slack',
    })
    expect(acquireInputs[0]?.stepId).toMatch(
      /^tool:legacy-direct:session-slack:[0-9a-f-]{36}$/,
    )
    expect(acquireInputs[1]?.stepId).not.toBe(acquireInputs[0]?.stepId)
    const firstCallId = acquireInputs[0]?.stepId.split(':').at(-1)
    expect(managerCallTool).toHaveBeenNthCalledWith(
      1,
      'workspace-slack',
      'slack_search_channels',
      {
        query: 'gen',
        limit: 20,
        channel_types: 'public_channel,private_channel',
      },
      {
        signal: expect.any(AbortSignal),
        callId: firstCallId,
      },
    )
    expect(rawCallTool).not.toHaveBeenCalled()
    expect(state.admission.markDispatched).toHaveBeenNthCalledWith(
      1,
      'slack-reservation-1',
      expect.objectContaining({
        boundary: 'tool_effect',
        details: expect.objectContaining({
          toolName: 'mcp.preflight.slack_channel_suggestions',
          recoveryCategory: 'idempotent',
          maxCostUsd: 0,
        }),
      }),
    )
    expect(state.admission.reconcile).toHaveBeenNthCalledWith(
      1,
      'slack-reservation-1',
      { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    )
    expect(state.admission.acknowledgeCompletion).toHaveBeenNthCalledWith(
      1,
      'slack-reservation-1',
    )
  })

  it('fails closed before canonical or raw RPC when the kernel denies admission', async () => {
    const state = admissionHarness({
      acquire: async () => {
        throw new AdmissionDeniedError('budget_exhausted')
      },
    })
    const managerCallTool = vi.fn()
    const rawCallTool = vi.fn()
    installSession(state.admission, managerCallTool)

    await expect(
      getSlackChannelSuggestions([slackConnection(rawCallTool)], 'general'),
    ).resolves.toEqual([])
    expect(managerCallTool).not.toHaveBeenCalled()
    expect(rawCallTool).not.toHaveBeenCalled()
    expect(state.admission.markDispatched).not.toHaveBeenCalled()
  })

  it('does not parse channel-looking content from a canonical error result', async () => {
    vi.useFakeTimers()
    const state = admissionHarness()
    const managerCallTool = vi.fn(async () => ({
      content: 'Name: #must-not-show',
      isError: true,
    }))
    const rawCallTool = vi.fn()
    installSession(state.admission, managerCallTool)

    await expect(
      getSlackChannelSuggestions([slackConnection(rawCallTool)], 'must'),
    ).resolves.toEqual([])
    expect(managerCallTool).toHaveBeenCalledOnce()
    expect(rawCallTool).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails closed before canonical or raw RPC when the required kernel is missing', async () => {
    const managerCallTool = vi.fn()
    const rawCallTool = vi.fn()
    installSession(undefined, managerCallTool)

    await expect(
      getSlackChannelSuggestions([slackConnection(rawCallTool)], 'general'),
    ).resolves.toEqual([])
    expect(managerCallTool).not.toHaveBeenCalled()
    expect(rawCallTool).not.toHaveBeenCalled()
  })

  it('does not fall back to the raw client when the canonical manager boundary is unavailable', async () => {
    const state = admissionHarness()
    const rawCallTool = vi.fn()
    installSession(state.admission)

    await expect(
      getSlackChannelSuggestions([slackConnection(rawCallTool)], 'general'),
    ).resolves.toEqual([])
    expect(state.acquire).not.toHaveBeenCalled()
    expect(rawCallTool).not.toHaveBeenCalled()
  })

  it('fails closed before RPC without one unambiguous ambient session', async () => {
    const rawCallTool = vi.fn()

    await expect(
      getSlackChannelSuggestions([slackConnection(rawCallTool)], 'general'),
    ).resolves.toEqual([])
    expect(rawCallTool).not.toHaveBeenCalled()
  })

  it('forwards lease cancellation and reconciles the idempotent RPC settlement', async () => {
    const leaseController = new AbortController()
    const state = admissionHarness({
      acquire: async input =>
        leaseFor(input, 'slack-cancelled', leaseController.signal),
    })
    const invoked = Promise.withResolvers<AbortSignal>()
    const managerCallTool = vi.fn(
      async (
        _serverName: string,
        _toolName: string,
        _args: Readonly<Record<string, unknown>>,
        options: { signal: AbortSignal },
      ) => {
        invoked.resolve(options.signal)
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(options.signal.reason),
            { once: true },
          )
        })
      },
    )
    const rawCallTool = vi.fn()
    installSession(state.admission, managerCallTool)

    const suggestions = getSlackChannelSuggestions(
      [slackConnection(rawCallTool)],
      'general',
    )
    const rawSignal = await invoked.promise
    const cancellation = new AdmissionDeniedError(
      'run_cancelled',
      'cancelled',
    )
    leaseController.abort(cancellation)

    await expect(suggestions).resolves.toEqual([])
    expect(rawSignal.aborted).toBe(true)
    expect(rawSignal.reason).toBe(cancellation)
    await vi.waitFor(() => {
      expect(state.admission.acknowledgeCompletion).toHaveBeenCalledWith(
        'slack-cancelled',
      )
    })
    expect(state.admission.reconcile).toHaveBeenCalledWith(
      'slack-cancelled',
      { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    )
    expect(state.admission.holdUnknown).not.toHaveBeenCalled()
    expect(rawCallTool).not.toHaveBeenCalled()
  })

  it('aborts the canonical call after five seconds and releases the timeout timer', async () => {
    vi.useFakeTimers()
    const state = admissionHarness()
    const invoked = Promise.withResolvers<AbortSignal>()
    const physical = Promise.withResolvers<{ content: string }>()
    const managerCallTool = vi.fn(
      async (
        _serverName: string,
        _toolName: string,
        _args: Readonly<Record<string, unknown>>,
        options: { signal: AbortSignal },
      ) => {
        invoked.resolve(options.signal)
        return physical.promise
      },
    )
    const rawCallTool = vi.fn()
    installSession(state.admission, managerCallTool)

    const suggestions = getSlackChannelSuggestions(
      [slackConnection(rawCallTool)],
      'general',
    )
    let settled = false
    void suggestions.then(() => {
      settled = true
    })
    const signal = await invoked.promise
    expect(signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(4999)
    expect(signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)

    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBeInstanceOf(DOMException)
    expect((signal.reason as DOMException).name).toBe('AbortError')
    expect(settled).toBe(false)
    expect(state.admission.reconcile).not.toHaveBeenCalled()
    expect(state.admission.acknowledgeCompletion).not.toHaveBeenCalled()

    physical.resolve({ content: 'Name: #late-result' })
    await expect(suggestions).resolves.toEqual([])

    expect(vi.getTimerCount()).toBe(0)
    expect(state.admission.reconcile).toHaveBeenCalledWith(
      expect.any(String),
      { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    )
    expect(rawCallTool).not.toHaveBeenCalled()
  })
})
