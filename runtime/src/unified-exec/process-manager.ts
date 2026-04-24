import { spawn, type ChildProcessByStdio } from "node:child_process";
import { basename, resolve } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import type { IPty } from "@homebridge/node-pty-prebuilt-multiarch";

import {
  approximateTokenCount,
  maxCharsForTokens,
  truncateHeadTail,
} from "./head-tail-buffer.js";
import {
  type ExecCommandRequest,
  type ExecCommandToolOutput,
  type UnifiedExecManagerOptions,
  type UnifiedExecProcessManagerLike,
  type UnifiedExecProgressEvent,
  type UnifiedExecStream,
  type WriteStdinRequest,
  UnifiedExecError,
} from "./types.js";

const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_TIME_MS = 250;
const MIN_YIELD_TIME_MS = 250;
const MIN_EMPTY_YIELD_TIME_MS = 5_000;
const MAX_YIELD_TIME_MS = 30_000;
const DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_PROCESSES = 64;
const DEFAULT_OUTPUT_BUFFER_CHARS = 1024 * 1024;

type ExitState = {
  readonly exitCode: number | null;
  readonly signal?: string | number | null;
};

type StoredProcess =
  | { readonly kind: "pty"; readonly process: IPty }
  | { readonly kind: "pipe"; readonly process: ChildProcessByStdio<null, Readable, Readable> };

type PtyModule = typeof import("@homebridge/node-pty-prebuilt-multiarch");

interface OutputChunk {
  readonly stream: UnifiedExecStream;
  readonly chunk: string;
}

class ProcessOutputBuffer {
  private readonly chunks: OutputChunk[] = [];
  private consumedIndex = 0;
  private totalChars = 0;
  private droppedChars = 0;

  constructor(private readonly maxChars = DEFAULT_OUTPUT_BUFFER_CHARS) {}

  append(stream: UnifiedExecStream, chunk: string): void {
    if (chunk.length === 0) return;
    this.chunks.push({ stream, chunk });
    this.totalChars += chunk.length;
    this.enforceCap();
  }

  drain(): OutputChunk[] {
    const drained = this.chunks.slice(this.consumedIndex);
    this.consumedIndex = this.chunks.length;
    if (this.droppedChars > 0) {
      const marker = `[... omitted ${this.droppedChars} chars before collection ...]\n`;
      this.droppedChars = 0;
      return [{ stream: "stdout", chunk: marker }, ...drained];
    }
    return drained;
  }

  private enforceCap(): void {
    while (this.totalChars > this.maxChars && this.chunks.length > 0) {
      const removed = this.chunks.shift()!;
      this.totalChars -= removed.chunk.length;
      this.droppedChars += removed.chunk.length;
      this.consumedIndex = Math.max(0, this.consumedIndex - 1);
    }
  }
}

interface ProcessEntry {
  readonly processId: number;
  readonly command: string;
  readonly cwd: string;
  readonly tty: boolean;
  readonly startedAt: number;
  readonly output: ProcessOutputBuffer;
  readonly stored: StoredProcess;
  readonly callId: string;
  readonly abortController: AbortController;
  readonly exitPromise: Promise<ExitState>;
  resolveExit: (state: ExitState) => void;
  exitState: ExitState | null;
  hardTimeout?: NodeJS.Timeout;
}

