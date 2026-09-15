import { expect, it, vi } from "vitest";
import { withAdmittedExecutionCall } from "../../src/execution/call-context.js";
import { ExecutionEnvironmentError, type ExecutionEnvironment, type ExecutionProcess, type ExecutionProcessSpecification,
  type ExecutionOperationIdentity, type ExecutionFilesystem, type ExecutionProcessReceipt } from "../../src/execution/types.js";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import * as localSpawning from "../../src/utils/supervisedProcess.js";

const owner = "environment-owner";
const binding = { kind: "docker" as const, containerId: "a".repeat(64), generation: "b".repeat(64), processHandleNamespace: "e".repeat(32) };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
class ProcessFixture implements ExecutionProcess {
  readonly operationId: string;
  readonly outputParts: { stdout: Buffer; stderr: Buffer }[] = [];
  done = false;
  cleanup = false;
  leader = false;
  failure: string | undefined;
  residualProcessesTerminated = false;
  exitCode: number | null = null;
  stopGate?: Promise<void>;
  detachedService?: ExecutionProcessReceipt["detachedService"];
  constructor(readonly specification: ExecutionProcessSpecification, readonly sessionId: number) {
    this.operationId = sessionId === 10001 ? "d".repeat(32) : sessionId.toString(16).padStart(32, "0");
    if (specification.lifetime === "environment") this.detachedService = {
      logPath: "/tmp/agenc-detached-" + this.operationId + ".log", startupState: "bootstrap_closed", pid: 4321,
    };
  }
  emit(stdout: Buffer | string, stderr: Buffer | string = "") {
    this.outputParts.push({ stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
  }
  finish(code = 0) { this.leader = true; this.cleanup = true; this.done = true; this.exitCode = code; }
  inspect = vi.fn(async () => ({ operationId: this.operationId, leaderExited: this.leader,
    outputComplete: this.done, cleanupProven: this.cleanup, exitCode: this.exitCode,
    ...(this.residualProcessesTerminated ? { residualProcessesTerminated: true } : {}),
    ...(this.detachedService === undefined ? {} : { detachedService: this.detachedService }),
    ...(this.failure ? { failure: this.failure } : {}) }));
  output = vi.fn(async (offset: number, maximum = 65536) => {
    let start = 0;
    for (const part of this.outputParts) {
      for (const stream of ["stdout", "stderr"] as const) {
        if (part[stream].length === 0) continue;
        if (!this.specification.terminal && this.specification.lifetime === "operation") start += 8;
        const end = start + part[stream].length;
        if (offset < end) {
          const begin = Math.max(offset, start);
          const bytes = part[stream].subarray(begin - start, Math.min(end - start, begin - start + maximum));
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), [stream]: bytes, nextOffset: begin + bytes.length };
        }
        start = end;
      }
    }
    if (offset > start) throw new ExecutionEnvironmentError("invalid_cursor", "Offset exceeds original output", false);
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), nextOffset: offset };
  });
  write = vi.fn(async (_identity: ExecutionOperationIdentity, _bytes: Buffer, _eof?: boolean,
    dispatch?: { readonly signal: AbortSignal; readonly crossEffectBoundary: () => void }) => {
    if (dispatch?.signal.aborted) throw new ExecutionEnvironmentError("aborted", "cancelled before input", false);
    dispatch?.crossEffectBoundary();
  });
  resize = vi.fn(async () => {});
  terminate = vi.fn(async () => {
    await this.stopGate;
    const terminated = !this.cleanup;
    if (terminated) { this.emit("final output\n"); this.finish(137); }
    return { terminated, cleanupProven: true };
  });
}
class EnvironmentFixture implements ExecutionEnvironment {
  readonly binding = binding;
  readonly ownerId = owner;
  readonly authorityRevision = 0;
  readonly processHandleNamespace = "e".repeat(32);
  readonly filesystem = {} as ExecutionFilesystem;
  readonly processes: ProcessFixture[] = [];
  launchGate?: Promise<void>;
  lostAck = false;
  onLaunch?: (process: ProcessFixture) => void;
  launch = vi.fn(async (spec: ExecutionProcessSpecification, _identity: ExecutionOperationIdentity,
    dispatch?: { readonly signal: AbortSignal; readonly crossEffectBoundary: () => void }) => {
    await this.launchGate;
    dispatch?.crossEffectBoundary();
    const process = new ProcessFixture(spec, 10001 + this.processes.length);
    this.processes.push(process); this.onLaunch?.(process);
    if (this.lostAck) throw new ExecutionEnvironmentError("unknown_outcome", "lost launch ack", true);
    return process;
  });
  reconnect = vi.fn(async () => this.processes[0]);
  close = vi.fn(async () => { for (const process of this.processes) { if (!process.done && process.specification.lifetime !== "environment") process.finish(137); } });
}
function admitted<T>(callId: string, action: () => Promise<T>, signal = new AbortController().signal) {
  return withAdmittedExecutionCall({ runId: "run", callId, attempt: 1 }, { signal, crossEffectBoundary: () => {} }, action);
}

