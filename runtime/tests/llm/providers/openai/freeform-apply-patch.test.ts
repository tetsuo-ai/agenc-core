import { describe, expect, test, vi } from "vitest";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import {
  planResponsesWebSocketInput,
  responsesWebSocketFixedPart,
  type ResponsesWebSocketChain,
} from "../../../../src/llm/providers/openai/responses-websocket.js";
import {
  buildOpenAIResponsesRequest,
  parseOpenAIResponsesResponse,
  type OpenAIResponsesRequestOptions,
} from "../../../../src/llm/wire/responses-openai.js";
import { resolveProviderRuntimeRequest } from "../../../../src/llm/provider-request.js";
import { APPLY_PATCH_LARK_GRAMMAR } from "../../../../src/tools/apply-patch/grammar.js";
import type { LLMMessage, LLMTool, LLMToolCall } from "../../../../src/llm/types.js";
import { runWithStartupProviderSelection } from "../../../../src/utils/model/providers.js";

const MODEL = "gpt-6-luna";
const PATCH = '*** Begin Patch\n*** Update File: a.ts\n@@\n-const a = "1";\n+const a = "2\\n";\n*** End Patch\n';
const ISSUED_ID = "ctc_0e97423644f1c343016acabc7447308191b58ec08aee27d0ee";

const APPLY_PATCH: LLMTool = {
  type: "function",
  function: {
    name: "apply_patch",
    description: "Use the apply_patch tool to edit files.",
    parameters: {
      type: "object",
      properties: { input: { type: "string", description: "The full apply_patch payload." } },
      required: ["input"],
      additionalProperties: false,
    },
  },
};
const EXEC: LLMTool = {
  type: "function",
  function: {
    name: "exec_command",
    description: "Run a command.",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false },
  },
};
const TOOLS = [EXEC, APPLY_PATCH];

const patchCall: LLMToolCall = { id: "call_p", name: "apply_patch", arguments: JSON.stringify({ input: PATCH }) };
const execCall: LLMToolCall = { id: "call_e", name: "exec_command", arguments: '{"cmd":"ls"}' };

function history(toolCalls: readonly LLMToolCall[]): LLMMessage[] {
  return [
    { role: "user", content: "change a" },
    { role: "assistant", content: "", toolCalls: [...toolCalls] },
    ...toolCalls.map((call): LLMMessage => ({ role: "tool", toolCallId: call.id, content: `done ${call.id}` })),
  ];
}

function build(extra: Partial<OpenAIResponsesRequestOptions> = {}): Record<string, unknown> {
  return buildOpenAIResponsesRequest({ model: MODEL, messages: history([execCall, patchCall]), tools: TOOLS, ...extra });
}

