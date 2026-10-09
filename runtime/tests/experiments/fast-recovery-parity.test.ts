import { expect, test, vi } from "vitest";
import { buildChatCompletionsRequest } from "../../src/llm/wire/chat-completions.js";
import { runTurn } from "../../src/session/run-turn.js";
import { oneShotFastModeActive } from "../../src/one-shot-fast-mode.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";
import type { LLMResponse } from "../../src/llm/types.js";

test.each(["reasoning-only", "truncated-tool", "exhausted"])("fast %s length recovery matches normal requests without executing partial calls", async kind => {
  const run = async (fast: boolean) => {
    const execute = vi.fn(async () => ({ content: "MUST NOT RUN" }));
    const provider = mkProvider();
    const bodies: string[] = [];
    let fastCalls = 0;
    provider.chatStream = async (messages, _delta, options): Promise<LLMResponse> => {
      if (oneShotFastModeActive()) fastCalls++;
      bodies.push(JSON.stringify(buildChatCompletionsRequest({ model: "test-model", messages, tools: options?.tools ?? [], options })));
      return bodies.length === 1 || kind === "exhausted" ? {
        content: "", toolCalls: kind === "truncated-tool" ? [{ id: "partial", name: "Write", arguments: '{"file_path":' }] : [],
        finishReason: "length", usage: { promptTokens: 100, completionTokens: 8192, totalTokens: 8292,
          ...(kind !== "truncated-tool" ? { reasoningOutputTokens: 8192 } : {}) }, model: "test-model",
      } : { content: "done", toolCalls: [], finishReason: "stop", model: "test-model",
        usage: { promptTokens: 200, completionTokens: 3, totalTokens: 203 } };
    };
    const { session } = mkSession({ provider, registry: {
      tools: [{ name: "Write", description: "Write", inputSchema: { type: "object" }, execute }],
      toLLMTools: () => [], dispatch: execute,
    }, services: { runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive: true,
      dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true }) } });
    Object.assign(session.services, { permissionModeRegistry: new PermissionModeRegistry({
      ...session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
    }) });
    const ctx = mkCtx({ permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" },
      modelInfo: { ...mkCtx().modelInfo, maxOutputTokens: 8192, maxOutputTokensExplicit: true },
      config: { ...mkCtx().config, bypassFastMode: fast } });
    const phases: unknown[] = [];
    const loop = runTurn(session, ctx, "Finish the task.", { exactOutput: true });
    let terminal;
    for (;;) { const next = await loop.next(); if (next.done) { terminal = next.value; break; } phases.push(next.value); }
    expect(bodies).toHaveLength(kind === "exhausted" ? 4 : 2);
    expect(fastCalls).toBe(fast ? 1 : 0);
    expect(terminal?.reason).toBe(kind === "exhausted" ? "model_error" : "completed");
    expect(execute).not.toHaveBeenCalled();
    if (kind !== "exhausted") expect(phases.at(-1)).toMatchObject({ type: "turn_complete", content: "done",
      usage: { promptTokens: 300, completionTokens: 8195, totalTokens: 8495 } });
    return bodies;
  };
  const normal = await run(false);
  const fast = await run(true);
  expect(fast.map(body => JSON.parse(body))).toEqual(normal.map(body => JSON.parse(body)));
  expect(fast).toEqual(normal);
});
