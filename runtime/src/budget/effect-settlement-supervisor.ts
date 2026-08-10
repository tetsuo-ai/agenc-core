import type { ToolRecoveryCategory } from "../tools/types.js";

export const DEFAULT_EFFECT_SETTLEMENT_DRAIN_MS = 2_000;

export interface LiveEffectIdentity {
  readonly runId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly recoveryCategory: ToolRecoveryCategory;
  readonly idempotencyKey?: string;
}

export interface EffectSettlementMetrics {
  readonly callerTimeouts: number;
  readonly callerAborts: number;
  readonly heldAccounting: number;
  readonly unknownEffects: number;
  readonly durabilityPersistenceFailures: number;
  readonly occupiedPostTimeoutLeases: number;
  readonly lateReviewResolutions: number;
}

interface MutableEffectSettlementMetrics {
  callerTimeouts: number;
  callerAborts: number;
  heldAccounting: number;
  unknownEffects: number;
  durabilityPersistenceFailures: number;
  occupiedPostTimeoutLeases: number;
  lateReviewResolutions: number;
}

interface SupervisedSession {
  trackDurableOperation?<T>(operation: Promise<T>): Promise<T>;
}

type SettlementOutcome<T> =
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly kind: "rejected"; readonly reason: unknown };

export type IdempotentRendezvousOutcome<T> =
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly kind: "rejected"; readonly reason: unknown }
  | { readonly kind: "forced_shutdown" }
  | { readonly kind: "observer_failed"; readonly reason: unknown };

interface ActiveObserver {
  readonly identity: LiveEffectIdentity;
  readonly done: Promise<void>;
  force(): void;
}

interface SupervisorState {
  accepting: boolean;
  readonly active: Map<string, ActiveObserver>;
  readonly rendezvous: Map<
    string,
    Promise<IdempotentRendezvousOutcome<unknown>>
  >;
  readonly poisoned: Map<string, LiveEffectIdentity>;
  readonly externallyResolved: Set<string>;
  readonly metrics: MutableEffectSettlementMetrics;
}

const SUPERVISORS = new WeakMap<object, SupervisorState>();

export class LiveEffectMutationBlockedError extends Error {
  readonly code = "UNKNOWN_OUTCOME_MUTATION_BLOCKED" as const;

  constructor(readonly blocking: readonly LiveEffectIdentity[]) {
    // Name the way out. This message is what the model sees, and without the
    // remediation it concludes the session is unrecoverable and tells the user
    // to restart the chat — observed verbatim on a live hardware session that
    // then lost its whole working context. `/resolve` clears the gate through
    // the running daemon; the operator never needed a new session.
    super(
      `live effect settlement is unresolved for ${blocking
        .map((effect) => `${effect.callId} (${effect.toolName})`)
        .join(", ")}; side-effecting and interactive dispatch remain blocked. ` +
        `This is recoverable without restarting: run ` +
        `\`/resolve ${blocking[0]?.callId ?? "<call-id>"} ` +
        `<confirmed_committed|confirmed_no_effect|remains_unknown> ` +
        `<evidence-ref> <evidence-sha256>\` to review the unknown outcome and ` +
        `unblock the session.`,
    );
    this.name = "LiveEffectMutationBlockedError";
  }
}

export function assertNoLiveUnknownEffect(
  session: object,
  recoveryCategory: ToolRecoveryCategory,
): void {
  if (recoveryCategory === "idempotent") return;
  const blocking = [...stateFor(session).poisoned.values()];
  if (blocking.length > 0) throw new LiveEffectMutationBlockedError(blocking);
}

export function poisonLiveEffect(
  session: object,
  identity: LiveEffectIdentity,
): void {
  const state = stateFor(session);
  const key = effectKey(identity);
  if (!state.poisoned.has(key)) {
    state.poisoned.set(key, identity);
    state.metrics.unknownEffects += 1;
  }
}

export function clearLiveEffectPoison(
  session: object,
  identity: LiveEffectIdentity,
): void {
  stateFor(session).poisoned.delete(effectKey(identity));
}

export function readIdempotentRendezvous<T>(
  session: object,
  idempotencyKey: string,
): Promise<IdempotentRendezvousOutcome<T>> | undefined {
  return stateFor(session).rendezvous.get(idempotencyKey) as
    Promise<IdempotentRendezvousOutcome<T>> | undefined;
}

export function resolveLiveEffectPoison(
  session: object,
  options: {
    readonly callId: string;
    readonly runId?: string;
    readonly stepId?: string;
  },
): number {
  const state = stateFor(session);
  const identities = new Map<string, LiveEffectIdentity>();
  const activeKeys = new Set<string>();
  for (const identity of state.poisoned.values()) {
    identities.set(effectKey(identity), identity);
  }
  for (const observer of state.active.values()) {
    const key = effectKey(observer.identity);
    activeKeys.add(key);
    identities.set(key, observer.identity);
  }
  let resolved = 0;
  for (const [key, identity] of identities) {
    if (
      identity.callId !== options.callId ||
      (options.runId !== undefined && identity.runId !== options.runId) ||
      (options.stepId !== undefined && identity.stepId !== options.stepId)
    ) {
      continue;
    }
    state.poisoned.delete(key);
    if (activeKeys.has(key)) state.externallyResolved.add(key);
    resolved += 1;
  }
  return resolved;
}

export function liveEffectWasExternallyResolved(
  session: object,
  identity: LiveEffectIdentity,
): boolean {
  return stateFor(session).externallyResolved.has(effectKey(identity));
}

export function incrementEffectSettlementMetric(
  session: object,
  metric: Exclude<
    keyof MutableEffectSettlementMetrics,
    "occupiedPostTimeoutLeases"
  >,
): void {
  stateFor(session).metrics[metric] += 1;
}

