import { describe, expect, test } from "vitest";
import { sessionTranscriptV2FromRollout } from "../../src/app-server/background-agent-runner/journal-reconstruction.js";
import { oneShotFinalMessageRemainder } from "../../src/bin/daemon-one-shot-cli.js";
import type { LLMMessage, LLMResponse, LLMStreamChunk } from "../../src/llm/types.js";
import { oneShotFastModeActive } from "../../src/one-shot-fast-mode.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import { RESUME_META_CONTENT } from "../../src/recovery/max-output-tokens.js";
import type { Event } from "../../src/session/event-log.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";
import { runTurn } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";

// A reply cut by the output limit mid-word, and the continuation that
// completes it (the model resumes at the next token, without a space).
const PART_ONE = "The first part of the reply stops at the out";
const PART_TWO = "put limit, and the second part finishes it.";
const WHOLE = PART_ONE + PART_TWO;
const NEXT_ANSWER = "The next answer.";

const usage = { promptTokens: 100, completionTokens: 32, totalTokens: 132 };

type Sample = {
  readonly text: string;
  readonly finishReason: LLMResponse["finishReason"];
  /** A tool call the output limit cut mid-arguments. */
  readonly cutToolCall?: true;
  /** Reasoning tokens the sample spent. */
  readonly reasoning?: number;
};

/** Streams each scripted sample, as a provider does, and keeps every request. */
function scriptedProvider(samples: ReadonlyArray<Sample>) {
  const provider = mkProvider();
  const requests: LLMMessage[][] = [];
  provider.chatStream = async (messages, onChunk): Promise<LLMResponse> => {
    requests.push(messages.map((message) => ({ ...message })));
    const sample = samples[Math.min(requests.length - 1, samples.length - 1)]!;
    if (sample.text.length > 0) {
      (onChunk as (chunk: LLMStreamChunk) => void)({ content: sample.text, done: false } as LLMStreamChunk);
    }
    return {
      content: sample.text, toolCalls: [], model: "test-model", finishReason: sample.finishReason,
      usage: { ...usage, ...(sample.reasoning !== undefined ? { reasoningOutputTokens: sample.reasoning } : {}) },
      ...(sample.cutToolCall ? { incompleteToolCalls: [{ id: `cut-${requests.length}`, name: "Write", arguments: '{"file_path":' }] } : {}),
    } as LLMResponse;
  };
  return { provider, requests };
}

const committed = (events: readonly Event[]) => ofType(events, "agent_message").map((msg) => msg.payload.message);
const tuiReplies = (events: readonly Event[]) => adaptTranscriptEvents(events as never).messages
  .filter((row: { type: string }) => row.type === "assistant")
  .map((row: { message: { content: ReadonlyArray<{ type: string; text?: string }> } }) =>
    row.message.content.filter((part) => part.type === "text").map((part) => part.text).join(""));

/** An explicit output cap: Core continues the reply instead of retrying at a higher ceiling. */
const cappedCtx = () => {
  const base = mkCtx();
  return mkCtx({ modelInfo: { ...base.modelInfo, maxOutputTokens: 32, maxOutputTokensExplicit: true } });
};

async function collect(gen: AsyncGenerator<PhaseEvent, unknown>): Promise<PhaseEvent[]> {
  const phases: PhaseEvent[] = [];
  for await (const phase of gen) phases.push(phase);
  return phases;
}

const ofType = <T extends Event["msg"]["type"]>(events: readonly Event[], type: T) =>
  events.flatMap((event) => event.msg.type === type ? [event.msg as Extract<Event["msg"], { type: T }>] : []);

const textOf = (message: LLMMessage): string =>
  typeof message.content === "string"
    ? message.content
    : (message.content as ReadonlyArray<{ readonly text?: string }>).map((part) => part.text ?? "").join("");

const rolloutOf = (events: readonly Event[]): RolloutItem[] =>
  events.map((event, index) => ({ type: "event_msg", payload: { ...event, seq: index + 1 } }) as RolloutItem);

