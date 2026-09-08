import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionRouter } from "../../src/gateway/session-router.js";
import type {
  ChannelAdapter,
  GatewayDaemonClient,
  GatewayPromptHandlers,
  GatewayPromptResult,
  GatewaySession,
} from "../../src/gateway/types.js";

const completed: GatewayPromptResult = {
  stopReason: "completed",
  finalMessage: "final answer",
};

describe("SessionRouter delivery failures", () => {
  let home: string;
  let finishPrompt: ReturnType<typeof Promise.withResolvers<GatewayPromptResult>>;
  let handlersReady: ReturnType<typeof Promise.withResolvers<GatewayPromptHandlers>>;
  let promptCalls: number;
  let sessionCreates: number;
  let outcomes: Promise<unknown>[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-router-delivery-"));
    finishPrompt = Promise.withResolvers<GatewayPromptResult>();
    handlersReady = Promise.withResolvers<GatewayPromptHandlers>();
    promptCalls = 0;
    sessionCreates = 0;
    outcomes = [];
  });

  afterEach(async () => {
    finishPrompt.resolve(completed);
    await Promise.all(outcomes);
    rmSync(home, { recursive: true, force: true });
  });

  function setup(send: ChannelAdapter["send"], supportsEdit = true) {
    const session: GatewaySession = {
      sessionId: "delivery-session",
      prompt: async (_text, handlers) => {
        promptCalls += 1;
        if (promptCalls > 1) return completed;
        handlersReady.resolve(handlers);
        return finishPrompt.promise;
      },
    };
    const client: GatewayDaemonClient = {
      createSession: async () => { sessionCreates += 1; return session; },
      attachSession: async () => session,
      close: async () => {},
    };
    const adapter: ChannelAdapter = {
      id: "test", supportsEdit, send,
      start: async () => {}, stop: async () => {},
    };
    const router = new SessionRouter({ agencHome: home, client, flushIntervalMs: 0 });
    return () => {
      const outcome = router.runTurn({
        key: "conversation", text: "request", conversationId: "conversation", adapter,
        onPermissionRequest: async () => ({ behavior: "deny" }),
      }).then(
        (value) => ({ kind: "completed" as const, value }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
      outcomes.push(outcome);
      return outcome;
    };
  }

  it.each([1, 2])("observes send %s failure while prompt is pending and stops queued/later chunks", async (failAt) => {
    const failure = new Error("delivery failed");
    let sends = 0;
    let lateDeltaReads = 0;
    const run = setup(async () => {
      sends += 1;
      if (sends === failAt) throw failure;
      return "message-id";
    });
    const first = run();
    const handlers = await handlersReady.promise;
    handlers.onEvent({ type: "text", delta: "first" });
    await nextEventLoopTurn();
    if (failAt === 2) {
      handlers.onEvent({ type: "text", delta: "second" });
    }
    handlers.onEvent({ type: "text", delta: "queued" });
    await nextEventLoopTurn();
    handlers.onEvent({ type: "text", get delta() { lateDeltaReads += 1; return "late"; } });
    const next = run();
    await nextEventLoopTurn();
    expect(promptCalls).toBe(1);
    expect(sends).toBe(failAt);
    expect(lateDeltaReads).toBe(0);
    finishPrompt.resolve(completed);
    await expect(first).resolves.toEqual({ kind: "failed", error: failure });
    await expect(next).resolves.toEqual({ kind: "completed", value: completed });
    expect(promptCalls).toBe(2);
    expect(sends).toBe(failAt + 1);
  });

  it.each([undefined, null, "delivery rejected", { reason: "delivery rejected" }])(
    "retains the first delivery rejection when the prompt also fails (%j)",
    async (failure) => {
      const run = setup(async () => { throw failure; });
      const outcome = run();
      const handlers = await handlersReady.promise;
      handlers.onEvent({ type: "text", delta: "first" });
      await nextEventLoopTurn();
      finishPrompt.reject(new Error("later prompt failure"));
      const result = await outcome;
      expect(result.kind).toBe("failed");
      expect("error" in result && result.error).toBe(failure);
    },
  );

  it("does not replay the prompt when an adapter failure resembles a missing daemon agent", async () => {
    const failure = Object.assign(new Error("adapter agent missing"), {
      data: { code: "AGENT_NOT_FOUND" },
    });
    const run = setup(async () => { throw failure; });
    const outcome = run();
    const handlers = await handlersReady.promise;
    handlers.onEvent({ type: "text", delta: "first" });
    await nextEventLoopTurn();
    finishPrompt.resolve(completed);
    await expect(outcome).resolves.toEqual({ kind: "failed", error: failure });
    expect(sessionCreates).toBe(1);
    expect(promptCalls).toBe(1);
  });

  it("reports final-only adapter failure and releases the conversation lock", async () => {
    const failure = new Error("final delivery failed");
    let sends = 0;
    const run = setup(async () => {
      sends += 1;
      if (sends === 1) throw failure;
      return "message-id";
    }, false);
    const first = run();
    const handlers = await handlersReady.promise;
    handlers.onEvent({ type: "text", delta: "buffered" });
    await nextEventLoopTurn();
    expect(sends).toBe(0);
    finishPrompt.resolve(completed);
    await expect(first).resolves.toEqual({ kind: "failed", error: failure });
    await expect(run()).resolves.toEqual({ kind: "completed", value: completed });
    expect(sends).toBe(2);
  });

  it("preserves a prompt failure without inventing a final send", async () => {
    const failure = new Error("prompt failed");
    let sends = 0;
    const run = setup(async () => { sends += 1; return "message-id"; }, false);
    const outcome = run();
    const handlers = await handlersReady.promise;
    handlers.onEvent({ type: "text", delta: "partial" });
    finishPrompt.reject(failure);
    await expect(outcome).resolves.toEqual({ kind: "failed", error: failure });
    expect(sends).toBe(0);
  });
});