export function effectSettlementMetrics(
  session: object,
): EffectSettlementMetrics {
  return { ...stateFor(session).metrics };
}

export function registerEffectSettlementObserver<T>(
  session: SupervisedSession & object,
  options: {
    readonly identity: LiveEffectIdentity;
    readonly settlement: Promise<T>;
    /**
     * Runs on the next event-loop turn, after the stopped caller can observe its
     * typed timeout/abort. Physical settlement is not processed until this
     * preparation succeeds or supervised shutdown forces the observer.
     */
    readonly beforeSettlement?: (signal: AbortSignal) => void | Promise<void>;
    readonly onSettled: (outcome: SettlementOutcome<T>) => void | Promise<void>;
    readonly onForcedShutdown: () => void | Promise<void>;
  },
): Promise<void> {
  const state = stateFor(session);
  if (!state.accepting) {
    const forced = deferToNextEventLoopTurn().then(options.onForcedShutdown);
    session.trackDurableOperation?.(forced);
    return forced;
  }
  const key = effectKey(options.identity);
  if (state.active.has(key)) {
    throw new Error(`effect settlement observer already owns ${key}`);
  }

  let force!: () => void;
  const preparationController = new AbortController();
  const forced = new Promise<"forced">((resolve) => {
    force = () => {
      if (!preparationController.signal.aborted) {
        preparationController.abort(
          "effect settlement supervisor forced shutdown",
        );
      }
      resolve("forced");
    };
  });
  const physical = options.settlement.then<
    SettlementOutcome<T>,
    SettlementOutcome<T>
  >(
    (value) => ({ kind: "fulfilled", value }),
    (reason) => ({ kind: "rejected", reason }),
  );
  const prepared =
    options.beforeSettlement === undefined
      ? Promise.resolve()
      : deferToNextEventLoopTurn().then(() =>
          options.beforeSettlement!(preparationController.signal),
        );
  const preparedPhysical = Promise.all([prepared, physical]).then(
    ([, outcome]) => outcome,
  );
  state.metrics.occupiedPostTimeoutLeases += 1;
  let processedOutcome:
    SettlementOutcome<T> | { readonly kind: "forced_shutdown" } | undefined;
  let rendezvous!: Promise<IdempotentRendezvousOutcome<T>>;
  const done = (async (): Promise<void> => {
    try {
      const outcome = await Promise.race([preparedPhysical, forced]);
      if (outcome === "forced") {
        await options.onForcedShutdown();
        processedOutcome = { kind: "forced_shutdown" };
      } else {
        await options.onSettled(outcome);
        processedOutcome = outcome;
      }
    } finally {
      state.active.delete(key);
      state.metrics.occupiedPostTimeoutLeases = Math.max(
        0,
        state.metrics.occupiedPostTimeoutLeases - 1,
      );
      if (options.identity.idempotencyKey !== undefined) {
        const current = state.rendezvous.get(options.identity.idempotencyKey);
        if (current === rendezvous) {
          state.rendezvous.delete(options.identity.idempotencyKey);
        }
      }
      state.externallyResolved.delete(key);
    }
  })();
  rendezvous = done.then<
    IdempotentRendezvousOutcome<T>,
    IdempotentRendezvousOutcome<T>
  >(
    () => {
      if (processedOutcome === undefined) {
        return {
          kind: "observer_failed",
          reason: new Error("effect settlement observer produced no outcome"),
        };
      }
      if (processedOutcome.kind === "forced_shutdown") {
        return processedOutcome;
      }
      return processedOutcome.kind === "fulfilled"
        ? { kind: "fulfilled", value: processedOutcome.value }
        : { kind: "rejected", reason: processedOutcome.reason };
    },
    (reason) => ({ kind: "observer_failed", reason }),
  );
  const observer: ActiveObserver = { identity: options.identity, done, force };
  state.active.set(key, observer);
  if (options.identity.idempotencyKey !== undefined) {
    state.rendezvous.set(options.identity.idempotencyKey, rendezvous);
  }
  session.trackDurableOperation?.(done);
  return done;
}

export async function shutdownEffectSettlementSupervisor(
  session: object,
  drainMs = DEFAULT_EFFECT_SETTLEMENT_DRAIN_MS,
): Promise<void> {
  const state = stateFor(session);
  state.accepting = false;
  if (state.active.size === 0) return;
  if (!Number.isSafeInteger(drainMs) || drainMs < 0) {
    throw new TypeError(
      "effect settlement drainMs must be a non-negative integer",
    );
  }
  const observers = [...state.active.values()];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = Promise.allSettled(
    observers.map((observer) => observer.done),
  );
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), drainMs);
  });
  const outcome = await Promise.race([
    drained.then(() => "drained" as const),
    timeout,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome === "timeout") {
    for (const observer of observers) observer.force();
  }
  const final = await Promise.allSettled(
    observers.map((observer) => observer.done),
  );
  const failures = final.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "effect settlement shutdown failed");
  }
}

function stateFor(session: object): SupervisorState {
  const current = SUPERVISORS.get(session);
  if (current !== undefined) return current;
  const created: SupervisorState = {
    accepting: true,
    active: new Map(),
    rendezvous: new Map(),
    poisoned: new Map(),
    externallyResolved: new Set(),
    metrics: {
      callerTimeouts: 0,
      callerAborts: 0,
      heldAccounting: 0,
      unknownEffects: 0,
      durabilityPersistenceFailures: 0,
      occupiedPostTimeoutLeases: 0,
      lateReviewResolutions: 0,
    },
  };
  SUPERVISORS.set(session, created);
  return created;
}

function effectKey(identity: LiveEffectIdentity): string {
  return `${identity.runId}\0${identity.stepId}\0${identity.callId}`;
}

function deferToNextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
