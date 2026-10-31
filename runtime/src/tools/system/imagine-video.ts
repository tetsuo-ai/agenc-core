/**
 * LIVE Imagine **video** generation across independent media backends.
 *
 * Three providers, three job protocols, all submit-then-poll:
 *   xAI      POST /videos/generations → request_id; GET /videos/{id};
 *            the finished payload carries a URL to download.
 *   OpenAI   POST /videos → id; GET /videos/{id} until "completed";
 *            GET /videos/{id}/content streams the MP4 under the same auth,
 *            so no payload-supplied URL is ever followed.
 *   MiniMax  POST /video_generation → task_id;
 *            GET /query/video_generation until "Success" → file_id;
 *            GET /files/retrieve → download_url on MiniMax's CDN.
 *   MiniMax H3 (v2 task API, sibling of /v1 on the same host)
 *            POST /v2/video_generation → task_id;
 *            GET /v2/query/video_generation/{task_id} until "succeeded" →
 *            task.content.url on MiniMax's CDN.
 *   OpenRouter POST /videos → id; GET /videos/{id} until "completed";
 *            GET /videos/{id}/content streams the MP4 under the same auth
 *            (the response's unsigned_urls are never followed).
 *   Venice   POST /video/quote (free) → price; POST /video/queue → queue_id
 *            (and for some models a pre-signed download_url on venice.ai);
 *            POST /video/retrieve until the body is video/mp4, or until
 *            COMPLETED and then the download_url through the download guard;
 *            the stored copy is removed afterwards.
 *   OpenRouter and Venice sessions use only their own key (session-native).
 *
 * Auth follows the same rule as ImagineImage: a session generates with its
 * own provider's native route, authorized only by that provider's canonical
 * environment ingress, and every backend is also available independently to
 * any other session. `/grok-login` OAuth still wins over BYOK for xAI, and a
 * direct Grok session retains its session bearer and base URL.
 *
 * @module
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { readProviderIdentity } from "../../llm/provider.js";
import {
  isDirectXaiInferenceHost,
  tryResolveXaiBearerTokenForBaseUrl,
} from "../../llm/xai-capability-config.js";
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
  sessionXaiRoute,
  type ToolCallAuthority,
  toolCallSession,
  withToolCallTransport,
} from "./session-provider-authority.js";
import { preEffectRefusal } from "../results.js";
import { safeStringify } from "../types.js";
import type { HomeContext } from "../../config/home.js";
import {
  cachedVeniceMediaModels,
  loadVeniceMediaModels,
  type VeniceMediaModel,
} from "./venice-media-models.js";

export interface ImagineVideoToolOptions {
  readonly workspaceRoot: string;
  readonly home: HomeContext;
  readonly getSession: () => {
    services?: { provider?: unknown };
  } | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  /** Override poll interval (ms) for tests. Default 5000. */
  readonly pollIntervalMs?: number;
  /** Override max poll wait (ms) for tests. Default 240_000. */
  readonly pollTimeoutMs?: number;
}

function json(payload: unknown, isError?: boolean): ToolResult {
  return {
    content: safeStringify(payload),
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * A refusal made before any provider request. ImagineVideo is
 * `side-effecting`, so a bare error result is filed as an unknown outcome and
 * gates every later side-effecting call behind /resolve (#2190). Argument
 * validation provably touched nothing, so it must carry the disposition.
 */
function refusal(payload: unknown): ToolResult {
  return preEffectRefusal("ImagineVideo", safeStringify(payload));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

const VALID_ASPECT = new Set([
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
]);
const VALID_RESOLUTIONS = new Set(["480p", "720p"]);
const TEXT_TO_VIDEO_MODEL = "grok-imagine-video";
const IMAGE_TO_VIDEO_MODEL = "grok-imagine-video-1.5-preview";
const MAX_REFERENCE_IMAGES = 7;
const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";

/** Sora's own list, read back from its rejection of an unknown model. */
const OPENAI_VIDEO_MODELS = Object.freeze(
  new Set([
    "sora-2",
    "sora-2-pro",
    "sora-2-2025-10-06",
    "sora-2-pro-2025-10-06",
    "sora-2-2025-12-08",
  ]),
);
/** Sora accepts these three durations and nothing between them. */
const OPENAI_VIDEO_SECONDS = Object.freeze([4, 8, 12]);
const OPENAI_VIDEO_SIZES = Object.freeze({
  "16:9": Object.freeze({ "720p": "1280x720", "1080p": "1792x1024" }),
  "9:16": Object.freeze({ "720p": "720x1280", "1080p": "1024x1792" }),
});
const OPENAI_VIDEO_RESOLUTIONS = Object.freeze(new Set(["720p", "1080p"]));

const MINIMAX_VIDEO_MODELS = Object.freeze(
  new Set([
    "MiniMax-H3",
    "MiniMax-H3-Max",
    "MiniMax-Hailuo-02",
    "MiniMax-Hailuo-2.3",
    "MiniMax-Hailuo-2.3-fast",
    "T2V-01",
    "T2V-01-Director",
    "I2V-01",
    "I2V-01-Director",
    "I2V-01-live",
  ]),
);
const MINIMAX_TEXT_TO_VIDEO_MODEL = "MiniMax-Hailuo-02";
const MINIMAX_VIDEO_DURATIONS = Object.freeze([6, 10]);
const MINIMAX_VIDEO_RESOLUTIONS = Object.freeze(
  new Set(["512P", "768P", "1080P"]),
);
/**
 * MiniMax refuses 512P unless a first frame is supplied: "param 'resolution'
 * 512P is only supported when param 'first_frame_image' provided".
 */
const MINIMAX_FIRST_FRAME_ONLY_RESOLUTION = "512P";
/**
 * The H3 generation lives on MiniMax's v2 task API (platform.minimax.io,
 * 2026-09-11). H3 renders 768P or 2K for 4 to 15 seconds; H3-Max renders
 * 480P or 768P for 5 to 15 seconds. Hailuo stays on the v1 route above.
 */
const MINIMAX_V2_VIDEO_MODELS = Object.freeze(
  new Set(["MiniMax-H3", "MiniMax-H3-Max"]),
);
const MINIMAX_V2_VIDEO_RESOLUTIONS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  "MiniMax-H3": Object.freeze(["768P", "2K"]),
  "MiniMax-H3-Max": Object.freeze(["480P", "768P"]),
});
const MINIMAX_V2_VIDEO_DURATIONS: Readonly<
  Record<string, readonly [number, number]>
> = Object.freeze({
  "MiniMax-H3": [4, 15],
  "MiniMax-H3-Max": [5, 15],
});
/** Text-to-video on v2 requires a concrete ratio; a first frame fixes it. */
const MINIMAX_V2_VIDEO_RATIOS = Object.freeze(
  new Set(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]),
);
const MINIMAX_V2_DEFAULT_RATIO = "16:9";

const MAX_VIDEO_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_VIDEO_DOWNLOAD_REDIRECTS = 5;

type VideoBackendKind = "xai" | "openai" | "minimax" | "openrouter" | "venice";

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_VENICE_BASE_URL = "https://api.venice.ai/api/v1";

interface ReviewedVideoModel {
  /** Seconds the model takes; a request snaps to the nearest. */
  readonly durations: readonly number[];
  /** USD per second of output by resolution: the reviewed ceiling. */
  readonly perSecond: Readonly<Record<string, number>>;
  readonly aspects: readonly string[];
}

const seconds = (from: number, to: number): readonly number[] =>
  Object.freeze(Array.from({ length: to - from + 1 }, (_, index) => from + index));

/**
 * Reviewed OpenRouter video models (GET /api/v1/videos/models pricing_skus,
 * 2026-10-20). 480p and 720p only, so one short clip stays cheap.
 */
const OPENROUTER_VIDEO_MODELS: ReadonlyMap<string, ReviewedVideoModel> = new Map<string, ReviewedVideoModel>([
  ["x-ai/grok-imagine-video-1.5-lite", Object.freeze({
    durations: seconds(1, 15), perSecond: Object.freeze({ "480p": 0.02, "720p": 0.03 }),
    aspects: Object.freeze(["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"]),
  })],
  ["alibaba/wan-3.0", Object.freeze({
    durations: seconds(2, 15), perSecond: Object.freeze({ "480p": 0.05, "720p": 0.1 }),
    aspects: Object.freeze(["16:9", "4:3", "1:1", "3:4", "9:16"]),
  })],
  ["google/veo-3.1-lite", Object.freeze({
    durations: Object.freeze([4, 6, 8]), perSecond: Object.freeze({ "720p": 0.08 }),
    aspects: Object.freeze(["16:9", "9:16"]),
  })],
]);
const OPENROUTER_DEFAULT_VIDEO_MODEL = "x-ai/grok-imagine-video-1.5-lite";

/**
 * Reviewed Venice text-to-video models. Venice publishes video prices only
 * through POST /video/quote; these ceilings come from quotes on 2026-10-20
 * (jobs/pv/probes/venice-video-quotes.json) and every call is quoted again
 * first and refused above its ceiling.
 */
const VENICE_VIDEO_MODELS: ReadonlyMap<string, ReviewedVideoModel> = new Map<string, ReviewedVideoModel>([
  ["grok-imagine-1-5-lite-text-to-video", Object.freeze({
    durations: seconds(1, 15), perSecond: Object.freeze({ "480p": 0.025, "720p": 0.036 }),
    aspects: Object.freeze(["16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"]),
  })],
  ["seedance-2-0-mini-text-to-video-basic", Object.freeze({
    durations: seconds(4, 15), perSecond: Object.freeze({ "480p": 0.045, "720p": 0.095 }),
    aspects: Object.freeze(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]),
  })],
  ["wan-3-0-text-to-video", Object.freeze({
    durations: Object.freeze([2, 5, 10, 15]), perSecond: Object.freeze({ "480p": 0.066, "720p": 0.13 }),
    aspects: Object.freeze(["16:9", "9:16", "1:1", "4:3", "3:4"]),
  })],
]);
const VENICE_DEFAULT_VIDEO_MODEL = "grok-imagine-1-5-lite-text-to-video";
/**
 * Any other text-to-video model in Venice's live list is accepted with the
 * call's own ceiling (`max_usd`): Venice prices video only by quote, and a
 * quote above the ceiling is refused before anything is queued.
 */
