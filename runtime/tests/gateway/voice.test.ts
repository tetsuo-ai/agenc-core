import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { parseVoicePrompt, XaiVoiceFeature } from "../../src/gateway/voice.js";
import type { ChannelReplyOptions } from "../../src/gateway/types.js";

describe("parseVoicePrompt", () => {
  test("parses explicit voice and song routes", () => {
    expect(parseVoicePrompt("/voice say hello")).toMatchObject({
      text: "say hello",
      voiceId: "eve",
      song: false,
    });
    expect(parseVoicePrompt("/song@agenc_test_bot solana agents")).toMatchObject({
      text: "solana agents",
      song: true,
    });
    expect(parseVoicePrompt("voice: tell this with male voice")).toMatchObject({
      text: "tell this with male voice",
      voiceId: "leo",
      song: false,
    });
  });

  test("parses narrow natural-language audio requests only", () => {
    expect(parseVoicePrompt("make a short song for Solana agents")).toMatchObject({
      voiceId: "eve",
      song: true,
    });
    expect(parseVoicePrompt("say hello onchain with female voice")).toMatchObject({
      text: "hello onchain",
      voiceId: "eve",
      song: false,
    });
    expect(parseVoicePrompt("what is AgenC?")).toBeNull();
  });

  test("parses casual English and Spanish voice/song requests", () => {
    expect(
      parseVoicePrompt("generate a 10 second song with female voice about AgenC"),
    ).toMatchObject({
      voiceId: "eve",
      song: true,
    });
    expect(
      parseVoicePrompt("quiero una canción de 10 segundos con voz de mujer sobre Solana agents"),
    ).toMatchObject({
      voiceId: "eve",
      song: true,
    });
    expect(parseVoicePrompt("haz un audio con voz masculina diciendo hello AgenC")).toMatchObject({
      text: "hello AgenC",
      voiceId: "leo",
      song: false,
    });
    expect(parseVoicePrompt("di hello onchain con voz de hombre")).toMatchObject({
      text: "hello onchain",
      voiceId: "leo",
      song: false,
    });
    expect(parseVoicePrompt("tell me what a song is")).toBeNull();
  });
});

describe("XaiVoiceFeature", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-voice-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("generates an audio reply through the configured xAI TTS endpoint", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const audioBytes = new Uint8Array([1, 2, 3, 4]);
    const fakeFetch = (async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
      return {
        ok: true,
        arrayBuffer: async () => audioBytes.buffer.slice(0),
        headers: { get: () => "audio/mpeg" },
      } as Response;
    }) as unknown as typeof fetch;
    const replies: { text: string; options?: ChannelReplyOptions }[] = [];
    const feature = new XaiVoiceFeature({
      apiKey: "xai-test",
      usageFile: join(home, "usage.json"),
      dailyLimit: 1,
      fetchImpl: fakeFetch,
      now: () => Date.parse("2026-07-09T00:00:00Z"),
    });

    await expect(
      feature.handle({
        text: "/voice hello from AgenC",
        async reply(text, options) {
          replies.push({ text, ...(options !== undefined ? { options } : {}) });
          return `reply-${replies.length}`;
        },
      }),
    ).resolves.toBe(true);

    expect(calls[0].url).toBe("https://api.x.ai/v1/tts");
    expect(calls[0].body).toMatchObject({
      text: "hello from AgenC",
      voice_id: "eve",
      language: "auto",
      output_format: { codec: "mp3" },
    });
    expect(replies.at(-1)?.options).toMatchObject({
      audioBytes,
      audioContentType: "audio/mpeg",
      audioFileName: "agenc-voice.mp3",
      audioTitle: "AgenC voice",
      audioPerformer: "AgenC",
    });
  });

  test("enforces the local daily voice cap", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1]).buffer,
        headers: { get: () => "audio/mpeg" },
      }) as Response) as unknown as typeof fetch;
    const replies: string[] = [];
    const feature = new XaiVoiceFeature({
      apiKey: "xai-test",
      usageFile: join(home, "usage.json"),
      dailyLimit: 1,
      fetchImpl: fakeFetch,
      now: () => Date.parse("2026-07-09T00:00:00Z"),
    });
    const input = {
      text: "/voice one",
      async reply(text: string) {
        replies.push(text);
        return "ok";
      },
    };
    await feature.handle(input);
    await feature.handle({ ...input, text: "/voice two" });
    expect(replies.at(-1)).toContain("Voice cap hit");
  });
});
