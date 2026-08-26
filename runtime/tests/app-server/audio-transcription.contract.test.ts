import { describe, expect, it, vi } from "vitest";

import { AgenCDaemonAgentManager } from "./agent-lifecycle.js";
import {
  AgenCAudioTranscriptionServiceImpl,
  MAX_AUDIO_TRANSCRIPTION_BYTES,
  type AgenCAudioTranscriptionService,
} from "./audio-transcription.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import { JSON_RPC_VERSION, type JsonObject } from "./protocol/index.js";

function request(id: string, method: string, params?: JsonObject): JsonObject {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  };
}

async function initializedConnection(
  audioTranscription: AgenCAudioTranscriptionService,
) {
  const connection = new AgenCDaemonJsonRpcDispatcher({
    agentManager: new AgenCDaemonAgentManager(),
    audioTranscription,
  }).createConnection();
  await connection.dispatch(
    request("init", "initialize", {
      protocol: { version: "1.2.0" },
    }),
  );
  return connection;
}

describe("daemon audio.transcribe", () => {
  it("decodes strict base64 and dispatches through the injected service", async () => {
    const transcribe = vi.fn(async () => ({
      text: "hello from audio",
      model: "test-stt",
      provider: "local" as const,
    }));
    const connection = await initializedConnection({ transcribe });
    const raw = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

    await expect(
      connection.dispatch(
        request("audio-ok", "audio.transcribe", {
          preferredProvider: "local",
          audio: {
            data: raw.toString("base64"),
            mimeType: "audio/webm",
            fileName: "voice.webm",
          },
        }),
      ),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "audio-ok",
      result: {
        text: "hello from audio",
        model: "test-stt",
        provider: "local",
      },
    });
    expect(transcribe).toHaveBeenCalledOnce();
    expect(transcribe.mock.calls[0]?.[0]).toMatchObject({
      mimeType: "audio/webm",
      fileName: "voice.webm",
      preferredProvider: "local",
    });
    expect(Buffer.from(transcribe.mock.calls[0]![0].bytes)).toEqual(raw);
    expect(transcribe.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["%%%=", " YQ==", "YQ", "YQ===", "data:audio/webm;base64,YQ=="])(
    "rejects malformed base64 before calling the service: %s",
    async (data) => {
      const transcribe = vi.fn();
      const connection = await initializedConnection({ transcribe });
      const response = await connection.dispatch(
        request("audio-bad-base64", "audio.transcribe", {
          audio: { data, mimeType: "audio/webm", fileName: "voice.webm" },
        }),
      );
      expect(response).toMatchObject({
        error: {
          code: -32602,
          message: expect.stringContaining("strict base64"),
        },
      });
      expect(transcribe).not.toHaveBeenCalled();
    },
  );

  it("rejects unsupported MIME types and path-bearing filenames", async () => {
    const transcribe = vi.fn();
    const connection = await initializedConnection({ transcribe });
    const data = Buffer.from("audio").toString("base64");

    await expect(
      connection.dispatch(
        request("audio-bad-mime", "audio.transcribe", {
          audio: { data, mimeType: "image/png", fileName: "voice.webm" },
        }),
      ),
    ).resolves.toMatchObject({
      error: { code: -32602, message: expect.stringContaining("mimeType") },
    });
    await expect(
      connection.dispatch(
        request("audio-bad-name", "audio.transcribe", {
          audio: {
            data,
            mimeType: "audio/webm",
            fileName: "../voice.webm",
          },
        }),
      ),
    ).resolves.toMatchObject({
      error: { code: -32602, message: expect.stringContaining("basename") },
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("rejects an unsupported preferred provider", async () => {
    const transcribe = vi.fn();
    const connection = await initializedConnection({ transcribe });
    await expect(
      connection.dispatch(
        request("audio-bad-provider", "audio.transcribe", {
          preferredProvider: "grok",
          audio: {
            data: Buffer.from("audio").toString("base64"),
            mimeType: "audio/webm",
            fileName: "voice.webm",
          },
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining("preferredProvider"),
      },
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("rejects decoded audio over 10 MiB before calling the service", async () => {
    const transcribe = vi.fn();
    const connection = await initializedConnection({ transcribe });
    const data = Buffer.alloc(MAX_AUDIO_TRANSCRIPTION_BYTES + 1).toString(
      "base64",
    );

    await expect(
      connection.dispatch(
        request("audio-too-large", "audio.transcribe", {
          audio: { data, mimeType: "audio/webm", fileName: "voice.webm" },
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining("decoded limit"),
      },
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("propagates request.cancel into an in-flight transcription", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const connection = await initializedConnection({
      transcribe: async (_request, options) => {
        observedSignal = options.signal;
        started();
        await new Promise<void>((resolve) => {
          options.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return { text: "unused", model: "unused", provider: "local" };
      },
    });

    const transcribing = connection.dispatch(
      request("audio-running", "audio.transcribe", {
        audio: {
          data: Buffer.from("audio").toString("base64"),
          mimeType: "audio/webm",
          fileName: "voice.webm",
        },
      }),
    );
    await startedPromise;
    await expect(
      connection.dispatch(
        request("audio-cancel", "request.cancel", {
          requestId: "audio-running",
          reason: "user cancelled recording",
        }),
      ),
    ).resolves.toMatchObject({
      result: { requestId: "audio-running", cancelled: true },
    });
    expect(observedSignal?.aborted).toBe(true);
    await expect(transcribing).resolves.toMatchObject({
      error: {
        code: -32000,
        data: {
          code: "REQUEST_CANCELLED",
          requestId: "audio-running",
        },
      },
    });
  });
});

describe("audio transcription provider privacy", () => {
  const audio = {
    bytes: Buffer.from("audio"),
    mimeType: "audio/webm",
    fileName: "voice.webm",
  } as const;

  it("never falls through to cloud when local is explicitly preferred", async () => {
    const localTranscriber = vi.fn(async () => {
      throw new Error("local stack unavailable");
    });
    const cloudTranscriber = vi.fn();
    const service = new AgenCAudioTranscriptionServiceImpl({
      env: {
        OPENAI_API_KEY: "leftover-openai",
        GEMINI_API_KEY: "leftover-gemini",
      },
      localTranscriber,
      cloudTranscriber,
    });

    await expect(
      service.transcribe(
        { ...audio, preferredProvider: "local" },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("local stack unavailable");
    expect(localTranscriber).toHaveBeenCalledOnce();
    expect(cloudTranscriber).not.toHaveBeenCalled();
  });

  it.each([
    {
      provider: "openai" as const,
      expectedKey: "OPENAI_API_KEY",
      forbiddenKey: "GEMINI_API_KEY",
    },
    {
      provider: "gemini" as const,
      expectedKey: "GEMINI_API_KEY",
      forbiddenKey: "OPENAI_API_KEY",
    },
  ])(
    "falls back only to the explicitly preferred $provider direct key",
    async ({ provider, expectedKey, forbiddenKey }) => {
      const localTranscriber = vi.fn(async () => {
        throw new Error("local stack unavailable");
      });
      const cloudTranscriber = vi.fn(async () => ({
        text: "cloud transcript",
        model: "test-cloud",
        provider,
      }));
      const service = new AgenCAudioTranscriptionServiceImpl({
        env: {
          OPENAI_API_KEY: "openai-direct",
          GEMINI_API_KEY: "gemini-direct",
          CHATGPT_ACCESS_TOKEN: "must-not-cross-boundary",
        },
        localTranscriber,
        cloudTranscriber,
      });

      await expect(
        service.transcribe(
          { ...audio, preferredProvider: provider },
          { signal: new AbortController().signal },
        ),
      ).resolves.toMatchObject({ provider, text: "cloud transcript" });
      expect(localTranscriber).toHaveBeenCalledOnce();
      expect(cloudTranscriber).toHaveBeenCalledOnce();
      const cloudEnv = cloudTranscriber.mock.calls[0]?.[0].env;
      expect(cloudEnv[expectedKey]).toContain("-direct");
      expect(cloudEnv[forbiddenKey]).toBeUndefined();
      expect(cloudEnv.CHATGPT_ACCESS_TOKEN).toBeUndefined();
      expect(localTranscriber.mock.invocationCallOrder[0]).toBeLessThan(
        cloudTranscriber.mock.invocationCallOrder[0]!,
      );
    },
  );
});
