import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { ExecutionAdmissionClient } from '../../../src/budget/admission-client.js'
import { AdmissionDeniedError } from '../../../src/budget/admission-client.js'
import { beginLegacyAgentSpawnAdmission } from '../../../src/tools/AgentTool/spawnAdmission.js'

function admissionClient(leaseSignal: AbortSignal): {
  readonly client: ExecutionAdmissionClient
  readonly child: ExecutionAdmissionClient
  readonly acquire: ReturnType<typeof vi.fn>
  readonly markDispatched: ReturnType<typeof vi.fn>
  readonly reconcile: ReturnType<typeof vi.fn>
  readonly holdUnknown: ReturnType<typeof vi.fn>
  readonly voidReservation: ReturnType<typeof vi.fn>
  readonly acknowledgeCompletion: ReturnType<typeof vi.fn>
  readonly forSession: ReturnType<typeof vi.fn>
} {
  const child = {
    scope: {
      runId: 'child-agent',
      workspaceId: 'workspace',
      sessionId: 'child-agent',
      autonomous: false,
    },
  } as ExecutionAdmissionClient
  const acquire = vi.fn(async () => ({
    decision: 'allow' as const,
    reservation: {
      reservationId: 'spawn-reservation',
      step: { runId: 'parent-run', stepId: 'legacy-spawn-step' },
      reservedCostUsd: 0,
      reservedTokens: 0,
      reservedAt: '2026-07-18T00:00:00.000Z',
    },
    request: {} as never,
    signal: leaseSignal,
  }))
  const markDispatched = vi.fn()
  const reconcile = vi.fn(() => ({
    applied: true as const,
    outcome: 'reconciled' as const,
  }))
  const voidReservation = vi.fn()
  const holdUnknown = vi.fn()
  const acknowledgeCompletion = vi.fn()
  const forSession = vi.fn(() => child)
  const client = {
    scope: {
      runId: 'parent-run',
      workspaceId: 'workspace',
      sessionId: 'parent-session',
      autonomous: false,
    },
    acquire,
    markDispatched,
    reconcile,
    holdUnknown,
    void: voidReservation,
    acknowledgeCompletion,
    recordFallback: vi.fn(),
    forSession,
    subscribe: vi.fn(() => () => {}),
  } satisfies ExecutionAdmissionClient
  return {
    client,
    child,
    acquire,
    markDispatched,
    reconcile,
    holdUnknown,
    voidReservation,
    acknowledgeCompletion,
    forSession,
  }
}

