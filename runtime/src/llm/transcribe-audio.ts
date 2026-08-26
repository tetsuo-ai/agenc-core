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

import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

import { scrubEnvForChildProcess } from "../unified-exec/scrub-env.js";
import {
  runSupervisedProcess,
  type SupervisedProcessCommand,
  type SupervisedProcessOptions,
  type SupervisedProcessResult,
} from "../utils/supervisedProcess.js";

const DEFAULT_ENDPOINT = "https://api.openai.com/v1";

/** Cheap, fast, and current; whisper-1 remains the compatibility floor. */
const DEFAULT_MODEL = "gpt-4o-transcribe"; // branding-scan: allow OpenAI model identifier

/** What Gemini transcribes with when it is the credential that is present. */
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
const CLOUD_TRANSCRIPTION_TIMEOUT_MS = 120_000;
const CLOUD_TRANSCRIPTION_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Env names an OpenAI-compatible transcription key may arrive under. */
const KEY_ENV_NAMES = [
  "OPENAI_API_KEY",
  "AGENC_OPENAI_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
] as const;

export interface TranscriptionResult {
  readonly text: string;
  readonly model: string;
  readonly provider: "openai" | "gemini" | "local";
}

export interface LocalAudioTranscriberParams {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export type LocalAudioTranscriber = (
  params: LocalAudioTranscriberParams,
) => Promise<TranscriptionResult>;

export interface LocalAudioTranscriptionDependencies {
  readonly resolveExecutable?: (
    name: "whisper-cli" | "ffmpeg",
    configuredPath: string | undefined,
    env: NodeJS.ProcessEnv,
  ) => Promise<string | undefined>;
  readonly resolveModel?: (
    env: NodeJS.ProcessEnv,
  ) => Promise<string | undefined>;
  readonly runProcess?: (
    command: SupervisedProcessCommand,
    options: SupervisedProcessOptions,
  ) => Promise<SupervisedProcessResult>;
  readonly fileSize?: (filePath: string) => Promise<number>;
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

function boundedCloudSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(CLOUD_TRANSCRIPTION_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function readBoundedCloudResponse(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > CLOUD_TRANSCRIPTION_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new TranscriptionUnavailableError(
          "Transcription provider response exceeded the 1 MiB limit.",
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
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
  const signal = boundedCloudSignal(params.signal);
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
      signal,
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new TranscriptionUnavailableError(
      `Transcription failed (${response.status}).`,
    );
  }
  const payload = JSON.parse(await readBoundedCloudResponse(response)) as {
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
  return { text, model: params.model, provider: "gemini" };
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
  readonly localTranscriber?: LocalAudioTranscriber;
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
    const localTranscriber = params.localTranscriber ?? transcribeWithLocalAudio;
    return await localTranscriber({
      bytes: params.bytes,
      filename: params.filename,
      mimeType: params.mimeType,
      env,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    });
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
  const signal = boundedCloudSignal(params.signal);
  const response = await doFetch(
    `${resolveEndpoint(env)}/audio/transcriptions`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal,
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new TranscriptionUnavailableError(
      `Transcription failed (${response.status}).`,
    );
  }
  const text = (await readBoundedCloudResponse(response)).trim();
  if (text.length === 0) {
    throw new TranscriptionUnavailableError(
      "The recording transcribed to nothing — it may be silent.",
    );
  }
  return { text, model, provider: "openai" };
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

const LOCAL_TRANSCRIPTION_TIMEOUT_MS = 120_000;
const LOCAL_TRANSCRIPTION_MAX_OUTPUT_BYTES = 1024 * 1024;
const LOCAL_TRANSCRIPTION_MAX_DURATION_SECONDS = 600;
const LOCAL_TRANSCRIPTION_MAX_PCM_BYTES =
  LOCAL_TRANSCRIPTION_MAX_DURATION_SECONDS * 16_000 * 2;
const LOCAL_MODEL_EXTENSIONS = new Set([".bin", ".gguf"]);

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw Object.assign(new Error("audio transcription was cancelled"), {
    name: "AbortError",
  });
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function resolveLocalExecutable(
  name: "whisper-cli" | "ffmpeg",
  configuredPath: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const configured = configuredPath?.trim();
  if (configured !== undefined && configured.length > 0) {
    const configuredAbsolute = isAbsolute(configured)
      ? configured
      : resolve(configured);
    return (await isExecutableFile(configuredAbsolute))
      ? configuredAbsolute
      : undefined;
  }

  const executableNames =
    process.platform === "win32" ? [name, `${name}.exe`] : [name];
  for (const pathEntry of (env.PATH ?? process.env.PATH ?? "").split(
    delimiter,
  )) {
    if (pathEntry.length === 0) continue;
    for (const executableName of executableNames) {
      const candidate = join(pathEntry, executableName);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function localModelRank(filePath: string): number {
  const name = basename(filePath).toLowerCase();
  // `.en` checkpoints cannot reliably transcribe the multilingual voice notes
  // common in the desktop app. Prefer any multilingual checkpoint first, then
  // prefer the practical low-latency sizes within each language class.
  const englishOnlyPenalty = /(?:^|[._-])en(?:[._-]|$)/u.test(name) ? 10 : 0;
  if (name.includes("small")) return englishOnlyPenalty;
  if (name.includes("base")) return englishOnlyPenalty + 1;
  if (name.includes("tiny")) return englishOnlyPenalty + 2;
  if (name.includes("medium")) return englishOnlyPenalty + 3;
  if (name.includes("large")) return englishOnlyPenalty + 4;
  return englishOnlyPenalty + 5;
}

async function collectLocalModels(
  root: string,
  depth: number,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const entry of entries) {
    const candidate = join(root, entry.name);
    if (
      entry.isFile() &&
      LOCAL_MODEL_EXTENSIONS.has(extname(entry.name).toLowerCase())
    ) {
      candidates.push(candidate);
      continue;
    }
    if (entry.isDirectory() && depth > 0) {
      candidates.push(...(await collectLocalModels(candidate, depth - 1)));
    }
  }
  return candidates;
}

/**
 * Find a model the user already has. This deliberately never downloads or
 * mutates a model cache.
 */
export async function resolveExistingWhisperModel(
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const configured = env.AGENC_WHISPER_MODEL?.trim();
  if (configured !== undefined && configured.length > 0) {
    const configuredAbsolute = isAbsolute(configured)
      ? configured
      : resolve(configured);
    try {
      return (await stat(configuredAbsolute)).isFile()
        ? configuredAbsolute
        : undefined;
    } catch {
      return undefined;
    }
  }

  const userHome = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const configuredAgenCHome = env.AGENC_HOME?.trim();
  const agencHome =
    configuredAgenCHome !== undefined && configuredAgenCHome.length > 0
      ? isAbsolute(configuredAgenCHome)
        ? configuredAgenCHome
        : resolve(configuredAgenCHome)
      : join(userHome, ".agenc");
  // Keep auto-discovery inside AgenC-owned state. Do not silently trust models
  // left by unrelated processes in global ~/.cache trees.
  const candidates = (await collectLocalModels(join(agencHome, "models", "whisper"), 2))
    .sort(
      (left, right) =>
        localModelRank(left) - localModelRank(right) ||
        left.localeCompare(right),
    );
  return candidates[0];
}

function localTranscriptionError(message: string): TranscriptionUnavailableError {
  return new TranscriptionUnavailableError(
    `${message} Set OPENAI_API_KEY or GEMINI_API_KEY, or install whisper-cli and set AGENC_WHISPER_MODEL to an existing whisper.cpp model (or place one under AGENC_HOME/models/whisper). AgenC never downloads a model automatically.`,
  );
}

function subprocessFailureDetail(result: SupervisedProcessResult): string {
  if (result.stopReason === "timeout") return "timed out";
  if (result.stopReason === "output_limit") return "exceeded its output limit";
  if (result.stopReason === "aborted") return "was cancelled";
  const detail = (result.error?.message ?? result.stderr.toString("utf8"))
    .trim()
    .slice(0, 400);
  return detail.length > 0
    ? detail
    : `exited with code ${String(result.exitCode ?? "unknown")}`;
}

/** Optional, offline fallback for BYOK-less desktop sessions. */
export async function transcribeWithLocalAudio(
  params: LocalAudioTranscriberParams,
  dependencies: LocalAudioTranscriptionDependencies = {},
): Promise<TranscriptionResult> {
  throwIfAborted(params.signal);
  const resolveExecutable =
    dependencies.resolveExecutable ?? resolveLocalExecutable;
  const resolveModel = dependencies.resolveModel ?? resolveExistingWhisperModel;
  const runProcess = dependencies.runProcess ?? runSupervisedProcess;
  const fileSize =
    dependencies.fileSize ?? (async (filePath: string) => (await stat(filePath)).size);
  const whisperCli = await resolveExecutable(
    "whisper-cli",
    params.env.AGENC_WHISPER_CLI,
    params.env,
  );
  const model = await resolveModel(params.env);
  if (whisperCli === undefined || model === undefined) {
    throw localTranscriptionError(
      whisperCli === undefined && model === undefined
        ? "No transcription credentials or local whisper-cli/model were found."
        : whisperCli === undefined
          ? "A local Whisper model was found, but whisper-cli was not."
          : "whisper-cli was found, but no local Whisper model was found.",
    );
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), "agenc-audio-"));
  try {
    const inputExtension = extname(params.filename).toLowerCase() || ".audio";
    const inputPath = join(tempDirectory, `input${inputExtension}`);
    await writeFile(inputPath, params.bytes);

    let whisperInput = inputPath;
    if (params.mimeType !== "audio/wav") {
      const ffmpeg = await resolveExecutable(
        "ffmpeg",
        params.env.AGENC_FFMPEG,
        params.env,
      );
      if (ffmpeg === undefined) {
        throw localTranscriptionError(
          `${params.mimeType} needs ffmpeg before whisper-cli can read it, but ffmpeg was not found.`,
        );
      }
      whisperInput = join(tempDirectory, "input-16k-mono.wav");
      const converted = await runProcess(
        {
          program: ffmpeg,
          args: [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            inputPath,
            "-t",
            String(LOCAL_TRANSCRIPTION_MAX_DURATION_SECONDS),
            "-ac",
            "1",
            "-ar",
            "16000",
            whisperInput,
          ],
          cwd: tempDirectory,
          env: scrubEnvForChildProcess(params.env),
        },
        {
          timeoutMs: LOCAL_TRANSCRIPTION_TIMEOUT_MS,
          maxOutputBytes: LOCAL_TRANSCRIPTION_MAX_OUTPUT_BYTES,
          ...(params.signal !== undefined ? { signal: params.signal } : {}),
        },
      );
      throwIfAborted(params.signal);
      if (converted.stopReason !== undefined || converted.exitCode !== 0) {
        throw localTranscriptionError(
          `ffmpeg could not prepare the recording: ${subprocessFailureDetail(converted)}.`,
        );
      }
      let convertedSize: number;
      try {
        convertedSize = await fileSize(whisperInput);
      } catch (error) {
        throw localTranscriptionError(
          `ffmpeg did not produce a readable WAV: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
      // The WAV container adds a small header on top of its PCM payload, so an
      // ffmpeg output stopped exactly at `-t 600` is at least this large. Treat
      // reaching the raw 600-second PCM threshold as truncation instead of
      // returning an apparently complete transcript.
      if (convertedSize >= LOCAL_TRANSCRIPTION_MAX_PCM_BYTES) {
        throw localTranscriptionError(
          "The recording exceeds the 10-minute local transcription limit.",
        );
      }
    }

    const transcribed = await runProcess(
      {
        program: whisperCli,
        args: [
          "-m",
          model,
          "-f",
          whisperInput,
          "-l",
          "auto",
          "-nt",
          "-np",
        ],
        cwd: dirname(whisperInput),
        env: scrubEnvForChildProcess(params.env),
      },
      {
        timeoutMs: LOCAL_TRANSCRIPTION_TIMEOUT_MS,
        maxOutputBytes: LOCAL_TRANSCRIPTION_MAX_OUTPUT_BYTES,
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
      },
    );
    throwIfAborted(params.signal);
    if (transcribed.stopReason !== undefined || transcribed.exitCode !== 0) {
      throw localTranscriptionError(
        `whisper-cli could not transcribe the recording: ${subprocessFailureDetail(transcribed)}.`,
      );
    }
    const text = transcribed.stdout.toString("utf8").trim();
    if (text.length === 0) {
      throw new TranscriptionUnavailableError(
        "The recording transcribed to nothing — it may be silent.",
      );
    }
    return { text, model: basename(model), provider: "local" };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
