import { randomUUID } from "node:crypto";
import type { AgenCDaemonClientMultiplexer } from "../app-server/client-multiplexer.js";
import type { JsonObject } from "../app-server/protocol/index.js";
import type { RoutineDesktopTools, RoutineSessionPrepareResponse } from "./types.js";

export const ROUTINE_SESSION_PREPARE_CAPABILITY = "routine.session.prepare.v1";
/** Four seconds bounds a local socket attach, even if Desktop disappears mid-request. */
export const ROUTINE_SESSION_PREPARE_TIMEOUT_MS = 4_000;
const unavailable = (reason: string): RoutineDesktopTools => ({ status: "unavailable", reason });
const DECLINED_WITHOUT_REASON = "Desktop declined to attach its tools.";

interface PendingPreparation {
  readonly resolve: (outcome: RoutineDesktopTools) => void;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

/** One-shot requests. The random request id also rejects late and duplicate answers. */
export class RoutineSessionPreparation {
  readonly #pending = new Map<string, PendingPreparation>();
  constructor(private readonly clients: Pick<AgenCDaemonClientMultiplexer, "hasClientWithCapability" | "broadcastCapabilityEvent">,
    private readonly timeoutMs = ROUTINE_SESSION_PREPARE_TIMEOUT_MS) {}

  async prepare(input: { sessionId: string; routineId: string; runId: string; cwd: string }, signal: AbortSignal): Promise<RoutineDesktopTools> {
    if (signal.aborted) return unavailable("Routine was cancelled.");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let resolveAbort!: (value: RoutineDesktopTools) => void;
    const aborted = new Promise<RoutineDesktopTools>(resolve => { resolveAbort = resolve; });
    const onAbort = () => resolveAbort(unavailable("Routine was cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    const deadlineAt = Date.now() + this.timeoutMs;
    const deadline = new Promise<RoutineDesktopTools>(resolve => {
      timeout = setTimeout(() => resolve(unavailable("Desktop did not answer within 4 seconds.")), this.timeoutMs);
      timeout.unref?.();
    });
    let requestId: string | undefined;
    try {
      const capable = await Promise.race([this.clients.hasClientWithCapability(ROUTINE_SESSION_PREPARE_CAPABILITY), deadline, aborted]);
      if (typeof capable !== "boolean") return capable;
      if (!capable) return unavailable("No Desktop client is connected.");
      requestId = randomUUID();
      let resolveAnswer!: (value: RoutineDesktopTools) => void;
      const answer = new Promise<RoutineDesktopTools>(resolve => { resolveAnswer = resolve; });
      this.#pending.set(requestId, { resolve: resolveAnswer, deadlineAt, signal });
      const delivery = this.clients.broadcastCapabilityEvent(input.sessionId, ROUTINE_SESSION_PREPARE_CAPABILITY, {
        jsonrpc: "2.0", method: "routine.session.prepare", params: { ...input, requestId },
      } as JsonObject, { bufferOnFailure: false, signal, deadlineAt }).then(delivered =>
        delivered.deliveredClientIds.length > 0 ? answer : unavailable("Desktop disconnected before preparation."));
      return await Promise.race([delivery, answer, deadline, aborted]);
    } catch { return unavailable("Desktop could not receive the preparation request."); }
    finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (requestId) this.#pending.delete(requestId);
    }
  }

  respond(params: RoutineSessionPrepareResponse, capable: boolean): { accepted: boolean } {
    // The wire schema makes a decline's reason optional; a present reason must
    // still be short, single-line text.
    if (!capable || typeof params.requestId !== "string" || !/^[a-f0-9-]{36}$/u.test(params.requestId) ||
      (params.status !== "attached" && params.status !== "declined") ||
      (params.status === "declined" && params.reason !== undefined && (typeof params.reason !== "string" || !params.reason.trim() || params.reason.length > 200 || /[\u0000-\u001f\u007f]/u.test(params.reason)))) return { accepted: false };
    const pending = this.#pending.get(params.requestId);
    if (!pending) return { accepted: false };
    this.#pending.delete(params.requestId);
    // A delayed timer callback must not let an expired or cancelled request
    // be answered: the deadline and the signal decide, not the timer.
    if (pending.signal.aborted || Date.now() >= pending.deadlineAt) return { accepted: false };
    pending.resolve(params.status === "attached"
      ? { status: "attached", reason: null }
      : { status: "declined", reason: params.reason?.trim() || DECLINED_WITHOUT_REASON });
    return { accepted: true };
  }
}
