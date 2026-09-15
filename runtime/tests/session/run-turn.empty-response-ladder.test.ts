import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import {
  ProviderHttpClient,
  type ProviderHttpContinuationSnapshot,
} from "../../src/llm/client.js";
import type { LLMResponse } from "../../src/llm/types.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import {
  EMPTY_RESPONSE_RETRY_CAUSE,
  EMPTY_RESPONSE_RETRY_DELAYS_MS,
  runTurn,
  setEmptyResponseRetryDelaysForTests,
} from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { Event } from "../../src/session/session.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

/**
 * Regression from Terminal-Bench `vf2-speedup-networkx__Kama2MQ` (#2502).
 *
 * Grok returned two empty samples in a row 3.4 hours into a healthy run and
 * the single retry ended the turn: "The model returned no assistant output
 * after a retry." Nobody attached to `agenc -p` can press enter again, so an
 * unattended turn now walks a small backoff ladder, resetting the provider
 * continuation from the second retry, before it gives up. Attended sessions
 * keep their one immediate retry.
 */

beforeEach(() => {
  setEmptyResponseRetryDelaysForTests([0, 0, 0]);
});

afterEach(() => {
  setEmptyResponseRetryDelaysForTests(null);
  vi.restoreAllMocks();
});

function emptyThenAnswer(emptySamples: number, answer = "done") {
  let samples = 0;
  const provider = mkProvider({});
  provider.chatStream = async (): Promise<LLMResponse> => {
    samples += 1;
    return {
      content: samples <= emptySamples ? "" : answer,
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
      model: "test-model",
      finishReason: "stop",
    };
  };
  return { provider, samples: () => samples };
}

function retryWarnings(events: readonly Event[]): string[] {
  return events.flatMap((event) =>
    event.msg.type === "warning" && event.msg.payload.cause === EMPTY_RESPONSE_RETRY_CAUSE
      ? [String(event.msg.payload.message)]
      : [],
  );
}

function terminals(events: readonly Event[]) {
  return events.flatMap((event) => {
    const terminal = classifyTurnTerminal(event.msg, { expectedTurnId: mkCtx().subId });
    return terminal === undefined ? [] : [terminal];
  });
}

async function collect(session: ReturnType<typeof mkSession>["session"], ctx = mkCtx()) {
  const phases: PhaseEvent[] = [];
  for await (const phase of runTurn(session, ctx, "answer the question")) phases.push(phase);
  return phases;
}

const unattended = () => ({
  runtimeOptions: resolveAgentRuntimeOptions({}, { nonInteractive: true }),
});

