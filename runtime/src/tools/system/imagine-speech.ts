/**
 * Text to speech for OpenRouter and Venice sessions.
 *
 * Both providers serve an OpenAI-compatible `POST /audio/speech` that
 * returns the audio bytes. The route is session-native and fail-closed: an
 * OpenRouter or Venice session speaks with its own key (factory or canonical
 * environment ingress) and nobody else's, the managed AgenC route lends no
 * credential, only models with a published per-character price are sent
 * (OpenRouter's reviewed ones; any text-to-speech model in Venice's live
 * list, see venice-media-models), and the file lands under the workspace's `.agenc/imagine` directory
 * like ImagineImage and ImagineVideo output. The tool is always deferred:
 * a session finds it through system.searchTools, so no request carries its
 * schema unless the model asked for it.
 *
 * @module
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { readProviderIdentity } from "../../llm/provider.js";
import {
  resolveProviderApiKeyEnvironment,
  resolveProviderBaseURLEnvironment,
} from "../../llm/registry/provider-ingress.js";
import type { Tool, ToolResult } from "../types.js";
import { readInvokingSession } from "../runtimes/context.js";
import {
  isManagedProviderRoute,
  resolveToolCallAuthority,
  sessionApiKeyRoute,
  type ToolCallAuthority,
  toolCallSession,
  withToolCallTransport,
} from "./session-provider-authority.js";
import { preEffectRefusal } from "../results.js";
import { safeStringify } from "../types.js";
import { redactSensitiveAPIText } from "../../errors/api.js";
import {
  cachedVeniceMediaModels,
  loadVeniceMediaModels,
  type VeniceListAuthority,
  veniceSpeechFormat,
  veniceSpeechUsdPerCharacter,
  type VeniceMediaModel,
} from "./venice-media-models.js";

export interface ImagineSpeechToolOptions {
  readonly workspaceRoot: string;
  readonly getSession: () => {
    services?: { provider?: unknown };
  } | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

type SpeechBackendKind = "openrouter" | "venice";

interface SpeechBackend {
  readonly kind: SpeechBackendKind;
  readonly baseURL: string;
  readonly bearer: string;
  /** The calling session's authority; its requests use this transport. */
  readonly authority: ToolCallAuthority;
}

interface ReviewedSpeechModel {
  /** USD per input character (the published rate). */
  readonly usdPerCharacter: number;
  readonly defaultVoice: string;
}

/**
 * Reviewed text-to-speech models and their published per-character price,
 * 2026-10-20: OpenRouter GET /api/v1/models?output_modalities=speech
 * (`pricing.prompt`), Venice GET /api/v1/models?type=tts (USD per million).
 */
const SPEECH_MODELS: Readonly<Record<SpeechBackendKind, ReadonlyMap<string, ReviewedSpeechModel>>> = Object.freeze({
  openrouter: new Map<string, ReviewedSpeechModel>([
    ["hexgrad/kokoro-82m", { usdPerCharacter: 0.00000062, defaultVoice: "af_heart" }],
    ["x-ai/grok-voice-tts-1.0", { usdPerCharacter: 0.000015, defaultVoice: "eve" }],
    ["deepgram/aura-2", { usdPerCharacter: 0.00003, defaultVoice: "aura-2-thalia-en" }],
  ]),
  venice: new Map<string, ReviewedSpeechModel>([
    ["tts-kokoro", { usdPerCharacter: 3.5 / 1_000_000, defaultVoice: "af_sky" }],
    ["tts-xai-v1", { usdPerCharacter: 18.75 / 1_000_000, defaultVoice: "eve" }],
  ]),
});
const DEFAULT_SPEECH_MODEL: Readonly<Record<SpeechBackendKind, string>> = Object.freeze({
  openrouter: "hexgrad/kokoro-82m",
  venice: "tts-kokoro",
});
const DEFAULT_BASE_URL: Readonly<Record<SpeechBackendKind, string>> = Object.freeze({
  openrouter: "https://openrouter.ai/api/v1",
  venice: "https://api.venice.ai/api/v1",
});
const LABEL: Readonly<Record<SpeechBackendKind, string>> = Object.freeze({
  openrouter: "OpenRouter speech",
  venice: "Venice speech",
});
/** Venice's /audio/speech limit; OpenRouter's models take at least as much. */
const MAX_SPEECH_CHARACTERS = 4096;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

