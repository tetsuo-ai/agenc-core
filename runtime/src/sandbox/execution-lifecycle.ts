import {
  SandboxExecutionBroker,
  type SandboxExecutionBrokerAuthority,
  type SandboxExecutionBrokerLike,
  type SandboxExecutionLifecycleFence,
  type SandboxExecutionSurface,
} from "./execution-broker.js";
import { resolve } from "node:path";
import type { SandboxMode } from "../tools/orchestrator.js";

export interface SandboxExecutionLifecycleParticipant {
  readonly name: string;
  /** Long-lived spawn surfaces whose process tree this participant owns. */
  readonly spawnSurfaces?: readonly SandboxExecutionSurface[];
  /** Stop every child that was created under the broker's current cwd. */
  quiesce(): Promise<void>;
  /** Re-arm the service after the broker has moved; lazy services may no-op. */
  resume(cwd: string): Promise<void>;
  /** Permanently release broker-owned state. Defaults to {@link quiesce}. */
  dispose?(): Promise<void>;
}

const participants = new WeakMap<
  SandboxExecutionBrokerLike,
  Set<SandboxExecutionLifecycleParticipant>
>();
const participantSpawnUnregisters = new WeakMap<
  SandboxExecutionBrokerLike,
  Map<SandboxExecutionLifecycleParticipant, () => void>
>();
const disposedBrokers = new WeakSet<SandboxExecutionBrokerLike>();
const disposalPromises = new WeakMap<
  SandboxExecutionBrokerLike,
  Promise<void>
>();
type SandboxExecutionLifecyclePhase =
  "idle" | "queued" | "cwd-transition" | "mode-transition" | "disposal";

interface SandboxExecutionLifecycleCoordinator {
  tail: Promise<void>;
  pending: number;
  phase: SandboxExecutionLifecyclePhase;
}

const lifecycleCoordinators = new WeakMap<
  SandboxExecutionBrokerLike,
  SandboxExecutionLifecycleCoordinator
>();

export function registerSandboxExecutionLifecycleParticipant(
  broker: SandboxExecutionBrokerLike,
  participant: SandboxExecutionLifecycleParticipant,
): () => void {
  if (disposedBrokers.has(broker)) {
    throw new Error(
      `cannot register ${participant.name} on a disposed sandbox execution broker`,
    );
  }
  const coordinator = lifecycleCoordinators.get(broker);
  if (coordinator !== undefined && coordinator.phase !== "idle") {
    throw new Error(
      `cannot register ${participant.name} while a sandbox execution broker lifecycle transition is active`,
    );
  }
  if (!(broker instanceof SandboxExecutionBroker)) {
    throw new Error(
      `cannot register ${participant.name} without a canonical sandbox execution broker`,
    );
  }
  const unregisterSpawnSurfaces =
    broker.registerLifecycleParticipantSpawnSurfaces(
      participant.name,
      participant.spawnSurfaces ?? [],
    );
  const scoped = participants.get(broker) ?? new Set();
  scoped.add(participant);
  participants.set(broker, scoped);
  const spawnUnregisters = participantSpawnUnregisters.get(broker) ??
    new Map<SandboxExecutionLifecycleParticipant, () => void>();
  spawnUnregisters.set(participant, unregisterSpawnSurfaces);
  participantSpawnUnregisters.set(broker, spawnUnregisters);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    scoped.delete(participant);
    spawnUnregisters.get(participant)?.();
    spawnUnregisters.delete(participant);
    if (scoped.size === 0) {
      participants.delete(broker);
      participantSpawnUnregisters.delete(broker);
    }
  };
}

export function isSandboxExecutionBrokerDisposed(
  broker: SandboxExecutionBrokerLike,
): boolean {
  return disposedBrokers.has(broker);
}

/**
 * Permanently stop and detach every process owner registered to a child
 * broker. Disposal is idempotent and runs in reverse registration order so
 * higher-level services release their dependencies before earlier owners.
 * A failed participant remains attached to the now-closed broker and is
 * retried by the next call; participants that already proved cleanup are not
 * disposed twice.
 */
