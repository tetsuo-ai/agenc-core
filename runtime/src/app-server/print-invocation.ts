/** Authenticated resident print execution. No caller state becomes process state. */
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { PassThrough } from "node:stream";
import { classifyCLI } from "../bin/route.js";
import { readStartupCliFlags } from "../bin/startup-cli-flags.js";
import { resolveCliCwdForStartup } from "../bin/cli-cwd.js";
import { cliStartupErrorMessage } from "../bin/cli-process-main.js";
import { requireProjectTrustForTui } from "../bin/project-trust-preflight.js";
import { oneShotCLI, oneShotAbortExitCode, type OneShotInvocation } from "../bin/daemon-one-shot-cli.js";
import { resolveAgenCDaemonAutostartEnabled } from "./daemon-autostart.js";
import { assertCanonicalEnvironmentIngress } from "../config/environment-ingress.js";
import { resolveAgencHome } from "../config/env.js";
import { AgenCDaemonResponseError, type AgenCJsonLineDaemonTuiClient } from "./agent-cli.js";
import type { AgenCDaemonMethod, AgenCDaemonResponse, JsonObject, PrintInvokeParams, PrintInvokeResult } from "./protocol/index.js";
import { isRecord } from "../utils/record.js";
import { PrintOutput, PRINT_OUTPUT_MAX_BYTES, PRINT_OUTPUT_MAX_FRAMES } from "./print-output.js";

export interface PrintInvocationHost {
  readonly home: string;
  readonly send: (message: JsonObject) => void | Promise<void>;
  /** Existing canonical dispatcher, pinned to the authenticated connection. */
  readonly request: (method: AgenCDaemonMethod, params: JsonObject, signal?: AbortSignal) => Promise<AgenCDaemonResponse>;
}

/** The raw envelope is ephemeral; do not include it in errors or journal fields. */
export function validatePrintInvokeParams(params: JsonObject): PrintInvokeParams {
  const caller = params.caller;
  if (Object.keys(params).some(key => !["invocationId", "argv", "cwd", "env", "caller"].includes(key)) ||
      typeof params.invocationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(params.invocationId) ||
      typeof params.cwd !== "string" || !isAbsolute(params.cwd) || params.cwd.includes("\0") ||
      !Array.isArray(params.argv) || params.argv.length > 4096 || params.argv.some(arg => typeof arg !== "string" || arg.includes("\0")) ||
      !isRecord(params.env) || Object.keys(params.env).length > 4096 ||
      Object.entries(params.env).some(([key, value]) => !/^[^=\0]+$/.test(key) || typeof value !== "string" || value.includes("\0")) ||
      !isRecord(caller) || Object.keys(caller).some(key => !["pid", "stdinIsTTY", "stdoutIsTTY", "stderrIsTTY"].includes(key)) ||
      !Number.isSafeInteger(caller.pid) || (caller.pid as number) <= 0 ||
      [caller.stdinIsTTY, caller.stdoutIsTTY, caller.stderrIsTTY].some(value => typeof value !== "boolean") ||
      Buffer.byteLength(JSON.stringify(params), "utf8") > PRINT_OUTPUT_MAX_BYTES) {
    throw new Error("invalid print invocation envelope");
  }
  // Detached immutable values: no later caller or protocol mutation can alter preparation.
  return Object.freeze({ ...params, argv: Object.freeze([...params.argv]), env: Object.freeze({ ...params.env }), caller: Object.freeze({ ...caller }) }) as PrintInvokeParams;
}

