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
  /** Deferred: the restart request whose end a client should wait for. */
  readonly requestId?: string;
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
  const requestId = record.requestId;
  const pid = record.pid;
  return {
    status: record.status as AgenCDaemonRestartStatus,
    ...(code !== undefined && CODES.has(code) ? { code: code as AgenCDaemonRestartCode } : {}),
    ...(reason === undefined ? {} : { reason }),
    ...(fromVersion === undefined ? {} : { fromVersion }),
    ...(toVersion === undefined ? {} : { toVersion }),
    ...(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
    ...(waitUntil === undefined ? {} : { waitUntil }),
    ...(isAgenCDaemonRestartRequestId(requestId) ? { requestId } : {}),
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
 * A restart request's id: `--request-id`, chosen by the TUI that asked, kept
 * in the pending record, on the deferred outcome and in the results.
 */
export function isAgenCDaemonRestartRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/.test(value);
}

/**
 * `<AGENC_HOME>/daemon-restart-results.json`: how the last restart requests
 * ended, oldest first, keyed by request id. A TUI that follows an update
 * after `still-running` or `deferred` reads the end of its own request here;
 * it never compares times. Written by the restart step and the waiting
 * process before either clears the pending record. A deferral is not an end.
 */
export const AGENC_DAEMON_RESTART_RESULTS_FILENAME = "daemon-restart-results.json";
/** The results file keeps the ends of this many requests. */
export const AGENC_DAEMON_RESTART_RESULTS_KEPT = 8;

export interface AgenCDaemonRestartResult {
  readonly requestId: string;
  /** When it ended, for people reading the file; never compared. */
  readonly finishedAt: string;
  readonly outcome: AgenCDaemonRestartOutcome;
  /** This request goes on as that one: a newer request took its place. */
  readonly continuedBy?: string;
}

/** Parse the results file; an unreadable file holds none. */
export function parseAgenCDaemonRestartResults(text: string): AgenCDaemonRestartResult[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const record = value as { readonly schemaVersion?: unknown; readonly results?: unknown } | null;
  if (record?.schemaVersion !== 2 || !Array.isArray(record.results)) return [];
  const results: AgenCDaemonRestartResult[] = [];
  for (const entry of record.results.slice(-AGENC_DAEMON_RESTART_RESULTS_KEPT)) {
    const item = entry as Partial<Record<keyof AgenCDaemonRestartResult, unknown>> | null;
    if (!isAgenCDaemonRestartRequestId(item?.requestId) || typeof item?.finishedAt !== "string") continue;
    const outcome = parseAgenCDaemonRestartOutcome(JSON.stringify(item.outcome ?? null));
    if (outcome === null) continue;
    results.push({
      requestId: item.requestId,
      finishedAt: item.finishedAt,
      outcome,
      ...(isAgenCDaemonRestartRequestId(item.continuedBy) ? { continuedBy: item.continuedBy } : {}),
    });
  }
  return results;
}

/**
 * The file text with `result` added: one entry per request, the newest last;
 * null when nothing changes. For a request the first end wins: a later one,
 * such as a replaced waiting process that woke after its successor ended under
 * the same id, never replaces it. A hand-over (`continuedBy`) is not an end.
 */
export function addAgenCDaemonRestartResult(
  existing: string | null,
  result: AgenCDaemonRestartResult,
): string | null {
  const entries = parseAgenCDaemonRestartResults(existing ?? "");
  if (entries.some((entry) => entry.requestId === result.requestId && entry.continuedBy === undefined)) return null;
  const kept = entries.filter((entry) => entry.requestId !== result.requestId);
  const results = [...kept, result].slice(-AGENC_DAEMON_RESTART_RESULTS_KEPT);
  return `${JSON.stringify({ schemaVersion: 2, results }, null, 2)}\n`;
}
