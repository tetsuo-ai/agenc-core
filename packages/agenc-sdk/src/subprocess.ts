/**
 * Subprocess ("headless CLI") transport.
 *
 * Instead of speaking JSON-RPC to the daemon socket, this transport spawns
 * `agenc -p --output-format stream-json --input-format stream-json` and
 * adapts its line-delimited output onto the same event-iterable interface
 * as {@link AgencSession.prompt}.
 *
 * stream-json contract (mirrors `runtime/src/bin/agenc-main.ts`):
 *   - stdin: one JSON object per line; `{"type":"prompt","prompt":"..."}`
 *     (also accepts `input_text` / user `message` records).
 *   - stdout: `{"type":"event","sessionId","agentId","event":<daemon
 *     notification>}` lines while the turn runs, then one final
 *     `{"type":"result","exitCode","finalMessage","deniedPermissionRequestIds",
 *     "tokenUsage"?}` line.
 *
 * Limitations (inherent to `agenc -p`): the run is one-shot and
 * non-interactive — the CLI auto-DENIES permission requests, so permission
 * callbacks cannot grant tools over this transport. Exit code 2 marks a
 * tool-denied giveup, exactly like the CLI.
 *
 * Settlement waits for child `exit`, stdout `end`, and child `close`. Node
 * may emit `exit` while a descendant still holds the inherited stdout pipe;
 * deciding on `exit` alone drops a valid result that arrives before `close`.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { isJsonObject, type JsonObject } from "./protocol.js";
import {
  promptEventFromNotification,
  sessionIdFromNotification,
  stopReasonFromExitCode,
  type AgencPromptEvent,
  type AgencPromptResult,
} from "./events.js";
import { createPromptEventQueue } from "./prompt-event-queue.js";

/** Default bound on waiting for stdio to close after the child process exits. */
export const DEFAULT_POST_EXIT_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Signal a process group this transport's default spawner created with
 * `detached: true`. Returns false without signalling when `ownsDetachedProcessGroup`
 * is false, the platform has no POSIX process groups, or `pid` is not a safe
 * integer greater than 1 and distinct from this process. Those checks keep
 * `kill(-1)` and a self-signal from ever being issued.
 */
export function signalOwnedDetachedProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  ownsDetachedProcessGroup: boolean,
): boolean {
  if (
    !ownsDetachedProcessGroup ||
    process.platform === "win32" ||
    !isSignalableProcessGroupLeader(pid)
  ) {
    return false;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function isSignalableProcessGroupLeader(
  pid: number | undefined,
): pid is number {
  return (
    typeof pid === "number" &&
    Number.isSafeInteger(pid) &&
    pid > 1 &&
    pid !== process.pid
  );
}

type ChildExitListener = (
  code: number | null,
  signal: string | null,
) => void;

export interface AgencSubprocessChild {
  readonly pid?: number | undefined;
  readonly stdin: {
    write(chunk: string): unknown;
    end(): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
    removeListener(event: "error", listener: (error: Error) => void): unknown;
  } | null;
  readonly stdout: {
    setEncoding(encoding: string): unknown;
    on(event: "data", listener: (chunk: string) => void): unknown;
    on(event: "end", listener: () => void): unknown;
    removeListener(event: "data", listener: (chunk: string) => void): unknown;
    removeListener(event: "end", listener: () => void): unknown;
    destroy?(): unknown;
  } | null;
  readonly stderr: {
    setEncoding(encoding: string): unknown;
    on(event: "data", listener: (chunk: string) => void): unknown;
    removeListener(event: "data", listener: (chunk: string) => void): unknown;
    destroy?(): unknown;
  } | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: ChildExitListener): unknown;
  on(event: "close", listener: ChildExitListener): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: ChildExitListener): unknown;
  once(event: "close", listener: ChildExitListener): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "exit", listener: ChildExitListener): unknown;
  removeListener(event: "close", listener: ChildExitListener): unknown;
  kill(signal?: string): unknown;
}

