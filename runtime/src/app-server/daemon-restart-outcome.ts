/**
 * Result of `agenc daemon restart --when-idle`, shared with `agenc update`.
 *
 * The updater and the runtime it activates are different builds: the updater
 * reads this one JSON line from the new runtime. Keep it additive.
 */

export type AgenCDaemonRestartStatus =
  | "restarted"
  | "deferred"
  | "not-running"
  | "skipped"
  | "failed";

/** Stable reasons a caller may act on; the reason text is for people. */
export type AgenCDaemonRestartCode =
  | "already-current"
  | "newer-daemon"
  | "opt-out"
  | "not-activated"
  | "unsupported"
  /** The daemon cannot stop only when idle (0.19.24 and older): restart it by hand. */
  | "daemon-too-old"
  /**
   * `agenc update` stopped waiting for the restart step, which keeps going in
   * the background (status `deferred`): the daemon moves when it finishes.
   */
  | "still-running";

export interface AgenCDaemonRestartOutcome {
  readonly status: AgenCDaemonRestartStatus;
  readonly code?: AgenCDaemonRestartCode;
  /** Plain words. Always set unless the status is restarted or not-running. */
  readonly reason?: string;
  /** Build the daemon ran before; set when a running daemon was found. */
  readonly fromVersion?: string;
  /** The installed runtime's build, which the daemon runs after a restart. */
  readonly toVersion?: string;
  /** The daemon's pid: the replacement after a restart. */
  readonly pid?: number;
  /** Deferred: when the waiting process gives up. */
  readonly waitUntil?: string;
}

const STATUSES: ReadonlySet<string> = new Set([
  "restarted",
  "deferred",
  "not-running",
  "skipped",
  "failed",
]);
const CODES: ReadonlySet<string> = new Set([
  "already-current",
  "newer-daemon",
  "opt-out",
  "not-activated",
  "unsupported",
  "daemon-too-old",
  "still-running",
]);

/** Parse an outcome line printed by `restart --when-idle --json`. */
export function parseAgenCDaemonRestartOutcome(
  line: string,
): AgenCDaemonRestartOutcome | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.status !== "string" || !STATUSES.has(record.status)) return null;
  const text = (key: string): string | undefined => {
    const field = record[key];
    return typeof field === "string" && field.length > 0 ? field.slice(0, 2_000) : undefined;
  };
  const code = text("code");
  const reason = text("reason");
  const fromVersion = text("fromVersion");
  const toVersion = text("toVersion");
  const waitUntil = text("waitUntil");
  const pid = record.pid;
  return {
    status: record.status as AgenCDaemonRestartStatus,
    ...(code !== undefined && CODES.has(code) ? { code: code as AgenCDaemonRestartCode } : {}),
    ...(reason === undefined ? {} : { reason }),
    ...(fromVersion === undefined ? {} : { fromVersion }),
    ...(toVersion === undefined ? {} : { toVersion }),
    ...(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
    ...(waitUntil === undefined ? {} : { waitUntil }),
  };
}

/** The one line a person sees for an outcome. */
export function formatAgenCDaemonRestartOutcome(
  outcome: AgenCDaemonRestartOutcome,
): string {
  const target = outcome.toVersion ?? "the installed runtime";
  switch (outcome.status) {
    case "restarted":
      return `Restarted the daemon on ${target}${outcome.pid === undefined ? "" : ` (pid ${outcome.pid})`}.`;
    case "deferred":
      return outcome.code === "still-running"
        ? `The daemon restart onto ${target} is still running (${outcome.reason ?? "no result yet"}); it continues in the background.`
        : `The daemon is busy (${outcome.reason ?? "in use"}), so it will restart on ${target} once it is idle.`;
    case "not-running":
      return `No daemon is running. The next one starts on ${target}.`;
    case "skipped":
      return outcome.code === "already-current"
        ? `The daemon already runs ${target}.`
        : `Daemon restart skipped: ${outcome.reason ?? "not possible here"}.`;
    case "failed":
      return `Daemon restart failed: ${outcome.reason ?? "unknown error"}.`;
  }
}

/**
 * True when the old "restart it yourself" hint still applies. Never for a
 * newer daemon: restarting it would start an older runtime.
 */
export function agenCDaemonRestartNeedsHint(outcome: AgenCDaemonRestartOutcome): boolean {
  return outcome.status === "failed" ||
    (outcome.status === "skipped" &&
      outcome.code !== "already-current" &&
      outcome.code !== "newer-daemon");
}

/**
 * True when an "up to date" run has something to say about the daemon: it
 * was stale and was restarted, will be, or could not be.
 */
export function agenCDaemonRestartIsNews(outcome: AgenCDaemonRestartOutcome): boolean {
  return outcome.status === "restarted" ||
    outcome.status === "deferred" ||
    outcome.status === "failed" ||
    // A stale daemon that only a manual restart moves.
    (outcome.status === "skipped" && outcome.code === "daemon-too-old");
}

/**
 * `<AGENC_HOME>/daemon-restart-result.json`: how the last restart step that
 * finished ended. A client that stopped waiting for a restart (a TUI that
 * follows an update after `still-running` or `deferred`) reads it to learn
 * the end it no longer sees. Written by the restart step and the waiting
 * process; a deferral is not an end, so it is not written for one.
 */
export const AGENC_DAEMON_RESTART_RESULT_FILENAME = "daemon-restart-result.json";

export interface AgenCDaemonRestartResult {
  /** ISO time the restart step finished. */
  readonly finishedAt: string;
  readonly outcome: AgenCDaemonRestartOutcome;
}

export function formatAgenCDaemonRestartResult(
  outcome: AgenCDaemonRestartOutcome,
  finishedAt: Date,
): string {
  return `${JSON.stringify({ schemaVersion: 1, finishedAt: finishedAt.toISOString(), outcome }, null, 2)}\n`;
}

/** Parse the result file; null when it is not one. */
export function parseAgenCDaemonRestartResult(text: string): AgenCDaemonRestartResult | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as { readonly schemaVersion?: unknown; readonly finishedAt?: unknown; readonly outcome?: unknown };
  if (
    record.schemaVersion !== 1 ||
    typeof record.finishedAt !== "string" ||
    !Number.isFinite(Date.parse(record.finishedAt))
  ) {
    return null;
  }
  const outcome = parseAgenCDaemonRestartOutcome(JSON.stringify(record.outcome ?? null));
  return outcome === null ? null : { finishedAt: record.finishedAt, outcome };
}
