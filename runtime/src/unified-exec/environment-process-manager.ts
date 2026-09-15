import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { prepareAdmittedExecutionOperation } from "../execution/call-context.js";
import { assertSameExecutionEnvironment, readExecutionEnvironmentBinding } from "../execution/binding.js";
import { ExecutionEnvironmentError, type ExecutionEnvironment, type ExecutionProcess, type ExecutionProcessReceipt, type ExecutionOperationIdentity } from "../execution/types.js";
import { commandShellArgs, wrapCommandForShell } from "../utils/shell/commandExecution.js";
import { retainCurrentWorkspaceOperation } from "../workspace/tool-operation-lifetime.js";
import { createUnifiedExecResult } from "./format-execution-result.js";
import { ProcessOutputBuffer } from "./process-output-buffer.js";
import { RecoverableUtf8Decoder } from "./recoverable-utf8-decoder.js";
import { executionSpecificationDigest, processRecoveryFailure, readExecutionProcessRecoveryState,
  type ExecutionProcessRecoveryState, type ProcessOutputCursor } from "./process-recovery.js";
import {
  UnifiedExecError, type UnifiedExecManagerOptions, type UnifiedExecProcessManagerLike,
  type ExecCommandRequest, type WriteStdinRequest, type DetachedProcessRequest, type TerminateProcessRequest,
  type UnifiedExecBackgroundProcess, type ManagedProcessInfo, type ExecCommandToolOutput,
} from "./types.js";

interface Entry {
  id?: number;
  readonly taskId: string;
  readonly command: string;
  readonly cwd: string;
  readonly tty: boolean;
  readonly started: number;
  readonly identity: ExecutionOperationIdentity;
  readonly specificationDigest: string;
  readonly timeoutAt?: number;
  readonly output: ProcessOutputBuffer;
  readonly stdout: RecoverableUtf8Decoder;
  readonly stderr: RecoverableUtf8Decoder;
  offset: number;
  delivered: ProcessOutputCursor;
  readonly launched: Promise<ExecutionProcess>;
  readonly finished: Promise<void>;
  readonly finish: () => void;
  readonly cancel: AbortController;
  readonly signal: AbortSignal;
  detachAbort?: () => void;
  process?: ExecutionProcess;
  receipt?: ExecutionProcessReceipt;
  failure?: Error;
  stopped: boolean;
  backgrounded: boolean;
  ended?: number;
  timer?: ReturnType<typeof setTimeout>;
  timedOut: boolean;
  dispatched: boolean;
  termination?: Promise<{ terminated: boolean }>;
  cleanupEstablished?: boolean;
}

function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
function execYield(value: number | undefined): number {
  return Math.min(30000, Math.max(250, Number.isFinite(value) ? Math.floor(value!) : 10000));
}
function writeYield(value: number | undefined, text: string): number {
  const base = Math.max(250, Number.isFinite(value) ? Math.floor(value!) : 250);
  return text.length ? Math.min(30000, base) : Math.min(300000, Math.max(5000, base));
}

/**
 * Unified-exec's backend-owned path. No host spawning, PID signalling, cwd
 * probing, temp-directory injection or controller environment inheritance.
 */
export class EnvironmentProcessManager implements UnifiedExecProcessManagerLike {
  readonly executionEnvironmentBinding: import("../execution/types.js").ExecutionEnvironmentBinding;
  readonly maxTimeoutMs: number;
  private readonly environment: ExecutionEnvironment;
  private readonly cwd: string;
  private readonly shell: string;
  private readonly wrapper: readonly string[];
  private readonly variables: Readonly<Record<string, string>>;
  private readonly maximum: number;
  // Pending launches have only a controller bookkeeping key. Model handles
  // come from the durable host allocation after its original acknowledgement.
  private readonly entries = new Map<string, Entry>();
  private readonly history = new Map<string, UnifiedExecBackgroundProcess>();
  private epoch = 0;
  private paused = false;
  private closed = false;
  private failure?: Error;
  private closing?: Promise<void>;
  private readonly detachedLaunches = new Set<Promise<unknown>>();
  private activeCalls = 0;
  private restoring = false;
  private pristine = true;

