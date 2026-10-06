import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { LLMResponse } from "../../src/llm/types.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { shutdownSessionLifecycle } from "../../src/session/lifecycle.js";
import { reconstructFromRollout } from "../../src/session/rollout-reconstruction.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { runTurn, setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

afterEach(() => {
  setAutoCompactImplForTests(null);
});

function postToolCompactionHarness(autoCompactTokenLimit = 3_000) {
  const cwd = mkdtempSync(join(tmpdir(), "agenc-compact-shutdown-"));
  const home = join(cwd, "home");
  const provider = mkProvider();
  let samples = 0;
  provider.chatStream = async (): Promise<LLMResponse> => {
    samples += 1;
    return {
      content: samples === 1 ? "read first" : "done",
      toolCalls: samples === 1 ? [{ id: "read-once", name: "Read", arguments: "{}" }] : [],
      usage: { promptTokens: 3_100, completionTokens: 1, totalTokens: 3_101 },
      model: "test-model",
      finishReason: samples === 1 ? "tool_calls" : "stop",
    };
  };
  const registry = {
    tools: [{ name: "Read", description: "read", inputSchema: { type: "object" },
      requiresApproval: false, recoveryCategory: "read-only",
      execute: async () => ({ content: "read result", isError: false }) }],
    toLLMTools: () => [],
    dispatch: async () => ({ content: "read result", isError: false }),
  } as unknown as ToolRegistry;
  const { session, events } = mkSession({ cwd, provider, registry });
  const store = new RolloutStore({ cwd, agencHome: home,
    sessionId: session.conversationId, agencVersion: "0.17.0",
    sessionTempRoot: join(cwd, "scratch"), autoStartScheduler: false });
  store.open({ sessionId: session.conversationId, timestamp: new Date().toISOString(),
    cwd, originator: "compact-shutdown-test", agencVersion: "0.17.0",
    model: "test-model", modelProvider: provider.name });
  session.mountRolloutStore(store);
  const base = mkCtx();
  const ctx = mkCtx({ cwd, modelInfo: { ...base.modelInfo, autoCompactTokenLimit } });
  const run = () => drain(runTurn(session, ctx, "read then finish"));
  const reconstruct = () => reconstructFromRollout(store.readAll(), {
    checkpointProjection: store.checkpointProjectionContext("compact-shutdown-test"),
  });
  const cleanup = async () => {
    await session.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  };
  return { session, events, run, reconstruct, cleanup, samples: () => samples };
}

function blockCompactionUntilAbort(harness: ReturnType<typeof postToolCompactionHarness>,
  injectionPoint: "do_not_inject" | "before_last_user_message", abortMessage: string,
  entered: PromiseWithResolvers<void>) {
  setAutoCompactImplForTests(async (_messages, _ctx, _tracking, _snip, injection) => {
    if (injection !== injectionPoint) return { wasCompacted: false };
    entered.resolve();
    return await new Promise((_resolve, reject) => {
      harness.session.abortController.signal.addEventListener("abort", () => {
        reject(new DOMException(abortMessage, "AbortError"));
      }, { once: true });
    });
  });
}

describe("compaction terminal outcome", () => {
  test.each([
    ["daemon_shutdown", "daemon_shutdown"],
    ["session_shutdown", "interrupted"],
  ] as const)("%s during pre-request compaction records %s", async (shutdownReason, expectedReason) => {
    const harness = postToolCompactionHarness(1);
    const entered = Promise.withResolvers<void>();
    try {
      blockCompactionUntilAbort(harness, "do_not_inject", "pre-request compaction aborted", entered);
      const running = harness.run().then(() => undefined, error => error);
      await entered.promise;
      await shutdownSessionLifecycle({ session: harness.session,
        shutdownReason, skipMemoryExtractionDrain: true });
      expect(await running).toBeUndefined();
      expect(harness.samples()).toBe(0);
      expect(harness.events.find(event => event.msg.type === "turn_aborted")?.msg)
        .toMatchObject({ payload: { reason: expectedReason } });
      expect(harness.events.some(event => event.msg.type === "turn_failed")).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  test("daemon shutdown during post-tool compaction leaves one resumable turn", async () => {
    const harness = postToolCompactionHarness();
    const entered = Promise.withResolvers<void>();
    try {
      blockCompactionUntilAbort(harness, "before_last_user_message", "compaction aborted", entered);
      const running = harness.run().then(() => undefined, error => error);
      await entered.promise;
      expect(harness.samples()).toBe(1);
      expect(harness.reconstruct().resumableTurns).toHaveLength(1);
      await shutdownSessionLifecycle({ session: harness.session,
        skipMemoryExtractionDrain: true });
      expect(await running).toBeUndefined();
      expect(harness.events.filter(event => event.msg.type === "turn_aborted"))
        .toEqual([expect.objectContaining({ msg: expect.objectContaining({
          payload: expect.objectContaining({ reason: "daemon_shutdown" }),
        }) })]);
      expect(harness.events.some(event => event.msg.type === "turn_failed")).toBe(false);
      expect(harness.reconstruct().resumableTurns).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  test("ordinary post-tool compaction error still fails the turn", async () => {
    const harness = postToolCompactionHarness();
    try {
      setAutoCompactImplForTests(async (_messages, _ctx, _tracking, _snip, injection) => {
        if (injection !== "before_last_user_message") return { wasCompacted: false };
        throw new Error("summary service failed");
      });
      await harness.run();
      expect(harness.events.find(event => event.msg.type === "turn_failed")?.msg)
        .toMatchObject({ payload: { code: "compact_failed" } });
      expect(harness.reconstruct().resumableTurns).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });
});
