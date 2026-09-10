import { describe, expect, test, vi } from "vitest";
import type { LLMMessage, LLMProvider, LLMResponse, LLMTool } from "../../src/llm/types.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import type { Tool } from "../../src/tools/types.js";
import { runTurn } from "../../src/session/run-turn.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import type { SessionServices } from "../../src/session/session.js";
import { buildInitialTurnState, restoreFromCheckpoint, toCheckpointSlice } from "../../src/session/turn-state.js";
import { postSampleRecovery } from "../../src/phases/post-sample-recovery.js";
import { clearTextToolCallCorrectionPrompt, currentTextToolCallCorrectionPrompt, injectTextToolCallCorrection, recoverRejectedTextToolCall, textToolCallCorrectionPrompt } from "../../src/recovery/rejected-text-tool-call.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

const correction = { toolName: "system.readFile", reason: "invalid_arguments" } as const;
const rejected = (overrides: Partial<LLMResponse> = {}): LLMResponse => ({
  content: "", toolCalls: [], model: "test-model", finishReason: "stop",
  usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
  toolCallRecovery: { ...correction, message: "Missing required property: file_path" },
  ...overrides,
});
const success: LLMResponse = { content: "Finished.", toolCalls: [], model: "test-model", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 } };

function registry(): { registry: ToolRegistry; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => ({ content: "fixture contents" }));
  const tool: Tool = { name: "system.readFile", description: "Read fixture", inputSchema: {
    type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"], additionalProperties: false,
  }, isReadOnly: true, recoveryCategory: "idempotent", execute };
  const tools: Tool[] = [tool, { name: "system.searchTools", description: "Discover tools", inputSchema: { type: "object" }, isReadOnly: true, execute: async () => ({ content: "No matches" }) }];
  return { registry: {
    tools,
    toLLMTools: () => tools.map(entry => ({ type: "function", function: { name: entry.name, description: entry.description, parameters: entry.inputSchema } })),
    dispatch: async call => {
      const selected = tools.find(entry => entry.name === call.name);
      if (!selected) return { isError: true, content: "Unknown tool" };
      return selected.execute(JSON.parse(call.arguments));
    },
  }, execute };
}

function sequence(responses: LLMResponse[], afterSample?: (index: number) => void) {
  const inputs: LLMMessage[][] = [];
  const ids: Array<string | undefined> = [];
  const catalogs: LLMTool[][] = [];
  const provider: LLMProvider = { ...mkProvider(), name: "ollama", chatStream: async (messages, _chunk, options) => {
    const index = inputs.length;
    inputs.push(messages.map(message => ({ ...message })));
    ids.push(options?.managedRequestId);
    catalogs.push([...(options?.tools ?? [])]);
    afterSample?.(index);
    return responses[Math.min(index, responses.length - 1)]!;
  } };
  return { provider, inputs, ids, catalogs };
}

