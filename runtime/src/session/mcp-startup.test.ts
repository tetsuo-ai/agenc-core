/**
 * T6 gap #119 seam: `attachMcpManagerToSession` must install the
 * session-bound `MCPCallObserver` on the manager BEFORE `manager.start()`
 * so every bridge created thereafter emits `mcp_tool_call_*` events
 * into the session event log.
 */

import { describe, expect, it, vi } from "vitest";
import {
  attachMcpManagerToSession,
  getMcpConfigFromEnv,
} from "./mcp-startup.js";
import type { SessionSlot } from "./observer-wiring.js";
import type { MCPManager } from "../mcp-client/manager.js";
import type { Session } from "./session.js";

function stubManager() {
  const setCallObserver = vi.fn();
  return {
    manager: { setCallObserver } as unknown as MCPManager,
    setCallObserver,
  };
}

function stubSession() {
  const emit = vi.fn();
  const nextInternalSubId = vi.fn(() => "sub-0");
  return {
    session: { emit, nextInternalSubId } as unknown as Session,
    emit,
  };
}

describe("mcp-startup.attachMcpManagerToSession", () => {
  it("installs a call observer on the manager", () => {
    const { manager, setCallObserver } = stubManager();
    const { session } = stubSession();
    const slot: SessionSlot = { current: null };

    attachMcpManagerToSession(manager, session, slot);

    expect(setCallObserver).toHaveBeenCalledOnce();
    const observer = setCallObserver.mock.calls[0]![0]!;
    expect(typeof observer.onBegin).toBe("function");
    expect(typeof observer.onEnd).toBe("function");
  });

  it("fills an empty slot so observer emits reach the session", () => {
    const { manager } = stubManager();
    const { session } = stubSession();
    const slot: SessionSlot = { current: null };

    attachMcpManagerToSession(manager, session, slot);
    expect(slot.current).toBe(session);
  });

  it("rethrows + logs when setCallObserver fails", () => {
    const manager = {
      setCallObserver: () => {
        throw new Error("observer install failed");
      },
    } as unknown as MCPManager;
    const { session, emit } = stubSession();
    const slot: SessionSlot = { current: null };

    expect(() => attachMcpManagerToSession(manager, session, slot)).toThrow(
      /observer install failed/,
    );
    expect(emit).toHaveBeenCalled();
    const emitted = emit.mock.calls[0]![0];
    expect(emitted.msg.type).toBe("error");
  });
});

describe("mcp-startup.getMcpConfigFromEnv", () => {
  it("returns [] for unset env", () => {
    expect(getMcpConfigFromEnv({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("returns [] for malformed JSON", () => {
    expect(
      getMcpConfigFromEnv({ AGENC_MCP_SERVERS: "not-json" } as NodeJS.ProcessEnv),
    ).toEqual([]);
  });

  it("returns [] when JSON is not an array", () => {
    expect(
      getMcpConfigFromEnv({
        AGENC_MCP_SERVERS: '{"name":"foo"}',
      } as NodeJS.ProcessEnv),
    ).toEqual([]);
  });

  it("parses a valid JSON array of MCP configs", () => {
    const env = {
      AGENC_MCP_SERVERS: JSON.stringify([
        { name: "alpha", command: "alpha-cmd" },
        { name: "beta", transport: "sse", endpoint: "http://example/beta" },
        // Invalid entries get filtered out.
        { missingName: true },
        null,
        "string",
      ]),
    } as NodeJS.ProcessEnv;
    const parsed = getMcpConfigFromEnv(env);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.name).toBe("alpha");
    expect(parsed[1]!.name).toBe("beta");
  });
});
