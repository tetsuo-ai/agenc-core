import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { basename, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import treeKill from "tree-kill";

import { SandboxManager, type SandboxType } from "../sandbox/engine/index.js";
import {
  approximateTokenCount,
  maxCharsForTokens,
  truncateHeadTail,
} from "./head-tail-buffer.js";
import {
  type ExecCommandRequest,
  type ExecCommandToolOutput,
  type TerminateProcessRequest,
  type UnifiedExecManagerOptions,
  type UnifiedExecProcessManagerLike,
  type UnifiedExecRuntimeSandbox,
  type UnifiedExecSandboxManager,
  type UnifiedExecProgressEvent,
  type UnifiedExecStream,
  type WriteStdinRequest,
  UnifiedExecError,
} from "./types.js";
import { assertProcessOwnerAccess } from "./process-ownership.js";
import { buildScrubbedSpawnEnv } from "./scrub-env.js";
import {
  loadPty as loadRequiredPty,
  type IPty,
  type PtyModule,
} from "../pty/loadPty.js";
import {
  hasCurrentWorkspaceOperationLifetime,
  retainCurrentWorkspaceOperation,
} from "../workspace/tool-operation-lifetime.js";
import {
  signalProcessTree,
  spawnContainedProcess,
  terminateProcessTreeAndWait,
} from "../utils/supervisedProcess.js";
import {
  commandShellArgs,
  wrapCommandForShell,
} from "../utils/shell/commandExecution.js";
import { withChildTempAuthority } from "../utils/subprocessEnv.js";
import { resolveSessionTempRoot } from "../session/runtime-options.js";

const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_TIME_MS = 250;
const MIN_YIELD_TIME_MS = 250;
const MIN_EMPTY_YIELD_TIME_MS = 5_000;
const MAX_YIELD_TIME_MS = 30_000;
const MAX_EMPTY_WRITE_YIELD_TIME_MS = 300_000;
const DEFAULT_MAX_PROCESSES = 64;
const DEFAULT_OUTPUT_BUFFER_CHARS = 1024 * 1024;
const SANDBOX_AUTHORITY_QUIESCE_TIMEOUT_MS = 5_000;
const PTY_ARGV0_EXECVE_SCRIPT =
  "const [program, argv0, ...args] = process.argv.slice(1);" +
  "const execve = process.execve;" +
  "if (typeof execve !== 'function') {" +
  "console.error('PTY argv0 handoff requires process.execve support');" +
  "process.exit(126);" +
  "}" +
  "execve(program, [argv0, ...args], process.env);";

type ExitState = {
  readonly exitCode: number | null;
  readonly signal?: string | number | null;
};

type StoredProcess =
  | { readonly kind: "pty"; readonly process: IPty }
  | { readonly kind: "pipe"; readonly process: ChildProcessWithoutNullStreams };

interface OutputChunk {
  readonly stream: UnifiedExecStream;
  readonly chunk: string;
}

interface SpawnCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly argv0?: string;
}

export class ProcessOutputBuffer {
  private readonly chunks: OutputChunk[] = [];
  private consumedIndex = 0;
  private totalChars = 0;
  /**
   * Test-only counter of expensive pending-collapse passes, so a perf test can
   * assert the O(pending) work is amortized rather than run on every append.
   */
  collapseCountForTest = 0;

  constructor(private readonly maxChars = DEFAULT_OUTPUT_BUFFER_CHARS) {}

  append(stream: UnifiedExecStream, chunk: string): void {
    if (chunk.length === 0) return;
    this.chunks.push({ stream, chunk });
    this.totalChars += chunk.length;
    // Evicting already-consumed chunks is cheap and safe on every append. The
    // expensive pending collapse (slice/filter/join/truncateHeadTail over the
    // whole ~1MB pending region) is amortized: under deferred drain
    // (consumedIndex stays 0) it previously re-ran on every 8KB chunk past the
    // cap, pinning a core for a verbose emitter. Now it runs only once the
    // pending region overshoots by a full cap's worth, then collapses back to
    // the cap — bounding memory at ~2*maxChars and making the collapse amortized
    // O(1) per appended char. drain() still collapses to the cap so a caller
    // never sees more than maxChars.
    this.evictConsumed();
    if (this.totalChars > this.maxChars * 2) {
      this.collapsePending();
    }
  }

  drain(): OutputChunk[] {
    if (this.totalChars > this.maxChars) {
      this.evictConsumed();
      if (this.totalChars > this.maxChars) {
        this.collapsePending();
      }
    }
    const drained = this.chunks.slice(this.consumedIndex);
    this.consumedIndex = this.chunks.length;
    return drained;
  }

