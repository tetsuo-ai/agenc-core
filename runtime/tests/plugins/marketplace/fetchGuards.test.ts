import { describe, expect, it } from "vitest";
import type { Fetcher, FetchResponse } from "./marketplace.js";
import {
  assertHttpsOrLoopbackUrl,
  fetchWithTimeout,
  isLoopbackHostname,
  readResponseTextWithLimit,
} from "./fetchGuards.js";

describe("marketplace fetch guards", () => {
  it("cancels streamed responses when a size limit is exceeded", async () => {
    let cancelled = false;
    const response: Pick<FetchResponse, "body" | "arrayBuffer"> = {
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(8));
        },
        cancel() {
          cancelled = true;
        },
      }),
      arrayBuffer: async () => new ArrayBuffer(0),
    };

    await expect(readResponseTextWithLimit(response, 4, "guarded body"))
      .rejects.toThrow("exceeded maximum size");
    expect(cancelled).toBe(true);
  });

  it("aborts fetches that exceed the timeout", async () => {
    const fetcher: Fetcher = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });

    await expect(fetchWithTimeout(
      fetcher,
      "https://agenc.tech/plugins.json",
      {},
      { timeoutMs: 1, label: "slow marketplace fetch" },
    )).rejects.toThrow("slow marketplace fetch timed out after 1ms");
  });

  it("accepts bracketed IPv6 loopback hosts when loopback HTTP is explicitly allowed", () => {
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(assertHttpsOrLoopbackUrl(
      "http://[::1]/marketplace.json",
      "marketplace URL",
      { allowLoopbackHttp: true },
    ).hostname).toBe("[::1]");
  });
});