describe('legacy AgentTool spawn admission', () => {
  it('admits the spawn commit, binds a child run, and forwards source cancellation', async () => {
    const leaseAbort = new AbortController()
    const sourceAbort = new AbortController()
    const fake = admissionClient(leaseAbort.signal)
    const handle = await beginLegacyAgentSpawnAdmission({
      parent: {
        conversationId: 'parent-session',
        services: {
          executionAdmission: fake.client,
          admissionRequired: true,
        },
      },
      agentId: 'child-agent',
      sourceAbortController: sourceAbort,
      stepId: 'legacy-spawn-step',
    })

    expect(fake.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: 'legacy-spawn-step',
        kind: 'spawn',
        sessionId: 'parent-session',
        parentScopeId: 'parent-session',
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: 0,
      }),
      sourceAbort.signal,
    )
    expect(fake.forSession).toHaveBeenCalledWith({
      runId: 'child-agent',
      sessionId: 'child-agent',
      parentRunId: 'parent-run',
      parentScopeId: 'parent-session',
    })
    expect(handle.childAdmission).toBe(fake.child)

    handle.markDispatched()
    expect(fake.markDispatched).toHaveBeenCalledWith(
      'spawn-reservation',
      expect.objectContaining({ boundary: 'spawn_commit' }),
    )
    // Dispatch evidence is persisted before the metadata write. It must not
    // reconcile the spawn as successful until that durable commit finishes.
    expect(fake.reconcile).not.toHaveBeenCalled()

    handle.commit()
    expect(fake.reconcile).toHaveBeenCalledTimes(1)
    expect(fake.acknowledgeCompletion).toHaveBeenCalledOnce()

    sourceAbort.abort(new Error('parent_cancelled'))
    expect(handle.abortController.signal.aborted).toBe(true)
    expect(sourceAbort.signal.aborted).toBe(true)

    handle.complete()
    handle.complete()
    expect(fake.reconcile).toHaveBeenCalledTimes(1)
    expect(fake.reconcile).toHaveBeenCalledWith('spawn-reservation', {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    })
    expect(fake.acknowledgeCompletion).toHaveBeenCalledOnce()
  })

  it('does not expose a reconciliation fault as a retryable spawn failure after durable publication', async () => {
    const fake = admissionClient(new AbortController().signal)
    const reconciliationFailure = new Error(
      'simulated reconciliation journal failure',
    )
    fake.reconcile.mockImplementationOnce(() => {
      throw reconciliationFailure
    })
    let durablePublications = 0
    let retried = false

    const publish = async () => {
      const handle = await beginLegacyAgentSpawnAdmission({
        parent: {
          conversationId: 'parent-session',
          services: { executionAdmission: fake.client },
        },
        agentId: 'child-agent',
        sourceAbortController: new AbortController(),
        stepId: 'legacy-spawn-step',
      })
      try {
        handle.markDispatched()
        // This stands in for the successfully fsynced agent metadata/session
        // publication immediately before the production caller invokes commit.
        durablePublications++
        handle.commit()
        return handle
      } catch (error) {
        handle.complete()
        throw error
      }
    }

    const publishWithOneRetry = async () => {
      try {
        return await publish()
      } catch (error) {
        if (error !== reconciliationFailure) throw error
        retried = true
        return publish()
      }
    }

    const handle = await publishWithOneRetry()
    handle.complete()

    expect(retried).toBe(false)
    expect(durablePublications).toBe(1)
    expect(fake.acquire).toHaveBeenCalledOnce()
    expect(fake.holdUnknown).toHaveBeenCalledWith(
      'spawn-reservation',
      'legacy_agent_spawn_reconciliation_failed_after_commit',
    )
    expect(fake.acknowledgeCompletion).toHaveBeenCalledWith(
      'spawn-reservation',
    )
  })

  it('forwards live spawn-lease cancellation before durable dispatch', async () => {
    const leaseAbort = new AbortController()
    const sourceAbort = new AbortController()
    const fake = admissionClient(leaseAbort.signal)
    const handle = await beginLegacyAgentSpawnAdmission({
      parent: {
        conversationId: 'parent-session',
        services: { executionAdmission: fake.client },
      },
      agentId: 'child-agent',
      sourceAbortController: sourceAbort,
      stepId: 'legacy-spawn-step',
    })

    leaseAbort.abort(new AdmissionDeniedError('parent_cancelled', 'cancelled'))
    expect(handle.abortController.signal.aborted).toBe(true)
    expect(sourceAbort.signal.aborted).toBe(false)
    expect(() => handle.markDispatched()).toThrow(
      'execution admission cancelled: parent_cancelled',
    )
    handle.complete()
    expect(fake.markDispatched).not.toHaveBeenCalled()
    expect(fake.acknowledgeCompletion).toHaveBeenCalledWith(
      'spawn-reservation',
    )
  })

  it('voids a reservation when setup stops before the spawn commit', async () => {
    const fake = admissionClient(new AbortController().signal)
    const handle = await beginLegacyAgentSpawnAdmission({
      parent: {
        conversationId: 'parent-session',
        services: { executionAdmission: fake.client },
      },
      agentId: 'child-agent',
      sourceAbortController: new AbortController(),
      stepId: 'legacy-spawn-step',
    })

    handle.complete()
    expect(fake.voidReservation).toHaveBeenCalledWith(
      'spawn-reservation',
      'legacy_agent_stopped_before_dispatch',
    )
    expect(fake.reconcile).not.toHaveBeenCalled()
    expect(fake.acknowledgeCompletion).toHaveBeenCalledWith(
      'spawn-reservation',
    )
  })

  it('voids and acknowledges an acquired reservation when child binding fails', async () => {
    const fake = admissionClient(new AbortController().signal)
    const bindingFailure = new Error('child admission binding failed')
    fake.forSession.mockImplementationOnce(() => {
      throw bindingFailure
    })
    fake.voidReservation.mockImplementationOnce(() => {
      throw new Error('void journal failure')
    })

    await expect(
      beginLegacyAgentSpawnAdmission({
        parent: {
          conversationId: 'parent-session',
          services: { executionAdmission: fake.client },
        },
        agentId: 'child-agent',
        sourceAbortController: new AbortController(),
        stepId: 'legacy-spawn-step',
      }),
    ).rejects.toBe(bindingFailure)

    expect(fake.acquire).toHaveBeenCalledOnce()
    expect(fake.markDispatched).not.toHaveBeenCalled()
    expect(fake.voidReservation).toHaveBeenCalledWith(
      'spawn-reservation',
      'legacy_agent_child_admission_binding_failed',
    )
    expect(fake.acknowledgeCompletion).toHaveBeenCalledWith(
      'spawn-reservation',
    )
  })

  it('holds a dispatched spawn unknown when metadata commit never completes', async () => {
    const fake = admissionClient(new AbortController().signal)
    const handle = await beginLegacyAgentSpawnAdmission({
      parent: {
        conversationId: 'parent-session',
        services: { executionAdmission: fake.client },
      },
      agentId: 'child-agent',
      sourceAbortController: new AbortController(),
      stepId: 'legacy-spawn-step',
    })

    handle.markDispatched()
    handle.complete()

    expect(fake.reconcile).not.toHaveBeenCalled()
    expect(fake.holdUnknown).toHaveBeenCalledWith(
      'spawn-reservation',
      'legacy_agent_spawn_commit_outcome_unknown',
    )
    expect(fake.voidReservation).not.toHaveBeenCalled()
    expect(fake.acknowledgeCompletion).toHaveBeenCalledWith(
      'spawn-reservation',
    )
  })

  it('preserves a durable metadata commit when cancellation races after dispatch', async () => {
    const leaseAbort = new AbortController()
    const fake = admissionClient(leaseAbort.signal)
    const handle = await beginLegacyAgentSpawnAdmission({
      parent: {
        conversationId: 'parent-session',
        services: { executionAdmission: fake.client },
      },
      agentId: 'child-agent',
      sourceAbortController: new AbortController(),
      stepId: 'legacy-spawn-step',
    })

    handle.markDispatched()
    leaseAbort.abort(new AdmissionDeniedError('parent_cancelled', 'cancelled'))
    expect(() => handle.commit()).not.toThrow()
    handle.complete()

    expect(handle.abortController.signal.aborted).toBe(true)
    expect(fake.reconcile).toHaveBeenCalledOnce()
    expect(fake.holdUnknown).not.toHaveBeenCalled()
    expect(fake.acknowledgeCompletion).toHaveBeenCalledOnce()
  })

  it.each([
    { dispatched: false, settlement: 'void' as const },
    { dispatched: true, settlement: 'hold' as const },
  ])(
    'acknowledges physical completion when $settlement settlement throws',
    async ({ dispatched, settlement }) => {
      const fake = admissionClient(new AbortController().signal)
      const settlementFailure = new Error(`${settlement} journal failure`)
      if (settlement === 'void') {
        fake.voidReservation.mockImplementationOnce(() => {
          throw settlementFailure
        })
      } else {
        fake.holdUnknown.mockImplementationOnce(() => {
          throw settlementFailure
        })
      }
      const handle = await beginLegacyAgentSpawnAdmission({
        parent: {
          conversationId: 'parent-session',
          services: { executionAdmission: fake.client },
        },
        agentId: 'child-agent',
        sourceAbortController: new AbortController(),
        stepId: 'legacy-spawn-step',
      })
      if (dispatched) handle.markDispatched()

      expect(() => handle.complete()).not.toThrow()
      expect(fake.acknowledgeCompletion).toHaveBeenCalledWith(
        'spawn-reservation',
      )
    },
  )

  it('retries a failed physical-completion acknowledgement idempotently', async () => {
    const fake = admissionClient(new AbortController().signal)
    fake.acknowledgeCompletion.mockImplementationOnce(() => {
      throw new Error('completion acknowledgement failure')
    })
    const handle = await beginLegacyAgentSpawnAdmission({
      parent: {
        conversationId: 'parent-session',
        services: { executionAdmission: fake.client },
      },
      agentId: 'child-agent',
      sourceAbortController: new AbortController(),
      stepId: 'legacy-spawn-step',
    })

    handle.markDispatched()
    expect(() => handle.commit()).not.toThrow()
    expect(fake.acknowledgeCompletion).toHaveBeenCalledOnce()

    handle.complete()
    handle.complete()
    expect(fake.acknowledgeCompletion).toHaveBeenCalledTimes(2)
  })

  it('fails closed when a production parent requires an unavailable kernel', async () => {
    await expect(
      beginLegacyAgentSpawnAdmission({
        parent: {
          conversationId: 'parent-session',
          services: { admissionRequired: true },
        },
        agentId: 'child-agent',
        sourceAbortController: new AbortController(),
      }),
    ).rejects.toMatchObject({
      code: 'ADMISSION_DENIED',
      reason: 'admission_kernel_unavailable',
    })
  })

  it('keeps the production runner wired to the child client', () => {
    const runtimeRoot = resolve(import.meta.dirname, '../../../src')
    const runAgentSource = readFileSync(
      resolve(runtimeRoot, 'tools/AgentTool/runAgent.ts'),
      'utf8',
    )
    expect(runAgentSource).toContain('beginLegacyAgentSpawnAdmission')
    expect(runAgentSource).toContain('spawnAdmission.markDispatched()')
    expect(runAgentSource).toContain('spawnAdmission.commit()')
    expect(runAgentSource).toContain(
      'executionAdmission: spawnAdmission.childAdmission',
    )
  })
})
