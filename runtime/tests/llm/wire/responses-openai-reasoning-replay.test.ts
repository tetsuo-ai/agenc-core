import { describe, expect, test } from "vitest";
import type { LLMMessage } from "../../../src/llm/types.js";
import {
  buildOpenAIResponsesRequest,
  extractOpenAIReasoningReplay,
  parseOpenAIResponsesResponse,
  type OpenAIResponsesRequestOptions,
} from "../../../src/llm/wire/responses-openai.js";
import {
  llmMessageToDurableResponseItem,
  responseItemToLlmMessage,
} from "../../../src/session/message-history-conversion.js";

const MODEL = "gpt-6-sol";
// Synthetic items in the shape OpenAI returns; never real ciphertext.
const TOOL_REASONING = {
  type: "reasoning",
  id: "rs_tool_turn",
  summary: [{ type: "summary_text", text: "Read both files first." }],
  encrypted_content: "gAAAAABsynthetic-tool-turn==",
};
const ANSWER_REASONING = {
  type: "reasoning",
  id: "rs_answer",
  summary: [],
  encrypted_content: "gAAAAABsynthetic-answer==",
};
const REPLAY_REQUEST: OpenAIResponsesRequestOptions = {
  model: MODEL,
  messages: [],
  tools: [],
  reasoningReplayProvider: "openai",
};

function replayOf(...items: unknown[]): Pick<
  LLMMessage,
  "providerReasoningContent" | "providerReasoningProvenance"
> {
  return extractOpenAIReasoningReplay(items, REPLAY_REQUEST);
}

function toolTurn(
  replay: Pick<LLMMessage, "providerReasoningContent" | "providerReasoningProvenance"> =
    replayOf(TOOL_REASONING),
): LLMMessage[] {
  return [
    { role: "user", content: "compare a and b" },
    {
      role: "assistant",
      content: "Reading both.",
      toolCalls: [
        { id: "call_1", name: "read", arguments: '{"path":"a"}' },
        { id: "call_2", name: "read", arguments: '{"path":"b"}' },
      ],
      ...replay,
    },
    { role: "tool", toolCallId: "call_1", content: "A" },
    { role: "tool", toolCallId: "call_2", content: "B" },
  ];
}

function build(
  messages: LLMMessage[],
  overrides: Partial<OpenAIResponsesRequestOptions> = {},
): Record<string, unknown> {
  return buildOpenAIResponsesRequest({ ...REPLAY_REQUEST, messages, ...overrides });
}

const user = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});
const assistant = (text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});
const call = (id: string, path: string) => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: `call_${id}`,
  name: "read",
  arguments: JSON.stringify({ path }),
});
const output = (id: string, text: string) => ({
  type: "function_call_output",
  call_id: `call_${id}`,
  output: text,
});

