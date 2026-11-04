import { describe, expect, it } from "vitest";

import { runOllamaWebSearch } from "../../../src/llm/providers/gateway-web-search.js";

const CHUNK_BYTES = 64 * 1024;
/** The response cap in postJson. */
const MAX_RESPONSE_BYTES = 4_000_000;

/** A body far over the cap that counts the chunks pulled from it and notes its cancel. */
function oversizedStream(totalBytes: number) {
  const chunk = new Uint8Array(CHUNK_BYTES).fill(0x20);
  const totalChunks = Math.ceil(totalBytes / CHUNK_BYTES);
  const state = { pulled: 0, totalChunks, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= totalChunks) {
        controller.close();
        return;
      }
      state.pulled += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

describe("gateway web search response limit", () => {
  it.each([200, 500])("stops reading an HTTP %i body once it passes the cap", async (status) => {
    const { body, state } = oversizedStream(MAX_RESPONSE_BYTES * 4);
    const fetchImpl = (async () => new Response(body, { status })) as typeof fetch;
    await expect(
      runOllamaWebSearch({ apiKey: "ollama-session", query: "q", maxResults: 3, fetchImpl }),
    ).resolves.toEqual({ kind: "failed", reason: "response too large", costUsd: undefined });
    expect(state.pulled).toBeLessThan(state.totalChunks);
    expect(state.pulled).toBeLessThanOrEqual(Math.ceil(MAX_RESPONSE_BYTES / CHUNK_BYTES) + 2);
    expect(state.cancelled).toBe(true);
  });
});
