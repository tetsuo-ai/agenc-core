/**
 * T6 gap #119 integration: the session-level observer helpers wire
 * `MCPCallObserver` + `BashExecObserver` through `session.emit(...)`
 * so `mcp_tool_call_*` and `exec_command_*` EventMsg variants
 * actually reach the event log in production.
 */

import { describe, expect, it, vi } from "vitest";
import type { Event, EventMsg } from "./event-log.js";
import { createToolBridge } from "../mcp-client/tools.js";
import { createBashTool } from "../tools/system/bash.js";
import { bindExplicitDangerBoundary } from "../helpers/explicit-danger-boundary.js";
import {
  createBashExecObserverForSession,
  createBashExecObserverForSlot,
  createMCPCallObserverForSession,
  createMCPCallObserverForSlot,
  type ObserverSessionSink,
  type SessionSlot,
} from "./observer-wiring.js";

/**
 * Minimal stub that exposes the subset of `Session` the observers
 * actually call. Captures every emitted event so assertions can
 * inspect ordering + payload fidelity.
 */
function stubSession() {
  const events: Event[] = [];
  let nextId = 0;
  const session: ObserverSessionSink = {
    nextInternalSubId: () => `sub-test-${nextId++}`,
    emit: (event: Event) => {
      events.push(event);
    },
  };
  const types = () => events.map((e) => e.msg.type);
  const msgs = () => events.map((e) => e.msg) as EventMsg[];
  return { session, events, types, msgs };
}

describe("observer-wiring — T6 gap #119 session wiring", () => {
  it("MCP: success path emits begin + end with matching callId", async () => {
    const { session, msgs } = stubSession();
    const observer = createMCPCallObserverForSession(session);

    const fakeClient = {
      listTools: async () => ({
        tools: [
          {
            name: "echo",
            description: "echoes input",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
      callTool: async () => ({
        content: [{ type: "text", text: "pong" }],
        isError: false,
      }),
      close: async () => {},
    };

    const bridge = await createToolBridge(fakeClient, "srv", undefined, {
      callObserver: observer,
    });
    const tool = bridge.tools[0]!;
    const result = await tool.execute({ ping: true });
    expect(result.isError).toBeFalsy();

    const emitted = msgs();
    expect(emitted.map((m) => m.type)).toEqual([
      "mcp_tool_call_begin",
      "mcp_tool_call_end",
    ]);
    const begin = emitted[0];
    const end = emitted[1];
    if (begin?.type !== "mcp_tool_call_begin") throw new Error("bad begin");
    if (end?.type !== "mcp_tool_call_end") throw new Error("bad end");
    expect(begin.payload.server).toBe("srv");
    expect(begin.payload.toolName).toBe("echo");
    expect(JSON.parse(begin.payload.args)).toEqual({ ping: true });
    expect(end.payload.callId).toBe(begin.payload.callId);
    expect(end.payload.isError).toBe(false);
    expect(end.payload.result).toBe("pong");
    expect(typeof end.payload.durationMs).toBe("number");
  });

  it("MCP: error path still emits end with isError=true", async () => {
    const { session, msgs } = stubSession();
    const observer = createMCPCallObserverForSession(session);

    const fakeClient = {
      listTools: async () => ({
        tools: [
          {
            name: "boom",
            description: "throws",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
      callTool: async () => {
        throw new Error("server exploded");
      },
      close: async () => {},
    };

    const bridge = await createToolBridge(fakeClient, "srv", undefined, {
      callObserver: observer,
    });
    const result = await bridge.tools[0]!.execute({});
    expect(result.isError).toBe(true);

    const emitted = msgs();
    expect(emitted.map((m) => m.type)).toEqual([
      "mcp_tool_call_begin",
      "mcp_tool_call_end",
    ]);
    const end = emitted[1];
    if (end?.type !== "mcp_tool_call_end") throw new Error("bad end");
    expect(end.payload.isError).toBe(true);
  });

  it("bash: running a command emits exec_command_begin + exec_command_end", async () => {
    const { session, msgs } = stubSession();
    const execObserver = createBashExecObserverForSession(session);

    const tool = bindExplicitDangerBoundary(createBashTool({
      cwd: process.cwd(),
      execObserver,
    }));

    const result = await tool.execute({ command: "true" });
    expect(result.isError).toBeUndefined();

    const emitted = msgs();
    const types = emitted.map((m) => m.type);
    expect(types).toContain("exec_command_begin");
    expect(types).toContain("exec_command_end");
    // Begin must precede end.
    expect(types.indexOf("exec_command_begin")).toBeLessThan(
      types.indexOf("exec_command_end"),
    );

    const begin = emitted.find(
      (m): m is Extract<EventMsg, { type: "exec_command_begin" }> =>
        m.type === "exec_command_begin",
    );
    const end = emitted.find(
      (m): m is Extract<EventMsg, { type: "exec_command_end" }> =>
        m.type === "exec_command_end",
    );
    expect(begin).toBeDefined();
    expect(end).toBeDefined();
    expect(begin!.payload.callId).toBe(end!.payload.callId);
    expect(begin!.payload.command).toBe("true");
    expect(end!.payload.exitCode).toBe(0);
  });

  it("slot variant drops pre-session events with no backfill, then emits in call order once filled", async () => {
    const slot: SessionSlot = { current: null };
    const observer = createMCPCallObserverForSlot(slot);
    const bashObs = createBashExecObserverForSlot(slot);

    // Drop-while-null: no session, silent, and nothing is queued for
    // later replay once the slot is populated.
    observer.onBegin?.({
      callId: "c1",
      server: "s",
      toolName: "t",
      args: "{}",
    });
    observer.onEnd?.({
      callId: "c1",
      server: "s",
      toolName: "t",
      result: "",
      isError: false,
      durationMs: 1,
    });
    bashObs.onBegin?.({ callId: "b1", command: "true", cwd: "/tmp" });

    const { session, msgs } = stubSession();
    expect(msgs()).toHaveLength(0);
    slot.current = session;

    observer.onBegin?.({
      callId: "c2",
      server: "s",
      toolName: "t",
      args: "{}",
    });
    bashObs.onEnd?.({ callId: "b2", exitCode: 0, durationMs: 2 });

    const emitted = msgs();
    expect(emitted.map((m) => m.type)).toEqual([
      "mcp_tool_call_begin",
      "exec_command_end",
    ]);

    const mcpBegin = emitted[0];
    const bashEnd = emitted[1];
    if (mcpBegin?.type !== "mcp_tool_call_begin") {
      throw new Error("bad mcp begin");
    }
    if (bashEnd?.type !== "exec_command_end") {
      throw new Error("bad bash end");
    }
    expect(mcpBegin.payload.callId).toBe("c2");
    expect(bashEnd.payload.callId).toBe("b2");
  });

  // Sanity check that the tools tests already rely on: observer
  // missing = no emissions. Mirrors the test-fixtures-stay-silent
  // contract documented on `MCPCallObserver`.
  it("MCP bridge without observer emits nothing", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const fakeClient = {
      listTools: async () => ({
        tools: [
          {
            name: "echo",
            description: "",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
      callTool,
      close: async () => {},
    };
    const bridge = await createToolBridge(fakeClient, "srv", undefined, {});
    await bridge.tools[0]!.execute({});
    expect(callTool).toHaveBeenCalledOnce();
    // No observer, no listeners — nothing to assert beyond "no throw".
  });
});