it("routes the public manager through its environment without host spawning or ambient environment inheritance", async () => {
  const environment = new EnvironmentFixture();
  environment.onLaunch = (process) => {
    process.emit(Buffer.from([0xe2])); process.emit(Buffer.from([0x82, 0xac]), "stderr"); process.finish();
  };
  const hostSpawn = vi.spyOn(localSpawning, "spawnContainedProcess");
  const manager = new UnifiedExecProcessManager({ executionEnvironment: environment, cwd: "/app", env: { ONLY: "explicit" } });
  try {
    const result = await admitted("execute", () => manager.execCommand({ ownerId: owner, cmd: "printf text", workdir: "nested", yield_time_ms: 250 }));
    expect(result).toMatchObject({ stdout: "€", stderr: "stderr", exit_code: 0 });
    expect(environment.launch.mock.calls[0][0]).toMatchObject({ program: "/bin/sh", argv: ["-c", "printf text"],
      cwd: "/app/nested", environment: { ONLY: "explicit" }, lifetime: "operation" });
    expect(environment.processes[0].write.mock.calls[0].slice(0, 3)).toMatchObject([{ runId: "run", callId: "execute", operationIndex: 1 }, Buffer.alloc(0), true]);
    expect(hostSpawn).not.toHaveBeenCalled();
  } finally { await manager.closeAll(); hostSpawn.mockRestore(); }
});

