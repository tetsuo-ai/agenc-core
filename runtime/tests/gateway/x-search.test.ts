import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  parseXSearchIntent,
  XaiXSearchFeature,
} from "../../src/gateway/x-search.js";

function xaiResponse(options: {
  readonly text?: string;
  readonly url?: string;
  readonly status?: number;
} = {}): Response {
  const text =
    options.text ??
    "Latest post at 2026-07-09T18:00:00Z.[[1]](https://x.com/example/status/123)";
  const url = options.url ?? "https://x.com/example/status/123";
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "custom_tool_call",
          name: "x_user_search",
          status: "completed",
        },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text,
              annotations: url === "" ? [] : [{ type: "url_citation", url }],
            },
          ],
        },
      ],
    }),
    {
      status: options.status ?? 200,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("parseXSearchIntent", () => {
  test.each([
    "what is the latest post from @xai?",
    "dime el último comentario de @xai",
    "what are people saying about AgenC on X?",
    "read https://x.com/xai/status/123",
    "/x latest thread from @xai",
    "what did @xai post today?",
  ])("recognizes read-only X research: %s", (input) => {
    expect(parseXSearchIntent(input)).not.toBeNull();
  });

  test.each([
    "post a task on AgenC",
    "write a product launch post",
    "what is the latest Solana block?",
    "comment this TypeScript function",
  ])("does not steal unrelated prompts: %s", (input) => {
    expect(parseXSearchIntent(input)).toBeNull();
  });

  test("extracts and deduplicates exact handles for allowed_x_handles", () => {
    expect(
      parseXSearchIntent("latest posts from @XAI and https://x.com/xai/status/123")
        ?.handles,
    ).toEqual(["xai"]);
  });
});

describe("XaiXSearchFeature", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-x-search-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("uses only x_search, constrains handles, and returns cited X data", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init !== undefined ? { init } : {}) });
      return xaiResponse({
        text:
          "Latest from @example.[[1]](https://x.com/example/status/123) " +
          "Unverified https://x.com/example/status/999",
      });
    });
    const replies: string[] = [];
    const feature = new XaiXSearchFeature({
      apiKey: "xai-test-key-that-is-long-enough",
      usageFile: join(home, "usage.json"),
      fetchImpl: fetchImpl as typeof fetch,
      now: () => Date.parse("2026-07-09T20:00:00Z"),
    });

    const handled = await feature.handle({
      text: "what is the latest post from @example?",
      channelId: "telegram",
      peerId: "alice",
      reply: async (text) => {
        replies.push(text);
        return "out-1";
      },
    });

    expect(handled).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.x.ai/v1/responses");
    expect(calls[0]?.init?.redirect).toBe("error");
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      tools: readonly Record<string, unknown>[];
      input: readonly { role: string; content: string }[];
      max_turns?: number;
      store?: boolean;
    };
    expect(body.tools).toEqual([
      { type: "x_search", allowed_x_handles: ["example"] },
    ]);
    expect(JSON.stringify(body.tools)).not.toMatch(/post|like|follow|delete/i);
    expect(body.max_turns).toBe(2);
    expect(body.store).toBe(false);
    expect(body.input).toHaveLength(2);
    expect(body.input[0]?.role).toBe("system");
    expect(body.input[0]?.content).toContain("read-only X research function");
    expect(body.input[0]?.content).toContain("untrusted data");
    expect(body.input[0]?.content).not.toContain("latest post from @example");
    expect(body.input[1]?.role).toBe("user");
    expect(body.input[1]?.content).toContain("latest post from @example");
    expect(replies[0]).toContain("https://x.com/example/status/123");
    expect(replies[0]).not.toContain("https://x.com/example/status/999");
    expect(JSON.parse(readFileSync(join(home, "usage.json"), "utf8"))).toEqual({
      day: "2026-07-09",
      count: 1,
    });
  });

  test("refuses uncited model output instead of presenting it as fact", async () => {
    const feature = new XaiXSearchFeature({
      apiKey: "xai-test-key-that-is-long-enough",
      usageFile: join(home, "usage.json"),
      fetchImpl: (async () =>
        xaiResponse({
          text: "The latest post says something, trust me.",
          url: "",
        })) as typeof fetch,
    });
    const replies: string[] = [];

    await feature.handle({
      text: "latest post from @example",
      channelId: "telegram",
      peerId: "alice",
      reply: async (text) => {
        replies.push(text);
        return "out-1";
      },
    });

    expect(replies).toEqual([
      "I could not verify that X result with a direct public source, so I will not guess. Check the handle and try again.",
    ]);
  });

  test("requires proof that an allowed server-side x_search tool actually ran", async () => {
    const replies: string[] = [];
    const feature = new XaiXSearchFeature({
      apiKey: "xai-test-key-that-is-long-enough",
      usageFile: join(home, "usage.json"),
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "Plausible but unsearched result",
                    annotations: [
                      {
                        type: "url_citation",
                        url: "https://x.com/example/status/123",
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        )) as typeof fetch,
    });

    await feature.handle({
      text: "latest post from @example",
      channelId: "telegram",
      peerId: "alice",
      reply: async (text) => {
        replies.push(text);
        return "out-1";
      },
    });

    expect(replies).toEqual([
      "I could not verify that X result with a direct public source, so I will not guess. Check the handle and try again.",
    ]);
  });

  test("accepts the documented x_search_call response shape", async () => {
    const replies: string[] = [];
    const feature = new XaiXSearchFeature({
      apiKey: "xai-test-key-that-is-long-enough",
      usageFile: join(home, "usage.json"),
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            status: "completed",
            output: [
              { type: "x_search_call", status: "completed" },
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "Verified result",
                    annotations: [
                      {
                        type: "url_citation",
                        url: "https://x.com/example/status/123",
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        )) as typeof fetch,
    });

    await feature.handle({
      text: "latest post from @example",
      channelId: "telegram",
      peerId: "alice",
      reply: async (text) => {
        replies.push(text);
        return "out-1";
      },
    });

    expect(replies[0]).toContain("Verified result");
    expect(replies[0]).toContain("https://x.com/example/status/123");
  });

  test("rejects unrelated custom tools even when their output carries an X citation", async () => {
    const replies: string[] = [];
    const feature = new XaiXSearchFeature({
      apiKey: "xai-test-key-that-is-long-enough",
      usageFile: join(home, "usage.json"),
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "custom_tool_call",
                name: "code_execution",
                status: "completed",
              },
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "Untrusted tool result",
                    annotations: [
                      {
                        type: "url_citation",
                        url: "https://x.com/example/status/123",
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        )) as typeof fetch,
    });

    await feature.handle({
      text: "latest post from @example",
      channelId: "telegram",
      peerId: "alice",
      reply: async (text) => {
        replies.push(text);
        return "out-1";
      },
    });

    expect(replies).toEqual([
      "I could not verify that X result with a direct public source, so I will not guess. Check the handle and try again.",
    ]);
  });

  test("fails closed when xAI does not report a completed response", async () => {
    const replies: string[] = [];
    const feature = new XaiXSearchFeature({
      apiKey: "xai-test-key-that-is-long-enough",
      usageFile: join(home, "usage.json"),
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            status: "in_progress",
            output: [
              {
                type: "custom_tool_call",
                name: "x_keyword_search",
                status: "completed",
              },
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "Incomplete result",
                    annotations: [
                      {
                        type: "url_citation",
                        url: "https://x.com/example/status/123",
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        )) as typeof fetch,
    });

    await feature.handle({
      text: "latest post from @example",
      channelId: "telegram",
      peerId: "alice",
      reply: async (text) => {
        replies.push(text);
        return "out-1";
      },
    });

    expect(replies).toEqual([
      "I could not complete that read-only X search safely. Check the handle and try again.",
    ]);
  });

  test("does not invoke xAI for unrelated messages", async () => {
    const fetchImpl = vi.fn();
    const feature = new XaiXSearchFeature({
      apiKey: "xai-test-key-that-is-long-enough",
      usageFile: join(home, "usage.json"),
      fetchImpl: fetchImpl as typeof fetch,
    });

    const handled = await feature.handle({
      text: "create an AgenC marketplace task",
      channelId: "telegram",
      peerId: "alice",
      reply: async () => "out-1",
    });

    expect(handled).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("enforces per-peer and daily request caps", async () => {
    const fetchImpl = vi.fn(async () => xaiResponse());
    const replies: string[] = [];
    const feature = new XaiXSearchFeature({
      apiKey: "xai-test-key-that-is-long-enough",
      usageFile: join(home, "usage.json"),
      fetchImpl: fetchImpl as typeof fetch,
      perPeerLimit: 1,
      dailyLimit: 2,
      cacheTtlMs: 0,
      now: () => Date.parse("2026-07-09T20:00:00Z"),
    });
    const ask = async (peerId: string, text: string) =>
      feature.handle({
        text,
        channelId: "telegram",
        peerId,
        reply: async (reply) => {
          replies.push(reply);
          return "out";
        },
      });

    await ask("alice", "latest post from @example");
    await ask("alice", "latest reply from @example");
    await ask("bob", "latest post from @another");
    await ask("carol", "latest post from @third");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(replies.some((reply) => reply.includes("Too many live X reads"))).toBe(true);
    expect(replies.some((reply) => reply.includes("budget is full"))).toBe(true);
  });

  test("redacts provider errors", async () => {
    const logs: string[] = [];
    const replies: string[] = [];
    const feature = new XaiXSearchFeature({
      apiKey: "xai-test-key-that-is-long-enough",
      usageFile: join(home, "usage.json"),
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ error: { message: "account secret and billing detail" } }),
          { status: 401 },
        )) as typeof fetch,
      log: (line) => logs.push(line),
    });

    await feature.handle({
      text: "latest post from @example",
      channelId: "telegram",
      peerId: "alice",
      reply: async (text) => {
        replies.push(text);
        return "out";
      },
    });

    expect(replies[0]).toContain("server-side credential needs attention");
    expect(replies.join("\n")).not.toContain("account secret");
    expect(logs).toEqual([
      "gateway x-search: read failed (authentication_failed, status=401)",
    ]);
  });

  test("reports a bounded timeout separately from other upstream failures", async () => {
    const logs: string[] = [];
    const replies: string[] = [];
    const feature = new XaiXSearchFeature({
      apiKey: "xai-test-key-that-is-long-enough",
      usageFile: join(home, "usage.json"),
      timeoutMs: 5,
      fetchImpl: ((_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        })) as typeof fetch,
      log: (line) => logs.push(line),
    });

    await feature.handle({
      text: "latest post from @example",
      channelId: "telegram",
      peerId: "alice",
      reply: async (text) => {
        replies.push(text);
        return "out";
      },
    });

    expect(replies).toEqual([
      "X search took longer than the bounded server wait, so no result was returned. Try the same question again.",
    ]);
    expect(logs).toEqual(["gateway x-search: read failed (timeout)"]);
  });

  test.each([
    [429, "rate-limited upstream", "rate_limited"],
    [503, "temporarily unavailable at xAI", "upstream_unavailable"],
  ])(
    "reports HTTP %i with a specific safe message",
    async (status, expectedReply, expectedCode) => {
      const logs: string[] = [];
      const replies: string[] = [];
      const feature = new XaiXSearchFeature({
        apiKey: "xai-test-key-that-is-long-enough",
        usageFile: join(home, "usage.json"),
        maxAttempts: 1,
        fetchImpl: (async () =>
          new Response("provider detail must stay private", { status })) as typeof fetch,
        log: (line) => logs.push(line),
      });

      await feature.handle({
        text: "latest post from @example",
        channelId: "telegram",
        peerId: "alice",
        reply: async (text) => {
          replies.push(text);
          return "out";
        },
      });

      expect(replies[0]).toContain(expectedReply);
      expect(replies[0]).not.toContain("provider detail");
      expect(logs).toEqual([
        `gateway x-search: read failed (${expectedCode}, status=${status})`,
      ]);
    },
  );

  test("retries one transient xAI failure and returns the cited result", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(xaiResponse());
    const sleep = vi.fn(async () => {});
    const logs: string[] = [];
    const replies: string[] = [];
    const feature = new XaiXSearchFeature({
      apiKey: "xai-test-key-that-is-long-enough",
      usageFile: join(home, "usage.json"),
      fetchImpl,
      sleep,
      log: (line) => logs.push(line),
    });

    await feature.handle({
      text: "latest post from @example",
      channelId: "telegram",
      peerId: "alice",
      reply: async (text) => {
        replies.push(text);
        return "out";
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(750);
    expect(replies[0]).toContain("https://x.com/example/status/123");
    expect(logs).toEqual([]);
  });

  test("does not retry a long provider rate-limit delay", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "30" },
      }),
    );
    const sleep = vi.fn(async () => {});
    const replies: string[] = [];
    const feature = new XaiXSearchFeature({
      apiKey: "xai-test-key-that-is-long-enough",
      usageFile: join(home, "usage.json"),
      fetchImpl: fetchImpl as typeof fetch,
      sleep,
    });

    await feature.handle({
      text: "latest post from @example",
      channelId: "telegram",
      peerId: "alice",
      reply: async (text) => {
        replies.push(text);
        return "out";
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(replies[0]).toContain("rate-limited upstream");
  });
});
