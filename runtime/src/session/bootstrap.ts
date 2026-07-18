/**
 * Session bootstrap — port of upstream agenc runtime
 * `core/src/session/session.rs::Session::new` (lines 258-967).
 *
 * Upstream `Session::new` is a single ~710 LOC async function that
 * constructs the `Session`, kicks off parallel auth + MCP + thread-
 * persistence futures, awaits required MCP servers, emits
 * `SessionConfigured`, schedules the startup prewarm, and calls
 * `record_initial_history` for resumed sessions. Gut ports that
 * sequence into a TypeScript free function so the `Session` constructor
 * stays lightweight (field init only) and callers have a single entry
 * point whose contract is testable.
 *
 * Design decisions (per brief + `docs/plan/translation-conventions.md`):
 *
 *   - **Module-level `bootstrapSession(opts)`** instead of a static
 *     factory on `Session`. Upstream's `Session::new` is a free
 *     constructor function in Rust; mapping it to a TypeScript free
 *     function avoids leaking bootstrap-only state onto the class
 *     itself and keeps the constructor usable directly from unit tests
 *     that don't want prewarm / session_configured side effects.
 *
 *   - **Compatibility `new Session(...)` stays.** Pure unit tests (see
 *     `session.test.ts`, `idle-input.test.ts`, `tasks.test.ts`) build
 *     minimal `SessionServices` via loose-cast through `unknown`; they
 *     are not upgraded to the bootstrap entry because they don't
 *     exercise shell/MCP/prewarm. The compatibility constructor path remains
 *     a no-op for bootstrap-only effects.
 *
 *   - **Staged caller hooks.** Upstream does thread-persistence,
 *     state_db lookup, live-thread init, and `record_initial_history`
 *     inline; gut's `bin/bootstrap.ts` already owns rollout-store
 *     mount + history reconstruction between session construction and
 *     `session_configured` emit, and sidecar/MCP start between
 *     session_configured and prewarm. The helper exposes two hooks —
 *     `onBeforeSessionConfigured(session)` at the pre-emit seam and
 *     `onAfterSessionConfigured(session)` at the post-emit seam — so
 *     the caller can run rollout/history work before the emit and
 *     sidecar/MCP-manager work after it, without forcing that
 *     orchestration into the bootstrap layer.
 *
 *   - **No new abstractions.** `BootstrapManager`, `HealthCheckRunner`,
 *     and similar wrappers are intentionally absent. Each sub-step is
 *     an exported helper so tests can drive them in isolation.
 *
 * Sub-steps that landed in this port vs. upstream:
 *
 *   | Upstream step                                | Gut status                                     |
 *   |-----------------------------------------------|-----------------------------------------------|
 *   | Shell discovery (`shell::default_user_shell`) | WIRED via `utils/shell-discovery.ts`          |
 *   | Parallel auth + MCP startup (`tokio::join!`)  | WIRED via `Promise.all` in this file          |
 *   | `LiveThread::create/resume`                   | WIRED in `bin/bootstrap-services.ts`          |
 *   | `state_db` lookup                             | WIRED for thread-store metadata              |
 *   | Thread-name lookup                            | WIRED through thread-store metadata          |
 *   | `SessionConfigured` event emit                | WIRED — called from the bootstrap helper      |
 *   | `required_mcp_servers` await (fail-closed)    | WIRED — fails at `manager.start`              |
 *   | Startup prewarm                               | WIRED (best-effort TurnContext construction)  |
 *   | `record_initial_history` (resume)             | WIRED via `agent-task-lifecycle.ts`           |
 *   | Network-proxy setup                           | PUNTED — T11 network approval is separate     |
 *   | `guardian_rejections` / telemetry seeds       | PUNTED — initialized in services builder      |
 *
 * Remaining PUNTED items either live in a different tranche or are
 * intentionally owned by services bootstrap. The WIRED set is
 * sufficient to make the bootstrap sequencing uniform across the live
 * CLI path and the integration fixtures that drive tests.
 *
 * @module
 */

import type { MCPManager, MCPManagerStartOpts } from "../mcp-client/manager.js";
import type { RolloutItem } from "./rollout-item.js";
import { discoverDefaultUserShellAsync } from "../utils/shell-discovery.js";
import {
  recordInitialHistoryOnResume,
  maybePrewarmAgentTaskRegistration,
} from "./agent-task-lifecycle.js";
import { scheduleProviderStartupPrewarm } from "./startup-prewarm.js";
import { runWithCurrentRuntimeSession } from "./current-session.js";
import {
  Session,
  type SessionOpts,
  type SessionServices,
  type SessionConfiguredEvent,
  type UserShell,
} from "./session.js";

