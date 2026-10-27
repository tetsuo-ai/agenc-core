import { expect, it, vi } from "vitest";
import { runTurn } from "../../src/session/run-turn.js";
import type { LLMResponse } from "../../src/llm/types.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";

it("resumes an interactive turn after its admitted tool completes and the user removes the cap", async () => {
  const provider = mkProvider(); let calls = 0; let completed = false;
  provider.chatStream = async (): Promise<LLMResponse> => {
    calls++;
    return { content: calls === 1 ? "Checking the fix." : "The check passed.",
      toolCalls: calls === 1 ? [{ id: "check", name: "probe", arguments: "{}" }] : [],
      model: "test-model", finishReason: calls === 1 ? "tool_calls" : "stop",
      usage: { promptTokens: calls === 1 ? 50_000 : 10, completionTokens: 1,
        totalTokens: calls === 1 ? 50_001 : 11, availability: "reported", provenance: "provider" } };
  };
  const registry = { tools: [{ name: "probe", description: "check", inputSchema: { type: "object" }, requiresApproval: false,
    recoveryCategory: "idempotent", execute: async () => { completed = true; return { content: "passed" }; } }],
    toLLMTools: () => [], dispatch: async () => ({ content: "passed" }) } as unknown as ToolRegistry;
  const { session } = mkSession({ provider, registry });
  Object.assign(session.services, { runtimeOptions: { ...session.services.runtimeOptions, interactiveTaskBudget: true } });
  Object.assign(session.config, { taskTokenBudget: 50_000 });
  const request = vi.spyOn(session, "requestUserInput").mockImplementation(async () => {
    expect(completed).toBe(true); expect(calls).toBe(1);
    return { answers: { task_budget: { answers: ["Remove the limit for this task"] } } };
  });
  const phases: PhaseEvent[] = [];
  for await (const phase of runTurn(session, mkCtx(), "Fix and check")) phases.push(phase);
  expect(phases.at(-1)?.error).toBeUndefined();
  expect(calls).toBe(2);
  expect(request).toHaveBeenCalledOnce();
  expect(phases.at(-1)).toMatchObject({ content: "The check passed." });
  expect(phases.at(-1)?.stopReason).not.toBe("task_budget");
});
