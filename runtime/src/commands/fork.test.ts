import { describe, expect, it, vi } from "vitest";
import forkCommand, { runFork } from "./fork.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "./types.js";

const { ensureAgentControlMock } = vi.hoisted(() => ({
  ensureAgentControlMock: vi.fn(),
}));

vi.mock("../bin/delegate-tool.js", () => ({
  ensureAgentControl: ensureAgentControlMock,
}));

function mkctx(session: Session): SlashCommandContext {
  return { session, argsRaw: "", cwd: "/ws", home: "/home/test" };
}

function stubSession(): Session {
  return {
    conversationId: "parent-1",
    nextInternalSubId: vi.fn(() => "sub-parent-1-7"),
  } as unknown as Session;
}

describe("forkCommand", () => {
  it("uses the live AgentControl fork contract", async () => {
    const spawnForkedThread = vi.fn(async () => ({ agentId: "child-2" }));
    ensureAgentControlMock.mockReturnValue({
      control: { spawnForkedThread },
      registry: {},
    });

    const session = stubSession();
    const res = await runFork(mkctx(session));

    expect(ensureAgentControlMock).toHaveBeenCalledWith(session);
    expect(spawnForkedThread).toHaveBeenCalledWith(
      "/root",
      { kind: "full_history" },
      { forkParentSpawnCallId: "sub-parent-1-7" },
    );
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/parent-1 → child-2/);
    }
  });

  it("wraps fork failures into a typed error", async () => {
    const spawnForkedThread = vi.fn(async () => {
      throw new Error("boom");
    });
    ensureAgentControlMock.mockReturnValue({
      control: { spawnForkedThread },
      registry: {},
    });

    const session = stubSession();
    const res = await forkCommand.execute(mkctx(session));
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.message).toMatch(/boom/);
    }
  });
});
