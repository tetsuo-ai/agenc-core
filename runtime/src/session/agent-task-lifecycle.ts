/**
 * Agent task registration lifecycle.
 *
 * AgenC-specific session layer over the low-level agent-task
 * registration primitive that upstream codex runtime exposes in
 * `codex-rs/agent-identity/src/lib.rs::register_agent_task` (the
 * HTTP call that mints a `task_id` for a given agent runtime).
 * Upstream codex runtime caches a single `task_id` per process in
 * `AgentIdentityAuth::ensure_runtime`
 * (`codex-rs/login/src/auth/agent_identity.rs::ensure_runtime`) via a
 * `OnceCell`. No session-scoped cache, rollout persistence, identity
 * rotation handling, or double-checked registration lock exists in the
 * current codex runtime tree; this module is the AgenC extension that adds
 * those. Each helper takes `session: Session` as its first argument.
 *
 * The only function in this module with a direct upstream port is
 * `recordInitialHistoryOnResume`, which mirrors the
 * `InitialHistory::Resumed` arm of
 * `codex-rs/core/src/session/mod.rs::record_initial_history`
 * (model-change warning and token-info seed). See that function's
 * docstring for exact line references.
 *
 * Integrations that land in later tranches:
 *   - T6 (event log / rollout) wires `persistRolloutItems` with the
 *     real rollout recorder.
 *
 * For T5 the forward-dep services return safe defaults so typechecking
 * succeeds end-to-end.
 *
 * @module
 */

import type { Session } from "./session.js";
import type { RolloutItem } from "./rollout-item.js";
import type { TokenCountEvent } from "./event-log.js";

export type { RolloutItem, SessionStateUpdate } from "./rollout-item.js";

// ─────────────────────────────────────────────────────────────────────
// Forward-dep types — real impls in T9 (agent_identity).
// ─────────────────────────────────────────────────────────────────────

/**
 * AgenC-specific in-memory shape for a task registered with the
 * identity-binding service. Upstream codex runtime does not define an
 * equivalent struct: `codex-rs/agent-identity/src/lib.rs::register_agent_task`
 * returns only a `task_id: String`, and the surrounding agent runtime id
 * and registration timestamp live outside that return value. AgenC
 * groups them together so the session-scoped cache and rollout
 * persistence path have a single value to pass around.
 */
export interface RegisteredAgentTask {
  readonly agentRuntimeId: string;
  readonly taskId: string;
  readonly registeredAt: string;
}

/**
 * AgenC-specific wire representation of a RegisteredAgentTask used in
 * `RolloutItem::SessionState(update)` persistence. Upstream codex runtime has
 * no equivalent struct in `codex runtime-protocol` or elsewhere in the current
 * tree. Shape is kept identical to `RegisteredAgentTask` to keep the
 * conversion helpers below trivial.
 */
export interface SessionAgentTask {
  readonly agentRuntimeId: string;
  readonly taskId: string;
  readonly registeredAt: string;
}

// ─────────────────────────────────────────────────────────────────────
// Conversion helpers — AgenC-specific. Trivial field-for-field copies
// between the in-memory and on-rollout shapes.
// ─────────────────────────────────────────────────────────────────────

export function registeredAgentTaskFromSessionAgentTask(
  t: SessionAgentTask,
): RegisteredAgentTask {
  return {
    agentRuntimeId: t.agentRuntimeId,
    taskId: t.taskId,
    registeredAt: t.registeredAt,
  };
}

export function registeredAgentTaskToSessionAgentTask(
  t: RegisteredAgentTask,
): SessionAgentTask {
  return {
    agentRuntimeId: t.agentRuntimeId,
    taskId: t.taskId,
    registeredAt: t.registeredAt,
  };
}

function sessionAgentTaskEquals(
  a: SessionAgentTask | undefined,
  b: SessionAgentTask | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.agentRuntimeId === b.agentRuntimeId &&
    a.taskId === b.taskId &&
    a.registeredAt === b.registeredAt
  );
}

// ─────────────────────────────────────────────────────────────────────
// Session-state accessors — use AsyncLock<SessionState> so we can
// surgically read/write the embedded `agentTask` slot without exposing
// the whole state type to callers of this module.
// ─────────────────────────────────────────────────────────────────────

/**
 * Augment SessionState with an optional agent task. The existing
 * SessionState shape in session.ts uses `unknown[]` history; this
 * module owns the `agentTask` slot.
 */
interface SessionStateWithAgentTask {
  agentTask?: SessionAgentTask;
}

async function readAgentTask(session: Session): Promise<SessionAgentTask | undefined> {
  return session.state.with((s) => (s as unknown as SessionStateWithAgentTask).agentTask);
}

