/**
 * What `agenc update` shares with the step it hands the daemon to,
 * `agenc daemon restart --when-idle`, which can be a different build: the
 * daemon restart lock, how long a restart waits for another one and for the
 * daemon to start, the updater's handoff timeout derived from those, how long
 * a TUI that follows the update may wait for the restart to end, and the line
 * a waiting restart prints. The updater must not load daemon code, so this
 * module imports nothing but `node:path`.
 */

import { basename } from "node:path";

/** `<AGENC_HOME>/daemon-restart.lock.sqlite`: one restart step at a time. */
export const AGENC_DAEMON_RESTART_LOCK_FILENAME = "daemon-restart.lock.sqlite";
export const AGENC_DAEMON_RESTART_LOCK_LABEL = "AgenC daemon restart";

/** How long a restart waits for another restart of the same daemon. */
export const AGENC_DAEMON_RESTART_LOCK_WAIT_MS = 15 * 60 * 1_000;

/**
 * How long a restart first tries the lock before it says that it waits for
 * another restart.
 */
export const AGENC_DAEMON_RESTART_LOCK_FIRST_TRY_MS = 1_000;

/**
 * How the progress line of a restart that waits for another one starts. The
 * restart step writes it to stderr after `agenc: `, where the updater, of
 * whatever build, recognizes it and shows it.
 */
export const AGENC_DAEMON_RESTART_WAITING_PREFIX = "Waiting for another daemon restart";

/** The progress line of a restart that waits for another one. */
export function formatAgenCDaemonRestartWaitingLine(): string {
  return `${AGENC_DAEMON_RESTART_WAITING_PREFIX} to finish (up to ${Math.round(AGENC_DAEMON_RESTART_LOCK_WAIT_MS / 60_000)} minutes).`;
}

/**
 * Env override (ms) for how long the daemon readiness waits block, plus the
 * default applied when unset/invalid. This single name covers BOTH the bare
 * daemon controls (`start`/`restart`/`reload` in `daemon-control.ts`) and the
 * agent autostart path (`waitForAgenCDaemonReady` in `daemon-autostart.ts`),
 * which imports {@link resolveAgenCDaemonReadyTimeoutMs} so both budgets stay
 * in sync from one resolved value.
 */
export const AGENC_DAEMON_READY_TIMEOUT_MS_ENV =
  "AGENC_DAEMON_READY_TIMEOUT_MS";

/**
 * Bound for how long the daemon readiness waits block for the detached daemon
 * to bind and accept on its control socket before giving up.
 *
 * Raised from 15s to 45s: a cold start has to pay the full hydration cost
 * (state recovery + MCP server start + `socketServer.listen()`) before it can
 * accept, which empirically lands at ~15-16.5s, leaving the old 15s budget with
 * near-zero margin and producing false "did not become ready before timeout"
 * failures on healthy daemons. 45s gives ~3x headroom; CI can tune it back down
 * via {@link AGENC_DAEMON_READY_TIMEOUT_MS_ENV}. A longer budget only makes a
 * genuinely-broken daemon take longer to surface, which is the safer tradeoff
 * against false negatives on cold start.
 */
export const DEFAULT_DAEMON_READY_TIMEOUT_MS = 45_000;

/**
 * Resolve the daemon readiness timeout (ms) from the env override, falling back
 * to {@link DEFAULT_DAEMON_READY_TIMEOUT_MS} when unset or invalid. Matches the
 * codebase env-int convention (e.g. `getMaxMcpOutputTokens`): only a finite,
 * strictly-positive parse wins; everything else (non-numeric, NaN, <= 0) falls
 * back to the default. Exported so the autostart path resolves the same value.
 */
export function resolveAgenCDaemonReadyTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const envValue = env[AGENC_DAEMON_READY_TIMEOUT_MS_ENV];
  if (envValue !== undefined && envValue.trim().length > 0) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_DAEMON_READY_TIMEOUT_MS;
}

/**
 * Env override (ms) for the total time `daemon start` keeps waiting for a
 * spawned daemon that is still hydrating past the readiness budget.
 */
export const AGENC_DAEMON_START_MAX_WAIT_MS_ENV =
  "AGENC_DAEMON_START_MAX_WAIT_MS";

/**
 * Bound for that extended wait. A home with hundreds of sessions takes longer
 * than {@link DEFAULT_DAEMON_READY_TIMEOUT_MS} to open its state and recover
 * its runs (observed: 60 s for 877 sessions). Cancelling such a daemon at the
 * deadline and letting the caller start another one produced a loop in which
 * no daemon ever finished starting. While the startup log keeps advancing the
 * wait continues, in readiness-budget steps, up to this total.
 */
