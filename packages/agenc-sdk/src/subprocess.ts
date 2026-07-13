/**
 * Subprocess ("headless CLI") transport.
 *
 * Instead of speaking JSON-RPC to the daemon socket, this transport spawns
 * `agenc -p --output-format stream-json --input-format stream-json` and
 * adapts its line-delimited output onto the same event-iterable interface
 * as {@link AgencSession.prompt}.
 *
 * stream-json contract (mirrors `runtime/src/bin/agenc.ts`):
 *   - stdin: one JSON object per line; `{"type":"prompt","prompt":"..."}`
 *     (also accepts `input_text` / user `message` records).
 *   - stdout: `{"type":"event","sessionId","agentId","event":<daemon
 *     notification>}` lines while the turn runs, then one final
 *     `{"type":"result","exitCode","finalMessage","deniedPermissionRequestIds",
 *     "tokenUsage"?,"cacheStats"?}` line.
 *
 * Limitations (inherent to `agenc -p`): the run is one-shot and
 * non-interactive — the CLI auto-DENIES permission requests, so permission
 * callbacks cannot grant tools over this transport. Exit code 2 marks a
 * tool-denied giveup, exactly like the CLI.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { isJsonObject, type JsonObject } from "./protocol.js";
import {
  promptEventFromNotification,
  stopReasonFromExitCode,
  type AgencPromptEvent,
  type AgencPromptResult,
} from "./events.js";

/** Cap on internally buffered, not-yet-consumed prompt events (mirrors client.ts). */
const MAX_BUFFERED_PROMPT_EVENTS = 1_000;

export interface AgencSubprocessChild {
  readonly stdin: {
    write(chunk: string): unknown;
    end(): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
  } | null;
  readonly stdout: {
    setEncoding(encoding: string): unknown;
    on(event: "data", listener: (chunk: string) => void): unknown;
  } | null;
  readonly stderr: {
    setEncoding(encoding: string): unknown;
    on(event: "data", listener: (chunk: string) => void): unknown;
  } | null;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
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
  readonly permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions";
  /** Extra argv appended verbatim after the built-in flags. */
  readonly extraArgs?: readonly string[];
  readonly signal?: AbortSignal;
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
    ...(options.permissionMode !== undefined
      ? ["--permission-mode", options.permissionMode]
      : []),
    ...(options.extraArgs ?? []),
  ];

  const spawner: AgencSubprocessSpawnFn =
    options.spawn ??
    ((spawnCommand, spawnArgs, spawnOptions) =>
      nodeSpawn(spawnCommand, [...spawnArgs], {
        ...spawnOptions,
        stdio: [...spawnOptions.stdio],
      }) as unknown as AgencSubprocessChild);

  const child = spawner(executable, args, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const buffered: AgencPromptEvent[] = [];
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
  // Removes the abort listener on completion so a reused long-lived AbortSignal
  // does not accumulate one dead listener per prompt run.
  let removeAbortListener: (() => void) | null = null;
  const runCleanup = () => {
    removeAbortListener?.();
    removeAbortListener = null;
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
      const event = promptEventFromNotification(parsed.event);
      if (event !== null && !done) {
        buffered.push(event);
        while (buffered.length > MAX_BUFFERED_PROMPT_EVENTS) buffered.shift();
        notify();
      }
      return;
    }
    if (parsed.type === "result") {
      resultLine = parsed;
    }
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutRemainder += chunk;
    let newlineIndex = stdoutRemainder.indexOf("\n");
    while (newlineIndex >= 0) {
      handleLine(stdoutRemainder.slice(0, newlineIndex));
      stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1);
      newlineIndex = stdoutRemainder.indexOf("\n");
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-8_192);
  });

  child.once("error", (error) => {
    finishError(
      new Error(`failed to spawn AgenC CLI (${executable}): ${error.message}`),
    );
  });
  child.once("exit", (code, signal) => {
    if (stdoutRemainder.length > 0) {
      handleLine(stdoutRemainder);
      stdoutRemainder = "";
    }
    if (resultLine !== null) {
      const line = resultLine;
      const exitCode =
        typeof line.exitCode === "number" ? line.exitCode : code ?? 1;
      const denied = Array.isArray(line.deniedPermissionRequestIds)
        ? line.deniedPermissionRequestIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      finishOk({
        stopReason: stopReasonFromExitCode(exitCode),
        exitCode,
        finalMessage:
          typeof line.finalMessage === "string" ? line.finalMessage : "",
        deniedPermissionRequestIds: denied,
        ...(isJsonObject(line.tokenUsage) ? { usage: line.tokenUsage } : {}),
        ...(isJsonObject(line.cacheStats)
          ? { cacheStats: line.cacheStats }
          : {}),
      });
      return;
    }
    finishError(
      new Error(
        `AgenC CLI exited (code ${code ?? "null"}${
          signal !== null ? `, signal ${signal}` : ""
        }) without a stream-json result${
          stderrTail.trim().length > 0 ? `: ${stderrTail.trim()}` : ""
        }`,
      ),
    );
  });

  if (options.signal !== undefined) {
    const abortSignal = options.signal;
    const onAbort = () => child.kill("SIGTERM");
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
    // the embedder's process. child.once("error") (above) only covers
    // ChildProcess spawn errors, not stream errors — route those into finishError.
    child.stdin.on("error", (error: Error) => {
      finishError(new Error(`AgenC CLI stdin write failed: ${error.message}`));
    });
    child.stdin.write(`${JSON.stringify({ type: "prompt", prompt })}\n`);
    child.stdin.end();
  }

  return {
    result: () => resultPromise,
    cancel: () => {
      child.kill("SIGTERM");
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
