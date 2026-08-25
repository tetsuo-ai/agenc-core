/**
 * Speech to text, so a voice note reaches a model that cannot hear.
 *
 * None of the models people actually run here take audio in: GPT-5.x is
 * text and image only, and so are Grok and Claude. Only Gemini and OpenAI's
 * dedicated audio models accept sound, and the session is rarely on one of
 * those. Left alone, an attached recording arrived as a file path, the agent
 * tried to read it, was told "cannot read binary files", and went hunting
 * the machine for ffmpeg and whisper — burning a turn to answer nothing.
 *
 * Transcribing costs the tone of voice and keeps the words, which is the
 * part a model can act on.
 */

const DEFAULT_ENDPOINT = "https://api.openai.com/v1";

/** Cheap, fast, and current; whisper-1 remains the compatibility floor. */
const DEFAULT_MODEL = "gpt-4o-transcribe"; // branding-scan: allow OpenAI model identifier

/** Env names an OpenAI-compatible transcription key may arrive under. */
const KEY_ENV_NAMES = [
  "OPENAI_API_KEY",
  "AGENC_OPENAI_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
] as const;

export interface TranscriptionResult {
  readonly text: string;
  readonly model: string;
}

export class TranscriptionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionUnavailableError";
  }
}

function resolveKey(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of KEY_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function resolveEndpoint(env: NodeJS.ProcessEnv): string {
  const base =
    env.AGENC_TRANSCRIBE_BASE_URL?.trim() ||
    env.OPENAI_BASE_URL?.trim() ||
    DEFAULT_ENDPOINT;
  return base.replace(/\/+$/, "");
}

/**
 * Post the recording to an OpenAI-compatible `/audio/transcriptions`.
 *
 * Multipart is built by hand through FormData/Blob rather than a helper so
 * this carries no dependency: the file is already in memory as the bytes the
 * read tool just took off disk.
 */
export async function transcribeAudio(params: {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}): Promise<TranscriptionResult> {
  const env = params.env ?? process.env;
  const key = resolveKey(env);
  if (key === undefined) {
    throw new TranscriptionUnavailableError(
      "No transcription credentials. Set OPENAI_API_KEY (or AGENC_OPENAI_API_KEY) to have voice notes transcribed.",
    );
  }
  const model = env.AGENC_TRANSCRIBE_MODEL?.trim() || DEFAULT_MODEL;
  const form = new FormData();
  // Copy into a fresh buffer: the caller's view may be a slice of a larger
  // allocation, which Blob would otherwise carry whole.
  form.append(
    "file",
    new Blob([new Uint8Array(params.bytes)], { type: params.mimeType }),
    params.filename,
  );
  form.append("model", model);
  form.append("response_format", "text");

  const doFetch = params.fetchImpl ?? fetch;
  const response = await doFetch(
    `${resolveEndpoint(env)}/audio/transcriptions`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    },
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 400);
    throw new TranscriptionUnavailableError(
      `Transcription failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  const text = (await response.text()).trim();
  if (text.length === 0) {
    throw new TranscriptionUnavailableError(
      "The recording transcribed to nothing — it may be silent.",
    );
  }
  return { text, model };
}

/** Extensions this path claims, mapped to what the endpoint expects. */
export const AUDIO_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".flac": "audio/flac",
};

export function audioMediaTypeFor(ext: string): string | undefined {
  return AUDIO_MEDIA_TYPES[ext.toLowerCase()];
}
