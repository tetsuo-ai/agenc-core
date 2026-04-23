import { describe, expect, it, vi } from "vitest";
import forkCommand, { runFork } from "./fork.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "./types.js";

function mkctx(session: Session): SlashCommandContext {
  return { session, argsRaw: "", cwd: "/ws", home: "/home/test" };
}

function stubSession(agentControl: unknown): Session {
  return {
    conversationId: "parent-1",
    services: { agentControl },
  } as unknown as Session;
}

describe("forkCommand", () => {
  it("returns a stub text when spawnForkedThread is absent", async () => {
    const session = stubSession({});
    const res = await runFork(mkctx(session));
    expect(res.kind).toBe("text");
    if (res.kind === "text") expect(res.text).toMatch(/pending integration/);
  });

  it("invokes spawnForkedThread when it exists on agentControl", async () => {
    const spawnForkedThread = vi.fn(async () => ({ threadId: "child-2" }));
    const session = stubSession({ spawnForkedThread });
    const res = await runFork(mkctx(session));
    expect(spawnForkedThread).toHaveBeenCalledWith({ source: "parent-1" });
    expect(res.kind).toBe("text");
    if (res.kind === "text")
      expect(res.text).toMatch(/parent-1 → child-2/);
  });

  it("wraps spawn failures into a typed error", async () => {
    const spawnForkedThread = vi.fn(async () => {
      throw new Error("boom");
    });
    const session = stubSession({ spawnForkedThread });
    const res = await forkCommand.execute(mkctx(session));
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).toMatch(/boom/);
  });
});