function refusal(message: string): ToolResult {
  return preEffectRefusal("ImagineSpeech", safeStringify({ error: message }));
}

function json(payload: unknown, isError?: boolean): ToolResult {
  return { content: safeStringify(payload), ...(isError ? { isError: true } : {}) };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The speech route of the session making the call (`args`; a sub-agent runs
 * its parent's tool): its own key with its own URL, or, without a factory
 * key, its provider's canonical key with the canonical URL from its own
 * environment. Never one session's URL with another's key.
 */
function resolveSpeechBackend(
  opts: ImagineSpeechToolOptions,
  args?: Readonly<Record<string, unknown>>,
): SpeechBackend | { readonly error: string } {
  const call = toolCallSession(readInvokingSession(args), opts.getSession);
  const session = call.session;
  const provider = session?.services?.provider;
  const identity = readProviderIdentity(provider as never);
  if ((identity !== "openrouter" && identity !== "venice") || provider === undefined) {
    return { error: "ImagineSpeech speaks only in an OpenRouter or Venice session, with that session's own key." };
  }
  if (isManagedProviderRoute(provider)) {
    return { error: "ImagineSpeech is not available on the managed AgenC route." };
  }
  const authority = resolveToolCallAuthority("ImagineSpeech", call, {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
  if ("error" in authority) return authority;
  const own = sessionApiKeyRoute(provider, DEFAULT_BASE_URL[identity]);
  if (own !== undefined) return { kind: identity, ...own, authority };
  const env = authority.environment;
  const bearer = resolveProviderApiKeyEnvironment(identity, env)?.value;
  if (bearer === undefined) return { error: `ImagineSpeech needs this ${identity} session's API key.` };
  const baseURL = resolveProviderBaseURLEnvironment(identity, env)?.value ?? DEFAULT_BASE_URL[identity];
  try {
    new URL(baseURL);
  } catch {
    return { error: "ImagineSpeech endpoint is invalid." };
  }
  return { kind: identity, baseURL: baseURL.replace(/\/+$/, ""), bearer, authority };
}

/** Whose Venice list a call reads: the session's endpoint, key and transport. */
function veniceList(backend: SpeechBackend): VeniceListAuthority {
  return { baseURL: backend.baseURL, bearer: backend.bearer, transport: backend.authority.transportEnvironment };
}

/** Whether this session has its own speech route. */
export function hasImagineSpeechBackend(opts: ImagineSpeechToolOptions): boolean {
  return !("error" in resolveSpeechBackend(opts));
}

function inputSchema(kind: SpeechBackendKind | undefined): Record<string, unknown> {
  // Venice takes any text-to-speech model from its live list. The schema a
  // registry advertises before its session attaches is the one the TUI
  // keeps, so it names no list either; the call is checked against the
  // session's own provider.
  const model = kind === "openrouter"
    ? {
      type: "string",
      enum: [...SPEECH_MODELS.openrouter.keys()],
      description: "Text-to-speech model (default: the provider's cheapest reviewed one).",
    }
    : {
      type: "string",
      description: kind === "venice"
        ? `A Venice text-to-speech model id (default ${DEFAULT_SPEECH_MODEL.venice}; others include ` +
          "tts-xai-v1, tts-elevenlabs-turbo-v2-5, tts-inworld-1-5-max, tts-orpheus)."
        : `Text-to-speech model: on OpenRouter one of ${[...SPEECH_MODELS.openrouter.keys()].join(", ")}; ` +
          `on Venice any Venice text-to-speech model (default ${DEFAULT_SPEECH_MODEL.venice}).`,
    };
  return {
    type: "object",
    properties: {
      text: { type: "string", description: `What to say, up to ${MAX_SPEECH_CHARACTERS} characters.` },
      model,
      voice: { type: "string", description: "Voice name the model offers (default: the model's reviewed default voice)." },
      speed: { type: "number", minimum: 0.5, maximum: 2, description: "Speaking speed (default 1)." },
    },
    required: ["text"],
    additionalProperties: false,
  };
}

interface SpeechPlan {
  readonly usdPerCharacter: number;
  readonly voice: string | undefined;
  readonly voices: readonly string[];
  /** The audio format to request (some Venice models return only WAV). */
  readonly format: string;
}

/**
 * How one model is priced and voiced: Venice's live row when the list names
 * it, else the reviewed table (OpenRouter, or Venice while its list is unread).
 */
function speechPlan(
  backend: SpeechBackend,
  model: string,
  live: ReadonlyMap<string, VeniceMediaModel> | undefined,
): SpeechPlan | undefined {
  const reviewed = SPEECH_MODELS[backend.kind].get(model);
  if (backend.kind === "venice" && live !== undefined) {
    const row = live.get(model);
    const usdPerCharacter = row?.type === "tts" ? veniceSpeechUsdPerCharacter(row) : undefined;
    if (row === undefined || usdPerCharacter === undefined) return undefined;
    const reviewedVoice = reviewed !== undefined && row.voices.includes(reviewed.defaultVoice) ? reviewed.defaultVoice : undefined;
    return { usdPerCharacter, voice: reviewedVoice ?? row.voices[0], voices: row.voices, format: veniceSpeechFormat(row) };
  }
  return reviewed === undefined
    ? undefined
    : { usdPerCharacter: reviewed.usdPerCharacter, voice: reviewed.defaultVoice, voices: [], format: "mp3" };
}

function extensionFor(contentType: string | null): string {
  const type = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (type === "audio/wav" || type === "audio/x-wav" || type === "audio/wave") return "wav";
  if (type === "audio/ogg" || type === "audio/opus") return "ogg";
  if (type === "audio/flac") return "flac";
  if (type === "audio/aac") return "aac";
  return "mp3";
}

async function readCappedAudio(response: Response): Promise<Buffer> {
  if (response.body === null) throw new Error("Speech response had no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AUDIO_BYTES) {
      await reader.cancel();
      throw new Error("Speech audio exceeds the 50 MiB limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export function createImagineSpeechTool(opts: ImagineSpeechToolOptions): Tool {
  const advertised = opts.getSession() === null ? undefined : resolveSpeechBackend(opts);
  const advertisedKind = advertised !== undefined && !("error" in advertised) ? advertised.kind : undefined;
  if (advertised !== undefined && !("error" in advertised) && advertised.kind === "venice" &&
      cachedVeniceMediaModels(veniceList(advertised)) === undefined) {
    void loadVeniceMediaModels(veniceList(advertised),
      withToolCallTransport(opts.fetchImpl ?? fetch, advertised.authority)).catch(() => undefined);
  }
  return {
    name: "ImagineSpeech",
    description: advertisedKind === undefined
      ? "Turn text into a spoken audio file with the session's OpenRouter or Venice text-to-speech and save it under the workspace."
      : `Turn text into a spoken audio file with ${LABEL[advertisedKind]} on this session's key and save it under the workspace.`,
    metadata: {
      family: "media",
      source: "builtin",
      hiddenByDefault: false,
      mutating: true,
      // Found through system.searchTools; never on every request.
      deferred: true,
      fixedWriteTargets: () => [join(opts.workspaceRoot, ".agenc", "imagine")],
      keywords: ["speech", "audio", "voice", "tts", "speak", "narrate", "sound", "media"],
      preferredProfiles: ["coding", "operator", "general"],
    },
    isReadOnly: false,
    requiresApproval: true,
    concurrencyClass: { kind: "exclusive" },
    timeoutMs: 120_000,
    recoveryCategory: "side-effecting",
    admissionEstimate: (args) => {
      const backend = resolveSpeechBackend(opts, args);
      if ("error" in backend) return { maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: null };
      const model = stringValue(args.model) ?? DEFAULT_SPEECH_MODEL[backend.kind];
      const live = backend.kind === "venice" ? cachedVeniceMediaModels(veniceList(backend)) : undefined;
      const plan = speechPlan(backend, model, live);
      const text = typeof args.text === "string" ? args.text : "";
      return {
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: plan === undefined ? null : plan.usdPerCharacter * Math.min(text.length, MAX_SPEECH_CHARACTERS),
      };
    },
    inputSchema: inputSchema(advertisedKind),
    execute: async (args) => {
      const signal = args.__abortSignal instanceof AbortSignal ? args.__abortSignal : undefined;
      signal?.throwIfAborted();
      const backend = resolveSpeechBackend(opts, args);
      if ("error" in backend) return refusal(backend.error);
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (text.length === 0) return refusal("text is required");
      if (text.length > MAX_SPEECH_CHARACTERS) {
        return refusal(`text is ${text.length} characters; the limit is ${MAX_SPEECH_CHARACTERS}`);
      }
      const model = stringValue(args.model) ?? DEFAULT_SPEECH_MODEL[backend.kind];
      // The calling session's own proxy, client certificate and CA trust.
      const fetchImpl = withToolCallTransport(opts.fetchImpl ?? fetch, backend.authority);
      const live = backend.kind === "venice"
        ? await loadVeniceMediaModels(veniceList(backend), fetchImpl, signal)
        : undefined;
      const plan = speechPlan(backend, model, live);
      if (plan === undefined) {
        const names = live !== undefined
          ? [...live.values()].filter(row => row.type === "tts").map(row => row.id)
          : [...SPEECH_MODELS[backend.kind].keys()];
        return refusal(`${LABEL[backend.kind]} model must be one of ${names.join(", ")}`);
      }
      const voice = stringValue(args.voice) ?? plan.voice;
      if (voice === undefined) return refusal(`${LABEL[backend.kind]} model ${model} lists no voice`);
      if (plan.voices.length > 0 && !plan.voices.includes(voice)) {
        return refusal(`${model} voices are ${plan.voices.join(", ")}`);
      }
      const speed = typeof args.speed === "number" && Number.isFinite(args.speed)
        ? Math.min(2, Math.max(0.5, args.speed)) : undefined;
      const timeout = AbortSignal.timeout(110_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const response = await fetchImpl(`${backend.baseURL}/audio/speech`, {
          method: "POST",
          headers: { authorization: `Bearer ${backend.bearer}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            input: text,
            voice,
            response_format: plan.format,
            ...(speed === undefined ? {} : { speed }),
          }),
          signal: requestSignal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          const message = redactSensitiveAPIText(
            `${LABEL[backend.kind]} HTTP ${response.status}${detail ? `: ${detail.slice(0, 1000)}` : ""}`
              .replaceAll(backend.bearer, "[REDACTED]"),
          );
          // A refused request generated nothing.
          return response.status >= 400 && response.status < 500 ? refusal(message) : json({ error: message }, true);
        }
        const contentType = response.headers.get("content-type");
        if (contentType !== null && !/^audio\//i.test(contentType) && !/octet-stream/i.test(contentType)) {
          return json({ error: `${LABEL[backend.kind]} returned ${contentType}, not audio` }, true);
        }
        const bytes = await readCappedAudio(response);
        if (bytes.byteLength === 0) return json({ error: `${LABEL[backend.kind]} returned empty audio` }, true);
        const outDir = join(opts.workspaceRoot, ".agenc", "imagine");
        await mkdir(outDir, { recursive: true });
        const path = join(outDir, `imagine-speech-${randomUUID()}.${extensionFor(contentType)}`);
        await writeFile(path, bytes, { signal: requestSignal });
        // The published per-character rate is the charge of record.
        const costUsd = plan.usdPerCharacter * text.length;
        return {
          ...json({ backend: backend.kind, model, voice, path, bytes: bytes.byteLength, characters: text.length, costUsd }),
          admissionUsage: { inputTokens: 0, outputTokens: 0, costUsd },
        };
      } catch (error) {
        signal?.throwIfAborted();
        return json({ error: error instanceof Error ? error.message : "Speech request failed" }, true);
      }
    },
  };
}
