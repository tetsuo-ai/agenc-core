import { randomUUID } from 'node:crypto'

import {
  AdmissionDeniedError,
  type ExecutionAdmissionClient,
} from '../../budget/admission-client.js'
import type { SessionServices } from '../../session/session.js'

interface LegacyAgentParentSession {
  readonly conversationId: string
  readonly services: Pick<
    SessionServices,
    'executionAdmission' | 'admissionRequired'
  >
}

export interface LegacyAgentSpawnAdmission {
  readonly abortController: AbortController
  readonly childAdmission: ExecutionAdmissionClient | undefined
  markDispatched(): void
  commit(): void
  complete(): void
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new AdmissionDeniedError('legacy_agent_spawn_cancelled', 'cancelled')
}

/**
 * Admit one legacy AgentTool child through its durable spawn commit. The
 * returned child client gives every nested model/tool step its own run
 * identity while conserving the parent's budget hierarchy; those child
 * leases, rather than the short spawn lease, bound the live work.
 */
export async function beginLegacyAgentSpawnAdmission(params: {
  readonly parent: LegacyAgentParentSession
  readonly agentId: string
  readonly sourceAbortController: AbortController
  readonly stepId?: string
}): Promise<LegacyAgentSpawnAdmission> {
  const admission = params.parent.services.executionAdmission
  if (admission === undefined) {
    if (params.parent.services.admissionRequired !== false) {
      throw new AdmissionDeniedError('admission_kernel_unavailable')
    }
    return {
      abortController: params.sourceAbortController,
      childAdmission: undefined,
      markDispatched() {},
      commit() {},
      complete() {},
    }
  }

  const lease = await admission.acquire(
    {
      stepId:
        params.stepId ?? `legacy-agent-spawn:${params.agentId}:${randomUUID()}`,
      kind: 'spawn',
      sessionId: params.parent.conversationId,
      parentScopeId: params.parent.conversationId,
      maxInputTokens: 0,
      maxOutputTokens: 0,
      maxCostUsd: 0,
    },
    params.sourceAbortController.signal,
  )

  const abortController = new AbortController()
  const forwardSourceAbort = (): void => {
    if (!abortController.signal.aborted) {
      abortController.abort(params.sourceAbortController.signal.reason)
    }
  }
  const forwardLeaseAbort = (): void => {
    if (!abortController.signal.aborted) {
      abortController.abort(lease.signal.reason)
    }
  }
  if (params.sourceAbortController.signal.aborted) {
    forwardSourceAbort()
  } else {
    params.sourceAbortController.signal.addEventListener(
      'abort',
      forwardSourceAbort,
      { once: true },
    )
  }
  if (lease.signal.aborted) {
    forwardLeaseAbort()
  } else {
    lease.signal.addEventListener('abort', forwardLeaseAbort, { once: true })
  }

  const reservationId = lease.reservation.reservationId
  let dispatched = false
  let committed = false
  let completed = false
  let completionAcknowledged = false

  const cleanup = (): void => {
    params.sourceAbortController.signal.removeEventListener(
      'abort',
      forwardSourceAbort,
    )
    lease.signal.removeEventListener('abort', forwardLeaseAbort)
  }

  const acknowledgePhysicalCompletion = (): void => {
    if (completionAcknowledged) return
    try {
      admission.acknowledgeCompletion(reservationId)
      completionAcknowledged = true
    } catch {
      // Admission settlement is recovery evidence, not the spawn result. A
      // later idempotent complete() retries acknowledgement without turning a
      // durably published child into a retryable pre-commit failure.
    }
  }

  let childAdmission: ExecutionAdmissionClient
  try {
    childAdmission = admission.forSession({
      runId: params.agentId,
      sessionId: params.agentId,
      parentRunId: admission.scope.runId,
      parentScopeId: params.parent.conversationId,
    })
  } catch (error) {
    cleanup()
    try {
      admission.void(
        reservationId,
        'legacy_agent_child_admission_binding_failed',
      )
    } catch {
      // Preserve the binding failure. The acquired reservation remains
      // conservative recovery evidence if its void journal cannot be written.
    } finally {
      acknowledgePhysicalCompletion()
    }
    throw error
  }

  return {
    abortController,
    childAdmission,
    markDispatched(): void {
      if (dispatched) return
      if (abortController.signal.aborted) {
        throw cancellationError(abortController.signal)
      }
      admission.markDispatched(reservationId, {
        boundary: 'spawn_commit',
        details: {
          childThreadId: params.agentId,
          parentSessionId: params.parent.conversationId,
          legacyAgentTool: true,
        },
      })
      dispatched = true
    },
    commit(): void {
      if (committed) {
        acknowledgePhysicalCompletion()
        return
      }
      if (!dispatched) {
        throw new Error('legacy agent spawn cannot commit before dispatch')
      }
      // Callers invoke commit only after the child metadata/session boundary
      // is durably published. Record that fact before touching settlement: a
      // reconciliation journal fault (or a cancellation racing after the
      // write) must never be surfaced as a clean failure that invites a
      // duplicate spawn retry.
      committed = true
      try {
        admission.reconcile(reservationId, {
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        })
      } catch {
        try {
          admission.holdUnknown(
            reservationId,
            'legacy_agent_spawn_reconciliation_failed_after_commit',
          )
        } catch {
          // acknowledgePhysicalCompletion still releases the in-memory slot;
          // durable restart repair retains the dispatched evidence.
        }
      } finally {
        // The physical spawn boundary ends at durable child publication. The
        // child admission client, not this short spawn lease, accounts for its
        // subsequent model/tool work.
        acknowledgePhysicalCompletion()
      }
    },
    complete(): void {
      if (completed) {
        acknowledgePhysicalCompletion()
        return
      }
      completed = true
      cleanup()
      try {
        if (committed) return
        if (!dispatched) {
          admission.void(reservationId, 'legacy_agent_stopped_before_dispatch')
          return
        }
        admission.holdUnknown(
          reservationId,
          'legacy_agent_spawn_commit_outcome_unknown',
        )
      } catch {
        // Do not replace the physical setup/lifecycle outcome with an
        // admission repository failure. The dispatched journal evidence (if
        // any) remains conservative and acknowledgement releases live slots.
      } finally {
        acknowledgePhysicalCompletion()
      }
    },
  }
}
