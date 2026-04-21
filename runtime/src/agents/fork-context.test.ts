import { describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "../llm/types.js";
import { buildCacheSafeParams, forkSubagent } from "./fork-context.js";
import type { Session } from "../session/session.js";

function stubSession(
  rolloutStore: { flushDurable: ReturnType<typeof vi.fn> } | null = null,
): Session {
  return {
    rolloutStore,
    sessionConfiguration: { cwd: "/repo" },
    config: { cwd: "/repo" },
  } as unknown as Session;
}

const history: ReadonlyArray<LLMMessage> = [
  { role: "user", content: "turn 1 user" },
  { role: "assistant", content: "turn 1 assistant" },
  { role: "user", content: "turn 2 user" },
  { role: "assistant", content: "turn 2 assistant" },
  { role: "user", content: "turn 3 user" },
  { role: "assistant", content: "turn 3 assistant" },
];

describe("forkSubagent", () => {
  it("mode=new returns directive only", async () => {
    const res = await forkSubagent({
      parent: stubSession(),
      parentMessages: history,
      mode: { kind: "new" },
      taskPrompt: "do the thing",
    });
    expect(res.messages).toHaveLength(1);
    expect(res.directivePrompt).toContain("do the thing");
  });

  it("mode=full_history keeps every parent message + directive", async () => {
    const res = await forkSubagent({
      parent: stubSession(),
      parentMessages: history,
      mode: { kind: "full_history" },
      taskPrompt: "t",
    });
    expect(res.messages.length).toBe(history.length + 1);
  });

  it("mode=last_n_turns slices from the Nth user turn", async () => {
    const res = await forkSubagent({
      parent: stubSession(),
      parentMessages: history,
      mode: { kind: "last_n_turns", n: 2 },
      taskPrompt: "t",
    });
    // Should include last two user-turn boundaries (turns 2 + 3) = 4 + directive.
    expect(res.messages.length).toBe(5);
    expect((res.messages[0] as LLMMessage).content).toBe("turn 2 user");
  });

  it("mode=explicit uses caller-supplied prefix + directive", async () => {
    const explicit: ReadonlyArray<LLMMessage> = [
      { role: "user", content: "override" },
    ];
    const res = await forkSubagent({
      parent: stubSession(),
      parentMessages: history,
      mode: { kind: "explicit", messages: explicit },
      taskPrompt: "t",
    });
    expect(res.messages.length).toBe(2);
    expect((res.messages[0] as LLMMessage).content).toBe("override");
  });

  it("I-36: flushes parent rollout before building the fork", async () => {
    const flush = vi.fn();
    const parent = stubSession({ flushDurable: flush });
    await forkSubagent({
      parent,
      parentMessages: history,
      mode: { kind: "new" },
      taskPrompt: "t",
    });
    expect(flush).toHaveBeenCalledOnce();
  });

  it("mentions the worktree path when provided", async () => {
    const res = await forkSubagent({
      parent: stubSession(),
      parentMessages: history,
      mode: { kind: "new" },
      taskPrompt: "t",
      worktreePath: "/tmp/wt",
    });
    expect(res.directivePrompt).toContain("/tmp/wt");
  });

  it("explains how inherited paths map into an isolated worktree", async () => {
    const res = await forkSubagent({
      parent: stubSession(),
      parentMessages: history,
      mode: { kind: "new" },
      taskPrompt: "t",
      worktreePath: "/tmp/wt",
    });
    expect(res.directivePrompt).toContain("/repo");
    expect(res.directivePrompt).toContain("/tmp/wt");
    expect(res.directivePrompt).toContain("Translate inherited paths");
  });
});

describe("buildCacheSafeParams", () => {
  it("preserves parent systemPrompt when no override", () => {
    const p = buildCacheSafeParams({
      parent: {
        systemPrompt: "SYS",
        toolCatalogIds: ["a", "b", "c"],
        userContextKeys: ["k1"],
      },
    });
    expect(p.systemPrompt).toBe("SYS");
    expect(p.toolCatalogIds).toEqual(["a", "b", "c"]);
  });

  it("filters tool catalog by allowlist", () => {
    const p = buildCacheSafeParams({
      parent: {
        systemPrompt: "SYS",
        toolCatalogIds: ["a", "b", "c"],
        userContextKeys: [],
      },
      overrideToolAllowlist: ["a", "c"],
    });
    expect(p.toolCatalogIds).toEqual(["a", "c"]);
  });
});
