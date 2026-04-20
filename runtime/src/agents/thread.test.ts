import { describe, expect, it } from "vitest";
import { AgentThread } from "./thread.js";
import type { LiveAgent } from "./control.js";
import { AgentStatusTracker } from "./status.js";
import { resolveAgentRole } from "./role.js";
import { Mailbox } from "./mailbox.js";

function makeLive(): LiveAgent {
  return {
    agentId: "thread-1",
    agentPath: "/root/alpha",
    role: resolveAgentRole(undefined),
    depth: 1,
    nickname: "alpha",
    status: new AgentStatusTracker(),
    upInbox: new Mailbox({ threadId: "thread-1" }),
    downInbox: new Mailbox({ threadId: "thread-1-down" }),
    abortController: new AbortController(),
  };
}

describe("AgentThread", () => {
  it("exposes threadId/path/nickname from the live agent", () => {
    const t = new AgentThread({
      live: makeLive(),
      initialMessages: [],
      forkMode: { kind: "new" },
      taskPrompt: "hi",
    });
    expect(t.threadId).toBe("thread-1");
    expect(t.agentPath).toBe("/root/alpha");
    expect(t.nickname).toBe("alpha");
  });

  it("isInterrupted reflects the abort controller", () => {
    const live = makeLive();
    const t = new AgentThread({
      live,
      initialMessages: [],
      forkMode: { kind: "new" },
      taskPrompt: "hi",
    });
    expect(t.isInterrupted).toBe(false);
    live.abortController.abort("test");
    expect(t.isInterrupted).toBe(true);
  });

  it("onStatusChange subscribes to the status tracker", () => {
    const live = makeLive();
    const t = new AgentThread({
      live,
      initialMessages: [],
      forkMode: { kind: "new" },
      taskPrompt: "hi",
    });
    const seen: string[] = [];
    const unsub = t.onStatusChange((s) => seen.push(s.status));
    live.status.markRunning("turn-1");
    unsub();
    expect(seen).toContain("running");
  });
});
