import { describe, expect, test, vi } from "vitest";
import type { LLMStreamChunk } from "../../types.js";
import { AnthropicProvider } from "./adapter.js";

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const messageStart =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-3-7-sonnet","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n';
const messageStop = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const messageDeltaToolUse =
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":1}}\n\n';

async function runStream(frames: string[]): Promise<LLMStreamChunk[]> {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse(frames));
  const provider = new AnthropicProvider({
    apiKey: "anthropic-test",
    model: "claude-3-7-sonnet",
    fetchImpl,
  });
  const chunks: LLMStreamChunk[] = [];
  await provider.chatStream(
    [{ role: "user", content: "go" }],
    (chunk) => chunks.push(chunk),
  );
  return chunks;
}

describe("R6 Anthropic adapter forwards input_json_delta as toolInputBlockStart + toolInputDelta chunks", () => {
  test("E6.1 a content_block_start with content_block.type !== 'tool_use' does NOT emit toolInputBlockStart", async () => {
    const chunks = await runStream([
      messageStart,
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      messageStop,
    ]);
    expect(chunks.some((c) => c.toolInputBlockStart)).toBe(false);
    expect(chunks.some((c) => c.toolInputDelta)).toBe(false);
    expect(chunks.find((c) => c.content === "hi")).toBeDefined();
  });

  test("E6.2 a content_block_start with index missing/negative does NOT emit toolInputBlockStart (only valid >=0 indices reach the bridge)", async () => {
    const chunks = await runStream([
      messageStart,
      // Anthropic should always send index, but if we ever see a malformed
      // event without it, the adapter sentinel is -1 and we must not forward.
      'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_x","name":"X","input":{}}}\n\n',
      messageStop,
    ]);
    expect(chunks.some((c) => c.toolInputBlockStart)).toBe(false);
  });

  test("E6.3 an input_json_delta with non-string partial_json is dropped at the adapter; no toolInputDelta is emitted", async () => {
    const chunks = await runStream([
      messageStart,
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"X","input":{}}}\n\n',
      // partial_json is a number, not a string — must be ignored
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":42}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      messageDeltaToolUse,
      messageStop,
    ]);
    expect(chunks.some((c) => c.toolInputDelta)).toBe(false);
    // The block_start chunk must still be emitted
    expect(chunks.some((c) => c.toolInputBlockStart?.callId === "toolu_1")).toBe(true);
  });

  test("E6.4 multiple input_json_delta events in succession all forward in arrival order with their partial_json contents preserved", async () => {
    const chunks = await runStream([
      messageStart,
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"X","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"k\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"1,"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"v\\":2}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      messageDeltaToolUse,
      messageStop,
    ]);
    const deltas = chunks
      .map((c) => c.toolInputDelta)
      .filter((d): d is NonNullable<typeof d> => Boolean(d));
    expect(deltas).toHaveLength(3);
    expect(deltas.map((d) => d.partialJson)).toEqual([
      '{"k":',
      "1,",
      '"v":2}',
    ]);
    expect(deltas.every((d) => d.callId === "toolu_1")).toBe(true);
    expect(deltas.every((d) => d.index === 0)).toBe(true);
  });

  test("E6.5 two concurrent tool_use blocks at distinct indices each emit their own toolInputBlockStart and their own toolInputDelta chunks without interleaving payloads", async () => {
    const chunks = await runStream([
      messageStart,
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_a","name":"A","input":{}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_b","name":"B","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":\\"piece\\"}"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"b\\":\\"piece\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      messageDeltaToolUse,
      messageStop,
    ]);
    const starts = chunks
      .map((c) => c.toolInputBlockStart)
      .filter((s): s is NonNullable<typeof s> => Boolean(s));
    expect(starts.map((s) => ({ callId: s.callId, index: s.index }))).toEqual([
      { callId: "toolu_a", index: 0 },
      { callId: "toolu_b", index: 1 },
    ]);
    const deltas = chunks
      .map((c) => c.toolInputDelta)
      .filter((d): d is NonNullable<typeof d> => Boolean(d));
    expect(deltas.map((d) => ({ callId: d.callId, index: d.index, partialJson: d.partialJson }))).toEqual([
      { callId: "toolu_a", index: 0, partialJson: '{"a":"piece"}' },
      { callId: "toolu_b", index: 1, partialJson: '{"b":"piece"}' },
    ]);
  });

  test("E6.6 a consumer that ignores chunk.toolInputBlockStart and chunk.toolInputDelta still receives the existing completed-tool-call chunk at content_block_stop (backward-compatibility)", async () => {
    const chunks = await runStream([
      messageStart,
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"X","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"k\\":1}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      messageDeltaToolUse,
      messageStop,
    ]);
    const ignoringConsumerChunks = chunks
      .filter((c) => !c.toolInputBlockStart && !c.toolInputDelta)
      .filter((c) => c.toolCalls && c.toolCalls.length > 0);
    expect(ignoringConsumerChunks.length).toBeGreaterThan(0);
    expect(ignoringConsumerChunks[0]?.toolCalls?.[0]).toEqual({
      id: "toolu_1",
      name: "X",
      arguments: '{"k":1}',
    });
  });

  test("B6.2 toolInputBlockStart fires BEFORE the first toolInputDelta for the same block", async () => {
    const chunks = await runStream([
      messageStart,
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"X","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"abc\\":true}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      messageDeltaToolUse,
      messageStop,
    ]);
    const startIdx = chunks.findIndex((c) => c.toolInputBlockStart?.callId === "toolu_1");
    const deltaIdx = chunks.findIndex((c) => c.toolInputDelta?.callId === "toolu_1");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(deltaIdx).toBeGreaterThan(startIdx);
  });

  test("B6.5 the existing onChunk text-delta path is unaffected when tool_use blocks are interleaved with text", async () => {
    const chunks = await runStream([
      messageStart,
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"X","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      messageDeltaToolUse,
      messageStop,
    ]);
    const textChunks = chunks.filter((c) => c.content === "hello " || c.content === "world");
    expect(textChunks).toHaveLength(2);
    // The text chunks must NOT carry the new streaming-tool-use fields.
    expect(textChunks.every((c) => !c.toolInputBlockStart && !c.toolInputDelta)).toBe(true);
  });
});
