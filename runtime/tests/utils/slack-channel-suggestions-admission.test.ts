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

function installSession(admission?: ExecutionAdmissionClient): void {
  setCurrentRuntimeSession({
    ...createTestEffectJournal(),
    conversationId: 'session-slack',
    services: {
      ...(admission ? { executionAdmission: admission } : {}),
      admissionRequired: true,
    },
  } as unknown as Session)
}

function slackConnection(callTool: ReturnType<typeof vi.fn>): MCPServerConnection {
  return {
    name: 'workspace-slack',
    type: 'connected',
    capabilities: { tools: {} },
    config: { type: 'sdk', name: 'workspace-slack', scope: 'dynamic' },
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
  })

  it('does not issue the raw RPC until allowed and journals stable settlement identity', async () => {
    const allow = Promise.withResolvers<void>()
    let reservationSequence = 0
    const state = admissionHarness({
      acquire: async input => {
        await allow.promise
        return leaseFor(input, `slack-reservation-${++reservationSequence}`)
      },
    })
    installSession(state.admission)
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'Name: #general' }],
    }))
    const clients = [slackConnection(callTool)]

    const first = getSlackChannelSuggestions(clients, 'gen')
    await vi.waitFor(() => expect(state.acquire).toHaveBeenCalledOnce())
    expect(callTool).not.toHaveBeenCalled()

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
    const requestOptions = callTool.mock.calls[0]?.[2]
    expect(requestOptions).toMatchObject({ timeout: 5000, maxTotalTimeout: 5000 })
    expect(requestOptions?.signal).toBeInstanceOf(AbortSignal)
  })

  it('fails closed before RPC when the kernel denies admission', async () => {
    const state = admissionHarness({
      acquire: async () => {
        throw new AdmissionDeniedError('budget_exhausted')
      },
    })
    installSession(state.admission)
    const callTool = vi.fn()

    await expect(
      getSlackChannelSuggestions([slackConnection(callTool)], 'general'),
    ).resolves.toEqual([])
    expect(callTool).not.toHaveBeenCalled()
    expect(state.admission.markDispatched).not.toHaveBeenCalled()
  })

  it('fails closed before RPC when the required kernel is missing', async () => {
    installSession()
    const callTool = vi.fn()

    await expect(
      getSlackChannelSuggestions([slackConnection(callTool)], 'general'),
    ).resolves.toEqual([])
    expect(callTool).not.toHaveBeenCalled()
  })

  it('fails closed before RPC without one unambiguous ambient session', async () => {
    const callTool = vi.fn()

    await expect(
      getSlackChannelSuggestions([slackConnection(callTool)], 'general'),
    ).resolves.toEqual([])
    expect(callTool).not.toHaveBeenCalled()
  })

  it('forwards lease cancellation to the raw RPC and holds its journal outcome', async () => {
    const leaseController = new AbortController()
    const state = admissionHarness({
      acquire: async input =>
        leaseFor(input, 'slack-cancelled', leaseController.signal),
    })
    installSession(state.admission)
    const invoked = Promise.withResolvers<AbortSignal>()
    const callTool = vi.fn(
      async (
        _input: unknown,
        _schema: unknown,
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

    const suggestions = getSlackChannelSuggestions(
      [slackConnection(callTool)],
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
    expect(state.admission.holdUnknown).toHaveBeenCalledWith(
      'slack-cancelled',
      'tool_cancelled_after_dispatch',
    )
    expect(state.admission.acknowledgeCompletion).toHaveBeenCalledWith(
      'slack-cancelled',
    )
  })
})
