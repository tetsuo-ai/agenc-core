import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { LLMProviderTraceEvent } from "../../src/llm/types.js";
import {
  createProviderTraceSink,
  providerTraceEnabled,
  summarizeProviderRequestParams,
} from "../../src/llm/provider-trace-sink.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agenc-trace-sink-"));
  homes.push(home);
  return home;
}

function readLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const requestEvent: LLMProviderTraceEvent = {
  kind: "request",
  transport: "chat_stream",
  provider: "grok",
  model: "grok-4.6",
  payload: {
    model: "grok-4.6",
    input: [
      { role: "system", content: "static instructions" },
      { role: "user", content: "hello there" },
    ],
    tools: [{ type: "function", name: "FileRead" }, { type: "function", name: "Edit" }],
    prompt_cache_key: "conv-1",
    previous_response_id: "resp_0",
    reasoning: { effort: "xhigh" },
    parallel_tool_calls: true,
    max_output_tokens: 32_000,
    store: true,
    stream: true,
  },
  context: { requestMetrics: { totalContentChars: 30 } },
};

const responseEvent: LLMProviderTraceEvent = {
  kind: "response",
  transport: "chat_stream",
  provider: "grok",
  model: "grok-4.6",
  payload: {
    id: "resp_1",
    status: "completed",
    model: "grok-4.6",
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      { type: "function_call", call_id: "call_1", name: "FileRead", arguments: "{}" },
    ],
    usage: {
      input_tokens: 154_304,
      output_tokens: 878,
      input_tokens_details: { cached_tokens: 151_680 },
      output_tokens_details: { reasoning_tokens: 348 },
    },
  },
};

