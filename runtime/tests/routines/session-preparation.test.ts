import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutineSessionPreparation, ROUTINE_SESSION_PREPARE_CAPABILITY } from "../../src/routines/session-preparation.js";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";

const workspaces = createTempWorkspaceFixture("agenc-routine-preparation-delivery-");
afterEach(async () => { await workspaces.cleanup(); });

const input = { sessionId: "session_one", routineId: "routine_one", runId: "routine_run_one", cwd: "/workspace" };
function fixture(capable = true, timeoutMs = 500) {
  const clients = {
    hasClientWithCapability: vi.fn(async () => capable),
    broadcastCapabilityEvent: vi.fn(async (..._args: unknown[]) => ({ deliveredClientIds: ["desktop"], failed: [], sessionId: input.sessionId })),
  };
  return { broker: new RoutineSessionPreparation(clients as never, timeoutMs), clients };
}

describe("bounded routine session preparation", () => {
  it("asks a capable client with exact run identity and accepts the first attached answer", async () => {
    const f = fixture();
    const waiting = f.broker.prepare(input, new AbortController().signal);
    await vi.waitFor(() => expect(f.clients.broadcastCapabilityEvent).toHaveBeenCalledOnce());
    const [sessionId, capability, notification, options] = f.clients.broadcastCapabilityEvent.mock.calls[0] as unknown as [string, string, any, any];
    expect([sessionId, capability]).toEqual([input.sessionId, ROUTINE_SESSION_PREPARE_CAPABILITY]);
    expect(options).toMatchObject({ bufferOnFailure: false, signal: expect.any(AbortSignal), deadlineAt: expect.any(Number) });
    expect(notification).toMatchObject({ method: "routine.session.prepare", params: input });
    expect(f.broker.respond({ requestId: notification.params.requestId, status: "attached" }, true)).toEqual({ accepted: true });
    expect(await waiting).toEqual({ status: "attached", reason: null });
    expect(f.broker.respond({ requestId: notification.params.requestId, status: "declined", reason: "late" }, true)).toEqual({ accepted: false });
  });
  it("dispatches immediately when no capable client exists", async () => {
    const f = fixture(false);
    expect(await f.broker.prepare(input, new AbortController().signal)).toEqual({ status: "unavailable", reason: "No Desktop client is connected." });
    expect(f.clients.broadcastCapabilityEvent).not.toHaveBeenCalled();
  });
  it("bounds a nonanswer and refuses its late response", async () => {
    const f = fixture(true, 5);
    const result = await f.broker.prepare(input, new AbortController().signal);
    expect(result).toEqual({ status: "unavailable", reason: "Desktop did not answer within 4 seconds." });
    const notification = f.clients.broadcastCapabilityEvent.mock.calls[0]?.[2] as any;
    expect(f.broker.respond({ requestId: notification.params.requestId, status: "attached" }, true)).toEqual({ accepted: false });
  });
  it("preserves a declined reason and rejects clients without the capability", async () => {
    const f = fixture();
    const waiting = f.broker.prepare(input, new AbortController().signal);
    await vi.waitFor(() => expect(f.clients.broadcastCapabilityEvent).toHaveBeenCalledOnce());
    const notification = f.clients.broadcastCapabilityEvent.mock.calls[0]?.[2] as any;
    expect(f.broker.respond({ requestId: notification.params.requestId, status: "attached" }, false)).toEqual({ accepted: false });
    expect(f.broker.respond({ requestId: notification.params.requestId, status: "declined", reason: "Desktop window is not open." }, true)).toEqual({ accepted: true });
    expect(await waiting).toEqual({ status: "declined", reason: "Desktop window is not open." });
  });
  it("refuses an answer that arrives after the deadline, before the timer runs", async () => {
    const f = fixture(true, 200);
    const waiting = f.broker.prepare(input, new AbortController().signal);
    await vi.waitFor(() => expect(f.clients.broadcastCapabilityEvent).toHaveBeenCalledOnce());
    const notification = f.clients.broadcastCapabilityEvent.mock.calls[0]?.[2] as any;
    // The event loop was busy: the clock passed the deadline, the timer has not fired.
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 201);
    try {
      expect(f.broker.respond({ requestId: notification.params.requestId, status: "attached" }, true)).toEqual({ accepted: false });
    } finally { clock.mockRestore(); }
    expect(await waiting).toEqual({ status: "unavailable", reason: "Desktop did not answer within 4 seconds." });
  });
  it("accepts a decline without a reason, as the wire schema allows", async () => {
    const f = fixture();
    const waiting = f.broker.prepare(input, new AbortController().signal);
    await vi.waitFor(() => expect(f.clients.broadcastCapabilityEvent).toHaveBeenCalledOnce());
    const notification = f.clients.broadcastCapabilityEvent.mock.calls[0]?.[2] as any;
    expect(f.broker.respond({ requestId: notification.params.requestId, status: "declined" }, true)).toEqual({ accepted: true });
    expect(await waiting).toEqual({ status: "declined", reason: "Desktop declined to attach its tools." });
  });
  it("unblocks immediately on cancellation", async () => {
    const f = fixture(); const controller = new AbortController();
    const waiting = f.broker.prepare(input, controller.signal);
    await vi.waitFor(() => expect(f.clients.broadcastCapabilityEvent).toHaveBeenCalledOnce());
    controller.abort();
    expect(await waiting).toEqual({ status: "unavailable", reason: "Routine was cancelled." });
  });
});

describe("queued preparation delivery", () => {
  it.each(["timeout", "cancellation"] as const)("drops an expired request after %s while the client send queue is blocked", async expiry => {
    const sessionManager = new AgenCDaemonSessionManager({ createSessionId: () => input.sessionId });
    await sessionManager.createSession({ agentId: "agent_one", cwd: await workspaces.create() });
    const clients = new AgenCDaemonClientMultiplexer({ sessionManager });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const sent: unknown[] = [];
    await clients.registerClient({ clientId: "desktop", capabilities: { [ROUTINE_SESSION_PREPARE_CAPABILITY]: true }, send: async event => {
      sent.push(event);
      if (sent.length === 1) await blocked;
    } });
    const earlier = clients.broadcastCapabilityEvent(input.sessionId, ROUTINE_SESSION_PREPARE_CAPABILITY, { method: "earlier" }, { bufferOnFailure: false });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const broker = new RoutineSessionPreparation(clients, expiry === "timeout" ? 10 : 500);
    const controller = new AbortController();
    const broadcast = vi.spyOn(clients, "broadcastCapabilityEvent");
    const pending = broker.prepare(input, controller.signal);
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledOnce());
    // Let the multiplexer enqueue behind the blocked send before expiring it.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent).toHaveLength(1);
    if (expiry === "cancellation") controller.abort();
    expect(await pending).toEqual({ status: "unavailable", reason: expiry === "timeout" ? "Desktop did not answer within 4 seconds." : "Routine was cancelled." });
    release();
    await earlier;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent).toHaveLength(1);
  });
});
