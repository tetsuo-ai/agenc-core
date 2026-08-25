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

/** What Gemini transcribes with when it is the credential that is present. */
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

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
 * Gemini hears audio directly, so it transcribes through an ordinary
 * generateContent call rather than a transcription endpoint. Worth trying
 * first when its key is the one present: a ChatGPT subscription login
 * leaves no OPENAI_API_KEY behind, so for most sessions here this is the
 * only credential that can do the job.
 */
async function transcribeWithGemini(params: {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly key: string;
  readonly model: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}): Promise<TranscriptionResult> {
  const doFetch = params.fetchImpl ?? fetch;
  const response = await doFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${params.model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": params.key,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: "Transcribe this recording verbatim. Reply with the transcript and nothing else.",
              },
              {
                inlineData: {
                  mimeType: params.mimeType,
                  data: Buffer.from(params.bytes).toString("base64"),
                },
              },
            ],
          },
        ],
      }),
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    },
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 400);
    throw new TranscriptionUnavailableError(
      `Transcription failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  const payload = (await response.json()) as {
    candidates?: {
      content?: { parts?: { text?: string }[] };
    }[];
  };
  const text = (payload.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (text.length === 0) {
    throw new TranscriptionUnavailableError(
      "The recording transcribed to nothing — it may be silent.",
    );
  }
  return { text, model: params.model };
}

/**
 * Words from a recording, by whichever credential is present.
 *
 * An OpenAI-compatible `/audio/transcriptions` when there is a key for one —
 * multipart built by hand so this carries no dependency, since the bytes are
 * already in memory from the read. Otherwise Gemini, which hears audio
 * natively and is the key a session here usually has.
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
    const geminiKey =
      env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || "";
    if (geminiKey.length > 0) {
      return await transcribeWithGemini({
        bytes: params.bytes,
        mimeType: params.mimeType,
        key: geminiKey,
        model: env.AGENC_TRANSCRIBE_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
        ...(params.fetchImpl !== undefined ? { fetchImpl: params.fetchImpl } : {}),
      });
    }
    throw new TranscriptionUnavailableError(
      "No transcription credentials. Set OPENAI_API_KEY or GEMINI_API_KEY to have voice notes transcribed.",
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
