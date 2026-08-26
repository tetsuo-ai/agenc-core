import {
  transcribeAudio,
  transcribeWithLocalAudio,
  TranscriptionUnavailableError,
  type LocalAudioTranscriber,
} from "../llm/transcribe-audio.js";
import type { AudioTranscribeResult } from "./protocol/index.js";

export const MAX_AUDIO_TRANSCRIPTION_BYTES = 10 * 1024 * 1024;

/** Validated, decoded audio owned by the daemon request boundary. */
export interface AgenCAudioTranscriptionRequest {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly fileName: string;
  readonly preferredProvider?: "openai" | "gemini" | "local";
}

export interface AgenCAudioTranscriptionService {
  transcribe(
    request: AgenCAudioTranscriptionRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<AudioTranscribeResult>;
}

export interface AgenCAudioTranscriptionServiceOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly localTranscriber?: LocalAudioTranscriber;
  readonly cloudTranscriber?: typeof transcribeAudio;
}

function directCloudEnvironment(
  env: NodeJS.ProcessEnv,
  provider: "openai" | "gemini",
): NodeJS.ProcessEnv {
  if (provider === "gemini") {
    return {
      ...(env.GEMINI_API_KEY !== undefined
        ? { GEMINI_API_KEY: env.GEMINI_API_KEY }
        : {}),
      ...(env.GOOGLE_API_KEY !== undefined
        ? { GOOGLE_API_KEY: env.GOOGLE_API_KEY }
        : {}),
      ...(env.AGENC_TRANSCRIBE_MODEL !== undefined
        ? { AGENC_TRANSCRIBE_MODEL: env.AGENC_TRANSCRIBE_MODEL }
        : {}),
    };
  }
  return {
    ...(env.OPENAI_API_KEY !== undefined
      ? { OPENAI_API_KEY: env.OPENAI_API_KEY }
      : {}),
    ...(env.AGENC_OPENAI_API_KEY !== undefined
      ? { AGENC_OPENAI_API_KEY: env.AGENC_OPENAI_API_KEY }
      : {}),
    ...(env.OPENAI_COMPATIBLE_API_KEY !== undefined
      ? { OPENAI_COMPATIBLE_API_KEY: env.OPENAI_COMPATIBLE_API_KEY }
      : {}),
    ...(env.AGENC_TRANSCRIBE_BASE_URL !== undefined
      ? { AGENC_TRANSCRIBE_BASE_URL: env.AGENC_TRANSCRIBE_BASE_URL }
      : {}),
    ...(env.OPENAI_BASE_URL !== undefined
      ? { OPENAI_BASE_URL: env.OPENAI_BASE_URL }
      : {}),
    ...(env.AGENC_TRANSCRIBE_MODEL !== undefined
      ? { AGENC_TRANSCRIBE_MODEL: env.AGENC_TRANSCRIBE_MODEL }
      : {}),
  };
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function toAudioTranscribeResult(
  result: Awaited<ReturnType<typeof transcribeAudio>>,
): AudioTranscribeResult {
  return {
    text: result.text,
    model: result.model,
    provider: result.provider,
  };
}

/**
 * One-shot pre-turn speech-to-text. This intentionally uses only direct
 * BYOK/environment credentials or the optional local whisper stack. It must
 * remain outside managed-key vending and provider accounting because there is
 * no admitted model turn to which that paid operation could be charged.
 */
export class AgenCAudioTranscriptionServiceImpl
  implements AgenCAudioTranscriptionService
{
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #localTranscriber: LocalAudioTranscriber;
  readonly #cloudTranscriber: typeof transcribeAudio;

  constructor(options: AgenCAudioTranscriptionServiceOptions = {}) {
    this.#env = options.env;
    this.#localTranscriber = options.localTranscriber ?? transcribeWithLocalAudio;
    this.#cloudTranscriber = options.cloudTranscriber ?? transcribeAudio;
  }

  async transcribe(
    request: AgenCAudioTranscriptionRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<AudioTranscribeResult> {
    const env = this.#env ?? process.env;
    try {
      return toAudioTranscribeResult(
        await this.#localTranscriber({
          bytes: request.bytes,
          filename: request.fileName,
          mimeType: request.mimeType,
          env,
          signal: options.signal,
        }),
      );
    } catch (error) {
      if (isCancellation(error, options.signal)) throw error;
      if (
        request.preferredProvider === undefined ||
        request.preferredProvider === "local"
      ) {
        throw error;
      }
    }

    const provider = request.preferredProvider;
    const result = await this.#cloudTranscriber({
      bytes: request.bytes,
      filename: request.fileName,
      mimeType: request.mimeType,
      env: directCloudEnvironment(env, provider),
      signal: options.signal,
      localTranscriber: async () => {
        throw new TranscriptionUnavailableError(
          `No direct ${provider} transcription API key is configured.`,
        );
      },
    });
    if (result.provider !== provider) {
      throw new TranscriptionUnavailableError(
        `The ${provider} transcription request resolved through an unexpected provider.`,
      );
    }
    return toAudioTranscribeResult(result);
  }
}