  private evictConsumed(): void {
    // Already-consumed chunks were returned to the caller by a prior drain(), so
    // discarding them costs nothing and never needs an omitted-count marker.
    while (
      this.totalChars > this.maxChars &&
      this.consumedIndex > 0 &&
      this.chunks.length > 0
    ) {
      const removed = this.chunks.shift()!;
      this.totalChars -= removed.chunk.length;
      this.consumedIndex -= 1;
    }
  }

  private collapsePending(): void {
    if (this.totalChars <= this.maxChars) return;
    this.collapseCountForTest += 1;

    // The cap is still exceeded by pending (undrained) output. Rather than
    // dropping the most-recent unconsumed bytes wholesale (which previously
    // discarded still-unconsumed HEAD output on a single oversized burst),
    // collapse the pending region with head/tail truncation so both the head
    // and the tail/exit-summary survive, and surface the omitted count.
    const pending = this.chunks.slice(this.consumedIndex);
    if (pending.length === 0) return;

    // The pending region interleaves stdout AND stderr chunks. Collapsing them
    // under a single hard-coded "stdout" label would relabel all stderr bytes
    // as stdout (silently emptying the returned stderr field). Instead, truncate
    // each stream's pending bytes SEPARATELY so each keeps its own head/tail and
    // its own stream label.
    const stdoutText = pending
      .filter((chunk) => chunk.stream === "stdout")
      .map((chunk) => chunk.chunk)
      .join("");
    const stderrText = pending
      .filter((chunk) => chunk.stream === "stderr")
      .map((chunk) => chunk.chunk)
      .join("");

    // Preserve original stream order (stdout before stderr) for deterministic
    // output; only non-empty streams participate.
    const segments: OutputChunk[] = [];
    if (stdoutText.length > 0) {
      segments.push({ stream: "stdout", chunk: stdoutText });
    }
    if (stderrText.length > 0) {
      segments.push({ stream: "stderr", chunk: stderrText });
    }
    if (segments.length === 0) return;
    const totalLen = stdoutText.length + stderrText.length;

    // Allocate the cap across streams with max-min fairness: smallest stream
    // first, each taking an equal share of the remaining budget, with any unused
    // share rolling forward to the larger stream(s). A proportional split would
    // starve a tiny stderr exit-summary when stdout floods past the cap; this
    // keeps the small stream intact (its budget == its length) and gives the
    // overflow budget to whichever stream actually needs truncating.
    const budgetByStream = new Map<UnifiedExecStream, number>();
    const ordered = [...segments].sort(
      (a, b) => a.chunk.length - b.chunk.length,
    );
    let remainingCap = this.maxChars;
    let remaining = ordered.length;
    for (const segment of ordered) {
      const share = Math.floor(remainingCap / remaining);
      const budget = Math.min(segment.chunk.length, share);
      budgetByStream.set(segment.stream, budget);
      remainingCap -= budget;
      remaining -= 1;
    }

    // truncateHeadTail embeds its own `[... omitted N chars ...]` marker inline
    // between the preserved head and tail, so we replace the pending chunks with
    // the per-stream truncated text directly. Clamp each budget to truncateHeadTail's
    // own 64-char floor: passing a smaller budget would make it report a negative
    // omitted count for a sub-64 stream (it never truncates below 64 chars anyway).
    const replacement: OutputChunk[] = [];
    for (const segment of segments) {
      const budget = budgetByStream.get(segment.stream) ?? segment.chunk.length;
      const truncated = truncateHeadTail(segment.chunk, Math.max(64, budget));
      replacement.push({ stream: segment.stream, chunk: truncated.text });
    }

    this.chunks.length = this.consumedIndex;
    this.chunks.push(...replacement);
    const replacementChars = replacement.reduce(
      (sum, chunk) => sum + chunk.chunk.length,
      0,
    );
    this.totalChars = this.totalChars - totalLen + replacementChars;
  }
}

function runtimeSandboxesCompatible(
  active: UnifiedExecRuntimeSandbox | undefined,
  requested: UnifiedExecRuntimeSandbox,
): boolean {
  if (active === undefined) return false;
  return (
    active.sandboxPolicyCwd === requested.sandboxPolicyCwd &&
    active.sessionTempRoot === requested.sessionTempRoot &&
    canonicalPermissionProfile(active.permissionProfile) ===
      canonicalPermissionProfile(requested.permissionProfile) &&
    (active.agencLinuxSandboxExe ?? "") ===
      (requested.agencLinuxSandboxExe ?? "") &&
    (active.preference ?? "require") === (requested.preference ?? "require") &&
    (active.enforceManagedNetwork ?? false) ===
      (requested.enforceManagedNetwork ?? false) &&
    stableStringify(active.network ?? null) ===
      stableStringify(requested.network ?? null) &&
    active.networkPolicyDecider === requested.networkPolicyDecider &&
    active.blockedRequestObserver === requested.blockedRequestObserver &&
    (active.windowsSandboxLevel ?? "disabled") ===
      (requested.windowsSandboxLevel ?? "disabled") &&
    (active.windowsSandboxPrivateDesktop ?? false) ===
      (requested.windowsSandboxPrivateDesktop ?? false)
  );
}

