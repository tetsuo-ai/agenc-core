import { describe, expect, it, vi } from "vitest";
import { RoutineSessionPreparation, ROUTINE_SESSION_PREPARE_CAPABILITY } from "../../src/routines/session-preparation.js";

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
    expect([sessionId, capability, options]).toEqual([input.sessionId, ROUTINE_SESSION_PREPARE_CAPABILITY, { bufferOnFailure: false }]);
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
  it("unblocks immediately on cancellation", async () => {
    const f = fixture(); const controller = new AbortController();
    const waiting = f.broker.prepare(input, controller.signal);
    await vi.waitFor(() => expect(f.clients.broadcastCapabilityEvent).toHaveBeenCalledOnce());
    controller.abort();
    expect(await waiting).toEqual({ status: "unavailable", reason: "Routine was cancelled." });
  });
});
