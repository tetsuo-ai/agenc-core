import { describe, expect, it, vi } from "vitest";

vi.mock("../agents/control.js", () => ({
  AgentControl: class AgentControl {
    registerSessionRoot(): void {}
  },
}));

vi.mock("../agents/registry.js", () => ({
  AgentRegistry: class AgentRegistry {},
}));

vi.mock("../agents/delegate.js", () => ({
  delegate: vi.fn(),
}));

import type { Session } from "../session/session.js";
import { buildDelegateTool } from "./delegate-tool.js";

function stubSession(): Session {
  return {
    eventLog: {},
    nextInternalSubId: () => "sub-1",
    services: {},
  } as unknown as Session;
}

describe("buildDelegateTool", () => {
  it("rejects worktree isolation without worktreeSlug before dispatch", async () => {
    const delegateSpy = vi.fn();
    const tool = buildDelegateTool({
      getSession: () => stubSession(),
      delegateFn: delegateSpy,
    });

    const result = await tool.execute({
      taskPrompt: "do work",
      isolation: "worktree",
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("worktreeSlug");
    expect(delegateSpy).not.toHaveBeenCalled();
  });

  it("passes an explicit worktreeSlug through to delegate", async () => {
    const delegateSpy = vi.fn().mockResolvedValue({
      kind: "rejected",
      reason: "expected test rejection",
    });
    const tool = buildDelegateTool({
      getSession: () => stubSession(),
      delegateFn: delegateSpy,
    });

    const result = await tool.execute({
      taskPrompt: "do work",
      isolation: "worktree",
      worktreeSlug: "agent-fix",
    });

    expect(result.isError).toBe(true);
    expect(delegateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        isolation: "worktree",
        worktreeSlug: "agent-fix",
      }),
    );
  });
});
