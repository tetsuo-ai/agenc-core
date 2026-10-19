import { describe, expect, test, vi } from "vitest";
import { runTurn } from "../../src/session/run-turn.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

describe("direct answers in plan mode", () => {
  test.each(["MODE-RECOVERY-OK", "No changes are needed."])("finishes %s without requesting execution authority", async (answer) => {
    const provider = mkProvider({ content: answer });
    const chat = vi.spyOn(provider, "chatStream");
    const dispatch = vi.fn(async () => ({ content: "unused" }));
    const registry = {
      tools: [],
      toLLMTools: () => [{ type: "function", function: { name: "ExitPlanMode", description: "Present a plan", parameters: { type: "object" } } }],
      dispatch,
    } as unknown as ToolRegistry;
    const { session, events } = mkSession({ provider, registry });
    await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode: "plan" });

    await drain(runTurn(session, mkCtx({ permissionMode: "plan" }), "Answer without calling tools or changing files."));

    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]?.[2]?.toolChoice).not.toBe("required");
    expect(dispatch).not.toHaveBeenCalled();
    expect(session.permissionModeRegistry.current().mode).toBe("plan");
    expect(events.filter(event => event.msg.type === "turn_complete")).toEqual([
      expect.objectContaining({ msg: expect.objectContaining({ payload: expect.objectContaining({ lastAgentMessage: answer }) }) }),
    ]);
  });
});