function makeDeferredExit(): {
  readonly promise: Promise<ExitState>;
  readonly resolve: (state: ExitState) => void;
} {
  let resolveExit: (state: ExitState) => void = () => {};
  const promise = new Promise<ExitState>((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  return { promise, resolve: resolveExit };
}

function resolveShell(shell: string | undefined): string {
  if (shell && shell.trim().length > 0) return shell;
  return process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "/bin/bash");
}

function shellArgs(command: string, login: boolean | undefined): string[] {
  if (process.platform === "win32") return ["/d", "/s", "/c", command];
  return [login === true ? "-lc" : "-c", command];
}

function buildEnv(env: Record<string, string> | undefined): Record<string, string> {
  return {
    ...process.env,
    ...(env ?? {}),
  } as Record<string, string>;
}

function clampExecYield(value: number | undefined): number {
  const raw = typeof value === "number" && Number.isFinite(value)
    ? value
    : DEFAULT_EXEC_YIELD_TIME_MS;
  return Math.min(MAX_YIELD_TIME_MS, Math.max(MIN_YIELD_TIME_MS, Math.floor(raw)));
}

function clampWriteYield(value: number | undefined, input: string): number {
  const raw = typeof value === "number" && Number.isFinite(value)
    ? value
    : DEFAULT_WRITE_STDIN_YIELD_TIME_MS;
  const base = Math.max(MIN_YIELD_TIME_MS, Math.floor(raw));
  if (input.length === 0) {
    return Math.min(
      DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS,
      Math.max(MIN_EMPTY_YIELD_TIME_MS, base),
    );
  }
  return Math.min(MAX_YIELD_TIME_MS, base);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createResult(params: {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly processId?: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly maxOutputTokens?: number;
}): ExecCommandToolOutput {
  const maxChars = maxCharsForTokens(params.maxOutputTokens);
  const stdout = truncateHeadTail(params.stdout, maxChars);
  const stderr = truncateHeadTail(params.stderr, maxChars);
  const output = [stdout.text, stderr.text].filter((part) => part.length > 0).join("");
  const originalText = `${params.stdout}${params.stderr}`;
  return {
    output,
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: params.exitCode,
    exit_code: params.exitCode,
    ...(params.processId !== undefined
      ? { process_id: params.processId, session_id: params.processId }
      : {}),
    durationMs: params.durationMs,
    wall_time_seconds: params.durationMs / 1000,
    timedOut: params.timedOut,
    truncated: stdout.truncated || stderr.truncated,
    original_token_count: approximateTokenCount(originalText),
  };
}

export class UnifiedExecProcessManager implements UnifiedExecProcessManagerLike {
  readonly maxTimeoutMs: number;
  private readonly cwd: string;
  private readonly env?: Record<string, string>;
  private readonly maxProcesses: number;
  private nextProcessId = 1;
  private readonly processes = new Map<number, ProcessEntry>();

  constructor(options: UnifiedExecManagerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env;
    this.maxTimeoutMs =
      options.maxTimeoutMs ?? DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS;
    this.maxProcesses = options.maxProcesses ?? DEFAULT_MAX_PROCESSES;
  }

  async execCommand(request: ExecCommandRequest): Promise<ExecCommandToolOutput> {
    if (request.cmd.trim().length === 0) {
      throw new UnifiedExecError("missing_command", "missing command line for unified exec request");
    }
    this.pruneExitedProcesses();
    if (this.processes.size >= this.maxProcesses) {
      throw new UnifiedExecError(
        "process_limit",
        `too many live unified exec processes (${this.processes.size}/${this.maxProcesses})`,
      );
    }

    const processId = this.allocateProcessId();
    const cwd = resolve(request.workdir ?? this.cwd);
    const shell = resolveShell(request.shell);
    const args = shellArgs(request.cmd, request.login);
    const startedAt = Date.now();
    const callId = request.callId ?? `exec-${processId}`;
    const tty = request.tty === true;
    const entry = await this.spawnProcess({
      processId,
      callId,
      command: request.cmd,
      shell,
      args,
      cwd,
      tty,
      startedAt,
      signal: request.__abortSignal,
    });
    this.processes.set(processId, entry);
    request.observer?.onBegin?.({
      callId,
      command: request.cmd,
      cwd,
      processId,
      tty,
    });

    if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
      const timeoutMs = Math.min(request.timeoutMs, this.maxTimeoutMs);
      entry.hardTimeout = setTimeout(() => {
        this.forceTerminate(entry);
      }, timeoutMs);
      entry.hardTimeout.unref?.();
    }

    const collected = await this.collect(entry, {
      yieldMs: clampExecYield(request.yield_time_ms),
      signal: request.__abortSignal,
      maxOutputTokens: request.max_output_tokens,
      onProgress: request.__onProgress,
    });
    request.observer?.onEnd?.({
      callId,
      exitCode: collected.exitCode,
      stdout: collected.stdout,
      stderr: collected.stderr,
      durationMs: collected.durationMs,
      processId,
      sessionId: processId,
      tty,
    });
    if (collected.exitCode !== null || entry.exitState !== null) {
      this.releaseProcessId(processId);
      return collected;
    }
    return {
      ...collected,
      process_id: processId,
      session_id: processId,
    };
  }

  async writeStdin(request: WriteStdinRequest): Promise<ExecCommandToolOutput> {
    const entry = this.processes.get(request.session_id);
    if (!entry) {
      throw new UnifiedExecError(
        "unknown_process",
        `Unknown process id ${request.session_id}`,
      );
    }
    const input = request.chars ?? "";
    if (input.length > 0) {
      if (!entry.tty) {
        throw new UnifiedExecError(
          "stdin_closed",
          "stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
        );
      }
      if (entry.exitState !== null) {
        this.releaseProcessId(entry.processId);
        throw new UnifiedExecError(
          "unknown_process",
          `Unknown process id ${request.session_id}`,
        );
      }
      try {
        if (entry.stored.kind !== "pty") {
          throw new UnifiedExecError(
            "stdin_closed",
            "stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
          );
        }
        entry.stored.process.write(input);
        await delay(100, undefined, { signal: request.__abortSignal });
      } catch (error) {
        if (isAbortError(error)) {
          this.forceTerminate(entry);
        }
        throw error instanceof UnifiedExecError
          ? error
          : new UnifiedExecError("write_stdin", "failed to write to stdin");
      }
    }

    const collected = await this.collect(entry, {
      yieldMs: clampWriteYield(request.yield_time_ms, input),
      signal: request.__abortSignal,
      maxOutputTokens: request.max_output_tokens,
      onProgress: request.__onProgress,
    });
    if (entry.exitState !== null) {
      this.releaseProcessId(entry.processId);
      return collected;
    }
    return {
      ...collected,
      process_id: entry.processId,
      session_id: entry.processId,
    };
  }

  async closeAll(_reason = "session_shutdown"): Promise<void> {
    const entries = [...this.processes.values()];
    for (const entry of entries) {
      this.forceTerminate(entry);
    }
    await Promise.allSettled(
      entries.map((entry) =>
        Promise.race([entry.exitPromise, delay(2_000)]),
      ),
    );
    this.processes.clear();
  }

  private allocateProcessId(): number {
    while (this.processes.has(this.nextProcessId)) {
      this.nextProcessId += 1;
    }
    return this.nextProcessId++;
  }

  private releaseProcessId(processId: number): void {
    const entry = this.processes.get(processId);
    if (entry?.hardTimeout) clearTimeout(entry.hardTimeout);
    this.processes.delete(processId);
  }

  private pruneExitedProcesses(): void {
    for (const [processId, entry] of this.processes) {
      if (entry.exitState !== null) {
        this.releaseProcessId(processId);
      }
    }
  }

  private async loadPty(): Promise<PtyModule> {
    try {
      return await import("@homebridge/node-pty-prebuilt-multiarch");
    } catch (error) {
      throw new UnifiedExecError(
        "create_process",
        `PTY support is unavailable. Install @homebridge/node-pty-prebuilt-multiarch to use tty:true and write_stdin. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async spawnProcess(params: {
    readonly processId: number;
    readonly callId: string;
    readonly command: string;
    readonly shell: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly tty: boolean;
    readonly startedAt: number;
    readonly signal?: AbortSignal;
  }): Promise<ProcessEntry> {
    const output = new ProcessOutputBuffer();
    const abortController = new AbortController();
    const exit = makeDeferredExit();
    const notifyData = (stream: UnifiedExecStream, chunk: string): void => {
      output.append(stream, chunk);
    };
    const entryBase = {
      processId: params.processId,
      command: params.command,
      cwd: params.cwd,
      tty: params.tty,
      startedAt: params.startedAt,
      output,
      callId: params.callId,
      abortController,
      exitPromise: exit.promise,
      resolveExit: exit.resolve,
      exitState: null,
    };
    const complete = (entry: ProcessEntry, state: ExitState): void => {
      if (entry.exitState !== null) return;
      entry.exitState = state;
      entry.resolveExit(state);
    };

    if (params.signal) {
      if (params.signal.aborted) {
        abortController.abort(params.signal.reason);
      } else {
        params.signal.addEventListener(
          "abort",
          () => abortController.abort(params.signal?.reason),
          { once: true },
        );
      }
    }

    if (params.tty) {
      let processHandle: IPty;
      try {
        const pty = await this.loadPty();
        processHandle = pty.spawn(params.shell, [...params.args], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: params.cwd,
          env: buildEnv(this.env),
        });
      } catch (error) {
        throw new UnifiedExecError(
          "create_process",
          error instanceof Error ? error.message : String(error),
        );
      }
      const entry: ProcessEntry = {
        ...entryBase,
        stored: { kind: "pty", process: processHandle },
      };
      processHandle.onData((data) => notifyData("stdout", data));
      processHandle.onExit((event) => {
        complete(entry, { exitCode: event.exitCode, signal: event.signal });
      });
      abortController.signal.addEventListener("abort", () => this.terminate(entry), {
        once: true,
      });
      return entry;
    }

    const child = spawn(params.shell, [...params.args], {
      cwd: params.cwd,
      env: buildEnv(this.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      argv0: basename(params.shell),
    });
    child.stdout.on("data", (data: Buffer) => notifyData("stdout", data.toString("utf8")));
    child.stderr.on("data", (data: Buffer) => notifyData("stderr", data.toString("utf8")));
    const entry: ProcessEntry = {
      ...entryBase,
      stored: { kind: "pipe", process: child },
    };
    child.on("exit", (code, signal) => {
      setTimeout(() => complete(entry, { exitCode: code, signal }), 20).unref?.();
    });
    child.on("error", (error) => {
      notifyData("stderr", error.message);
      complete(entry, { exitCode: 1 });
    });
    abortController.signal.addEventListener("abort", () => this.terminate(entry), {
      once: true,
    });
    child.unref();
    return entry;
  }

  private async collect(
    entry: ProcessEntry,
    options: {
      readonly yieldMs: number;
      readonly signal?: AbortSignal;
      readonly maxOutputTokens?: number;
      readonly onProgress?: (event: UnifiedExecProgressEvent) => void;
    },
  ): Promise<ExecCommandToolOutput> {
    let timedOut = true;
    try {
      const timeout = delay(options.yieldMs, "timeout" as const, {
        signal: options.signal,
      });
      const outcome = await Promise.race([
        timeout,
        entry.exitPromise.then(() => "exit" as const),
      ]);
      timedOut = outcome === "timeout" && entry.exitState === null;
    } catch (error) {
      if (isAbortError(error)) {
        this.forceTerminate(entry);
        await Promise.race([entry.exitPromise, delay(1_000)]);
        timedOut = false;
      } else {
        throw error;
      }
    }

    const chunks = entry.output.drain();
    for (const chunk of chunks) {
      options.onProgress?.({
        stream: chunk.stream,
        chunk: chunk.chunk,
        processId: entry.processId,
      });
    }
    const stdout = chunks
      .filter((chunk) => chunk.stream === "stdout")
      .map((chunk) => chunk.chunk)
      .join("");
    const stderr = chunks
      .filter((chunk) => chunk.stream === "stderr")
      .map((chunk) => chunk.chunk)
      .join("");
    return createResult({
      stdout,
      stderr,
      exitCode: entry.exitState?.exitCode ?? null,
      processId: entry.exitState === null ? entry.processId : undefined,
      durationMs: Date.now() - entry.startedAt,
      timedOut,
      maxOutputTokens: options.maxOutputTokens,
    });
  }

  private forceTerminate(entry: ProcessEntry): void {
    this.terminate(entry, "SIGTERM");
    setTimeout(() => {
      if (entry.exitState === null) {
        this.terminate(entry, "SIGKILL");
      }
    }, 500).unref?.();
  }

  private terminate(entry: ProcessEntry, signal: NodeJS.Signals = "SIGTERM"): void {
    try {
      if (entry.stored.kind === "pty") {
        entry.stored.process.kill();
      } else if (entry.stored.process.pid) {
        if (process.platform !== "win32") {
          try {
            process.kill(-entry.stored.process.pid, signal);
          } catch {
            entry.stored.process.kill(signal);
          }
        } else {
          entry.stored.process.kill(signal);
        }
      }
    } catch {
      // Best-effort shutdown.
    }
  }
}
