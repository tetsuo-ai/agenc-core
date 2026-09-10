import { describe, expect, test } from "vitest";
import { OllamaProvider } from "../../../../src/llm/providers/ollama/adapter.js";
import { createAskUserQuestionTool } from "../../../../src/tools/ask-user-question/tool.js";
import type { LLMChatOptions, LLMStreamChunk, LLMTool } from "../../../../src/llm/types.js";

const readTool: LLMTool = {
  type: "function",
  function: {
    name: "FileRead",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
};
const call = '{"name":"FileRead","arguments":{"file_path":"note.txt"}}';
const messages = [{ role: "user" as const, content: "Read note.txt" }];

function providerFor(
  parts: readonly string[],
  configTools: LLMTool[] = [readTool],
  tail: Record<string, unknown> = { done: true, done_reason: "stop" },
  fail = false,
) {
  const requests: Record<string, unknown>[] = [];
  async function* stream() {
    for (const part of parts) yield { message: { content: part } };
    yield tail;
    if (fail) throw new Error("stream transport disconnected");
  }
  const provider = new OllamaProvider({ model: "qwen2.5-coder:7b", tools: configTools });
  Object.assign(provider, {
    client: {
      chat: async (params: Record<string, unknown>) => {
        requests.push(params);
        return params.stream ? stream() : { message: { content: parts.join("") }, ...tail };
      },
      list: async () => ({ models: [] }),
    },
  });
  return { provider, requests };
}

describe("Ollama text-call recovery in actual adapter requests", () => {
  test.each([false, true])("uses constructor tools when the call has no override (stream=%s)", async (streaming) => {
    const { provider, requests } = providerFor([call]);
    const chunks: LLMStreamChunk[] = [];
    const response = streaming
      ? await provider.chatStream(messages, (chunk) => chunks.push(chunk))
      : await provider.chat(messages);
    expect(requests[0]?.tools).toEqual([readTool]);
    expect(response.toolCalls).toMatchObject([{ name: "FileRead", arguments: '{"file_path":"note.txt"}' }]);
    expect(response.finishReason).toBe("tool_calls");
    expect(response.content).toBe("");
    expect(chunks.map((chunk) => chunk.content).join("")).toBe("");
  });

  test.each([false, true])("honors the filtered wire catalog, not the larger input catalog (stream=%s)", async (streaming) => {
    for (const options of [
      { tools: [readTool], toolRouting: { allowedToolNames: [] } },
      { tools: [readTool], toolRouting: { allowedToolNames: ["other"] } },
      { tools: [] },
    ] satisfies LLMChatOptions[]) {
      const { provider, requests } = providerFor([call]);
      const chunks: LLMStreamChunk[] = [];
      const response = streaming
        ? await provider.chatStream(messages, (chunk) => chunks.push(chunk), options)
        : await provider.chat(messages, options);
      expect(requests[0]?.tools ?? []).toEqual([]);
      expect(response.toolCalls).toEqual([]);
      expect(response.content).toBe(call);
      if (streaming) expect(chunks.map((chunk) => chunk.content).join("")).toBe(call);
    }
  });

  test.each([false, true])("does not promote unadvertised skills or schema-invalid calls (stream=%s)", async (streaming) => {
    for (const text of [
      '{"name":"agent-browser","arguments":{"url":"https://www.apple.com"}}',
      '{"name":"FileRead","arguments":{"path":"note.txt"}}',
    ]) {
      const { provider } = providerFor([text]);
      const response = streaming
        ? await provider.chatStream(messages, () => {})
        : await provider.chat(messages);
      expect(response.toolCalls).toEqual([]);
      if (text.includes('"name":"FileRead"')) {
        expect(response.content).toBe("");
        expect(response.toolCallRecovery).toMatchObject({ reason: "invalid_arguments", toolName: "FileRead" });
      } else {
        expect(response.content).toBe(text);
        expect(response.toolCallRecovery).toBeUndefined();
      }
    }
  });

  test.each([false, true])("rejects advertised MCP non-object arguments without leaking JSON or sampling again (stream=%s)", async streaming => {
    const routineTool: LLMTool = { ...readTool, function: { ...readTool.function,
      name: "mcp.agenc-desktop-control.desktop_routine_list",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    } };
    for (const args of [[], null, true, 42, "[]", "private-marker-invalid-json"]) {
      const text = JSON.stringify({ name: "mcp__agenc-desktop-control__desktop_routine_list", arguments: args });
      const { provider, requests } = providerFor([...text], [routineTool]);
      const chunks: LLMStreamChunk[] = [];
      const response = streaming
        ? await provider.chatStream(messages, chunk => chunks.push(chunk))
        : await provider.chat(messages);
      expect(response.toolCalls).toEqual([]);
      expect(response.content).toBe("");
      expect(response.finishReason).toBe("stop");
      expect(response.toolCallRecovery).toMatchObject({
        toolName: routineTool.function.name, reason: "invalid_arguments",
      });
      expect(JSON.stringify(response.toolCallRecovery)).not.toContain("private-marker");
      expect(chunks.map(chunk => chunk.content).join("")).toBe("");
      expect(chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
      expect(requests).toHaveLength(1);
    }
  });

  test.each([false, true])("diagnoses the live fenced AskUserQuestion regression after an answered call (stream=%s)", async streaming => {
    const ask = createAskUserQuestionTool();
    const askTool: LLMTool = { type: "function", function: {
      name: ask.name, description: ask.description, parameters: ask.inputSchema,
    } };
    const question = "Do you want to add a Vitest regression test in tests/local-model-flow.test.ts for the TypeScript function runLocalModelFlow(io)?";
    const options = [{ label: "Accept" }, { label: "Decline" }];
    const validArgs = { questions: [{ question, header: "Please confirm:", multiSelect: false, options }] };
    // The wire schema requires question, but deliberately permits label-only options.
    const invalidArgs = { questions: [{ header: question, multiSelect: false, options }] };
    const text = "```json\n" + JSON.stringify({ name: ask.name, arguments: invalidArgs }, null, 2) + "\n```";
    const { provider, requests } = providerFor([...text], [askTool]);
    const history = [...messages,
      { role: "assistant" as const, content: "", toolCalls: [{ id: "previous-ask", name: ask.name, arguments: JSON.stringify(validArgs) }] },
      { role: "tool" as const, content: "User answered: Accept", toolCallId: "previous-ask" },
    ];
    const chunks: LLMStreamChunk[] = [];
    const response = streaming
      ? await provider.chatStream(history, chunk => chunks.push(chunk))
      : await provider.chat(history);
    expect(requests[0]?.tools).toEqual([askTool]);
    expect(response.toolCalls).toEqual([]);
    expect(response.content).toBe("");
    expect(response.finishReason).toBe("stop");
    expect(response.toolCallRecovery).toMatchObject({
      toolName: ask.name, reason: "invalid_arguments", message: expect.stringContaining("required property 'question'"),
    });
    expect(response.toolCallRecovery?.message).not.toContain(question);
    expect(chunks.map(chunk => chunk.content).join("")).toBe("");
    expect(chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
    // The adapter returns feedback; only the separately admitted turn loop may retry.
    expect(requests).toHaveLength(1);
  });

  test("holds a rejected standalone fence across every streaming boundary", async () => {
    const text = '```json\n{"name":"FileRead","arguments":{"path":"note.txt"}}\n```';
    for (let split = 1; split < text.length; split++) {
      const { provider, requests } = providerFor([text.slice(0, split), text.slice(split)]);
      const chunks: LLMStreamChunk[] = [];
      const response = await provider.chatStream(messages, chunk => chunks.push(chunk));
      expect(response.toolCalls).toEqual([]);
      expect(response.content).toBe("");
      expect(response.toolCallRecovery).toMatchObject({ toolName: "FileRead", reason: "invalid_arguments" });
      expect(chunks.map(chunk => chunk.content).join("")).toBe("");
      expect(requests).toHaveLength(1);
    }
  });

  test.each([false, true])("preserves fenced examples and unadvertised or truncated call text (stream=%s)", async streaming => {
    const invalid = '```json\n{"name":"FileRead","arguments":{"path":"note.txt"}}\n```';
    for (const [text, tools, doneReason] of [
      ["Example:\n" + invalid, [readTool], "stop"],
      [invalid + "\nThis is an example.", [readTool], "stop"],
      [invalid.replace("json", "typescript"), [readTool], "stop"],
      [invalid, [], "stop"],
      [invalid, [readTool], "length"],
    ] as const) {
      const { provider, requests } = providerFor([...text], [...tools], { done: true, done_reason: doneReason });
      const chunks: LLMStreamChunk[] = [];
      const response = streaming
        ? await provider.chatStream(messages, chunk => chunks.push(chunk))
        : await provider.chat(messages);
      expect(response.content).toBe(text);
      expect(response.toolCalls).toEqual([]);
      expect(response.toolCallRecovery).toBeUndefined();
      if (streaming) expect(chunks.map(chunk => chunk.content).join("")).toBe(text);
      expect(requests).toHaveLength(1);
    }
  });

  test("preserves streamed prose exactly and never leaks fences, regardless of token boundaries", async () => {
    const prefix = "  I will read it.\n\n  ";
    const suffix = "\n\n  I will explain next.  ";
    const text = prefix + "```json\n" + call + "\n```" + suffix;
    // Every possible two-chunk boundary includes the split fence regression;
    // single-character chunks catch multiple shrinking-prefix interactions.
    const partitions = [...Array.from({ length: text.length - 1 }, (_, i) => [text.slice(0, i + 1), text.slice(i + 1)]), [...text]];
    for (const parts of partitions) {
      const { provider } = providerFor(parts);
      const chunks: LLMStreamChunk[] = [];
      const response = await provider.chatStream(messages, (chunk) => chunks.push(chunk));
      expect(response.toolCalls).toHaveLength(1);
      expect(response.content).toBe(prefix + suffix);
      expect(chunks.map((chunk) => chunk.content).join("")).toBe(response.content);
      expect(chunks.filter((chunk) => chunk.done)).toHaveLength(1);
      expect(chunks.flatMap((chunk) => chunk.toolCalls ?? [])).toEqual(response.toolCalls);
    }
  });

  test("does not buffer ordinary JSON/code when the request has no tools", async () => {
    const { provider } = providerFor(["```json\n", "{\"note\":1}", "\n```"], []);
    const chunks: LLMStreamChunk[] = [];
    await provider.chatStream(messages, (chunk) => chunks.push(chunk));
    expect(chunks.map((chunk) => chunk.content)).toEqual(["```json\n", "{\"note\":1}", "\n```", ""]);
  });

  test("releases non-call text byte-for-byte after buffering", async () => {
    const text = "  Here is JSON.\n```json\n{\"note\":1}\n```\nDone.  ";
    const { provider } = providerFor([...text]);
    const chunks: LLMStreamChunk[] = [];
    const response = await provider.chatStream(messages, (chunk) => chunks.push(chunk));
    expect(response.content).toBe(text);
    expect(response.toolCalls).toEqual([]);
    expect(chunks.map((chunk) => chunk.content).join("")).toBe(text);
  });

  test.each([false, true])("does not recover complete-looking text if the provider truncated (stream=%s)", async (streaming) => {
    const { provider } = providerFor([call], [readTool], { done: true, done_reason: "length" });
    const response = streaming
      ? await provider.chatStream(messages, () => {})
      : await provider.chat(messages);
    expect(response.finishReason).toBe("length");
    expect(response.toolCalls).toEqual([]);
    expect(response.content).toBe(call);
  });

  test("failed streams release buffered text without exposing any executable calls", async () => {
    const { provider } = providerFor(["I will read.\n", call], [readTool], {
      message: { tool_calls: [{ function: { name: "FileRead", arguments: { file_path: "note.txt" } } }] },
    }, true);
    const chunks: LLMStreamChunk[] = [];
    const response = await provider.chatStream(messages, (chunk) => chunks.push(chunk));
    expect(response.finishReason).toBe("error");
    expect(response.partial).toBe(true);
    expect(response.toolCalls).toEqual([]);
    expect(chunks.flatMap((chunk) => chunk.toolCalls ?? [])).toEqual([]);
    expect(chunks.map((chunk) => chunk.content).join("")).toBe(response.content);
  });

  test("native calls take precedence, without adding another recovered call", async () => {
    const { provider } = providerFor([call], [readTool], {
      done: true, done_reason: "stop",
      message: { tool_calls: [{ function: { name: "FileRead", arguments: { file_path: "note.txt" } } }] },
    });
    const response = await provider.chatStream(messages, () => {});
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]?.name).toBe("FileRead");
  });
});
