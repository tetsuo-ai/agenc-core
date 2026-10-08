import { enqueue, resetCommandQueueForTesting } from "../../src/utils/messageQueueManager.js";
import type { Session } from "../../src/session/session.js";
import type { TurnCheckpointSlice } from "../../src/session/turn-state.js";
import { readTurnCheckpoint } from "../../src/session/durable-checkpoint-reader.js";
import { afterEach, expect, test, vi } from "vitest";
import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";
import { runTurn } from "../../src/session/run-turn.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";
import { bodyAt, sseResponse } from "../llm/providers/openai-compatible-test-helpers.js";

type Sample = "reason-cap" | "visible-cap" | "tool-cap" | "tool" | "final";
async function scenario(samples: Sample[], policy: "off" | "streak2" | "absent" = "streak2", restoreSlice?: TurnCheckpointSlice,
  queued?: { readonly afterTool: number; readonly mode: "prompt" | "task-notification"; readonly isMeta?: boolean }) {
  let completedTools = 0;
  const execute = vi.fn(async () => {
    if (++completedTools === queued?.afterTool) enqueue({
      uuid: "policy-boundary-input", value: "Inspect the newly requested fixture.",
      mode: queued.mode, ...(queued.isMeta ? { isMeta: true } : {}), priority: "next",
      queueOwner: { kind: "session", conversationId: session.conversationId },
    });
    return { content: "observed fixture" };
  });
  const tool = { name: "read_fixture", description: "Read fixture", inputSchema: { type: "object", properties: {} },
    isReadOnly: true, recoveryCategory: "idempotent" as const, execute };
  const registry = { tools: [tool], toLLMTools: () => [{ type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }], dispatch: execute };
  let index = 0;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
    const i = index++;
    const sample = samples[i] ?? "final";
    const capped = sample.endsWith("-cap");
    const delta = sample === "reason-cap" ? { reasoning_content: "Consider next step." }
      : sample === "tool" || sample === "tool-cap" ? { tool_calls: [{ index: 0, id: `read${i}`, type: "function",
        function: { name: tool.name, arguments: sample === "tool" ? "{}" : '{"partial":' } }] }
      : { content: sample === "final" ? "Finished." : "Partial answer." };
    return sseResponse([
      `data: ${JSON.stringify({ model: "deepseek-flash", choices: [{ index: 0, delta }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: capped ? "length" : sample === "tool" ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: capped ? 8192 : 10, total_tokens: capped ? 8202 : 20,
          ...(sample === "reason-cap" ? { completion_tokens_details: { reasoning_tokens: 8192 } } : {}) } })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  });
  const provider = new DeepSeekProvider({ apiKey: "test", model: "deepseek-flash", fetchImpl });
  const { session, events } = mkSession({ provider, model: "deepseek-flash", registry });
  Object.assign(session.config!, { reasoningCapPolicy: policy === "absent" ? undefined : policy });
  session.rolloutStore = {
    assertCompactionProjectionReady: () => {}, assertToolAdmissionAllowed: vi.fn(),
    append: vi.fn(), appendRollout: vi.fn(),
    rolloutPath: "/tmp/reasoning-cap-policy-fixture.jsonl",
  } as unknown as Session["rolloutStore"];
  const ctx = mkCtx({ reasoningEffort: "high" });
  await drain(runTurn(session, { ...ctx,
    config: { ...ctx.config, model: "deepseek-flash", model_provider: "deepseek", max_output_tokens: 8192 },
    modelInfo: { ...ctx.modelInfo, maxOutputTokens: 8192, maxOutputTokensExplicit: true, supportedReasoningLevels: ["low", "high", "max"] },
  }, restoreSlice ? "" : "Read fixtures and finish.", restoreSlice ? {
    history: [{ role: "user", content: "Read fixtures and finish." }],
    resume: { turnId: ctx.subId, fromIteration: 1, fromCheckpointSeq: 1, persistedMessageCount: 1, restoreSlice },
  } : {}));
  for (let i = 0; i < fetchImpl.mock.calls.length; i++) {
    expect(bodyAt(fetchImpl, i)).toMatchObject({ max_tokens: 8192, reasoning_effort: "high" });
  }
  const checkpoints = events.flatMap(event => {
    if (event.msg.type !== "turn_checkpoint") return [];
    const parsed = readTurnCheckpoint(JSON.parse(JSON.stringify(event.msg.payload)));
    return [parsed.checkpoint.resumableState as TurnCheckpointSlice];
  });
  return { fetchImpl, execute, events, checkpoints };
}


const modes = (fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) => fetchImpl.mock.calls.map((_, i) => (bodyAt(fetchImpl, i).thinking as { type: string }).type);

test("native SSE produces enabled/off/enabled/off/extra-off/enabled with distinct policy notice", async () => {
  const { fetchImpl, events, execute } = await scenario(["reason-cap", "tool", "reason-cap", "tool", "tool", "final"]);
  expect(modes(fetchImpl)).toEqual(["enabled", "disabled", "enabled", "disabled", "disabled", "enabled"]);
  expect(execute).toHaveBeenCalledTimes(3);
  expect(events.filter(e => e.msg.type === "warning" && e.msg.payload.cause === "reasoning_cap_policy")).toHaveLength(1);
  expect(events.filter(e => e.msg.type === "warning" && e.msg.payload.cause === "thinking_disabled_recovery")).toHaveLength(2);
  expect(events.some(e => e.msg.type === "turn_complete")).toBe(true);
});

test("multiple cycles need two fresh recoveries after each extra sample", async () => {
  const { fetchImpl } = await scenario(["reason-cap", "tool", "reason-cap", "tool", "tool", "reason-cap", "tool", "reason-cap", "tool", "tool", "final"]);
  expect(modes(fetchImpl)).toEqual(["enabled", "disabled", "enabled", "disabled", "disabled", "enabled", "disabled", "enabled", "disabled", "disabled", "enabled"]);
});

test("intervening ordinary success resets the streak", async () => {
  const { fetchImpl } = await scenario(["reason-cap", "tool", "tool", "reason-cap", "tool", "final"]);
  expect(modes(fetchImpl)).toEqual(["enabled", "disabled", "enabled", "enabled", "disabled", "enabled"]);
});

test("absent and explicit off preserve complete native request bodies", async () => {
  const samples: Sample[] = ["reason-cap", "tool", "reason-cap", "tool", "tool", "final"];
  const absent = await scenario(samples, "absent");
  const off = await scenario(samples, "off");
  expect(modes(off.fetchImpl)).toEqual(["enabled", "disabled", "enabled", "disabled", "enabled", "enabled"]);
  expect(absent.fetchImpl.mock.calls.map((_, i) => bodyAt(absent.fetchImpl, i))).toEqual(off.fetchImpl.mock.calls.map((_, i) => bodyAt(off.fetchImpl, i)));
  expect(off.events.filter(e => e.msg.type === "warning" && e.msg.payload.cause === "reasoning_cap_policy")).toHaveLength(0);
});

test("policy cap does not qualify its native recovery for another streak and still exhausts", async () => {
  const { fetchImpl, events } = await scenario(["reason-cap", "tool", "reason-cap", "tool", "reason-cap", "reason-cap", "reason-cap", "reason-cap", "final"]);
  expect(fetchImpl).toHaveBeenCalledTimes(8);
  expect(events.some(e => e.msg.type === "turn_complete")).toBe(false);
  expect(events.find(e => e.msg.type === "turn_failed")?.msg).toMatchObject({ payload: { message: expect.stringContaining("Output recovery is exhausted") } });
});

test("real dispatch checkpoints restore armed, consumed, and completed policy samples without duplication", async () => {
  const original = await scenario(["reason-cap", "tool", "reason-cap", "tool", "tool", "final"]);
  const armed = original.checkpoints.find(s => s.reasoningCapPolicy?.extraPending)!;
  const consumed = original.checkpoints.find(s => s.reasoningCapPolicy?.sample?.kind === "extra" && !s.reasoningCapPolicy.sample.completed)!;
  const completed = original.checkpoints.find(s => s.reasoningCapPolicy?.sample?.kind === "extra" && s.reasoningCapPolicy.sample.completed)!;
  expect(armed).toBeDefined(); expect(consumed).toBeDefined(); expect(completed).toBeDefined();
  for (const slice of [armed, consumed]) {
    const resumed = await scenario(["tool", "final"], "streak2", slice);
    expect(modes(resumed.fetchImpl)).toEqual(["disabled", "enabled"]);
    if (slice === consumed) expect(resumed.checkpoints.some(s =>
      s.reasoningCapPolicy?.sample?.id === consumed.reasoningCapPolicy!.sample!.id)).toBe(true);
  }
  const after = await scenario(["tool", "final"], "streak2", completed);
  expect(modes(after.fetchImpl)).toEqual(["enabled", "enabled"]);
  const disabled = await scenario(["tool", "final"], "off", consumed);
  expect(modes(disabled.fetchImpl)).toEqual(["enabled", "enabled"]);
});

test("pre-response native recovery checkpoint advances the second streak exactly once after restart", async () => {
  const original = await scenario(["reason-cap", "tool", "reason-cap", "tool", "tool", "final"]);
  const recovering = original.checkpoints.find(s => s.reasoningCapPolicy?.streak === 1 &&
    s.reasoningCapPolicy.sample?.kind === "recovery" && !s.reasoningCapPolicy.sample.completed)!;
  expect(recovering).toBeDefined();
  const resumed = await scenario(["tool", "tool", "final"], "streak2", recovering);
  expect(modes(resumed.fetchImpl)).toEqual(["disabled", "disabled", "enabled"]);
  expect(resumed.events.filter(e => e.msg.type === "warning" && e.msg.payload.cause === "reasoning_cap_policy")).toHaveLength(1);
});

afterEach(() => resetCommandQueueForTesting());

test.each([1, 2])("accepted human input after recovery %i clears prior streak/extra before checkpoint and restart", async afterTool => {
  const result = await scenario(["reason-cap", "tool", "reason-cap", "tool", "tool", "final"],
    "streak2", undefined, { afterTool, mode: "prompt" });
  const accepted = result.events.findIndex(e => e.msg.type === "user_message" && e.msg.payload.queuedCommandUuid === "policy-boundary-input");
  expect(accepted).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(bodyAt(result.fetchImpl, afterTool * 2))).toContain("Inspect the newly requested fixture.");
  expect(modes(result.fetchImpl)).toEqual(["enabled", "disabled", "enabled", "disabled", "enabled", "enabled"]);
  expect(result.events.filter(e => e.msg.type === "warning" && e.msg.payload.cause === "reasoning_cap_policy")).toHaveLength(0);
  const checkpointEvent = result.events.slice(accepted + 1).find(e => e.msg.type === "turn_checkpoint");
  expect(checkpointEvent?.msg.type).toBe("turn_checkpoint");
  if (checkpointEvent?.msg.type !== "turn_checkpoint") throw new Error("Missing post-input checkpoint");
  const parsed = readTurnCheckpoint(JSON.parse(JSON.stringify(checkpointEvent.msg.payload)));
  const restoredSlice = parsed.checkpoint.resumableState as TurnCheckpointSlice;
  expect(restoredSlice.reasoningCapPolicy).toBeUndefined();
  const resumed = await scenario(["tool", "final"], "streak2", restoredSlice);
  expect(modes(resumed.fetchImpl)).toEqual(["enabled", "enabled"]);
});

test.each(["task-notification", "meta-prompt"] as const)("%s keeps the current human scope and earned extra", async kind => {
  const result = await scenario(["reason-cap", "tool", "reason-cap", "tool", "tool", "final"],
    "streak2", undefined, { afterTool: 2, mode: kind === "meta-prompt" ? "prompt" : "task-notification", isMeta: kind === "meta-prompt" });
  expect(JSON.stringify(bodyAt(result.fetchImpl, 4))).toContain("Inspect the newly requested fixture.");
  expect(result.events.filter(e => e.msg.type === "user_message" && e.msg.payload.queuedCommandUuid === "policy-boundary-input")).toHaveLength(0);
  expect(modes(result.fetchImpl)).toEqual(["enabled", "disabled", "enabled", "disabled", "disabled", "enabled"]);
  expect(result.events.filter(e => e.msg.type === "warning" && e.msg.payload.cause === "reasoning_cap_policy")).toHaveLength(1);
});