const VENICE_LISTED_VIDEO_DEFAULT_CEILING_USD = 1;
const VENICE_LISTED_VIDEO_MAX_CEILING_USD = 5;
const VIDEO_RESOLUTION_ORDER = ["256p", "360p", "480p", "540p", "580p", "720p", "768p", "1080p", "1440p", "4k"];

function listedVideoCeiling(args: Record<string, unknown>): number {
  const requested = typeof args.max_usd === "number" && Number.isFinite(args.max_usd) && args.max_usd > 0
    ? args.max_usd
    : VENICE_LISTED_VIDEO_DEFAULT_CEILING_USD;
  return Math.min(requested, VENICE_LISTED_VIDEO_MAX_CEILING_USD);
}

/** A Venice text-to-video row's durations (seconds), resolutions and aspect ratios. */
function listedVideoShape(row: VeniceMediaModel | undefined): {
  readonly durations: readonly number[];
  readonly resolutions: readonly string[];
  readonly aspects: readonly string[];
} | undefined {
  if (row?.type !== "video" || row.constraints.model_type !== "text-to-video") return undefined;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const durations = strings(row.constraints.durations)
    .map(value => Number.parseFloat(value))
    .filter(value => Number.isFinite(value) && value > 0);
  // Venice spells some tiers in capitals (480P); order them case-blind and
  // send the model's own spelling.
  const rank = (value: string): number => {
    const index = VIDEO_RESOLUTION_ORDER.indexOf(value.toLowerCase());
    return index < 0 ? VIDEO_RESOLUTION_ORDER.length : index;
  };
  const resolutions = strings(row.constraints.resolutions).sort((a, b) => rank(a) - rank(b));
  if (durations.length === 0 || resolutions.length === 0) return undefined;
  return { durations, resolutions, aspects: strings(row.constraints.aspect_ratios) };
}
const GATEWAY_DEFAULT_VIDEO_SECONDS = 4;
const GATEWAY_DEFAULT_VIDEO_RESOLUTION = "480p";

interface GatewayVideoPlan {
  readonly model: string;
  readonly duration: number;
  readonly resolution: string;
  readonly aspectRatio: string;
  readonly ceilingUsd: number;
  readonly ignoredControls: readonly string[];
}

/** The model, duration, resolution and price ceiling one call will use. */
function planGatewayVideo(
  kind: "openrouter" | "venice",
  args: Record<string, unknown>,
  listed?: ReadonlyMap<string, VeniceMediaModel>,
): GatewayVideoPlan | { readonly error: string } {
  const catalog = kind === "openrouter" ? OPENROUTER_VIDEO_MODELS : VENICE_VIDEO_MODELS;
  const model = stringValue(args.model) ??
    (kind === "openrouter" ? OPENROUTER_DEFAULT_VIDEO_MODEL : VENICE_DEFAULT_VIDEO_MODEL);
  const reviewed = catalog.get(model);
  if (reviewed === undefined && kind === "venice") {
    const shape = listedVideoShape(listed?.get(model));
    if (shape === undefined) {
      const names = listed === undefined
        ? [...catalog.keys()]
        : [...listed.values()].filter(row => listedVideoShape(row) !== undefined).map(row => row.id);
      return { error: `Venice video model must be a text-to-video model in Venice's list: ${names.join(", ")}` };
    }
    const ignoredControls: string[] = [];
    const duration = snapDuration(requestedDuration(args), shape.durations,
      snapDuration(GATEWAY_DEFAULT_VIDEO_SECONDS, shape.durations, shape.durations[0]!));
    const requestedResolution = stringValue(args.resolution)?.toLowerCase();
    const listedSpelling = (wanted: string): string | undefined =>
      shape.resolutions.find(value => value.toLowerCase() === wanted);
    const resolution = (requestedResolution === undefined ? undefined : listedSpelling(requestedResolution)) ??
      listedSpelling(GATEWAY_DEFAULT_VIDEO_RESOLUTION) ?? shape.resolutions[0]!;
    if (requestedResolution !== undefined && requestedResolution !== resolution.toLowerCase()) ignoredControls.push("resolution");
    const requestedAspect = stringValue(args.aspect_ratio);
    const aspectRatio = requestedAspect !== undefined && shape.aspects.includes(requestedAspect)
      ? requestedAspect : shape.aspects[0] ?? "";
    if (requestedAspect !== undefined && requestedAspect !== aspectRatio) ignoredControls.push("aspect_ratio");
    return { model, duration, resolution, aspectRatio, ignoredControls, ceilingUsd: listedVideoCeiling(args) };
  }
  if (reviewed === undefined) {
    return { error: `${kind === "openrouter" ? "OpenRouter" : "Venice"} video model must be one of ${[...catalog.keys()].join(", ")}` };
  }
  const ignoredControls: string[] = [];
  const duration = snapDuration(requestedDuration(args), reviewed.durations,
    snapDuration(GATEWAY_DEFAULT_VIDEO_SECONDS, reviewed.durations, reviewed.durations[0]!));
  const requestedResolution = stringValue(args.resolution)?.toLowerCase();
  const resolutions = Object.keys(reviewed.perSecond);
  const resolution = requestedResolution !== undefined && resolutions.includes(requestedResolution)
    ? requestedResolution
    : resolutions.includes(GATEWAY_DEFAULT_VIDEO_RESOLUTION) ? GATEWAY_DEFAULT_VIDEO_RESOLUTION : resolutions[0]!;
  if (requestedResolution !== undefined && requestedResolution !== resolution) ignoredControls.push("resolution");
  const requestedAspect = stringValue(args.aspect_ratio);
  const aspectRatio = requestedAspect !== undefined && reviewed.aspects.includes(requestedAspect)
    ? requestedAspect : reviewed.aspects[0]!;
  if (requestedAspect !== undefined && requestedAspect !== aspectRatio) ignoredControls.push("aspect_ratio");
  return {
    model, duration, resolution, aspectRatio, ignoredControls,
    ceilingUsd: reviewed.perSecond[resolution]! * duration,
  };
}

interface VideoBackend {
  readonly kind: VideoBackendKind;
  readonly baseURL: string;
  readonly bearer: string;
}

/**
 * What a backend is allowed to download from, stated per backend so that a
 * new one cannot inherit another's hosts through a fallthrough.
 *
 * `none` is the strongest: the backend never follows a URL out of a response
 * body at all. `hosts` pins an observed CDN. `any-https` is the honest
 * encoding of an unestablished fact rather than a guess: this repo has never
 * captured a finished xAI video URL, and this team's account cannot produce
 * one (see the ZDR note on the xAI runner), so narrowing it here would be an
 * unverified behaviour change to a shipped path. Those downloads still get
 * credential-free HTTPS, hop-by-hop redirect checks and the byte cap.
 */
type VideoDownloadPolicy =
  | { readonly kind: "none" }
  | { readonly kind: "hosts"; readonly suffixes: readonly string[] }
  | { readonly kind: "any-https" };

const VIDEO_DOWNLOAD_POLICY: Readonly<
  Record<VideoBackendKind, VideoDownloadPolicy>
> = Object.freeze({
  // Observed: video-product.cdn.minimax.io
  minimax: { kind: "hosts", suffixes: ["minimax.io", "minimaxi.com"] },
  // Streams from the API host under the same bearer; no payload URL exists.
  openai: { kind: "none" },
  // OpenRouter streams the MP4 from its API host under the session's key.
  openrouter: { kind: "none" },
  // Venice returns some videos inline and others (Grok Imagine models,
  // observed 2026-10-20) behind a pre-signed private-share.venice.ai link.
  venice: { kind: "hosts", suffixes: ["venice.ai"] },
  xai: { kind: "any-https" },
});

type VideoBackendResolution =
  | { readonly backend: VideoBackend; readonly authority: ToolCallAuthority }
  | { readonly error: string };

/**
 * A canonical media key with its own URL (or the provider's default), one
 * pair from one environment; never paired with a session's endpoint.
 */