/**
 * Resume-path bundle for `bootstrapSession`. Mirrors the subset of
 * upstream `InitialHistory::Resumed` that the gut `record_initial_history`
 * port consumes: rollout items, the previous model name (for the
 * model-change warning), and the current session's active model.
 */
export interface BootstrapResumePayload {
  readonly rolloutItems: ReadonlyArray<RolloutItem>;
  readonly previousModel?: string;
  readonly currentModel: string;
}

/** Payload fields required to emit the terminal `SessionConfigured`. */
export interface BootstrapSessionConfiguredPayload {
  readonly sessionId: string;
  readonly forkedFromId?: string;
  readonly threadName?: string;
  readonly model: string;
  readonly modelProviderId: string;
  readonly serviceTier?: string;
  readonly cwd: string;
  readonly historyLogId: number;
  readonly historyEntryCount: number;
  readonly initialMessages: SessionConfiguredEvent["initialMessages"];
  readonly rolloutPath?: string;
}

/**
 * Options for `bootstrapSession`. A superset of `SessionOpts` with the
 * bootstrap-only fields agenc runtime `Session::new` accepts directly:
 *
 *   - `mcp` — session-owned MCP manager + optional start opts. Upstream
 *     constructs `McpConnectionManager::new()` inline; gut wires the
 *     existing `startMcpManagerForSession` seam here.
 *   - `auth` — async auth prep future. Upstream calls
 *     `auth_manager.auth().await` in parallel with MCP; gut accepts a
 *     caller-supplied prep so the parallelism is preserved even when
 *     the live `AuthManager` is not yet threaded end-to-end.
 *   - `resume` — resume-path bundle handed to `recordInitialHistoryOnResume`
 *     after SessionConfigured. Missing when the session is fresh.
 *   - `sessionConfigured` — payload for the terminal SessionConfigured
 *     emit. Required because the exact model/provider strings live
 *     with the caller (startup selection + provider identity).
 *   - `onBeforeSessionConfigured` — caller hook run after MCP startup
 *     completes but before the `SessionConfigured` emit. Used by
 *     `bin/bootstrap.ts` to mount the rollout store and reconstruct
 *     resume history at the exact moment upstream does the same work.
 *   - `onAfterSessionConfigured` — caller hook run AFTER the
 *     `SessionConfigured` emit but BEFORE the startup prewarm. Used by
 *     `bin/bootstrap.ts` to start sidecars and launch the live MCP
 *     connection manager, mirroring the upstream agenc runtime ordering at
 *     `session.rs:814-854, 857-908` where sidecar and MCP start happen
 *     after the terminal SessionConfigured event.
 *   - `enablePrewarm` — opt-out for tests. Default `true`; the prewarm
 *     call is a no-op-safe `session.newDefaultTurn()` today so it is
 *     cheap, but unit tests still opt out when they don't want the
 *     extra TurnContext object.
 *   - `signal` — caller abort. Checked at every async boundary so the
 *     bootstrap rejects cleanly if the caller cancels mid-startup.
 *
 * `sessionConfigured` accepts either the payload directly OR a lazy
 * thunk evaluated after `onBeforeSessionConfigured` runs. The thunk
 * form exists because the bin path computes `rolloutPath`,
 * `initialMessages`, and `historyEntryCount` inside the before-hook
 * (when the rollout store mounts + resume-history reconstructs), so
 * those fields are not available at `bootstrapSession` call time.
 */
export interface BootstrapSessionOptions extends SessionOpts {
  readonly mcp?: {
    readonly manager: MCPManager;
    readonly startOpts?: MCPManagerStartOpts;
    readonly requiredServers?: ReadonlyArray<string>;
  };
  readonly auth?: () => Promise<unknown>;
  readonly resume?: BootstrapResumePayload;
  readonly sessionConfigured:
    | BootstrapSessionConfiguredPayload
    | (() =>
        | BootstrapSessionConfiguredPayload
        | Promise<BootstrapSessionConfiguredPayload>);
  readonly onBeforeSessionConfigured?: (session: Session) => Promise<void>;
  readonly onAfterSessionConfigured?: (session: Session) => Promise<void>;
  readonly enablePrewarm?: boolean;
  readonly signal?: AbortSignal;
}