describe("provider trace sink", () => {
  test("is gated by AGENC_PROVIDER_TRACE", () => {
    expect(providerTraceEnabled({})).toBe(false);
    expect(providerTraceEnabled({ AGENC_PROVIDER_TRACE: "0" })).toBe(false);
    expect(providerTraceEnabled({ AGENC_PROVIDER_TRACE: "1" })).toBe(true);
    expect(providerTraceEnabled({ AGENC_PROVIDER_TRACE: "true" })).toBe(true);
  });

  test("writes one request line and one response line per call without message bodies", () => {
    const home = tempHome();
    let clock = 1_000;
    const sink = createProviderTraceSink({
      agencHome: home,
      conversationId: "conv-1",
      now: () => clock,
      wallClock: () => "2026-09-02T00:00:00.000Z",
    });

    sink.onProviderTraceEvent(requestEvent);
    clock = 1_250;
    sink.onProviderTraceEvent({
      kind: "stream_event",
      transport: "chat_stream",
      provider: "grok",
      payload: { type: "response.created" },
    });
    sink.onProviderTraceEvent({
      kind: "stream_event",
      transport: "chat_stream",
      provider: "grok",
      payload: { type: "response.output_text.delta", delta: "done" },
    });
    clock = 13_400;
    sink.onProviderTraceEvent(responseEvent);

    expect(sink.directory).toBe(join(home, "agent-logs", "conv-1"));
    expect(readdirSync(sink.directory)).toEqual(["llm-00001.jsonl"]);
    const [request, response] = readLines(join(sink.directory, "llm-00001.jsonl"));

    expect(request).toMatchObject({
      kind: "request",
      seq: 1,
      conversationId: "conv-1",
      provider: "grok",
      model: "grok-4.6",
      params: {
        model: "grok-4.6",
        prompt_cache_key: "conv-1",
        previous_response_id: "resp_0",
        reasoning: { effort: "xhigh" },
        parallel_tool_calls: true,
        max_output_tokens: 32_000,
        store: true,
        input_items: 2,
        tool_count: 2,
        tool_names: ["FileRead", "Edit"],
      },
      context: { requestMetrics: { totalContentChars: 30 } },
    });
    const params = request?.params as Record<string, unknown>;
    expect(params.input).toBeUndefined();
    expect(params.tools).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain("hello there");
    expect(JSON.stringify(request)).not.toContain("static instructions");

    expect(response).toMatchObject({
      kind: "response",
      seq: 1,
      elapsedMs: 12_400,
      firstStreamEventMs: 250,
      streamEvents: 2,
      response: {
        id: "resp_1",
        status: "completed",
        usage: {
          input_tokens: 154_304,
          output_tokens: 878,
          input_tokens_details: { cached_tokens: 151_680 },
          output_tokens_details: { reasoning_tokens: 348 },
        },
        output_items: 2,
        output_text_chars: 4,
        tool_calls: 1,
      },
    });
  });

  test("writes the full request body only when bodies are requested", () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-trace-bodies-"));
    homes.push(home);
    const payload = {
      model: "grok-4",
      prompt_cache_key: "conv-bodies",
      instructions: "static head",
      input: [{ role: "user", content: "hello with token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG" }],
      tools: [{ name: "FileRead" }],
    };
    const request: LLMProviderTraceEvent = {
      kind: "request",
      transport: "chat_stream",
      provider: "grok",
      model: "grok-4",
      payload,
    };
    const silent = createProviderTraceSink({ agencHome: home, conversationId: "conv-silent" });
    silent.onProviderTraceEvent(request);
    expect(readdirSync(silent.directory)).toEqual(["llm-00001.jsonl"]);

    const loud = createProviderTraceSink({ agencHome: home, conversationId: "conv-bodies", bodies: true });
    loud.onProviderTraceEvent(request);
    expect(readdirSync(loud.directory).sort()).toEqual(["llm-00001.jsonl", "llm-00001.request.json"]);
    const body = JSON.parse(readFileSync(join(loud.directory, "llm-00001.request.json"), "utf8"));
    expect(body.instructions).toBe("static head");
    expect(body.input).toHaveLength(1);
    expect(body.tools).toEqual([{ name: "FileRead" }]);
    expect(JSON.stringify(body)).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
  });

  test("numbers files per request and records errors with elapsed time", () => {
    const home = tempHome();
    let clock = 0;
    const sink = createProviderTraceSink({
      agencHome: home,
      conversationId: "conv/with spaces",
      now: () => clock,
    });
    sink.onProviderTraceEvent(requestEvent);
    clock = 40;
    sink.onProviderTraceEvent(responseEvent);
    sink.onProviderTraceEvent(requestEvent);
    clock = 95;
    sink.onProviderTraceEvent({
      kind: "error",
      transport: "chat_stream",
      provider: "grok",
      payload: { name: "LLMRateLimitError", message: "rate limited", status: 429 },
    });

    const files = readdirSync(sink.directory).sort();
    expect(files).toEqual(["llm-00001.jsonl", "llm-00002.jsonl"]);
    const [, error] = readLines(join(sink.directory, "llm-00002.jsonl"));
    expect(error).toMatchObject({
      kind: "error",
      seq: 2,
      elapsedMs: 55,
      streamEvents: 0,
      error: { name: "LLMRateLimitError", status: 429 },
    });
  });

  test("a new sink for the same conversation continues the file numbering", () => {
    // Live shape: after a daemon restart the resumed session's sink restarted
    // at llm-00001 and appended the new epoch's records into the first
    // epoch's files.
    const home = mkdtempSync(join(tmpdir(), "agenc-trace-seq-"));
    try {
      const first = createProviderTraceSink({ agencHome: home, conversationId: "conv-seq" });
      for (let i = 0; i < 3; i += 1) {
        first.onProviderTraceEvent({ kind: "request", provider: "grok", model: "m", transport: "chat_stream", payload: { model: "m", input: [] } } as unknown as LLMProviderTraceEvent);
        first.onProviderTraceEvent({ kind: "response", provider: "grok", model: "m", transport: "chat_stream", payload: { id: `resp_${i}`, status: "completed", model: "m", output: [] } } as unknown as LLMProviderTraceEvent);
      }
      const second = createProviderTraceSink({ agencHome: home, conversationId: "conv-seq" });
      second.onProviderTraceEvent({ kind: "request", provider: "grok", model: "m", transport: "chat_stream", payload: { model: "m", input: [] } } as unknown as LLMProviderTraceEvent);
      const names = readdirSync(first.directory).sort();
      expect(names).toEqual(["llm-00001.jsonl", "llm-00002.jsonl", "llm-00003.jsonl", "llm-00004.jsonl"]);
      expect(readFileSync(join(first.directory, "llm-00001.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("summarizeProviderRequestParams records prefix and tool digests without bodies", () => {
    const payload = {
      model: "grok-4.6",
      input: [
        { role: "system", content: "You are the AgenC runtime. SECRET-A" },
        { role: "developer", content: "memory: SECRET-B" },
        { role: "user", content: "Add levels" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "and a banner" },
      ],
      tools: [{ type: "function", name: "FileRead" }, { type: "function", name: "Edit" }],
    };
    const summary = summarizeProviderRequestParams(payload);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("SECRET-A");
    expect(serialized).not.toContain("SECRET-B");
    expect(summary.input_items).toBe(5);
    expect(summary.input_prefix_sha256).toHaveLength(4);
    expect(typeof summary.input_sha256).toBe("string");
    expect(typeof summary.tools_sha256).toBe("string");

    // A change in the second item moves only its digest (and the whole-body digest).
    const changed = summarizeProviderRequestParams({
      ...payload,
      input: payload.input.map((item, index) =>
        index === 1 ? { ...item, content: "memory: recalled today" } : item,
      ),
    });
    const before = summary.input_prefix_sha256 as string[];
    const after = changed.input_prefix_sha256 as string[];
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    expect(after[3]).toBe(before[3]);
    expect(changed.input_sha256).not.toBe(summary.input_sha256);
    expect(changed.tools_sha256).toBe(summary.tools_sha256);
  });

  test("summarizeProviderRequestParams reports absent routing fields as null", () => {
    const summary = summarizeProviderRequestParams({ model: "grok-4.6", input: [] });
    expect(summary.input_prefix_sha256).toEqual([]);
    expect(typeof summary.input_sha256).toBe("string");
    const { input_prefix_sha256: _prefix, input_sha256: _body, ...routing } = summary;
    expect(routing).toEqual({
      model: "grok-4.6",
      prompt_cache_key: null,
      previous_response_id: null,
      reasoning: null,
      parallel_tool_calls: null,
      max_output_tokens: null,
      input_items: 0,
      input_chars: 2,
    });
  });
});
