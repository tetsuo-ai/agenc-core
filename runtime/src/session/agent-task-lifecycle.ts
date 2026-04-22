/**
 * Agent task registration lifecycle.
 *
 * Hand-port of codex `core/src/session/agent_task_lifecycle.rs` (182 LOC).
 * The Rust file is an additional `impl Session` block that holds the
 * task-registration bookkeeping separate from the Session struct
 * definition in `session.rs`. In TypeScript we mirror that separation
 * by putting the helpers in a dedicated module; each helper takes
 * `session: Session` as its first argument.
 *
 * Integrations that land in later tranches:
 *   - T6 (event log / rollout) wires `persistRolloutItems` with the
 *     real rollout recorder.
 *
 * For T5 the implementation is structurally faithful: the control flow
 * mirrors Rust line-for-line, and the forward-dep services return
 * safe defaults so typechecking succeeds end-to-end.
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
 * Codex `RegisteredAgentTask` (agent_identity/task_registration.rs:19).
 * Three string fields identifying a task registered with the
 * identity-binding service.
 */
export interface RegisteredAgentTask {
  readonly agentRuntimeId: string;
  readonly taskId: string;
  readonly registeredAt: string;
}

/**
 * Codex `SessionAgentTask` (codex-protocol). Wire representation of a
 * RegisteredAgentTask used in RolloutItem::SessionState(update).
 */
export interface SessionAgentTask {
  readonly agentRuntimeId: string;
  readonly taskId: string;
  readonly registeredAt: string;
}

// ─────────────────────────────────────────────────────────────────────
// Conversion helpers — mirror codex `RegisteredAgentTask::{from,to}_session_agent_task`.
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
// Ported methods — line-for-line mirror of Rust impl block.
// Each exported function corresponds to one Rust fn.
// ─────────────────────────────────────────────────────────────────────

/**
 * codex `Session::maybe_prewarm_agent_task_registration` (agent_task_lifecycle.rs:11-20).
 * Startup task registration is best-effort: regular turns retry on
 * demand, and a prewarm failure should not shut down the session.
 */
export async function maybePrewarmAgentTaskRegistration(
  session: Session,
): Promise<void> {
  try {
    await ensureAgentTaskRegistered(session);
  } catch (error) {
    // Mirror codex `warn!("startup agent task prewarm failed; regular turns will retry registration")`
    void error;
  }
}

/**
 * codex `Session::latest_persisted_agent_task` (agent_task_lifecycle.rs:22-29).
 * Walk rollout items in reverse, return the `Option<SessionAgentTask>`
 * from the most recent `SessionState` update (or `None` if none).
 *
 * Returns `undefined` if no SessionState was ever persisted, or the
 * stored value (which may itself be `undefined` meaning "explicitly
 * cleared"). Mirrors Rust's `Option<Option<SessionAgentTask>>`.
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
 * codex `Session::restore_persisted_agent_task` (agent_task_lifecycle.rs:31-63).
 * If the most recent persisted SessionState has an agent task, validate
 * it against the current identity and either keep it (on match) or
 * clear the cached task (on mismatch).
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
      // Mirror codex `debug!("discarding persisted agent task because it does not match the registered agent identity")`
      await clearAgentTask(session);
    }
  } else {
    await clearAgentTask(session);
  }
}

/**
 * Codex `Session::last_token_info_from_rollout`
 * (session/mod.rs:1257-1262). Walks rollout items in reverse and
 * returns the most recent `token_count` event payload. Returns
 * `undefined` if no token_count event was ever persisted.
 *
 * AgenC stores token usage in the `TokenCountEvent` payload; codex
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
 * Port of codex `Session::record_initial_history` resume branch
 * (session/mod.rs:1150-1236 — the `InitialHistory::Resumed` arm).
 *
 * Three resume-time behaviors are wired here so the AgenC bootstrap
 * has a single entrypoint for them:
 *
 *   1. **Agent-task restore.** Delegates to `restorePersistedAgentTask`
 *      so the cached task matches the post-replay session identity.
 *   2. **Model-change warning.** Codex emits
 *      `EventMsg::Warning(WarningEvent { ... })` (session/mod.rs:1186-1195)
 *      when the rollout's last `turn_context.model` differs from the
 *      session's active model. The warning wording mirrors codex's
 *      English sentence; "Codex" is swapped for "AgenC".
 *   3. **Token-info seed.** Sets `initialTokenUsage` on session state
 *      from the last persisted `token_count` event so UIs display
 *      cumulative usage immediately after resume.
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
  // 1. Agent-task restore. Preserves codex line 1173 ordering
  // (task restore before any state mutations tied to the new model).
  await restorePersistedAgentTask(session, rolloutItems);

  // 2. Model-change warning. Matches codex's sentence at
  // session/mod.rs:1189-1191 with "Codex" → "AgenC".
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

  // 3. Seed token_info so downstream UIs see persisted usage
  // (codex session/mod.rs:1200-1203).
  const info = lastTokenInfoFromRollout(rolloutItems);
  if (info !== undefined) {
    await session.state.with((s) => {
      (s as unknown as { initialTokenUsage?: TokenCountEvent }).initialTokenUsage =
        info;
    });
  }
}

/**
 * codex `Session::persist_agent_task_update` (agent_task_lifecycle.rs:65-70).
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
 * codex `Session::clear_cached_agent_task` (agent_task_lifecycle.rs:72-85).
 * Clear the cached task only if it matches the passed-in task (avoids
 * clearing a task another flow just wrote concurrently).
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
 * codex `Session::cache_agent_task` (agent_task_lifecycle.rs:87-102).
 * Write the task into session state if it differs from the current
 * cached value, persisting the update.
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
 * codex `Session::cached_agent_task_for_current_identity` (agent_task_lifecycle.rs:104-135).
 * Returns the cached task iff it still matches the current identity.
 * On mismatch, clears the cached value and returns undefined.
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
 * codex `Session::ensure_agent_task_registered` (agent_task_lifecycle.rs:137-181).
 * Fast path: return cached. Otherwise, take the registration lock,
 * double-check the cache, then call the identity manager to register
 * a new task. Retry up to twice if the identity manager returns a
 * task that no longer matches current identity (race with identity
 * rotation during registration).
 *
 * Returns `undefined` when feature is disabled or auth binding
 * unavailable (mirrors Rust `Ok(None)`). Throws on registration
 * failure (caller decides whether to log-and-continue per the
 * `maybe_prewarm_agent_task_registration` pattern).
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
        // Mirror codex `debug!("discarding newly registered agent task because the registered agent identity changed")`
        continue;
      }

      const cached2 = await cacheAgentTask(session, registered);
      return cached2;
    }

    return undefined;
  });
}
