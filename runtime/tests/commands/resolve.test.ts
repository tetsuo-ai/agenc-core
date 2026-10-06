import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "./resolve.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "./types.js";

function mkctx(argsRaw: string, resolveDaemonToolCall: ReturnType<typeof vi.fn>): SlashCommandContext {
  return {
    session: { resolveDaemonToolCall } as unknown as Session,
    argsRaw,
    cwd: "/ws",
    home: "/home/test",
  };
}

const resolvedOne = async () => ({
  sessionId: "session_1",
  resolved: [{ toolCallId: "call_1", toolName: "mcp.lane.lane_hang" }],
  remaining: 0,
});

describe("resolveCommand", () => {
  it("lets the user attest an outcome with only the call id and a disposition", async () => {
    const resolve = vi.fn(resolvedOne);
    const res = await resolveCommand.execute(mkctx("call_1 confirmed_no_effect", resolve));
    expect(resolve).toHaveBeenCalledWith({
      toolCallId: "call_1",
      disposition: "confirmed_no_effect",
      attestation: "operator",
    });
    expect(res.kind).toBe("text");
  });

  it("still forwards an explicit evidence reference and digest verbatim", async () => {
    const resolve = vi.fn(resolvedOne);
    await resolveCommand.execute(mkctx(`call_1 confirmed_committed ticket:INC-1 ${"b".repeat(64)}`, resolve));
    expect(resolve).toHaveBeenCalledWith({
      toolCallId: "call_1",
      disposition: "confirmed_committed",
      evidenceRef: "ticket:INC-1",
      evidenceSha256: "b".repeat(64),
    });
  });

  it.each([
    "call_1",
    "call_1 maybe",
    "call_1 confirmed_no_effect ticket:INC-1",
    `call_1 confirmed_no_effect ticket:INC-1 ${"B".repeat(64)}`,
  ])("rejects the malformed form %j without calling the daemon", async (args) => {
    const resolve = vi.fn(resolvedOne);
    const res = await resolveCommand.execute(mkctx(args, resolve));
    expect(res.kind).toBe("error");
    expect(resolve).not.toHaveBeenCalled();
  });
});
