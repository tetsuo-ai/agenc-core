import { describe, expect, it, vi } from "vitest";
import forkCommand, { runFork } from "./fork.js";
import {
  _clearAgentControlCacheForTesting,
  _setAgentControlForTesting,
} from "../bin/delegate-tool.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "./types.js";

function mkctx(session: Session): SlashCommandContext {
  return { session, argsRaw: "", cwd: "/ws", home: "/home/test" };
}

function stubSession(): Session {
  return {
    conversationId: "parent-1",
    services: {},
  } as unknown as Session;
}

describe("forkCommand", () => {
  it("invokes spawnForkedThread on the per-session AgentControl cache", async () => {
    const spawnForkedThread = vi.fn(async () => ({ agentId: "child-2" }));
    const session = stubSession();
    _setAgentControlForTesting(session, {
      control: { spawnForkedThread } as never,
      registry: {} as never,
    });
    const res = await runFork(mkctx(session));
    expect(spawnForkedThread).toHaveBeenCalledTimes(1);
    expect(spawnForkedThread.mock.calls[0]?.[0]).toBe("/root");
    expect(spawnForkedThread.mock.calls[0]?.[1]).toEqual({
      kind: "full_history",
    });
    expect(
      (spawnForkedThread.mock.calls[0]?.[2] as { forkParentSpawnCallId?: string })
        .forkParentSpawnCallId,
    ).toMatch(/^slash-fork-parent-1-/);
    expect(res.kind).toBe("text");
    if (res.kind === "text")
      expect(res.text).toMatch(/parent-1 → child-2/);
    _clearAgentControlCacheForTesting(session);
  });

  it("wraps spawn failures into a typed error", async () => {
    const spawnForkedThread = vi.fn(async () => {
      throw new Error("boom");
    });
    const session = stubSession();
    _setAgentControlForTesting(session, {
      control: { spawnForkedThread } as never,
      registry: {} as never,
    });
    const res = await forkCommand.execute(mkctx(session));
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).toMatch(/boom/);
    _clearAgentControlCacheForTesting(session);
  });
});