async function setAgentTask(session: Session, task: SessionAgentTask): Promise<void> {
  await session.state.with((s) => {
    (s as unknown as SessionStateWithAgentTask).agentTask = task;
  });
}

async function clearAgentTask(session: Session): Promise<void> {
  await session.state.with((s) => {
    (s as unknown as SessionStateWithAgentTask).agentTask = undefined;
  });
}

// ─────────────────────────────────────────────────────────────────────
// Identity-manager forward-dep protocol — structural shape the real
// AgentIdentityManager must satisfy. Accessed via session.services.
// ─────────────────────────────────────────────────────────────────────

interface AgentIdentityManagerProto {
  taskMatchesCurrentIdentity?: (
    task: RegisteredAgentTask,
  ) => Promise<boolean>;
  registerTask?: () => Promise<RegisteredAgentTask | null>;
}

function identityManager(session: Session): AgentIdentityManagerProto {
  return session.services.agentIdentityManager as unknown as AgentIdentityManagerProto;
}

// ─────────────────────────────────────────────────────────────────────
// Rollout persistence forward-dep. T6 wires real recorder.
// ─────────────────────────────────────────────────────────────────────

async function persistRolloutItems(
  session: Session,
  items: ReadonlyArray<RolloutItem>,
): Promise<void> {
  const rollout = session.services.rollout;
  if (!rollout) return;
  for (const item of items) {
    await rollout.record(item);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Session-scoped task-registration lifecycle — AgenC-specific.
// Upstream codex runtime keeps only a process-wide `OnceCell<String>` cache in
// `AgentIdentityAuth::ensure_runtime`
// (`codex-rs/login/src/auth/agent_identity.rs::ensure_runtime`) and
// makes no attempt to invalidate on identity rotation, persist the
// registration, or double-check a session-scoped cache. The helpers
// below are the AgenC additions that wrap the same underlying HTTP
// primitive with session-aware bookkeeping.
// ─────────────────────────────────────────────────────────────────────

/**
 * AgenC-specific. Startup task registration is best-effort: regular
 * turns retry on demand, and a prewarm failure should not shut down the
 * session. codex runtime's equivalent startup path is `ensure_runtime`
 * (`codex-rs/login/src/auth/agent_identity.rs`), which has no
 * swallow-and-continue wrapper because it runs from the async auth
 * handshake, not the session boot.
 */
export async function maybePrewarmAgentTaskRegistration(
  session: Session,
): Promise<void> {
  try {
    await ensureAgentTaskRegistered(session);
  } catch (error) {
    // AgenC-specific: prewarm failures are intentionally swallowed so
    // that regular turns can retry registration on demand.
    void error;
  }
}

/**
 * AgenC-specific. Walks rollout items in reverse and returns the
 * `SessionAgentTask | undefined` from the most recent `SessionState`
 * update, wrapped in a `{ value }` envelope so callers can distinguish
 * "no SessionState ever persisted" (returns `undefined`) from
 * "SessionState persisted with the slot explicitly cleared" (returns
 * `{ value: undefined }`). Upstream codex runtime does not persist an
 * agent-task slot on rollout, so there is no equivalent walker.
 */
export function latestPersistedAgentTask(
  rolloutItems: ReadonlyArray<RolloutItem>,
): { value: SessionAgentTask | undefined } | undefined {
  for (let i = rolloutItems.length - 1; i >= 0; i -= 1) {
    const item = rolloutItems[i];
    if (item && item.type === "session_state") {
      return { value: item.payload.agentTask };
    }
  }
  return undefined;
}

/**
 * AgenC-specific. If the most recent persisted `SessionState` has an
 * agent task, validate it against the current identity and either keep
 * it (on match) or clear the cached task (on mismatch). Upstream codex runtime
 * has no persisted agent-task restore path; on process restart it
 * simply re-registers a fresh task through `ensure_runtime`.
 */
export async function restorePersistedAgentTask(
  session: Session,
  rolloutItems: ReadonlyArray<RolloutItem>,
): Promise<void> {
  const found = latestPersistedAgentTask(rolloutItems);
  if (found === undefined) return;

  const agentTaskUpdate = found.value;
  if (agentTaskUpdate !== undefined) {
    const registeredTask = registeredAgentTaskFromSessionAgentTask(agentTaskUpdate);
    const matches =
      (await identityManager(session).taskMatchesCurrentIdentity?.(registeredTask)) ?? false;
    if (matches) {
      await setAgentTask(session, agentTaskUpdate);
    } else {
      // AgenC-specific: drop the persisted task when it no longer
      // matches the currently bound agent identity.
      await clearAgentTask(session);
    }
  } else {
    await clearAgentTask(session);
  }
}

/**
 * codex runtime `Session::last_token_info_from_rollout`
 * (session/mod.rs:1257-1262). Walks rollout items in reverse and
 * returns the most recent `token_count` event payload. Returns
 * `undefined` if no token_count event was ever persisted.
 *
 * AgenC stores token usage in the `TokenCountEvent` payload; codex runtime
 * uses `TokenUsageInfo` directly. The field set is equivalent.
 */
export function lastTokenInfoFromRollout(
  rolloutItems: ReadonlyArray<RolloutItem>,
): TokenCountEvent | undefined {
  for (let i = rolloutItems.length - 1; i >= 0; i -= 1) {
    const item = rolloutItems[i];
    if (!item || item.type !== "event_msg") continue;
    const inner = item.payload.msg;
    if ((inner as { type?: string }).type !== "token_count") continue;
    const payload = (inner as { payload?: TokenCountEvent }).payload;
    if (payload !== undefined) return payload;
  }
  return undefined;
}

/**
 * Port of the `InitialHistory::Resumed` arm of codex runtime
 * `Session::record_initial_history`
 * (`codex-rs/core/src/session/mod.rs::record_initial_history`,
 * function at lines 1151-1236; the Resumed arm runs roughly
 * 1172-1209).
 *
 * Three resume-time behaviors are wired here so the AgenC bootstrap
 * has a single entrypoint for them:
 *
 *   1. **Agent-task restore.** Delegates to `restorePersistedAgentTask`.
 *      AgenC-specific: no equivalent exists in codex runtime because codex runtime does
 *      not persist the agent task to the rollout. Runs first so the
 *      cached task is consistent with the post-replay session identity
 *      before any model-dependent state mutations.
 *   2. **Model-change warning.** codex runtime emits
 *      `EventMsg::Warning(WarningEvent { ... })` at
 *      `session/mod.rs:1185-1196` when the rollout's last
 *      `turn_context.model` differs from the session's active model.
 *      The warning wording mirrors codex runtime's English sentence; "codex runtime" is
 *      swapped for "AgenC".
 *   3. **Token-info seed.** Sets `initialTokenUsage` on session state
 *      from the last persisted `token_count` event so UIs display
 *      cumulative usage immediately after resume. Mirrors
 *      `session/mod.rs:1200-1203`.
 *
 * Callers (bootstrap.ts resume branch) pass the rollout items read
 * from the JSONL file plus the already-computed `previousTurnSettings`
 * from `reconstructFromRollout` so we do not re-walk the rollout
 * needlessly. `currentModel` is the model the session is booting with
 * (the model actually going to run the next turn). When these differ
 * a warning is emitted via `session.emit`.
 */
export async function recordInitialHistoryOnResume(
  session: Session,
  rolloutItems: ReadonlyArray<RolloutItem>,
  opts: {
    readonly previousModel?: string;
    readonly currentModel: string;
  },
): Promise<void> {
  // 1. Agent-task restore. AgenC-specific (no upstream equivalent);
  // run first so the cached task lines up with the restored session
  // identity before any model-dependent state mutations.
  await restorePersistedAgentTask(session, rolloutItems);

  // 2. Model-change warning. Matches codex runtime's sentence at
  // session/mod.rs:1189-1192 with "codex runtime" → "AgenC".
  if (
    opts.previousModel !== undefined &&
    opts.previousModel !== opts.currentModel
  ) {
    const prev = opts.previousModel;
    const curr = opts.currentModel;
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "warning",
        payload: {
          cause: "resumed_with_different_model",
          message: `This session was recorded with model \`${prev}\` but is resuming with \`${curr}\`. Consider switching back to \`${prev}\` as it may affect AgenC performance.`,
        },
      },
    });
  }

  // 3. Seed token_info so downstream UIs see persisted usage. Mirrors
  // codex runtime session/mod.rs:1200-1203.
  const info = lastTokenInfoFromRollout(rolloutItems);
  if (info !== undefined) {
    await session.state.with((s) => {
      (s as unknown as { initialTokenUsage?: TokenCountEvent }).initialTokenUsage =
        info;
    });
  }
}

