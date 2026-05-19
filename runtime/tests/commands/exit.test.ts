import { describe, expect, it, vi } from "vitest";
import { exitCommand } from "./exit.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "./types.js";

function mkctx(session: Session): SlashCommandContext {
  return {
    session,
    argsRaw: "",
    cwd: "/ws",
    home: "/home/test",
  };
}

describe("exitCommand", () => {
  it("advertises the /quit alias", () => {
    expect(exitCommand.aliases).toContain("quit");
    expect(exitCommand.immediate).toBe(true);
  });

  it("calls session.shutdown and returns exit=0 on success", async () => {
    const shutdown = vi.fn(async () => {});
    const session = { shutdown } as unknown as Session;
    const res = await exitCommand.execute(mkctx(session));
    expect(shutdown).toHaveBeenCalledOnce();
    expect(res.kind).toBe("exit");
    if (res.kind === "exit") expect(res.code).toBe(0);
  });

  it("maps a shutdown failure into an error result", async () => {
    const shutdown = vi.fn(async () => {
      throw new Error("shutdown failed");
    });
    const session = { shutdown } as unknown as Session;
    const res = await exitCommand.execute(mkctx(session));
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).toMatch(/shutdown failed/);
  });
});
