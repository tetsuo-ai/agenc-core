import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { buildChatCompletionsRequest } from "../../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../src/llm/wire/capability-gating.js";
import { runTurn } from "../../src/session/run-turn.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

it("keeps DeepSeek request bytes identical with every timeline observer enabled", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "timeline-wire-"));
  try {
    const run = async (enabled: boolean) => {
      await writeFile(join(cwd, "sample.txt"), "before\n");
      const provider = mkProvider();
      const bodies: string[] = [];
      provider.chatStream = async (messages, _delta, options) => {
        bodies.push(JSON.stringify(buildChatCompletionsRequest({ model: "deepseek-flash", messages,
          tools: options?.tools ?? [], options, providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("deepseek", "deepseek-flash") })));
        if (bodies.length === 1) execFileSync(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], 'after\\n')", join(cwd, "sample.txt")]);
        return { content: "Finished fixture work.", toolCalls: [], usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedInputTokens: 20, reasoningOutputTokens: 2 }, model: "deepseek-flash", finishReason: "stop" };
      };
      const { session, events } = mkSession({ cwd, provider });
      await drain(runTurn(session, mkCtx({ cwd }), "Reply with a short answer.", { ...(enabled ? { includeToolProgress: true, turnChanges: { includeDiff: true } } : {}) }));
      return { bodies, events };
    };
    const old = await run(false), modern = await run(true);
    expect(modern.bodies).toEqual(old.bodies);
    expect(old.bodies.length).toBeGreaterThan(0);

    {
      expect(old.events.some(event => event.msg.type === "turn_changes")).toBe(false);
      const changeIndex = modern.events.findIndex(event => event.msg.type === "turn_changes");
      const completeIndex = modern.events.findIndex(event => event.msg.type === "turn_complete");
      expect(changeIndex).toBeGreaterThanOrEqual(0);
      expect(changeIndex).toBeLessThan(completeIndex);
      expect(modern.events[changeIndex]!.msg).toMatchObject({ payload: { files: [{ path: "sample.txt", op: "modified", added: 1, removed: 1 }] } });
      expect(modern.events[completeIndex]!.msg).toMatchObject({ payload: { usage: { input: 100, output: 10 } } });
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it("pins portable DeepSeek provider request bytes against the release fixture", async () => {
  const run = async (enabled: boolean) => {
    const provider = mkProvider();
    const bodies: string[] = [];
    provider.chatStream = async (messages, _delta, options) => {
      bodies.push(JSON.stringify(buildChatCompletionsRequest({ model: "deepseek-flash", messages,
        tools: options?.tools ?? [], options, providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("deepseek", "deepseek-flash") })));
      return { content: "Fixture answer.", toolCalls: [], usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }, model: "deepseek-flash", finishReason: "stop" };
    };
    const { session } = mkSession({ cwd: "/workspace/timeline-fixture", provider });
    await drain(runTurn(session, mkCtx({ cwd: "/workspace/timeline-fixture" }), "Reply with a short answer.", { ...(enabled ? { includeToolProgress: true, turnChanges: {} } : {}) }));
    return bodies;
  };
  const old = await run(false), modern = await run(true);
  expect(modern).toEqual(old);
  expect(old.map(body => createHash("sha256").update(body).digest("hex"))).toEqual(["7ea6da6cd3c3af845327133d574617ef4cc6d59fae509a35dc8c1950bd97db64"]);
});

it("preserves DeepSeek bytes through a tool round and a second user turn", async () => {
  const run = async (enabled: boolean) => {
    const provider = mkProvider();
    const bodies: string[] = [];
    const tool = { requiresApproval: false, isReadOnly: true, name: "fixture_read", description: "Read fixture", inputSchema: { type: "object", properties: {} }, execute: async () => ({ content: "fixture result" }) };
    const registry = { tools: [tool], toLLMTools: () => [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }], dispatch: tool.execute } as any;
    provider.chatStream = async (messages, _delta, options) => {
      bodies.push(JSON.stringify(buildChatCompletionsRequest({ model: "deepseek-flash", messages,
        tools: options?.tools ?? [], options, providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("deepseek", "deepseek-flash") })));
      const first = bodies.length === 1;
      return { content: first ? "" : "Fixture answer.", toolCalls: first ? [{ id: "fixture-call", name: "fixture_read", arguments: "{}" }] : [], usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }, model: "deepseek-flash", finishReason: first ? "tool_calls" : "stop" };
    };
    const { session, events } = mkSession({ cwd: "/workspace/timeline-fixture", provider, registry });
    const opts = enabled ? { includeToolProgress: true, turnChanges: {} } : {};
    await drain(runTurn(session, mkCtx({ cwd: "/workspace/timeline-fixture" }), "Read the fixture.", opts));
    await drain(runTurn(session, mkCtx({ cwd: "/workspace/timeline-fixture", subId: "turn-second" }), "Reply again.", opts));
    expect(events.filter(event => event.msg.type === "tool_call_completed").map(event => event.msg)).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ isError: false }) }));
    return bodies;
  };
  const old = await run(false), modern = await run(true);
  expect(modern).toEqual(old);
  expect(old.length).toBe(3);
  expect(old.map(body => createHash("sha256").update(body).digest("hex"))).toEqual([
    "4888ac65a07dd83f3e7b84768bd3c45edfe34f4ebe2c67e216270888cf0f88c5",
    "9843ba1a022fd752d741f00ca659cf607cc1b69aba7ce5c943badaa89a8a4546",
    "dbcde16a3a4b69cae3d0fd606ae5b00658996e1e5fc821d93fa554570e791434",
  ]);
});