it("keeps owner-only numeric handles and listing preserves output until polling after strict cleanup", async () => {
  const environment = new EnvironmentFixture();
  environment.onLaunch = (process) => { process.emit("prefix\n"); process.leader = true; };
  const manager = new UnifiedExecProcessManager({ executionEnvironment: environment, cwd: "/app" });
  try {
    const initial = await admitted("start", () => manager.execCommand({ ownerId: owner, cmd: "background", tty: true, yield_time_ms: 250 }));
    const id = initial.session_id!;
    expect(id).toBe(environment.processes[0].sessionId);
    expect(initial.exitCode).toBeNull();
    expect(manager.listProcesses(owner)).toMatchObject([{ session_id: id, command: "background", cwd: "/app", tty: true }]);
    expect(manager.listProcesses("foreign")).toEqual([]);
    expect(manager.listProcesses()).toEqual([]);
    await expect(manager.writeStdin({ ownerId: "foreign", session_id: id })).rejects.toMatchObject({ code: "owner_denied" });
    await expect(manager.terminateProcess({ ownerId: "foreign", processId: id })).rejects.toMatchObject({ code: "owner_denied" });
    const process = environment.processes[0];
    process.emit("unconsumed\n");
    await vi.waitFor(() => expect(manager.listBackgroundProcesses()[0].outputTail).toContain("unconsumed"));
    manager.listProcesses(owner); manager.listProcesses(owner);
    const gate = deferred(); process.stopGate = gate.promise;
    const stopping = manager.terminateProcess({ ownerId: owner, processId: id });
    let completed = false;
    void stopping.then(() => { completed = true; });
    await vi.waitFor(() => expect(process.terminate).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    gate.resolve();
    expect(await stopping).toEqual({ terminated: true });
    expect(await manager.terminateProcess({ ownerId: owner, processId: id })).toEqual({ terminated: false });
    const final = await manager.writeStdin({ ownerId: owner, session_id: id, yield_time_ms: 1 });
    expect(final.stdout).toContain("unconsumed\nfinal output\n");
    expect(final.exitCode).toBe(137);
    expect(await manager.terminateProcess({ ownerId: owner, processId: id })).toEqual({ terminated: false });
  } finally { await manager.closeAll(); }
});

it("does not relabel a natural exit as killed when cleanup finishes before its last output is polled", async () => {
  const environment = new EnvironmentFixture();
  const manager = new UnifiedExecProcessManager({ executionEnvironment: environment });
  try {
    const started = await admitted("start", () => manager.execCommand({ ownerId: owner, cmd: "work", tty: true, yield_time_ms: 250 }));
    environment.processes[0].emit("last output"); environment.processes[0].finish(0);
    expect(await manager.terminateProcess({ ownerId: owner, processId: started.session_id! })).toEqual({ terminated: false });
    expect(await manager.writeStdin({ ownerId: owner, session_id: started.session_id! })).toMatchObject({ stdout: "last output", exitCode: 0 });
    expect(manager.listBackgroundProcesses()[0].status).toBe("completed");
  } finally { await manager.closeAll(); }
});

it("reports proved residual cleanup through the existing tool result without changing the leader exit code", async () => {
  const environment = new EnvironmentFixture();
  environment.onLaunch = (process) => { process.residualProcessesTerminated = true; process.emit("leader done"); process.finish(0); };
  const manager = new UnifiedExecProcessManager({ executionEnvironment: environment });
  try {
    const result = await admitted("forking-command", () => manager.execCommand({ ownerId: owner, cmd: "fork and exit" }));
    expect(result).toMatchObject({ stdout: "leader done", exitCode: 0, residual_processes_terminated: true });
  } finally { await manager.closeAll(); }
});

it("does not alias an old numeric handle when a new controller manager launches another command", async () => {
  const environment = new EnvironmentFixture();
  const previous = new UnifiedExecProcessManager({ executionEnvironment: environment });
  const current = new UnifiedExecProcessManager({ executionEnvironment: environment });
  try {
    const old = await admitted("old", () => previous.execCommand({ ownerId: owner, cmd: "old", tty: true, yield_time_ms: 250 }));
    await previous.terminateProcess({ ownerId: owner, processId: old.session_id! });
    const next = await admitted("new", () => current.execCommand({ ownerId: owner, cmd: "new", tty: true, yield_time_ms: 250 }));
    expect(next.session_id).not.toBe(old.session_id);
    expect(await current.terminateProcess({ ownerId: owner, processId: old.session_id! })).toEqual({ terminated: false });
    await expect(current.writeStdin({ ownerId: owner, session_id: old.session_id! })).rejects.toMatchObject({ code: "unknown_process" });
    expect(environment.processes[1].terminate).not.toHaveBeenCalled();
    expect(current.listProcesses(owner)).toMatchObject([{ session_id: next.session_id }]);
  } finally { await previous.closeAll(); await current.closeAll(); }
});

it("sends terminal input with its admitted identity and never resends a lost input acknowledgement", async () => {
  const environment = new EnvironmentFixture();
  const manager = new UnifiedExecProcessManager({ executionEnvironment: environment });
  try {
    const started = await admitted("start", () => manager.execCommand({ ownerId: owner, cmd: "terminal", tty: true, yield_time_ms: 250 }));
    const process = environment.processes[0];
    await admitted("input", () => manager.writeStdin({ ownerId: owner, session_id: started.session_id!, chars: "α\u0004", yield_time_ms: 250 }));
    expect(process.write.mock.calls[0][0]).toEqual({ runId: "run", callId: "input", attempt: 1, operationIndex: 0 });
    expect(process.write.mock.calls[0][1]).toEqual(Buffer.from("α\u0004"));
    process.write.mockRejectedValueOnce(new ExecutionEnvironmentError("unknown_outcome", "uncertain input", true));
    await expect(admitted("lost-input", () => manager.writeStdin({ ownerId: owner, session_id: started.session_id!, chars: "effect" })))
      .rejects.toMatchObject({ code: "unknown_outcome" });
    expect(process.write).toHaveBeenCalledTimes(2);
    expect(environment.launch).toHaveBeenCalledTimes(1);
    expect(environment.close).toHaveBeenCalledTimes(1);
  } finally { await manager.closeAll(); }
});

it("fences a pending launch before dispatch and can resume only after its drain", async () => {
  const environment = new EnvironmentFixture();
  const gate = deferred(); environment.launchGate = gate.promise;
  const manager = new UnifiedExecProcessManager({ executionEnvironment: environment });
  const started = admitted("pending", () => manager.execCommand({ ownerId: owner, cmd: "never" }));
  const rejected = expect(started).rejects.toMatchObject({ code: "create_process" });
  await vi.waitFor(() => expect(environment.launch).toHaveBeenCalledOnce());
  const token = manager.beginSandboxAuthorityQuiesce();
  const drained = manager.finishSandboxAuthorityQuiesce(token);
  gate.resolve(); await rejected; await drained;
  expect(environment.processes).toHaveLength(0);
  expect(environment.close).not.toHaveBeenCalled();
  manager.resumeSandboxAuthorityAfterQuiesce(token);
  environment.onLaunch = (process) => process.finish();
  try {
    expect((await admitted("after-resume", () => manager.execCommand({ ownerId: owner, cmd: "next" }))).exitCode).toBe(0);
  } finally { await manager.closeAll(); }
});

it("fences the owner after uncertain launch without replay or a fabricated success", async () => {
  const environment = new EnvironmentFixture(); environment.lostAck = true;
  const manager = new UnifiedExecProcessManager({ executionEnvironment: environment });
  await expect(admitted("lost-launch", () => manager.execCommand({ ownerId: owner, cmd: "effect" })))
    .rejects.toMatchObject({ code: "unknown_outcome" });
  expect(environment.launch).toHaveBeenCalledOnce();
  expect(environment.close).toHaveBeenCalledOnce();
  expect(manager.listBackgroundProcesses()).toMatchObject([{ status: "failed", failure: "lost launch ack" }]);
  await expect(admitted("next", () => manager.execCommand({ ownerId: owner, cmd: "must not launch" }))).rejects.toMatchObject({ code: "create_process" });
  await manager.closeAll();
});

it("reports environment loss with retained output and no fabricated exit code", async () => {
  const environment = new EnvironmentFixture();
  const manager = new UnifiedExecProcessManager({ executionEnvironment: environment });
  const started = await admitted("start", () => manager.execCommand({ ownerId: owner, cmd: "work", tty: true, yield_time_ms: 250 }));
  const process = environment.processes[0];
  process.emit("last received bytes");
  process.cleanup = true; process.leader = true; process.failure = "environment generation died";
  await expect(manager.writeStdin({ ownerId: owner, session_id: started.session_id! })).rejects.toMatchObject({ code: "output_incomplete" });
  expect(manager.listBackgroundProcesses()).toMatchObject([{ status: "failed", failure: "environment generation died", outputTail: "last received bytes" }]);
  expect(manager.listBackgroundProcesses()[0].exitCode).toBeUndefined();
  await manager.closeAll();
});

it("keeps failed cleanup explicit and rejects foreign detached or restricted paths before dispatch", async () => {
  const environment = new EnvironmentFixture();
  const manager = new UnifiedExecProcessManager({ executionEnvironment: environment });
  await expect(manager.startDetachedProcess({ cmd: "service" })).rejects.toMatchObject({ code: "owner_denied" });
  await expect(admitted("restricted", () => manager.execCommand({ ownerId: owner, cmd: "work", runtimeSandbox: {} as never })))
    .rejects.toMatchObject({ code: "unsupported_permission_profile", requestSent: false });
  expect(environment.launch).not.toHaveBeenCalled();
  const started = await admitted("start", () => manager.execCommand({ ownerId: owner, cmd: "work", tty: true, yield_time_ms: 250 }));
  environment.processes[0].terminate.mockRejectedValueOnce(new ExecutionEnvironmentError("cleanup_unproven", "scope cannot be drained", true));
  await expect(manager.terminateProcess({ ownerId: owner, processId: started.session_id! })).rejects.toMatchObject({ code: "cleanup_unproven" });
  expect(environment.close).toHaveBeenCalledOnce();
  await manager.closeAll();
});

it("returns task PID/log metadata and preserves a detached service after owner shutdown without sending stdin", async () => {
  const environment = new EnvironmentFixture();
  environment.onLaunch = (process) => process.emit("service started");
  const manager = new UnifiedExecProcessManager({ executionEnvironment: environment, cwd: "/app", env: { TASK: "only" } });
  const result = await admitted("service", () => manager.startDetachedProcess({ ownerId: owner, cmd: "service", yield_time_ms: 250 }));
  expect(result).toMatchObject({ detached: true, pid: 4321, stdout: "service started", exitCode: null,
    log_path: "/tmp/agenc-detached-" + "d".repeat(32) + ".log" });
  expect(result.session_id).toBeUndefined();
  expect(manager.listProcesses(owner)).toEqual([]);
  expect(manager.listBackgroundProcesses()).toEqual([]);
  expect(environment.processes[0].specification).toMatchObject({ cwd: "/app", environment: { TASK: "only" }, terminal: false, lifetime: "environment" });
  await manager.closeAll();
  expect(environment.processes[0].write).not.toHaveBeenCalled();
  expect(environment.processes[0].terminate).not.toHaveBeenCalled();
  expect(environment.processes[0].done).toBe(false);
});

it("reports an early detached bootstrap failure with its task log instead of a fabricated live PID", async () => {
  const environment = new EnvironmentFixture();
  environment.onLaunch = (process) => {
    process.detachedService = { ...process.detachedService!, startupState: "failed", error: "missing task program" };
    process.emit("startup diagnostic"); process.finish(127);
  };
  const manager = new UnifiedExecProcessManager({ executionEnvironment: environment });
  try {
    const result = await admitted("bad-service", () => manager.startDetachedProcess({ ownerId: owner, cmd: "missing" }));
    expect(result).toMatchObject({ detached: true, exitCode: 127, stdout: "startup diagnostic", stderr: "missing task program" });
    expect(result.pid).toBeUndefined();
    expect(environment.launch).toHaveBeenCalledOnce();
  } finally { await manager.closeAll(); }
});

it("stops waiting after cancellation of an acknowledged detached startup while preserving the requested service", async () => {
  const environment = new EnvironmentFixture();
  const abort = new AbortController();
  environment.onLaunch = () => abort.abort();
  const manager = new UnifiedExecProcessManager({ executionEnvironment: environment });
  const result = await admitted("service", () => manager.startDetachedProcess({ ownerId: owner, cmd: "service", __abortSignal: abort.signal }));
  expect(result.pid).toBe(4321);
  await manager.closeAll();
  expect(environment.processes[0].done).toBe(false);
});

it("does not replay a detached launch whose acknowledgement was lost", async () => {
  const environment = new EnvironmentFixture(); environment.lostAck = true;
  const manager = new UnifiedExecProcessManager({ executionEnvironment: environment });
  await expect(admitted("unknown-service", () => manager.startDetachedProcess({ ownerId: owner, cmd: "service" })))
    .rejects.toMatchObject({ code: "unknown_outcome" });
  expect(environment.launch).toHaveBeenCalledOnce();
  expect(environment.close).toHaveBeenCalledOnce();
  expect(environment.processes[0].done).toBe(false);
  await manager.closeAll();
});

it("restores original numeric handles and stream carries without replaying delivered output, launch or EOF", async () => {
  const environment = new EnvironmentFixture();
  environment.onLaunch = (process) => { process.emit(Buffer.concat([Buffer.from("delivered:"), Buffer.from([0xe2])])); process.emit("", "delivered error"); };
  const first = new UnifiedExecProcessManager({ executionEnvironment: environment, cwd: "/app" });
  const restored = new UnifiedExecProcessManager({ executionEnvironment: environment, cwd: "/elsewhere", env: { NEW: "irrelevant" } });
  try {
    const started = await admitted("recover", () => first.execCommand({ ownerId: owner, cmd: "original", yield_time_ms: 250 }));
    expect(started).toMatchObject({ stdout: "delivered:", stderr: "delivered error" });
    const state = first.captureExecutionProcesses()!;
    expect(state.entries[0].delivered).toMatchObject({ stdoutCarry: "4g==", stderrCarry: "" });
    const process = environment.processes[0];
    process.emit(Buffer.from([0x82]), Buffer.from([0xf0, 0x90]));
    await vi.waitFor(() => expect(process.output.mock.calls.some(([offset]) => offset > state.entries[0].delivered.offset)).toBe(true));
    expect(first.captureExecutionProcesses()).toEqual(state); // Observation is not delivery.
    await restored.restoreExecutionProcesses(JSON.parse(JSON.stringify(state)));
    expect(restored.listProcesses(owner)).toEqual(first.listProcesses(owner));
    expect(restored.listProcesses("foreign")).toEqual([]);
    expect(restored.listBackgroundProcesses()[0].taskId).toBe(first.listBackgroundProcesses()[0].taskId);
    process.emit(Buffer.from([0xac]), Buffer.from([0x80, 0x80])); process.finish();
    const result = await restored.writeStdin({ ownerId: owner, session_id: started.session_id! });
    expect(result).toMatchObject({ stdout: "€", stderr: "𐀀", exitCode: 0 });
    expect(environment.launch).toHaveBeenCalledOnce();
    expect(environment.reconnect).toHaveBeenCalledExactlyOnceWith({ runId: "run", callId: "recover", attempt: 1, operationIndex: 0 });
    expect(process.write).toHaveBeenCalledOnce(); // Original EOF only.
    expect(process.resize).not.toHaveBeenCalled();
    expect(process.terminate).not.toHaveBeenCalled();
    expect(restored.captureExecutionProcesses()!.entries).toEqual([]);
    await expect(restored.restoreExecutionProcesses(state)).rejects.toMatchObject({ code: "process_recovery_busy" });
  } finally { await restored.closeAll(); await first.closeAll(); }
});

it("refuses snapshotting an in-flight tool and preserves its original absolute timeout", async () => {
  const environment = new EnvironmentFixture();
  const gate = deferred(); environment.launchGate = gate.promise;
  const manager = new UnifiedExecProcessManager({ executionEnvironment: environment });
  const pending = admitted("pending", () => manager.execCommand({ ownerId: owner, cmd: "work", timeoutMs: 10000, yield_time_ms: 250 }));
  expect(() => manager.captureExecutionProcesses()).toThrow(/active tool calls/);
  gate.resolve(); await pending;
  const state = manager.captureExecutionProcesses()!;
  expect(state.entries[0].timeoutAt! - state.entries[0].startedAt).toBe(10000);
  const restored = new UnifiedExecProcessManager({ executionEnvironment: environment });
  try {
    await restored.restoreExecutionProcesses(state);
    expect(restored.captureExecutionProcesses()!.entries[0].timeoutAt).toBe(state.entries[0].timeoutAt);
    const stop = deferred(); environment.processes[0].stopGate = stop.promise;
    const stopping = restored.terminateProcess({ ownerId: owner, processId: state.entries[0].sessionId });
    expect(() => restored.captureExecutionProcesses()).toThrow(/active tool calls/);
    stop.resolve(); await stopping;
  } finally { await restored.closeAll(); await manager.closeAll(); }
});

it("validates recovery ownership, generation, receipt store, authority and duplicate handles before host lookup", async () => {
  const environment = new EnvironmentFixture();
  const first = new UnifiedExecProcessManager({ executionEnvironment: environment });
  await admitted("original", () => first.execCommand({ ownerId: owner, cmd: "work", yield_time_ms: 250 }));
  const state = first.captureExecutionProcesses()!;
  try {
    for (const invalid of [{ ...state, ownerId: "foreign" }, { ...state, authorityRevision: 1 },
      { ...state, binding: { ...binding, generation: "f".repeat(64) } },
      { ...state, binding: { ...binding, processHandleNamespace: "f".repeat(32) } },
      { ...state, entries: [...state.entries, ...state.entries] }]) {
      const restored = new UnifiedExecProcessManager({ executionEnvironment: environment });
      await expect(restored.restoreExecutionProcesses(invalid)).rejects.toThrow();
      expect(restored.listProcesses(owner)).toEqual([]);
    }
    expect(environment.reconnect).not.toHaveBeenCalled();
    expect(environment.launch).toHaveBeenCalledOnce();
    expect(environment.close).not.toHaveBeenCalled();
  } finally { await first.closeAll(); }
});

it("publishes no handles and closes admission when any original receipt mismatches", async () => {
  const environment = new EnvironmentFixture();
  const first = new UnifiedExecProcessManager({ executionEnvironment: environment });
  const restored = new UnifiedExecProcessManager({ executionEnvironment: environment });
  try {
    for (const call of ["one", "two"]) await admitted(call, () => first.execCommand({ ownerId: owner, cmd: call, yield_time_ms: 250 }));
    const state = first.captureExecutionProcesses()!;
    // The second lookup returns another operation's original receipt.
    await expect(restored.restoreExecutionProcesses(state)).rejects.toMatchObject({ code: "process_recovery_mismatch" });
    expect(environment.reconnect).toHaveBeenCalledTimes(2);
    expect(restored.listProcesses(owner)).toEqual([]);
    await expect(admitted("forbidden", () => restored.execCommand({ ownerId: owner, cmd: "replacement" }))).rejects.toThrow(/admission is closed/);
    expect(environment.launch).toHaveBeenCalledTimes(2);
    expect(environment.close).not.toHaveBeenCalled();
    expect(environment.processes.every((process) => process.terminate.mock.calls.length === 0)).toBe(true);
    expect(restored.captureExecutionProcesses()).toMatchObject({ admission: "closed", failure: { code: "process_recovery_mismatch" }, entries: [] });
  } finally { await first.closeAll(); }
});

it("preserves uncertain input failure and closed admission through recovery", async () => {
  const environment = new EnvironmentFixture();
  const first = new UnifiedExecProcessManager({ executionEnvironment: environment });
  const restored = new UnifiedExecProcessManager({ executionEnvironment: environment });
  try {
    const start = await admitted("terminal", () => first.execCommand({ ownerId: owner, cmd: "read", tty: true, yield_time_ms: 250 }));
    const process = environment.processes[0];
    process.write.mockRejectedValueOnce(new ExecutionEnvironmentError("unknown_outcome", "input acknowledgement lost", true));
    await expect(admitted("input", () => first.writeStdin({ ownerId: owner, session_id: start.session_id!, chars: "one" })))
      .rejects.toMatchObject({ code: "unknown_outcome" });
    await restored.restoreExecutionProcesses(first.captureExecutionProcesses()!);
    await expect(restored.writeStdin({ ownerId: owner, session_id: start.session_id! })).rejects.toMatchObject({ code: "unknown_outcome" });
    await expect(admitted("replacement", () => restored.execCommand({ ownerId: owner, cmd: "again" }))).rejects.toThrow(/admission is closed/);
    expect(process.write).toHaveBeenCalledOnce();
    expect(environment.launch).toHaveBeenCalledOnce();
  } finally { await restored.closeAll(); await first.closeAll(); }
});

it("restores completed but unpolled output without listing a dead process", async () => {
  const environment = new EnvironmentFixture();
  const first = new UnifiedExecProcessManager({ executionEnvironment: environment });
  const restored = new UnifiedExecProcessManager({ executionEnvironment: environment });
  try {
    await admitted("finishes-offline", () => first.execCommand({ ownerId: owner, cmd: "work", yield_time_ms: 250 }));
    const state = first.captureExecutionProcesses()!;
    environment.processes[0].emit("offline final output"); environment.processes[0].finish();
    await restored.restoreExecutionProcesses(state);
    expect(restored.listProcesses(owner)).toEqual([]);
    const result = await restored.writeStdin({ ownerId: owner, session_id: state.entries[0].sessionId });
    expect(result).toMatchObject({ stdout: "offline final output", exitCode: 0 });
    expect(environment.launch).toHaveBeenCalledOnce();
    expect(environment.processes[0].terminate).not.toHaveBeenCalled();
  } finally { await restored.closeAll(); await first.closeAll(); }
});

it("cleans up an original process whose deadline passed while the controller was offline", async () => {
  const environment = new EnvironmentFixture();
  const first = new UnifiedExecProcessManager({ executionEnvironment: environment });
  const restored = new UnifiedExecProcessManager({ executionEnvironment: environment });
  try {
    await admitted("deadline", () => first.execCommand({ ownerId: owner, cmd: "work", timeoutMs: 10000, yield_time_ms: 250 }));
    const state = first.captureExecutionProcesses()!;
    const now = vi.spyOn(Date, "now").mockReturnValue(state.entries[0].timeoutAt! + 1);
    try { await restored.restoreExecutionProcesses(state); }
    finally { now.mockRestore(); }
    await vi.waitFor(() => expect(environment.processes[0].terminate).toHaveBeenCalledOnce());
    const result = await restored.writeStdin({ ownerId: owner, session_id: state.entries[0].sessionId });
    expect(result).toMatchObject({ timedOut: true, exitCode: 137 });
    expect(environment.launch).toHaveBeenCalledOnce();
  } finally { await restored.closeAll(); await first.closeAll(); }
});