  constructor(options: UnifiedExecManagerOptions & { readonly executionEnvironment: ExecutionEnvironment },
    private readonly assertAuthority: () => void = () => {}) {
    this.environment = options.executionEnvironment;
    this.executionEnvironmentBinding = readExecutionEnvironmentBinding(this.environment.binding);
    if (this.environment.binding.kind !== "docker") {
      throw new ExecutionEnvironmentError("unsupported_environment", "This process manager requires a qualified Docker environment", false);
    }
    this.cwd = options.cwd ?? "/";
    if (!posix.isAbsolute(this.cwd) || this.cwd.includes("\0")) throw new UnifiedExecError("create_process", "Task cwd must be absolute");
    this.shell = options.shellPath ?? "/bin/sh";
    this.wrapper = Object.freeze([...(options.commandWrapperArgv ?? [])]);
    this.variables = Object.freeze(Object.fromEntries(Object.entries({ ...options.baseEnv, ...options.env })
      .filter((entry): entry is [string, string] => entry[1] !== undefined)));
    this.maxTimeoutMs = options.maxTimeoutMs ?? Number.POSITIVE_INFINITY;
    this.maximum = options.maxProcesses ?? 64;
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.maxTimeoutMs <= 0) {
      throw new UnifiedExecError("create_process", "Invalid execution process limits");
    }
  }

  private assertOpen(epoch = this.epoch): void {
    this.assertAuthority();
    if (this.closed || this.paused || this.restoring || epoch !== this.epoch || this.failure !== undefined) {
      throw new UnifiedExecError("create_process", "Execution environment admission is closed or its authority changed");
    }
  }
  private assertOwner(ownerId: string | undefined): void {
    if (ownerId !== this.environment.ownerId) throw new UnifiedExecError("owner_denied", "Managed process belongs to another session");
  }
  private complete(entry: Entry): void {
    if (entry.ended !== undefined) return;
    entry.ended = Date.now();
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.detachAbort?.(); entry.detachAbort = undefined;
    entry.finish();
  }

  private async poison(error: unknown): Promise<void> {
    this.failure ??= asError(error);
    this.closed = true; this.paused = true; this.epoch++;
    // The host owner-close fence prevents a delayed request from allocating or
    // claiming after this controller loses its launch acknowledgement.
    this.closing ??= this.environment.close();
    try { await this.closing; }
    catch (cleanup) {
      if (this.failure.cause === undefined) this.failure.cause = cleanup;
    }
  }

  private async track<T>(action: () => Promise<T>): Promise<T> {
    if (this.restoring) throw new ExecutionEnvironmentError("process_recovery_busy", "Managed process recovery is in progress", false);
    this.pristine = false;
    this.activeCalls++;
    try { return await action(); }
    finally { this.activeCalls--; }
  }

  /** The caller must persist this only at a canonical tool-settlement boundary. */
  captureExecutionProcesses(): ExecutionProcessRecoveryState {
    if (this.activeCalls || this.restoring) {
      throw new ExecutionEnvironmentError("process_recovery_busy", "Cannot checkpoint process output before active tool calls settle", false);
    }
    return readExecutionProcessRecoveryState({ version: 1, binding: this.environment.binding,
      ownerId: this.environment.ownerId, authorityRevision: this.environment.authorityRevision,
      admission: this.closed ? "closed" : this.paused ? "paused" : "open",
      ...(this.failure ? { failure: processRecoveryFailure(this.failure) } : {}),
      entries: [...this.entries.values()].filter((entry) => entry.id !== undefined).map((entry) => ({
        sessionId: entry.id!, operationId: entry.process!.operationId, identity: entry.identity,
        specificationDigest: entry.specificationDigest, taskId: entry.taskId, command: entry.command, cwd: entry.cwd,
        tty: entry.tty, startedAt: entry.started, stopped: entry.stopped, timedOut: entry.timedOut,
        ...(entry.timeoutAt === undefined ? {} : { timeoutAt: entry.timeoutAt }),
        ...(entry.failure ? { failure: processRecoveryFailure(entry.failure) } : {}), delivered: entry.delivered,
      })) });
  }

  /** Look up the original receipts. Never launch, resend input/EOF or resize. */
  async restoreExecutionProcesses(value: ExecutionProcessRecoveryState): Promise<void> {
    const state = readExecutionProcessRecoveryState(value);
    assertSameExecutionEnvironment(this.environment.binding, state.binding);
    this.assertOwner(state.ownerId);
    if (state.authorityRevision !== this.environment.authorityRevision) {
      throw new ExecutionEnvironmentError("invalid_authority", "Original process authority revision is unavailable", false);
    }
    this.assertOpen();
    if (!this.pristine || this.activeCalls || this.entries.size || this.history.size) {
      throw new ExecutionEnvironmentError("process_recovery_busy", "Process recovery requires a fresh manager", false);
    }
    if (state.entries.length > this.maximum) throw new UnifiedExecError("process_limit", "Recovery exceeds configured process limits");
    this.pristine = false; this.restoring = true;
    const epoch = this.epoch;
    const restored: Entry[] = [];
    try {
      for (const saved of state.entries) {
        const process = await this.environment.reconnect(saved.identity);
        if (process === undefined || process.sessionId !== saved.sessionId || process.operationId !== saved.operationId ||
            executionSpecificationDigest(process.specification) !== saved.specificationDigest ||
            process.specification.lifetime !== "operation" || process.specification.cwd !== saved.cwd || process.specification.terminal !== saved.tty) {
          throw new ExecutionEnvironmentError("process_recovery_mismatch", "Original managed process receipt is missing or changed", false);
        }
        // Validate the delivered cursor before publishing any of the handles.
        // The host retains output: this observation consumes nothing.
        const receipt = await process.inspect();
        if (receipt.operationId !== saved.operationId) {
          throw new ExecutionEnvironmentError("process_recovery_mismatch", "Original managed process status changed identity", false);
        }
        await process.output(saved.delivered.offset, 1);
        let finish!: () => void;
        const finished = new Promise<void>((resolve) => { finish = resolve; });
        const cancel = new AbortController();
        restored.push({ id: saved.sessionId, taskId: saved.taskId, command: saved.command, cwd: saved.cwd, tty: saved.tty,
          started: saved.startedAt, identity: saved.identity, specificationDigest: saved.specificationDigest,
          ...(saved.timeoutAt === undefined ? {} : { timeoutAt: saved.timeoutAt }),
          output: new ProcessOutputBuffer(undefined, saved.delivered), stdout: new RecoverableUtf8Decoder(saved.delivered.stdoutCarry),
          stderr: new RecoverableUtf8Decoder(saved.delivered.stderrCarry), offset: saved.delivered.offset, delivered: saved.delivered,
          process, receipt, launched: Promise.resolve(process), finished, finish, cancel, signal: cancel.signal,
          stopped: saved.stopped, timedOut: saved.timedOut, dispatched: true, backgrounded: true,
          ...(saved.failure ? { failure: new ExecutionEnvironmentError(saved.failure.code, saved.failure.message, saved.failure.requestSent) } : {}) });
      }
      this.assertAuthority();
      if (epoch !== this.epoch || this.closed) throw new ExecutionEnvironmentError("invalid_authority", "Execution authority changed during recovery", false);
      this.closed = state.admission === "closed";
      this.paused = state.admission !== "open";
      if (state.failure) this.failure = new ExecutionEnvironmentError(state.failure.code, state.failure.message, state.failure.requestSent);
      for (const entry of restored) this.entries.set(entry.taskId, entry);
      for (const entry of restored) {
        void this.pump(entry);
        if (!this.closed) this.armTimeout(entry);
      }
    } catch (error) {
      // A failed lookup is evidence, not permission to replace or terminate the
      // original operation. Admission stays closed pending canonical review.
      this.failure = asError(error); this.closed = true; this.paused = true;
      throw error;
    } finally { this.restoring = false; }
  }

  private armTimeout(entry: Entry): void {
    if (entry.timeoutAt !== undefined && entry.ended === undefined) {
      entry.timer = setTimeout(() => { entry.timedOut = true; void this.stop(entry).catch(() => {}); },
        Math.max(1, Math.min(2147483647, entry.timeoutAt - Date.now())));
    }
  }

  async execCommand(request: ExecCommandRequest): Promise<ExecCommandToolOutput> {
    return this.track(() => this.execCommandInner(request));
  }
  private async execCommandInner(request: ExecCommandRequest): Promise<ExecCommandToolOutput> {
    this.assertOpen(); this.assertOwner(request.ownerId);
    if (typeof request.cmd !== "string" || !request.cmd.trim()) throw new UnifiedExecError("missing_command", "Missing command line");
    if (request.runtimeSandbox !== undefined || request.directInvocation !== undefined) {
      throw new ExecutionEnvironmentError("unsupported_permission_profile", "This task environment requires its qualified full-access permission profile", false);
    }
    this.prune();
    if (this.entries.size >= this.maximum) throw new UnifiedExecError("process_limit", "Too many managed task processes");
    const epoch = this.epoch;
    const dispatch = prepareAdmittedExecutionOperation();
    const cwd = posix.resolve(this.cwd, request.workdir ?? this.cwd);
    const shell = request.shell?.trim() ? request.shell : this.shell;
    const specification = { program: shell, argv: commandShellArgs(shell,
      wrapCommandForShell(shell, this.wrapper, request.cmd), request.login === true),
      cwd, environment: this.variables, terminal: request.tty === true, lifetime: "operation" as const };
    const cancel = new AbortController();
    const signal = AbortSignal.any([dispatch.signal, cancel.signal, ...(request.__abortSignal ? [request.__abortSignal] : [])]);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const releaseWorkspace = retainCurrentWorkspaceOperation();
    void finished.then(releaseWorkspace);
    const launched = Promise.resolve().then(() => this.environment.launch(specification, dispatch.identity, {
      signal, crossEffectBoundary: () => { this.assertOpen(epoch); dispatch.crossEffectBoundary(); entry.dispatched = true; },
    }));
    const started = Date.now();
    const entry: Entry = { taskId: randomUUID(), command: request.cmd, cwd, tty: specification.terminal,
      started, identity: dispatch.identity, specificationDigest: executionSpecificationDigest(specification),
      ...(request.timeoutMs !== undefined && request.timeoutMs > 0
        ? { timeoutAt: started + Math.floor(Math.min(request.timeoutMs, this.maxTimeoutMs, 2147483647)) } : {}),
      output: new ProcessOutputBuffer(), stdout: new RecoverableUtf8Decoder(), stderr: new RecoverableUtf8Decoder(), offset: 0,
      delivered: { offset: 0, stdoutCarry: "", stderrCarry: "", outputBytes: 0, outputTail: "" }, launched, finished, finish,
      cancel, signal, stopped: false, backgrounded: false, timedOut: false, dispatched: false };
    this.entries.set(entry.taskId, entry);
    try {
      entry.process = await launched;
      const id = entry.process.sessionId;
      if (!Number.isSafeInteger(id) || id < 1 || this.find(id) !== undefined) {
        const error = new ExecutionEnvironmentError("host_protocol", "Execution host returned an invalid or reused numeric process handle", true);
        await this.poison(error);
        this.complete(entry);
        throw error;
      }
      entry.id = id;
      const abort = (): void => { void this.stop(entry).catch(() => {}); };
      signal.addEventListener("abort", abort, { once: true });
      entry.detachAbort = () => signal.removeEventListener("abort", abort);
      void this.pump(entry);
      this.armTimeout(entry);
      if (signal.aborted || epoch !== this.epoch || this.closed || this.paused) abort();
      else if (!entry.tty) {
        const input = prepareAdmittedExecutionOperation();
        try { await entry.process.write(input.identity, Buffer.alloc(0), true, { ...input, signal }); }
        catch (error) { if (!(error instanceof ExecutionEnvironmentError && error.code === "stdin_closed")) throw error; }
      }
      request.observer?.onBegin?.({ callId: request.callId ?? dispatch.identity.callId,
        command: entry.command, cwd, processId: id, tty: entry.tty });
      const result = await this.collect(entry, execYield(request.yield_time_ms), request);
      request.observer?.onEnd?.({ callId: request.callId ?? dispatch.identity.callId, exitCode: result.exitCode,
        stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, processId: id, sessionId: id, tty: entry.tty });
      return result;
    } catch (error) {
      entry.failure ??= asError(error);
      entry.backgrounded = true;
      if (entry.process !== undefined) {
        try { await this.stop(entry); }
        catch (cleanup) { entry.failure.cause ??= cleanup; }
      } else {
        const uncertain = error instanceof ExecutionEnvironmentError ? error.requestSent : entry.dispatched;
        if (uncertain) await this.poison(error);
        else entry.cleanupEstablished = true;
        this.complete(entry);
      }
      throw error;
    }
  }

  private async pump(entry: Entry): Promise<void> {
    try {
      for (;;) {
        const receipt = await entry.process!.inspect();
        entry.receipt = receipt;
        const output = await entry.process!.output(entry.offset, 65536);
        entry.offset = output.nextOffset;
        entry.output.append("stdout", entry.stdout.write(output.stdout));
        entry.output.append("stderr", entry.stderr.write(output.stderr));
        if (receipt.failure && !receipt.outputComplete && receipt.cleanupProven) {
          throw new ExecutionEnvironmentError("output_incomplete", receipt.failure, true);
        }
        if (receipt.outputComplete && receipt.cleanupProven && output.stdout.length + output.stderr.length === 0) break;
        if (output.stdout.length + output.stderr.length === 0) await delay(20);
      }
    } catch (error) {
      entry.failure ??= asError(error);
      entry.backgrounded = true;
      await this.poison(error);
    } finally {
      entry.output.append("stdout", entry.stdout.end()); entry.output.append("stderr", entry.stderr.end());
      this.complete(entry);
    }
  }

  private async collect(entry: Entry, yieldMs: number, request: ExecCommandRequest | WriteStdinRequest): Promise<ExecCommandToolOutput> {
    const wait = new AbortController();
    const signal = request.__abortSignal ? AbortSignal.any([wait.signal, request.__abortSignal]) : wait.signal;
    let yielded = false;
    try { yielded = await Promise.race([entry.finished.then(() => false), delay(yieldMs, true, { signal })]); }
    catch (error) {
      if (!request.__abortSignal?.aborted) throw error;
      await this.stop(entry);
      await entry.finished;
    } finally { wait.abort(); }
    if (entry.failure !== undefined) throw entry.failure;
    const parts = entry.output.drain();
    entry.delivered = Object.freeze({ offset: entry.offset, stdoutCarry: entry.stdout.snapshot(), stderrCarry: entry.stderr.snapshot(),
      ...entry.output.snapshot() });
    for (const part of parts) request.__onProgress?.({ ...part, processId: entry.id });
    const result = createUnifiedExecResult({
      stdout: parts.filter((part) => part.stream === "stdout").map((part) => part.chunk).join(""),
      stderr: parts.filter((part) => part.stream === "stderr").map((part) => part.chunk).join(""),
      exitCode: entry.ended === undefined ? null : entry.receipt?.exitCode ?? null,
      ...(entry.ended === undefined ? { processId: entry.id } : {}),
      durationMs: (entry.ended ?? Date.now()) - entry.started, timedOut: entry.timedOut || yielded,
      residualProcessesTerminated: entry.receipt?.cleanupProven && entry.receipt.residualProcessesTerminated,
      maxOutputTokens: request.max_output_tokens,
    });
    if (entry.ended === undefined) entry.backgrounded = true;
    else this.release(entry);
    return result;
  }

  async writeStdin(request: WriteStdinRequest): Promise<ExecCommandToolOutput> {
    return this.track(() => this.writeStdinInner(request));
  }
  private async writeStdinInner(request: WriteStdinRequest): Promise<ExecCommandToolOutput> {
    this.assertOwner(request.ownerId);
    const entry = this.find(request.session_id);
    if (!entry) throw new UnifiedExecError("unknown_process", `Unknown process id ${request.session_id}`);
    if (request.runtimeSandbox !== undefined) throw new UnifiedExecError("write_stdin", "Task input cannot change execution permission profiles");
    const chars = request.chars ?? "";
    if (chars.length) {
      this.assertOpen();
      if (!entry.tty) throw new UnifiedExecError("stdin_closed", "Use tty=true to keep task stdin open");
      if (entry.ended !== undefined) throw new UnifiedExecError("unknown_process", `Process ${entry.id} has finished`);
      const bytes = Buffer.from(chars);
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        const dispatch = prepareAdmittedExecutionOperation();
        const signal = request.__abortSignal ? AbortSignal.any([dispatch.signal, request.__abortSignal]) : dispatch.signal;
        try {
          await entry.process!.write(dispatch.identity, bytes.subarray(offset, offset + 65536), false, {
            signal, crossEffectBoundary: () => { this.assertOpen(); dispatch.crossEffectBoundary(); },
          });
        } catch (error) {
          // The original input identity stays in the supervisor. Do not resend
          // or turn acknowledgement loss into a fresh command or input attempt.
          if (error instanceof ExecutionEnvironmentError && error.code === "unknown_outcome") {
            entry.failure = error; await this.poison(error);
          }
          if (signal.aborted) await this.stop(entry);
          throw error;
        }
      }
    }
    return this.collect(entry, writeYield(request.yield_time_ms, chars), request);
  }

  private stop(entry: Entry): Promise<{ terminated: boolean }> {
    if (entry.cleanupEstablished) return Promise.resolve({ terminated: false });
    if (entry.termination) return entry.termination;
    entry.termination = (async () => {
      try {
        const process = entry.process ?? await entry.launched;
        const result = await process.terminate();
        if (!result.cleanupProven) throw new ExecutionEnvironmentError("cleanup_unproven", "Task command cleanup was not proved", true);
        entry.cleanupEstablished = true;
        if (result.terminated) entry.stopped = true;
        return { terminated: result.terminated };
      } catch (error) {
        if (entry.process === undefined && (!entry.dispatched ||
            (error instanceof ExecutionEnvironmentError && !error.requestSent))) {
          entry.cleanupEstablished = true;
          this.complete(entry);
          return { terminated: false };
        }
        entry.failure ??= asError(error);
        await this.poison(error);
        throw error;
      }
    })();
    return entry.termination;
  }

  async terminateProcess(request: number | TerminateProcessRequest): Promise<{ terminated: boolean }> {
    return this.track(() => this.terminateProcessInner(request));
  }
  private async terminateProcessInner(request: number | TerminateProcessRequest): Promise<{ terminated: boolean }> {
    const id = typeof request === "number" ? request : request.processId;
    const entry = this.find(id);
    if (!entry) return { terminated: false };
    this.assertOwner(typeof request === "number" ? undefined : request.ownerId);
    if (entry.receipt?.cleanupProven && entry.ended !== undefined) return { terminated: false };
    return this.stop(entry);
  }
  listProcesses(ownerId?: string): ManagedProcessInfo[] {
    if (ownerId !== this.environment.ownerId) return [];
    return [...this.entries.values()].filter((entry) => entry.id !== undefined && entry.backgrounded && entry.ended === undefined &&
      !entry.cleanupEstablished && !entry.receipt?.cleanupProven && !entry.failure)
      .map((entry) => ({ session_id: entry.id!, command: entry.command.slice(0, 4096), cwd: entry.cwd.slice(0, 4096),
        tty: entry.tty, started_at: entry.started }));
  }
  private snapshot(entry: Entry): UnifiedExecBackgroundProcess {
    return { taskId: entry.taskId, command: entry.command, cwd: entry.cwd, tty: entry.tty,
      ownerId: this.environment.ownerId, startedAt: entry.started, ...(entry.ended === undefined ? {} : { endedAt: entry.ended }),
      status: entry.failure ? "failed" : entry.ended === undefined ? "running" : entry.stopped ? "killed" : entry.receipt?.exitCode === 0 ? "completed" : "failed",
      ...(entry.receipt?.exitCode == null ? {} : { exitCode: entry.receipt.exitCode }),
      ...(entry.failure === undefined ? {} : { failure: entry.failure.message }), ...entry.output.snapshot() };
  }
  listBackgroundProcesses(): UnifiedExecBackgroundProcess[] {
    return [...[...this.history.values()].map((entry) => ({ ...entry })), ...[...this.entries.values()].filter((entry) => entry.backgrounded).map((entry) => this.snapshot(entry))]
      .sort((left, right) => left.startedAt - right.startedAt);
  }
  async stopBackgroundProcess(taskId: string): Promise<{ stopped: boolean }> {
    return this.track(() => this.stopBackgroundProcessInner(taskId));
  }
  private async stopBackgroundProcessInner(taskId: string): Promise<{ stopped: boolean }> {
    const entry = [...this.entries.values()].find((candidate) => candidate.backgrounded && candidate.taskId === taskId);
    if (!entry || (entry.ended !== undefined && entry.receipt?.cleanupProven)) return { stopped: false };
    return { stopped: (await this.stop(entry)).terminated };
  }
  private release(entry: Entry): void {
    if (entry.backgrounded) {
      this.history.set(entry.taskId, this.snapshot(entry));
      if (this.history.size > 64) this.history.delete(this.history.keys().next().value!);
    }
    this.entries.delete(entry.taskId);
  }
  private find(id: number): Entry | undefined {
    return [...this.entries.values()].find((entry) => entry.id === id);
  }
  private prune(): void {
    for (const entry of this.entries.values()) {
      if (this.entries.size < this.maximum) return;
      if (entry.ended !== undefined && (entry.cleanupEstablished || entry.receipt?.cleanupProven)) this.release(entry);
    }
  }

  quiesce(): void { this.paused = true; this.epoch++; }
  async drain(): Promise<void> {
    this.quiesce();
    const results = await Promise.allSettled([...this.entries.values()].filter((entry) => !entry.receipt?.cleanupProven).map((entry) => this.stop(entry)));
    await Promise.allSettled(this.detachedLaunches);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (this.failure !== undefined) errors.push(this.failure);
    if (errors.length) throw new AggregateError(errors, "Execution environment drain did not establish cleanup");
  }
  resume(): void {
    if (this.closed || this.failure !== undefined) throw new UnifiedExecError("create_process", "Failed environment authority cannot resume");
    this.paused = false; this.epoch++;
  }
  async closeAll(): Promise<void> {
    this.closed = true; this.quiesce();
    if (this.failure === undefined) {
      for (const entry of this.entries.values()) {
        if (entry.ended === undefined && !entry.receipt?.cleanupProven) entry.stopped = true;
      }
    }
    this.closing ??= this.environment.close();
    await this.closing;
    await Promise.allSettled(this.detachedLaunches);
    await Promise.all([...this.entries.values()].map((entry) => entry.finished));
  }
  async startDetachedProcess(request: DetachedProcessRequest): Promise<ExecCommandToolOutput> {
    return this.track(() => this.startDetachedProcessInner(request));
  }
  private async startDetachedProcessInner(request: DetachedProcessRequest): Promise<ExecCommandToolOutput> {
    this.assertOpen(); this.assertOwner(request.ownerId);
    if (typeof request.cmd !== "string" || !request.cmd.trim()) throw new UnifiedExecError("missing_command", "Missing command line");
    const epoch = this.epoch;
    const dispatch = prepareAdmittedExecutionOperation();
    const signal = request.__abortSignal ? AbortSignal.any([dispatch.signal, request.__abortSignal]) : dispatch.signal;
    const cwd = posix.resolve(this.cwd, request.workdir ?? this.cwd);
    const shell = request.shell?.trim() ? request.shell : this.shell;
    const started = Date.now();
    const pending = this.environment.launch({ program: shell, argv: commandShellArgs(shell,
      wrapCommandForShell(shell, this.wrapper, request.cmd), request.login === true),
      cwd, environment: this.variables, terminal: false, lifetime: "environment" }, dispatch.identity, {
      signal, crossEffectBoundary: () => { this.assertOpen(epoch); dispatch.crossEffectBoundary(); },
    });
    this.detachedLaunches.add(pending);
    let process: ExecutionProcess;
    try { process = await pending; }
    catch (error) {
      if (error instanceof ExecutionEnvironmentError && error.requestSent) await this.poison(error);
      throw error;
    } finally { this.detachedLaunches.delete(pending); }
    request.observer?.onBegin?.({ callId: request.callId ?? dispatch.identity.callId, command: request.cmd,
      cwd, processId: process.sessionId, tty: false });
    const yieldDeadline = started + execYield(request.yield_time_ms ?? 2000);
    const startupDeadline = started + 30000;
    let receipt: ExecutionProcessReceipt;
    try {
      for (;;) {
        receipt = await process.inspect();
        const service = receipt.detachedService;
        if (service?.startupState === "failed" && receipt.exitCode !== null) break;
        if (receipt.failure && service?.startupState !== "failed") throw new ExecutionEnvironmentError("unknown_outcome", receipt.failure, true);
        if (service?.startupState === "bootstrap_closed" && (receipt.exitCode !== null ||
            (service.pid !== undefined && (Date.now() >= yieldDeadline || request.__abortSignal?.aborted)))) break;
        if (Date.now() >= startupDeadline) throw new ExecutionEnvironmentError("unknown_outcome", "Detached service startup acknowledgement is unavailable; inspect its original operation", true);
        await delay(20);
      }
      let stdout = "";
      try { stdout = (await process.output(0, 65536)).stdout.toString("utf8"); }
      catch (error) { if (receipt.detachedService?.startupState !== "failed") throw error; }
      const result = createUnifiedExecResult({ stdout, stderr: receipt.detachedService?.error ?? "",
        exitCode: receipt.exitCode, durationMs: Date.now() - started, timedOut: false, maxOutputTokens: request.max_output_tokens,
        detached: { logPath: receipt.detachedService!.logPath,
          ...(receipt.exitCode === null && !receipt.leaderExited && receipt.detachedService?.pid !== undefined
            ? { pid: receipt.detachedService.pid } : {}) } });
      request.observer?.onEnd?.({ callId: request.callId ?? dispatch.identity.callId, exitCode: result.exitCode,
        stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, processId: process.sessionId, tty: false });
      return result;
    } catch (error) {
      await this.poison(error);
      throw error;
    }
  }
}