export function disposeSandboxExecutionBroker(
  broker: SandboxExecutionBrokerLike,
): Promise<void> {
  const existing = disposalPromises.get(broker);
  if (existing !== undefined) return existing;

  disposedBrokers.add(broker);
  const disposal = runSerializedLifecycleOperation(
    broker,
    "disposal",
    async () => {
      const registered = participants.get(broker);
      const scoped = [...(registered ?? [])].reverse();
      const errors: unknown[] = [];
      const failed: SandboxExecutionLifecycleParticipant[] = [];
      for (const participant of scoped) {
        try {
          if (participant.dispose !== undefined) {
            await participant.dispose();
          } else {
            await participant.quiesce();
          }
        } catch (error) {
          failed.push(participant);
          errors.push(error);
          continue;
        }
        registered?.delete(participant);
        const spawnUnregisters = participantSpawnUnregisters.get(broker);
        spawnUnregisters?.get(participant)?.();
        spawnUnregisters?.delete(participant);
      }
      if (registered?.size === 0) {
        participants.delete(broker);
        participantSpawnUnregisters.delete(broker);
      }
      if (!(broker instanceof SandboxExecutionBroker)) {
        throw new Error(
          "sandbox lifecycle disposal lost its canonical execution broker",
        );
      }
      broker.closeAfterLifecycleAuthorityFailure(
        "sandbox execution broker was disposed",
      );
      if (errors.length > 0) {
        throw lifecycleAggregateError(
          "disposal failed; broker remains closed",
          failed,
          errors,
        );
      }
    },
  );
  disposalPromises.set(broker, disposal);
  void disposal.catch(() => {
    if (disposalPromises.get(broker) === disposal) {
      disposalPromises.delete(broker);
    }
  });
  return disposal;
}

/**
 * Move a live broker only after every process created under its old authority
 * has stopped. A failed resume is rolled back: new-authority children are
 * quiesced, the old cwd is restored, and participants are resumed there.
 */
export async function transitionSandboxExecutionBroker(
  broker: SandboxExecutionBrokerLike,
  cwd: string,
): Promise<void> {
  if (disposedBrokers.has(broker)) {
    throw new Error("cannot transition a disposed sandbox execution broker");
  }
  if (!(broker instanceof SandboxExecutionBroker)) {
    throw new Error(
      "sandbox lifecycle operations require a canonical execution broker",
    );
  }
  const canonicalBroker = broker;
  return runSerializedLifecycleOperation(
    canonicalBroker,
    "cwd-transition",
    async (fence) => {
      const lifecycleFence = requireLifecycleFence(fence);
    if (disposedBrokers.has(canonicalBroker)) {
      throw new Error("cannot transition a disposed sandbox execution broker");
    }
    const targetCwd = resolve(cwd);
    if (canonicalBroker.cwd === targetCwd) return;
    const previousCwd = canonicalBroker.cwd;
    const scoped = [...(participants.get(canonicalBroker) ?? [])];
    const quiesceErrors = await settleLifecyclePhase(
      scoped.map((participant) => () => participant.quiesce()),
    );
    if (quiesceErrors.length > 0) {
      // Some participants may already be stopped. Re-arm all of them at the
      // unchanged authority before reporting failure so a partial quiesce does
      // not leave the session silently degraded.
      const recoveryErrors = await settleLifecycleResumePhase(
        canonicalBroker,
        lifecycleFence,
        scoped,
        previousCwd,
      );
      if (recoveryErrors.length > 0) {
        closeSandboxExecutionBrokerAfterAuthorityFailure(canonicalBroker);
        throw lifecycleAggregateError(
          "quiesce failed; recovery resume failed and broker was closed",
          scoped,
          [...quiesceErrors, ...recoveryErrors],
        );
      }
      throw lifecycleAggregateError(
        "quiesce failed; old authority restored",
        scoped,
        [...quiesceErrors, ...recoveryErrors],
      );
    }
    const mutationPermit =
      canonicalBroker.proveLifecycleParticipantsQuiesced(lifecycleFence);
    canonicalBroker.rebaseAfterLifecycleQuiesce(mutationPermit, targetCwd);
    const resumeErrors = await settleLifecycleResumePhase(
      canonicalBroker,
      lifecycleFence,
      scoped,
      targetCwd,
    );
    if (resumeErrors.length === 0) return;

    const rollbackQuiesceErrors = await settleLifecyclePhase(
      scoped.map((participant) => () => participant.quiesce()),
    );
    if (rollbackQuiesceErrors.length > 0) {
      closeSandboxExecutionBrokerAfterAuthorityFailure(canonicalBroker);
      throw lifecycleAggregateError(
        "resume failed; rollback quiesce failed and broker was closed",
        scoped,
        [...resumeErrors, ...rollbackQuiesceErrors],
      );
    }
    const rollbackMutationPermit =
      canonicalBroker.proveLifecycleParticipantsQuiesced(lifecycleFence);
    canonicalBroker.rebaseAfterLifecycleQuiesce(
      rollbackMutationPermit,
      previousCwd,
    );
    const rollbackResumeErrors = await settleLifecycleResumePhase(
      canonicalBroker,
      lifecycleFence,
      scoped,
      previousCwd,
    );
    if (rollbackResumeErrors.length > 0) {
      closeSandboxExecutionBrokerAfterAuthorityFailure(canonicalBroker);
      throw lifecycleAggregateError(
        "resume failed; rollback resume failed and broker was closed",
        scoped,
        [...resumeErrors, ...rollbackResumeErrors],
      );
    }
    throw lifecycleAggregateError(
      "resume failed; transition rolled back",
      scoped,
      [...resumeErrors, ...rollbackQuiesceErrors, ...rollbackResumeErrors],
    );
    },
  );
}

