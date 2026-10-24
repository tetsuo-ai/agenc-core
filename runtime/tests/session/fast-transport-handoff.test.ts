import { afterEach, expect, test, vi } from "vitest";
import { runTurn } from "../../src/session/run-turn.js";
import { oneShotFastModeActive } from "../../src/one-shot-fast-mode.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { LLMProviderError, LLMServerError, LLMStreamTruncatedError } from "../../src/llm/errors.js";
import { createTestConfigStore, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import type { LLMResponse } from "../../src/llm/types.js";

afterEach(() => { vi.restoreAllMocks(); });

// The shapes TB2.1 trials ended on: a DeepSeek stream cut before its terminal
// event, a recorder 502 and an upstream connection reset.
const failures: Record<string, () => Error> = {
  stream_truncated: () => new LLMStreamTruncatedError("deepseek", "DeepSeek SSE stream closed before any finish_reason"),
  http_502: () => new LLMServerError("deepseek", 502, "upstream transport failure"),
  connection_reset: () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
};

test.each(Object.keys(failures))("a one-shot bypass turn retries a %s like the standard loop without replaying tools", async kind => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const run = async (fast: boolean) => {
    const execute = vi.fn(async () => ({ content: "listed" }));
    const provider = mkProvider();
    let calls = 0;
    let fastCalls = 0;
    provider.chatStream = async (): Promise<LLMResponse> => {
      calls++;
      if (oneShotFastModeActive()) fastCalls++;
      if (calls === 1) {
        return { content: "", toolCalls: [{ id: "list-once", name: "Write", arguments: "{}" }],
          finishReason: "tool_calls", model: "test-model",
          usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 } };
      }
      if (calls === 2) throw failures[kind]!();
      return { content: "done", toolCalls: [], finishReason: "stop", model: "test-model",
        usage: { promptTokens: 200, completionTokens: 3, totalTokens: 203 } };
    };
    const { session, events } = mkSession({ provider, registry: {
      tools: [{ name: "Write", description: "Write", inputSchema: { type: "object" }, execute }],
      toLLMTools: () => [], dispatch: execute,
    } as never, services: {
      configStore: createTestConfigStore({ base: { provider_outage_wait_ms: 0 } }),
      runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive: true,
        dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true }),
    } });
    Object.assign(session.services, { permissionModeRegistry: new PermissionModeRegistry({
      ...session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
    }) });
    const ctx = mkCtx({ permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" },
      config: { ...mkCtx().config, bypassFastMode: fast } });
    const phases: unknown[] = [];
    const loop = runTurn(session, ctx, "List the files, then finish.", { exactOutput: true });
    let terminal;
    for (;;) { const next = await loop.next(); if (next.done) { terminal = next.value; break; } phases.push(next.value); }
    expect(terminal?.reason).toBe("completed");
    expect(calls).toBe(3);
    // The tool from the first response ran once; the cut response had none to replay.
    expect(execute).toHaveBeenCalledOnce();
    expect(events.some(event => event.msg.type === "turn_failed")).toBe(false);
    expect(phases.at(-1)).toMatchObject({ type: "turn_complete", content: "done" });
    const receipts = events.filter(event => event.msg.type === "warning" &&
      (event.msg.payload as { cause?: string }).cause === "transport_recovery");
    if (fast) {
      // Two fast samples (the tool call and the cut one); the retry ran in the standard loop.
      expect(fastCalls).toBe(2);
      expect(receipts).toContainEqual(expect.objectContaining({ msg: expect.objectContaining({ payload: expect.objectContaining({
        details: expect.objectContaining({ outcome: "interrupted", loop: "one_shot_fast", completedToolCallIds: "list-once", toolReplay: false }),
      }) }) }));
    } else {
      expect(fastCalls).toBe(0);
    }
    expect(receipts.length).toBeGreaterThan(0);
  };
  await run(false);
  await run(true);
});

test("a one-shot bypass turn still ends on a non-transient provider error", async () => {
  const provider = mkProvider();
  let calls = 0;
  provider.chatStream = async (): Promise<LLMResponse> => {
    calls++;
    throw new LLMProviderError("deepseek", "invalid request", 400);
  };
  const { session } = mkSession({ provider, services: {
    configStore: createTestConfigStore({ base: { provider_outage_wait_ms: 0 } }),
    runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive: true,
      dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true }),
  } });
  Object.assign(session.services, { permissionModeRegistry: new PermissionModeRegistry({
    ...session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
  }) });
  const ctx = mkCtx({ permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" },
    config: { ...mkCtx().config, bypassFastMode: true } });
  const loop = runTurn(session, ctx, "Finish.", { exactOutput: true });
  await expect((async () => { for (;;) { const next = await loop.next(); if (next.done) return next.value; } })())
    .rejects.toThrow(/invalid request/);
  expect(calls).toBe(1);
});
