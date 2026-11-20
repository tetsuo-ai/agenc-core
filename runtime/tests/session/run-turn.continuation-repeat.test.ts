import { describe, expect, test } from "vitest";
import { sessionTranscriptV2FromRollout } from "../../src/app-server/background-agent-runner/journal-reconstruction.js";
import { oneShotFinalMessageRemainder } from "../../src/bin/daemon-one-shot-cli.js";
import type { LLMMessage, LLMResponse, LLMStreamChunk } from "../../src/llm/types.js";
import { oneShotFastModeActive } from "../../src/one-shot-fast-mode.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { MAX_REPEAT_CHARS } from "../../src/phases/continuation-repeat.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import { RESUME_META_CONTENT } from "../../src/recovery/max-output-tokens.js";
import type { Event } from "../../src/session/event-log.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";
import { runTurn } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";

// A reply the output limit cuts, and the continuation that opens by
// repeating the reply's last words, as Core's note asks. The reply joins
// where the repeat ends; without a repeat it is kept as written.

const usage = { promptTokens: 100, completionTokens: 32, totalTokens: 132 };

// The note Core sends after a cut, pinned here: every continuation request
// asks for the repeat, whether or not the model then writes one.
const NOTE = "Your previous message was cut off by the output limit. Continue it: start with the last five words " +
  "of your previous message, repeated exactly, then go on from there. Do not apologize, do not restart, do not add preamble.";

type Sample = {
  readonly text: string;
  readonly finishReason: LLMResponse["finishReason"];
  /** Characters per streamed chunk; the whole text in one chunk when absent. */
  readonly chunk?: number;
  /** Exact chunks, in order (their concatenation is `text`). */
  readonly chunks?: readonly string[];
  /** A tool call the output limit cut mid-arguments. */
  readonly cutToolCall?: true;
  /** After its text, the sample starts a tool call and ends with it. */
  readonly toolCall?: string;
  /** Where in `text` the tool call starts; the rest streams after it. */
  readonly toolAt?: number;
};

const ofType = <T extends Event["msg"]["type"]>(events: readonly Event[], type: T) =>
  events.flatMap((event) => event.msg.type === type ? [event.msg as Extract<Event["msg"], { type: T }>] : []);
const streamedText = (events: readonly Event[]) =>
  ofType(events, "agent_message_delta").map((msg) => msg.payload.delta).join("");
