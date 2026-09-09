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

import {
  readProviderFactoryOptions,
  readProviderIdentity,
} from "../../llm/provider.js";
import {
  isDirectXaiInferenceHost,
  resolveXaiBearerToken,
} from "../../llm/xai-capability-config.js";
import {
  resolveProviderApiKeyEnvironment,
  resolveProviderBaseURLEnvironment,
} from "../../llm/registry/provider-ingress.js";
import type { Tool, ToolResult } from "../types.js";
import { preEffectRefusal } from "../results.js";
import { safeStringify } from "../types.js";
import type { HomeContext } from "../../config/home.js";

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

const MAX_VIDEO_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_VIDEO_DOWNLOAD_REDIRECTS = 5;

type VideoBackendKind = "xai" | "openai" | "minimax";

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
  xai: { kind: "any-https" },
});

type VideoBackendResolution =
  | { readonly backend: VideoBackend }
  | { readonly error: string };

function environmentVideoBackend(
  kind: "openai" | "minimax",
  env: NodeJS.ProcessEnv,
): VideoBackend | undefined {
  const credential = resolveProviderApiKeyEnvironment(kind, env);
  if (credential === undefined) return undefined;
  const baseURL =
    resolveProviderBaseURLEnvironment(kind, env)?.value ??
    (kind === "openai" ? DEFAULT_OPENAI_BASE_URL : DEFAULT_MINIMAX_BASE_URL);
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
function resolveVideoBackend(
  opts: ImagineVideoToolOptions,
): VideoBackendResolution {
  const env = opts.env ?? process.env;
  const provider = opts.getSession()?.services?.provider;
  const providerIdentity = readProviderIdentity(provider as never);

  if (providerIdentity === "openai" || providerIdentity === "minimax") {
    const backend = environmentVideoBackend(providerIdentity, env);
    if (backend !== undefined) return { backend };
  }

  if (providerIdentity === "grok" && provider !== undefined) {
    const factory = readProviderFactoryOptions(provider as never);
    if (isDirectXaiInferenceHost(factory.baseURL)) {
      const sessionKey =
        typeof factory.apiKey === "string" ? factory.apiKey : undefined;
      const bearer = resolveXaiBearerToken(opts.home, env, sessionKey);
      if (bearer !== undefined) {
        return {
          backend: {
            kind: "xai",
            baseURL: (factory.baseURL ?? DEFAULT_XAI_BASE_URL).replace(
              /\/$/,
              "",
            ),
            bearer,
          },
        };
      }
    }
  }

  // Never pass a non-Grok session key/base URL. A non-direct Grok session
  // also lands here and must supply independent xAI authority.
  const bearer = resolveXaiBearerToken(opts.home, env);
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
    error:
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
  | { readonly state: "pending"; readonly status: string }
  | { readonly state: "failed"; readonly error: string };

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
  const timeout = opts.pollTimeoutMs ?? 240_000;
  let elapsed = 0;
  let lastStatus = "queued";
  while (elapsed < timeout) {
    const outcome = await probe();
    if (outcome.state === "done") return { value: outcome.value };
    if (outcome.state === "failed") return { error: outcome.error };
    lastStatus = outcome.status;
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
  // MiniMax sizes a video by resolution and model, so an aspect_ratio from
  // the universal schema is dropped and named rather than refused.
  const ignoredControls: string[] = [];
  if (stringValue(args.aspect_ratio) !== undefined) {
    ignoredControls.push("aspect_ratio");
  }
  const model = stringValue(args.model) ?? MINIMAX_TEXT_TO_VIDEO_MODEL;
  if (!MINIMAX_VIDEO_MODELS.has(model)) {
    return refusal({
      error: `MiniMax video model must be one of ${[...MINIMAX_VIDEO_MODELS].join(", ")}`,
    });
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

// ── Tool surface ──────────────────────────────────────────────────────

function imagineVideoDescription(kind: VideoBackendKind | undefined): string {
  switch (kind) {
    case "openai":
      return (
        "Generate a video with OpenAI Sora and save the MP4 under the workspace. " +
        "Text-to-video only; duration is 4, 8 or 12 seconds."
      );
    case "minimax":
      return (
        "Generate a video with MiniMax Hailuo and save the MP4 under the workspace. " +
        "Text-to-video, or image-to-video by passing image_url as the first frame. " +
        "Duration is 6 or 10 seconds."
      );
    case "xai":
      return (
        "Generate a video with xAI Grok Imagine (text-to-video or image-to-video) " +
        "and save the MP4 under the workspace."
      );
    default:
      return (
        "Generate a video with the configured xAI, OpenAI Sora, or MiniMax Hailuo " +
        "media backend and save the MP4 under the workspace."
      );
  }
}

function imagineVideoInputSchema(
  kind: VideoBackendKind | undefined,
): Record<string, unknown> {
  const prompt = { type: "string" };
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
          description: "Seconds: 6 or 10; anything else snaps to the nearest (default 6)",
        },
        resolution: {
          type: "string",
          enum: [...MINIMAX_VIDEO_RESOLUTIONS],
          description: "512P requires image_url; text-to-video uses 768P or 1080P",
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
          "grok-imagine-video (text-to-video default) or grok-imagine-video-1.5-preview (image-to-video default)",
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
      resolution: { type: "string", enum: ["480p", "720p"] },
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
  return {
    name: "ImagineVideo",
    description: imagineVideoDescription(advertisedKind),
    isReadOnly: false,
    requiresApproval: true,
    concurrencyClass: { kind: "exclusive" },
    // Video generation legitimately outlives the 30s default tool timeout: the
    // internal poll alone waits up to 240s (pollTimeoutMs), plus the initial
    // POST and the MP4 download. Give the harness backstop 5min so a healthy
    // long generation isn't killed mid-poll; the tool's own internal timeouts
    // still fire first with a clean error.
    timeoutMs: 300_000,
    recoveryCategory: "side-effecting",
    admissionEstimate: () => ({
      maxInputTokens: 0,
      maxOutputTokens: 0,
      maxCostUsd: null,
    }),
    inputSchema: imagineVideoInputSchema(advertisedKind),
    execute: async (args) => {
      const admittedSignal = abortSignalFromArgs(args);
      admittedSignal?.throwIfAborted();
      const backendResolution = resolveVideoBackend(opts);
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
        fetchImpl: opts.fetchImpl ?? fetch,
        signal: admittedSignal,
        args,
        prompt,
        imageUrl,
        referenceImages,
      };

      try {
        if (backend.kind === "openai") return await runOpenAiVideo(ctx);
        if (backend.kind === "minimax") return await runMinimaxVideo(ctx);
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