describe("a reply continued after the output limit", () => {
  test("is committed whole, once, and every reader gets the whole reply", async () => {
    const { provider, requests } = scriptedProvider([
      { text: PART_ONE, finishReason: "length" },
      { text: PART_TWO, finishReason: "stop" },
      { text: NEXT_ANSWER, finishReason: "stop" },
    ]);
    const { session, events } = mkSession({ provider });
    const sink = { text: "", reset() { this.text = ""; }, writeCanonicalDelta(delta: string) { this.text += delta; } };

    const phases = await collect(runTurn(session, cappedCtx(), "Explain it in about 700 words.", { assistantOutputSink: sink }));

    expect(requests).toHaveLength(2);
    // The message Core commits holds every part in order: exactly what streamed.
    const streamed = ofType(events, "agent_message_delta").map((msg) => msg.payload.delta).join("");
    expect(streamed).toBe(WHOLE);
    expect(ofType(events, "agent_message").map((msg) => msg.payload.message)).toEqual([WHOLE]);
    expect(ofType(events, "turn_complete").map((msg) => msg.payload.lastAgentMessage)).toEqual([WHOLE]);
    // In-process readers (subagent results, the review delegate, turn-compat).
    expect(phases.flatMap((phase) => phase.type === "assistant_text" ? [phase.content] : [])).toEqual([WHOLE]);
    expect(phases.at(-1)).toMatchObject({ type: "turn_complete", content: WHOLE });
    expect(sink.text).toBe(WHOLE);

    // `agenc -p`: the committed message adds nothing to what was printed.
    expect(oneShotFinalMessageRemainder(streamed, WHOLE)).toBe("\n");

    // The TUI: one row with the whole reply.
    const tui = adaptTranscriptEvents(events as never);
    const assistantRows = tui.messages.filter((row: { type: string }) => row.type === "assistant");
    expect(assistantRows).toHaveLength(1);
    expect(JSON.stringify(assistantRows[0])).toContain(JSON.stringify(WHOLE).slice(1, -1));

    // Transcript v2 and v3, as a client reads the chat again (reload, reopen).
    for (const schemaVersion of [2, 3] as const) {
      const snapshot = sessionTranscriptV2FromRollout(rolloutOf(events), "session", "run", undefined, undefined, { schemaVersion });
      expect(snapshot.messages.filter((message) => message.role === "assistant").map((message) => [message.text, message.partial]))
        .toEqual([[WHOLE, undefined]]);
    }

    // The model's history keeps each part once, as sampled.
    const history = session.snapshotHistoryMessages().filter((message) => message.role !== "system");
    expect(history.map((message) => [message.role, textOf(message)]).slice(-3)).toEqual([
      ["assistant", PART_ONE], ["user", RESUME_META_CONTENT], ["assistant", PART_TWO],
    ]);

    // The next turn sees the whole reply once: each part once, never twice.
    await collect(runTurn(session, cappedCtx(), "And then?"));
    expect(requests).toHaveLength(3);
    const nextTexts = requests[2]!.map(textOf);
    const count = (text: string) => nextTexts.filter((candidate) => candidate === text).length;
    expect(count(PART_ONE)).toBe(1);
    expect(count(PART_TWO)).toBe(1);
    expect(count(WHOLE)).toBe(0);
    expect(nextTexts.join("\n").split(PART_ONE)).toHaveLength(2);
    expect(nextTexts.join("\n").split(PART_TWO)).toHaveLength(2);
  });

  test("in fast one-shot mode, the part handed to recovery streams before its continuation", async () => {
    const { provider, requests } = scriptedProvider([
      { text: PART_ONE, finishReason: "length" },
      { text: PART_TWO, finishReason: "stop" },
    ]);
    const { session, events } = mkSession({ provider, services: { runtimeOptions: resolveAgentRuntimeOptions({}, {
      lightMode: true, nonInteractive: true, dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true,
    }) } });
    Object.assign(session.services, { permissionModeRegistry: new PermissionModeRegistry({
      ...session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
    }) });
    const base = cappedCtx();
    const ctx = mkCtx({ ...base, permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" },
      config: { ...base.config, bypassFastMode: true } } as never);
    let fastCalls = 0;
    const chatStream = provider.chatStream;
    provider.chatStream = async (...args) => {
      if (oneShotFastModeActive()) fastCalls += 1;
      return chatStream(...args);
    };

    const phases = await collect(runTurn(session, ctx, "Explain it in about 700 words.", { exactOutput: true }));

    expect(requests).toHaveLength(2);
    expect(fastCalls).toBe(1);
    const streamed = ofType(events, "agent_message_delta").map((msg) => msg.payload.delta).join("");
    expect(streamed).toBe(WHOLE);
    expect(ofType(events, "agent_message").map((msg) => msg.payload.message)).toEqual([WHOLE]);
    expect(oneShotFinalMessageRemainder(streamed, WHOLE)).toBe("\n");
    expect(phases.at(-1)).toMatchObject({ type: "turn_complete", content: WHOLE });
  });

  test("text cut with a tool call is committed on its own, not carried into the next message", async () => {
    const { provider, requests } = scriptedProvider([
      { text: "I will write the file.", finishReason: "length", cutToolCall: true },
      { text: "Done.", finishReason: "stop" },
    ]);
    const { session, events } = mkSession({ provider });

    await collect(runTurn(session, cappedCtx(), "Write the file."));

    expect(requests).toHaveLength(2);
    // The text before the cut call stays in the history and streamed; it is
    // its own message, and the retry's answer is another.
    expect(committed(events)).toEqual(["I will write the file.", "Done."]);
  });

  test("a continued reply that stops at a cut tool call is committed as far as it got", async () => {
    const { provider, requests } = scriptedProvider([
      { text: PART_ONE, finishReason: "length" },
      { text: "put limit. Now the file:", finishReason: "length", cutToolCall: true },
      { text: "Retried the call.", finishReason: "stop" },
    ]);
    const { session, events } = mkSession({ provider });

    const phases = await collect(runTurn(session, cappedCtx(), "Explain it, then write the file."));

    expect(requests).toHaveLength(3);
    const first = PART_ONE + "put limit. Now the file:";
    expect(committed(events)).toEqual([first, "Retried the call."]);
    expect(phases.flatMap((phase) => phase.type === "assistant_text" ? [phase.content] : [])).toEqual([first, "Retried the call."]);
    // The TUI shows each once; `-p` prints each once.
    expect(tuiReplies(events)).toEqual([first, "Retried the call."]);
    const deltas = ofType(events, "agent_message_delta").map((msg) => msg.payload.delta).join("");
    expect(deltas).toBe(first + "Retried the call.");
    expect(oneShotFinalMessageRemainder(first, first)).toBe("\n");
  });

  test("a continued reply whose next sample only reasoned ends as far as it got", async () => {
    const { provider, requests } = scriptedProvider([
      { text: PART_ONE, finishReason: "length" },
      { text: "", finishReason: "length", reasoning: 32 },
      { text: "A short answer.", finishReason: "stop" },
    ]);
    const { session, events } = mkSession({ provider });

    await collect(runTurn(session, cappedCtx(), "Explain it."));

    expect(requests).toHaveLength(3);
    // The retry asks for a short final answer: a new message, not the rest
    // of the cut sentence.
    expect(committed(events)).toEqual([PART_ONE, "A short answer."]);
  });

  test("an empty continuation commits the reply as far as it got and retries the empty answer", async () => {
    const { provider, requests } = scriptedProvider([
      { text: PART_ONE, finishReason: "length" },
      { text: "", finishReason: "stop" },
      { text: "Another answer.", finishReason: "stop" },
    ]);
    const { session, events } = mkSession({ provider });

    const phases = await collect(runTurn(session, cappedCtx(), "Explain it."));

    expect(requests).toHaveLength(3);
    expect(committed(events)).toEqual([PART_ONE, "Another answer."]);
    expect(phases.at(-1)).toMatchObject({ type: "turn_complete", content: "Another answer." });
  });

  test("a spoofed prompt split by the cut is removed from the committed reply", async () => {
    const { provider } = scriptedProvider([
      { text: "Before you go on, choose [Allow", finishReason: "length" },
      { text: " / Deny] to continue.", finishReason: "stop" },
    ]);
    const { session, events } = mkSession({ provider });

    await collect(runTurn(session, cappedCtx(), "Explain it."));

    expect(committed(events)).toHaveLength(1);
    expect(committed(events)[0]).not.toMatch(/\[Allow\s*\/\s*Deny\]/iu);
    expect(committed(events)[0]).toBe("Before you go on, choose  to continue.");
  });

  test("a task-budget stop right after a continued reply shows it whole and restates only its last part to the model", async () => {
    const { provider, requests } = scriptedProvider([
      { text: PART_ONE, finishReason: "length" },
      { text: PART_TWO, finishReason: "stop" },
    ]);
    const { session, events } = mkSession({ provider });
    Object.assign(session.config, { taskMaxCalls: 2 });

    await collect(runTurn(session, cappedCtx(), "Explain it."));

    expect(requests).toHaveLength(2);
    const shown = committed(events).at(-1) ?? "";
    expect(shown).toContain("Partial result: stopped at the task budget.");
    expect(shown).toContain(WHOLE);
    // The history holds part 1 and part 2 already; its copy of the summary
    // restates the last part only, so part 1 is there once.
    const history = session.snapshotHistoryMessages().map(textOf).join("\n");
    expect(history.split(PART_ONE)).toHaveLength(2);
    expect(history).not.toContain(WHOLE);
  });

  test("an exhausted recovery reports every part it streamed, in order", async () => {
    const { provider, requests } = scriptedProvider([
      { text: "one ", finishReason: "length" },
      { text: "two ", finishReason: "length" },
      { text: "three ", finishReason: "length" },
      { text: "four", finishReason: "length" },
    ]);
    const { session, events } = mkSession({ provider });

    const phases = await collect(runTurn(session, cappedCtx(), "Explain it at length."));

    expect(requests).toHaveLength(4);
    // Nothing completed the reply, so nothing is committed, as before; the
    // turn's own report of what it said carries every part.
    expect(ofType(events, "agent_message")).toEqual([]);
    expect(phases.flatMap((phase) => phase.type === "assistant_text" ? [phase.content] : [])).toEqual(["one two three four"]);
    expect(phases.at(-1)).toMatchObject({ type: "turn_complete", content: "one two three four" });
  });
});