export type AgencSubprocessSpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly stdio: readonly ["pipe", "pipe", "pipe"];
  },
) => AgencSubprocessChild;

export interface AgencSubprocessOptions {
  /**
   * Executable (plus fixed prefix args) for the AgenC CLI. Defaults to
   * `"agenc"` on PATH.
   */
  readonly agencCommand?: string | readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly configPath?: string;
  readonly permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions";
  /** Disable both approval prompts and the OS sandbox for this subprocess. */
  readonly dangerouslyBypassApprovalsAndSandbox?: boolean;
  /** Extra argv appended verbatim after the built-in flags. */
  readonly extraArgs?: readonly string[];
  readonly signal?: AbortSignal;
  /**
   * Bound on waiting for stdout `end` and child `close` after `exit`.
   * Defaults to {@link DEFAULT_POST_EXIT_DRAIN_TIMEOUT_MS}.
   */
  readonly postExitDrainTimeoutMs?: number;
  /**
   * Unix only, and only for the default spawner. When true, the child is
   * started as its own process-group leader (`detached: true`) so a drain
   * timeout can SIGKILL retained descendants. Terminal SIGINT and SIGHUP
   * then do not reach the child; `cancel()` and an aborted `signal` forward
   * SIGTERM to that group instead. Default false, so a foreground embedder
   * keeps the child in the terminal's process group. Ignored when `spawn`
   * is set: a custom spawner is never group-signalled.
   */
  readonly detachProcessGroup?: boolean;
  /** Injectable for tests. */
  readonly spawn?: AgencSubprocessSpawnFn;
}

/** Event-iterable prompt run over the subprocess transport. */
export interface AgencSubprocessRun extends AsyncIterable<AgencPromptEvent> {
  result(): Promise<AgencPromptResult>;
  /** SIGTERM the child. */
  cancel(): void;
}

/**
 * Run one headless prompt through the AgenC CLI and stream typed events.
 */
