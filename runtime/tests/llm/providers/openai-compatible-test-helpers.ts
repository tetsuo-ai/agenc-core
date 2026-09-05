import { vi } from "vitest";

import type { LLMTool } from "../types.js";

export const ECHO_TOOL: LLMTool = {
  type: "function",
  function: {
    name: "system.echo",
    description: "Echo text.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
};

export const ONE_PIXEL_PNG =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export function createSuccessfulChatResponse(responseId: string) {
  return (
    model: string,
    content = "ok",
    extraMessage: Record<string, unknown> = {},
    finishReason = "stop",
  ): Response =>
    new Response(JSON.stringify({
      id: responseId,
      model,
      choices: [{
        finish_reason: finishReason,
        message: { role: "assistant", content, ...extraMessage },
      }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }), { headers: { "content-type": "application/json" } });
}

export function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  const chunks = frames.map((frame) => encoder.encode(frame));
  let next = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[next++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

export function bodyAt(
  fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>,
  index = 0,
): Record<string, unknown> {
  return JSON.parse(String(fetchImpl.mock.calls[index]?.[1]?.body)) as Record<
    string,
    unknown
  >;
}