function environmentVideoBackend(
  kind: "openai" | "minimax",
  env: NodeJS.ProcessEnv,
): VideoBackend | undefined {
  const credential = resolveProviderApiKeyEnvironment(kind, env);
  if (credential === undefined) return undefined;
  const environmentBaseURL = resolveProviderBaseURLEnvironment(kind, env)?.value;
  const baseURL = kind === "openai"
    ? environmentBaseURL ?? DEFAULT_OPENAI_BASE_URL
    : environmentBaseURL ?? DEFAULT_MINIMAX_BASE_URL;
  try {
    new URL(baseURL);
  } catch {
    return undefined;
  }
  return {
    kind,
    baseURL: baseURL.replace(/\/$/, ""),
    bearer: credential.value,
  };
}

/**
 * Resolve a media backend independently from the reasoning provider.
 *
 * A session generates with its own provider first, the way ImagineImage
 * already works. Only a direct Grok session may contribute its factory
 * bearer or URL; Meta/OpenAI/etc credentials must never cross the xAI trust
 * boundary, and an OpenAI session's bearer may be a ChatGPT OAuth grant,
 * which does not authorize /videos at all. Both new backends therefore read
 * only their canonical API-key ingress.
 */
/**
 * An OpenRouter or Venice session's own video route: its own factory key
 * with its own base URL, or, for a session without a factory key, that
 * provider's canonical key with its canonical URL from the session's
 * environment. The managed AgenC route lends no credential to media.
 */
function gatewayVideoBackend(
  kind: "openrouter" | "venice",
  provider: unknown,
  env: NodeJS.ProcessEnv,
): VideoBackend | undefined {
  if (isManagedProviderRoute(provider)) return undefined;
  const defaultBaseURL = kind === "openrouter" ? DEFAULT_OPENROUTER_BASE_URL : DEFAULT_VENICE_BASE_URL;
  const own = sessionApiKeyRoute(provider, defaultBaseURL);
  if (own !== undefined) return { kind, ...own };
  const credential = resolveProviderApiKeyEnvironment(kind, env);
  if (credential === undefined) return undefined;
  const baseURL = resolveProviderBaseURLEnvironment(kind, env)?.value ?? defaultBaseURL;
  try {
    new URL(baseURL);
  } catch {
    return undefined;
  }
  return { kind, baseURL: baseURL.replace(/\/$/, ""), bearer: credential.value };
}

/**
 * The backend for a call, all of it from the session that made it (`args`;
 * a sub-agent runs its parent's tool): its own provider's key and endpoint
 * as its model calls use them, or a separate backend's key and URL from its
 * own environment and credential home (session-provider-authority.ts). It
 * never pairs that session's endpoint with another session's credential and
 * never falls back to the parent's.
 */
function resolveVideoBackend(
  opts: ImagineVideoToolOptions,
  args?: Readonly<Record<string, unknown>>,
): VideoBackendResolution {
  const call = toolCallSession(readInvokingSession(args), opts.getSession);
  const session = call.session;
  const authority = resolveToolCallAuthority(
    "ImagineVideo", call, { env: opts.env, home: opts.home }, true,
  );
  if ("error" in authority) return authority;
  // Present whenever the authority resolved (it was required above).
  if (authority.credentialHome === undefined) {
    return { error: "ImagineVideo cannot run: this session has no credential home of its own." };
  }
  const resolution = resolveVideoBackendWith(
    authority, session?.services?.provider, authority.credentialHome,
  );
  return "backend" in resolution ? { backend: resolution.backend, authority } : resolution;
}

function resolveVideoBackendWith(
  authority: ToolCallAuthority,
  provider: unknown,
  home: HomeContext,
): { readonly backend: VideoBackend } | { readonly error: string } {
  const env = authority.environment;
  const providerIdentity = readProviderIdentity(provider as never);
  let oauthBaseUrlError: string | undefined;

  // An OpenRouter or Venice session generates with its own key and nobody
  // else's; neither backend is offered to sessions of other providers.
  if (
    (providerIdentity === "openrouter" || providerIdentity === "venice") &&
    provider !== undefined
  ) {
    const backend = gatewayVideoBackend(providerIdentity, provider, env);
    if (backend !== undefined) return { backend };
  }

  // An OpenAI or MiniMax session generates with its own API key and URL. A
  // ChatGPT sign-in does not authorize /videos, so a session on that grant
  // uses the canonical key with its canonical URL instead.
  if ((providerIdentity === "openai" || providerIdentity === "minimax") && provider !== undefined) {
    const own = sessionApiKeyRoute(
      provider,
      providerIdentity === "openai" ? DEFAULT_OPENAI_BASE_URL : DEFAULT_MINIMAX_BASE_URL,
    );
    const backend: VideoBackend | undefined = own !== undefined
      ? { kind: providerIdentity, ...own }
      : environmentVideoBackend(providerIdentity, env);
    if (backend !== undefined) return { backend };
  }

  // A Grok session's xAI authority is its own (the sign-in or key its model
  // calls use, with its own URL and selection); it never takes the
  // independent xAI backend below.
  const grokSession = providerIdentity === "grok" && provider !== undefined;
  if (grokSession) {
    const own = sessionXaiRoute(provider, DEFAULT_XAI_BASE_URL);
    if (own !== undefined && "error" in own) {
      oauthBaseUrlError = own.error;
    } else if (own !== undefined) {
      return { backend: { kind: "xai", baseURL: own.baseURL, bearer: own.bearer } };
    }
  }

  // Another provider's session uses only independent xAI authority, resolved
  // from its own environment and credential home.
  const xaiResolution: { readonly bearer?: string; readonly oauthBaseUrlError?: string } = grokSession
    ? {}
    : tryResolveXaiBearerTokenForBaseUrl(
      home, env,
      resolveProviderBaseURLEnvironment("grok", env)?.value ?? DEFAULT_XAI_BASE_URL,
    );
  oauthBaseUrlError ??= xaiResolution.oauthBaseUrlError;
  const bearer = xaiResolution.bearer;
  if (bearer !== undefined) {
    const baseURL =
      resolveProviderBaseURLEnvironment("grok", env)?.value ??
      DEFAULT_XAI_BASE_URL;
    if (!isDirectXaiInferenceHost(baseURL)) {
      const fallback =
        environmentVideoBackend("openai", env) ??
        environmentVideoBackend("minimax", env);
      if (fallback !== undefined) return { backend: fallback };
      return {
        error:
          "ImagineVideo's independent xAI backend must use a direct xAI host (api.x.ai).",
      };
    }
    return {
      backend: { kind: "xai", baseURL: baseURL.replace(/\/$/, ""), bearer },
    };
  }

  const independent =
    environmentVideoBackend("openai", env) ??
    environmentVideoBackend("minimax", env);
  if (independent !== undefined) return { backend: independent };

  return {
    error: oauthBaseUrlError ??
      "ImagineVideo needs a media credential: OPENAI_API_KEY for Sora, " +
      "MINIMAX_API_KEY for Hailuo, or an independent xAI media credential " +
      "via /grok-login, XAI_API_KEY, or GROK_API_KEY.",
  };
}

/** Whether this request has a usable, credential-isolated video backend. */
export function hasImagineVideoBackend(
  opts: ImagineVideoToolOptions,
): boolean {
  return "backend" in resolveVideoBackend(opts);
}

function validatedVideoDownloadUrl(value: string, kind: VideoBackendKind): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Video download URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Video download URL must use credential-free HTTPS");
  }
  const policy = VIDEO_DOWNLOAD_POLICY[kind];
  if (policy.kind === "any-https") return url;
  const hostname = url.hostname.toLowerCase();
  const trusted =
    policy.kind === "hosts" &&
    policy.suffixes.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    );
  if (!trusted) {
    throw new Error(`Video download host is not trusted for the ${kind} backend`);
  }
  return url;
}

/**
 * Stream a finished video through a hard byte cap.
 *
 * Redirects are followed by hand so every hop is re-checked against the
 * backend's hosts: a signed URL is provider-controlled, and a 302 off the
 * allowlist would otherwise be followed silently.
 */