/** Raised when a required MCP server fails to start during bootstrap. */
export class RequiredMcpStartupError extends Error {
  readonly failures: ReadonlyArray<{ server: string; error: string }>;
  constructor(failures: ReadonlyArray<{ server: string; error: string }>) {
    const detail = failures
      .map((f) => `${f.server}: ${f.error}`)
      .join("; ");
    super(`required MCP servers failed to initialize: ${detail}`);
    this.name = "RequiredMcpStartupError";
    this.failures = failures;
  }
}

/** Raised when bootstrap is cancelled via `opts.signal`. */
export class BootstrapAbortError extends Error {
  readonly reason: unknown;
  constructor(reason: unknown) {
    super(
      `session bootstrap aborted${typeof reason === "string" ? `: ${reason}` : ""}`,
    );
    this.name = "BootstrapAbortError";
    this.reason = reason;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new BootstrapAbortError(signal.reason ?? "aborted");
  }
}

// ─────────────────────────────────────────────────────────────────────
// Exported sub-steps. Each is a standalone helper so tests can drive
// them without going through the full bootstrap sequence.
// ─────────────────────────────────────────────────────────────────────

/**
 * Upstream `let mut default_shell = ...` block
 * (agenc-rs/core/src/session/session.rs:585-605). Discovers the real
 * user shell and returns a `UserShell` suitable for
 * `SessionServices.userShell`.
 */
export async function discoverShellForSession(
  env: NodeJS.ProcessEnv = process.env,
): Promise<UserShell> {
  return discoverDefaultUserShellAsync({ env });
}

/**
 * Upstream parallel `tokio::join!(auth_and_mcp_fut, ...)`
 * (agenc-rs/core/src/session/session.rs:388-419). Runs the caller's
 * `auth` prep and `manager.start(...)` concurrently and returns the
 * individual results so the caller can thread the auth artifact into
 * downstream services.
 *
 * Required-server failures are raised by `manager.start` itself (see
 * `mcp-client/manager.ts::start` lines 189-201 which throw
 * `MCP aggregate startup failure`), so we rethrow as a typed
 * `RequiredMcpStartupError` that the bootstrap caller can catch
 * without string-matching.
 */
export async function startAuthAndMcpInParallel(params: {
  readonly auth?: () => Promise<unknown>;
  readonly mcp?: {
    readonly manager: MCPManager;
    readonly startFn: (
      manager: MCPManager,
      opts: MCPManagerStartOpts,
    ) => Promise<void>;
    readonly startOpts?: MCPManagerStartOpts;
    readonly requiredServers?: ReadonlyArray<string>;
  };
  readonly signal?: AbortSignal;
}): Promise<{ readonly auth?: unknown }> {
  throwIfAborted(params.signal);
  const authFut = params.auth ? params.auth() : Promise.resolve(undefined);
  const mcpFut = params.mcp
    ? (async () => {
        const startOpts: MCPManagerStartOpts = {
          ...(params.mcp!.startOpts ?? {}),
          ...(params.signal !== undefined ? { signal: params.signal } : {}),
          ...(params.mcp!.requiredServers !== undefined
            ? { requiredServers: [...params.mcp!.requiredServers] }
            : {}),
        };
        try {
          await params.mcp!.startFn(params.mcp!.manager, startOpts);
        } catch (err) {
          // I-20 aggregate-failure: the live manager throws a generic
          // Error. Rewrap so callers can `instanceof` the bootstrap
          // boundary failure.
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("required server(s) not ready")) {
            const required = params.mcp!.requiredServers ?? [];
            throw new RequiredMcpStartupError(
              required.map((server) => ({ server, error: message })),
            );
          }
          throw err;
        }
      })()
    : Promise.resolve();

  const [authResult] = await Promise.all([authFut, mcpFut]);
  throwIfAborted(params.signal);
  return authResult === undefined ? {} : { auth: authResult };
}

/**
 * Upstream `SessionConfigured` event emission block
 * (agenc-rs/core/src/session/session.rs:814-854). The event is the
 * LAST bootstrap step before the post-configured event chain; gut
 * mirrors that by emitting through the canonical `session.emit` path
 * and seeding the TUI's initial-transcript-event list with the same
 * payload so the resume UI renders from the same source of truth.
 */
