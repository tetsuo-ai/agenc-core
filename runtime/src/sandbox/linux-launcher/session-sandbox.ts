import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { prepareSessionBwrapPlan } from "./direct-bwrap.js";
import { consumeDirectBwrapPlan, registerDirectBwrapPlan } from "../../utils/direct-bwrap-handoff.js";
import { spawnContainedProcess, terminateProcessTreeAndReport } from "../../utils/supervisedProcess.js";
import { sessionProcessBoundaries } from "../../utils/session-process-boundary.js";
import type { ProcessBrokerV3Outcome } from "../../utils/process-broker-protocol-v3.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("warn", "[sandbox]");
export interface SessionSandboxAvailability { startupFailed: boolean; }

export class SessionSandboxCleanupError extends Error {
  constructor(cause: unknown) {
    super("persistent sandbox process-tree cleanup could not be proven", { cause });
    this.name = "SessionSandboxCleanupError";
  }
}

interface Invocation {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}
function frame(type: string, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(5); header.write(type, 0, "ascii");
  header.writeUInt32BE(payload.length, 1); return Buffer.concat([header, payload]);
}
function mountIdentity(file: string): string {
  let st: fs.BigIntStats;
  try { st = fs.statSync(file, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Bind planning may mask a path that does not exist yet. Pin its closest
    // existing ancestor too, so creating or retargeting it invalidates reuse.
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return "missing:" + file + ":" + mountIdentity(parent);
  }
  return [fs.realpathSync(file), st.dev, st.ino, st.mode, st.uid, st.gid,
    ...(st.isDirectory() ? [] : [st.size, st.mtimeNs, st.ctimeNs])].join(":");
}
function invocationKey(input: Invocation): string {
  const delimiter = input.args.indexOf("--");
  // Cwd and launcher environment are part of the namespace construction.
  return JSON.stringify([input.program, input.args.slice(0, delimiter), input.cwd, input.env]);
}
interface Active {
  readonly child: ChildProcessWithoutNullStreams;
  readonly settled: Promise<void>;
  readonly finish: (status: number | undefined, residual: boolean, cleanupError?: Error) => void;
}

/** One idle-or-running namespace. Busy callers retain per-command isolation. */
export class SessionSandbox {
  constructor(private readonly availability: SessionSandboxAvailability = { startupFailed: false }) {}
  private server?: ChildProcessWithoutNullStreams;
  private active?: Active;
  private key?: string;
  private identities: Array<readonly [string, string]> = [];
  private received = Buffer.alloc(0);
  private starting = false;
  private closed?: Promise<void>;
  private ready?: () => void;
  private closing = false;
  private closeTask?: Promise<void>;
  private detachAbort?: () => void;
  private cleanupFailure?: SessionSandboxCleanupError;

  private watchAbort(signal?: AbortSignal): void {
    this.detachAbort?.();
    this.detachAbort = undefined;
    if (!signal) return;
    const abort = (): void => { void this.close().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    this.detachAbort = () => signal.removeEventListener("abort", abort);
  }

  async spawn(input: Invocation, validateAdmission: () => void, signal?: AbortSignal): Promise<ChildProcessWithoutNullStreams | undefined> {
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.availability.startupFailed) return undefined;
    if (process.platform !== "linux" || this.active || this.starting || this.closing) return undefined;
    const key = invocationKey(input);
    let current = this.key === key;
    try { current &&= this.identities.every(([file, identity]) => mountIdentity(file) === identity); }
    catch { current = false; }
    if (!current && this.server) await this.close();
    signal?.throwIfAborted();
    this.watchAbort(signal);
    if (!this.server) {
      this.starting = true;
      try {
        const plan = prepareSessionBwrapPlan(input);
        if (!plan) return undefined;
        const handoff = consumeDirectBwrapPlan(plan);
        try {
          const launch = handoff.sessionSandbox;
          if (!launch || !handoff.isCurrent()) return undefined;
          const paths = new Set([input.program, input.args[0]!, launch.program, launch.executable, ...launch.policyPaths]);
          for (let i = 0; i < launch.args.indexOf("--"); i++) {
            if (["--bind", "--ro-bind", "--dev-bind"].includes(launch.args[i]!)) {
              paths.add(launch.args[++i]!); paths.add(launch.args[++i]!);
            } else if (["--tmpfs", "--dir", "--remount-ro"].includes(launch.args[i]!)) {
              paths.add(launch.args[++i]!);
            }
          }
          this.identities = [...paths].map(file => [file, mountIdentity(file)] as const);
          validateAdmission();
          this.received = Buffer.alloc(0);
          // The native broker is amortized over the session. Its private
          // status pipe remains the independent proof for namespace failure.
          // A declined direct launch may only execute this fixed no-op, never
          // the model command, before falling back to the ordinary launcher.
          const server = spawnContainedProcess(process.execPath, ["-e", "process.exit(125)"], {
            cwd: input.cwd, env: launch.env, linuxContainment: "subreaper",
            directBwrap: { prepare: () => registerDirectBwrapPlan(handoff),
              validateAdmission, signal: new AbortController().signal },
          });
          this.server = server;
          this.closed = new Promise<void>(resolve => server.once("close", () => {
            const finish = (error?: SessionSandboxCleanupError): void => {
              if (this.server === server) {
                this.server = undefined; this.key = undefined;
                this.cleanupFailure ??= error;
                this.active?.finish(undefined, false, error);
              }
              resolve();
            };
            void terminateProcessTreeAndReport(server).then(
              () => finish(), error => finish(new SessionSandboxCleanupError(error)),
            );
          }));
          server.stdin.on("error", () => { server.kill("SIGKILL"); });
          server.stderr.resume();
          server.on("error", () => { server.kill("SIGKILL"); });
          server.stdout.on("data", (data: Buffer) => this.receive(data));
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("session sandbox startup timed out")), 3000);
            const failed = (): void => { clearTimeout(timer); reject(new Error("session sandbox startup failed")); };
            server.once("close", failed);
            this.ready = () => { clearTimeout(timer); server.removeListener("close", failed); resolve(); };
          });
          this.key = key;
        } finally { handoff.dispose(); }
      } catch {
        await this.close();
        if (!this.availability.startupFailed && !signal?.aborted) {
          this.availability.startupFailed = true;
          logger.warn("Persistent sandbox startup failed; using a separate sandbox for each command for the rest of this session.");
        }
        return undefined;
      } finally { this.starting = false; }
    }
    validateAdmission();
    signal?.throwIfAborted();
    if (!this.server || this.active || this.closing) return undefined;
    const command = input.args.slice(input.args.indexOf("--") + 1);
    const environment = Object.entries({ ...input.env, AGENC_LINUX_SANDBOX_ACTIVE: "1" }).map(([name, value]) => `${name}=${value}`);
    const strings = [input.cwd, ...command, ...environment];
    if (strings.some(s => s.includes("\0"))) return undefined;
    const counts = Buffer.alloc(8); counts.writeUInt32BE(command.length, 0); counts.writeUInt32BE(environment.length, 4);
    const payload = Buffer.concat([counts, Buffer.from(strings.join("\0") + "\0")]);
    if (payload.length > 2 * 1024 * 1024) return undefined;
    const stdout = new PassThrough(), stderr = new PassThrough();
    const stdin = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("pipe command stdin is closed")); } });
    stdin.on("error", () => {});
    const child = Object.assign(new EventEmitter(), {
      pid: this.server.pid, stdin, stdout, stderr, exitCode: null as number | null,
      signalCode: null, killed: false,
      unref: () => child, ref: () => child,
      kill: (requestedSignal?: NodeJS.Signals | number): boolean => {
        if (this.active?.child !== child) return false;
        if (requestedSignal === 0) return true;
        const hard = requestedSignal === "SIGKILL" || requestedSignal === 9;
        this.server?.stdin.write(frame(hard ? "K" : "T")); return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    let outcome: ProcessBrokerV3Outcome | undefined;
    let cleanupError: Error | undefined;
    let resolve!: () => void;
    const settled = new Promise<void>(r => { resolve = r; });
    const finish = (status: number | undefined, residual: boolean, failure?: Error): void => {
      if (this.active?.child !== child) return;
      this.active = undefined;
      cleanupError = failure;
      outcome = status === undefined ? { kind: "unavailable", residual: "unknown" } : {
        kind: "reported", result: (status & 127) === 0
          ? { kind: "exit", code: (status >> 8) & 255 }
          : { kind: "signal", signal: status & 127 }, residual: residual ? "observed" : "none",
      };
      Object.defineProperty(child, "exitCode", { value: status === undefined ? null : (status & 127) === 0 ? (status >> 8) & 255 : 128 + (status & 127), configurable: true });
      stdout.end(); stderr.end(); resolve();
      child.emit("exit", child.exitCode, null); child.emit("close", child.exitCode, null);
    };
    this.active = { child, settled, finish };
    sessionProcessBoundaries.set(child, {
      alive: () => this.active?.child === child,
      settled, outcome: () => cleanupError ? undefined : outcome,
      terminate: async () => {
        if (this.active?.child === child) {
          child.kill("SIGTERM");
          const force = setTimeout(() => child.kill("SIGKILL"), 500);
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([settled, new Promise<void>(resolve => {
            timer = setTimeout(() => { void this.killServer().then(resolve, resolve); }, 2000);
          })]);
          clearTimeout(timer); clearTimeout(force);
        }
        if (cleanupError) throw cleanupError;
        return { commandOutcome: outcome,
          residualProcessesTerminated: outcome?.kind === "reported" && outcome.residual === "observed",
          residualProcessesObserved: outcome?.kind === "reported" && outcome.residual === "observed" };
      },
    });
    // This publication is irreversible. Never replay a command after it.
    this.server.stdin.write(frame("R", payload));
    return child;
  }

  private receive(data: Buffer): void {
    this.received = Buffer.concat([this.received, data]);
    while (this.received.length >= 5) {
      const length = this.received.readUInt32BE(1);
      if (length > 2 * 1024 * 1024) { void this.shutdown(false).catch(() => {}); return; }
      if (this.received.length < length + 5) return;
      const type = String.fromCharCode(this.received[0]!);
      const body = this.received.subarray(5, length + 5);
      this.received = this.received.subarray(length + 5);
      if (type === "P" && length === 0 && this.ready) { const ready = this.ready; this.ready = undefined; ready(); }
      else if (type === "O" && this.active) this.active.child.stdout.push(body);
      else if (type === "X" && this.active) this.active.child.stderr.push(body);
      else if (type === "D" && length === 5 && this.active && body[4]! <= 1 && terminalWaitStatus(body.readUInt32BE(0)))
        this.active.finish(body.readUInt32BE(0), body[4] === 1);
      else { void this.shutdown(false).catch(() => {}); return; }
    }
  }

  close(): Promise<void> { return this.shutdown(true); }

  private shutdown(graceful: boolean): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.detachAbort?.(); this.detachAbort = undefined;
    const task = (async () => {
      if (graceful && this.active)
        await sessionProcessBoundaries.get(this.active.child)!.terminate();
      await this.killServer();
    })();
    this.closeTask = task.finally(() => { this.closing = false; this.closeTask = undefined; });
    return this.closeTask;
  }

  private async killServer(): Promise<void> {
    const server = this.server;
    if (!server) { if (this.cleanupFailure) throw this.cleanupFailure; return; }
    server.kill("SIGKILL");
    await this.closed;
    server.stdin.destroy(); server.stdout.destroy(); server.stderr.destroy();
    if (this.cleanupFailure) throw this.cleanupFailure;
  }
}

function terminalWaitStatus(status: number): boolean {
  if (status > 0xffff) return false;
  if ((status & 0xff) === 0) return true;
  const signal = status & 0x7f;
  return (status & 0xff00) === 0 && signal > 0 && signal <= 64;
}
