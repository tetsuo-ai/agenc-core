import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  audioMediaTypeFor,
  resolveExistingWhisperModel,
  transcribeWithLocalAudio,
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
    expect(result.provider).toBe("openai");
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
    expect(init.signal).toBeInstanceOf(AbortSignal);
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
        localTranscriber: async () => {
          throw new TranscriptionUnavailableError(
            "No transcription credentials or local stack. Set OPENAI_API_KEY or GEMINI_API_KEY.",
          );
        },
      }),
    ).rejects.toThrow(/OPENAI_API_KEY or GEMINI_API_KEY/);
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
    ).rejects.toThrow(/404/);
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

  test("falls to Gemini when that is the key present", async () => {
    // A ChatGPT subscription login leaves no OPENAI_API_KEY behind, so for
    // most sessions here Gemini is the only credential that can do this.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "spoken words" }] } }],
          }),
          { status: 200 },
        ),
    );
    const result = await transcribeAudio({
      bytes: BYTES,
      filename: "voice.webm",
      mimeType: "audio/webm",
      env: { GEMINI_API_KEY: "g" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.text).toBe("spoken words");
    expect(result.provider).toBe("gemini");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("gemini-3.5-flash:generateContent");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g");
    const body = JSON.parse(init.body as string) as {
      contents: { parts: { inlineData?: { mimeType: string } }[] }[];
    };
    expect(body.contents[0]?.parts[1]?.inlineData?.mimeType).toBe("audio/webm");
  });

  test("prefers an OpenAI key over Gemini when both are set", async () => {
    const fetchImpl = vi.fn(async () => okResponse("from openai"));
    await transcribeAudio({
      bytes: BYTES,
      filename: "voice.webm",
      mimeType: "audio/webm",
      env: { OPENAI_API_KEY: "k", GEMINI_API_KEY: "g" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("/audio/transcriptions");
  });

  test("uses an injected local fallback when no cloud key is present", async () => {
    const localTranscriber = vi.fn(async () => ({
      text: "offline words",
      model: "ggml-small.bin",
      provider: "local" as const,
    }));
    const fetchImpl = vi.fn();
    const result = await transcribeAudio({
      bytes: BYTES,
      filename: "voice.webm",
      mimeType: "audio/webm",
      env: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      localTranscriber,
    });

    expect(result).toEqual({
      text: "offline words",
      model: "ggml-small.bin",
      provider: "local",
    });
    expect(localTranscriber).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("local WebM fallback converts then invokes whisper with bounded args", async () => {
    const runProcess = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        forced: false,
        backstopExpired: false,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        stdout: Buffer.from("  local transcript  \n"),
        stderr: Buffer.alloc(0),
        forced: false,
        backstopExpired: false,
      });
    const result = await transcribeWithLocalAudio(
      {
        bytes: BYTES,
        filename: "voice.webm",
        mimeType: "audio/webm",
        env: {},
      },
      {
        resolveExecutable: async (name) => `/fake/${name}`,
        resolveModel: async () => "/fake/models/ggml-small.bin",
        runProcess,
        fileSize: async () => 1024,
      },
    );

    expect(result).toEqual({
      text: "local transcript",
      model: "ggml-small.bin",
      provider: "local",
    });
    expect(runProcess).toHaveBeenCalledTimes(2);
    expect(runProcess.mock.calls[0]?.[0]).toMatchObject({
      program: "/fake/ffmpeg",
      args: expect.arrayContaining([
        "-t",
        "600",
        "-ac",
        "1",
        "-ar",
        "16000",
      ]),
    });
    expect(runProcess.mock.calls[1]?.[0]).toMatchObject({
      program: "/fake/whisper-cli",
      args: expect.arrayContaining([
        "-m",
        "/fake/models/ggml-small.bin",
        "-l",
        "auto",
        "-nt",
        "-np",
      ]),
    });
  });

  test("rejects a converted WAV that reaches the 10-minute cap before whisper", async () => {
    const runProcess = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      forced: false,
      backstopExpired: false,
    });

    await expect(
      transcribeWithLocalAudio(
        {
          bytes: BYTES,
          filename: "voice.webm",
          mimeType: "audio/webm",
          env: {},
        },
        {
          resolveExecutable: async (name) => `/fake/${name}`,
          resolveModel: async () => "/fake/models/ggml-small.bin",
          runProcess,
          fileSize: async () => 600 * 16_000 * 2,
        },
      ),
    ).rejects.toThrow(/recording exceeds the 10-minute local transcription limit/i);

    expect(runProcess).toHaveBeenCalledOnce();
    expect(runProcess.mock.calls[0]?.[0]).toMatchObject({
      program: "/fake/ffmpeg",
      args: expect.arrayContaining(["-t", "600"]),
    });
  });

  test("prefers an AgenC-owned multilingual model over a smaller English-only model", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-whisper-models-"));
    const models = join(home, "models", "whisper");
    await mkdir(models, { recursive: true });
    await Promise.all([
      writeFile(join(models, "ggml-small.en.bin"), "english-only"),
      writeFile(join(models, "ggml-medium.bin"), "multilingual"),
    ]);

    try {
      await expect(
        resolveExistingWhisperModel({ AGENC_HOME: home }),
      ).resolves.toBe(
        join(models, "ggml-medium.bin"),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("does not discover models from another process's global cache", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-whisper-untrusted-"));
    const globalCache = join(home, ".cache", "whisper", "models");
    await mkdir(globalCache, { recursive: true });
    await writeFile(join(globalCache, "ggml-small.bin"), "untrusted");

    try {
      await expect(resolveExistingWhisperModel({ HOME: home })).resolves.toBe(
        undefined,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("knows the extensions a recording arrives as", () => {
    expect(audioMediaTypeFor(".webm")).toBe("audio/webm");
    expect(audioMediaTypeFor(".M4A")).toBe("audio/mp4");
    expect(audioMediaTypeFor(".png")).toBeUndefined();
  });
});
