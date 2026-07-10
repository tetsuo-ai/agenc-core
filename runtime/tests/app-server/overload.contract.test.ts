import { describe, expect, it } from "vitest";
import {
  AgenCDaemonConnectionLimiter,
  isDaemonControlMessage,
  isDaemonPreemptiveMessage,
} from "./overload.js";
import { JSON_RPC_VERSION, type JsonObject } from "./protocol/index.js";

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
    expect(isDaemonControlMessage(request("session.cancelTurn"))).toBe(true);
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
      response: {
        error: {
          data: { code: "TOO_MANY_IN_FLIGHT_REQUESTS" },
        },
      },
    });

    expect(limiter.tryStart(request("session.cancelTurn"), 0)).toMatchObject({
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
