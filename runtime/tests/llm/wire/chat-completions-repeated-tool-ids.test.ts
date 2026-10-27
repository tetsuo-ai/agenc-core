import { describe, expect, test } from "vitest";
import { parseChatCompletionsResponse } from "./chat-completions.js";
import type { LLMMessage } from "../types.js";

const fileRead = { type: "function" as const, function: { name: "FileRead", description: "Read", parameters: { type: "object" } } };

/** A response with the given tool-call ids (Venice serves Kimi with "FileRead:0", "FileRead:1"...). */
function toolResponse(...ids: string[]): Record<string, unknown> {
  return {
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: ids.map(id => ({
          id,
          type: "function",
          function: { name: "FileRead", arguments: `{"file_path":"${id}.txt"}` },
        })),
      },
      finish_reason: "tool_calls",
    }],
  };
}

function history(...ids: string[]): LLMMessage[] {
  return [
    { role: "user", content: "read files" },
    { role: "assistant", content: "", toolCalls: ids.map(id => ({ id, name: "FileRead", arguments: "{}" })) },
    ...ids.map(id => ({ role: "tool" as const, content: "ok", toolCallId: id })),
    { role: "assistant", content: "done" },
    { role: "user", content: "read more files" },
  ];
}

const ids = (response: ReturnType<typeof parseChatCompletionsResponse>) => response.toolCalls!.map(call => call.id);

describe("tool-call ids a provider repeats across responses", () => {
  test("per-response counters never reach history twice", () => {
    // Turn 1 and turn 2 of a Venice Kimi session both start their calls at FileRead:0.
    const first = ids(parseChatCompletionsResponse("kimi-k2-7-code", toolResponse("FileRead:0", "FileRead:1"), {
      model: "kimi-k2-7-code", messages: [{ role: "user", content: "read a and b" }], tools: [fileRead],
    }));
    const second = ids(parseChatCompletionsResponse("kimi-k2-7-code", toolResponse("FileRead:0", "FileRead:1", "FileRead:2"), {
      model: "kimi-k2-7-code", messages: history(...first), tools: [fileRead],
    }));
    for (const id of [...first, ...second]) expect(id).toMatch(/^call_[a-f0-9]{32}$/u);
    expect(new Set([...first, ...second]).size).toBe(5);
  });

  test("an id the history already holds is replaced; other ids are kept", () => {
    const response = parseChatCompletionsResponse("some-model", toolResponse("call_0", "call_9f2c"), {
      model: "some-model", messages: history("call_0"), tools: [fileRead],
    });
    const [repeated, fresh] = ids(response);
    expect(repeated).toMatch(/^call_[a-f0-9]{32}$/u);
    expect(repeated).not.toBe("call_0");
    expect(fresh).toBe("call_9f2c");
    // Without a repeat, provider ids pass through unchanged.
    expect(ids(parseChatCompletionsResponse("some-model", toolResponse("call_0", "call_9f2c"), {
      model: "some-model", messages: [{ role: "user", content: "x" }], tools: [fileRead],
    }))).toEqual(["call_0", "call_9f2c"]);
  });

  test("the managed route keeps its namespaced ids", () => {
    const parse = (messages: LLMMessage[]) => ids(parseChatCompletionsResponse("kimi-k2-7-code", toolResponse("FileRead:0"), {
      model: "kimi-k2-7-code", messages, tools: [fileRead], toolCallIdNamespace: "managed-attempt-1",
    }));
    const withHistory = parse(history("FileRead:0"));
    expect(withHistory[0]).toMatch(/^call_[a-f0-9]{32}$/u);
    // Same attempt, same id: the gateway's idempotent replay depends on it.
    expect(parse([{ role: "user", content: "x" }])).toEqual(withHistory);
  });
});
