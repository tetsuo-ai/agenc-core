import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSubscriptionProvider, prepareRequest, parseResponse, wireName, PROVIDER } from "./provider.js";
import type { LLMTool, LLMMessage, LLMStreamChunk } from "../../src/llm/types.js";

const tools: LLMTool[] = [{ type: "function", function: { name: "system.fixture.with.dots", description: "Fixture", parameters: { type: "object", properties: {} } } }];
const messages: LLMMessage[] = [{ role: "user", content: "test" }];
const request = prepareRequest("sonnet", messages, { tools });
test("PDF attachments send native document fields without local extraction metadata", () => {
  const source = { type: "base64" as const, media_type: "application/pdf" as const, data: "JVBERi0=" };
  const result = prepareRequest("sonnet", [{ role: "user", content: [{ type: "document", source, title: "fixture", filename: "fixture.pdf", fallbackText: "local-only", fallbackTextError: "local-path", fallbackTextTruncated: false }] }]);
  assert.deepEqual(result.messages[0]!.content, [{ type: "document", source, title: "fixture" }]);
});
function native(tool = true) {
  return { model: "sonnet", choices: [{ finish_reason: tool ? "tool_calls" as const : "stop" as const,
    message: { content: "ok", tool_calls: tool ? [{ id: "call1", function: { name: wireName(tools[0]!.function.name), arguments: "{}" } }] : [],
      reasoning_details: [{ type: "claude-subscription-directsdk-experimental.native_assistant", version: 1, messages: [], projection: {} }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, native_admission: { upstream_requests: 1, blocked_requests: 0 } } };
}

test("AgenC tool names map deterministically across catalog reorder and history", () => {
  assert.match(request.tools[0]!.function.name, /^[a-zA-Z0-9_-]{1,50}$/);
  const next = prepareRequest("sonnet", [{ role: "assistant", content: "", toolCalls: [{ id: "a", name: tools[0]!.function.name, arguments: "{}" }] }, { role: "tool", content: "done", toolCallId: "a" }], { tools: [...tools].reverse() });
  assert.equal(next.messages[0]!.tool_calls![0]!.function.name, request.tools[0]!.function.name);
  assert.equal(parseResponse(native(), request, { tools }).toolCalls[0]!.name, tools[0]!.function.name);
  assert.throws(() => prepareRequest("sonnet", messages, { tools: [...tools, ...tools] }), /Duplicate/);
});

test("native reasoning replay is bound to provider AND model; runtime metadata is omitted", () => {
  const msg: LLMMessage = { role: "assistant", content: "ok", providerReasoningContent: "[]", providerReasoningProvenance: { provider: PROVIDER, model: "sonnet" }, runtimeOnly: { anchorPreserve: true } };
  assert.deepEqual(prepareRequest("sonnet", [msg]).messages[0]!.reasoning_details, []);
  assert.equal(prepareRequest("opus", [msg]).messages[0]!.reasoning_details, undefined);
  assert.equal(prepareRequest("sonnet", [{ ...msg, providerReasoningProvenance: { provider: "another", model: "sonnet" } }]).messages[0]!.reasoning_details, undefined);
  assert(!("runtimeOnly" in prepareRequest("sonnet", [msg]).messages[0]!));
});

test("complete usage and a single admitted upstream attempt are mandatory", () => {
  const data = native(); data.usage.native_admission.upstream_requests = 2;
  assert.throws(() => parseResponse(data, request, { tools }), /one upstream/);
  data.usage.native_admission.upstream_requests = 1; data.usage.prompt_tokens = NaN;
  assert.throws(() => parseResponse(data, request, { tools }), /token usage/);
});

test("unadvertised tools, duplicate calls, and malformed arguments cannot execute", () => {
  assert.throws(() => parseResponse(native(), request), /Unadvertised/);
  const data = native(); data.choices[0]!.message.tool_calls.push(data.choices[0]!.message.tool_calls[0]!);
  assert.throws(() => parseResponse(data, request, { tools }), /duplicate/);
  const bad = native(); bad.choices[0]!.message.tool_calls[0]!.function.arguments = "[]";
  assert.throws(() => parseResponse(bad, request, { tools }), /arguments/);
});

test("unsupported request controls fail before starting a subprocess", () => {
  assert.equal(prepareRequest("sonnet", messages, { parallelToolCalls: false }).parallel_tool_calls, false);
  assert.throws(() => prepareRequest("sonnet", messages, { toolChoice: "required" }), /Unsupported/);
  assert.throws(() => prepareRequest("sonnet", messages, { maxTurns: 2 }), /maxTurns/);
});

test("refusals and output cutoffs cannot release a tool call", () => {
  for (const stop_reason of ["max_tokens", "model_context_window_exceeded", "refusal"]) {
    const data = native();
    Object.assign(data.choices[0]!.message.reasoning_details[0]!, { messages: [{ stop_reason }] });
    assert.throws(() => parseResponse(data, request, { tools }), /normal tool completion/);
  }
  const refusal = native(false);
  Object.assign(refusal.choices[0]!.message.reasoning_details[0]!, { messages: [{ stop_reason: "refusal" }] });
  assert.equal(parseResponse(refusal, request).finishReason, "content_filter");
});

const dir = mkdtempSync(join(tmpdir(), "agenc-claude-adapter-test-"));
after(() => rmSync(dir, { recursive: true }));
const executable = join(dir, "fake-python");
writeFileSync(executable, `#!${process.execPath}
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  const request = JSON.parse(input); const mode = request.model;
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  console.log(JSON.stringify({type:'text',text:'ok'}));
  if (mode === 'truncate') return;
  const response = ${JSON.stringify(native(false))};
  console.log(JSON.stringify({type:'response',response}));
  if (mode === 'badexit') process.exitCode = 1;
});
`, { mode: 0o700 });

test("text streams, but completion waits for a successful bridge exit", async () => {
  const provider = new ClaudeSubscriptionProvider("sonnet", executable);
  const chunks: LLMStreamChunk[] = [];
  const result = await provider.chatStream(messages, c => chunks.push(c));
  assert.equal(result.content, "ok"); assert.equal(chunks[0]!.content, "ok");
  assert.equal(chunks.at(-1)!.done, true); provider.dispose();
});

test("truncated/failed subprocess output never publishes a completed tool batch", async () => {
  for (const model of ["truncate", "badexit"]) {
    const provider = new ClaudeSubscriptionProvider(model, executable);
    const chunks: LLMStreamChunk[] = [];
    await assert.rejects(provider.chatStream(messages, c => chunks.push(c)));
    assert(chunks.every(c => !c.done && !c.toolCalls)); provider.dispose();
  }
});

test("abort, deadline, disposal, and isolated forks stop owned requests", async () => {
  for (const mode of ["abort", "deadline", "dispose"]) {
    const provider = new ClaudeSubscriptionProvider("hang", executable);
    const controller = new AbortController();
    const call = provider.chat(messages, { signal: controller.signal, timeoutMs: mode === "deadline" ? 100 : 1000 });
    const timer = setTimeout(() => { if (mode === "abort") controller.abort(); if (mode === "dispose") provider.dispose(); }, 100);
    await assert.rejects(call, /cancelled|timed out/); clearTimeout(timer);
    const fork = provider.forkForSession(); provider.dispose();
    assert.equal((await fork.chat(messages, { model: "sonnet" })).content, "ok"); fork.dispose();
    await assert.rejects(provider.chat(messages), /closed/);
  }
});