async function downloadVideo(
  fetchImpl: typeof fetch,
  value: string,
  kind: VideoBackendKind,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  let current = validatedVideoDownloadUrl(value, kind);
  for (
    let redirects = 0;
    redirects <= MAX_VIDEO_DOWNLOAD_REDIRECTS;
    redirects += 1
  ) {
    const response = await fetchImpl(current, {
      redirect: "manual",
      ...(signal === undefined ? {} : { signal }),
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = validatedVideoDownloadUrl(
        new URL(location, current).toString(),
        kind,
      );
      continue;
    }
    if (!response.ok) {
      throw new Error(`Failed to download video (HTTP ${response.status})`);
    }
    return await readCappedBody(response);
  }
  throw new Error("Video download exceeded the redirect limit");
}

async function readCappedBody(response: Response): Promise<Buffer> {
  if (response.body === null) {
    throw new Error("Video download returned an empty body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_VIDEO_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw new Error("Video download exceeds the 256 MiB limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function imageRefToUrl(
  value: string,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const ref = value.trim();
  if (!ref) return undefined;
  const lower = ref.toLowerCase();
  if (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("data:image/")
  ) {
    return ref;
  }
  const path = isAbsolute(ref) ? ref : join(workspaceRoot, ref);
  if (!existsSync(path)) return undefined;
  const bytes = await readFile(path, { signal });
  const ext = path.toLowerCase();
  const mime = ext.endsWith(".png")
    ? "image/png"
    : ext.endsWith(".webp")
      ? "image/webp"
      : "image/jpeg";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        signal?.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortSignalFromArgs(
  args: Record<string, unknown>,
): AbortSignal | undefined {
  const signal = args.__abortSignal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/** Nearest value a backend actually accepts, ties resolving downward. */
function snapDuration(
  requested: number | undefined,
  allowed: readonly number[],
  fallback: number,
): number {
  if (requested === undefined || !Number.isFinite(requested)) return fallback;
  let best = allowed[0]!;
  for (const candidate of allowed) {
    if (Math.abs(candidate - requested) < Math.abs(best - requested)) {
      best = candidate;
    }
  }
  return best;
}

function requestedDuration(args: Record<string, unknown>): number | undefined {
  return typeof args.duration === "number" && Number.isFinite(args.duration)
    ? Math.floor(args.duration)
    : undefined;
}

type PollOutcome<T> =
  | { readonly state: "done"; readonly value: T }
  /** `waitMs`: how long the provider says the job takes (Venice's P80 estimate). */
  | { readonly state: "pending"; readonly status: string; readonly waitMs?: number }
  | { readonly state: "failed"; readonly error: string };

/**
 * The longest a call waits for a provider that says its job takes longer than
 * the default poll (Venice reports a P80 estimate; longcat-distilled lists
 * 13.6 minutes, observed 2026-10-20). The tool's own timeout covers it.
 */
const MAX_ESTIMATED_VIDEO_WAIT_MS = 20 * 60_000;

/**
 * The submit-then-poll wait shared by all three backends. Only the probe
 * differs; the interval, the deadline and the cancellation point do not.
 */
async function pollForVideo<T>(
  opts: ImagineVideoToolOptions,
  signal: AbortSignal | undefined,
  probe: () => Promise<PollOutcome<T>>,
): Promise<{ readonly value: T } | { readonly error: string }> {
  const interval = opts.pollIntervalMs ?? 5_000;
  let timeout = opts.pollTimeoutMs ?? 240_000;
  let elapsed = 0;
  let lastStatus = "queued";
  while (elapsed < timeout) {
    const outcome = await probe();
    if (outcome.state === "done") return { value: outcome.value };
    if (outcome.state === "failed") return { error: outcome.error };
    lastStatus = outcome.status;
    // Wait about half again the provider's own estimate, never past the cap.
    if (outcome.waitMs !== undefined && Number.isFinite(outcome.waitMs) && outcome.waitMs > 0) {
      timeout = Math.max(timeout, Math.min(Math.ceil(outcome.waitMs * 1.5), MAX_ESTIMATED_VIDEO_WAIT_MS));
    }
    await sleep(interval, signal);
    elapsed += interval;
  }
  return {
    error: `Imagine video timed out after ${timeout}ms (last status: ${lastStatus})`,
  };
}

async function saveVideoBytes(
  workspaceRoot: string,
  bytes: Buffer,
  signal: AbortSignal | undefined,
): Promise<string> {
  const outDir = join(workspaceRoot, ".agenc", "imagine");
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, `imagine-video-${randomUUID()}.mp4`);
  await writeFile(path, bytes, { signal });
  return path;
}

interface VideoRunContext {
  readonly opts: ImagineVideoToolOptions;
  readonly backend: VideoBackend;
  /** The calling session's authority; `fetchImpl` sends through its transport. */
  readonly authority: ToolCallAuthority;
  readonly fetchImpl: typeof fetch;
  readonly signal: AbortSignal | undefined;
  readonly args: Record<string, unknown>;
  readonly prompt: string;
  readonly imageUrl: string | undefined;
  readonly referenceImages: readonly { url: string }[];
}

function authHeaders(backend: VideoBackend): Record<string, string> {
  return {
    authorization: `Bearer ${backend.bearer}`,
    "content-type": "application/json",
  };
}

function signalInit(signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? {} : { signal };
}

// ── xAI ───────────────────────────────────────────────────────────────

async function runXaiVideo(ctx: VideoRunContext): Promise<ToolResult> {
  const { args, backend, fetchImpl, signal } = ctx;
  const modality =
    ctx.imageUrl || ctx.referenceImages.length > 0 ? "image" : "text";
  const model =
    stringValue(args.model) ??
    (modality === "image" ? IMAGE_TO_VIDEO_MODEL : TEXT_TO_VIDEO_MODEL);

  let duration = requestedDuration(args) ?? 8;
  if (duration < 1) duration = 1;
  if (duration > 15) duration = 15;
  if (ctx.referenceImages.length > 0 && duration > 10) duration = 10;

  let aspect_ratio = stringValue(args.aspect_ratio) ?? "16:9";
  if (!VALID_ASPECT.has(aspect_ratio)) aspect_ratio = "16:9";
  let resolution = (stringValue(args.resolution) ?? "720p").toLowerCase();
  if (!VALID_RESOLUTIONS.has(resolution)) resolution = "720p";

  const body: Record<string, unknown> = {
    model,
    prompt: ctx.prompt,
    duration,
    aspect_ratio,
    resolution,
  };
  if (ctx.imageUrl) body.image = { url: ctx.imageUrl };
  if (ctx.referenceImages.length > 0) {
    body.reference_images = ctx.referenceImages;
  }

  const submitRes = await fetchImpl(`${backend.baseURL}/videos/generations`, {
    method: "POST",
    headers: { ...authHeaders(backend), "x-idempotency-key": randomUUID() },
    body: JSON.stringify(body),
    ...signalInit(signal),
  });
  const submitJson = (await submitRes.json()) as {
    request_id?: string;
    error?: string | { message?: string };
  };
  if (!submitRes.ok) {
    return json({ error: xaiSubmitError(submitJson, submitRes.status) }, true);
  }
  const requestId = submitJson.request_id;
  if (!requestId) {
    return json(
      { error: "xAI video response did not include request_id" },
      true,
    );
  }

  const polled = await pollForVideo(ctx.opts, signal, async () => {
    const pollRes = await fetchImpl(`${backend.baseURL}/videos/${requestId}`, {
      method: "GET",
      headers: authHeaders(backend),
      ...signalInit(signal),
    });
    const pollJson = (await pollRes.json()) as Record<string, unknown> & {
      status?: string;
      error?: { message?: string };
      video?: { url?: string };
      url?: string;
    };
    if (!pollRes.ok) {
      return {
        state: "failed",
        error:
          pollJson.error?.message ?? `Imagine video poll HTTP ${pollRes.status}`,
      };
    }
    const status = String(pollJson.status ?? "").toLowerCase();
    if (status === "done") return { state: "done", value: pollJson };
    if (
      status === "failed" ||
      status === "error" ||
      status === "expired" ||
      status === "cancelled"
    ) {
      return {
        state: "failed",
        error: `Imagine video ${status}: ${
          pollJson.error?.message ?? "upstream failure"
        }`,
      };
    }
    return { state: "pending", status };
  });
  if ("error" in polled) {
    return json({ error: polled.error, request_id: requestId }, true);
  }

  const doneBody = polled.value;
  const videoUrl =
    (doneBody.video as { url?: string } | undefined)?.url ??
    (typeof doneBody.url === "string" ? doneBody.url : undefined);
  if (!videoUrl) {
    return json(
      {
        error: "Imagine video completed but returned no video URL",
        request_id: requestId,
        status: "done",
      },
      true,
    );
  }

  const bytes = await downloadVideo(fetchImpl, videoUrl, "xai", signal);
  const path = await saveVideoBytes(ctx.opts.workspaceRoot, bytes, signal);
  return json({
    model,
    path,
    url: videoUrl,
    request_id: requestId,
    duration,
    aspect_ratio,
    resolution,
    modality,
  });
}

/**
 * xAI reports media refusals as a bare `error` string, not the `{message}`
 * object the chat endpoints use. A Zero Data Retention team gets one of
 * these on every video call, so passing it through unchanged is the
 * difference between an operator seeing the cause and seeing "HTTP 400".
 */
function xaiSubmitError(
  payload: { readonly error?: string | { message?: string } },
  status: number,
): string {
  const raw = payload.error;
  if (typeof raw === "string" && raw.trim().length > 0) return raw;
  if (typeof raw === "object" && raw?.message) return raw.message;
  return `Imagine video submit HTTP ${status}`;
}

// ── OpenAI Sora ───────────────────────────────────────────────────────

async function runOpenAiVideo(ctx: VideoRunContext): Promise<ToolResult> {
  const { args, backend, fetchImpl, signal } = ctx;
  if (ctx.imageUrl || ctx.referenceImages.length > 0) {
    return refusal({
      error:
        "Sora image-to-video needs an uploaded reference and is not wired here; this backend is text-to-video only",
    });
  }
  const model = stringValue(args.model) ?? "sora-2";
  if (!OPENAI_VIDEO_MODELS.has(model)) {
    return refusal({
      error: `Sora model must be one of ${[...OPENAI_VIDEO_MODELS].join(", ")}`,
    });
  }
  // A dimension control the universal schema offers but this backend cannot
  // honour is dropped and named, never refused: the schema a model sees
  // before a Session attaches is the xAI one, and refusing what it advertised
  // stalls the run rather than correcting it.
  const ignoredControls: string[] = [];
  const requestedAspect = stringValue(args.aspect_ratio);
  const aspectSupported =
    requestedAspect === "16:9" || requestedAspect === "9:16";
  if (requestedAspect !== undefined && !aspectSupported) {
    ignoredControls.push("aspect_ratio");
  }
  const aspect_ratio = aspectSupported ? requestedAspect : "16:9";
  const requestedResolution = stringValue(args.resolution)?.toLowerCase();
  const resolutionSupported =
    requestedResolution !== undefined &&
    OPENAI_VIDEO_RESOLUTIONS.has(requestedResolution);
  if (requestedResolution !== undefined && !resolutionSupported) {
    ignoredControls.push("resolution");
  }
  const resolution = resolutionSupported ? requestedResolution : "720p";
  const size =
    OPENAI_VIDEO_SIZES[aspect_ratio][resolution as "720p" | "1080p"];
  const seconds = snapDuration(
    requestedDuration(args),
    OPENAI_VIDEO_SECONDS,
    8,
  );

  const submitRes = await fetchImpl(`${backend.baseURL}/videos`, {
    method: "POST",
    headers: authHeaders(backend),
    // Sora rejects unknown parameters outright, so nothing extra is sent.
    body: JSON.stringify({
      model,
      prompt: ctx.prompt,
      seconds: String(seconds),
      size,
    }),
    ...signalInit(signal),
  });
  const submitJson = (await submitRes.json()) as {
    id?: string;
    error?: { message?: string };
  };
  if (!submitRes.ok) {
    return json(
      {
        error:
          submitJson.error?.message ??
          `Sora video submit HTTP ${submitRes.status}`,
      },
      true,
    );
  }
  const videoId = submitJson.id;
  if (!videoId) {
    return json({ error: "Sora response did not include a video id" }, true);
  }

  const polled = await pollForVideo(ctx.opts, signal, async () => {
    const pollRes = await fetchImpl(`${backend.baseURL}/videos/${videoId}`, {
      method: "GET",
      headers: authHeaders(backend),
      ...signalInit(signal),
    });
    const pollJson = (await pollRes.json()) as {
      status?: string;
      progress?: number;
      error?: { message?: string };
    };
    if (!pollRes.ok) {
      return {
        state: "failed",
        error:
          pollJson.error?.message ?? `Sora video poll HTTP ${pollRes.status}`,
      };
    }
    const status = String(pollJson.status ?? "").toLowerCase();
    if (status === "completed") return { state: "done", value: status };
    if (status === "failed") {
      return {
        state: "failed",
        error: `Sora video failed: ${pollJson.error?.message ?? "upstream failure"}`,
      };
    }
    return { state: "pending", status };
  });
  if ("error" in polled) {
    return json({ error: polled.error, request_id: videoId }, true);
  }

  // The MP4 streams from the API host under the same bearer, so no
  // provider-supplied URL is ever followed for this backend.
  const contentRes = await fetchImpl(
    `${backend.baseURL}/videos/${videoId}/content`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${backend.bearer}` },
      ...signalInit(signal),
    },
  );
  if (!contentRes.ok) {
    return json(
      {
        error: `Failed to download Sora video (HTTP ${contentRes.status})`,
        request_id: videoId,
      },
      true,
    );
  }
  const bytes = await readCappedBody(contentRes);
  const path = await saveVideoBytes(ctx.opts.workspaceRoot, bytes, signal);
  return json({
    model,
    path,
    request_id: videoId,
    duration: seconds,
    aspect_ratio,
    resolution,
    size,
    modality: "text",
    ...(ignoredControls.length > 0 ? { ignoredControls } : {}),
  });
}

// ── MiniMax Hailuo ────────────────────────────────────────────────────

interface MinimaxEnvelope {
  readonly base_resp?: { readonly status_code?: number; readonly status_msg?: string };
}

/** MiniMax answers HTTP 200 for a rejected request; the outcome is in here. */
function minimaxFailure(payload: MinimaxEnvelope): string | undefined {
  const code = payload.base_resp?.status_code;
  if (code === 0) return undefined;
  return (
    payload.base_resp?.status_msg ??
    `MiniMax request failed with status ${code ?? "unknown"}`
  );
}

async function runMinimaxVideo(ctx: VideoRunContext): Promise<ToolResult> {
  const { args, backend, fetchImpl, signal } = ctx;
  if (ctx.referenceImages.length > 0) {
    return refusal({
      error:
        "MiniMax takes a single first frame; use image_url rather than reference_image_urls",
    });
  }
  const model = stringValue(args.model) ?? MINIMAX_TEXT_TO_VIDEO_MODEL;
  if (!MINIMAX_VIDEO_MODELS.has(model)) {
    return refusal({
      error: `MiniMax video model must be one of ${[...MINIMAX_VIDEO_MODELS].join(", ")}`,
    });
  }
  if (MINIMAX_V2_VIDEO_MODELS.has(model)) return runMinimaxV2Video(ctx, model);
  // MiniMax sizes a Hailuo video by resolution and model, so an aspect_ratio
  // from the universal schema is dropped and named rather than refused.
  const ignoredControls: string[] = [];
  if (stringValue(args.aspect_ratio) !== undefined) {
    ignoredControls.push("aspect_ratio");
  }
  const requestedResolution = stringValue(args.resolution);
  const resolutionSupported =
    requestedResolution !== undefined &&
    MINIMAX_VIDEO_RESOLUTIONS.has(requestedResolution);
  if (requestedResolution !== undefined && !resolutionSupported) {
    // 480p/720p are the xAI vocabulary; MiniMax grades in 512P/768P/1080P.
    ignoredControls.push("resolution");
  }
  const resolution = resolutionSupported ? requestedResolution : "768P";
  if (
    resolution === MINIMAX_FIRST_FRAME_ONLY_RESOLUTION &&
    ctx.imageUrl === undefined
  ) {
    return refusal({
      error:
        "MiniMax accepts 512P only with a first frame; pass image_url or choose 768P or 1080P",
    });
  }
  const duration = snapDuration(
    requestedDuration(args),
    MINIMAX_VIDEO_DURATIONS,
    6,
  );

  const submitRes = await fetchImpl(`${backend.baseURL}/video_generation`, {
    method: "POST",
    headers: authHeaders(backend),
    body: JSON.stringify({
      model,
      prompt: ctx.prompt,
      duration,
      resolution,
      ...(ctx.imageUrl === undefined
        ? {}
        : { first_frame_image: ctx.imageUrl }),
    }),
    ...signalInit(signal),
  });
  const submitJson = (await submitRes.json()) as MinimaxEnvelope & {
    task_id?: string;
  };
  if (!submitRes.ok) {
    return json(
      { error: `MiniMax video submit HTTP ${submitRes.status}` },
      true,
    );
  }
  const submitFailure = minimaxFailure(submitJson);
  if (submitFailure !== undefined) return json({ error: submitFailure }, true);
  const taskId = submitJson.task_id;
  if (!taskId) {
    return json({ error: "MiniMax response did not include a task_id" }, true);
  }

  const polled = await pollForVideo(ctx.opts, signal, async () => {
    const pollRes = await fetchImpl(
      `${backend.baseURL}/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
      { method: "GET", headers: authHeaders(backend), ...signalInit(signal) },
    );
    const pollJson = (await pollRes.json()) as MinimaxEnvelope & {
      status?: string;
      file_id?: string;
    };
    if (!pollRes.ok) {
      return {
        state: "failed",
        error: `MiniMax video poll HTTP ${pollRes.status}`,
      };
    }
    // Observed: Preparing → Processing → Success. Matched case-insensitively
    // so a capitalisation change upstream does not read as an unknown state.
    const status = String(pollJson.status ?? "").toLowerCase();
    if (status === "success") {
      const fileId = pollJson.file_id;
      if (!fileId) {
        return {
          state: "failed",
          error: "MiniMax reported success without a file_id",
        };
      }
      return { state: "done", value: fileId };
    }
    if (status === "fail") {
      return {
        state: "failed",
        error:
          minimaxFailure(pollJson) ?? "MiniMax video generation failed",
      };
    }
    const pollFailure = minimaxFailure(pollJson);
    if (pollFailure !== undefined) {
      return { state: "failed", error: pollFailure };
    }
    return { state: "pending", status };
  });
  if ("error" in polled) {
    return json({ error: polled.error, request_id: taskId }, true);
  }

  const fileRes = await fetchImpl(
    `${backend.baseURL}/files/retrieve?file_id=${encodeURIComponent(polled.value)}`,
    { method: "GET", headers: authHeaders(backend), ...signalInit(signal) },
  );
  const fileJson = (await fileRes.json()) as MinimaxEnvelope & {
    file?: { download_url?: string };
  };
  const fileFailure = minimaxFailure(fileJson);
  if (!fileRes.ok || fileFailure !== undefined) {
    return json(
      {
        error:
          fileFailure ?? `MiniMax file retrieve HTTP ${fileRes.status}`,
        request_id: taskId,
      },
      true,
    );
  }
  const downloadUrl = fileJson.file?.download_url;
  if (!downloadUrl) {
    return json(
      {
        error: "MiniMax returned no download URL for the finished video",
        request_id: taskId,
      },
      true,
    );
  }

  const bytes = await downloadVideo(fetchImpl, downloadUrl, "minimax", signal);
  const path = await saveVideoBytes(ctx.opts.workspaceRoot, bytes, signal);
  return json({
    model,
    path,
    url: downloadUrl,
    request_id: taskId,
    duration,
    resolution,
    modality: ctx.imageUrl === undefined ? "text" : "image",
    ...(ignoredControls.length > 0 ? { ignoredControls } : {}),
  });
}

// ── MiniMax H3 (v2 task API) ──────────────────────────────────────────

/** v2 answers a real HTTP status with an OpenAI-style error body. */
interface MinimaxV2ErrorEnvelope {
  readonly type?: string;
  readonly error?: { readonly type?: string; readonly message?: string };
}

function minimaxV2Failure(payload: MinimaxV2ErrorEnvelope): string | undefined {
  if (payload.type !== "error") return undefined;
  return payload.error?.message ?? "MiniMax request failed";
}

/** Hailuo lives under /v1; the H3 task API is the sibling /v2 on the host. */
function minimaxV2BaseURL(baseURL: string): string {
  return /\/v1$/.test(baseURL) ? baseURL.replace(/\/v1$/, "/v2") : `${baseURL}/v2`;
}

async function runMinimaxV2Video(
  ctx: VideoRunContext,
  model: string,
): Promise<ToolResult> {
  const { args, backend, fetchImpl, signal } = ctx;
  const ignoredControls: string[] = [];
  const resolutions = MINIMAX_V2_VIDEO_RESOLUTIONS[model] ?? [];
  const requestedResolution = stringValue(args.resolution)?.toUpperCase();
  const resolutionSupported =
    requestedResolution !== undefined &&
    resolutions.includes(requestedResolution);
  if (requestedResolution !== undefined && !resolutionSupported) {
    ignoredControls.push("resolution");
  }
  const resolution = resolutionSupported ? requestedResolution : "768P";
  const [minDuration, maxDuration] = MINIMAX_V2_VIDEO_DURATIONS[model] ?? [4, 15];
  const duration = Math.min(
    maxDuration,
    Math.max(minDuration, requestedDuration(args) ?? 6),
  );
  // Text-to-video must name a ratio; with a first frame the image decides
  // and the API treats anything else as adaptive anyway.
  const requestedRatio = stringValue(args.aspect_ratio);
  const ratioSupported =
    requestedRatio !== undefined && MINIMAX_V2_VIDEO_RATIOS.has(requestedRatio);
  if (requestedRatio !== undefined && !ratioSupported) {
    ignoredControls.push("aspect_ratio");
  }
  const ratio =
    ctx.imageUrl !== undefined
      ? "adaptive"
      : ratioSupported
        ? requestedRatio
        : MINIMAX_V2_DEFAULT_RATIO;
  const v2 = minimaxV2BaseURL(backend.baseURL);

  const submitRes = await fetchImpl(`${v2}/video_generation`, {
    method: "POST",
    headers: authHeaders(backend),
    body: JSON.stringify({
      model,
      content: [
        { type: "text", text: ctx.prompt },
        ...(ctx.imageUrl === undefined
          ? []
          : [{
              type: "image_url",
              image_url: { url: ctx.imageUrl },
              role: "first_frame",
            }]),
      ],
      resolution,
      duration,
      ratio,
    }),
    ...signalInit(signal),
  });
  const submitJson = (await submitRes.json()) as MinimaxV2ErrorEnvelope & {
    task_id?: string;
  };
  if (!submitRes.ok) {
    return json(
      {
        error:
          minimaxV2Failure(submitJson) ??
          `MiniMax video submit HTTP ${submitRes.status}`,
      },
      true,
    );
  }
  const taskId = submitJson.task_id;
  if (!taskId) {
    return json({ error: "MiniMax response did not include a task_id" }, true);
  }

  const polled = await pollForVideo(ctx.opts, signal, async () => {
    const pollRes = await fetchImpl(
      `${v2}/query/video_generation/${encodeURIComponent(taskId)}`,
      { method: "GET", headers: authHeaders(backend), ...signalInit(signal) },
    );
    const pollJson = (await pollRes.json()) as MinimaxV2ErrorEnvelope & {
      task?: {
        status?: string;
        content?: { url?: string };
        error?: { message?: string };
      };
    };
    if (!pollRes.ok) {
      return {
        state: "failed",
        error:
          minimaxV2Failure(pollJson) ??
          `MiniMax video poll HTTP ${pollRes.status}`,
      };
    }
    // Documented: queued → running → succeeded | failed | cancelled.
    const status = String(pollJson.task?.status ?? "").toLowerCase();
    if (status === "succeeded") {
      const url = pollJson.task?.content?.url;
      if (!url) {
        return {
          state: "failed",
          error: "MiniMax reported success without a video URL",
        };
      }
      return { state: "done", value: url };
    }
    if (status === "failed" || status === "cancelled") {
      return {
        state: "failed",
        error:
          pollJson.task?.error?.message ?? `MiniMax video generation ${status}`,
      };
    }
    return { state: "pending", status: status || "queued" };
  });
  if ("error" in polled) {
    return json({ error: polled.error, request_id: taskId }, true);
  }
  const bytes = await downloadVideo(fetchImpl, polled.value, "minimax", signal);
  const path = await saveVideoBytes(ctx.opts.workspaceRoot, bytes, signal);
  return json({
    model,
    path,
    url: polled.value,
    request_id: taskId,
    duration,
    resolution,
    ratio,
    modality: ctx.imageUrl === undefined ? "text" : "image",
    ...(ignoredControls.length > 0 ? { ignoredControls } : {}),
  });
}

// ── OpenRouter and Venice (session-native gateways) ───────────────────

function finiteCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function gatewayVideoResult(
  plan: GatewayVideoPlan,
  path: string,
  requestId: string,
  costUsd: number,
): ToolResult {
  return {
    ...json({
      model: plan.model,
      path,
      request_id: requestId,
      duration: plan.duration,
      aspect_ratio: plan.aspectRatio,
      resolution: plan.resolution,
      modality: "text",
      costUsd,
      ...(plan.ignoredControls.length > 0 ? { ignoredControls: plan.ignoredControls } : {}),
    }),
    admissionUsage: { inputTokens: 0, outputTokens: 0, costUsd },
  };
}

async function runOpenRouterVideo(ctx: VideoRunContext): Promise<ToolResult> {
  const { args, backend, fetchImpl, signal } = ctx;
  if (ctx.imageUrl || ctx.referenceImages.length > 0) {
    return refusal({ error: "This OpenRouter video backend is text-to-video only" });
  }
  const plan = planGatewayVideo("openrouter", args);
  if ("error" in plan) return refusal({ error: plan.error });
  const submitRes = await fetchImpl(`${backend.baseURL}/videos`, {
    method: "POST",
    headers: authHeaders(backend),
    body: JSON.stringify({
      model: plan.model,
      prompt: ctx.prompt,
      duration: plan.duration,
      resolution: plan.resolution,
      aspect_ratio: plan.aspectRatio,
    }),
    ...signalInit(signal),
  });
  const submitJson = (await submitRes.json()) as { id?: string; error?: { message?: string } | string };
  if (!submitRes.ok) {
    const message = (typeof submitJson.error === "string" ? submitJson.error : submitJson.error?.message) ??
      `OpenRouter video submit HTTP ${submitRes.status}`;
    // A refused submit generated nothing.
    return submitRes.status >= 400 && submitRes.status < 500
      ? refusal({ error: message })
      : json({ error: message }, true);
  }
  const videoId = submitJson.id;
  if (!videoId || !/^[\w-]+$/.test(videoId)) {
    return json({ error: "OpenRouter response did not include a usable video id" }, true);
  }
  const polled = await pollForVideo<number | undefined>(ctx.opts, signal, async () => {
    const pollRes = await fetchImpl(`${backend.baseURL}/videos/${videoId}`, {
      method: "GET",
      headers: authHeaders(backend),
      ...signalInit(signal),
    });
    const pollJson = (await pollRes.json()) as {
      status?: string;
      error?: { message?: string } | string;
      usage?: { cost?: number };
    };
    if (!pollRes.ok) {
      return { state: "failed", error: `OpenRouter video poll HTTP ${pollRes.status}` };
    }
    const status = String(pollJson.status ?? "").toLowerCase();
    if (status === "completed") return { state: "done", value: finiteCost(pollJson.usage?.cost) };
    if (status === "failed" || status === "cancelled" || status === "expired") {
      const detail = typeof pollJson.error === "string" ? pollJson.error : pollJson.error?.message;
      return { state: "failed", error: `OpenRouter video ${status}: ${detail ?? "upstream failure"}` };
    }
    return { state: "pending", status };
  });
  if ("error" in polled) return json({ error: polled.error, request_id: videoId }, true);
  // The MP4 streams from the API host under the same key; the response's
  // unsigned_urls are never followed.
  const contentRes = await fetchImpl(`${backend.baseURL}/videos/${videoId}/content?index=0`, {
    method: "GET",
    headers: { authorization: `Bearer ${backend.bearer}` },
    ...signalInit(signal),
  });
  if (!contentRes.ok) {
    return json({ error: `Failed to download the OpenRouter video (HTTP ${contentRes.status})`, request_id: videoId }, true);
  }
  const bytes = await readCappedBody(contentRes);
  const path = await saveVideoBytes(ctx.opts.workspaceRoot, bytes, signal);
  return gatewayVideoResult(plan, path, videoId, polled.value ?? plan.ceilingUsd);
}

async function runVeniceVideo(ctx: VideoRunContext): Promise<ToolResult> {
  const { args, backend, fetchImpl, signal } = ctx;
  if (ctx.imageUrl || ctx.referenceImages.length > 0) {
    return refusal({ error: "This Venice video backend is text-to-video only" });
  }
  const listed = VENICE_VIDEO_MODELS.has(stringValue(args.model) ?? VENICE_DEFAULT_VIDEO_MODEL)
    ? undefined
    : await loadVeniceMediaModels(
      { baseURL: backend.baseURL, bearer: backend.bearer, transport: ctx.authority.transportEnvironment },
      fetchImpl, signal);
  const plan = planGatewayVideo("venice", args, listed);
  if ("error" in plan) return refusal({ error: plan.error });
  const shape = {
    model: plan.model,
    duration: `${plan.duration}s`,
    resolution: plan.resolution,
    ...(plan.aspectRatio ? { aspect_ratio: plan.aspectRatio } : {}),
  };
  // Venice prices video only by quote; a quote above the reviewed ceiling
  // is refused before anything is queued.
  const quoteRes = await fetchImpl(`${backend.baseURL}/video/quote`, {
    method: "POST",
    headers: authHeaders(backend),
    body: JSON.stringify(shape),
    ...signalInit(signal),
  });
  const quoteJson = (await quoteRes.json()) as { quote?: number; error?: string };
  const quote = finiteCost(quoteJson.quote);
  if (!quoteRes.ok || quote === undefined) {
    return refusal({ error: quoteJson.error ?? `Venice video quote HTTP ${quoteRes.status}` });
  }
  if (quote > plan.ceilingUsd + 1e-9) {
    return refusal({
      error: VENICE_VIDEO_MODELS.has(plan.model)
        ? `Venice quoted ${quote} USD for this clip, above its reviewed ceiling of ${plan.ceilingUsd.toFixed(3)} USD`
        : `Venice quoted ${quote} USD for this clip, above max_usd ${plan.ceilingUsd.toFixed(3)} USD`,
    });
  }
  const queueRes = await fetchImpl(`${backend.baseURL}/video/queue`, {
    method: "POST",
    headers: authHeaders(backend),
    body: JSON.stringify({ ...shape, prompt: ctx.prompt }),
    ...signalInit(signal),
  });
  const queueJson = (await queueRes.json()) as { queue_id?: string; download_url?: string; error?: string };
  // Venice hands some models' result out once, as a pre-signed link on its
  // own domain; it is checked against the download guard before anything.
  let downloadUrl: string | undefined;
  if (typeof queueJson.download_url === "string" && queueJson.download_url.length > 0) {
    try {
      downloadUrl = validatedVideoDownloadUrl(queueJson.download_url, "venice").toString();
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Venice download link refused" }, true);
    }
  }
  if (!queueRes.ok) {
    const message = queueJson.error ?? `Venice video queue HTTP ${queueRes.status}`;
    return queueRes.status >= 400 && queueRes.status < 500
      ? refusal({ error: message })
      : json({ error: message }, true);
  }
  const queueId = queueJson.queue_id;
  if (!queueId || !/^[\w-]+$/.test(queueId)) {
    return json({ error: "Venice did not return a usable queue id" }, true);
  }
  const ticket = { model: plan.model, queue_id: queueId };
  const polled = await pollForVideo<Buffer | "download">(ctx.opts, signal, async () => {
    const retrieveRes = await fetchImpl(`${backend.baseURL}/video/retrieve`, {
      method: "POST",
      headers: authHeaders(backend),
      body: JSON.stringify(ticket),
      ...signalInit(signal),
    });
    const contentType = retrieveRes.headers.get("content-type")?.toLowerCase() ?? "";
    if (retrieveRes.ok && contentType.startsWith("video/")) {
      return { state: "done", value: await readCappedBody(retrieveRes) };
    }
    const status = (await retrieveRes.json().catch(() => ({}))) as {
      status?: string;
      error?: string;
      average_execution_time?: number;
    };
    if (!retrieveRes.ok) {
      return { state: "failed", error: status.error ?? `Venice video retrieve HTTP ${retrieveRes.status}` };
    }
    const state = String(status.status ?? "").toUpperCase();
    if (state === "FAILED" || state === "ERROR") {
      return { state: "failed", error: `Venice video failed: ${status.error ?? "upstream failure"}` };
    }
    if (state === "COMPLETED") {
      return downloadUrl !== undefined
        ? { state: "done", value: "download" as const }
        : { state: "failed", error: "Venice finished the video without returning it or a download link" };
    }
    // Venice reports how long this model's jobs take (P80, milliseconds).
    const estimate = typeof status.average_execution_time === "number" ? status.average_execution_time : undefined;
    return {
      state: "pending",
      status: state.toLowerCase() || "processing",
      ...(estimate === undefined ? {} : { waitMs: estimate }),
    };
  });
  if ("error" in polled) return json({ error: polled.error, request_id: queueId }, true);
  // The pre-signed link carries no key; the session's key never goes there.
  const bytes = polled.value === "download"
    ? await downloadVideo(fetchImpl, downloadUrl!, "venice", signal)
    : polled.value;
  const path = await saveVideoBytes(ctx.opts.workspaceRoot, bytes, signal);
  // Best effort: remove Venice's stored copy once the file is saved here
  // (DELETE revokes a pre-signed link; /video/complete deletes inline media).
  await (downloadUrl !== undefined
    ? fetchImpl(downloadUrl, { method: "DELETE", ...signalInit(signal) })
    : fetchImpl(`${backend.baseURL}/video/complete`, {
      method: "POST",
      headers: authHeaders(backend),
      body: JSON.stringify(ticket),
      ...signalInit(signal),
    })).catch(() => undefined);
  return gatewayVideoResult(plan, path, queueId, quote);
}

// ── Tool surface ──────────────────────────────────────────────────────

function imagineVideoDescription(kind: VideoBackendKind | undefined): string {
  switch (kind) {
    case "openrouter":
      return (
        "Generate a short video with OpenRouter on this session's OpenRouter key and save the MP4 under the workspace. " +
        "Text-to-video only; 480p or 720p, default 4 seconds at 480p."
      );
    case "venice":
      return (
        "Generate a short video with Venice on this session's Venice key and save the MP4 under the workspace. " +
        "Text-to-video only; 480p or 720p, default 4 seconds at 480p. Venice quotes the price first."
      );
    case "openai":
      return (
        "Generate a video with OpenAI Sora and save the MP4 under the workspace. " +
        "Text-to-video only; duration is 4, 8 or 12 seconds."
      );
    case "minimax":
      return (
        "Generate a video with MiniMax and save the MP4 under the workspace. " +
        "Text-to-video, or image-to-video by passing image_url as the first frame. " +
        "Hailuo (default) takes 6 or 10 seconds; model MiniMax-H3 takes 4 to 15 " +
        "seconds at 768P or 2K, MiniMax-H3-Max 5 to 15 seconds at 480P or 768P."
      );
    case "xai":
      return (
        "Generate a video with xAI Grok Imagine (text-to-video or image-to-video) " +
        "and save the MP4 under the workspace."
      );
    default:
      return (
        "Generate a video with the configured xAI, OpenAI Sora, MiniMax Hailuo, " +
        "OpenRouter or Venice media backend and save the MP4 under the workspace."
      );
  }
}

function imagineVideoInputSchema(
  kind: VideoBackendKind | undefined,
): Record<string, unknown> {
  const prompt = { type: "string" };
  if (kind === "openrouter" || kind === "venice") {
    const catalog = kind === "openrouter" ? OPENROUTER_VIDEO_MODELS : VENICE_VIDEO_MODELS;
    return {
      type: "object",
      properties: {
        prompt,
        model: kind === "openrouter"
          ? { type: "string", enum: [...catalog.keys()] }
          : {
            type: "string",
            description:
              `A Venice text-to-video model id (default ${VENICE_DEFAULT_VIDEO_MODEL}; any text-to-video model ` +
              "in Venice's model list, priced by Venice's quote).",
          },
        ...(kind === "venice"
          ? {
            max_usd: {
              type: "number",
              description:
                `Highest price in USD accepted for a model AgenC has not reviewed (default ` +
                `${VENICE_LISTED_VIDEO_DEFAULT_CEILING_USD}, at most ${VENICE_LISTED_VIDEO_MAX_CEILING_USD}); ` +
                "Venice quotes first and a higher quote is refused.",
            },
          }
          : {}),
        duration: {
          type: "number",
          description: `Seconds; snaps to what the model takes (default ${GATEWAY_DEFAULT_VIDEO_SECONDS})`,
        },
        aspect_ratio: { type: "string" },
        resolution: { type: "string", enum: ["480p", "720p"], description: "default 480p" },
      },
      required: ["prompt"],
      additionalProperties: false,
    };
  }
  if (kind === "openai") {
    return {
      type: "object",
      properties: {
        prompt,
        model: { type: "string", enum: [...OPENAI_VIDEO_MODELS] },
        duration: {
          type: "number",
          description: "Seconds: 4, 8 or 12; anything else snaps to the nearest (default 8)",
        },
        aspect_ratio: { type: "string", enum: ["16:9", "9:16"] },
        resolution: { type: "string", enum: [...OPENAI_VIDEO_RESOLUTIONS] },
      },
      required: ["prompt"],
      additionalProperties: false,
    };
  }
  if (kind === "minimax") {
    return {
      type: "object",
      properties: {
        prompt,
        model: { type: "string", enum: [...MINIMAX_VIDEO_MODELS] },
        image_url: {
          type: "string",
          description:
            "Optional first frame: image URL, data URI, or workspace path",
        },
        duration: {
          type: "number",
          description:
            "Seconds. Hailuo: 6 or 10, anything else snaps to the nearest. " +
            "MiniMax-H3: 4 to 15; MiniMax-H3-Max: 5 to 15 (default 6)",
        },
        resolution: {
          type: "string",
          enum: [...MINIMAX_VIDEO_RESOLUTIONS, "480P", "2K"],
          description:
            "Hailuo: 512P (requires image_url), 768P or 1080P. " +
            "MiniMax-H3: 768P or 2K. MiniMax-H3-Max: 480P or 768P",
        },
        aspect_ratio: {
          type: "string",
          enum: [...MINIMAX_V2_VIDEO_RATIOS],
          description:
            "MiniMax-H3 text-to-video only (default 16:9); Hailuo sizes by resolution",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    };
  }
  return {
    type: "object",
    properties: {
      prompt,
      model: {
        type: "string",
        description:
          "xAI: grok-imagine-video (text-to-video default) or grok-imagine-video-1.5-preview (image-to-video default); " +
          `OpenRouter: ${[...OPENROUTER_VIDEO_MODELS.keys()].join(", ")}; ` +
          `Venice: any Venice text-to-video model id (default ${VENICE_DEFAULT_VIDEO_MODEL})`,
      },
      // The schema a registry advertises before its session attaches is the
      // one the TUI keeps, so it carries every backend's controls.
      max_usd: {
        type: "number",
        description:
          `Venice: highest price in USD accepted for a model AgenC has not reviewed (default ` +
          `${VENICE_LISTED_VIDEO_DEFAULT_CEILING_USD}, at most ${VENICE_LISTED_VIDEO_MAX_CEILING_USD}); other backends ignore it`,
      },
      image_url: {
        type: "string",
        description:
          "Optional image URL, data URI, or workspace path for image-to-video",
      },
      reference_image_urls: {
        type: "array",
        items: { type: "string" },
        description: "Up to 7 reference images (not combined with image_url)",
      },
      duration: {
        type: "number",
        description: "Seconds 1–15 (max 10 with reference images); default 8",
      },
      aspect_ratio: { type: "string" },
      resolution: { type: "string", description: "e.g. 480p or 720p; snaps to what the model takes (default 480p)" },
    },
    required: ["prompt"],
    additionalProperties: false,
  };
}

export function createImagineVideoTool(opts: ImagineVideoToolOptions): Tool {
  // Same lifecycle rule as ImagineImage: before a Session is attached the
  // eventual provider can still change the backend, so the universal schema
  // stands until a concrete Session exists. Execution always re-resolves.
  const advertised =
    opts.getSession() === null ? undefined : resolveVideoBackend(opts);
  const advertisedKind =
    advertised !== undefined && "backend" in advertised
      ? advertised.backend.kind
      : undefined;
  const deferredUntilDiscovered =
    opts.getSession() === null;
  return {
    name: "ImagineVideo",
    description: imagineVideoDescription(advertisedKind),
    metadata: {
      family: "media",
      source: "builtin",
      hiddenByDefault: false,
      mutating: true,
      deferred: deferredUntilDiscovered,
      // The only write is the generated media file under this fixed
      // directory; no argument names a path, so the sandbox must be told
      // where the output lands or it denies the call as unverifiable.
      fixedWriteTargets: () => [join(opts.workspaceRoot, ".agenc", "imagine")],
      keywords: ["video", "generate", "media"],
      preferredProfiles: ["coding", "operator", "general"],
    },
    isReadOnly: false,
    requiresApproval: true,
    concurrencyClass: { kind: "exclusive" },
    // Video generation legitimately outlives the 30s default tool timeout: the
    // internal poll waits 240s (pollTimeoutMs), or up to 20 minutes when the
    // provider says the job takes longer (Venice's estimate), plus the
    // initial POST and the MP4 download. The harness backstop sits above that
    // so a healthy long generation is not killed mid-poll; the tool's own
    // internal timeouts still fire first with a clean error.
    timeoutMs: 22 * 60_000,
    recoveryCategory: "side-effecting",
    admissionEstimate: (args) => {
      // OpenRouter and Venice clips have a reviewed per-second ceiling.
      const resolution = resolveVideoBackend(opts, args);
      const kind = "backend" in resolution ? resolution.backend.kind : undefined;
      const listed = "backend" in resolution && kind === "venice"
        ? cachedVeniceMediaModels({
          baseURL: resolution.backend.baseURL,
          bearer: resolution.backend.bearer,
          transport: resolution.authority.transportEnvironment,
        })
        : undefined;
      const plan = kind === "openrouter" || kind === "venice" ? planGatewayVideo(kind, args, listed) : undefined;
      // A Venice model AgenC has not reviewed is bounded by the call's max_usd
      // whether or not its list has been read yet.
      const model = stringValue(args.model);
      const listedCeiling = kind === "venice" && model !== undefined && !VENICE_VIDEO_MODELS.has(model)
        ? listedVideoCeiling(args)
        : undefined;
      return {
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: plan !== undefined && !("error" in plan) ? plan.ceilingUsd : listedCeiling ?? null,
      };
    },
    inputSchema: imagineVideoInputSchema(advertisedKind),
    execute: async (args) => {
      const admittedSignal = abortSignalFromArgs(args);
      admittedSignal?.throwIfAborted();
      const backendResolution = resolveVideoBackend(opts, args);
      if ("error" in backendResolution) {
        return refusal({ error: backendResolution.error });
      }
      const { backend } = backendResolution;

      const prompt = stringValue(args.prompt);
      if (!prompt) return refusal({ error: "prompt is required" });

      const imageUrlRaw = stringValue(args.image_url);
      const imageUrl = imageUrlRaw
        ? await imageRefToUrl(imageUrlRaw, opts.workspaceRoot, admittedSignal)
        : undefined;

      const refRaw = Array.isArray(args.reference_image_urls)
        ? args.reference_image_urls.filter(
            (v): v is string => typeof v === "string" && v.trim().length > 0,
          )
        : [];
      if (imageUrl && refRaw.length > 0) {
        return refusal({
          error: "image_url and reference_image_urls cannot be combined on xAI",
        });
      }
      if (refRaw.length > MAX_REFERENCE_IMAGES) {
        return refusal({
          error: `reference_image_urls supports at most ${MAX_REFERENCE_IMAGES} images`,
        });
      }
      const referenceImages: { url: string }[] = [];
      for (const r of refRaw) {
        const url = await imageRefToUrl(r, opts.workspaceRoot, admittedSignal);
        if (url) referenceImages.push({ url });
      }

      const ctx: VideoRunContext = {
        opts,
        backend,
        authority: backendResolution.authority,
        // Every request goes out through the calling session's own proxy,
        // client certificate and CA trust.
        fetchImpl: withToolCallTransport(opts.fetchImpl ?? fetch, backendResolution.authority),
        signal: admittedSignal,
        args,
        prompt,
        imageUrl,
        referenceImages,
      };

      try {
        if (backend.kind === "openai") return await runOpenAiVideo(ctx);
        if (backend.kind === "minimax") return await runMinimaxVideo(ctx);
        if (backend.kind === "openrouter") return await runOpenRouterVideo(ctx);
        if (backend.kind === "venice") return await runVeniceVideo(ctx);
        return await runXaiVideo(ctx);
      } catch (error) {
        admittedSignal?.throwIfAborted();
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Imagine video request failed",
          },
          true,
        );
      }
    },
  };
}