export function emitSessionConfigured(
  session: Session,
  payload: BootstrapSessionConfiguredPayload,
): void {
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "session_configured",
      payload: {
        sessionId: payload.sessionId,
        ...(payload.forkedFromId !== undefined
          ? { forkedFromId: payload.forkedFromId }
          : {}),
        ...(payload.threadName !== undefined
          ? { threadName: payload.threadName }
          : {}),
        model: payload.model,
        modelProviderId: payload.modelProviderId,
        ...(payload.serviceTier !== undefined
          ? { serviceTier: payload.serviceTier }
          : {}),
        cwd: payload.cwd,
        historyLogId: payload.historyLogId,
        historyEntryCount: payload.historyEntryCount,
        initialMessages: payload.initialMessages,
        ...(payload.rolloutPath !== undefined
          ? { rolloutPath: payload.rolloutPath }
          : {}),
      } satisfies SessionConfiguredEvent,
    },
  });
}

/**
 * Upstream `sess.schedule_startup_prewarm(...)` (session.rs:931-932,
 * impl in session_startup_prewarm.rs:159-181). Upstream pre-builds a
 * default TurnContext and pre-warms the provider websocket so the
 * first `submit` isn't bottlenecked on context construction.
 *
 * Gut runs the TurnContext construction, the optional provider startup
 * prewarm hook, and agent-task registration prewarm so the first submit
 * doesn't pay that cost.
 * Failures are swallowed — the real first submit will re-run the
 * same work and surface any error there.
 *
 * Cancellation honors `opts.signal` at entry. Once the prewarm runs
 * in the background it is not interrupted, matching upstream's
 * `CancellationToken::new()` scope which only covers the in-line
 * prewarm body.
 */
export async function runStartupPrewarm(
  session: Session,
  opts: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  if (opts.signal?.aborted) return;
  try {
    // Upstream pre-builds the startup turn context via
    // `new_default_turn_with_sub_id(INITIAL_SUBMIT_ID.to_owned())`.
    // The gut equivalent is a default turn with a fresh sub-id.
    session.newDefaultTurn();
  } catch {
    // Non-fatal — the first submit will reconstruct the turn.
  }
  try {
    await scheduleProviderStartupPrewarm(session, session.conversationId);
  } catch {
    // Non-fatal — provider/session prewarm is an optimization.
  }
  // Prewarm agent-task registration. Upstream does this in the
  // same broad startup prep block; the gut helper already
  // swallows its own failures.
  try {
    await maybePrewarmAgentTaskRegistration(session);
  } catch {
    /* already best-effort inside the helper */
  }
}

// ─────────────────────────────────────────────────────────────────────
// Top-level entry.
// ─────────────────────────────────────────────────────────────────────

/**
 * Full port of upstream `Session::new`.
 *
 * Orchestration mirrors upstream line-for-line where a gut-side
 * concept exists:
 *
 *   1. Discover the default user shell and patch the services slot
 *      so `session.services.userShell` holds the real shell instead
 *      of the `/bin/sh` stub.
 *   2. Construct the `Session`. The constructor is still lightweight
 *      (field init + permission-registry bootstrap).
 *   3. Run auth prep and MCP startup in parallel. Required-server
 *      failures throw `RequiredMcpStartupError` BEFORE the
 *      SessionConfigured emit — matching upstream's
 *      `anyhow::bail!("required MCP servers failed to initialize: ...")`.
 *   4. Call `onBeforeSessionConfigured(session)` if provided. This is
 *      the seam `bin/bootstrap.ts` uses to mount the rollout store
 *      and reconstruct resume history at the same point upstream
 *      does the thread-persistence future.
 *   5. Emit `SessionConfigured` — the terminal bootstrap event.
 *   6. Start the skills watcher, then call
 *      `onAfterSessionConfigured(session)` if provided. This is where
 *      `bin/bootstrap.ts` starts sidecars and the live MCP connection
 *      manager, matching upstream agenc runtime ordering at
 *      `session.rs:856-908`.
 *   7. Schedule the startup prewarm. Runs in the background; any
 *      error is swallowed.
 *   8. If `opts.resume` is set, call `recordInitialHistoryOnResume`
 *      so the model-change warning and token-info seed matches
 *      upstream's `Session::record_initial_history(Resumed(...))`
 *      arm. Per upstream comment
 *      (`session.rs:941`: "record_initial_history can emit events.
 *      We record only after the SessionConfiguredEvent is emitted.")
 *      this runs AFTER the SessionConfigured emit.
 *
 * Returns the constructed `Session`. The caller owns its lifecycle
 * (shutdown + rollout flushing); `bootstrapSession` does not attach
 * a shutdown handler.
 */
