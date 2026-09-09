import { describe, expect, test, vi } from "vitest";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import { findToolTurnValidationIssue } from "../../src/llm/tool-turn-validator.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import { runTurn } from "../../src/session/run-turn.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import type { Tool } from "../../src/tools/types.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

function registryFor(tool: Tool): ToolRegistry {
  return {
    tools: [tool],
    toLLMTools: () => [{
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }],
    dispatch: async () => ({ content: "unexpected legacy dispatch", isError: true }),
  } as ToolRegistry;
}

describe("workflow turn boundaries", () => {
  test("ends an inspection turn after its conditional offer without executing the proposed work", async () => {
    const execute = vi.fn(async () => ({ content: "must not write" }));
    const registry = registryFor({ name: "write_notes", description: "Write the notes CLI", inputSchema: { type: "object" }, execute });
    const provider = mkProvider();
    let samples = 0;
    provider.chatStream = async () => {
      samples += 1;
      return {
        content: samples === 1 ? "I can implement the notes CLI, tests, and README if you want that next." : "Created the notes CLI.",
        toolCalls: samples === 2 ? [{ id: "unrequested-write", name: "write_notes", arguments: "{}" }] : [],
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        model: "test-model",
        finishReason: samples === 2 ? "tool_calls" : "stop",
      };
    };
    const { session, events } = mkSession({ provider, registry });

    await drain(runTurn(session, mkCtx(), "Inspect this directory and suggest a useful next step."));

    expect(samples).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(events.filter((event) => event.msg.type === "turn_complete")).toHaveLength(1);
  });

  test("fails a resolver-denied action with truthful text while keeping the session reusable", async () => {
    const execute = vi.fn(async () => ({ content: "must not execute" }));
    const registry = registryFor({ name: "spawn_agent", description: "Spawn a verifier", inputSchema: { type: "object" }, requiresApproval: true, execute });
    const provider = mkProvider({
      content: "I'll have a verification agent check the implementation.",
      toolCalls: [{ id: "denied-spawn", name: "spawn_agent", arguments: "{}" }],
      finishReason: "tool_calls",
    });
    const sample = vi.fn(provider.chatStream);
    provider.chatStream = sample;
    const request = vi.fn(async () => ({ kind: "denied" as const }));
    const stop = vi.fn(async () => ({}));
    const { session, events } = mkSession({
      provider,
      registry,
      services: { approvalResolver: { request }, hooks: { executeStop: stop } },
    });
    const ctx = mkCtx({ approvalPolicy: { value: "on_request" }, sandboxPolicy: { value: "workspace_write" } });
    const phases: PhaseEvent[] = [];

    for await (const phase of runTurn(session, ctx, "Check the implementation.")) phases.push(phase);

    expect(request).toHaveBeenCalledTimes(1);
    expect(sample).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(events.flatMap((event) => {
      const terminal = classifyTurnTerminal(event.msg);
      return terminal === undefined ? [] : [terminal];
    })).toEqual([expect.objectContaining({ outcome: "errored", code: 1, message: expect.stringMatching(/approval.*denied/i) })]);
    const closures = events.filter((event) => event.msg.type === "tool_call_completed" && event.msg.payload.callId === "denied-spawn");
    expect(closures).toHaveLength(1);
    expect(closures[0]?.msg).toMatchObject({ payload: { isError: true, metadata: { approvalDenied: true } } });
    expect(events.indexOf(closures[0]!)).toBeLessThan(events.findIndex((event) => event.msg.type === "turn_failed"));
    expect(phases.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "error", content: expect.stringMatching(/approval.*denied/i) });
    expect(session.snapshotHistoryMessages().at(-1)).toMatchObject({ role: "assistant", content: expect.stringMatching(/approval.*denied/i) });
    expect(findToolTurnValidationIssue(session.snapshotHistoryMessages())).toBeNull();
    expect(session.abortController.signal.aborted).toBe(false);

    provider.chatStream = mkProvider({ content: "Finished the allowed follow-up." }).chatStream;
    const previousEvents = events.length;
    await drain(runTurn(session, { ...ctx, subId: "allowed-followup" }, "Explain the code instead."));
    expect(events.slice(previousEvents).map((event) => classifyTurnTerminal(event.msg)))
      .toContainEqual(expect.objectContaining({ outcome: "completed", code: 0 }));
  });

  test("lets the model explain an unavailable approval resolver rather than marking a user denial", async () => {
    const execute = vi.fn(async () => ({ content: "must not execute" }));
    const registry = registryFor({ name: "approval_required", description: "Requires approval", inputSchema: { type: "object" }, requiresApproval: true, execute });
    const provider = mkProvider();
    let samples = 0;
    provider.chatStream = async () => {
      samples += 1;
      return {
        content: samples === 1 ? "Checking whether this action is permitted." : "No approval resolver is available, so I made no changes.",
        toolCalls: samples === 1 ? [{ id: "default-denial", name: "approval_required", arguments: "{}" }] : [],
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        model: "test-model",
        finishReason: samples === 1 ? "tool_calls" : "stop",
      };
    };
    const { session, events } = mkSession({ provider, registry });

    await drain(runTurn(session, mkCtx({ approvalPolicy: { value: "on_request" }, sandboxPolicy: { value: "workspace_write" } }), "Explain whether this action can run."));

    expect(samples).toBe(2);
    expect(execute).not.toHaveBeenCalled();
    const closure = events.find((event) => event.msg.type === "tool_call_completed" && event.msg.payload.callId === "default-denial");
    expect(closure?.msg).toMatchObject({ payload: { isError: true } });
    if (closure?.msg.type === "tool_call_completed") expect(closure.msg.payload.metadata?.approvalDenied).toBeUndefined();
    expect(events.some((event) => event.msg.type === "turn_failed")).toBe(false);
    expect(events.map((event) => classifyTurnTerminal(event.msg)))
      .toContainEqual(expect.objectContaining({ outcome: "completed", message: "No approval resolver is available, so I made no changes." }));
  });
});
