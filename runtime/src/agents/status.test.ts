import { describe, expect, it } from "vitest";
import { AgentStatusTracker, isFinal } from "./status.js";

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
    if (s.status === "interrupted") expect(s.reason).toBe("parent_interrupt");
  });

  it("final→final overrides are ignored (sticky final pair)", () => {
    const t = new AgentStatusTracker();
    t.markCompleted("turn-1");
    // final→final: ignored.
    t.markShutdown();
    expect(t.value.status).toBe("completed");
  });

  it("isFinal classifies terminal states", () => {
    expect(isFinal({ status: "pending_init" })).toBe(false);
    expect(isFinal({ status: "idle" })).toBe(false);
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

  it("shutdown stays sticky and rejects further transitions", () => {
    const t = new AgentStatusTracker();
    t.markShutdown();
    t.markRunning("turn-1");
    expect(t.value.status).toBe("shutdown");
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