export const DEFAULT_DAEMON_START_MAX_WAIT_MS = 600_000;

export function resolveAgenCDaemonStartMaxWaitMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const envValue = env[AGENC_DAEMON_START_MAX_WAIT_MS_ENV];
  if (envValue !== undefined && envValue.trim().length > 0) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_DAEMON_START_MAX_WAIT_MS;
}

/**
 * The longest a daemon start waits before it gives up, as `daemon start`
 * waits: readiness in budget steps up to the start maximum and, on macOS,
 * before that the launchd job's pid publication.
 */
export function agenCDaemonStartWaitBoundMs(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): number {
  const budgetMs = resolveAgenCDaemonReadyTimeoutMs(env);
  const maxWaitMs = resolveAgenCDaemonStartMaxWaitMs(env);
  const readinessMs = Math.max(1, Math.ceil(maxWaitMs / budgetMs)) * budgetMs;
  const publicationMs = platform === "darwin" ? Math.max(budgetMs, maxWaitMs) : 0;
  return publicationMs + readinessMs;
}

/**
 * Everything else a restart step does: its checks, the stop with its
 * escalation, the lifecycle lock waits (up to 2 minutes each) and the new
 * daemon's build report.
 */
export const AGENC_DAEMON_RESTART_WORK_ALLOWANCE_MS = 10 * 60 * 1_000;

/**
 * How long `agenc update` waits for the restart step it hands over: the
 * step's wait for another restart, the daemon start and the work around them.
 * Built from the same budgets the step uses, so the updater never gives up
 * while the step is still within its own limits.
 */
export function resolveAgenCDaemonRestartHandoffTimeoutMs(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): number {
  return AGENC_DAEMON_RESTART_LOCK_FIRST_TRY_MS +
    AGENC_DAEMON_RESTART_LOCK_WAIT_MS +
    agenCDaemonStartWaitBoundMs(env, platform) +
    AGENC_DAEMON_RESTART_WORK_ALLOWANCE_MS;
}

/** A deferred restart gives up after this long and changes nothing. */
export const AGENC_DAEMON_RESTART_MAX_WAIT_MS = 12 * 60 * 60 * 1_000;

/**
 * The latest a restart handed over by an update can still end, counted from
 * the handoff: the step itself (bounded like the handoff), a waiting process
 * for a busy daemon, then that process's own restart (bounded like the
 * handoff again). A TUI that follows the update stops waiting after this.
 */
export function resolveAgenCDaemonRestartFollowDeadlineMs(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): number {
  return AGENC_DAEMON_RESTART_MAX_WAIT_MS + 2 * resolveAgenCDaemonRestartHandoffTimeoutMs(env, platform);
}

/**
 * A local SQLite lock that stayed busy: another holder kept it for the whole
 * wait. A lock that times out while its path is still being validated (on
 * macOS the `/bin/df` filesystem probe has its own 2 s limit) carries another
 * label or path, and its message is the reason to report.
 */
export function isLocalSqliteLockBusyTimeout(
  error: unknown,
  lock: { readonly label: string; readonly filename: string },
): error is Error & { readonly timeoutMs: number } {
  const value = error as {
    readonly name?: unknown;
    readonly timeoutMs?: unknown;
    readonly label?: unknown;
    readonly path?: unknown;
  } | null;
  return value?.name === "LocalSqliteLockTimeoutError" &&
    typeof value.timeoutMs === "number" &&
    value.label === lock.label &&
    typeof value.path === "string" &&
    basename(value.path) === lock.filename;
}

/** A wait in a person's words: "50 ms", "120 s", "15 minutes". */
export function formatAgenCDaemonRestartWait(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms <= 120_000) return `${Math.round(ms / 1_000)} s`;
  return `${Math.round(ms / 60_000)} minutes`;
}

/** Why a restart could not take the daemon restart lock, in a person's words. */
export function describeAgenCDaemonRestartLockFailure(error: unknown): string {
  return isLocalSqliteLockBusyTimeout(error, {
    label: AGENC_DAEMON_RESTART_LOCK_LABEL,
    filename: AGENC_DAEMON_RESTART_LOCK_FILENAME,
  })
    ? `another daemon restart was still running after ${formatAgenCDaemonRestartWait(error.timeoutMs)}, so the daemon was left as it is`
    : `the daemon restart lock could not be taken: ${error instanceof Error ? error.message : String(error)}`;
}