export async function bootstrapSession(
  opts: BootstrapSessionOptions,
): Promise<Session> {
  throwIfAborted(opts.signal);

  // 1. Shell discovery. Patched into the services slot pre-construction
  //    so the session never sees the interface stub.
  const discoveredShell = await discoverShellForSession(process.env);
  const patchedServices: SessionServices = {
    ...opts.services,
    userShell: discoveredShell,
  };

  throwIfAborted(opts.signal);

  // 2. Construct the session.
  const session = new Session({
    ...opts,
    services: patchedServices,
  });

  throwIfAborted(opts.signal);

  // 3. Parallel auth + MCP startup. Required-server failures fail
  //    closed BEFORE SessionConfigured emits.
  const mcp = opts.mcp;
  await startAuthAndMcpInParallel({
    ...(opts.auth !== undefined ? { auth: opts.auth } : {}),
    ...(mcp !== undefined
      ? {
          mcp: {
            manager: mcp.manager,
            startFn: (manager, startOpts) =>
              session.startMcpManager(manager, startOpts),
            ...(mcp.startOpts !== undefined ? { startOpts: mcp.startOpts } : {}),
            ...(mcp.requiredServers !== undefined
              ? { requiredServers: mcp.requiredServers }
              : {}),
          },
        }
      : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  throwIfAborted(opts.signal);

  // 4. Caller hook — rollout mount, history reconstruction, etc.
  if (opts.onBeforeSessionConfigured) {
    await opts.onBeforeSessionConfigured(session);
  }

  throwIfAborted(opts.signal);

  // 5. Terminal bootstrap event. Resolve the lazy payload thunk here
  //    so callers that compute `rolloutPath` / `initialMessages` /
  //    `historyEntryCount` inside `onBeforeSessionConfigured` can
  //    thread them into the emit without reshaping the options.
  const sessionConfiguredPayload =
    typeof opts.sessionConfigured === "function"
      ? await opts.sessionConfigured()
      : opts.sessionConfigured;
  emitSessionConfigured(session, sessionConfiguredPayload);

  // 6. Post-emit startup — skill watcher first, then caller hook for
  //    sidecar start + live MCP connection manager init. Upstream
  //    agenc runtime ordering (`agenc-rs/core/src/session/session.rs:856-908`)
  //    starts the watcher/skills listener and the real
  //    `McpConnectionManager::new()` AFTER the SessionConfigured dispatch.
  await patchedServices.skillsWatcher?.start?.();
  await dispatchBootstrapSessionStart(session, {
    source: opts.initialState.pendingSessionStartSource ?? "startup",
    sessionConfigured: sessionConfiguredPayload,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  if (opts.onAfterSessionConfigured) {
    await opts.onAfterSessionConfigured(session);
  }

  throwIfAborted(opts.signal);

  // 7. Startup prewarm. Awaited here for determinism in tests; upstream
  //    detaches via `tokio::spawn` but the gut body is cheap enough to
  //    run inline. Errors are swallowed inside the helper.
  if (opts.enablePrewarm !== false) {
    await runStartupPrewarm(session, {
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }

  // 8. Resume-only: record_initial_history after SessionConfigured.
  if (opts.resume) {
    await recordInitialHistoryOnResume(session, opts.resume.rolloutItems, {
      ...(opts.resume.previousModel !== undefined
        ? { previousModel: opts.resume.previousModel }
        : {}),
      currentModel: opts.resume.currentModel,
    });
  }

  return session;
}

async function dispatchBootstrapSessionStart(
  session: Session,
  opts: {
    readonly source: "startup" | "resume" | "clear";
    readonly sessionConfigured?: BootstrapSessionConfiguredPayload;
    readonly signal?: AbortSignal;
  },
): Promise<void> {
  const processSessionStart = session.services.hooks?.processSessionStart;
  if (typeof processSessionStart !== "function") return;
  const permissionMode = (
    session.sessionConfiguration as {
      readonly permissionContext?: { readonly mode?: string };
    }
  ).permissionContext?.mode ?? "default";
  const messages = await runWithCurrentRuntimeSession(session, () =>
    processSessionStart(
      {
        hook_event_name: "SessionStart",
        source: opts.source,
        session_id: session.conversationId,
        transcript_path: opts.sessionConfigured?.rolloutPath ?? null,
        cwd: opts.sessionConfigured?.cwd ?? session.sessionConfiguration.cwd,
        model:
          opts.sessionConfigured?.model ??
          session.sessionConfiguration.collaborationMode?.model ??
          "unknown",
        permission_mode: permissionMode,
      },
      { signal: opts.signal },
    ),
  );
  for (const msg of messages) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: msg as never,
    });
  }
}
