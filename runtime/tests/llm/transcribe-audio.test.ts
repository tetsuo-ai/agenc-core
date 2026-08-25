import { describe, expect, test, vi } from "vitest";

import {
  audioMediaTypeFor,
  transcribeAudio,
  TranscriptionUnavailableError,
} from "../../src/llm/transcribe-audio.js";

const BYTES = new Uint8Array([1, 2, 3, 4]);

function okResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

describe("transcribing a recording", () => {
  test("posts the file to an OpenAI-compatible endpoint", async () => {
    const fetchImpl = vi.fn(async () => okResponse("  hello there  "));
    const result = await transcribeAudio({
      bytes: BYTES,
      filename: "voice.webm",
      mimeType: "audio/webm",
      env: { OPENAI_API_KEY: "k" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.text).toBe("hello there");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer k",
    );
    const form = init.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("response_format")).toBe("text");
    expect((form.get("file") as File).name).toBe("voice.webm");
  });

  test("says what to set when there is no key", async () => {
    // The whole point of this path is to stop the agent hunting the machine
    // for a transcriber, so the failure has to name the fix.
    await expect(
      transcribeAudio({
        bytes: BYTES,
        filename: "voice.webm",
        mimeType: "audio/webm",
        env: {},
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });

  test("carries the endpoint's own reason", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("model not found", { status: 404 }),
    );
    await expect(
      transcribeAudio({
        bytes: BYTES,
        filename: "voice.webm",
        mimeType: "audio/webm",
        env: { OPENAI_API_KEY: "k" },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/404.*model not found/s);
  });

  test("a silent recording is not an empty answer", async () => {
    const fetchImpl = vi.fn(async () => okResponse("   "));
    await expect(
      transcribeAudio({
        bytes: BYTES,
        filename: "voice.webm",
        mimeType: "audio/webm",
        env: { OPENAI_API_KEY: "k" },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(TranscriptionUnavailableError);
  });

  test("honours a redirected base url and model", async () => {
    const fetchImpl = vi.fn(async () => okResponse("ok"));
    await transcribeAudio({
      bytes: BYTES,
      filename: "voice.wav",
      mimeType: "audio/wav",
      env: {
        OPENAI_API_KEY: "k",
        AGENC_TRANSCRIBE_BASE_URL: "http://127.0.0.1:9099/v1/",
        AGENC_TRANSCRIBE_MODEL: "whisper-1",
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://127.0.0.1:9099/v1/audio/transcriptions");
    expect((init.body as FormData).get("model")).toBe("whisper-1");
  });

  test("knows the extensions a recording arrives as", () => {
    expect(audioMediaTypeFor(".webm")).toBe("audio/webm");
    expect(audioMediaTypeFor(".M4A")).toBe("audio/mp4");
    expect(audioMediaTypeFor(".png")).toBeUndefined();
  });
});
