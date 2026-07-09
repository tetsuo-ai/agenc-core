import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { parseMemePrompt, XaiMemeFeature } from "../../src/gateway/meme.js";

describe("parseMemePrompt", () => {
  test("parses slash and label forms", () => {
    expect(parseMemePrompt("/meme agent economy")).toBe("agent economy");
    expect(parseMemePrompt("/meme@agenc_test_bot agent economy")).toBe(
      "agent economy",
    );
    expect(parseMemePrompt("/image agent economy")).toBe("agent economy");
    expect(parseMemePrompt("/image@agenc_test_bot agent economy")).toBe(
      "agent economy",
    );
    expect(parseMemePrompt("meme: solana agents getting paid")).toBe(
      "solana agents getting paid",
    );
    expect(parseMemePrompt("image: solana agents getting paid")).toBe(
      "solana agents getting paid",
    );
    expect(parseMemePrompt("tell me about agenc")).toBeNull();
  });

  test("parses clear natural-language image requests", () => {
    expect(parseMemePrompt("make an image of agents settling on Solana")).toBe(
      "agents settling on Solana",
    );
    expect(parseMemePrompt("can you generate a 16:9 poster about AgenC")).toBe(
      "AgenC",
    );
    expect(parseMemePrompt("haz una imagen de agentes cobrando onchain")).toBe(
      "agentes cobrando onchain",
    );
    expect(parseMemePrompt("quiero un meme sobre wallets con policies")).toBe(
      "wallets con policies",
    );
    expect(parseMemePrompt("explain this image")).toBeNull();
    expect(parseMemePrompt("what is image generation?")).toBeNull();
  });
});

describe("XaiMemeFeature", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-meme-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("generates a photo reply through the configured xAI endpoint", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fakeFetch = (async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
      return {
        ok: true,
        json: async () => ({ data: [{ url: "https://img.example/meme.png" }] }),
      } as Response;
    }) as unknown as typeof fetch;
    const replies: { text: string; photoUrl?: string; caption?: string }[] = [];
    const feature = new XaiMemeFeature({
      apiKey: "xai-test",
      usageFile: join(home, "usage.json"),
      dailyLimit: 1,
      fetchImpl: fakeFetch,
      now: () => Date.parse("2026-07-09T00:00:00Z"),
    });

    await expect(
      feature.handle({
        text: "/meme autonomous agents paid onchain",
        async reply(text, options) {
          replies.push({ text, ...options });
          return `reply-${replies.length}`;
        },
      }),
    ).resolves.toBe(true);

    expect(calls[0].url).toBe("https://api.x.ai/v1/images/generations");
    expect(calls[0].body).toMatchObject({ model: "grok-imagine-image", n: 1 });
    expect(replies.at(-1)).toMatchObject({
      photoUrl: "https://img.example/meme.png",
      caption: "AgenC image: autonomous agents paid onchain",
    });
  });

  test("enforces the local daily image cap", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({ data: [{ url: "https://img.example/meme.png" }] }),
      }) as Response) as unknown as typeof fetch;
    const replies: string[] = [];
    const feature = new XaiMemeFeature({
      apiKey: "xai-test",
      usageFile: join(home, "usage.json"),
      dailyLimit: 1,
      fetchImpl: fakeFetch,
      now: () => Date.parse("2026-07-09T00:00:00Z"),
    });
    const input = {
      text: "/meme one",
      async reply(text: string) {
        replies.push(text);
        return "ok";
      },
    };
    await feature.handle(input);
    await feature.handle({ ...input, text: "/meme two" });
    expect(replies.at(-1)).toContain("Meme cap hit");
  });
});