export interface SandboxExecutionModeAuthorityUpdate {
  commit(): Promise<void> | void;
  rollback(): Promise<void> | void;
}

/**
 * Change a live broker's policy only while every registered process owner is
 * stopped. The optional authority update commits while those owners remain
 * quiesced. A failed commit or resume restores the full previous authority
 * before any old-authority child is resumed.
 */
export async function transitionSandboxExecutionBrokerMode(
  broker: SandboxExecutionBroker,
  mode: SandboxMode,
  authorityUpdate?: SandboxExecutionModeAuthorityUpdate,
): Promise<void> {
  return transitionSandboxExecutionBrokerAuthority(
    broker,
    { ...broker.executionAuthority(), mode },
    authorityUpdate,
  );
}

/** Apply every process-relevant sandbox setting under the lifecycle lock. */
export async function transitionSandboxExecutionBrokerAuthority(
  broker: SandboxExecutionBroker,
  authority: SandboxExecutionBrokerAuthority,
  authorityUpdate?: SandboxExecutionModeAuthorityUpdate,
): Promise<void> {
  if (disposedBrokers.has(broker)) {
    throw new Error("cannot transition a disposed sandbox execution broker");
  }
  return runSerializedLifecycleOperation(
    broker,
    "mode-transition",
    async (fence) => {
      const lifecycleFence = requireLifecycleFence(fence);
      if (disposedBrokers.has(broker)) {
        throw new Error(
          "cannot transition a disposed sandbox execution broker",
        );
      }
      const liveAuthority = broker.executionAuthority();
      if (
        authorityUpdate === undefined &&
        liveAuthority.mode === authority.mode &&
        liveAuthority.permissionProfile === authority.permissionProfile &&
        liveAuthority.windowsSandboxLevel === authority.windowsSandboxLevel &&
        liveAuthority.allowGpu === authority.allowGpu
      ) {
        return;
      }
      const previousAuthority = liveAuthority;
      const cwd = broker.cwd;
      const scoped = [...(participants.get(broker) ?? [])];
      const quiesceErrors = await settleLifecyclePhase(
        scoped.map((participant) => () => participant.quiesce()),
      );
      if (quiesceErrors.length > 0) {
      const recoveryErrors = await settleLifecycleResumePhase(
        broker,
        lifecycleFence,
        scoped,
        cwd,
      );
      if (recoveryErrors.length > 0) {
        closeSandboxExecutionBrokerAfterAuthorityFailure(broker);
        throw lifecycleAggregateError(
          "quiesce failed; recovery resume failed and broker was closed",
          scoped,
          [...quiesceErrors, ...recoveryErrors],
        );
      }
      throw lifecycleAggregateError(
        "quiesce failed; old authority restored",
          scoped,
          [...quiesceErrors, ...recoveryErrors],
        );
      }

      const mutationPermit =
        broker.proveLifecycleParticipantsQuiesced(lifecycleFence);
      broker.applyAuthorityAfterLifecycleQuiesce(mutationPermit, authority);
      try {
        await authorityUpdate?.commit();
      } catch (error) {
        const rollbackErrors = await settleLifecyclePhase([
          () => authorityUpdate?.rollback(),
        ]);
        if (rollbackErrors.length > 0) {
          closeSandboxExecutionBrokerAfterAuthorityFailure(broker);
          throw lifecycleAggregateError(
            "authority commit failed; rollback incomplete",
            scoped,
            [error, ...rollbackErrors],
          );
        }
        broker.applyAuthorityAfterLifecycleQuiesce(
          mutationPermit,
          previousAuthority,
        );
        const rollbackResumeErrors = await settleLifecycleResumePhase(
          broker,
          lifecycleFence,
          scoped,
          cwd,
        );
        if (rollbackResumeErrors.length > 0) {
          closeSandboxExecutionBrokerAfterAuthorityFailure(broker);
          throw lifecycleAggregateError(
            "authority commit failed; rollback resume failed and broker was closed",
            scoped,
            [error, ...rollbackResumeErrors],
          );
        }
        throw lifecycleAggregateError(
          "authority commit failed; transition rolled back",
          scoped,
          [error, ...rollbackResumeErrors],
        );
      }
      const resumeErrors = await settleLifecycleResumePhase(
        broker,
        lifecycleFence,
        scoped,
        cwd,
      );
      if (resumeErrors.length === 0) return;

      const rollbackQuiesceErrors = await settleLifecyclePhase(
        scoped.map((participant) => () => participant.quiesce()),
      );
      if (rollbackQuiesceErrors.length > 0) {
        closeSandboxExecutionBrokerAfterAuthorityFailure(broker);
        throw lifecycleAggregateError(
          "resume failed; rollback quiesce failed and broker was closed",
          scoped,
          [...resumeErrors, ...rollbackQuiesceErrors],
        );
      }
      const authorityRollbackErrors = await settleLifecyclePhase([
        () => authorityUpdate?.rollback(),
      ]);
      if (authorityRollbackErrors.length > 0) {
        closeSandboxExecutionBrokerAfterAuthorityFailure(broker);
        throw lifecycleAggregateError(
          "resume failed; authority rollback incomplete",
          scoped,
          [...resumeErrors, ...authorityRollbackErrors],
        );
      }
      const rollbackMutationPermit =
        broker.proveLifecycleParticipantsQuiesced(lifecycleFence);
      broker.applyAuthorityAfterLifecycleQuiesce(
        rollbackMutationPermit,
        previousAuthority,
      );
      const rollbackResumeErrors = await settleLifecycleResumePhase(
        broker,
        lifecycleFence,
        scoped,
        cwd,
      );
      if (rollbackResumeErrors.length > 0) {
        closeSandboxExecutionBrokerAfterAuthorityFailure(broker);
        throw lifecycleAggregateError(
          "resume failed; rollback resume failed and broker was closed",
          scoped,
          [...resumeErrors, ...rollbackResumeErrors],
        );
      }
      throw lifecycleAggregateError(
        "resume failed; transition rolled back",
        scoped,
        [...resumeErrors, ...rollbackResumeErrors],
      );
    },
  );
}

