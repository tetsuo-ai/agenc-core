import { describe, expect, it } from "vitest";
import {
  AgenCDaemonConnectionLimiter,
  isDaemonControlMessage,
  isDaemonPreemptiveMessage,
  isDaemonPriorityMessage,
  isDaemonCausalRoutineMessage,
} from "../../src/app-server/overload.js";
import { JSON_RPC_VERSION, type JsonObject } from "../../src/app-server/protocol/index.js";

function request(method: string): JsonObject {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: method,
    method,
  };
}

describe("AgenC daemon overload control messages", () => {
  it("classifies only abort controls as daemon control messages", () => {
    expect(isDaemonControlMessage(request("request.cancel"))).toBe(true);
    expect(isDaemonControlMessage(request("run.cancel"))).toBe(true);
    expect(isDaemonControlMessage(request("session.cancelTurn"))).toBe(true);
    expect(isDaemonControlMessage(request("session.processes.stop"))).toBe(true);
    expect(isDaemonControlMessage(request("tool.cancel"))).toBe(true);
    expect(isDaemonControlMessage(request("commandExec.terminate"))).toBe(true);

    expect(isDaemonControlMessage(request("tool.approve"))).toBe(false);
    expect(isDaemonControlMessage(request("tool.deny"))).toBe(false);
    expect(isDaemonControlMessage(request("elicitation.respond"))).toBe(false);

    expect(isDaemonControlMessage(request("message.stream"))).toBe(false);
    expect(isDaemonControlMessage({ jsonrpc: JSON_RPC_VERSION })).toBe(false);
    expect(isDaemonControlMessage({ method: 1 })).toBe(false);
  });

  it("classifies interactive decisions as preemptive without making them overload-exempt controls", () => {
    for (const method of [
      "request.cancel",
      "run.cancel",
      "session.cancelTurn",
      "tool.cancel",
      "commandExec.terminate",
      "tool.approve",
      "tool.deny",
      "elicitation.respond",
    ]) {
      expect(isDaemonPreemptiveMessage(request(method))).toBe(true);
    }

    expect(isDaemonPreemptiveMessage(request("message.send"))).toBe(false);
    expect(isDaemonPreemptiveMessage({ jsonrpc: JSON_RPC_VERSION })).toBe(false);
    expect(isDaemonPreemptiveMessage({ method: 1 })).toBe(false);
  });

  it("prioritizes bounded creation, health, status, and session lookup methods", () => {
    for (const method of [
      "agent.create",
      "agent.list",
      "run.status",
      "run.result",
      "run.replay",
      "run.evidence",
      "session.list",
      "session.snapshot",
      "session.processes.list",
      "session.hooks.status",
      "health.ping",
      "health.ready",
      "health.stats",
    ]) {
      expect(isDaemonPriorityMessage(request(method))).toBe(true);
      expect(isDaemonPreemptiveMessage(request(method))).toBe(false);
      expect(isDaemonControlMessage(request(method))).toBe(false);
    }
    expect(isDaemonPriorityMessage(request("agent.attach"))).toBe(false);
    expect(isDaemonPriorityMessage(request("session.attach"))).toBe(false);
    expect(isDaemonPriorityMessage(request("message.stream"))).toBe(false);
  });

  it("lets an effect review overtake the turn it unblocks on the same connection", () => {
    // Desktop reviews on the session's turn connection, which it must be
    // attached to; a review queued behind the refused turn would wait on it.
    const review = request("session.resolveToolCall");
    expect(isDaemonPriorityMessage(review)).toBe(true);
    expect(isDaemonPreemptiveMessage(review)).toBe(false);
    expect(isDaemonControlMessage(review)).toBe(false);
  });

  it("keeps routines in the ordinary FIFO except writes naming a live tool call", () => {
    for (const method of ["routine.capabilities", "routine.list", "routine.get", "routine.create", "routine.update", "routine.delete", "routine.run", "routine.runs", "routine.cancel"]) {
      expect(isDaemonPriorityMessage(request(method))).toBe(false);
      expect(isDaemonPreemptiveMessage(request(method))).toBe(false);
      expect(isDaemonControlMessage(request(method))).toBe(false);
    }
    for (const method of ["routine.create", "routine.update"]) {
      const causal = { ...request(method), params: { permissionAuthority: { kind: "session", sessionId: "s", toolCallId: "call" } } };
      expect(isDaemonCausalRoutineMessage(causal)).toBe(true);
      expect(isDaemonPriorityMessage(causal)).toBe(true);
    }
    expect(isDaemonCausalRoutineMessage(request("routine.delete"))).toBe(false);
    const limiter = new AgenCDaemonConnectionLimiter({ maxInFlightRequests: 1 });
    const turn = limiter.tryStart(request("message.stream"), 0);
    expect(turn.admitted).toBe(true);
    expect(limiter.tryStart(request("routine.create"), 0)).toMatchObject({
      admitted: false,
      response: { error: { data: { code: "TOO_MANY_IN_FLIGHT_REQUESTS" } } },
    });
    turn.release();
  });

  it("keeps preemptive interactive decisions subject to normal overload limits", () => {
    const limiter = new AgenCDaemonConnectionLimiter({
      maxInFlightRequests: 1,
      requestRatePerSecond: 1,
      requestBurst: 1,
    });
    const inFlight = limiter.tryStart(request("message.send"), 0);
    expect(inFlight.admitted).toBe(true);

    expect(limiter.tryStart(request("tool.approve"), 0)).toMatchObject({
      admitted: false,
      response: {
        error: { data: { code: "TOO_MANY_IN_FLIGHT_REQUESTS" } },
      },
    });

    inFlight.release();
    expect(limiter.tryStart(request("tool.approve"), 0)).toMatchObject({
      admitted: false,
      response: { error: { data: { code: "RATE_LIMITED" } } },
    });
  });

  it("admits abort controls even when normal requests are over limit", () => {
    const limiter = new AgenCDaemonConnectionLimiter({
      maxInFlightRequests: 1,
      requestRatePerSecond: 1,
      requestBurst: 1,
    });
    const first = limiter.tryStart(request("message.stream"), 0);
    expect(first.admitted).toBe(true);

    expect(limiter.tryStart(request("health.ping"), 0)).toMatchObject({
      admitted: false,
      response: { error: { data: { code: "TOO_MANY_IN_FLIGHT_REQUESTS" } } },
    });

    const causalRoutine = { ...request("routine.create"), params: {
      permissionAuthority: { kind: "session", sessionId: "s", toolCallId: "call" },
    } };
    expect(isDaemonCausalRoutineMessage(causalRoutine)).toBe(true);
    expect(limiter.tryStart(causalRoutine, 0)).toMatchObject({
      admitted: false,
      response: {
        error: {
          data: { code: "TOO_MANY_IN_FLIGHT_REQUESTS" },
        },
      },
    });

    expect(limiter.tryStart(request("session.cancelTurn"), 0)).toMatchObject({
      admitted: true,
    });
    expect(limiter.tryStart(request("session.processes.stop"), 0)).toMatchObject({
      admitted: true,
    });
    expect(limiter.tryStart(request("run.cancel"), 0)).toMatchObject({
      admitted: true,
    });
    expect(limiter.tryStart(request("tool.cancel"), 0)).toMatchObject({
      admitted: true,
    });
    expect(limiter.tryStart(request("commandExec.terminate"), 0)).toMatchObject({
      admitted: true,
    });

    first.release();
  });
});
