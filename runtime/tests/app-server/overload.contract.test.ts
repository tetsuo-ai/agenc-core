import { describe, expect, it } from "vitest";
import {
  AgenCDaemonConnectionLimiter,
  isDaemonControlMessage,
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

    expect(isDaemonControlMessage(request("message.stream"))).toBe(false);
    expect(isDaemonControlMessage({ jsonrpc: JSON_RPC_VERSION })).toBe(false);
    expect(isDaemonControlMessage({ method: 1 })).toBe(false);
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
