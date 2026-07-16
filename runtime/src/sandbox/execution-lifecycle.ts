import type { SandboxExecutionBrokerLike } from "./execution-broker.js";

export interface SandboxExecutionLifecycleParticipant {
  readonly name: string;
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
const disposedBrokers = new WeakSet<SandboxExecutionBrokerLike>();
const disposalPromises = new WeakMap<
  SandboxExecutionBrokerLike,
  Promise<void>
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
  const scoped = participants.get(broker) ?? new Set();
  scoped.add(participant);
  participants.set(broker, scoped);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    scoped.delete(participant);
    if (scoped.size === 0) participants.delete(broker);
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
 */
export function disposeSandboxExecutionBroker(
  broker: SandboxExecutionBrokerLike,
): Promise<void> {
  const existing = disposalPromises.get(broker);
  if (existing !== undefined) return existing;

  disposedBrokers.add(broker);
  const scoped = [...(participants.get(broker) ?? [])].reverse();
  participants.delete(broker);
  const disposal = (async () => {
    const errors: unknown[] = [];
    for (const participant of scoped) {
      try {
        if (participant.dispose !== undefined) {
          await participant.dispose();
        } else {
          await participant.quiesce();
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw lifecycleAggregateError(
        "disposal failed; broker remains closed",
        scoped,
        errors,
      );
    }
  })();
  disposalPromises.set(broker, disposal);
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
  if (broker.cwd === cwd) return;
  const previousCwd = broker.cwd;
  const scoped = [...(participants.get(broker) ?? [])];
  const quiesceErrors = await settleLifecyclePhase(
    scoped.map((participant) => participant.quiesce()),
  );
  if (quiesceErrors.length > 0) {
    // Some participants may already be stopped. Re-arm all of them at the
    // unchanged authority before reporting failure so a partial quiesce does
    // not leave the session silently degraded.
    const recoveryErrors = await settleLifecyclePhase(
      scoped.map((participant) => participant.resume(previousCwd)),
    );
    throw lifecycleAggregateError(
      "quiesce failed; old authority restored",
      scoped,
      [...quiesceErrors, ...recoveryErrors],
    );
  }
  broker.rebase(cwd);
  const resumeErrors = await settleLifecyclePhase(
    scoped.map((participant) => participant.resume(cwd)),
  );
  if (resumeErrors.length === 0) return;

  const rollbackQuiesceErrors = await settleLifecyclePhase(
    scoped.map((participant) => participant.quiesce()),
  );
  broker.rebase(previousCwd);
  const rollbackResumeErrors = await settleLifecyclePhase(
    scoped.map((participant) => participant.resume(previousCwd)),
  );
  throw lifecycleAggregateError(
    "resume failed; transition rolled back",
    scoped,
    [...resumeErrors, ...rollbackQuiesceErrors, ...rollbackResumeErrors],
  );
}

async function settleLifecyclePhase(
  operations: readonly Promise<void>[],
): Promise<unknown[]> {
  const results = await Promise.allSettled(operations);
  return results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
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