/**
 * AgenC-specific. Persist a `SessionState` rollout item carrying the
 * current agent-task cache value (or an explicit clear when `agentTask`
 * is null). Upstream codex runtime does not persist this slot.
 */
async function persistAgentTaskUpdate(
  session: Session,
  agentTask: RegisteredAgentTask | null,
): Promise<void> {
  await persistRolloutItems(session, [
    {
      type: "session_state",
      payload: {
        agentTask: agentTask === null ? undefined : registeredAgentTaskToSessionAgentTask(agentTask),
      },
    },
  ]);
}

/**
 * AgenC-specific. Clear the cached task only if it still matches the
 * passed-in task, which avoids clobbering a task another flow wrote
 * concurrently. Upstream codex runtime has no session-scoped cache to clear.
 */
async function clearCachedAgentTask(
  session: Session,
  agentTask: RegisteredAgentTask,
): Promise<void> {
  const cleared = await session.state.with((s) => {
    const state = s as unknown as SessionStateWithAgentTask;
    if (sessionAgentTaskEquals(state.agentTask, registeredAgentTaskToSessionAgentTask(agentTask))) {
      state.agentTask = undefined;
      return true;
    }
    return false;
  });

  if (cleared) {
    await persistAgentTaskUpdate(session, null);
  }
}

