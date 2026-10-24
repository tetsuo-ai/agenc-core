import { afterEach, expect, test, vi } from "vitest";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import { runTurn } from "../../src/session/run-turn.js";
import { oneShotFastModeActive } from "../../src/one-shot-fast-mode.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import { createTestConfigStore, mkCtx, mkProvider, mkSession } from "../fixtures.js";

afterEach(() => { vi.restoreAllMocks(); });

/**
 * The TB2.1 configuration: `agenc -p --dangerously-bypass-approvals-and-sandbox
 * --output-format stream-json` in Light. The one-shot fast loop does the work,
 * the caller requires the exact final answer, and nobody can correct the run.
 * The completion check is skipped here by default (stream-json sets
 * exactOutput). With `completion_gate.exact_output = "verify"` it runs as
 * internal work and the final answer keeps its bytes.
 */
async function runBypassExact(config: Record<string, unknown> = {}) {
  const execute = vi.fn(async () => ({ content: "listed" }));
  const provider = mkProvider();
  const requests: LLMMessage[][] = [];
  let fastCalls = 0;
  const final = "done: listed the files\n";
  provider.chatStream = async (messages): Promise<LLMResponse> => {
    requests.push(messages.map(message => ({ ...message })));
    if (oneShotFastModeActive()) fastCalls++;
    const usage = { promptTokens: 100, completionTokens: 5, totalTokens: 105 };
    if (requests.length === 1) {
      return { content: "", toolCalls: [{ id: "list-once", name: "Write", arguments: "{}" }],
        finishReason: "tool_calls", model: "test-model", usage };
    }
    if (requests.length === 2) {
      return { content: final, toolCalls: [], finishReason: "stop", model: "test-model", usage };
    }
    return { content: "- [x] Write listed the files: the Write result says listed", toolCalls: [],
      finishReason: "stop", model: "test-model", usage };
  };
  const { session, events } = mkSession({ provider, registry: {
    tools: [{ name: "Write", description: "Write", inputSchema: { type: "object" }, execute }],
    toLLMTools: () => [], dispatch: execute,
  } as never, services: {
    configStore: createTestConfigStore({ base: { provider_outage_wait_ms: 0 } }),
    runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive: true,
      dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true, exactOutput: true }),
  } });
  Object.assign(session.services, { permissionModeRegistry: new PermissionModeRegistry({
    ...session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
  }) });
  const ctx = mkCtx({ permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" },
    config: { ...mkCtx().config, bypassFastMode: true, ...config } });
  const loop = runTurn(session, ctx, "List the files, then finish.", { exactOutput: true });
  for (;;) { const next = await loop.next(); if (next.done) break; }
  const gates = events.flatMap(event => event.msg.type === "completion_gate" ? [event.msg.payload] : []);
  const terminal = events.map(event => classifyTurnTerminal(event.msg)).find(item => item !== undefined);
  return { requests, fastCalls, gates, terminal, final, execute };
}

test("by default a one-shot bypass turn with exact output skips the completion check", async () => {
  const run = await runBypassExact();
  expect(run.fastCalls).toBe(2);
  expect(run.requests).toHaveLength(2);
  expect(run.execute).toHaveBeenCalledOnce();
  expect(run.gates).toEqual([]);
  expect(run.terminal).toMatchObject({ outcome: "completed", code: 0, message: run.final });
});

test("with exact_output = verify a one-shot bypass turn runs the completion check and keeps the answer", async () => {
  const run = await runBypassExact({ completionGate: { exact_output: "verify" } });
  // The work ran in the fast loop; the check ran in the standard loop after it.
  expect(run.fastCalls).toBe(2);
  expect(run.requests).toHaveLength(3);
  expect(run.execute).toHaveBeenCalledOnce();
  expect(JSON.stringify(run.requests[2]?.at(-1)?.content)).toContain("<completion_gate round=\\\"1\\\"");
  expect(run.gates).toEqual([
    expect.objectContaining({ outcome: "injected", reason: "initial", round: 1 }),
    expect.objectContaining({ outcome: "verified", reason: "verified_with_tools", round: 1 }),
  ]);
  expect(run.terminal).toMatchObject({ outcome: "completed", code: 0, message: run.final });
});

test("completion_gate.exact_output = skip restores the unchecked one-shot answer", async () => {
  const run = await runBypassExact({ completionGate: { exact_output: "skip" } });
  expect(run.requests).toHaveLength(2);
  expect(run.gates).toEqual([]);
  expect(run.terminal).toMatchObject({ outcome: "completed", code: 0, message: run.final });
});
