import { describe, expect, it } from "vitest";
import { AgentStatusTracker, agentStatusFromEvent, isFinal } from "./status.js";

describe("AgentStatusTracker", () => {
  it("starts pending_init", () => {
    const t = new AgentStatusTracker();
    expect(t.value.status).toBe("pending_init");
  });

  it("transitions through the lifecycle", () => {
    const t = new AgentStatusTracker();
    t.markRunning("turn-1");
    expect(t.value.status).toBe("running");
    t.markCompleted("turn-1");
    expect(t.value.status).toBe("completed");
  });

  it("records error state with cause", () => {
    const t = new AgentStatusTracker();
    t.markErrored("turn-1", "boom");
    const s = t.value;
    expect(s.status).toBe("errored");
    if (s.status === "errored") expect(s.error).toBe("boom");
  });

  it("records interrupted reason", () => {
    const t = new AgentStatusTracker();
    t.markInterrupted("turn-1", "parent_interrupt");
    const s = t.value;
    expect(s.status).toBe("interrupted");
    if (s.status === "interrupted") expect(s.reason).toBe("parent_interrupt");
  });

  it("keeps completed terminal and rejects a later running transition", () => {
    const t = new AgentStatusTracker();
    t.markCompleted("turn-1", "done");
    t.markRunning("turn-2");
    expect(t.value).toMatchObject({
      status: "completed",
      turnId: "turn-1",
      lastMessage: "done",
    });
  });

  it("isFinal classifies terminal states", () => {
    expect(isFinal({ status: "pending_init" })).toBe(false);
    expect(isFinal({ status: "shutdown", endedAtMs: 0 })).toBe(true);
    expect(isFinal({ status: "not_found" })).toBe(true);
    // interrupted is non-final (matches AgenC semantics).
    expect(
      isFinal({
        status: "interrupted",
        turnId: "turn-1",
        endedAtMs: 0,
        reason: "parent_interrupt",
      }),
    ).toBe(false);
  });

  it("allows transition back to running after interrupt", () => {
    const t = new AgentStatusTracker();
    t.markRunning("turn-1");
    t.markInterrupted("turn-1", "parent_interrupt");
    expect(t.value.status).toBe("interrupted");
    t.markRunning("turn-2");
    expect(t.value.status).toBe("running");
  });

  it("markIdle moves a keep-alive worker to idle between turns", () => {
    const t = new AgentStatusTracker();
    t.markRunning("turn-1");
    t.markIdle("turn-1");
    const s = t.value;
    expect(s.status).toBe("idle");
    if (s.status === "idle") expect(s.turnId).toBe("turn-1");
  });

  it("idle is non-final so wait/list keeps watching a live worker", () => {
    expect(isFinal({ status: "idle", turnId: "turn-1", endedAtMs: 0 })).toBe(
      false,
    );
  });

  it("idle is reversible: a follow-up turn re-marks running", () => {
    const t = new AgentStatusTracker();
    t.markRunning("turn-1");
    t.markIdle("turn-1");
    expect(t.value.status).toBe("idle");
    t.markRunning("turn-2");
    expect(t.value).toMatchObject({ status: "running", turnId: "turn-2" });
  });

  it("idle can still reach a terminal state on shutdown", () => {
    const t = new AgentStatusTracker();
    t.markRunning("turn-1");
    t.markIdle("turn-1");
    t.markShutdown();
    expect(t.value.status).toBe("shutdown");
  });

  it("shutdown stays sticky and rejects further transitions", () => {
    const t = new AgentStatusTracker();
    t.markShutdown();
    t.markRunning("turn-1");
    expect(t.value.status).toBe("shutdown");
  });

  it("errored stays sticky and rejects further transitions", () => {
    const t = new AgentStatusTracker();
    t.markErrored("turn-1", "boom");
    t.markRunning("turn-2");
    expect(t.value).toMatchObject({
      status: "errored",
      turnId: "turn-1",
      error: "boom",
    });
  });

  it("subscribe delivers replay of current state", () => {
    const t = new AgentStatusTracker();
    let seen = "";
    const unsub = t.subscribe((s) => {
      seen = s.status;
    });
    expect(seen).toBe("pending_init");
    t.markRunning("turn-1");
    expect(seen).toBe("running");
    unsub();
  });
});

describe("agentStatusFromEvent (reference parity)", () => {
  it("turn_started -> running with turnId + startedAtMs", () => {
    const status = agentStatusFromEvent({
      type: "turn_started",
      payload: { turnId: "t1", startedAt: 100 },
    });
    expect(status).toEqual({
      status: "running",
      turnId: "t1",
      startedAtMs: 100,
    });
  });

  it("turn_complete -> completed with optional last message", () => {
    const status = agentStatusFromEvent({
      type: "turn_complete",
      payload: { turnId: "t1", lastAgentMessage: "done", completedAt: 200 },
    });
    expect(status).toMatchObject({
      status: "completed",
      turnId: "t1",
      lastMessage: "done",
      endedAtMs: 200,
    });
  });

  it("turn_aborted Interrupted-class reasons map to interrupted", () => {
    const status = agentStatusFromEvent({
      type: "turn_aborted",
      payload: { turnId: "t1", reason: "Interrupted by user" },
    });
    expect(status?.status).toBe("interrupted");
  });

  it("turn_aborted BudgetLimited reason maps to interrupted", () => {
    const status = agentStatusFromEvent({
      type: "turn_aborted",
      payload: { turnId: "t1", reason: "BudgetLimited" },
    });
    expect(status?.status).toBe("interrupted");
  });

  it("turn_aborted other reasons map to errored", () => {
    const status = agentStatusFromEvent({
      type: "turn_aborted",
      payload: { turnId: "t1", reason: "ProviderError" },
    });
    expect(status?.status).toBe("errored");
  });

  it("error event maps to errored with payload message", () => {
    const status = agentStatusFromEvent({
      type: "error",
      payload: { turnId: "t1", message: "boom" },
    });
    expect(status).toMatchObject({
      status: "errored",
      turnId: "t1",
      error: "boom",
    });
  });

  it("unrelated event types return undefined (no transition)", () => {
    expect(
      agentStatusFromEvent({ type: "agent_message", payload: {} }),
    ).toBeUndefined();
    expect(agentStatusFromEvent({ type: "tool_call_started" })).toBeUndefined();
  });
});