/**
 * AgenC-specific. Write the task into session state if it differs from
 * the current cached value, then persist the update to the rollout.
 * Upstream codex runtime stores only a `OnceCell<String>` per process
 * (`codex-rs/login/src/auth/agent_identity.rs::ensure_runtime`) and
 * never rewrites or persists it.
 */
async function cacheAgentTask(
  session: Session,
  agentTask: RegisteredAgentTask,
): Promise<RegisteredAgentTask> {
  const sessionAgentTask = registeredAgentTaskToSessionAgentTask(agentTask);
  const changed = await session.state.with((s) => {
    const state = s as unknown as SessionStateWithAgentTask;
    if (sessionAgentTaskEquals(state.agentTask, sessionAgentTask)) {
      return false;
    }
    state.agentTask = sessionAgentTask;
    return true;
  });

  if (changed) {
    await persistAgentTaskUpdate(session, agentTask);
  }
  return agentTask;
}

/**
 * AgenC-specific. Returns the cached task iff it still matches the
 * current agent identity; on mismatch, clears the cached value and
 * returns undefined. Upstream codex runtime does no per-call identity match
 * check against its `OnceCell<String>` task cache.
 */
export async function cachedAgentTaskForCurrentIdentity(
  session: Session,
): Promise<RegisteredAgentTask | undefined> {
  const stored = await readAgentTask(session);
  if (stored === undefined) return undefined;
  const agentTask = registeredAgentTaskFromSessionAgentTask(stored);

  const matches =
    (await identityManager(session).taskMatchesCurrentIdentity?.(agentTask)) ?? false;
  if (matches) {
    return agentTask;
  }

  await clearCachedAgentTask(session, agentTask);
  return undefined;
}

/**
 * AgenC-specific session-scoped wrapper around the codex runtime low-level
 * registration primitive `register_agent_task`
 * (`codex-rs/agent-identity/src/lib.rs`, pub fn at line 109). codex runtime's
 * only caller, `AgentIdentityAuth::ensure_runtime`
 * (`codex-rs/login/src/auth/agent_identity.rs::ensure_runtime`), just
 * memoizes the returned task id in a `OnceCell<String>` and never
 * retries, re-validates, or double-checks.
 *
 * AgenC adds:
 *   - fast-path return of the session-scoped cached task;
 *   - a registration lock + double-check so concurrent turns do not
 *     race-register duplicate tasks;
 *   - up-to-two retry if the identity manager returns a task that no
 *     longer matches current identity (covers a mid-registration
 *     identity rotation);
 *   - `undefined` return when the feature is disabled or auth binding
 *     is unavailable.
 *
 * Throws on registration failure; callers decide whether to
 * log-and-continue (see `maybePrewarmAgentTaskRegistration`).
 */
export async function ensureAgentTaskRegistered(
  session: Session,
): Promise<RegisteredAgentTask | undefined> {
  const cached = await cachedAgentTaskForCurrentIdentity(session);
  if (cached !== undefined) return cached;

  return session.agentTaskRegistrationLock.with(async () => {
    const doubleCheck = await cachedAgentTaskForCurrentIdentity(session);
    if (doubleCheck !== undefined) return doubleCheck;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const registered = await identityManager(session).registerTask?.();
      if (!registered) return undefined;

      const matches =
        (await identityManager(session).taskMatchesCurrentIdentity?.(registered)) ?? false;
      if (!matches) {
        // AgenC-specific: a registration that lost the race with an
        // identity rotation is discarded and retried once.
        continue;
      }

      const cached2 = await cacheAgentTask(session, registered);
      return cached2;
    }

    return undefined;
  });
}
