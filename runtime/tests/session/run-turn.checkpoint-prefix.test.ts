import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { LLMProvider, LLMResponse } from "../../src/llm/types.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { planLegacyDurableCheckpointUpgrade } from "../../src/session/durable-checkpoint-upgrade.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

// The hermetic setup loads session modules before this test's crypto mock.
vi.hoisted(() => vi.resetModules());

vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function usage(): LLMResponse["usage"] {
  return { promptTokens: 8, completionTokens: 4, totalTokens: 12, availability: "reported", provenance: "provider" };
}

test("per-tool-round checkpoint work stays flat across a long session and every checkpoint validates", async () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-checkpoint-prefix-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  const toolCallsPerTurn = 40;
  let calls = 0;
  const provider: LLMProvider = {
    ...mkProvider({}),
    chatStream: async (): Promise<LLMResponse> => {
      calls += 1;
      const step = (calls - 1) % (toolCallsPerTurn + 1);
      if (step === toolCallsPerTurn) {
        return { content: "finished", toolCalls: [], usage: usage(), model: "test-model", finishReason: "stop" };
      }
      return {
        content: "",
        toolCalls: [{ id: `read-${calls}`, name: "ReadFixture", arguments: JSON.stringify({ path: `src/file-${calls}.ts` }) }],
        usage: usage(),
        model: "test-model",
        finishReason: "tool_calls",
      };
    },
  };
  let reads = 0;
  const tool = {
    name: "ReadFixture", description: "read a fixture file", inputSchema: { type: "object" },
    requiresApproval: false, isReadOnly: true, recoveryCategory: "idempotent",
    execute: async () => {
      reads += 1;
      return { content: `file ${reads}\n${"const value = compute(input);\n".repeat(30)}`, isError: false };
    },
  };
  const registry = {
    tools: [tool],
    toLLMTools: () => [],
    dispatch: async () => tool.execute(),
  } as unknown as ToolRegistry;
  const store = new RolloutStore({ cwd, agencHome: home, sessionId: "conv-test", agencVersion: "test",
    sessionTempRoot: root, autoStartScheduler: false });
  store.open({ cwd, sessionId: "conv-test", agencVersion: "test", originator: "checkpoint-prefix-test",
    timestamp: new Date().toISOString(), model: "test-model", modelProvider: "stub-provider" });
  const { session } = mkSession({ cwd, provider, registry });
  session.mountRolloutStore(store);
  // Hash objects created between consecutive checkpoints: the whole tool
  // round's sealing, durable redaction and digest work, but no work that
  // scales with the history the round leaves behind.
  const hashesPerRound: number[] = [];
  let previous = vi.mocked(createHash).mock.calls.length;
  session.eventLog.subscribe((event) => {
    if (event.msg.type !== "turn_checkpoint") return;
    const now = vi.mocked(createHash).mock.calls.length;
    hashesPerRound.push(now - previous);
    previous = now;
  });
  try {
    await drain(session.runTurn("read the first forty files", { ctx: mkCtx({ cwd }) }));
    await drain(session.runTurn("read forty more", { ctx: mkCtx({ cwd, subId: "turn-two" }) }));
    expect(reads).toBe(2 * toolCallsPerTurn);
    expect(hashesPerRound.length).toBeGreaterThanOrEqual(4 * toolCallsPerTurn);
    // Every later round, including the second turn's start and the last round
    // (about 165 messages in), costs what an early round cost.
    const early = hashesPerRound.slice(4, 24);
    expect(Math.max(...hashesPerRound.slice(4))).toBeLessThanOrEqual(Math.max(...early) + 2);
    // The reader recomputes every checkpoint from the rollout: all must match.
    const projection = store.checkpointProjectionContext("checkpoint-prefix-test");
    const plan = planLegacyDurableCheckpointUpgrade({ items: store.readAll(), runId: "conv-test", ...projection });
    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    expect(plan.plan.changed).toBe(false);
    expect(plan.plan.checkpointsValidated).toBe(hashesPerRound.length);
  } finally {
    await session.shutdown().catch(() => undefined);
    store.close();
  }
});