describe("empty-response retry ladder (#2502)", () => {
  test("the default ladder is 2 s, 8 s, 30 s", () => {
    expect(EMPTY_RESPONSE_RETRY_DELAYS_MS).toEqual([2_000, 8_000, 30_000]);
  });

  test("an unattended turn re-samples three times, resetting the provider continuation from the second retry", async () => {
    const { provider, samples } = emptyThenAnswer(3);
    const { session, events } = mkSession({ provider, services: unattended() });
    const rebind = vi.spyOn(session, "bindProviderConversation");
    const reset = vi.spyOn(session, "resetProviderIncrementalState");
    const ctx = mkCtx();

    // maxTurns 1: the retries happen before commit() and never consume an
    // iteration, so the answer still lands.
    const phases = await collect(session, { ...ctx, config: { ...ctx.config, maxTurns: 1 } });

    expect(samples()).toBe(4);
    expect(phases.at(-1)).toMatchObject({ stopReason: "completed", content: "done" });
    expect(retryWarnings(events)).toEqual([
      "The model returned no assistant output; retry 1/3",
      "The model returned no assistant output; retry 2/3 with a fresh provider conversation",
      "The model returned no assistant output; retry 3/3 with a fresh provider conversation",
    ]);
    // The turn-start bind, then a full continuation reset per retry from the second on.
    expect(rebind).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(2);
    expect(terminals(events)).toEqual([
      expect.objectContaining({ outcome: "completed", code: 0 }),
    ]);
    expect(events.some((event) => event.msg.type === "turn_failed")).toBe(false);
    expect(events.some((event) =>
      event.msg.type === "error" && event.msg.payload.cause === "stream_disconnected",
    )).toBe(false);
  });

  test("retries two and three clear the provider's stale Responses continuation", async () => {
    // A spy on the rebind could not see this: binding the same conversation id keeps the last
    // request, response id and output, so a stuck server-side continuation was reused anyway.
    // A real ProviderHttpClient records what continuation each sample would have sent.
    const client = new ProviderHttpClient({
      providerName: "openai",
      baseURL: "https://offline.invalid",
      fetchImpl: async () => {
        throw new Error("network is not used: every sample is mocked");
      },
    });
    const provider = mkProvider({}, { client });
    const seen: ProviderHttpContinuationSnapshot[] = [];
    provider.chatStream = async (): Promise<LLMResponse> => {
      seen.push(client.snapshotResponsesContinuation());
      const sample = seen.length;
      // Each sample leaves a server-side continuation behind, as a Responses provider does.
      client.restoreResponsesContinuation({
        ...client.snapshotResponsesContinuation(),
        lastResponseId: `resp-${sample}`,
        lastRequest: { sample },
        lastResponseOutput: [],
      });
      return {
        content: sample <= 3 ? "" : "done",
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
        model: "test-model",
        finishReason: "stop",
      };
    };
    const { session } = mkSession({ provider, services: unattended() });

    const phases = await collect(session);

    expect(phases.at(-1)).toMatchObject({ stopReason: "completed", content: "done" });
    expect(seen).toHaveLength(4);
    // The first retry keeps continuity; the second and third start from a clean continuation
    // under the same conversation id.
    expect(seen[1]).toMatchObject({ lastResponseId: "resp-1" });
    for (const snapshot of seen.slice(2)) {
      expect(snapshot.lastResponseId).toBeUndefined();
      expect(snapshot.lastRequest).toBeUndefined();
      expect(snapshot.lastResponseOutput).toBeUndefined();
      expect(snapshot.conversationId).toBe(seen[0]?.conversationId);
    }
  });

  test("the warning names the configured backoff", async () => {
    setEmptyResponseRetryDelaysForTests([0, 5, 0]);
    const { provider } = emptyThenAnswer(2);
    const { session, events } = mkSession({ provider, services: unattended() });

    await collect(session);

    expect(retryWarnings(events)[1]).toBe(
      "The model returned no assistant output; retry 2/3 in 0 s with a fresh provider conversation",
    );
  });

  test("an unattended turn that stays empty after the ladder ends as empty_response", async () => {
    const { provider, samples } = emptyThenAnswer(10);
    const { session, events } = mkSession({ provider, services: unattended() });

    const phases = await collect(session);

    expect(samples()).toBe(4);
    expect(phases.at(-1)).toMatchObject({ stopReason: "empty_response" });
    expect(retryWarnings(events)).toHaveLength(3);
    expect(terminals(events)).toEqual([
      expect.objectContaining({
        outcome: "errored",
        code: 1,
        failureCode: "empty_response",
        message: "The model returned no assistant output after 3 retries.",
      }),
    ]);
  });

  test("an attended session keeps one immediate retry and its message", async () => {
    setEmptyResponseRetryDelaysForTests([500, 500, 500]);
    const { provider, samples } = emptyThenAnswer(10);
    const { session, events } = mkSession({ provider });
    const rebind = vi.spyOn(session, "bindProviderConversation");
    const reset = vi.spyOn(session, "resetProviderIncrementalState");

    const started = Date.now();
    const phases = await collect(session);

    expect(samples()).toBe(2);
    expect(Date.now() - started).toBeLessThan(400);
    // Only the turn-start bind; the single attended retry never resets the continuation.
    expect(rebind).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    expect(phases.at(-1)).toMatchObject({ stopReason: "empty_response" });
    expect(retryWarnings(events)).toEqual([
      "The model returned no assistant output; retry 1/1",
    ]);
    expect(terminals(events)).toEqual([
      expect.objectContaining({
        outcome: "errored",
        failureCode: "empty_response",
        message: "The model returned no assistant output after a retry.",
      }),
    ]);
  });

  test("an abort during the backoff cancels the turn instead of retrying", async () => {
    setEmptyResponseRetryDelaysForTests([0, 5_000, 5_000]);
    const { provider, samples } = emptyThenAnswer(10);
    const { session, events } = mkSession({ provider, services: unattended() });
    const originalStream = provider.chatStream;
    provider.chatStream = async (...args) => {
      const response = await originalStream(...args);
      if (samples() === 2) setTimeout(() => session.abortController.abort(), 10);
      return response;
    };

    const started = Date.now();
    await drain(runTurn(session, mkCtx(), "answer the question"));

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(samples()).toBe(2);
    expect(events.some((event) => event.msg.type === "turn_aborted")).toBe(true);
    expect(events.some((event) => event.msg.type === "turn_failed")).toBe(false);
  });
});
