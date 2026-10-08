import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { prepareSessionBwrapPlan } from "./direct-bwrap.js";
import { consumeDirectBwrapPlan } from "../../utils/direct-bwrap-handoff.js";
import { sessionProcessBoundaries } from "../../utils/session-process-boundary.js";
import type { ProcessBrokerV3Outcome } from "../../utils/process-broker-protocol-v3.js";

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
  const st = fs.statSync(file, { bigint: true });
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
  readonly finish: (status: number | undefined, residual: boolean) => void;
}

/** One idle-or-running namespace. Busy callers retain per-command isolation. */
export class SessionSandbox {
  private server?: ChildProcessWithoutNullStreams;
  private active?: Active;
  private key?: string;
  private identities: Array<readonly [string, string]> = [];
  private received = Buffer.alloc(0);
  private starting = false;
  private closed?: Promise<void>;
  private ready?: () => void;

  async spawn(input: Invocation, validateAdmission: () => void): Promise<ChildProcessWithoutNullStreams | undefined> {
    if (process.platform !== "linux" || this.active || this.starting) return undefined;
    const key = invocationKey(input);
    let current = this.key === key;
    try { current &&= this.identities.every(([file, identity]) => mountIdentity(file) === identity); }
    catch { current = false; }
    if (!current && this.server) await this.close();
    if (!this.server) {
      this.starting = true;
      try {
        const plan = prepareSessionBwrapPlan(input);
        if (!plan) return undefined;
        const handoff = consumeDirectBwrapPlan(plan);
        try {
          const launch = handoff.sessionSandbox;
          if (!launch || !handoff.isCurrent()) return undefined;
          const paths = new Set([input.program, input.args[0]!, launch.program, launch.executable]);
          for (let i = 0; i < launch.args.indexOf("--"); i++) {
            if (["--bind", "--ro-bind", "--dev-bind"].includes(launch.args[i]!)) paths.add(launch.args[++i]!);
          }
          this.identities = [...paths].map(file => [file, mountIdentity(file)] as const);
          validateAdmission();
          this.received = Buffer.alloc(0);
          const server = spawn(launch.program, [...launch.args], {
            cwd: input.cwd, env: launch.env, detached: true,
            stdio: handoff.sourceFd === undefined ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", handoff.sourceFd],
          }) as ChildProcessWithoutNullStreams;
          this.server = server;
          this.closed = new Promise<void>(resolve => server.once("close", () => {
            if (this.server === server) {
              this.server = undefined; this.key = undefined;
              this.active?.finish(undefined, false);
            }
            resolve();
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
        return undefined;
      } finally { this.starting = false; }
    }
    validateAdmission();
    if (!this.server || this.active) return undefined;
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
      kill: (_signal?: NodeJS.Signals | number): boolean => {
        if (this.active?.child !== child) return false;
        this.server?.stdin.write(frame("K")); return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    let outcome: ProcessBrokerV3Outcome | undefined;
    let resolve!: () => void;
    const settled = new Promise<void>(r => { resolve = r; });
    const finish = (status: number | undefined, residual: boolean): void => {
      if (this.active?.child !== child) return;
      this.active = undefined;
      outcome = status === undefined ? { kind: "unavailable", residual: "unknown" } : {
        kind: "reported", result: (status & 127) === 0
          ? { kind: "exit", code: (status >> 8) & 255 }
          : { kind: "signal", signal: status & 127 }, residual: residual ? "observed" : "none",
      };
      child.exitCode = status === undefined ? null : (status & 127) === 0 ? (status >> 8) & 255 : 128 + (status & 127);
      stdout.end(); stderr.end(); resolve();
      child.emit("exit", child.exitCode, null); child.emit("close", child.exitCode, null);
    };
    this.active = { child, settled, finish };
    sessionProcessBoundaries.set(child, {
      alive: () => this.active?.child === child,
      settled, outcome: () => outcome,
      terminate: async () => {
        if (this.active?.child === child) {
          child.kill("SIGKILL");
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([settled, new Promise<void>(resolve => {
            timer = setTimeout(() => { void this.close().then(resolve); }, 2000);
          })]);
          clearTimeout(timer);
        }
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
      if (length > 2 * 1024 * 1024) { void this.close(); return; }
      if (this.received.length < length + 5) return;
      const type = String.fromCharCode(this.received[0]!);
      const body = this.received.subarray(5, length + 5);
      this.received = this.received.subarray(length + 5);
      if (type === "P" && length === 0 && this.ready) { const ready = this.ready; this.ready = undefined; ready(); }
      else if (type === "O" && this.active) this.active.child.stdout.push(body);
      else if (type === "X" && this.active) this.active.child.stderr.push(body);
      else if (type === "D" && length === 5 && this.active) this.active.finish(body.readUInt32BE(0), body[4] === 1);
      else { void this.close(); return; }
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.kill("SIGKILL");
    await this.closed;
    server.stdin.destroy(); server.stdout.destroy(); server.stderr.destroy();
  }
}
