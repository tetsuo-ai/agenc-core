import { afterEach, describe, expect, test, vi } from "vitest";
import type { LLMMessage, LLMChatOptions } from "../../src/llm/types.js";
import { assembleBaseInstructionsForModel } from "../../src/prompts/system-prompt.js";
import { runTurn } from "../../src/session/run-turn.js";
import { buildSamplingRequestContract } from "../../src/session/run-turn-sampling-request.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { getPermissionsSection } from "../../src/prompts/permissions-prompt.js";
import { attachmentsToMessages } from "../../src/prompts/attachments/messages.js";
import { createAttachmentRetentionLedger, projectRetainedAttachments, recordRetainedAttachments } from "../../src/session/attachment-retention.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

afterEach(() => vi.restoreAllMocks());

describe("live permission instructions", () => {
  test("replaces plan guidance and required tool choice after an in-turn exit", async () => {
    const requests: { messages: readonly LLMMessage[]; options: LLMChatOptions | undefined }[] = [];
    const provider = mkProvider();
    const registry = {
      tools: [{ name: "ExitPlanMode", description: "Exit plan", inputSchema: { type: "object" }, execute: async () => {
        await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode: "acceptEdits" });
        return { content: "Plan approved. Continue implementation." };
      } }],
      toLLMTools: () => [{ type: "function", function: { name: "ExitPlanMode", description: "Exit plan", parameters: { type: "object" } } }],
      dispatch: async () => {
        await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode: "acceptEdits" });
        return { content: "Plan approved. Continue implementation." };
      },
    } as unknown as ToolRegistry;
    const { session, events } = mkSession({ provider, registry, services: { approvalResolver: { request: async () => ({ kind: "approved" }) } } });
    await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode: "plan" });
    const context = { ...mkCtx({ permissionMode: "plan" }), permissionInstructionsDeferred: true };
    const baseInstructions = await assembleBaseInstructionsForModel({ session, ctx: context, registry, provider: "grok", permissionContext: session.permissionModeRegistry.current(), profile: "standard" });
    provider.chatStream = async (messages, _onChunk, options) => {
      requests.push({ messages: structuredClone(messages), options: options === undefined ? undefined : { ...options } });
      return {
        content: requests.length === 1 ? "" : "Done.",
        toolCalls: requests.length === 1 ? [{ id: "exit-live-plan", name: "ExitPlanMode", arguments: "{}" }] : [],
        usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
        model: "test-model",
        finishReason: requests.length === 1 ? "tool_calls" : "stop",
      };
    };

    await drain(runTurn(session, { ...context, baseInstructions }, "Plan then implement."));

    expect(events.filter((event) => event.msg.type === "tool_call_completed").map((event) => event.msg.payload)).toEqual([expect.objectContaining({ isError: false })]);
    expect(session.permissionModeRegistry.current().mode).toBe("acceptEdits");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.options?.systemPrompt).toContain("# Permission Mode: plan");
    expect(requests[0]?.options?.toolChoice).toBe("required");
    expect(requests[1]?.options?.systemPrompt).toContain("# Permission Mode: acceptEdits");
    expect(requests[1]?.options?.systemPrompt).not.toContain("# Permission Mode: plan");
    expect(requests[1]?.options?.toolChoice).not.toBe("required");
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("Plan mode is active");
    expect(events.some((event) => event.msg.type === "turn_failed")).toBe(false);
    expect(context.permissionMode).toBe("plan");
  });

  test("uses committed mode instead of stale bootstrap mode on the next turn", async () => {
    const provider = mkProvider({ content: "Done." });
    const { session } = mkSession({ provider });
    await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode: "plan" });
    const context = { ...mkCtx({ permissionMode: "plan" }), permissionInstructionsDeferred: true };
    const baseInstructions = await assembleBaseInstructionsForModel({ session, ctx: context, registry: session.services.registry, provider: "grok", permissionContext: session.permissionModeRegistry.current(), profile: "standard" });
    await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode: "acceptEdits" });
    let systemPrompt = "";
    provider.chatStream = async (_messages, _onChunk, options) => {
      systemPrompt = options?.systemPrompt ?? "";
      return { content: "Done.", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: "test-model", finishReason: "stop" };
    };

    await drain(runTurn(session, { ...context, baseInstructions }, "Implement the approved plan."));

    expect(systemPrompt).toContain("# Permission Mode: acceptEdits");
    expect(systemPrompt).not.toContain("# Permission Mode: plan");
  });

  test("reconnects retain their captured mode and the next sample observes a transition", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const provider = mkProvider();
    const { session } = mkSession({ provider });
    await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode: "plan" });
    const requests: { messages: readonly LLMMessage[]; systemPrompt: string }[] = [];
    provider.chatStream = async (messages, _onChunk, options) => {
      requests.push({ messages: structuredClone(messages), systemPrompt: options?.systemPrompt ?? "" });
      if (requests.length === 1) {
        await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode: "acceptEdits" });
        if (options) options.systemPrompt = "PROVIDER_LOCAL_MUTATION";
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      }
      return { content: "Done.", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: "test-model", finishReason: "stop" };
    };
    const context = { ...mkCtx({ permissionMode: "plan", baseInstructions: "STABLE_BASE" }), permissionInstructionsDeferred: true };

    await drain(runTurn(session, context, "Inspect only."));
    await drain(runTurn(session, { ...context, subId: "after-reconnect" }, "Next task."));

    expect(requests).toHaveLength(3);
    expect(requests[0]?.systemPrompt).toContain("# Permission Mode: plan");
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]?.systemPrompt).toContain("# Permission Mode: acceptEdits");
    expect(JSON.stringify(requests[2]?.messages)).not.toContain("Plan mode is active");
  });

  test("does not force an obsolete plan tool after a mode change during streaming", async () => {
    const provider = mkProvider();
    const registry = { tools: [], toLLMTools: () => [{ type: "function", function: { name: "ExitPlanMode", description: "Exit plan", parameters: { type: "object" } } }], dispatch: async () => ({ content: "unused" }) } as unknown as ToolRegistry;
    const { session, events } = mkSession({ provider, registry });
    await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode: "plan" });
    let calls = 0;
    provider.chatStream = async () => {
      calls += 1;
      await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode: "acceptEdits" });
      return { content: "Inspection complete.", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: "test-model", finishReason: "stop" };
    };

    await drain(runTurn(session, mkCtx({ permissionMode: "plan" }), "Inspect only."));

    expect(calls).toBe(1);
    expect(events.some((event) => event.msg.type === "turn_failed")).toBe(false);
  });

  test("shares current permission instructions with compaction accounting without duplicating the base", async () => {
    const { session } = mkSession();
    await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode: "acceptEdits" });
    const context = { ...mkCtx({ permissionMode: "plan", baseInstructions: "STABLE_BASE" }), permissionInstructionsDeferred: true };
    const state = buildInitialTurnState(context, { role: "user", content: "Continue." }, { modelInstructions: "STABLE_BASE" });

    const request = buildSamplingRequestContract(state, session, context);

    expect(request.baseInstructions).toBe(`STABLE_BASE\n\n${getPermissionsSection(session.permissionModeRegistry.current(), { sandboxPolicy: context.sandboxPolicy.value, networkSandboxPolicy: context.networkSandboxPolicy })}`);
    expect(request.baseInstructions).toContain("# Permission Mode: acceptEdits");
    expect(request.baseInstructions).not.toContain("# Permission Mode: plan");
  });

  test("removes only obsolete typed reminders and keeps user text and unrelated attachments", () => {
    const ledger = createAttachmentRetentionLedger();
    const history: LLMMessage[] = [{ role: "user", content: "Quote: Plan mode is active" }];
    const reminders = attachmentsToMessages([
      { kind: "plan_mode", variant: "full", planFilePath: "/tmp/plan.md", planExists: false },
      { kind: "date_change", newDate: "2026-09-10" },
    ]);
    recordRetainedAttachments(ledger, history, 0, "before", reminders);

    const projected = projectRetainedAttachments(history, ledger, "acceptEdits");

    expect(projected.messages).toHaveLength(2);
    expect(projected.messages.at(-1)).toEqual(history[0]);
    expect(JSON.stringify(projected.messages)).toContain("2026-09-10");
    expect(projected.messages.some((message) => message.runtimeOnly?.permissionModeReminder === "plan")).toBe(false);
    expect(projectRetainedAttachments(history, ledger, "plan").messages).toEqual(projected.messages);
  });

  test("keeps permission projection scoped to its owner and preserves compact profiles", async () => {
    const first = mkSession().session;
    const second = mkSession().session;
    await first.permissionModeRegistry.update({ ...first.permissionModeRegistry.current(), mode: "plan" });
    await second.permissionModeRegistry.update({ ...second.permissionModeRegistry.current(), mode: "acceptEdits" });
    const context = { ...mkCtx(), permissionInstructionsDeferred: true };

    const state = buildInitialTurnState(context, { role: "user", content: "Continue." }, { modelInstructions: "" });
    expect(buildSamplingRequestContract(state, first, context).baseInstructions).toContain("# Permission Mode: plan");
    expect(buildSamplingRequestContract(state, second, context).baseInstructions).toContain("# Permission Mode: acceptEdits");
    expect(buildSamplingRequestContract(state, first, { ...context, modelProviderId: "lmstudio" }).baseInstructions).toBe("");
    expect(buildSamplingRequestContract(state, first, { ...context, config: { ...context.config, coordinatorMode: true } }).baseInstructions).toBe("");
  });

  test("failed permission publication retains committed guidance and pending authority fails closed", async () => {
    const { session } = mkSession();
    const registry = session.permissionModeRegistry;
    await registry.update({ ...registry.current(), mode: "plan" });
    const context = { ...mkCtx(), permissionInstructionsDeferred: true };
    const state = buildInitialTurnState(context, { role: "user", content: "Continue." }, { modelInstructions: "" });
    const removeHook = registry.installBeforeUpdateHook(() => { throw new Error("publication refused"); });
    try {
      await expect(registry.update({ ...registry.current(), mode: "acceptEdits" })).rejects.toThrow("publication refused");
      expect(buildSamplingRequestContract(state, session, context).baseInstructions).toContain("# Permission Mode: plan");
    } finally {
      removeHook();
    }
    registry.beginExternalAuthorityPublication();
    expect(() => buildSamplingRequestContract(state, session, context)).toThrow(/permission.*authority/i);
  });
});