function sse(events: ReadonlyArray<Record<string, unknown>>): Response {
  const body = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function json(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

const CUSTOM_ITEM = { type: "custom_tool_call", id: ISSUED_ID, call_id: "call_p", status: "completed", name: "apply_patch", input: PATCH };

function customTurnStream(): Response {
  return sse([
    { type: "response.output_item.added", output_index: 0, item: { ...CUSTOM_ITEM, input: "", status: "in_progress" } },
    { type: "response.custom_tool_call_input.delta", output_index: 0, item_id: ISSUED_ID, delta: PATCH },
    { type: "response.custom_tool_call_input.done", output_index: 0, item_id: ISSUED_ID, input: PATCH },
    { type: "response.output_item.done", output_index: 0, item: CUSTOM_ITEM },
    { type: "response.completed", response: { id: "resp_1", status: "completed", model: MODEL, output: [] } },
  ]);
}

function answerStream(): Response {
  return sse([
    { type: "response.output_text.delta", delta: "done" },
    { type: "response.completed", response: { id: "resp_2", status: "completed", model: MODEL, output: [] } },
  ]);
}

function sentBody(fetchImpl: { readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> } }, call: number) {
  const init = fetchImpl.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as { tools: Array<Record<string, unknown>>; input: Array<Record<string, unknown>> };
}

function inSession<T>(operation: () => Promise<T>, model = MODEL): Promise<T> {
  return runWithStartupProviderSelection({ provider: "openai", model, environment: {} }, operation);
}

describe("freeform apply_patch on the Responses wire", () => {
  test("declares apply_patch as a custom tool with the Lark grammar and leaves other tools alone", () => {
    const off = build();
    const on = build({ freeformApplyPatch: true });
    const offTools = off.tools as Array<Record<string, unknown>>;
    const onTools = on.tools as Array<Record<string, unknown>>;
    expect(onTools[0]).toEqual(offTools[0]);
    expect(offTools[1]).toMatchObject({ type: "function", name: "apply_patch" });
    expect(onTools[1]).toEqual({
      type: "custom",
      name: "apply_patch",
      description: "Use the apply_patch tool to edit files.",
      format: { type: "grammar", syntax: "lark", definition: APPLY_PATCH_LARK_GRAMMAR },
    });
  });

  test("an unset option leaves the request byte-identical", () => {
    expect(JSON.stringify(build({ freeformApplyPatch: false }))).toBe(JSON.stringify(build()));
    // A request without apply_patch does not change with the option either.
    const withoutPatch = (extra: Partial<OpenAIResponsesRequestOptions>) => JSON.stringify(buildOpenAIResponsesRequest({
      model: MODEL, messages: history([execCall]), tools: [EXEC], ...extra,
    }));
    expect(withoutPatch({ freeformApplyPatch: true })).toBe(withoutPatch({}));
  });

  test("replays a patch call and its result as custom items, other calls as function items", () => {
    const input = build({ freeformApplyPatch: true, functionCallItemId: (id) => id === "call_p" ? ISSUED_ID : undefined })
      .input as Array<Record<string, unknown>>;
    expect(input.slice(1)).toEqual([
      { type: "function_call", call_id: "call_e", name: "exec_command", arguments: '{"cmd":"ls"}' },
      { type: "custom_tool_call", id: ISSUED_ID, call_id: "call_p", name: "apply_patch", input: PATCH },
      { type: "function_call_output", call_id: "call_e", output: "done call_e" },
      { type: "custom_tool_call_output", call_id: "call_p", output: "done call_p" },
    ]);
  });

  test("keeps the function form for a patch call whose arguments are not exactly the input field", () => {
    for (const args of ['{"input":"x","cwd":"/tmp"}', "not json", '{"input":1}', "[]"]) {
      const input = buildOpenAIResponsesRequest({
        model: MODEL, tools: TOOLS, freeformApplyPatch: true,
        messages: history([{ id: "call_p", name: "apply_patch", arguments: args }]),
      }).input as Array<Record<string, unknown>>;
      expect(input.slice(1).map((item) => item.type), args).toEqual(["function_call", "function_call_output"]);
    }
  });

  test("closes an unanswered custom call with a custom output", () => {
    const input = buildOpenAIResponsesRequest({
      model: MODEL, tools: TOOLS, freeformApplyPatch: true,
      messages: [{ role: "user", content: "change a" }, { role: "assistant", content: "", toolCalls: [patchCall] }],
    }).input as Array<Record<string, unknown>>;
    expect(input.slice(1).map((item) => [item.type, item.call_id])).toEqual([
      ["custom_tool_call", "call_p"], ["custom_tool_call_output", "call_p"],
    ]);
  });

  test("names the custom tool in a forced tool choice", () => {
    const choice = (name: string, freeformApplyPatch: boolean) => buildOpenAIResponsesRequest({
      model: MODEL, messages: [{ role: "user", content: "x" }], tools: TOOLS, freeformApplyPatch,
      options: { toolChoice: { type: "function", name } },
    }).tool_choice;
    expect(choice("apply_patch", true)).toEqual({ type: "custom", name: "apply_patch" });
    expect(choice("apply_patch", false)).toEqual({ type: "function", name: "apply_patch" });
    expect(choice("exec_command", true)).toEqual({ type: "function", name: "exec_command" });
  });

  test("reads a custom_tool_call output item as the apply_patch function call", () => {
    const parsed = parseOpenAIResponsesResponse(MODEL, { id: "resp_1", status: "completed", output: [CUSTOM_ITEM] }, {
      model: MODEL, messages: [{ role: "user", content: "change a" }], tools: TOOLS, freeformApplyPatch: true,
    });
    expect(parsed.toolCalls).toEqual([patchCall]);
    expect(parsed.finishReason).toBe("tool_calls");
  });

  test("continues a socket chain over a custom call only when the replayed patch is the issued one", () => {
    const user = { type: "message", role: "user", content: [{ type: "input_text", text: "change a" }] };
    const body = (input: unknown[]): Record<string, unknown> => ({
      model: MODEL, input, stream: true, store: false, tools: [{ type: "custom", name: "apply_patch" }],
    });
    const chain: ResponsesWebSocketChain = {
      responseId: "resp_1", fixed: responsesWebSocketFixedPart(body([user])), input: [JSON.stringify(user)],
      output: [CUSTOM_ITEM],
    };
    const replay = { type: "custom_tool_call", id: ISSUED_ID, call_id: "call_p", name: "apply_patch", input: PATCH };
    const output = { type: "custom_tool_call_output", call_id: "call_p", output: "done" };
    expect(planResponsesWebSocketInput(chain, body([user, replay, output]))).toEqual([output]);
    expect(planResponsesWebSocketInput(chain, body([user, { ...replay, input: `${PATCH} ` }, output]))).toBeUndefined();
    expect(planResponsesWebSocketInput(chain, body([user,
      { type: "function_call", call_id: "call_p", name: "apply_patch", arguments: JSON.stringify({ input: PATCH }) },
      output]))).toBeUndefined();
  });
});

describe("OpenAIProvider with responsesToolFormat freeform", () => {
  test("streams a custom call as apply_patch and sends it back in custom form with the issued item id", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(customTurnStream())
      .mockResolvedValueOnce(answerStream());
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl, tools: TOOLS, responsesToolFormat: "freeform" });
    const chunks: LLMToolCall[] = [];

    const first = await inSession(() => provider.chatStream([{ role: "user", content: "change a" }],
      (chunk) => { chunks.push(...(chunk.toolCalls ?? [])); }));
    await inSession(() => provider.chatStream(history(first.toolCalls), () => {}));

    expect(first.toolCalls).toEqual([patchCall]);
    expect(first.finishReason).toBe("tool_calls");
    // Published when validated and again with the final chunk, as a function call is.
    expect(chunks.length).toBeGreaterThan(0);
    for (const call of chunks) expect(call).toEqual(patchCall);
    expect(sentBody(fetchImpl, 0).tools.map((tool) => tool.type)).toEqual(["function", "custom"]);
    expect(sentBody(fetchImpl, 1).input.slice(1)).toEqual([
      { type: "custom_tool_call", id: ISSUED_ID, call_id: "call_p", name: "apply_patch", input: PATCH },
      { type: "custom_tool_call_output", call_id: "call_p", output: "done call_p" },
    ]);
  });

  test("reads a custom call from a non-streaming response", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: "resp_1", status: "completed", model: MODEL, output: [CUSTOM_ITEM] }))
      .mockResolvedValueOnce(json({
        id: "resp_2", status: "completed", model: MODEL,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
      }));
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl, tools: TOOLS, responsesToolFormat: "freeform" });

    const first = await inSession(() => provider.chat([{ role: "user", content: "change a" }]));
    await inSession(() => provider.chat(history(first.toolCalls)));

    expect(first.toolCalls).toEqual([patchCall]);
    expect(sentBody(fetchImpl, 1).input[1]).toEqual(
      { type: "custom_tool_call", id: ISSUED_ID, call_id: "call_p", name: "apply_patch", input: PATCH });
  });

  test("sends the same bytes as an unconfigured provider when unset or set to function", async () => {
    const bodies: string[] = [];
    for (const responsesToolFormat of [undefined, "function"] as const) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(answerStream());
      const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl, tools: TOOLS,
        ...(responsesToolFormat !== undefined ? { responsesToolFormat } : {}) });
      await inSession(() => provider.chatStream(history([execCall, patchCall]), () => {}));
      bodies.push(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body));
    }
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[0]).not.toContain('"custom');
  });

  test("keeps the function tool for a model before GPT-5 and for other providers on this adapter", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["gpt-4.1", {}],
      [MODEL, { providerName: "meta", baseURL: "https://example.invalid/v1" }],
      [MODEL, { providerName: "grok", baseURL: "https://example.invalid/v1" }],
    ];
    for (const [model, extra] of cases) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(answerStream());
      const provider = new OpenAIProvider({ apiKey: "sk-test", model, fetchImpl, tools: TOOLS, responsesToolFormat: "freeform",
        useResponsesApi: true, ...extra });
      await provider.chatStream(history([execCall, patchCall]), () => {});
      const body = String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body);
      expect(body, `${model} ${JSON.stringify(extra)}`).not.toContain('"custom');
    }
  });
});

describe("AGENC_OPENAI_TOOL_FORMAT", () => {
  const extra = (provider: "openai" | "deepseek" | "openrouter", environment: Record<string, string>) =>
    resolveProviderRuntimeRequest({ provider, model: provider === "openai" ? MODEL : "deepseek-flash", config: {}, environment })
      .requested.extra as Record<string, unknown> | undefined;

  test("reaches only the openai provider, and only as a known value", () => {
    expect(extra("openai", { AGENC_OPENAI_TOOL_FORMAT: "freeform" })).toMatchObject({ responsesToolFormat: "freeform" });
    expect(extra("openai", { AGENC_OPENAI_TOOL_FORMAT: " Function " })).toMatchObject({ responsesToolFormat: "function" });
    expect(extra("openai", { AGENC_OPENAI_TOOL_FORMAT: "xml" })?.responsesToolFormat).toBeUndefined();
    expect(extra("openai", {})?.responsesToolFormat).toBeUndefined();
    for (const provider of ["deepseek", "openrouter"] as const) {
      expect(extra(provider, { AGENC_OPENAI_TOOL_FORMAT: "freeform" }), provider).toEqual(extra(provider, {}));
    }
  });
});