export function promptViaSubprocess(
  prompt: string,
  options: AgencSubprocessOptions = {},
): AgencSubprocessRun {
  const command = options.agencCommand ?? "agenc";
  const [executable, ...prefixArgs] =
    typeof command === "string" ? [command] : [...command];
  if (executable === undefined || executable.length === 0) {
    throw new Error("agencCommand must name an executable");
  }
  const drainTimeoutMs = resolvePostExitDrainTimeoutMs(
    options.postExitDrainTimeoutMs,
  );
  const args = [
    ...prefixArgs,
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    ...(options.model !== undefined ? ["--model", options.model] : []),
    ...(options.provider !== undefined ? ["--provider", options.provider] : []),
    ...(options.profile !== undefined ? ["--profile", options.profile] : []),
    ...(options.configPath !== undefined
      ? ["--config", options.configPath]
      : []),
    ...(options.permissionMode !== undefined
      ? ["--permission-mode", options.permissionMode]
      : []),
    ...(options.dangerouslyBypassApprovalsAndSandbox === true
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : []),
    ...(options.extraArgs ?? []),
  ];

  const ownsDetachedProcessGroup =
    options.spawn === undefined &&
    options.detachProcessGroup === true &&
    process.platform !== "win32";
  const spawner: AgencSubprocessSpawnFn =
    options.spawn ??
    ((spawnCommand, spawnArgs, spawnOptions) =>
      nodeSpawn(spawnCommand, [...spawnArgs], {
        ...spawnOptions,
        stdio: [...spawnOptions.stdio],
        ...(ownsDetachedProcessGroup ? { detached: true } : {}),
      }) as unknown as AgencSubprocessChild);

  const child = spawner(executable, args, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  });

  // `agenc -p` stamps every stream-json event line with the session it runs
  // in; a local-overflow gap reports that session so the loss is attributable.
  let observedSessionId: string | undefined;
  const buffered = createPromptEventQueue({
    sessionId: () => observedSessionId,
  });
  let wake: (() => void) | null = null;
  let done = false;
  let failure: Error | null = null;
  let finalResult: AgencPromptResult | null = null;
  let resultLine: JsonObject | null = null;
  let stderrTail = "";
  let stdoutRemainder = "";

  let resolveResult!: (value: AgencPromptResult) => void;
  let rejectResult!: (error: Error) => void;
  const resultPromise = new Promise<AgencPromptResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  resultPromise.catch(() => {});

  const notify = () => {
    wake?.();
    wake = null;
  };
  const listenerCleanups: Array<() => void> = [];
  // Removes the abort listener on completion so a reused long-lived AbortSignal
  // does not accumulate one dead listener per prompt run.
  let removeAbortListener: (() => void) | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let exited = false;
  let closed = false;
  let stdoutEnded = child.stdout === null;
  let remainderParsed = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;

  const runCleanup = () => {
    if (drainTimer !== undefined) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }
    removeAbortListener?.();
    removeAbortListener = null;
    for (const cleanup of listenerCleanups.splice(0)) {
      cleanup();
    }
  };
  const finishOk = (value: AgencPromptResult) => {
    if (done) return;
    done = true;
    finalResult = value;
    runCleanup();
    resolveResult(value);
    notify();
  };
  const finishError = (error: Error) => {
    if (done) return;
    done = true;
    failure = error;
    runCleanup();
    rejectResult(error);
    notify();
  };

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return; // non-JSON noise on stdout is ignored
    }
    if (!isJsonObject(parsed)) return;
    if (parsed.type === "event" && isJsonObject(parsed.event)) {
      if (observedSessionId === undefined) {
        observedSessionId =
          typeof parsed.sessionId === "string"
            ? parsed.sessionId
            : sessionIdFromNotification(parsed.event) ?? undefined;
      }
      const event = promptEventFromNotification(parsed.event);
      if (event !== null && !done) {
        buffered.push(event);
        notify();
      }
      return;
    }
    if (parsed.type === "result") {
      resultLine = parsed;
    }
  };

  const parseCompleteLines = () => {
    let newlineIndex = stdoutRemainder.indexOf("\n");
    while (newlineIndex >= 0) {
      handleLine(stdoutRemainder.slice(0, newlineIndex));
      stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1);
      newlineIndex = stdoutRemainder.indexOf("\n");
    }
  };
  const parseRemainderOnce = () => {
    if (remainderParsed) return;
    remainderParsed = true;
    if (stdoutRemainder.length > 0) {
      handleLine(stdoutRemainder);
      stdoutRemainder = "";
    }
  };
  const settleFromTerminalState = () => {
    if (done || !exited || !closed) return;
    if (!stdoutEnded) {
      stdoutEnded = true;
      parseRemainderOnce();
    }
    if (resultLine !== null) {
      const line = resultLine;
      const resolvedExitCode =
        typeof line.exitCode === "number" ? line.exitCode : exitCode ?? 1;
      const denied = Array.isArray(line.deniedPermissionRequestIds)
        ? line.deniedPermissionRequestIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      finishOk({
        stopReason: stopReasonFromExitCode(resolvedExitCode),
        exitCode: resolvedExitCode,
        finalMessage:
          typeof line.finalMessage === "string" ? line.finalMessage : "",
        deniedPermissionRequestIds: denied,
        ...(isJsonObject(line.tokenUsage) ? { usage: line.tokenUsage } : {}),
      });
      return;
    }
    finishError(
      new Error(
        `AgenC CLI exited (code ${exitCode ?? "null"}${
          exitSignal !== null ? `, signal ${exitSignal}` : ""
        }) without a stream-json result${
          stderrTail.trim().length > 0 ? `: ${stderrTail.trim()}` : ""
        }`,
      ),
    );
  };
  const signalChild = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal);
    } catch {
      // The wrapper may already be gone.
    }
    signalOwnedDetachedProcessGroup(
      child.pid,
      signal,
      ownsDetachedProcessGroup,
    );
  };
  const terminateRetainedDescendants = () => {
    signalChild("SIGKILL");
    try {
      child.stdout?.destroy?.();
    } catch {
      // Stream already closed.
    }
    try {
      child.stderr?.destroy?.();
    } catch {
      // Stream already closed.
    }
  };
  const beginPostExitDrain = () => {
    if (done || closed || drainTimer !== undefined) return;
    drainTimer = setTimeout(() => {
      drainTimer = undefined;
      finishError(
        new Error(
          `AgenC CLI exited (code ${exitCode ?? "null"}${
            exitSignal !== null ? `, signal ${exitSignal}` : ""
          }) but stdio did not close within ${drainTimeoutMs}ms`,
        ),
      );
      // Kill after settle so a synchronous stdout destroy cannot
      // race a successful result onto the same run.
      terminateRetainedDescendants();
    }, drainTimeoutMs);
  };
  const onStdoutData = (chunk: string) => {
    if (done || stdoutEnded) return;
    stdoutRemainder += chunk;
    parseCompleteLines();
  };
  const onStdoutEnd = () => {
    if (stdoutEnded) return;
    stdoutEnded = true;
    parseRemainderOnce();
    settleFromTerminalState();
  };
  const onStderrData = (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-8_192);
  };
  const onSpawnError = (error: Error) => {
    finishError(
      new Error(`failed to spawn AgenC CLI (${executable}): ${error.message}`),
    );
  };
  const onExit = (code: number | null, signal: string | null) => {
    if (exited) return;
    exited = true;
    exitCode = code;
    exitSignal = signal;
    beginPostExitDrain();
    settleFromTerminalState();
  };
  const onClose = (code: number | null, signal: string | null) => {
    if (closed) return;
    closed = true;
    if (!exited) {
      exited = true;
      exitCode = code;
      exitSignal = signal;
    }
    if (!stdoutEnded) {
      stdoutEnded = true;
      parseRemainderOnce();
    }
    settleFromTerminalState();
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  if (child.stdout !== null) {
    child.stdout.on("data", onStdoutData);
    child.stdout.on("end", onStdoutEnd);
    listenerCleanups.push(() => {
      child.stdout?.removeListener("data", onStdoutData);
      child.stdout?.removeListener("end", onStdoutEnd);
    });
  }
  if (child.stderr !== null) {
    child.stderr.on("data", onStderrData);
    listenerCleanups.push(() => {
      child.stderr?.removeListener("data", onStderrData);
    });
  }
  child.on("error", onSpawnError);
  child.on("exit", onExit);
  child.on("close", onClose);
  listenerCleanups.push(() => {
    child.removeListener("error", onSpawnError);
    child.removeListener("exit", onExit);
    child.removeListener("close", onClose);
  });

  if (options.signal !== undefined) {
    const abortSignal = options.signal;
    const onAbort = () => signalChild("SIGTERM");
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () =>
        abortSignal.removeEventListener("abort", onAbort);
    }
  }

  if (child.stdin === null) {
    finishError(new Error("AgenC CLI child has no stdin pipe"));
  } else {
    // Without an "error" listener a broken stdin pipe (the child exited before
    // draining stdin — startup crash, bad flag) surfaces as an uncaught EPIPE in
    // the embedder's process. child.on("error") (above) only covers
    // ChildProcess spawn errors, not stream errors — route those into finishError.
    const stdin = child.stdin;
    const onStdinError = (error: Error) => {
      finishError(new Error(`AgenC CLI stdin write failed: ${error.message}`));
    };
    stdin.on("error", onStdinError);
    listenerCleanups.push(() => {
      stdin.removeListener("error", onStdinError);
    });
    stdin.write(`${JSON.stringify({ type: "prompt", prompt })}\n`);
    stdin.end();
  }

  return {
    result: () => resultPromise,
    cancel: () => {
      signalChild("SIGTERM");
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (buffered.length > 0) {
          yield buffered.shift()!;
        }
        if (done) {
          if (failure !== null) throw failure;
          return finalResult!;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

function resolvePostExitDrainTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_POST_EXIT_DRAIN_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError(
      "postExitDrainTimeoutMs must be positive and no greater than 2147483647",
    );
  }
  return value;
}
