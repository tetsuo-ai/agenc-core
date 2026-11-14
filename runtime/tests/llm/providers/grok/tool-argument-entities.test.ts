import { describe, expect, test, vi } from "vitest";

import type { LLMMessage, LLMStreamChunk } from "../../../../src/llm/types.js";
import { validateToolCallsForExecution } from "../../../../src/llm/stream-parser.js";
import { encodeMcpToolNameForWire } from "../../../../src/llm/wire/mcp-tool-naming.js";
import { GrokProvider } from "../../../../src/llm/providers/grok/adapter.js";

const literalArguments = JSON.stringify({
  file_path: "entities.html",
  content: "&lt; &gt; &amp; &quot; &#39; &amp;lt;\n",
});

describe.each([false, true])("Grok tool argument entities (streaming=%s)", (streaming) => {
  test.each([
    {
      label: "literal file content",
      name: "Write",
      argumentsRaw: literalArguments,
      expected: literalArguments,
    },
    {
      // This valid-JSON fixture was added in 3c0f40fb34. Its string values
      // must remain literal even when the response comes from Grok.
      label: "historical parser.c content",
      name: "system.writeFile",
      argumentsRaw: JSON.stringify({ path: "src/parser.c", content: 'strcmp(token, "&quot;&gt;&quot;") == 0 && strcmp(token, "&amp;") == 0;' }),
      expected: JSON.stringify({ path: "src/parser.c", content: 'strcmp(token, "&quot;&gt;&quot;") == 0 && strcmp(token, "&amp;") == 0;' }),
    },
    {
      label: "historical escaped JSON syntax",
      name: "lookup",
      argumentsRaw: '{&quot;q&quot;:&quot;hello&quot;}',
      expected: '{"q":"hello"}',
    },
    {
      label: "escaped JSON containing literal entities",
      name: "Write",
      argumentsRaw: '{&quot;file_path&quot;:&quot;entities.html&quot;,&quot;content&quot;:&quot;&amp;lt; &amp;gt; &amp;amp; &amp;quot; &amp;#39; &amp;amp;lt;\\n&quot;}',
      expected: literalArguments,
    },
  ])("preserves execution and replay for $label", async ({ name, argumentsRaw, expected }) => {
    const provider = new GrokProvider({ apiKey: "xai-test", model: "grok-4-1-fast-reasoning" });
    const functionCall = {
      type: "function_call",
      id: "fc_entities",
      call_id: "call_entities",
      name,
      arguments: argumentsRaw,
    };
    const responseBody = {
      id: "resp_entities",
      status: "completed",
      model: "grok-4-1-fast-reasoning",
      output_text: "",
      output: [functionCall],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { type: "response.output_item.added", output_index: 0, item: { ...functionCall, arguments: "" } };
        yield { type: "response.function_call_arguments.delta", item_id: functionCall.id, output_index: 0, delta: argumentsRaw };
        yield { type: "response.output_item.done", output_index: 0, item: functionCall };
        yield { type: "response.completed", response: responseBody };
      },
    };
    const create = vi.fn((_params: Record<string, unknown>) => ({
      withResponse: async () => ({
        data: streaming ? stream : responseBody,
        response: new Response("", { status: 200 }),
        request_id: null,
      }),
    }));
    Object.assign(provider, { client: { responses: { create } } });
    const messages: LLMMessage[] = [{ role: "user", content: "Write literal entities." }];
    const chunks: LLMStreamChunk[] = [];
    const response = streaming
      ? await provider.chatStream(messages, (chunk) => chunks.push(chunk))
      : await provider.chat(messages);
    const expectedCall = { id: functionCall.call_id, name, arguments: expected };

    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([expectedCall]);
    if (streaming) {
      expect(chunks.flatMap((chunk) => chunk.toolCalls ?? [])).toContainEqual(expectedCall);
    }
    const execution = validateToolCallsForExecution(response.toolCalls);
    expect(execution).toEqual({ valid: [expectedCall], failures: [] });

    await provider.chat([
      ...messages,
      { role: "assistant", content: "", toolCalls: execution.valid },
      { role: "tool", toolCallId: expectedCall.id, toolName: name, content: "done" },
    ]);
    expect(create).toHaveBeenCalledTimes(2);
    const request = create.mock.calls[1]![0];
    expect(request.input).toContainEqual(expect.objectContaining({
      type: "function_call",
      call_id: expectedCall.id,
      name: encodeMcpToolNameForWire(name),
      arguments: expected,
    }));
  });
});