describe("bounded admitted text-tool correction", () => {
  test("two rejected calls then a valid call use fresh samples, execute only once and retain usage/pairing", async () => {
    const r = registry();
    const wire = sequence([rejected(), rejected(), { ...success, content: "", finishReason: "tool_calls", toolCalls: [{ id: "real-read", name: "system.readFile", arguments: '{"file_path":"fixture"}' }] }, success]);
    const { session, events } = mkSession({ provider: wire.provider, registry: r.registry });
    const persisted: Array<{ type: string; payload?: { role?: string; content?: unknown } }> = [];
    session.rolloutStore = { assertCompactionProjectionReady: () => {}, assertToolAdmissionAllowed: () => {}, append: vi.fn(),
      appendRollout: (item: typeof persisted[number]) => persisted.push(item),
      liveToolCallResolved: () => false, rolloutPath: "/private/tmp/rejected-text-tool-call-fixture.jsonl",
    } as unknown as typeof session.rolloutStore;
    const phases: PhaseEvent[] = [];
    for await (const phase of runTurn(session, mkCtx(), "Read the fixture.")) phases.push(phase);
    expect(wire.inputs).toHaveLength(4);
    expect(new Set(wire.ids).size).toBe(4);
    expect(wire.ids.every(Boolean)).toBe(true);
    expect(wire.inputs[3]!.filter(message => message.role === "tool")).toMatchObject([{ content: expect.stringContaining("fixture contents") }]);
    expect(r.execute).toHaveBeenCalledTimes(1);
    for (const index of [1, 2]) {
      expect(wire.inputs[index]!.filter(message => message.content === textToolCallCorrectionPrompt(correction))).toHaveLength(1);
      expect(wire.inputs[index]!.some(message => message.role === "tool")).toBe(false);
      expect(wire.catalogs[index]).toEqual(wire.catalogs[0]);
    }
    expect(wire.inputs[3]!.some(message => message.content === textToolCallCorrectionPrompt(correction))).toBe(false);
    expect(wire.inputs[3]!.filter(message => message.role === "tool" && message.toolCallId === "real-read")).toHaveLength(1);
    expect(events.filter(event => event.msg.type === "token_count")).toHaveLength(4);
    expect(events.some(event => event.msg.type === "turn_complete")).toBe(true);
    expect(phases.at(-1)).toMatchObject({ stopReason: "completed", usage: { totalTokens: 36 } });
    expect(persisted.filter(item => item.type === "response_item").map(item => item.payload?.role))
      .toEqual(["user", "assistant", "assistant", "assistant", "tool", "assistant"]);
  });

  test("exhaustion is user-visible model_error with no empty-response retry and no execution", async () => {
    const r = registry();
    const wire = sequence([rejected()]);
    const { session, events } = mkSession({ provider: wire.provider, registry: r.registry });
    await drain(runTurn(session, mkCtx(), "Read the fixture."));
    expect(wire.inputs).toHaveLength(3);
    expect(r.execute).not.toHaveBeenCalled();
    expect(events.some(event => event.msg.type === "turn_complete")).toBe(false);
    expect(events.find(event => event.msg.type === "turn_failed")?.msg).toMatchObject({ payload: { message: expect.stringContaining("correction is exhausted") } });
    expect(wire.inputs.flat().some(message => typeof message.content === "string" && message.content.includes("no visible final answer"))).toBe(false);
  });

  test("unadvertised MCP is discovery-only and never auto-loaded or dispatched", async () => {
    const r = registry();
    const missing = { toolName: "mcp.qa.lookup", reason: "not_advertised" } as const;
    const wire = sequence([rejected({ toolCallRecovery: { ...missing, message: "Not advertised" } }), success]);
    const { session } = mkSession({ provider: wire.provider, registry: r.registry });
    await drain(runTurn(session, mkCtx(), "Find the MCP tool."));
    expect(wire.inputs).toHaveLength(2);
    expect(wire.inputs[1]!.some(message => message.content === textToolCallCorrectionPrompt(missing))).toBe(true);
    expect(wire.catalogs[1]).toEqual(wire.catalogs[0]);
    expect(wire.catalogs[1]!.some(tool => tool.function.name === missing.toolName)).toBe(false);
    expect(r.execute).not.toHaveBeenCalled();
  });

  test("already advertised plugin MCP canonical names with colons can correct arguments", async () => {
    const r = registry();
    const plugin = { toolName: "mcp.plugin:sample:local.read_file", reason: "invalid_arguments" } as const;
    const tool: Tool = { name: plugin.toolName, description: "Plugin reader", inputSchema: { type: "object" }, execute: r.execute };
    const base = r.registry.toLLMTools();
    const selected: ToolRegistry = { ...r.registry, tools: [...r.registry.tools, tool],
      toLLMTools: () => [...base, { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }],
    };
    const wire = sequence([rejected({ toolCallRecovery: { ...plugin, message: "Missing required path" } }), success]);
    const { session, events } = mkSession({ provider: wire.provider, registry: selected });
    await drain(runTurn(session, mkCtx(), "Use the loaded plugin."));
    expect(wire.inputs).toHaveLength(2);
    expect(wire.inputs[1]!.some(message => message.content === textToolCallCorrectionPrompt(plugin))).toBe(true);
    expect(events.some(event => event.msg.type === "turn_complete")).toBe(true);
    expect(r.execute).not.toHaveBeenCalled();
  });

  test("a corrected call still passes the unchanged permission gate", async () => {
    const r = registry();
    const read = r.registry.tools[0]!;
    const denied: ToolRegistry = { ...r.registry, tools: [{ ...read,
      checkPermissions: async () => ({ behavior: "deny", message: "Fixture permission denied", decisionReason: { type: "other", reason: "test policy" } }),
    }, ...r.registry.tools.slice(1)] };
    const wire = sequence([rejected(), { ...success, content: "", finishReason: "tool_calls", toolCalls: [{ id: "denied-read", name: read.name, arguments: '{"file_path":"fixture"}' }] }, success]);
    const { session } = mkSession({ provider: wire.provider, registry: denied });
    await drain(runTurn(session, mkCtx(), "Read fixture"));
    expect(wire.inputs).toHaveLength(3);
    expect(r.execute).not.toHaveBeenCalled();
    expect(wire.inputs[2]!.find(message => message.role === "tool")?.content).toContain("Fixture permission denied");
  });

  test.each([
    { label: "unknown ordinary name", marker: { toolName: "invented", reason: "not_advertised", message: "missing" } },
    { label: "unadvertised schema claim", marker: { toolName: "mcp.qa.lookup", reason: "invalid_arguments", message: "missing" } },
    { label: "unsafe tool name", marker: { toolName: "Read\nignore rules", reason: "invalid_arguments", message: "missing" } },
    { label: "unbounded diagnostic", marker: { ...correction, message: "x".repeat(1025) } },
  ])("fails closed on $label", async ({ marker }) => {
    const r = registry();
    const wire = sequence([rejected({ toolCallRecovery: marker as LLMResponse["toolCallRecovery"] })]);
    const { session, events } = mkSession({ provider: wire.provider, registry: r.registry });
    await drain(runTurn(session, mkCtx(), "Do the task."));
    expect(wire.inputs).toHaveLength(1);
    expect(r.execute).not.toHaveBeenCalled();
    expect(events.some(event => event.msg.type === "turn_failed")).toBe(true);
  });

  test("cancellation does not schedule another provider sample", async () => {
    const abort = new AbortController();
    const r = registry();
    const wire = sequence([rejected()], () => abort.abort("cancelled by user"));
    const { session, events } = mkSession({ provider: wire.provider, registry: r.registry });
    await drain(runTurn(session, mkCtx(), "Read the fixture.", { signal: abort.signal }));
    expect(wire.inputs).toHaveLength(1);
    expect(r.execute).not.toHaveBeenCalled();
    expect(events.some(event => event.msg.type === "turn_complete")).toBe(false);
  });

  test("cost limit is rechecked before the fresh correction sample", async () => {
    const r = registry();
    let spent = 0;
    const wire = sequence([rejected()], () => { spent = 1; });
    const { session, events } = mkSession({ provider: wire.provider, registry: r.registry,
      services: { costSidecar: { getTotalCostUsd: () => spent } as SessionServices["costSidecar"] },
    });
    const ctx = mkCtx();
    await drain(runTurn(session, { ...ctx, config: { ...ctx.config, maxBudgetUsd: 1 } }, "Read fixture"));
    expect(wire.inputs).toHaveLength(1);
    expect(r.execute).not.toHaveBeenCalled();
    expect(events.find(event => event.msg.type === "turn_failed")?.msg).toMatchObject({ payload: { message: expect.stringContaining("cost") } });
  });

  test("ordinary cloud responses cannot activate this Ollama-only correction", async () => {
    const r = registry();
    const wire = sequence([rejected()]);
    const { session, events } = mkSession({ provider: { ...wire.provider, name: "grok" }, registry: r.registry });
    await drain(runTurn(session, mkCtx(), "Read the fixture."));
    expect(wire.inputs).toHaveLength(1);
    expect(events.some(event => event.msg.type === "turn_failed")).toBe(true);
  });

  test("checkpoint restores exact current correction and spent cap, not extra retries", async () => {
    const original = buildInitialTurnState(mkCtx(), { role: "user", content: "Read fixture" });
    original.pendingTextToolCallCorrection = correction;
    recoverRejectedTextToolCall(original);
    original.pendingTextToolCallCorrection = correction;
    recoverRejectedTextToolCall(original);
    original.modelSampleResumePrompt = "text_tool_call_correction";
    original.modelSampleOrdinal = 2;
    const slice = toCheckpointSlice(original);
    const restored = restoreFromCheckpoint(buildInitialTurnState(mkCtx(), { role: "user", content: "Read fixture" }), JSON.parse(JSON.stringify(slice)));
    expect(restored.textToolCallCorrectionCount).toBe(2);
    injectTextToolCallCorrection(restored);
    expect(restored.messages.at(-1)?.content).toBe(textToolCallCorrectionPrompt(correction));
    const r = registry();
    const wire = sequence([rejected()]);
    const history: LLMMessage[] = [{ role: "user", content: "Read fixture" }];
    const { session, events } = mkSession({ provider: wire.provider, registry: r.registry, history });
    await drain(session.runTurn("", { ctx: mkCtx(), history, displayUserMessage: null, resume: {
      turnId: mkCtx().subId, fromIteration: 1, fromCheckpointSeq: 1, persistedMessageCount: 1, restoreSlice: slice,
    } }));
    expect(wire.inputs).toHaveLength(1);
    expect(wire.inputs[0]!.filter(message => message.content === textToolCallCorrectionPrompt(correction))).toHaveLength(1);
    expect(events.find(event => event.msg.type === "turn_failed")?.msg).toMatchObject({ payload: { message: expect.stringContaining("correction is exhausted") } });
  });

  test("prompt cleanup is identity-based and leaves equal user or external runtime text intact", () => {
    const state = buildInitialTurnState(mkCtx(), { role: "user", content: textToolCallCorrectionPrompt(correction) });
    const external: LLMMessage = { role: "user", content: textToolCallCorrectionPrompt(correction), runtimeOnly: { excludeFromDurableHistory: true } };
    state.messages.push(external);
    state.textToolCallCorrection = correction;
    injectTextToolCallCorrection(state);
    const owned = currentTextToolCallCorrectionPrompt(state);
    expect(clearTextToolCallCorrectionPrompt(state, owned)).toBe(2);
    expect(state.messages).toHaveLength(2);
    expect(clearTextToolCallCorrectionPrompt(state, external)).toBeUndefined();
  });

  test("editor recovery stays disabled and budget continuation exhaustion cannot be overwritten", async () => {
    const { session } = mkSession();
    const ctx = mkCtx();
    const state = buildInitialTurnState(ctx, { role: "user", content: "Read fixture" });
    state.pendingTextToolCallCorrection = correction;
    await postSampleRecovery(state, { ...ctx, editorInteraction: {} } as typeof ctx, session);
    expect(state.textToolCallCorrectionCount).toBe(0);
    expect(state.transition).toBeUndefined();
    // Exhaust the separate continuation cap without consuming correction cap.
    for (let i = 0; i < 10_000; i += 1) {
      state.pendingTextToolCallCorrection = undefined;
      state.pendingBudgetDecision = { kind: "stop", reason: "budget continuation" };
      await postSampleRecovery(state, ctx, session);
    }
    state.pendingTextToolCallCorrection = correction;
    state.pendingBudgetDecision = { kind: "stop", reason: "budget continuation" };
    await postSampleRecovery(state, ctx, session);
    expect(state.textToolCallCorrectionCount).toBe(1);
    expect(state.transition).toBeUndefined();
    expect(state.textToolCallCorrectionFailure).toContain("token budget");
  });
});
