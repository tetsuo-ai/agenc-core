import { expect, test, vi } from "vitest";
import { runTurn } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";

test("unattended MCP configuration failure ends the turn before equivalent calls or completion gates", async () => {
  const name = "mcp.inventory.get_stock";
  const execute = vi.fn(async () => ({ content: "should not run" }));
  const tool = { name, serverId: "inventory", mcpInfo: { serverName: "inventory", toolName: "get_stock" },
    description: "stock", inputSchema: { type: "object" }, recoveryCategory: "side-effecting", execute };
  const provider = mkProvider({ content: "Looking up stock.",
    toolCalls: [{ id: "stock-call", name, arguments: '{"sku":"MC-421"}' }], finishReason: "tool_calls" });
  const chat = vi.spyOn(provider, "chatStream");
  const registry = { tools: [tool], toLLMTools: () => [], dispatch: async () => ({ content: "unused" }) } as unknown as ToolRegistry;
  const { session, events } = mkSession({ provider, registry, services: {
    runtimeOptions: resolveAgentRuntimeOptions({}, { nonInteractive: true }),
  } });
  const phases: PhaseEvent[] = [];
  try {
    for await (const event of runTurn(session, mkCtx({ sandboxPolicy: { value: "workspace_write" } }), "Get the stock using MCP only.")) phases.push(event);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(phases.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "error", content: expect.stringContaining('virtual_no_fs_write_tools = ["get_stock"]') });
    expect(events.flatMap(event => {
      const terminal = classifyTurnTerminal(event.msg);
      return terminal === undefined ? [] : [terminal];
    })).toEqual([expect.objectContaining({ outcome: "errored", code: 1 })]);
  } finally {
    await session.shutdown();
  }
});
