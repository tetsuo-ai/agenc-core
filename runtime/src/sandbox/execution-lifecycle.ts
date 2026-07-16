import type { SandboxExecutionBrokerLike } from "./execution-broker.js";

export interface SandboxExecutionLifecycleParticipant {
  readonly name: string;
  /** Stop every child that was created under the broker's current cwd. */
  quiesce(): Promise<void>;
  /** Re-arm the service after the broker has moved; lazy services may no-op. */
  resume(cwd: string): Promise<void>;
}

const participants = new WeakMap<
  SandboxExecutionBrokerLike,
  Set<SandboxExecutionLifecycleParticipant>
>();

export function registerSandboxExecutionLifecycleParticipant(
  broker: SandboxExecutionBrokerLike,
  participant: SandboxExecutionLifecycleParticipant,
): () => void {
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

/**
 * Move a live broker only after every process created under its old authority
 * has stopped. A failed resume is rolled back: new-authority children are
 * quiesced, the old cwd is restored, and participants are resumed there.
 */
export async function transitionSandboxExecutionBroker(
  broker: SandboxExecutionBrokerLike,
  cwd: string,
): Promise<void> {
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