function canonicalPermissionProfile(
  profile: UnifiedExecRuntimeSandbox["permissionProfile"],
): string {
  return stableStringify({
    ...profile,
    fileSystem: {
      ...profile.fileSystem,
      entries: [...profile.fileSystem.entries].sort((left, right) =>
        stableStringify(left).localeCompare(stableStringify(right)),
      ),
    },
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function commandForPtyArgv0(
  program: string,
  args: readonly string[],
  argv0: string | undefined,
): { readonly program: string; readonly args: readonly string[] } {
  if (argv0 === undefined || argv0 === basename(program)) {
    return { program, args };
  }
  return {
    program: process.execPath,
    args: ["-e", PTY_ARGV0_EXECVE_SCRIPT, program, argv0, ...args],
  };
}

interface ProcessEntry {
  readonly processId: number;
  readonly command: string;
  readonly cwd: string;
  readonly tty: boolean;
  readonly runtimeSandbox?: UnifiedExecRuntimeSandbox;
  /** Conversation/agent that started this process (TOOL-01 isolation). */
  readonly ownerId?: string;
  readonly startedAt: number;
  readonly output: ProcessOutputBuffer;
  readonly stored: StoredProcess;
  readonly callId: string;
  readonly abortController: AbortController;
  readonly exitPromise: Promise<ExitState>;
  resolveExit: (state: ExitState) => void;
  exitState: ExitState | null;
  cleanupFailure?: Error;
  hardTimeout?: NodeJS.Timeout;
  // gaphunt3 #44: removes the upstream-abort listener attached to the (long-lived,
  // session-scoped) source signal so it is cleaned up on normal exit, not only on abort.
  detachUpstreamAbort?: () => void;
}

declare const unifiedExecSandboxAuthorityQuiesceBrand: unique symbol;

/** Opaque generation token for one sandbox-authority quiesce cycle. */
export interface UnifiedExecSandboxAuthorityQuiesceToken {
  readonly [unifiedExecSandboxAuthorityQuiesceBrand]: never;
  readonly generation: number;
}

function enforceOwnerAccess(
  entry: ProcessEntry,
  requestOwnerId: string | undefined,
): void {
  const decision = assertProcessOwnerAccess({
    entryOwnerId: entry.ownerId,
    requestOwnerId,
  });
  if (!decision.ok) {
    throw new UnifiedExecError("owner_denied", decision.reason);
  }
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

function resolveShell(shell: string | undefined, fallback: string): string {
  if (shell && shell.trim().length > 0) return shell;
  return fallback;
}

/** SEC-01: never pass raw process.env (API keys) into shell children. */
function buildEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  env: Record<string, string> | undefined,
): Record<string, string> {
  return buildScrubbedSpawnEnv(env, baseEnv);
}

function clampExecYield(value: number | undefined): number {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : DEFAULT_EXEC_YIELD_TIME_MS;
  return Math.min(
    MAX_YIELD_TIME_MS,
    Math.max(MIN_YIELD_TIME_MS, Math.floor(raw)),
  );
}

function clampWriteYield(value: number | undefined, input: string): number {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : DEFAULT_WRITE_STDIN_YIELD_TIME_MS;
  const base = Math.max(MIN_YIELD_TIME_MS, Math.floor(raw));
  if (input.length === 0) {
    return Math.min(
      MAX_EMPTY_WRITE_YIELD_TIME_MS,
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
  const output = [stdout.text, stderr.text]
    .filter((part) => part.length > 0)
    .join("");
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
  private readonly baseEnv: Readonly<Record<string, string | undefined>>;
  private readonly sessionTempRoot: string;
  private readonly shellPath: string;
  private readonly commandWrapperArgv: readonly string[];
  private readonly maxProcesses: number;
  private readonly sandboxManager: UnifiedExecSandboxManager;
  private readonly sandboxAuthorityQuiesceTimeoutMs: number;
  private nextProcessId = 1;
  private readonly processes = new Map<number, ProcessEntry>();
  private sandboxAuthorityGeneration = 0;
  private sandboxAuthorityQuiesced = false;
  private sandboxAuthorityCleanupFailure: Error | undefined;
  private activeSandboxAuthorityQuiesce:
    | UnifiedExecSandboxAuthorityQuiesceToken
    | undefined;

  constructor(options: UnifiedExecManagerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env === undefined
      ? undefined
      : Object.freeze({ ...options.env });
    this.baseEnv = Object.freeze({ ...(options.baseEnv ?? process.env) });
    this.sessionTempRoot = options.sessionTempRoot ?? resolveSessionTempRoot();
    this.shellPath = options.shellPath ??
      (process.platform === "win32" ? "cmd.exe" : "/bin/bash");
    this.commandWrapperArgv = Object.freeze([
      ...(options.commandWrapperArgv ?? []),
    ]);
    this.maxTimeoutMs = options.maxTimeoutMs ?? Number.POSITIVE_INFINITY;
    this.maxProcesses = options.maxProcesses ?? DEFAULT_MAX_PROCESSES;
    this.sandboxManager = options.sandboxManager ?? new SandboxManager();
    this.sandboxAuthorityQuiesceTimeoutMs =
      options.sandboxAuthorityQuiesceTimeoutMs ??
      SANDBOX_AUTHORITY_QUIESCE_TIMEOUT_MS;
    if (
      !Number.isFinite(this.sandboxAuthorityQuiesceTimeoutMs) ||
      this.sandboxAuthorityQuiesceTimeoutMs <= 0
    ) {
      throw new Error(
        "unified exec sandbox-authority quiesce timeout must be finite and positive",
      );
    }
  }

  /** Close command admission synchronously before a lifecycle drain begins. */
  beginSandboxAuthorityQuiesce(): UnifiedExecSandboxAuthorityQuiesceToken {
    if (this.sandboxAuthorityCleanupFailure !== undefined) {
      throw new AggregateError(
        [this.sandboxAuthorityCleanupFailure],
        "unified exec process cleanup is unproven",
        { cause: this.sandboxAuthorityCleanupFailure },
      );
    }
    if (this.sandboxAuthorityQuiesced) {
      throw new Error("unified exec sandbox authority is already quiesced");
    }
    this.sandboxAuthorityGeneration += 1;
    this.sandboxAuthorityQuiesced = true;
    const token = Object.freeze({
      generation: this.sandboxAuthorityGeneration,
    }) as UnifiedExecSandboxAuthorityQuiesceToken;
    this.activeSandboxAuthorityQuiesce = token;
    return token;
  }

  /** Stop every admitted process and retain any entry whose cleanup is unproven. */
  async finishSandboxAuthorityQuiesce(
    token: UnifiedExecSandboxAuthorityQuiesceToken,
  ): Promise<void> {
    this.assertActiveSandboxAuthorityQuiesce(token);
    const entries = [...this.processes.values()];
    const results = await Promise.allSettled(
      entries.map((entry) => this.closeProcessStrict(entry)),
    );
    const errors: unknown[] = [];
    for (const [index, result] of results.entries()) {
      const entry = entries[index];
      if (entry === undefined) continue;
      if (result.status === "fulfilled") {
        this.releaseProcessId(entry.processId);
      } else {
        errors.push(result.reason);
      }
    }
    if (errors.length === 0) return;
    const primary = errors[0];
    const failure = new AggregateError(
      errors,
      "unified exec sandbox-authority quiesce could not prove process-tree cleanup",
      primary === undefined ? undefined : { cause: primary },
    );
    this.poisonSandboxAuthority(failure);
    throw failure;
  }

  /** Reopen admission only for the exact successfully-drained generation. */
  resumeSandboxAuthorityAfterQuiesce(
    token: UnifiedExecSandboxAuthorityQuiesceToken,
  ): void {
    this.assertActiveSandboxAuthorityQuiesce(token);
    if (this.sandboxAuthorityCleanupFailure !== undefined) {
      throw new AggregateError(
        [this.sandboxAuthorityCleanupFailure],
        "unified exec sandbox authority remains closed after cleanup failure",
        { cause: this.sandboxAuthorityCleanupFailure },
      );
    }
    this.activeSandboxAuthorityQuiesce = undefined;
    this.sandboxAuthorityGeneration += 1;
    this.sandboxAuthorityQuiesced = false;
  }

  async execCommand(
    request: ExecCommandRequest,
  ): Promise<ExecCommandToolOutput> {
    const sandboxAuthorityGeneration = this.assertSandboxAuthorityAdmission();
    if (request.cmd.trim().length === 0) {
      throw new UnifiedExecError(
        "missing_command",
        "missing command line for unified exec request",
      );
    }
    this.pruneExitedProcesses();
    if (this.processes.size >= this.maxProcesses) {
      throw new UnifiedExecError(
        "process_limit",
        `too many live unified exec processes (${this.processes.size}/${this.maxProcesses})`,
      );
    }
    const tty = request.tty === true;
    if (tty && hasCurrentWorkspaceOperationLifetime()) {
      throw new UnifiedExecError(
        "create_process",
        "tty=true execution is blocked while an Editor workspace fence is active because PTY descendants cannot be contained safely",
      );
    }

    const processId = this.allocateProcessId();
    const cwd = resolve(request.workdir ?? this.cwd);
    const shell = resolveShell(request.shell, this.shellPath);
    const command = wrapCommandForShell(
      shell,
      this.commandWrapperArgv,
      request.cmd,
    );
    const args = commandShellArgs(shell, command, request.login === true);
    const spawnCommand = this.buildSpawnCommand({
      program: shell,
      args,
      cwd,
      env: buildEnv(this.baseEnv, this.env),
      ...(request.runtimeSandbox !== undefined
        ? { runtimeSandbox: request.runtimeSandbox }
        : {}),
    });
    const startedAt = Date.now();
    const callId = request.callId ?? `exec-${processId}`;
    const ownerId =
      typeof request.ownerId === "string" && request.ownerId.trim().length > 0
        ? request.ownerId.trim()
        : undefined;
    const entry = await this.spawnProcess({
      processId,
      callId,
      command: request.cmd,
      program: spawnCommand.program,
      args: spawnCommand.args,
      cwd: spawnCommand.cwd,
      env: spawnCommand.env,
      ...(request.runtimeSandbox !== undefined
        ? { runtimeSandbox: request.runtimeSandbox }
        : {}),
      ...(spawnCommand.argv0 !== undefined
        ? { argv0: spawnCommand.argv0 }
        : {}),
      ...(ownerId !== undefined ? { ownerId } : {}),
      tty,
      startedAt,
      signal: request.__abortSignal,
      sandboxAuthorityGeneration,
    });
    const releaseWorkspaceOperation = retainCurrentWorkspaceOperation();
    void entry.exitPromise.then(
      releaseWorkspaceOperation,
      releaseWorkspaceOperation,
    );
    request.observer?.onBegin?.({
      callId,
      command: request.cmd,
      cwd: spawnCommand.cwd,
      processId,
      tty,
    });

    // A hard timeout is opt-in. Yielding a process must not silently
    // create a lifetime limit: agents may legitimately keep terminal
    // work alive for hours and return to it through write_stdin.
    const explicitTimeoutMs =
      request.timeoutMs !== undefined && request.timeoutMs > 0
        ? Math.min(request.timeoutMs, this.maxTimeoutMs)
        : null;
    if (explicitTimeoutMs !== null) {
      entry.hardTimeout = setTimeout(() => {
        this.forceTerminate(entry);
      }, explicitTimeoutMs);
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
    this.assertSandboxAuthorityAdmission();
    const entry = this.processes.get(request.session_id);
    if (!entry) {
      throw new UnifiedExecError(
        "unknown_process",
        `Unknown process id ${request.session_id}`,
      );
    }
    enforceOwnerAccess(entry, request.ownerId);
    const input = request.chars ?? "";
    if (
      request.runtimeSandbox !== undefined &&
      !runtimeSandboxesCompatible(entry.runtimeSandbox, request.runtimeSandbox)
    ) {
      throw new UnifiedExecError(
        "write_stdin",
        "write_stdin requires an existing session with a compatible sandbox profile",
      );
    }
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

  /**
   * Terminate one live background process by id (the model-facing
   * kill half of the run-in-background / poll / kill trio). Unknown or
   * already-exited ids report `terminated: false` rather than throwing —
   * killing a finished process is a benign race, not an error.
   * Ownership mismatches throw `owner_denied` (TOOL-01).
   */
  terminateProcess(processIdOrRequest: number | TerminateProcessRequest): {
    terminated: boolean;
  } {
    const processId =
      typeof processIdOrRequest === "number"
        ? processIdOrRequest
        : processIdOrRequest.processId;
    const ownerId =
      typeof processIdOrRequest === "number"
        ? undefined
        : processIdOrRequest.ownerId;
    const entry = this.processes.get(processId);
    if (!entry || entry.exitState !== null) {
      return { terminated: false };
    }
    enforceOwnerAccess(entry, ownerId);
    this.forceTerminate(entry);
    return { terminated: true };
  }

  async closeAll(_reason = "session_shutdown"): Promise<void> {
    const entries = [...this.processes.values()];
    for (const entry of entries) {
      this.forceTerminate(entry);
    }
    await Promise.allSettled(
      entries.map((entry) => Promise.race([entry.exitPromise, delay(2_000)])),
    );
    this.processes.clear();
  }

  private assertSandboxAuthorityAdmission(expectedGeneration?: number): number {
    if (
      this.sandboxAuthorityCleanupFailure !== undefined ||
      this.sandboxAuthorityQuiesced ||
      (expectedGeneration !== undefined &&
        expectedGeneration !== this.sandboxAuthorityGeneration)
    ) {
      throw new UnifiedExecError(
        "create_process",
        this.sandboxAuthorityCleanupFailure === undefined
          ? "unified exec is quiesced while sandbox runtime authority changes"
          : "unified exec is permanently closed because process-tree cleanup could not be proven",
      );
    }
    return this.sandboxAuthorityGeneration;
  }

  private assertActiveSandboxAuthorityQuiesce(
    token: UnifiedExecSandboxAuthorityQuiesceToken,
  ): void {
    if (
      !this.sandboxAuthorityQuiesced ||
      this.activeSandboxAuthorityQuiesce !== token ||
      token.generation !== this.sandboxAuthorityGeneration
    ) {
      throw new Error("unified exec sandbox-authority quiesce token is stale");
    }
  }

  private poisonSandboxAuthority(error: Error): void {
    this.sandboxAuthorityCleanupFailure ??= error;
    this.sandboxAuthorityQuiesced = true;
    this.sandboxAuthorityGeneration += 1;
    for (const entry of this.processes.values()) {
      this.forceTerminate(entry);
    }
  }

  private async closeProcessStrict(entry: ProcessEntry): Promise<void> {
    if (entry.cleanupFailure !== undefined) throw entry.cleanupFailure;
    const ptyTermination =
      entry.stored.kind === "pty"
        ? this.terminatePtyStrict(entry)
        : Promise.resolve();
    this.forceTerminate(entry);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `unified exec process ${entry.processId} cleanup exceeded ${this.sandboxAuthorityQuiesceTimeoutMs}ms`,
          ),
        );
      }, this.sandboxAuthorityQuiesceTimeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([
        Promise.all([ptyTermination, entry.exitPromise]).then(() => {}),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (entry.cleanupFailure !== undefined) throw entry.cleanupFailure;
    if (entry.exitState === null) {
      throw new Error(
        `unified exec process ${entry.processId} exit was not proven`,
      );
    }
  }

  private terminatePtyStrict(entry: ProcessEntry): Promise<void> {
    if (entry.stored.kind !== "pty") return Promise.resolve();
    const processHandle = entry.stored.process;
    const pid = processHandle.pid;
    if (!Number.isInteger(pid) || pid <= 1) {
      try {
        processHandle.kill("SIGKILL");
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise<void>((resolvePromise, reject) => {
      treeKill(pid, "SIGKILL", (error) => {
        if (error !== undefined && entry.exitState === null) {
          reject(error);
          return;
        }
        resolvePromise();
      });
    });
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
    // gaphunt3 #44: ensure the upstream-abort listener is removed when a slot is
    // released, even if the entry never reached complete() (idempotent).
    entry?.detachUpstreamAbort?.();
    if (entry) entry.detachUpstreamAbort = undefined;
    this.processes.delete(processId);
  }

  private pruneExitedProcesses(): void {
    // Reclaim slots from EXITED processes ONLY when at/over the cap, oldest first.
    // Do NOT release an exited process just because a new exec_command ran: a
    // background command that has exited but has not yet been polled must survive
    // so its final buffered output + exit code can still be retrieved (the
    // start -> do other exec work -> poll workflow). Unconditional pruning here
    // silently dropped that output and made the poll throw "unknown_process".
    // Drained results are already deleted at their delivery point, so this only
    // affects still-buffered, un-polled exits — and only under slot pressure.
    if (this.processes.size < this.maxProcesses) return;
    const exitedOldestFirst = [...this.processes.entries()]
      .filter(([, entry]) => entry.exitState !== null)
      .sort((a, b) => a[1].startedAt - b[1].startedAt);
    for (const [processId] of exitedOldestFirst) {
      if (this.processes.size < this.maxProcesses) break;
      this.releaseProcessId(processId);
    }
  }

  private async loadPty(): Promise<PtyModule> {
    try {
      return loadRequiredPty();
    } catch (error) {
      throw new UnifiedExecError(
        "create_process",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async spawnProcess(params: {
    readonly processId: number;
    readonly callId: string;
    readonly command: string;
    readonly program: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly runtimeSandbox?: UnifiedExecRuntimeSandbox;
    readonly ownerId?: string;
    readonly argv0?: string;
    readonly tty: boolean;
    readonly startedAt: number;
    readonly signal?: AbortSignal;
    readonly sandboxAuthorityGeneration: number;
  }): Promise<ProcessEntry> {
    this.assertSandboxAuthorityAdmission(params.sandboxAuthorityGeneration);
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
      ...(params.runtimeSandbox !== undefined
        ? { runtimeSandbox: params.runtimeSandbox }
        : {}),
      ...(params.ownerId !== undefined ? { ownerId: params.ownerId } : {}),
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
      // gaphunt3 #44: the process settled — drop the upstream-abort listener so
      // it does not survive (the normal-exit path the `{ once: true }` never covered).
      entry.detachUpstreamAbort?.();
      entry.detachUpstreamAbort = undefined;
      entry.resolveExit(state);
    };

    // gaphunt3 #44: capture the upstream-abort listener and a disposer so it can
    // be removed when the process settles. The previous `{ once: true }` only
    // auto-removed the listener on the abort path; on the (overwhelmingly common)
    // normal-exit path it was never removed, leaking one dead listener per command
    // on the long-lived session-scoped source signal.
    let detachUpstreamAbort: (() => void) | undefined;
    if (params.signal) {
      if (params.signal.aborted) {
        abortController.abort(params.signal.reason);
      } else {
        const sourceSignal = params.signal;
        const onUpstreamAbort = (): void =>
          abortController.abort(sourceSignal.reason);
        sourceSignal.addEventListener("abort", onUpstreamAbort, { once: true });
        detachUpstreamAbort = () => {
          sourceSignal.removeEventListener("abort", onUpstreamAbort);
        };
      }
    }

    if (params.tty) {
      let processHandle: IPty;
      try {
        const pty = await this.loadPty();
        const ptyCommand = commandForPtyArgv0(
          params.program,
          params.args,
          params.argv0,
        );
        this.assertSandboxAuthorityAdmission(
          params.sandboxAuthorityGeneration,
        );
        processHandle = pty.spawn(ptyCommand.program, [...ptyCommand.args], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: params.cwd,
          env: params.env,
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
        // gaphunt3 #44: thread the upstream-abort disposer onto the entry.
        ...(detachUpstreamAbort !== undefined ? { detachUpstreamAbort } : {}),
      };
      processHandle.onData((data) =>
        notifyData(
          "stdout",
          Buffer.isBuffer(data) ? data.toString("utf8") : data,
        ),
      );
      processHandle.onExit((event) => {
        complete(entry, { exitCode: event.exitCode, signal: event.signal });
      });
      this.attachAbortTermination(entry);
      this.processes.set(params.processId, entry);
      return entry;
    }

    this.assertSandboxAuthorityAdmission(params.sandboxAuthorityGeneration);
    const child = spawnContainedProcess(params.program, params.args, {
      cwd: params.cwd,
      env: params.env,
      argv0: params.argv0 ?? basename(params.program),
    });
    child.stdin.end();
    child.stdout.on("data", (data: Buffer) =>
      notifyData("stdout", data.toString("utf8")),
    );
    child.stderr.on("data", (data: Buffer) =>
      notifyData("stderr", data.toString("utf8")),
    );
    const entry: ProcessEntry = {
      ...entryBase,
      stored: { kind: "pipe", process: child },
      // gaphunt3 #44: thread the upstream-abort disposer onto the entry.
      ...(detachUpstreamAbort !== undefined ? { detachUpstreamAbort } : {}),
    };
    let settlementStarted = false;
    const settleContainedProcess = (
      state: ExitState,
      spawnError?: Error,
    ): void => {
      if (settlementStarted) return;
      settlementStarted = true;
      setTimeout(() => {
        void terminateProcessTreeAndWait(child, {
          label: `exec_command process ${params.processId}`,
        }).then(
          () => {
            if (spawnError !== undefined) {
              notifyData("stderr", spawnError.message);
            }
            complete(entry, state);
          },
          (error) => {
            const cleanupFailure =
              error instanceof Error ? error : new Error(String(error));
            entry.cleanupFailure = cleanupFailure;
            this.poisonSandboxAuthority(cleanupFailure);
            notifyData(
              "stderr",
              `AgenC could not verify descendant process cleanup: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            complete(entry, {
              exitCode: state.exitCode === 0 ? 1 : state.exitCode,
              signal: state.signal,
            });
          },
        );
      }, 20).unref?.();
    };
    child.on("exit", (code, signal) => {
      settleContainedProcess({ exitCode: code, signal });
    });
    child.on("error", (error) => {
      settleContainedProcess({ exitCode: 1 }, error);
    });
    this.attachAbortTermination(entry);
    this.processes.set(params.processId, entry);
    child.unref();
    return entry;
  }

  private attachAbortTermination(entry: ProcessEntry): void {
    const terminate = (): void => {
      this.forceTerminate(entry);
    };
    entry.abortController.signal.addEventListener("abort", terminate, {
      once: true,
    });
    if (entry.abortController.signal.aborted) {
      terminate();
    }
  }

  private buildSpawnCommand(params: {
    readonly program: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly runtimeSandbox?: UnifiedExecRuntimeSandbox;
  }): SpawnCommand {
    const sessionTempRoot =
      params.runtimeSandbox?.sessionTempRoot ?? this.sessionTempRoot;
    if (params.runtimeSandbox === undefined) {
      return {
        program: params.program,
        args: params.args,
        cwd: params.cwd,
        env: withChildTempAuthority(params.env, sessionTempRoot),
        argv0: basename(params.program),
      };
    }

    const permissions = params.runtimeSandbox.permissionProfile;
    const windowsSandboxLevel =
      params.runtimeSandbox.windowsSandboxLevel ?? "disabled";
    let sandbox: SandboxType = "none";
    try {
      sandbox = this.sandboxManager.selectInitial({
        fileSystemPolicy: permissions.fileSystem,
        networkPolicy: permissions.network,
        preference: params.runtimeSandbox.preference ?? "require",
        windowsSandboxLevel,
        hasManagedNetworkRequirements:
          params.runtimeSandbox.enforceManagedNetwork === true ||
          params.runtimeSandbox.network !== undefined,
      });
      if (
        sandbox === "none" &&
        (params.runtimeSandbox.preference ?? "require") === "require"
      ) {
        throw new UnifiedExecError(
          "create_process",
          "sandbox isolation was required for exec_command but no platform sandbox is available",
        );
      }
      const transformed = this.sandboxManager.transform({
        command: {
          program: params.program,
          args: params.args,
          cwd: params.cwd,
          env: params.env,
          ...(params.runtimeSandbox.additionalPermissions !== undefined
            ? {
                additionalPermissions:
                  params.runtimeSandbox.additionalPermissions,
              }
            : {}),
        },
        permissions,
        sandbox,
        enforceManagedNetwork:
          params.runtimeSandbox.enforceManagedNetwork ?? false,
        ...(params.runtimeSandbox.network !== undefined
          ? { network: params.runtimeSandbox.network }
          : {}),
        ...(params.runtimeSandbox.networkPolicyDecider !== undefined
          ? { networkPolicyDecider: params.runtimeSandbox.networkPolicyDecider }
          : {}),
        ...(params.runtimeSandbox.blockedRequestObserver !== undefined
          ? {
              blockedRequestObserver:
                params.runtimeSandbox.blockedRequestObserver,
            }
          : {}),
        sandboxPolicyCwd: params.runtimeSandbox.sandboxPolicyCwd,
        sessionTempRoot: params.runtimeSandbox.sessionTempRoot,
        ...(params.runtimeSandbox.agencLinuxSandboxExe !== undefined
          ? { agencLinuxSandboxExe: params.runtimeSandbox.agencLinuxSandboxExe }
          : {}),
        windowsSandboxLevel,
        windowsSandboxPrivateDesktop:
          params.runtimeSandbox.windowsSandboxPrivateDesktop ?? false,
        ...(params.runtimeSandbox.allowGpu === true ? { allowGpu: true } : {}),
      });
      const [program, ...args] = transformed.command;
      if (program === undefined) {
        throw new UnifiedExecError(
          "create_process",
          "sandbox transform returned an empty command",
        );
      }
      return {
        program,
        args,
        cwd: transformed.cwd,
        env: withChildTempAuthority(transformed.env, sessionTempRoot),
        argv0: transformed.arg0 ?? basename(program),
      };
    } catch (error) {
      if (error instanceof UnifiedExecError) throw error;
      throw new UnifiedExecError(
        "create_process",
        error instanceof Error ? error.message : String(error),
      );
    }
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

  private terminate(
    entry: ProcessEntry,
    signal: NodeJS.Signals = "SIGTERM",
  ): void {
    try {
      if (entry.stored.kind === "pty") {
        this.terminatePty(entry.stored.process, signal);
      } else {
        signalProcessTree(
          entry.stored.process,
          signal === "SIGKILL" ? "SIGKILL" : "SIGTERM",
        );
      }
    } catch {
      // Best-effort shutdown.
    }
  }

  private terminatePty(processHandle: IPty, signal: NodeJS.Signals): void {
    const killPty = (): void => {
      try {
        processHandle.kill(signal);
      } catch {
        // Best-effort shutdown.
      }
    };
    const pid = processHandle.pid;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        treeKill(pid, signal, () => {
          killPty();
        });
        return;
      } catch {
        // Fall back to the PTY handle below.
      }
    }
    killPty();
  }
}
