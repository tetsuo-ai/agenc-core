import { describe, expect, test } from "vitest";
import { sessionTranscriptV2FromRollout } from "../../src/app-server/background-agent-runner/journal-reconstruction.js";
import { isStreamAttemptDiscard } from "../../src/contracts/stream-attempt-boundary.js";
import type { LLMChatOptions, LLMMessage, LLMResponse, LLMStreamChunk } from "../../src/llm/types.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import { RESUME_META_CONTENT } from "../../src/recovery/max-output-tokens.js";
import type { Event } from "../../src/session/event-log.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";
import { runTurn } from "../../src/session/run-turn.js";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";

// A reply cut at the model's capped default output limit, and the same
// request sent again at the higher limit, which writes the whole reply.
const CUT = "The first attempt stops at the default out";
const WHOLE = "The retry at the higher limit writes the whole reply from its start.";

const usage = { promptTokens: 100, completionTokens: 32, totalTokens: 132 };

/** Streams each scripted sample, as a provider does, and keeps every request. */
function scriptedProvider(samples: ReadonlyArray<{ readonly text: string; readonly finishReason: LLMResponse["finishReason"] }>) {
  const provider = mkProvider();
  const requests: { readonly messages: LLMMessage[]; readonly maxOutputTokens?: number }[] = [];
  provider.chatStream = async (messages, onChunk, options?: LLMChatOptions): Promise<LLMResponse> => {
    requests.push({ messages: messages.map((message) => ({ ...message })), maxOutputTokens: options?.maxOutputTokens });
    const sample = samples[Math.min(requests.length - 1, samples.length - 1)]!;
    (onChunk as (chunk: LLMStreamChunk) => void)({ content: sample.text, done: false } as LLMStreamChunk);
    return { content: sample.text, toolCalls: [], model: "test-model", finishReason: sample.finishReason, usage } as LLMResponse;
  };
  return { provider, requests };
}

/** A capped default output limit and no explicit one: Core retries a cut reply at a higher ceiling. */
const cappedDefaultCtx = () => {
  const base = mkCtx();
  return mkCtx({ modelInfo: { ...base.modelInfo, maxOutputTokens: 256, maxOutputTokensCappedDefault: true } });
};

async function collect(gen: AsyncGenerator<PhaseEvent, unknown>): Promise<PhaseEvent[]> {
  const phases: PhaseEvent[] = [];
  for await (const phase of gen) phases.push(phase);
  return phases;
}

const textOf = (message: LLMMessage): string =>
  typeof message.content === "string"
    ? message.content
    : (message.content as ReadonlyArray<{ readonly text?: string }>).map((part) => part.text ?? "").join("");

const rolloutOf = (events: readonly Event[]): RolloutItem[] =>
  events.map((event, index) => ({ type: "event_msg", payload: { ...event, seq: index + 1 } }) as RolloutItem);

describe("a reply retried at a higher output limit", () => {
  test("marks the cut attempt discarded before the retry streams the reply again", async () => {
    const { provider, requests } = scriptedProvider([
      { text: CUT, finishReason: "length" },
      { text: WHOLE, finishReason: "stop" },
    ]);
    const { session, events } = mkSession({ provider });

    const phases = await collect(runTurn(session, cappedDefaultCtx(), "Explain it in about 700 words."));

    // The same request again at a higher ceiling: no continuation note, and
    // the cut text is not in the history the retry sends.
    expect(requests).toHaveLength(2);
    expect(requests[1]!.maxOutputTokens).toBeGreaterThan(requests[0]!.maxOutputTokens ?? 256);
    expect(requests[1]!.messages.map(textOf)).not.toContain(RESUME_META_CONTENT);
    expect(requests[1]!.messages.map(textOf).join("\n")).not.toContain(CUT);

    // Both attempts streamed, and the discard sits between them.
    const at = (match: (msg: Event["msg"]) => boolean) => events.findIndex((event) => match(event.msg));
    const cutDelta = at((msg) => msg.type === "agent_message_delta" && msg.payload.delta === CUT);
    const discard = at((msg) => isStreamAttemptDiscard(msg));
    const retryDelta = at((msg) => msg.type === "agent_message_delta" && msg.payload.delta === WHOLE);
    const committedAt = at((msg) => msg.type === "agent_message");
    expect(cutDelta).toBeGreaterThan(-1);
    expect(discard).toBeGreaterThan(cutDelta);
    expect(retryDelta).toBeGreaterThan(discard);
    expect(committedAt).toBeGreaterThan(retryDelta);
    expect(events[discard]!.msg).toMatchObject({ type: "stream_error", payload: { cause: "stream_attempt_discarded" } });
    expect(events.filter((event) => isStreamAttemptDiscard(event.msg))).toHaveLength(1);

    // While the retry streams, the TUI shows the retry only, and a client
    // that loads the transcript then gets the retry's text as the partial.
    const duringRetry = events.slice(0, committedAt);
    expect(adaptTranscriptEvents(duringRetry as never).streamingText).toBe(WHOLE);
    const reloaded = sessionTranscriptV2FromRollout(rolloutOf(duringRetry), "session", "run");
    const reloadedReplies = reloaded.messages.filter((message) => message.role === "assistant");
    expect(reloadedReplies.map((message) => message.text)).toEqual([WHOLE]);
    expect(reloadedReplies[0]!.partial).toBeDefined();

    // The committed reply was already the retry's, and stays so.
    expect(events.flatMap((event) => event.msg.type === "agent_message" ? [event.msg.payload.message] : [])).toEqual([WHOLE]);
    expect(adaptTranscriptEvents(events as never).messages
      .filter((row: { type: string }) => row.type === "assistant")
      .map((row: { message: { content: ReadonlyArray<{ type: string; text?: string }> } }) =>
        row.message.content.filter((part) => part.type === "text").map((part) => part.text).join(""))).toEqual([WHOLE]);
    expect(phases.at(-1)).toMatchObject({ type: "turn_complete", content: WHOLE });
  });

  test("a reply continued under an explicit limit keeps its first part and has no discard", async () => {
    const { provider, requests } = scriptedProvider([
      { text: CUT, finishReason: "length" },
      { text: "put limit, and the second part finishes it.", finishReason: "stop" },
    ]);
    const { session, events } = mkSession({ provider });
    const base = mkCtx();
    const explicit = mkCtx({ modelInfo: { ...base.modelInfo, maxOutputTokens: 256, maxOutputTokensCappedDefault: true, maxOutputTokensExplicit: true } });

    await collect(runTurn(session, explicit, "Explain it in about 700 words."));

    expect(requests).toHaveLength(2);
    expect(events.some((event) => isStreamAttemptDiscard(event.msg))).toBe(false);
    expect(events.flatMap((event) => event.msg.type === "agent_message" ? [event.msg.payload.message] : []))
      .toEqual([`${CUT}put limit, and the second part finishes it.`]);
  });
});