describe("OpenAI Responses encrypted reasoning replay", () => {
  test("replays a tool turn's reasoning immediately before its function calls", () => {
    const request = build(toolTurn());

    expect(request.include).toEqual(["reasoning.encrypted_content"]);
    expect(request.input).toEqual([
      user("compare a and b"),
      assistant("Reading both."),
      TOOL_REASONING,
      call("1", "a"),
      call("2", "b"),
      output("1", "A"),
      output("2", "B"),
    ]);
  });

  test("a turn without function calls replays before its text, an empty turn replays nothing", () => {
    const request = build([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello.", ...replayOf(ANSWER_REASONING) },
      { role: "user", content: "and again" },
      { role: "assistant", content: "", ...replayOf(TOOL_REASONING) },
    ]);

    expect(request.input).toEqual([
      user("hi"),
      ANSWER_REASONING,
      assistant("Hello."),
      user("and again"),
    ]);
  });

  test("keeps several reasoning items of one response in output order", () => {
    const input = build(toolTurn(replayOf(ANSWER_REASONING, TOOL_REASONING)))
      .input as unknown[];

    expect(input.slice(2, 5)).toEqual([
      ANSWER_REASONING,
      TOOL_REASONING,
      call("1", "a"),
    ]);
  });

  test("keeps id, summary and encrypted_content, bound to the provider and request model", () => {
    const replay = extractOpenAIReasoningReplay(
      [
        {
          ...TOOL_REASONING,
          status: "completed",
          summary: [...TOOL_REASONING.summary, { type: "future_part" }],
          content: [{ type: "reasoning_text", text: "plaintext" }],
        },
        { type: "reasoning", id: "rs_stored_only", summary: [] },
        { type: "message", role: "assistant", content: [] },
        call("1", "a"),
      ],
      REPLAY_REQUEST,
    );

    expect(replay).toEqual({
      providerReasoningContent: JSON.stringify([TOOL_REASONING]),
      providerReasoningProvenance: { provider: "openai", model: MODEL },
    });
    const parsed = parseOpenAIResponsesResponse(
      MODEL,
      {
        status: "completed",
        model: "gpt-6-sol-2026-09-14",
        output: [TOOL_REASONING, call("1", "a")],
      },
      REPLAY_REQUEST,
    );
    expect(parsed.providerReasoningProvenance).toEqual({
      provider: "openai",
      model: MODEL,
    });
  });

  test.each([
    ["another provider", { provider: "grok", model: MODEL }],
    ["another model", { provider: "openai", model: "gpt-6-luna" }],
  ])("drops reasoning produced by %s", (_label, provenance) => {
    const request = build(
      toolTurn({ ...replayOf(TOOL_REASONING), providerReasoningProvenance: provenance }),
    );

    expect(request.input).not.toContainEqual(TOOL_REASONING);
    expect(request.input).toContainEqual(call("1", "a"));
  });

  test("drops a replay without provenance, or one that no longer parses as reasoning items", () => {
    const valid = replayOf(TOOL_REASONING);
    for (const replay of [
      { providerReasoningContent: valid.providerReasoningContent },
      { ...valid, providerReasoningContent: "not json" },
      { ...valid, providerReasoningContent: "[]" },
      {
        ...valid,
        providerReasoningContent: JSON.stringify([
          TOOL_REASONING,
          { type: "reasoning", id: "rs_stored_only", summary: [] },
        ]),
      },
    ]) {
      expect(build(toolTurn(replay)).input).not.toContainEqual(TOOL_REASONING);
    }
  });

  test("compares provenance the way durable history normalizes it", () => {
    const mixedCase = {
      ...replayOf(TOOL_REASONING),
      providerReasoningProvenance: { provider: " OpenAI ", model: "GPT-6-Sol" },
    };

    expect(build(toolTurn(mixedCase)).input).toContainEqual(TOOL_REASONING);
    expect(build(toolTurn(), { model: " GPT-6-SOL " }).input).toContainEqual(
      TOOL_REASONING,
    );
  });

  test("replays after durable persistence and restore", () => {
    const messages = toolTurn();
    const durable = llmMessageToDurableResponseItem(messages[1]!);
    messages[1] = responseItemToLlmMessage(JSON.parse(JSON.stringify(durable)));

    expect(build(messages).input).toEqual(build(toolTurn()).input);
  });

  test("asks for encrypted reasoning on every stateless request", () => {
    const first = [{ role: "user" as const, content: "hi" }];

    expect(build(first).include).toEqual(["reasoning.encrypted_content"]);
    expect(build(first, { store: false }).include).toEqual([
      "reasoning.encrypted_content",
    ]);
  });

  test("leaves the wire unchanged when replay is off or the request is stored", () => {
    const today = buildOpenAIResponsesRequest({
      model: MODEL,
      messages: toolTurn(),
      tools: [],
    });

    expect(build(toolTurn(), { reasoningReplayProvider: undefined })).toEqual(today);
    const stored = build(toolTurn(), { store: true });
    expect(stored.include).toBeUndefined();
    expect(stored.input).toEqual(today.input);
    expect(today.input).not.toContainEqual(TOOL_REASONING);
    expect(extractOpenAIReasoningReplay([TOOL_REASONING], { ...REPLAY_REQUEST, store: true }))
      .toEqual({});
  });
});
