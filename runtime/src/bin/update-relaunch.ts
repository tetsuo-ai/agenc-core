/**
 * The second half of "Update now" in the TUI. The menu installed the new
 * version and the TUI has exited; this moves the daemon and replaces this
 * process with the new version, reopening the same conversation.
 *
 * The daemon step is the new version's `daemon restart --when-idle`, with
 * this process named as the requester: its own conversation never holds the
 * restart up, other clients and running work still do. When the daemon
 * restarted (or none was running), this process execs the new version in
 * place: same pid, same terminal, no shell in between. Otherwise this window
 * reopens on the version it runs, says why, and follows once it can. A
 * newer client would stop the older daemon at once, busy or not, so the new
 * version never starts while the old daemon still has work.
 *
 * Every failure ends in a working TUI: the old version reopens with the
 * reason, and a new version that cannot reopen the conversation starts
 * fresh instead of exiting.
 */

import { randomUUID } from "node:crypto";
import type { AgenCDaemonRestartOutcome } from "../app-server/daemon-restart-outcome.js";
import type {
  UpdateFollow,
  UpdateNotice,
  UpdateRelaunchRequest,
} from "../tui/update-relaunch-state.js";

export type UpdateRelaunchDecision =
  | { readonly kind: "exec" }
  | {
      readonly kind: "stay";
      readonly notice: UpdateNotice;
      readonly follow?: UpdateFollow["when"];
      /** The version the daemon moves to when that is not this update's. */
      readonly followVersion?: string;
    };

/** What the daemon step's outcome means for this window. */
export function decideUpdateRelaunch(
  outcome: AgenCDaemonRestartOutcome,
  request: UpdateRelaunchRequest,
): UpdateRelaunchDecision {
  const to = request.targetVersion;
  const from = request.fromVersion;
  switch (outcome.status) {
    case "restarted":
    case "not-running":
      return { kind: "exec" };
    case "skipped":
      if (outcome.code === "already-current" || outcome.code === "newer-daemon") return { kind: "exec" };
      break;
    case "deferred": {
      // A restart onto a newer build may already be waiting (another
      // update); the daemon then moves to that one, and so does this window.
      const next = outcome.toVersion ?? to;
      return {
        kind: "stay",
        follow: "daemon",
        ...(next === to ? {} : { followVersion: next }),
        notice: {
          kind: "info",
          // A restart still running past the update's wait is not a failure:
          // follow the daemon instead of telling the person to start over.
          text: outcome.code === "still-running"
            ? `Installed AgenC ${to}. The daemon restart is still running, so AgenC switches to ${next} once it finishes. This window keeps running ${from} until then.`
            : `Installed AgenC ${to}. The daemon is busy (${outcome.reason ?? "other work"}), so AgenC switches to ${next} once that work is done. This window keeps running ${from} until then.`,
        },
      };
    }
    case "failed":
      break;
  }
  return {
    kind: "stay",
    notice: {
      kind: "error",
      text: `Installed AgenC ${to}, but the daemon could not move to it (${outcome.reason ?? outcome.status}). This window keeps running ${from}. Quit AgenC and start it again to use ${to}.`,
    },
  };
}

/** Arguments for the new version: reopen the conversation, nothing else. */
export function updateRelaunchArgs(request: UpdateRelaunchRequest): string[] {
  // Resume restores the conversation's own model, permission mode, extra
  // directories and limits; repeating launch flags could contradict them.
  return request.conversationId === undefined ? [] : ["--resume", request.conversationId];
}

/**
 * Daemon step arguments: this process is the requester, and `requestId`
 * names this restart request, whose end the step publishes.
 */
export function updateDaemonStepArgs(request: UpdateRelaunchRequest, pid: number, requestId?: string): string[] {
  return [
    "--requester-pid",
    String(pid),
    ...(request.conversationId === undefined ? [] : ["--requester-agent", request.conversationId]),
    ...(requestId === undefined ? [] : ["--request-id", requestId]),
  ];
}

const RELAUNCH_ENV_DROP = [
  // Set for this session's own tools; a new process gets its own.
  "AGENC_TASK_LIST_ID",
  // Belongs to this start of the CLI only.
  "AGENC_DAEMON_AUTOSTART_FAILURE",
];

export function updateRelaunchEnvironment(
  env: NodeJS.ProcessEnv,
  markerName: string,
  marker: string,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of RELAUNCH_ENV_DROP) delete next[key];
  next[markerName] = marker;
  return next;
}

export interface UpdateRelaunchDeps {
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** Run `<command> daemon restart --when-idle --json <extra args>`. */
  readonly runDaemonStep: (
    request: UpdateRelaunchRequest,
    extraArgs: readonly string[],
  ) => Promise<AgenCDaemonRestartOutcome>;
  /** Replace this process. Throws when it cannot; never returns otherwise. */
  readonly execve: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => void;
  readonly chdir: (cwd: string) => void;
  /** Reopen this version's TUI with a notice, following later if asked. */
  readonly reopen: (
    request: UpdateRelaunchRequest,
    notice: UpdateNotice,
    follow: UpdateFollow | null,
  ) => Promise<number>;
  readonly markerName: string;
  readonly encodeMarker: (version: string) => string;
  readonly write: (line: string) => void;
  /** A monotonic clock in milliseconds (performance.now by default), for the follow's deadline. */
  readonly now?: () => number;
  /** The id for this restart request; a random UUID by default. */
  readonly newRequestId?: () => string;
}

export async function runUpdateRelaunch(
  request: UpdateRelaunchRequest,
  deps: UpdateRelaunchDeps,
): Promise<number> {
  if (deps.platform === "win32") {
    return deps.reopen(request, {
      kind: "info",
      text: `Installed AgenC ${request.targetVersion}. Quit AgenC and start it again to use it.`,
    }, null);
  }
  deps.write(`agenc: moving to AgenC ${request.targetVersion}`);
  // The follow's deadline counts from here; its results carry this id.
  const since = (deps.now ?? (() => performance.now()))();
  const requestId = (deps.newRequestId ?? randomUUID)();
  let outcome: AgenCDaemonRestartOutcome;
  try {
    outcome = await deps.runDaemonStep(request, updateDaemonStepArgs(request, deps.pid, requestId));
  } catch (error) {
    outcome = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  const decision = decideUpdateRelaunch(outcome, request);
  if (decision.kind === "stay") {
    const followRequest = decision.followVersion === undefined
      ? request
      : { ...request, targetVersion: decision.followVersion };
    return deps.reopen(
      request,
      decision.notice,
      decision.follow === undefined
        ? null
        // A deferral that joined another request's pending restart follows that one.
        : { request: followRequest, when: decision.follow, since, requestId: outcome.requestId ?? requestId },
    );
  }
  const args = updateRelaunchArgs(request);
  try {
    deps.chdir(request.cwd);
    deps.execve(
      request.command,
      [request.command, ...args],
      updateRelaunchEnvironment(deps.env, deps.markerName, deps.encodeMarker(request.targetVersion)),
    );
  } catch (error) {
    return deps.reopen(request, {
      kind: "error",
      text: `Could not start AgenC ${request.targetVersion} (${error instanceof Error ? error.message : String(error)}). This window keeps running ${request.fromVersion}.`,
    }, null);
  }
  // A test double that returns instead of replacing the process.
  return 0;
}
