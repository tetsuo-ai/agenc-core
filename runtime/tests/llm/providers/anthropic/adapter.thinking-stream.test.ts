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
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4-7","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n';
const messageStop = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const messageDelta =
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":12}}\n\n';

async function runStream(frames: string[]): Promise<{
  chunks: LLMStreamChunk[];
  response: Awaited<ReturnType<AnthropicProvider["chatStream"]>>;
}> {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse(frames));
  const provider = new AnthropicProvider({
    apiKey: "anthropic-test",
    model: "claude-opus-4-7",
    fetchImpl,
  });
  const chunks: LLMStreamChunk[] = [];
  const response = await provider.chatStream(
    [{ role: "user", content: "think please" }],
    (chunk) => chunks.push(chunk),
  );
  return { chunks, response };
}

describe("messages-API adapter forwards extended-thinking SSE events", () => {
  test("text-only stream emits no thinking events (regression guard)", async () => {
    const { chunks } = await runStream([
      messageStart,
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      messageDelta,
      messageStop,
    ]);
    expect(chunks.some((c) => c.thinkingBlockStart)).toBe(false);
    expect(chunks.some((c) => c.thinkingDelta)).toBe(false);
    expect(chunks.some((c) => c.thinkingBlockStop)).toBe(false);
  });

  test("thinking_delta forwards as thinkingDelta with same index, then thinkingBlockStop on content_block_stop", async () => {
    const { chunks, response } = await runStream([
      messageStart,
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"think."}}\n\n',
      // signature deltas are consumed silently — never forwarded as deltas
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"ABCDEF=="}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Answer."}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      messageDelta,
      messageStop,
    ]);

    const blockStarts = chunks.filter((c) => c.thinkingBlockStart);
    const deltas = chunks.filter((c) => c.thinkingDelta);
    const blockStops = chunks.filter((c) => c.thinkingBlockStop);

    expect(blockStarts).toHaveLength(1);
    expect(blockStarts[0]!.thinkingBlockStart).toEqual({
      index: 0,
      redacted: false,
    });

    expect(deltas).toHaveLength(2);
    expect(deltas[0]!.thinkingDelta).toEqual({ delta: "Let me ", index: 0 });
    expect(deltas[1]!.thinkingDelta).toEqual({ delta: "think.", index: 0 });

    expect(blockStops).toHaveLength(1);
    expect(blockStops[0]!.thinkingBlockStop).toEqual({ index: 0 });

    // signature_delta did NOT produce a delta chunk
    expect(chunks.find((c) => c.thinkingDelta?.delta?.includes("ABCDEF"))).toBeUndefined();

    // Final response carries the thinking block + its signature
    expect(response.thinking).toBeDefined();
    expect(response.thinking).toHaveLength(1);
    expect(response.thinking?.[0]).toMatchObject({
      text: "Let me think.",
      redacted: false,
      signature: "ABCDEF==",
    });

    // Visible content unaffected
    expect(response.content).toBe("Answer.");
  });

  test("redacted_thinking emits start + stop but no deltas", async () => {
    const { chunks, response } = await runStream([
      messageStart,
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"OPAQUEBYTES"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ok"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      messageDelta,
      messageStop,
    ]);

    const start = chunks.find((c) => c.thinkingBlockStart);
    expect(start?.thinkingBlockStart).toEqual({ index: 0, redacted: true });
    expect(chunks.some((c) => c.thinkingDelta)).toBe(false);
    expect(chunks.some((c) => c.thinkingBlockStop?.index === 0)).toBe(true);

    // Final response preserves the redacted block opaquely
    expect(response.thinking?.[0]).toMatchObject({
      redacted: true,
      text: "OPAQUEBYTES",
    });
  });

  test("thinking + tool_use + text in one turn produces three independent block lifecycles", async () => {
    const { chunks, response } = await runStream([
      messageStart,
      // Thinking block at index 0
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan."}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      // Tool use block at index 1
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"Read","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/x\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      // Text block at index 2
      'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"done"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":3}}\n\n',
      messageStop,
    ]);

    expect(chunks.filter((c) => c.thinkingBlockStart)).toHaveLength(1);
    expect(chunks.filter((c) => c.thinkingBlockStop)).toHaveLength(1);
    expect(chunks.filter((c) => c.toolInputBlockStart)).toHaveLength(1);
    expect(chunks.filter((c) => c.toolInputDelta)).toHaveLength(1);

    expect(response.thinking?.[0]?.text).toBe("Plan.");
    expect(response.toolCalls.map((c) => c.name)).toEqual(["Read"]);
    expect(response.content).toBe("done");
  });
});
