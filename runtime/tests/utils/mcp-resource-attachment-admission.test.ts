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
import type { ToolUseContext } from '../../src/tools/Tool.js'
import { createEmptyToolPermissionContext } from '../../src/permissions/types.js'
import { getAttachments } from '../../src/utils/attachments.js'

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

function installSession(admission?: ExecutionAdmissionClient): void {
  setCurrentRuntimeSession({
    conversationId: 'session-resource',
    services: {
      ...(admission ? { executionAdmission: admission } : {}),
      admissionRequired: true,
    },
  } as unknown as Session)
}

function attachmentContext(
  readResource: ReturnType<typeof vi.fn>,
): ToolUseContext {
  return {
    abortController: new AbortController(),
    readFileState: new Map(),
    nestedMemoryAttachmentTriggers: new Set(),
    options: {
      commands: [],
      debug: false,
      tools: [],
      verbose: false,
      mainLoopModel: 'test-model',
      thinkingConfig: { type: 'disabled' },
      mcpClients: [
        {
          name: 'docs',
          type: 'connected',
          client: { readResource },
        },
      ],
      mcpResources: {
        docs: [
          {
            uri: 'guide',
            name: 'Project guide',
            description: 'Useful docs',
          },
        ],
      },
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
    },
    getAppState: () => ({
      toolPermissionContext: createEmptyToolPermissionContext(),
      todos: {},
    }),
    setAppState: () => {},
  } as unknown as ToolUseContext
}

async function readMention(context: ToolUseContext) {
  return getAttachments('@docs:guide', context, null, [], [])
}

describe('MCP resource attachment admission', () => {
  beforeEach(() => {
    clearCurrentRuntimeSession()
  })

  afterEach(() => {
    clearCurrentRuntimeSession()
  })

  it('does not issue the raw RPC until allowed and settles the same journal identity', async () => {
    const allow = Promise.withResolvers<void>()
    const state = admissionHarness({
      acquire: async input => {
        await allow.promise
        return leaseFor(input, 'resource-reservation')
      },
    })
    installSession(state.admission)
    const readResource = vi.fn(async ({ uri }: { uri: string }) => ({
      contents: [{ uri, text: 'resource text' }],
    }))

    const attachments = readMention(attachmentContext(readResource))
    await vi.waitFor(() => expect(state.acquire).toHaveBeenCalledOnce())
    expect(readResource).not.toHaveBeenCalled()

    allow.resolve()
    await expect(attachments).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'mcp_resource',
          server: 'docs',
          uri: 'guide',
          name: 'Project guide',
        }),
      ]),
    )

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
    const requestOptions = readResource.mock.calls[0]?.[1]
    expect(requestOptions).toMatchObject({ timeout: 1000 })
    expect(requestOptions?.signal).toBeInstanceOf(AbortSignal)
  })

  it('fails closed before RPC when the kernel denies admission', async () => {
    const state = admissionHarness({
      acquire: async () => {
        throw new AdmissionDeniedError('budget_exhausted')
      },
    })
    installSession(state.admission)
    const readResource = vi.fn()

    await expect(readMention(attachmentContext(readResource))).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'mcp_resource' })]),
    )
    expect(readResource).not.toHaveBeenCalled()
    expect(state.admission.markDispatched).not.toHaveBeenCalled()
  })

  it('fails closed before RPC when the required kernel is missing', async () => {
    installSession()
    const readResource = vi.fn()

    await readMention(attachmentContext(readResource))
    expect(readResource).not.toHaveBeenCalled()
  })

  it('fails closed before RPC without one unambiguous ambient session', async () => {
    const readResource = vi.fn()

    await readMention(attachmentContext(readResource))
    expect(readResource).not.toHaveBeenCalled()
  })

  it('forwards lease cancellation to the raw RPC and holds its journal outcome', async () => {
    const leaseController = new AbortController()
    const state = admissionHarness({
      acquire: async input =>
        leaseFor(input, 'resource-cancelled', leaseController.signal),
    })
    installSession(state.admission)
    const invoked = Promise.withResolvers<AbortSignal>()
    const readResource = vi.fn(
      async (_input: unknown, options: { signal: AbortSignal }) => {
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

    const attachments = readMention(attachmentContext(readResource))
    const rawSignal = await invoked.promise
    const cancellation = new AdmissionDeniedError(
      'run_cancelled',
      'cancelled',
    )
    leaseController.abort(cancellation)

    await expect(attachments).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'mcp_resource' })]),
    )
    expect(rawSignal.aborted).toBe(true)
    expect(rawSignal.reason).toBe(cancellation)
    expect(state.admission.holdUnknown).toHaveBeenCalledWith(
      'resource-cancelled',
      'tool_cancelled_after_dispatch',
    )
    expect(state.admission.acknowledgeCompletion).toHaveBeenCalledWith(
      'resource-cancelled',
    )
  })
})
