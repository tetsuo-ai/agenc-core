import { describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "../llm/types.js";
import { buildCacheSafeParams, forkSubagent } from "./fork-context.js";
import type { Session } from "../session/session.js";

function stubSession(
  rolloutStore:
    | {
        flushDurable: ReturnType<typeof vi.fn>;
        readAll?: () => readonly unknown[];
      }
    | null = null,
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
  it("mode=undefined returns directive only", async () => {
    const res = await forkSubagent({
      parent: stubSession(),
      parentMessages: history,
      taskPrompt: "do the thing",
    });
    expect(res.messages).toHaveLength(1);
    expect(res.directivePrompt).toContain("do the thing");
  });

  it("keeps startup image parts on the directive message", async () => {
    const res = await forkSubagent({
      parent: stubSession(),
      parentMessages: history,
      taskPrompt: "describe this",
      taskContent: [
        { type: "text", text: "describe this" },
        {
          type: "image_url",
          image_url: { url: "file:///tmp/cat.png" },
        },
      ],
    });

    expect(res.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: expect.stringContaining("Task: describe this"),
          },
          {
            type: "image_url",
            image_url: { url: "file:///tmp/cat.png" },
          },
        ],
      },
    ]);
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

  it("mode=undefined yields directive-only context (reference Option::None)", async () => {
    const res = await forkSubagent({
      parent: stubSession(),
      parentMessages: history,
      taskPrompt: "t",
    });
    expect(res.messages.length).toBe(1);
    expect((res.messages[0] as LLMMessage).content).toContain("Task: t");
  });

  it("I-36: flushes parent rollout before building the fork", async () => {
    const flush = vi.fn();
    const parent = stubSession({ flushDurable: flush });
    await forkSubagent({
      parent,
      parentMessages: history,
      taskPrompt: "t",
    });
    expect(flush).toHaveBeenCalledOnce();
  });

  it("prefers flushed rollout history and filters tool/commentary items for inherited forks", async () => {
    const flush = vi.fn();
    const parent = stubSession({
      flushDurable: flush,
      readAll: () => [
        { type: "response_item", payload: { role: "user", content: "rollout user" } },
        {
          type: "response_item",
          payload: {
            role: "assistant",
            content: "working",
            phase: "commentary",
          },
        },
        {
          type: "response_item",
          payload: { role: "tool", content: "tool output" },
        },
        {
          type: "response_item",
          payload: { role: "assistant", content: "rollout final" },
        },
      ],
    });

    const res = await forkSubagent({
      parent,
      parentMessages: history,
      mode: { kind: "full_history" },
      taskPrompt: "t",
    });

    expect(flush).toHaveBeenCalledOnce();
    expect(res.messages.map((message) => message.content)).toEqual([
      "rollout user",
      "rollout final",
      expect.stringContaining("Task: t"),
    ]);
  });

  it("mentions the worktree path when provided", async () => {
    const res = await forkSubagent({
      parent: stubSession(),
      parentMessages: history,
      taskPrompt: "t",
      worktreePath: "/tmp/wt",
    });
    expect(res.directivePrompt).toContain("/tmp/wt");
  });

  it("explains how inherited paths map into an isolated worktree", async () => {
    const res = await forkSubagent({
      parent: stubSession(),
      parentMessages: history,
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