const committed = (events: readonly Event[]) => ofType(events, "agent_message").map((msg) => msg.payload.message);
const tuiReplies = (events: readonly Event[]) => adaptTranscriptEvents(events as never).messages
  .filter((row: { type: string }) => row.type === "assistant")
  .map((row: { message: { content: ReadonlyArray<{ type: string; text?: string }> } }) =>
    row.message.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
const textOf = (message: LLMMessage): string =>
  typeof message.content === "string"
    ? message.content
    : (message.content as ReadonlyArray<{ readonly text?: string }>).map((part) => part.text ?? "").join("");
const rolloutOf = (events: readonly Event[]): RolloutItem[] =>
  events.map((event, index) => ({ type: "event_msg", payload: { ...event, seq: index + 1 } }) as RolloutItem);

function chunksOf(sample: Sample): string[] {
  if (sample.chunks !== undefined) return [...sample.chunks];
  if (sample.text.length === 0) return [];
  const size = sample.chunk ?? sample.text.length;
  const out: string[] = [];
  for (let at = 0; at < sample.text.length; at += size) out.push(sample.text.slice(at, at + size));
  return out;
}

/**
 * Streams each scripted sample chunk by chunk, keeps every request, and
 * records what had streamed (the joined deltas) after every chunk.
 */
function scriptedProvider(samples: ReadonlyArray<Sample>, events: () => readonly Event[]) {
  const provider = mkProvider();
  const requests: LLMMessage[][] = [];
  const streamedAfterChunk: string[] = [];
  provider.chatStream = async (messages, onChunk): Promise<LLMResponse> => {
    requests.push(messages.map((message) => ({ ...message })));
    const sample = samples[Math.min(requests.length - 1, samples.length - 1)]!;
    const toolAt = sample.toolAt ?? sample.text.length;
    const stream = (text: string) => {
      for (const piece of chunksOf({ ...sample, text, chunks: text === sample.text ? sample.chunks : undefined })) {
        (onChunk as (chunk: LLMStreamChunk) => void)({ content: piece, done: false } as LLMStreamChunk);
        streamedAfterChunk.push(streamedText(events()));
      }
    };
    stream(sample.toolCall !== undefined ? sample.text.slice(0, toolAt) : sample.text);
    const id = `call-${requests.length}`;
    if (sample.toolCall !== undefined) {
      (onChunk as (chunk: LLMStreamChunk) => void)({ done: false, toolInputBlockStart: {
        callId: id, index: 1, contentBlock: { type: "tool_use", id, name: sample.toolCall, input: {} },
      } } as LLMStreamChunk);
      stream(sample.text.slice(toolAt));
    }
    return {
      content: sample.text, model: "test-model", finishReason: sample.finishReason, usage,
      toolCalls: sample.toolCall !== undefined ? [{ id, name: sample.toolCall, arguments: "{}" }] : [],
      ...(sample.cutToolCall ? { incompleteToolCalls: [{ id: `cut-${requests.length}`, name: "Write", arguments: '{"file_path":' }] } : {}),
    } as LLMResponse;
  };
  return { provider, requests, streamedAfterChunk };
}

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

async function run(samples: ReadonlyArray<Sample>, prompt = "Explain it in about 700 words.") {
  const box: { events: readonly Event[] } = { events: [] };
  const scripted = scriptedProvider(samples, () => box.events);
  const { session, events } = mkSession({ provider: scripted.provider });
  box.events = events;
  const sink = { text: "", reset() { this.text = ""; }, writeCanonicalDelta(delta: string) { this.text += delta; } };
  const phases = await collect(runTurn(session, cappedCtx(), prompt, { assistantOutputSink: sink }));
  return { ...scripted, session, events, phases, sink };
}

/** Every reader gets `whole`, and nothing streamed that is not in it. */
function expectReply(result: Awaited<ReturnType<typeof run>>, whole: string): void {
  const { events, phases, sink, streamedAfterChunk } = result;
  const streamed = streamedText(events);
  expect(streamed).toBe(whole);
  expect(committed(events)).toEqual([whole]);
  expect(ofType(events, "turn_complete").map((msg) => msg.payload.lastAgentMessage)).toEqual([whole]);
  expect(phases.flatMap((phase) => phase.type === "assistant_text" ? [phase.content] : [])).toEqual([whole]);
  expect(phases.at(-1)).toMatchObject({ type: "turn_complete", content: whole });
  expect(sink.text).toBe(whole);
  // `agenc -p`: the committed message adds nothing to what was printed.
  expect(oneShotFinalMessageRemainder(streamed, whole)).toBe("\n");
  // The TUI: one row with the reply.
  expect(tuiReplies(events)).toEqual([whole]);
  // Transcript v2 and v3, as a client reads the chat again.
  for (const schemaVersion of [2, 3] as const) {
    const snapshot = sessionTranscriptV2FromRollout(rolloutOf(events), "session", "run", undefined, undefined, { schemaVersion });
    expect(snapshot.messages.filter((message) => message.role === "assistant").map((message) => [message.text, message.partial]))
      .toEqual([[whole, undefined]]);
  }
  // Live: at every chunk, what had streamed is the start of the reply.
  for (const soFar of streamedAfterChunk) expect(whole.startsWith(soFar)).toBe(true);
}

/** The model's history keeps each part once, as sampled, with Core's note between them. */
function expectHistory(result: Awaited<ReturnType<typeof run>>, parts: readonly string[]): void {
  const history = result.session.snapshotHistoryMessages().filter((message) => message.role !== "system");
  const expected: [string, string][] = [];
  parts.forEach((part, index) => {
    if (index > 0) expected.push(["user", RESUME_META_CONTENT]);
    expected.push(["assistant", part]);
  });
  expect(history.map((message) => [message.role, textOf(message)]).slice(-expected.length)).toEqual(expected);
  // Each continuation request ends with the note that asks for the repeat.
  expect(result.requests.length).toBeGreaterThanOrEqual(parts.length);
  for (const request of result.requests.slice(1, parts.length)) expect(textOf(request.at(-1)!)).toBe(NOTE);
}

describe("a continued reply joins where its repeat ends", () => {
  test("the note asks the model to start with its last words, repeated exactly", () => {
    expect(RESUME_META_CONTENT).toBe(NOTE);
  });

  test("an exact overlap: the repeat is dropped once, for every reader", async () => {
    const one = "A mechanical watch keeps time with a balance wheel that swings back and forth";
    const two = "that swings back and forth five times a second, released by the escapement.";
    const whole = one + " five times a second, released by the escapement.";
    const result = await run([
      { text: one, finishReason: "length", chunk: 7 },
      { text: two, finishReason: "stop", chunk: 3 },
      { text: "The next answer.", finishReason: "stop" },
    ]);

    expect(result.requests).toHaveLength(2);
    expectReply(result, whole);
    expectHistory(result, [one, two]);

    // The next turn sees each part once, as sampled; the joined reply never.
    await collect(runTurn(result.session, cappedCtx(), "And then?"));
    const nextTexts = result.requests[2]!.map(textOf);
    expect(nextTexts.filter((text) => text === one)).toHaveLength(1);
    expect(nextTexts.filter((text) => text === two)).toHaveLength(1);
    expect(nextTexts.filter((text) => text === whole)).toHaveLength(0);
  });

  test.each([
    {
      name: "a cut between words: the repeat supplies the space",
      one: "A tourbillon, which rotates the whole escapement, attacks the same",
      two: "whole escapement, attacks the same problem by averaging positional error.",
      whole: "A tourbillon, which rotates the whole escapement, attacks the same problem by averaging positional error.",
    },
    {
      name: "a cut after a space: the repeat holds it too",
      one: "Temperature, magnetism and the slow thickening of ",
      two: "the slow thickening of lubricants all perturb the rate.",
      whole: "Temperature, magnetism and the slow thickening of lubricants all perturb the rate.",
    },
    {
      name: "a cut after a paragraph break: the repeat stops before it",
      one: "Lubricants all perturb rate as well.\n\n",
      two: "all perturb rate as well. Finally, the whole thing is held together.",
      whole: "Lubricants all perturb rate as well.\n\nFinally, the whole thing is held together.",
    },
  ])("an overlap at a word boundary: $name", async ({ one, two, whole }) => {
    const result = await run([
      { text: one, finishReason: "length", chunk: 5 },
      { text: two, finishReason: "stop", chunk: 2 },
    ]);
    expectReply(result, whole);
    expectHistory(result, [one, two]);
  });

  test("an overlap inside a word: the word is completed, nothing added or dropped in it", async () => {
    const one = "Each swing of the balance lets one tooth of the escap";
    const two = "one tooth of the escapement wheel slip past the pallet.";
    const result = await run([
      { text: one, finishReason: "length", chunk: 6 },
      { text: two, finishReason: "stop", chunk: 1 },
    ]);
    expectReply(result, "Each swing of the balance lets one tooth of the escapement wheel slip past the pallet.");
    expectHistory(result, [one, two]);
  });

  test.each([
    {
      name: "the model did not repeat (one shared letter is no repeat)",
      one: "The going train carries the energy on to the",
      two: "escape wheel, which turns in steps.",
    },
    {
      name: "a lead of dots without a repeat",
      one: "It swings against its spring.",
      two: "...That division of labour is the key.",
    },
    {
      name: "a short doubled word is not a repeat",
      one: "By noon the watchmaker had",
      two: " had enough of the hairspring.",
    },
    {
      name: "a match inside a word is not a repeat",
      one: "The energy is stored in the hairspring",
      two: "spring, which the wheel keeps in motion.",
    },
  ])("no overlap: the continuation is kept as written ($name)", async ({ one, two }) => {
    const result = await run([
      { text: one, finishReason: "length", chunk: 4 },
      { text: two, finishReason: "stop", chunk: 3 },
    ]);
    expectReply(result, one + two);
    expectHistory(result, [one, two]);
  });

  test.each([
    {
      name: "an ellipsis before a repeat that ends with a period",
      one: "The interval is set by a balance wheel swinging against its spring.",
      two: "…swinging against its spring. That division of labour is the key.",
      whole: "The interval is set by a balance wheel swinging against its spring. That division of labour is the key.",
    },
    {
      name: "quotes and a comma inside the repeat",
      one: "Watchmakers call it the \"lever escapement,\" and",
      two: "it the \"lever escapement,\" and it ticks five times a second.",
      whole: "Watchmakers call it the \"lever escapement,\" and it ticks five times a second.",
    },
    {
      name: "a repeat that ends inside parentheses",
      one: "The rate comes from the balance wheel (the oscillat",
      two: "the balance wheel (the oscillator), not from the mainspring.",
      whole: "The rate comes from the balance wheel (the oscillator), not from the mainspring.",
    },
    {
      name: "the repeat's first letter capitalized",
      one: "Wear comes from friction and the slow thickening of lubricants",
      two: "And the slow thickening of lubricants changes the rate over the years.",
      whole: "Wear comes from friction and the slow thickening of lubricants changes the rate over the years.",
    },
  ])("punctuation: $name", async ({ one, two, whole }) => {
    const result = await run([
      { text: one, finishReason: "length", chunk: 8 },
      { text: two, finishReason: "stop", chunk: 2 },
    ]);
    expectReply(result, whole);
    expectHistory(result, [one, two]);
  });

  // Both seen live on DeepSeek V4.1 Flash with this note (harness/evidence/ab-round1.txt).
  test.each([
    {
      name: "a paragraph break repeated as a space",
      one: "Without that flow the sail shakes uselessly.\n\nSo the answer comes",
      two: "uselessly. So the answer comes down to a partnership between two wings.",
      whole: "Without that flow the sail shakes uselessly.\n\nSo the answer comes down to a partnership between two wings.",
    },
    {
      name: "the last words written twice",
      one: "The firebox is the heat source, and the boiler is arranged so that",
      two: "so that the boiler is arranged so that the gas must travel the length of the tubes.",
      whole: "The firebox is the heat source, and the boiler is arranged so that the gas must travel the length of the tubes.",
    },
    {
      name: "the last word, then the last sentence with its first letter lowercased",
      one: "The element as a whole behaves as a converging lens. Rays from a distant point arrive nearly parallel and",
      two: "and rays from a distant point arrive nearly parallel and are brought to a focus behind the lens.",
      whole: "The element as a whole behaves as a converging lens. Rays from a distant point arrive nearly parallel and are brought to a focus behind the lens.",
    },
  ])("a repeat with other spacing or written twice is dropped once: $name", async ({ one, two, whole }) => {
    const result = await run([
      { text: one, finishReason: "length", chunk: 6 },
      { text: two, finishReason: "stop", chunk: 3 },
    ]);
    expectReply(result, whole);
    expectHistory(result, [one, two]);
  });

  test("a repeat longer than the hold so far is held until it ends, and none of it streams", async () => {
    const repeated = "The hairspring is a coiled ribbon of special alloy whose stiffness barely changes with temperature, " +
      "and the balance wheel it drives swings at a natural period that sets the rate of the whole watch";
    const one = "Two parts decide how well a watch keeps time. " + repeated;
    const two = repeated + ", from the first hour after winding to the last.";
    const result = await run([
      { text: one, finishReason: "length", chunk: 9 },
      { text: two, finishReason: "stop", chunk: 4 },
    ]);
    const whole = one + ", from the first hour after winding to the last.";
    expectReply(result, whole);
    expectHistory(result, [one, two]);
    // While the repeat streamed (49 chunks), nothing of the continuation
    // showed; the first chunk after it shows at once.
    const continuation = result.streamedAfterChunk.slice(Math.ceil(one.length / 9));
    const repeatChunks = Math.floor(repeated.length / 4);
    expect(continuation.slice(0, repeatChunks).every((soFar) => soFar === one)).toBe(true);
    expect(continuation[repeatChunks + 1]!.length).toBeGreaterThan(one.length);
  });

  test("a repeat longer than the hold's limit streams as written, and the stored reply equals the stream", async () => {
    const sentences = Array.from({ length: 30 }, (_, index) =>
      `Sentence ${index + 1} names part ${String.fromCharCode(65 + (index % 26))}${index} of the movement.`);
    const one = sentences.join(" ");
    const repeated = one.slice(one.length - (MAX_REPEAT_CHARS + 200));
    expect(repeated.length).toBeGreaterThan(MAX_REPEAT_CHARS);
    const two = repeated + " Then the reply goes on.";
    const result = await run([
      { text: one, finishReason: "length", chunk: 50 },
      { text: two, finishReason: "stop", chunk: 25 },
    ]);
    expectReply(result, one + two);
    expectHistory(result, [one, two]);
  });

  test("streaming equals stored: any chunking of a reply cut twice streams exactly what is committed", async () => {
    const one = "The mainspring stores the energy, and the going train carries it on towards the escape";
    const two = "on towards the escapement, which releases it one tooth at a time to the balance wheel, which";
    const three = "...the balance wheel, which swings back and forth at a steady rate.";
    const whole = "The mainspring stores the energy, and the going train carries it on towards the escapement, " +
      "which releases it one tooth at a time to the balance wheel, which swings back and forth at a steady rate.";
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const split = (text: string): string[] => {
      const out: string[] = [];
      for (let at = 0; at < text.length;) {
        const size = 1 + Math.floor(random() * 12);
        out.push(text.slice(at, at + size));
        at += size;
      }
      return out;
    };
    for (let round = 0; round < 12; round += 1) {
      const result = await run([
        { text: one, finishReason: "length", chunks: split(one) },
        { text: two, finishReason: "length", chunks: split(two) },
        { text: three, finishReason: "stop", chunks: split(three) },
      ]);
      expect(result.requests).toHaveLength(3);
      expectReply(result, whole);
      expectHistory(result, [one, two, three]);
    }
  });

  test("text the hold keeps shows before a tool call that follows it", async () => {
    const one = "First I read the plan, and now I will check the file";
    const result = await run([
      { text: one, finishReason: "length", chunk: 6 },
      // "Now" may still begin a repeat ("now I will check the file") when
      // the tool call starts; it shows before the call, kept as written.
      { text: "Now", finishReason: "tool_calls", toolCall: "Read" },
      { text: "Done.", finishReason: "stop" },
    ], "Check the file.");
    const kinds = result.events.flatMap((event) =>
      event.msg.type === "agent_message_delta" ? [`delta:${event.msg.payload.delta}`]
        : event.msg.type === "tool_input_block_start" ? ["tool"] : []);
    expect(textOf(result.requests[1]!.at(-1)!)).toBe(NOTE);
    expect(kinds.indexOf("delta:Now")).toBeGreaterThan(-1);
    expect(kinds.indexOf("delta:Now")).toBeLessThan(kinds.indexOf("tool"));
    expect(committed(result.events)[0]).toBe(one + "Now");
  });

  test("text after a tool call: what streamed is what is committed", async () => {
    const one = "First I will look at the logs and the config";
    // The hold has nothing when the call starts; the text after it passes as written.
    const two = "logs and the config first.";
    const result = await run([
      { text: one, finishReason: "length", chunk: 6 },
      { text: two, finishReason: "tool_calls", toolCall: "Read", toolAt: 0, chunk: 4 },
      { text: "Done.", finishReason: "stop" },
    ], "Check the logs.");
    expect(textOf(result.requests[1]!.at(-1)!)).toBe(NOTE);
    expect(committed(result.events)[0]).toBe(one + two);
    expect(streamedText(result.events).startsWith(one + two)).toBe(true);
  });

  test("an overlap in a script without spaces between words", async () => {
    const one = "首先我们需要仔细检查服务器上的配置文件和系统日志";
    const two = "配置文件和系统日志，然后重启服务。";
    const result = await run([
      { text: one, finishReason: "length", chunk: 5 },
      { text: two, finishReason: "stop", chunk: 2 },
    ]);
    expectReply(result, "首先我们需要仔细检查服务器上的配置文件和系统日志，然后重启服务。");
    expectHistory(result, [one, two]);
  });

  test("new text after the repeat that opens with the reply's last word stays", async () => {
    const one = "We looked at it twice, so the answer is no";
    const two = "so the answer is no. No, really, it is not.";
    const result = await run([
      { text: one, finishReason: "length", chunk: 5 },
      { text: two, finishReason: "stop", chunk: 3 },
    ]);
    expectReply(result, "We looked at it twice, so the answer is no. No, really, it is not.");
    expectHistory(result, [one, two]);
  });

  test("a continued reply that stops at a cut tool call is committed joined, as far as it got", async () => {
    const one = "First I explain the plan for the file in the work";
    const two = "plan for the file in the workspace. Now the file:";
    const result = await run([
      { text: one, finishReason: "length", chunk: 5 },
      { text: two, finishReason: "length", chunk: 3, cutToolCall: true },
      { text: "Retried the call.", finishReason: "stop" },
    ], "Explain it, then write the file.");
    const first = "First I explain the plan for the file in the workspace. Now the file:";
    expect(committed(result.events)).toEqual([first, "Retried the call."]);
    expect(tuiReplies(result.events)).toEqual([first, "Retried the call."]);
    expect(streamedText(result.events)).toBe(first + "Retried the call.");
  });

  test("an exhausted recovery reports the parts joined", async () => {
    const result = await run([
      { text: "The watch has one going train", finishReason: "length", chunk: 4 },
      { text: "has one going train and one escapement", finishReason: "length", chunk: 4 },
      { text: "train and one escapement wheel with fifteen", finishReason: "length", chunk: 4 },
      { text: "escapement wheel with fifteen teeth", finishReason: "length", chunk: 4 },
    ], "Explain it at length.");
    expect(result.requests).toHaveLength(4);
    const whole = "The watch has one going train and one escapement wheel with fifteen teeth";
    expect(ofType(result.events, "agent_message")).toEqual([]);
    expect(streamedText(result.events)).toBe(whole);
    expect(result.phases.flatMap((phase) => phase.type === "assistant_text" ? [phase.content] : [])).toEqual([whole]);
    expect(result.phases.at(-1)).toMatchObject({ type: "turn_complete", content: whole });
  });

  test("in fast one-shot mode, the continuation joins the part handed to recovery", async () => {
    const one = "The first part of the reply stops at the out";
    const two = "reply stops at the output limit, and the second part finishes it.";
    const box: { events: readonly Event[] } = { events: [] };
    const scripted = scriptedProvider([
      { text: one, finishReason: "length" },
      { text: two, finishReason: "stop", chunk: 3 },
    ], () => box.events);
    const { session, events } = mkSession({ provider: scripted.provider, services: { runtimeOptions: resolveAgentRuntimeOptions({}, {
      lightMode: true, nonInteractive: true, dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true,
    }) } });
    box.events = events;
    Object.assign(session.services, { permissionModeRegistry: new PermissionModeRegistry({
      ...session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
    }) });
    const base = cappedCtx();
    const ctx = mkCtx({ ...base, permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" },
      config: { ...base.config, bypassFastMode: true } } as never);
    let fastCalls = 0;
    const chatStream = scripted.provider.chatStream;
    scripted.provider.chatStream = async (...args) => {
      if (oneShotFastModeActive()) fastCalls += 1;
      return chatStream(...args);
    };

    const phases = await collect(runTurn(session, ctx, "Explain it in about 700 words.", { exactOutput: true }));

    expect(fastCalls).toBe(1);
    const whole = "The first part of the reply stops at the output limit, and the second part finishes it.";
    expect(streamedText(events)).toBe(whole);
    expect(committed(events)).toEqual([whole]);
    expect(oneShotFinalMessageRemainder(streamedText(events), whole)).toBe("\n");
    expect(phases.at(-1)).toMatchObject({ type: "turn_complete", content: whole });
  });
});
