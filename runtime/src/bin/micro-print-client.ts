/** Client-only invocation. Preparation and execution belong to the daemon. */
import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { isRecord } from "../utils/record.js";
import { openResidentPrintConnection, type ResidentPrintConnection } from "../app-server/micro-print-connection.js";
import { MICRO_PRINT_MAX_FRAME_BYTES, MicroPrintError, microTransportError, writeMicroOutput } from "../app-server/micro-print-transport.js";

export interface MicroPrintInvocation {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly caller: { readonly pid: number; readonly stdinIsTTY: boolean; readonly stdoutIsTTY: boolean; readonly stderrIsTTY: boolean };
}
export interface MicroPrintIo {
  readonly stdout: Writable; readonly stderr: Writable;
  readonly signals: Pick<NodeJS.Process, "on" | "off">;
}
/** Null is a definite pre-effect decline. Never replay an uncertain admission. */
export async function tryMicroPrint(
  invocation: MicroPrintInvocation, runtimeRoot: string,
  io: MicroPrintIo = { stdout: process.stdout, stderr: process.stderr, signals: process },
  /** @internal tests inject a real fixture connection; no application client. */
  connect: typeof openResidentPrintConnection = openResidentPrintConnection,
): Promise<number | null> {
  const invocationId = randomUUID();
  // Preflight bounds avoid sending an envelope that the daemon cannot represent.
  if (invocation.argv.length > 4096 || Object.keys(invocation.env).length > 4096) return null;
  const params = { invocationId, argv: [...invocation.argv], cwd: invocation.cwd,
    env: { ...invocation.env }, caller: { ...invocation.caller } };
  if (Buffer.byteLength(JSON.stringify(params)) > MICRO_PRINT_MAX_FRAME_BYTES - 1024) return null;
  let connection: ResidentPrintConnection | null = null;
  let admitted = false, challengeSeen = false, outputSeen = false;
  let lastSequence = 0;
  let cancelledCode: number | undefined;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (reason: "signal" | "broken_pipe", signal?: "SIGINT" | "SIGTERM" | "SIGHUP", stream?: "stdout" | "stderr"): void => {
    if (cancelledCode !== undefined) return;
    cancelledCode = reason === "broken_pipe" || signal === "SIGTERM" ? 0 : 130;
    if (connection === null) return;
    cancelTimer = setTimeout(() => connection?.transport.close(), connection.timeoutMs);
    try {
      void connection.transport.request("print.cancel", { invocationId, reason, ...(signal ? { signal } : {}), ...(stream ? { stream } : {}) }, connection.timeoutMs).catch(() => connection?.transport.close());
    } catch { connection.transport.close(); }
  };
  const onInt = (): void => cancel("signal", "SIGINT");
  const onTerm = (): void => cancel("signal", "SIGTERM");
  const onHup = (): void => cancel("signal", "SIGHUP");
  const onStdout = (error: NodeJS.ErrnoException): void => { if (error.code === "EPIPE") cancel("broken_pipe", undefined, "stdout"); else connection?.transport.close(); };
  const onStderr = (error: NodeJS.ErrnoException): void => { if (error.code === "EPIPE") cancel("broken_pipe", undefined, "stderr"); else connection?.transport.close(); };
  io.signals.on("SIGINT", onInt); io.signals.on("SIGTERM", onTerm); io.signals.on("SIGHUP", onHup);
  io.stdout.on("error", onStdout); io.stderr.on("error", onStderr);
  try {
    connection = await connect(invocation.env, runtimeRoot);
    if (cancelledCode !== undefined) return cancelledCode;
    if (connection === null) return null;
    const resident = connection;
    // An admitted operation cannot be replayed. Keep its original request on
    // the pinned socket while probing liveness, with one absolute deadline.
    const requestDuringRun = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (invocation.env.AGENC_PRINT_STALL_RECOVERY === "off") {
        return resident.transport.request(method, params, resident.timeoutMs);
      }
      const budgetMs = Math.max(resident.timeoutMs, 30_000);
      const deadline = Date.now() + budgetMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const probe = async (): Promise<void> => {
        try {
          const reply = await resident.transport.request("health.ping", {}, Math.max(1, deadline - Date.now()));
          if (!isRecord(reply) || reply.ok !== true || typeof reply.now !== "string" || !reply.now) {
            resident.transport.close(microTransportError());
            return;
          }
          if (!finished) timer = setTimeout(() => { void probe(); }, resident.timeoutMs);
        } catch (error) {
          if (!finished) resident.transport.close(error instanceof MicroPrintError ? error : microTransportError());
        }
      };
      timer = setTimeout(() => { void probe(); }, resident.timeoutMs);
      try { return await resident.transport.request(method, params, budgetMs); }
      finally { finished = true; clearTimeout(timer); }
    };
    resident.transport.setNotificationHandler(async ({ method, params: notice }) => {
      if (notice.invocationId !== invocationId) throw microTransportError();
      if (method === "print.admission") {
        if (challengeSeen || admitted || cancelledCode !== undefined || typeof notice.challenge !== "string" ||
            !notice.challenge || Buffer.byteLength(notice.challenge) > 256) throw microTransportError();
        challengeSeen = true;
        await resident.proveAgain();
        resident.assertLive();
        if (cancelledCode !== undefined) throw microTransportError();
        // Synchronous, before the send: lost acknowledgement cannot authorize replay.
        admitted = true;
        await requestDuringRun("print.admit", { invocationId, challenge: notice.challenge });
      } else if (method === "print.output") {
        if (cancelledCode !== undefined || (notice.stream !== "stdout" && notice.stream !== "stderr") ||
            !Number.isSafeInteger(notice.sequence) || notice.sequence !== lastSequence + 1 || typeof notice.data !== "string") throw microTransportError();
        lastSequence++;
        outputSeen = true;
        await writeMicroOutput(io[notice.stream], notice.data, resident.transport.signal);
        await requestDuringRun("print.ack", { invocationId, sequence: notice.sequence });
      } else throw microTransportError();
    });
    // Long invocations are governed by cancellation, not the ordinary RPC timeout.
    const result = await resident.transport.request("print.invoke", params);
    await resident.transport.notificationsIdle();
    if (cancelledCode !== undefined) return cancelledCode;
    if (!isRecord(result)) throw microTransportError();
    if (result.kind === "fallback" && !admitted && !outputSeen && !challengeSeen) return null;
    if (result.kind !== "exit" || !Number.isSafeInteger(result.exitCode) || (result.exitCode as number) < 0 || (result.exitCode as number) > 255) throw microTransportError();
    return result.exitCode as number;
  } catch (error) {
    if (cancelledCode !== undefined) return cancelledCode;
    if (!admitted && !outputSeen) return null;
    // Only locally classified errors are safe to print. Never reflect server text or the caller envelope.
    const diagnostic = error instanceof MicroPrintError ? error.message : microTransportError().message;
    try { await writeMicroOutput(io.stderr, `agenc: ${diagnostic}\n`, AbortSignal.timeout(connection?.timeoutMs ?? 2000)); } catch { /* broken sink */ }
    return 1;
  } finally {
    clearTimeout(cancelTimer); connection?.transport.close();
    io.signals.off("SIGINT", onInt); io.signals.off("SIGTERM", onTerm); io.signals.off("SIGHUP", onHup);
    io.stdout.off("error", onStdout); io.stderr.off("error", onStderr);
  }
}