export class PrintInvocation {
  readonly #host: PrintInvocationHost;
  readonly #params: PrintInvokeParams;
  readonly #abort = new AbortController();
  readonly #output: PrintOutput;
  readonly #listeners = new Map<string, Set<(event: JsonObject) => void>>();
  readonly #buffer: JsonObject[] = [];
  #bufferBytes = 0;
  #challenge: { value: string; resolve(): void; reject(error: Error): void } | undefined;
  #admitted = false;
  #done: Promise<PrintInvokeResult> | undefined;
  constructor(host: PrintInvocationHost, params: PrintInvokeParams) {
    this.#host = host; this.#params = params;
    this.#output = new PrintOutput(params.invocationId, host.send, error => this.cancel({ reason: "delivery_failed", message: error.message, exitCode: 1 }));
  }
  get invocationId(): string { return this.#params.invocationId; }
  run(): Promise<PrintInvokeResult> { return this.#done ??= this.#run(); }
  admit(challenge: string): void {
    if (this.#abort.signal.aborted || this.#admitted || this.#challenge?.value !== challenge) throw new Error("invalid print admission challenge");
    this.#admitted = true;
    const pending = this.#challenge; this.#challenge = undefined; pending.resolve();
  }
  acknowledge(sequence: number): void { this.#output.acknowledge(sequence); }
  cancel(reason: JsonObject): void {
    if (this.#abort.signal.aborted) return;
    this.#abort.abort(reason);
    const error = new Error("daemon print invocation cancelled");
    this.#challenge?.reject(error); this.#challenge = undefined;
    this.#output.fail(error);
    this.#buffer.length = 0; this.#bufferBytes = 0;
  }
  async close(): Promise<void> {
    this.cancel({ reason: "connection_closed", exitCode: 130 });
    await this.#done?.catch(() => {});
  }
  async event(event: JsonObject): Promise<void> {
    if (this.#abort.signal.aborted) return;
    const params = event.params;
    const sessionId = isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : undefined;
    if (sessionId === undefined) return;
    const listeners = this.#listeners.get(sessionId);
    if (listeners === undefined || listeners.size === 0) {
      const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      if (this.#buffer.length >= PRINT_OUTPUT_MAX_FRAMES || bytes > PRINT_OUTPUT_MAX_BYTES - this.#bufferBytes) {
        this.cancel({ reason: "event_delivery_limit", exitCode: 1 });
        throw new Error("daemon print event delivery limit exceeded");
      }
      this.#buffer.push(event); this.#bufferBytes += bytes;
      return;
    }
    for (const listener of listeners) listener(event);
    // Preserve multiplexer backpressure: no unbounded promise chain per event.
    await this.#output.flush();
  }
  #client(): AgenCJsonLineDaemonTuiClient {
    return {
      request: async <M extends AgenCDaemonMethod>(method: M, params: JsonObject = {}, options = {} as { signal?: AbortSignal }) => {
        const response = await this.#host.request(method, params, options.signal);
        if ("error" in response) throw new AgenCDaemonResponseError(response.error);
        return response.result as import("./protocol/index.js").AgenCDaemonResultByMethod[M];
      },
      supportsMethod: () => true,
      subscribeToSessionEvents: (sessionId, cb) => {
        let listeners = this.#listeners.get(sessionId);
        if (listeners === undefined) { listeners = new Set(); this.#listeners.set(sessionId, listeners); }
        listeners.add(cb);
        const buffered = this.#buffer.splice(0); this.#bufferBytes = 0;
        // Match the Unix client's synchronous pre-subscription replay ordering.
        for (const event of buffered) {
          if (isRecord(event.params) && event.params.sessionId === sessionId) cb(event);
        }
        return () => { listeners.delete(cb); };
      },
      subscribeToNotifications: () => () => {},
      getConnectionState: () => ({ status: "connected" }),
      subscribeToConnectionState: () => () => {},
      close: async () => { this.#listeners.clear(); this.#buffer.length = 0; this.#bufferBytes = 0; },
    };
  }
  async #admission(): Promise<void> {
    if (this.#abort.signal.aborted) throw new Error("daemon print invocation cancelled");
    const challenge = randomUUID();
    const acknowledged = new Promise<void>((resolve, reject) => { this.#challenge = { value: challenge, resolve, reject }; });
    // Both promises are observed immediately, including synchronous disconnect.
    await Promise.all([acknowledged, Promise.resolve().then(() => this.#host.send({
      jsonrpc: "2.0", method: "print.admission", params: { invocationId: this.invocationId, challenge },
    }))]);
    if (this.#abort.signal.aborted) throw new Error("daemon print invocation cancelled");
  }
  async #run(): Promise<PrintInvokeResult> {
    const p = this.#params;
    // No stdout, stdin, config writes or admission before eligibility is known.
    const argv = ["node", "agenc", ...p.argv];
    const plan = classifyCLI({ argv, isTTY: p.caller.stdinIsTTY, isStdoutTTY: p.caller.stdoutIsTTY });
    if ((p.caller.stdinIsTTY && p.caller.stdoutIsTTY) ||
        (plan.kind !== "oneShotCLI" && plan.kind !== "errorAndExit") ||
        (plan.kind === "oneShotCLI" && (plan.continueSession !== undefined || plan.userMessage.length === 0))) {
      return { kind: "fallback" };
    }
    // HOME omission and other-home connections cannot borrow daemon defaults.
    if (typeof p.env.HOME !== "string" || !isAbsolute(p.env.HOME)) return { kind: "fallback" };
    try { if (resolveAgencHome(p.env) !== this.#host.home) return { kind: "fallback" }; }
    catch { return { kind: "fallback" }; }
    const stdin = Object.assign(new PassThrough(), { isTTY: p.caller.stdinIsTTY });
    // This accepted route never reads stdin; close the placeholder defensively.
    stdin.end();
    const writeStream = (stream: "stdout" | "stderr", isTTY: boolean) => ({ isTTY, write: (data: string) => this.#output.write(stream, data) }) as NodeJS.WriteStream;
    const invocation: OneShotInvocation = {
      argv, env: p.env, cwd: p.cwd, clientId: `agenc-one-shot-${p.caller.pid}`,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: writeStream("stdout", p.caller.stdoutIsTTY), stderr: writeStream("stderr", p.caller.stderrIsTTY),
      signal: this.#abort.signal, flush: () => this.#output.flush(),
    };
    let exitCode = 1;
    try {
      try { assertCanonicalEnvironmentIngress(p.env); }
      catch (error) {
        invocation.stderr.write(`agenc: ${cliStartupErrorMessage(error)}\n`);
        await this.#output.flush();
        return { kind: "exit", exitCode: 2 };
      }
      if (plan.kind === "errorAndExit") {
        invocation.stderr.write(`${plan.message}\n`); exitCode = plan.exitCode;
      } else {
        const flags = readStartupCliFlags(argv);
        const cwd = resolveCliCwdForStartup(p.env, { cwdFn: () => p.cwd });
        if (!cwd.ok) invocation.stderr.write(`agenc: ${cwd.message}\n`);
        else if (await requireProjectTrustForTui({
          env: p.env, argv, startupCliFlags: flags, cwd: cwd.cwd,
          stdin: invocation.stdin, stdout: invocation.stdout, stderr: invocation.stderr,
          allowPrompt: false, markSessionTrusted: async () => {},
          onWarn: message => invocation.stderr.write(`${message}\n`),
        })) {
          if (this.#abort.signal.aborted) return { kind: "exit", exitCode: oneShotAbortExitCode(this.#abort.signal) };
          // Retain daemon-config validation at the same two boundaries as
          // default-cli-route and defaultEnsureDaemonReady. No autostart here.
          await resolveAgenCDaemonAutostartEnabled(p.env, p.env.HOME);
          const client = this.#client();
          exitCode = await oneShotCLI(plan.userMessage, plan.startupImages ?? [], flags, undefined, {
            // The second resident proof runs after canonical preparation and
            // before the existing agent.create dispatch in oneShotCLI.
            ensureDaemonReady: () => async () => {
              await resolveAgenCDaemonAutostartEnabled(p.env, p.env.HOME);
              await this.#admission();
            },
            createConnectedTuiClient: async () => client,
            // Stop remains available after the owning socket has closed.
            stopPromptAgent: async ({ agentId, reason }) => { await client.request("agent.stop", { agentId, ...(reason === undefined ? {} : { reason }) }); },
          }, invocation);
        }
      }
    } catch (error) {
      if (this.#abort.signal.aborted) exitCode = oneShotAbortExitCode(this.#abort.signal);
      else invocation.stderr.write(`agenc: ${cliStartupErrorMessage(error)}\n`);
    } finally {
      stdin.destroy(); this.#challenge = undefined;
    }
    if (!this.#abort.signal.aborted) await this.#output.flush();
    return { kind: "exit", exitCode };
  }
}