function runSerializedLifecycleOperation(
  broker: SandboxExecutionBrokerLike,
  phase: Exclude<SandboxExecutionLifecyclePhase, "idle" | "queued">,
  operation: (
    fence: SandboxExecutionLifecycleFence | undefined,
  ) => Promise<void>,
): Promise<void> {
  let coordinator = lifecycleCoordinators.get(broker);
  if (coordinator === undefined) {
    coordinator = {
      tail: Promise.resolve(),
      pending: 0,
      phase: "idle",
    };
    lifecycleCoordinators.set(broker, coordinator);
  }

  coordinator.pending += 1;
  if (coordinator.phase === "idle") coordinator.phase = "queued";
  const previous = coordinator.tail;
  const result = previous.then(async () => {
    coordinator.phase = phase;
    let fence: SandboxExecutionLifecycleFence | undefined;
    let operationFailed = false;
    let operationError: unknown;
    try {
      if (!(broker instanceof SandboxExecutionBroker)) {
        throw new Error(
          "sandbox lifecycle operations require a canonical execution broker",
        );
      }
      if (!broker.isClosedAfterLifecycleAuthorityFailure()) {
        fence = broker.beginLifecycleAuthorityTransition();
        try {
          await broker.waitForLifecycleOneShotDrain(fence);
        } catch (error) {
          closeSandboxExecutionBrokerAfterAuthorityFailure(broker);
          throw new AggregateError(
            [error],
            "sandbox workspace transition process drain failed and broker was closed",
            { cause: error },
          );
        }
      } else if (phase !== "disposal") {
        throw new Error(
          "sandbox execution broker is closed after an authority failure",
        );
      }
      await operation(fence);
    } catch (error) {
      operationFailed = true;
      operationError = error;
      throw error;
    } finally {
      let fenceReleaseError: unknown;
      try {
        if (fence !== undefined) {
          try {
            if (!(broker instanceof SandboxExecutionBroker)) {
              throw new Error(
                "sandbox lifecycle fence lost its canonical execution broker",
              );
            }
            broker.endLifecycleAuthorityTransition(fence);
          } catch (error) {
            closeSandboxExecutionBrokerAfterAuthorityFailure(broker);
            fenceReleaseError = error;
          }
        }
      } finally {
        coordinator.pending -= 1;
        coordinator.phase = coordinator.pending === 0 ? "idle" : "queued";
      }
      if (fenceReleaseError !== undefined) {
        const errors = operationFailed
          ? [operationError, fenceReleaseError]
          : [fenceReleaseError];
        const cause = operationFailed ? operationError : fenceReleaseError;
        throw new AggregateError(
          errors,
          "sandbox workspace transition fence release failed and broker was closed",
          cause === undefined ? undefined : { cause },
        );
      }
    }
  });
  coordinator.tail = result.then(
    () => {},
    () => {},
  );
  return result;
}

