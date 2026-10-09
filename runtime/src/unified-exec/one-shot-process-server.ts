import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { resolveLinuxSubreaperBroker, spawnContainedProcess, terminateProcessTreeAndReport } from "../utils/supervisedProcess.js";
import { sessionProcessBoundaries } from "../utils/session-process-boundary.js";
import type { ProcessBrokerV3Outcome } from "../utils/process-broker-protocol-v3.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("warn", "[sandbox]");
export interface OneShotProcessServerAvailability { startupFailed: boolean; }

export class OneShotProcessServerCleanupError extends Error {
  constructor(cause: unknown) {
    super("one-shot process server process-tree cleanup could not be proven", { cause });
    this.name = "OneShotProcessServerCleanupError";
  }
}

interface Invocation {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly argv0?: string;
}
function frame(type: string, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(5); header.write(type, 0, "ascii");
  header.writeUInt32BE(payload.length, 1); return Buffer.concat([header, payload]);
}
interface Active {
  readonly child: ChildProcessWithoutNullStreams;
  readonly settled: Promise<void>;
  readonly finish: (status: number | undefined, residual: boolean, cleanupError?: Error) => void;
}

/** Bypass-only reusable executor, held by an independent subreaper boundary. */
export class OneShotProcessServer {
  constructor(private readonly availability: OneShotProcessServerAvailability = { startupFailed: false }) {}
  private server?: ChildProcessWithoutNullStreams;
  private active?: Active;
  private received: Buffer = Buffer.alloc(0);
  private starting = false;
  private closed?: Promise<void>;
  private ready?: () => void;
  private closing = false;
  private closeTask?: Promise<void>;
  private detachAbort?: () => void;
  private cleanupFailure?: OneShotProcessServerCleanupError;

  private watchAbort(signal?: AbortSignal): void {
    this.detachAbort?.();
    this.detachAbort = undefined;
    if (!signal) return;
    const abort = (): void => { void this.close().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    this.detachAbort = () => signal.removeEventListener("abort", abort);
  }

  async prepare(cwd: string, validateAdmission: () => void, signal?: AbortSignal): Promise<boolean> {
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.availability.startupFailed) return false;
    if (process.platform !== "linux" || this.active || this.starting || this.closing) return false;
    signal?.throwIfAborted();
    this.watchAbort(signal);
    if (!this.server) {
      this.starting = true;
      try {
        const broker = resolveLinuxSubreaperBroker();
        validateAdmission();
        this.received = Buffer.alloc(0);
        // Outer containment adopts every descendant if the command server dies.
        const server = spawnContainedProcess(broker, ["--one-shot-server-v1"], {
          cwd, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
          linuxContainment: "subreaper",
        });
        this.server = server;
        this.closed = new Promise<void>(resolve => server.once("close", () => {
          const finish = (error?: OneShotProcessServerCleanupError): void => {
            if (this.server === server) {
              this.server = undefined;
              this.cleanupFailure ??= error;
              this.active?.finish(undefined, false, error);
            }
            resolve();
          };
          void terminateProcessTreeAndReport(server).then(
            () => finish(), error => finish(new OneShotProcessServerCleanupError(error)),
          );
        }));
        server.stdin.on("error", () => { server.kill("SIGKILL"); });
        server.stderr.resume();
        server.on("error", () => { server.kill("SIGKILL"); });
        server.stdout.on("data", (data: Buffer) => this.receive(data));
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("one-shot process server startup timed out")), 3000);
          const failed = (): void => { clearTimeout(timer); reject(new Error("one-shot process server startup failed")); };
          server.once("close", failed);
          this.ready = () => { clearTimeout(timer); server.removeListener("close", failed); resolve(); };
        });
      } catch {
        await this.close();
        if (!this.availability.startupFailed && !signal?.aborted) {
          this.availability.startupFailed = true;
          logger.warn("Reusable command server startup failed; using a separate broker for each command.");
        }
        return false;
      } finally { this.starting = false; }
    }
    validateAdmission();
    signal?.throwIfAborted();
    return this.server !== undefined && !this.closing;
  }

  async spawn(input: Invocation, validateAdmission: () => void, signal?: AbortSignal): Promise<ChildProcessWithoutNullStreams | undefined> {
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.availability.startupFailed || process.platform !== "linux" || this.active || this.starting || this.closing) return undefined;
    signal?.throwIfAborted();
    if (!this.server && !await this.prepare(input.cwd, validateAdmission, signal)) return undefined;
    this.watchAbort(signal);
    validateAdmission();
    signal?.throwIfAborted();
    if (!this.server || this.active || this.closing) return undefined;
    const command = [input.argv0 ?? input.program, ...input.args];
    const environment = Object.entries(input.env).map(([name, value]) => `${name}=${value}`);
    const strings = [input.cwd, input.program, ...command, ...environment];
    if (command.length + environment.length >= 65536) return undefined;
    if (strings.some(s => s.includes("\0"))) return undefined;
    const text = strings.join("\0") + "\0";
    const payloadLength = 8 + Buffer.byteLength(text, "utf8");
    if (payloadLength > 2 * 1024 * 1024) return undefined;
    // Encode directly into the final frame instead of copying the strings
    // through separate count, payload and transport buffers.
    const requestFrame = Buffer.allocUnsafe(5 + payloadLength);
    requestFrame[0] = 82; // R
    requestFrame.writeUInt32BE(payloadLength, 1);
    requestFrame.writeUInt32BE(command.length, 5);
    requestFrame.writeUInt32BE(environment.length, 9);
    requestFrame.write(text, 13, "utf8");
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
      this.detachAbort?.(); this.detachAbort = undefined;
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
    this.server.stdin.write(requestFrame);
    return child;
  }

  private receive(data: Buffer): void {
    // Incoming stream buffers are owned by Node and remain valid while held.
    // Only an incomplete previous frame requires joining two byte ranges.
    this.received = this.received.length === 0 ? data : Buffer.concat([this.received, data]);
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
