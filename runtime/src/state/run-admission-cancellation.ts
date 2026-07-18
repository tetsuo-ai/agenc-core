import type {
  AdmissionCancellationReport,
  AdmissionReconcileInput,
  AdmissionReconcileResult,
} from "../budget/admission-types.js";
import type { ExecutionAdmissionRepository } from "./execution-admission.js";
import {
  cancelAgentRunTree,
  type CancelAgentRunTreeReport,
} from "./run-cancellation.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";

export interface AtomicRunAdmissionCancellationReport {
  readonly run: CancelAgentRunTreeReport;
  readonly admission: AdmissionCancellationReport;
}

export interface AtomicAdmissionReconcileReport {
  readonly admission: AdmissionReconcileResult;
  /** Present when this reconciliation represents a provider overrun. */
  readonly run?: CancelAgentRunTreeReport;
}

/**
 * Reconcile provider usage and, when it overruns the reservation, cancel the
 * canonical agent-run/spawn-edge tree in the same SQLite write transaction.
 *
 * The repository also locks and settles the admission subtree during
 * reconciliation. Wrapping both transitions here means a crash or cascade
 * failure cannot expose provider-overrun accounting while `agent_runs` still
 * says the same execution is recoverable. A duplicate overrun is also repaired
 * so state written by an older interrupted caller cannot strand the run tree.
 */
export function reconcileAdmissionAndRunTree(
  driver: StateSqliteDriver,
  admissions: ExecutionAdmissionRepository,
  options: {
    readonly reservationId: string;
    readonly input: AdmissionReconcileInput;
    readonly reconciledAt: string;
  },
): AtomicAdmissionReconcileReport {
  return driver.transactionImmediate(() => {
    const reservation = admissions.getReservation(options.reservationId);
    const admission = admissions.reconcile(
      options.reservationId,
      options.input,
      { at: options.reconciledAt },
    );
    const isProviderOverrun =
      admission.outcome === "provider_overrun" ||
      (admission.outcome === "duplicate" &&
        admission.existingStatus === "provider_overrun");
    if (!isProviderOverrun) return { admission };
    if (reservation === undefined) {
      // `admissions.reconcile` normally throws first; retain a fail-closed
      // invariant if repository behavior ever changes.
      throw new Error(
        `provider-overrun reservation disappeared: ${options.reservationId}`,
      );
    }
    const run = cancelAgentRunTree(driver, {
      runId: reservation.reservation.step.runId,
      reason: "provider_overrun",
      cancelledAt: options.reconciledAt,
    });
    return { admission, run };
  });
}

/**
 * Persist the agent-run cascade and admission settlement under one SQLite
 * write transaction. Both called repositories use nested savepoints, so any
 * failure rolls the entire cancellation back instead of exposing a crash gap.
 */
export function cancelRunTreeAndAdmission(
  driver: StateSqliteDriver,
  admissions: ExecutionAdmissionRepository,
  options: {
    readonly runId: string;
    readonly reason: string;
    readonly cancelledAt: string;
  },
): AtomicRunAdmissionCancellationReport {
  return driver.transactionImmediate(() => {
    const hasAgentRun =
      driver
        .prepareState<[string], { readonly found: number }>(
          "SELECT 1 AS found FROM agent_runs WHERE id = ? LIMIT 1",
        )
        .get(options.runId) !== undefined;
    const hasAdmissionState = admissions.hasRunState(options.runId);
    const admissionAlreadyTerminal =
      admissions.isRunCancellationLocked(options.runId);
    if (!hasAgentRun && !hasAdmissionState) {
      return {
        run: {
          runId: options.runId,
          missing: true,
          alreadyTerminal: false,
          rootStatusBefore: null,
          subtreeRunIds: [],
          cancelledRunIds: [],
          priorStatusById: {},
          closedEdgeChildIds: [],
        },
      admission: emptyAdmissionCancellationReport(options.runId),
      };
    }

    const agentRun = cancelAgentRunTree(driver, options);
    const admission = admissions.cancel(options.runId, {
      reason: options.reason,
      cancelledAt: options.cancelledAt,
    });
    return {
      run: hasAgentRun
        ? agentRun
        : {
            ...agentRun,
            missing: false,
            admissionOnly: true,
            alreadyTerminal: admissionAlreadyTerminal,
            rootStatusBefore: admissionAlreadyTerminal ? "cancelled" : null,
            subtreeRunIds: admission.affectedRunIds,
          },
      admission,
    };
  });
}

function emptyAdmissionCancellationReport(
  runId: string,
): AdmissionCancellationReport {
  return {
    runId,
    affectedRunIds: [],
    cancelledJobIds: [],
    voidedReservationIds: [],
    heldUnknownReservationIds: [],
  };
}