function requireLifecycleFence(
  fence: SandboxExecutionLifecycleFence | undefined,
): SandboxExecutionLifecycleFence {
  if (fence === undefined) {
    throw new Error("sandbox execution lifecycle fence is unavailable");
  }
  return fence;
}

function settleLifecycleResumePhase(
  broker: SandboxExecutionBrokerLike,
  fence: SandboxExecutionLifecycleFence,
  scoped: readonly SandboxExecutionLifecycleParticipant[],
  cwd: string,
): Promise<unknown[]> {
  if (!(broker instanceof SandboxExecutionBroker)) {
    return Promise.resolve([
      new Error(
        "sandbox lifecycle resume requires a canonical execution broker",
      ),
    ]);
  }
  broker.invalidateLifecycleParticipantsQuiesced(fence);
  return settleLifecyclePhase(
    scoped.map(
      (participant) => () =>
        broker.runWithLifecycleParticipantSpawnPermit(
          fence,
          participant.name,
          () => participant.resume(cwd),
        ),
    ),
  );
}

function closeSandboxExecutionBrokerAfterAuthorityFailure(
  broker: SandboxExecutionBrokerLike,
): void {
  if (broker instanceof SandboxExecutionBroker) {
    broker.closeAfterLifecycleAuthorityFailure(
      "sandbox runtime authority rollback was incomplete",
    );
  }
  disposedBrokers.add(broker);
}

async function settleLifecyclePhase(
  operations: readonly (() => Promise<void> | void)[],
): Promise<unknown[]> {
  const results = await Promise.allSettled(
    operations.map((operation) => Promise.resolve().then(operation)),
  );
  return results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
}

function lifecycleAggregateError(
  outcome: string,
  scoped: readonly SandboxExecutionLifecycleParticipant[],
  errors: readonly unknown[],
): AggregateError {
  const names = scoped.map((participant) => participant.name).join(", ");
  return new AggregateError(
    errors,
    `sandbox workspace transition ${outcome}` +
      (names.length > 0 ? ` (${names})` : ""),
  );
}
