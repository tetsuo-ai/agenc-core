/**
 * LIVE image generation tool with provider-independent media backends.
 *
 * Backend routing (fail-closed and credential-isolated):
 * 1. Meta reasoning sessions prefer Meta Muse Image + MODEL_API_KEY.
 * 2. QwenCloud sessions prefer the matching PayGo or Token Plan image API.
 * 3. Z.AI reasoning sessions prefer GLM-Image + ZAI_API_KEY.
 * 4. Any reasoning provider may use independent xAI credentials.
 * 5. Direct Grok sessions retain their session bearer/base URL compatibility.
 *
 * @module
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
import { safeStringify } from "../types.js";
import type { HomeContext } from "../../config/home.js";

export interface ImagineImageToolOptions {
  readonly workspaceRoot: string;
  readonly home: HomeContext;
  readonly getSession: () => {
    services?: { provider?: unknown };
  } | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

function json(payload: unknown, isError?: boolean): ToolResult {
  return {
    content: safeStringify(payload),
    ...(isError ? { isError: true } : {}),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function abortSignalFromArgs(
  args: Record<string, unknown>,
): AbortSignal | undefined {
  const signal = args.__abortSignal;
  return signal instanceof AbortSignal ? signal : undefined;
}

const ALLOWED_ASPECT = new Set([
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
  "auto",
]);

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_META_BASE_URL = "https://api.meta.ai/v1";
const DEFAULT_QWEN_BASE_URL =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const DEFAULT_QWEN_TOKEN_PLAN_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const DEFAULT_ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";
const MAX_IMAGE_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_DOWNLOAD_REDIRECTS = 5;
const ZAI_GLM_IMAGE_COST_USD = 0.015;
const ZAI_COGVIEW_IMAGE_COST_USD = 0.01;

type ImageBackend =
  | {
      readonly kind: "meta";
      readonly baseURL: string;
      readonly bearer: string;
    }
  | {
      readonly kind: "xai";
      readonly baseURL: string;
      readonly bearer: string;
    }
  | {
      readonly kind: "qwen";
      readonly provider: "qwen" | "qwen-token-plan";
      readonly baseURL: string;
      readonly bearer: string;
    }
  | {
      readonly kind: "zai";
      readonly baseURL: string;
      readonly bearer: string;
    };

type BackendResolution =
  | { readonly backend: ImageBackend }
  | { readonly error: string };

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function qwenApiOrigin(baseURL: string): string | undefined {
  try {
    return new URL(baseURL).origin;
  } catch {
    return undefined;
  }
}

function isZaiCodingPlanBaseURL(baseURL: string): boolean {
  try {
    const pathname = new URL(baseURL).pathname.replace(/\/+$/u, "");
    return pathname.endsWith("/api/coding/paas/v4");
  } catch {
    return false;
  }
}

function validatedImageDownloadUrl(value: string, backend: ImageBackend): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Image download URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Image download URL must use credential-free HTTPS");
  }
  const hostname = url.hostname.toLowerCase();
  const trusted =
    backend.kind === "qwen"
      ? hostname === "aliyuncs.com" || hostname.endsWith(".aliyuncs.com")
      : backend.kind === "meta"
        ? hostname === "meta.ai" ||
          hostname.endsWith(".meta.ai") ||
          hostname === "fbcdn.net" ||
          hostname.endsWith(".fbcdn.net") ||
          hostname === "facebook.com" ||
          hostname.endsWith(".facebook.com")
        : backend.kind === "zai"
          ? hostname === "z.ai" ||
            hostname.endsWith(".z.ai") ||
            hostname === "bigmodel.cn" ||
            hostname.endsWith(".bigmodel.cn") ||
            hostname === "chatglm.cn" ||
            hostname.endsWith(".chatglm.cn")
          : hostname === "x.ai" || hostname.endsWith(".x.ai");
  if (!trusted) {
    throw new Error(
      `Image download host is not trusted for the ${backend.kind} backend`,
    );
  }
  return url;
}

async function downloadImage(
  fetchImpl: typeof fetch,
  value: string,
  backend: ImageBackend,
  signal: AbortSignal,
): Promise<{ readonly bytes: Buffer; readonly contentType: string }> {
  let current = validatedImageDownloadUrl(value, backend);
  for (
    let redirects = 0;
    redirects <= MAX_IMAGE_DOWNLOAD_REDIRECTS;
    redirects += 1
  ) {
    const response = await fetchImpl(current, {
      signal,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      if (redirects === MAX_IMAGE_DOWNLOAD_REDIRECTS) {
        throw new Error("Image download exceeded the redirect limit");
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("Image download redirect has no location");
      }
      current = validatedImageDownloadUrl(
        new URL(location, current).toString(),
        backend,
      );
      continue;
    }
    if (!response.ok) {
      throw new Error(`Image download HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (!contentType?.startsWith("image/")) {
      throw new Error("Image download returned a non-image content type");
    }
    const declaredRaw = response.headers.get("content-length");
    if (declaredRaw !== null) {
      const declared = Number(declaredRaw);
      if (!Number.isSafeInteger(declared) || declared < 0) {
        throw new Error("Image download returned an invalid content length");
      }
      if (declared > MAX_IMAGE_DOWNLOAD_BYTES) {
        throw new Error("Image download exceeds the 20 MiB limit");
      }
    }
    if (!response.body) {
      throw new Error("Image download returned an empty body");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      total += chunk.byteLength;
      if (total > MAX_IMAGE_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error("Image download exceeds the 20 MiB limit");
      }
      chunks.push(chunk);
    }
    return {
      bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total),
      contentType,
    };
  }
  throw new Error("Image download exceeded the redirect limit");
}

function qwenEnvironmentBackend(
  provider: "qwen" | "qwen-token-plan",
  env: NodeJS.ProcessEnv,
): ImageBackend | undefined {
  const credential = resolveProviderApiKeyEnvironment(provider, env);
  if (credential === undefined) return undefined;
  const defaultBaseURL =
    provider === "qwen"
      ? DEFAULT_QWEN_BASE_URL
      : DEFAULT_QWEN_TOKEN_PLAN_BASE_URL;
  const baseURL =
    resolveProviderBaseURLEnvironment(provider, env)?.value ?? defaultBaseURL;
  if (qwenApiOrigin(baseURL) === undefined) return undefined;
  return {
    kind: "qwen",
    provider,
    baseURL: withoutTrailingSlash(baseURL),
    bearer: credential.value,
  };
}

function zaiEnvironmentBackend(
  env: NodeJS.ProcessEnv,
): ImageBackend | undefined {
  const credential = resolveProviderApiKeyEnvironment("zai", env);
  if (credential === undefined) return undefined;
  const baseURL =
    resolveProviderBaseURLEnvironment("zai", env)?.value ??
    DEFAULT_ZAI_BASE_URL;
  if (isZaiCodingPlanBaseURL(baseURL)) return undefined;
  try {
    new URL(baseURL);
  } catch {
    return undefined;
  }
  return {
    kind: "zai",
    baseURL: withoutTrailingSlash(baseURL),
    bearer: credential.value,
  };
}

/**
 * Media credentials are intentionally independent from the reasoning
 * provider. A Meta/OpenAI/etc session key must never become an xAI bearer.
 * Direct Grok sessions retain their existing session-bearer compatibility.
 */
function resolveImageBackend(opts: ImagineImageToolOptions): BackendResolution {
  const env = opts.env ?? process.env;
  const provider = opts.getSession()?.services?.provider;
  const providerIdentity = readProviderIdentity(provider as never);
  const metaCredential = resolveProviderApiKeyEnvironment("meta", env);
  const metaBackend = (): ImageBackend | undefined => {
    if (metaCredential === undefined) return undefined;
    const metaBaseURL =
      resolveProviderBaseURLEnvironment("meta", env)?.value ??
      DEFAULT_META_BASE_URL;
    return {
      kind: "meta",
      baseURL: withoutTrailingSlash(metaBaseURL),
      bearer: metaCredential.value,
    };
  };

  if (
    (providerIdentity === "qwen" || providerIdentity === "qwen-token-plan") &&
    provider !== undefined
  ) {
    const factory = readProviderFactoryOptions(provider as never);
    const environmentBackend = qwenEnvironmentBackend(providerIdentity, env);
    const bearer =
      typeof factory.apiKey === "string" && factory.apiKey.trim().length > 0
        ? factory.apiKey.trim()
        : environmentBackend?.bearer;
    const baseURL = factory.baseURL ?? environmentBackend?.baseURL;
    if (
      bearer !== undefined &&
      baseURL !== undefined &&
      qwenApiOrigin(baseURL) !== undefined
    ) {
      return {
        backend: {
          kind: "qwen",
          provider: providerIdentity,
          baseURL: withoutTrailingSlash(baseURL),
          bearer,
        },
      };
    }
  }

  // A Z.AI reasoning session may reuse only its own factory credential (or
  // canonical ZAI_API_KEY fallback). Never borrow a different provider's
  // session bearer for the native image route.
  if (providerIdentity === "zai" && provider !== undefined) {
    const factory = readProviderFactoryOptions(provider as never);
    const environmentBackend = zaiEnvironmentBackend(env);
    const bearer =
      typeof factory.apiKey === "string" && factory.apiKey.trim().length > 0
        ? factory.apiKey.trim()
        : environmentBackend?.bearer;
    const baseURL =
      factory.baseURL ?? environmentBackend?.baseURL ?? DEFAULT_ZAI_BASE_URL;
    if (bearer !== undefined && !isZaiCodingPlanBaseURL(baseURL)) {
      return {
        backend: {
          kind: "zai",
          baseURL: withoutTrailingSlash(baseURL),
          bearer,
        },
      };
    }
  }

  // A Meta reasoning session prefers Meta's native image API, but only the
  // canonical MODEL_API_KEY ingress may authorize it. Never borrow a factory
  // key or an xAI alias for this request.
  if (providerIdentity === "meta") {
    const backend = metaBackend();
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
            baseURL: withoutTrailingSlash(
              factory.baseURL ?? DEFAULT_XAI_BASE_URL,
            ),
            bearer,
          },
        };
      }
    }
  }

  // A non-direct Grok session follows this path too: use only independent
  // xAI authority, never the gateway's session key or base URL.
  const xaiBearer = resolveXaiBearerToken(opts.home, env);
  if (xaiBearer !== undefined) {
    const xaiBaseURL =
      resolveProviderBaseURLEnvironment("grok", env)?.value ??
      DEFAULT_XAI_BASE_URL;
    if (!isDirectXaiInferenceHost(xaiBaseURL)) {
      const fallbackMetaBackend = metaBackend();
      if (fallbackMetaBackend !== undefined) {
        return { backend: fallbackMetaBackend };
      }
      return {
        error:
          "ImagineImage's independent xAI backend must use a direct xAI host (api.x.ai).",
      };
    }
    return {
      backend: {
        kind: "xai",
        baseURL: withoutTrailingSlash(xaiBaseURL),
        bearer: xaiBearer,
      },
    };
  }

  // MODEL_API_KEY is a complete, isolated Meta media backend even when a
  // different model provider performs the reasoning turn.
  const fallbackMetaBackend = metaBackend();
  if (fallbackMetaBackend !== undefined) {
    return { backend: fallbackMetaBackend };
  }

  const fallbackQwenBackend =
    qwenEnvironmentBackend("qwen", env) ??
    qwenEnvironmentBackend("qwen-token-plan", env);
  if (fallbackQwenBackend !== undefined) {
    return { backend: fallbackQwenBackend };
  }

  const fallbackZaiBackend = zaiEnvironmentBackend(env);
  if (fallbackZaiBackend !== undefined) {
    return { backend: fallbackZaiBackend };
  }

  return {
    error:
      "ImagineImage needs a media backend credential: MODEL_API_KEY for Meta Muse Image; DASHSCOPE_API_KEY/QWEN_API_KEY or QWEN_TOKEN_PLAN_API_KEY for QwenCloud; ZAI_API_KEY for GLM-Image; or /grok-login, XAI_API_KEY, or GROK_API_KEY for xAI Imagine.",
  };
}

/** Whether this request has at least one usable, isolated image backend. */
export function hasImagineImageBackend(
  opts: ImagineImageToolOptions,
): boolean {
  return "backend" in resolveImageBackend(opts);
}

function metaImageSize(aspectRatio: string | undefined): string {
  if (
    aspectRatio === undefined ||
    aspectRatio === "auto" ||
    aspectRatio === "1:1"
  ) {
    return "1024x1024";
  }
  const [width, height] = aspectRatio.split(":").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width === height) {
    return "1024x1024";
  }
  return width > height ? "1536x1024" : "1024x1536";
}

function qwenImageSize(
  aspectRatio: string | undefined,
  resolution: string | undefined,
): string | undefined {
  if (aspectRatio === undefined && resolution === undefined) return undefined;
  const normalizedAspect =
    aspectRatio === undefined || aspectRatio === "auto" ? "1:1" : aspectRatio;
  const [ratioWidth, ratioHeight] = normalizedAspect.split(":").map(Number);
  const ratio =
    Number.isFinite(ratioWidth) &&
      Number.isFinite(ratioHeight) &&
      ratioWidth > 0 &&
      ratioHeight > 0
      ? ratioWidth / ratioHeight
      : 1;
  const targetPixels = resolution === "2k" ? 2048 * 2048 : 1024 * 1024;
  // DashScope constrains total area, not each axis (official 2K examples
  // exceed 2048 px on the long edge). Flooring both axes to its 32 px grid
  // preserves the requested ratio without crossing the area budget.
  const floor32 = (value: number): number =>
    Math.max(512, Math.floor(value / 32) * 32);
  const width = floor32(Math.sqrt(targetPixels * ratio));
  const height = floor32(Math.sqrt(targetPixels / ratio));
  return `${width}*${height}`;
}

const ZAI_GLM_IMAGE_RECOMMENDED_SIZES: Readonly<Record<string, string>> =
  Object.freeze({
    "1:1": "1280x1280",
    "3:2": "1568x1056",
    "2:3": "1056x1568",
    "4:3": "1472x1088",
    "3:4": "1088x1472",
    "16:9": "1728x960",
    "9:16": "960x1728",
    "2:1": "2048x1024",
    "1:2": "1024x2048",
    "19.5:9": "2048x1024",
    "9:19.5": "1024x2048",
    "20:9": "2048x1024",
    "9:20": "1024x2048",
  });

const ZAI_COGVIEW_RECOMMENDED_SIZES: Readonly<Record<string, string>> =
  Object.freeze({
    "1:1": "1024x1024",
    "3:2": "1152x768",
    "2:3": "768x1152",
    "4:3": "1152x864",
    "3:4": "864x1152",
    "16:9": "1344x768",
    "9:16": "768x1344",
    "2:1": "1440x720",
    "1:2": "720x1440",
    "19.5:9": "1440x720",
    "9:19.5": "720x1440",
    "20:9": "1440x720",
    "9:20": "720x1440",
  });

function zaiImageSize(model: string, aspectRatio: string | undefined): string {
  const normalizedAspect =
    aspectRatio === undefined || aspectRatio === "auto" ? "1:1" : aspectRatio;
  const sizes = /^cogview-/i.test(model)
    ? ZAI_COGVIEW_RECOMMENDED_SIZES
    : ZAI_GLM_IMAGE_RECOMMENDED_SIZES;
  return sizes[normalizedAspect] ?? sizes["1:1"]!;
}

function extensionForImageContentType(
  contentType: string,
  fallback: string,
): string {
  switch (contentType.split(";", 1)[0]?.trim().toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/avif":
      return "avif";
    default:
      return fallback;
  }
}

function imagineImageDescription(backend: ImageBackend | undefined): string {
  switch (backend?.kind) {
    case "meta":
      return "Generate images with Meta Muse Image and save them under the workspace.";
    case "qwen":
      return backend.provider === "qwen"
        ? "Generate up to six images with QwenCloud Pay-As-You-Go and save them under the workspace."
        : "Generate images with QwenCloud Token Plan and save them under the workspace; Wan models return at most four images.";
    case "zai":
      return "Generate exactly one image with Z.AI GLM-Image or CogView and save it under the workspace. Select image dimensions with aspect_ratio; Z.AI does not accept resolution or multiple-image requests.";
    case "xai":
      return "Generate images with xAI Imagine and save them under the workspace.";
    default:
      return "Generate images with the configured QwenCloud, Meta, Z.AI, or xAI media backend and save them under the workspace.";
  }
}

function imagineImageInputSchema(
  backend: ImageBackend | undefined,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    prompt: {
      type: "string",
      description: "Describe the image to generate.",
    },
  };
  const aspectRatio = {
    type: "string",
    enum: [...ALLOWED_ASPECT],
    description: "Desired output aspect ratio (default 1:1).",
  };

  switch (backend?.kind) {
    case "meta":
      Object.assign(properties, {
        model: {
          type: "string",
          enum: ["muse-image-1.0"],
          description: "Meta image model (default muse-image-1.0).",
        },
        n: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Number of images to generate (default 1).",
        },
        aspect_ratio: aspectRatio,
      });
      break;
    case "qwen": {
      const isPayGo = backend.provider === "qwen";
      Object.assign(properties, {
        model: {
          type: "string",
          enum: isPayGo
            ? ["qwen-image-3.0", "qwen-image-3.0-pro"]
            : [
                "qwen-image-3.0-pro",
                "wan2.7-image",
                "wan2.7-image-pro",
              ],
          description: isPayGo
            ? "QwenCloud Pay-As-You-Go image model (default qwen-image-3.0)."
            : "QwenCloud Token Plan image model (default wan2.7-image).",
        },
        n: {
          type: "integer",
          minimum: 1,
          maximum: 6,
          description: isPayGo
            ? "Number of images to generate, from 1 to 6 (default 1)."
            : "Number of images to generate; Qwen Image allows up to 6 and Wan allows up to 4 (default 1).",
        },
        aspect_ratio: aspectRatio,
        resolution: {
          type: "string",
          enum: ["1k", "2k"],
          description: "Output resolution tier (default 1k).",
        },
      });
      break;
    }
    case "zai":
      Object.assign(properties, {
        model: {
          type: "string",
          enum: ["glm-image", "cogview-4-250304"],
          description: "Z.AI image model (default glm-image).",
        },
        aspect_ratio: aspectRatio,
        quality: {
          type: "string",
          enum: ["hd", "standard"],
          description:
            "Z.AI image quality (defaults to hd for glm-image and standard for CogView).",
        },
      });
      break;
    case "xai":
      Object.assign(properties, {
        model: {
          type: "string",
          enum: ["grok-imagine-image", "grok-imagine-image-quality"],
          description: "xAI image model (default grok-imagine-image).",
        },
        n: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Number of images to generate (default 1).",
        },
        aspect_ratio: aspectRatio,
        resolution: { type: "string", enum: ["1k", "2k"] },
      });
      break;
    default:
      Object.assign(properties, {
        model: {
          type: "string",
          description:
            "Backend-specific image model. Omit to use the selected backend default.",
        },
        n: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Number of images to generate (default 1).",
        },
        aspect_ratio: aspectRatio,
        resolution: { type: "string", enum: ["1k", "2k"] },
        quality: {
          type: "string",
          enum: ["hd", "standard"],
          description: "Z.AI only.",
        },
      });
  }

  return {
    type: "object",
    properties,
    required: ["prompt"],
    additionalProperties: false,
  };
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createImagineImageTool(opts: ImagineImageToolOptions): Tool {
  // A registry may be constructed before its Session ref is attached. In that
  // lifecycle state the eventual provider can still change the media backend,
  // so a backend-specific frozen schema would advertise the wrong controls.
  // Keep the universal safe schema until a concrete Session exists; execution
  // always re-resolves authority from the current Session and environment.
  const advertisedResolution = opts.getSession() === null
    ? undefined
    : resolveImageBackend(opts);
  const advertisedBackend =
    advertisedResolution !== undefined && "backend" in advertisedResolution
      ? advertisedResolution.backend
      : undefined;
  const deferredUntilDiscovered =
    opts.getSession() === null && !hasImagineImageBackend(opts);
  return {
    name: "ImagineImage",
    description: imagineImageDescription(advertisedBackend),
    metadata: {
      family: "media",
      source: "builtin",
      hiddenByDefault: false,
      mutating: true,
      deferred: deferredUntilDiscovered,
      keywords: ["image", "generate", "media"],
      preferredProfiles: ["coding", "operator", "general"],
    },
    isReadOnly: false,
    requiresApproval: true,
    concurrencyClass: { kind: "exclusive" },
    // Wan generation commonly takes one to two minutes. The harness backstop
    // must stay above the internal three-minute network/polling timeout.
    timeoutMs: 210_000,
    recoveryCategory: "side-effecting",
    admissionEstimate: (args) => {
      const resolution = resolveImageBackend(opts);
      const model = stringValue(args.model) ?? "glm-image";
      const maxCostUsd =
        "backend" in resolution && resolution.backend.kind === "zai"
          ? model === "glm-image"
            ? ZAI_GLM_IMAGE_COST_USD
            : model === "cogview-4-250304"
              ? ZAI_COGVIEW_IMAGE_COST_USD
              : null
          : null;
      return {
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd,
      };
    },
    inputSchema: imagineImageInputSchema(advertisedBackend),
    execute: async (args) => {
      const admittedSignal = abortSignalFromArgs(args);
      admittedSignal?.throwIfAborted();
      const backendResolution = resolveImageBackend(opts);
      if ("error" in backendResolution) {
        return json({ error: backendResolution.error }, true);
      }
      const { backend } = backendResolution;

      const prompt = stringValue(args.prompt);
      if (!prompt) return json({ error: "prompt is required" }, true);

      const model =
        stringValue(args.model) ??
        (backend.kind === "meta"
          ? "muse-image-1.0"
          : backend.kind === "qwen"
            ? backend.provider === "qwen"
              ? "qwen-image-3.0"
              : "wan2.7-image"
            : backend.kind === "zai"
              ? "glm-image"
              : "grok-imagine-image");
      if (backend.kind === "meta") {
        if (model !== "muse-image-1.0") {
          return json({ error: "Meta image model must be muse-image-1.0" }, true);
        }
      } else if (backend.kind === "qwen") {
        const isPayGoModel = /^qwen-image-3\.0(?:-pro)?$/i.test(model);
        const isTokenPlanModel =
          /^qwen-image-3\.0-pro$/i.test(model) ||
          /^wan2\.7-image(?:-pro)?$/i.test(model);
        if (
          (backend.provider === "qwen" && !isPayGoModel) ||
          (backend.provider === "qwen-token-plan" && !isTokenPlanModel)
        ) {
          return json(
            {
              error:
                backend.provider === "qwen"
                  ? "QwenCloud Pay-As-You-Go image model must be qwen-image-3.0 or qwen-image-3.0-pro"
                  : "QwenCloud Token Plan image model must be qwen-image-3.0-pro, wan2.7-image, or wan2.7-image-pro",
            },
            true,
          );
        }
      } else if (backend.kind === "zai") {
        if (model !== "glm-image" && model !== "cogview-4-250304") {
          return json(
            {
              error:
                "Z.AI image model must be glm-image or cogview-4-250304",
            },
            true,
          );
        }
      } else if (
        model !== "grok-imagine-image" &&
        model !== "grok-imagine-image-quality"
      ) {
        return json(
          {
            error:
              "xAI image model must be grok-imagine-image or grok-imagine-image-quality",
          },
          true,
        );
      }

      const nRaw = typeof args.n === "number" ? args.n : 1;
      if (backend.kind === "zai" && nRaw !== 1) {
        return json(
          {
            error:
              "Z.AI image generation returns exactly one image per request",
          },
          true,
        );
      }
      const qwenMaxImages = /^wan2\.7-image(?:-pro)?$/i.test(model) ? 4 : 6;
      const n = Math.max(
        1,
        Math.min(backend.kind === "qwen" ? qwenMaxImages : 10, Math.floor(nRaw)),
      );
      const aspect_ratio = stringValue(args.aspect_ratio);
      if (aspect_ratio !== undefined && !ALLOWED_ASPECT.has(aspect_ratio)) {
        return json(
          { error: `unsupported aspect_ratio: ${aspect_ratio}` },
          true,
        );
      }
      const resolution = stringValue(args.resolution);
      if (
        resolution !== undefined &&
        resolution !== "1k" &&
        resolution !== "2k"
      ) {
        return json({ error: "resolution must be 1k or 2k" }, true);
      }
      if (backend.kind === "zai" && resolution !== undefined) {
        return json(
          {
            error:
              "Z.AI image size is selected by aspect_ratio; resolution is not supported",
          },
          true,
        );
      }
      const quality = stringValue(args.quality);
      if (
        quality !== undefined &&
        quality !== "hd" &&
        quality !== "standard"
      ) {
        return json({ error: "quality must be hd or standard" }, true);
      }
      if (backend.kind !== "zai" && quality !== undefined) {
        return json({ error: "quality is supported only by Z.AI images" }, true);
      }

      const body: Record<string, unknown> =
        backend.kind === "meta"
          ? { model, prompt, size: metaImageSize(aspect_ratio), n }
          : backend.kind === "qwen"
            ? {}
            : backend.kind === "zai"
              ? {
                  model,
                  prompt,
                  size: zaiImageSize(model, aspect_ratio),
                  quality:
                    quality ?? (model === "glm-image" ? "hd" : "standard"),
                }
              : { model, prompt, n, response_format: "b64_json" };
      if (backend.kind === "xai") {
        if (aspect_ratio !== undefined) body.aspect_ratio = aspect_ratio;
        if (resolution !== undefined) body.resolution = resolution;
      }

      const fetchImpl = opts.fetchImpl ?? fetch;
      const timeoutSignal = AbortSignal.timeout(180_000);
      const requestSignal = admittedSignal
        ? AbortSignal.any([admittedSignal, timeoutSignal])
        : timeoutSignal;
      try {
        let endpoint = `${backend.baseURL}/images/generations`;
        const headers: Record<string, string> = {
          authorization: `Bearer ${backend.bearer}`,
          "content-type": "application/json",
        };
        if (backend.kind === "qwen") {
          const origin = qwenApiOrigin(backend.baseURL);
          if (origin === undefined) {
            return json({ error: "QwenCloud image endpoint is invalid" }, true);
          }
          const size = qwenImageSize(aspect_ratio, resolution);
          if (/^wan2\.7-image(?:-pro)?$/i.test(model)) {
            endpoint = `${origin}/api/v1/services/aigc/image-generation/generation`;
            headers["x-dashscope-async"] = "enable";
            Object.assign(body, {
              model,
              input: {
                messages: [
                  {
                    role: "user",
                    content: [{ text: prompt }],
                  },
                ],
              },
              parameters: {
                n,
                ...(size !== undefined ? { size } : {}),
                enable_sequential: false,
                watermark: false,
                thinking_mode: true,
              },
            });
          } else {
            endpoint = `${origin}/api/v1/services/aigc/multimodal-generation/generation`;
            Object.assign(body, {
              model,
              input: {
                messages: [
                  {
                    role: "user",
                    content: [{ text: prompt }],
                  },
                ],
              },
              parameters: {
                prompt_extend: true,
                n,
                ...(size !== undefined ? { size } : {}),
              },
            });
          }
        }

        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: requestSignal,
        });
        let payload = (await res.json()) as {
          data?: readonly { b64_json?: string; url?: string }[];
          error?: { message?: string };
          code?: string;
          message?: string;
          output?: {
            task_id?: string;
            task_status?: string;
            code?: string;
            message?: string;
            choices?: readonly {
              message?: {
                content?: readonly { image?: string }[];
              };
            }[];
            results?: readonly { url?: string }[];
          };
        };
        if (!res.ok) {
          return json(
            {
              error:
                payload.error?.message ??
                payload.message ??
                `${backend.kind === "meta" ? "Muse Image" : backend.kind === "qwen" ? "QwenCloud image" : backend.kind === "zai" ? "Z.AI image" : "Imagine"} HTTP ${res.status}`,
            },
            true,
          );
        }
        if (
          backend.kind === "qwen" &&
          /^wan2\.7-image(?:-pro)?$/i.test(model)
        ) {
          const taskId = payload.output?.task_id?.trim();
          if (!taskId) {
            return json(
              { error: "QwenCloud Token Plan returned no image task id" },
              true,
            );
          }
          const origin = qwenApiOrigin(backend.baseURL)!;
          while (payload.output?.task_status !== "SUCCEEDED") {
            const status = payload.output?.task_status;
            if (
              status === "FAILED" ||
              status === "CANCELED" ||
              status === "UNKNOWN"
            ) {
              return json(
                {
                  error:
                    payload.output?.message ??
                    payload.message ??
                    `QwenCloud image task ${status.toLowerCase()}`,
                },
                true,
              );
            }
            const taskResponse = await fetchImpl(
              `${origin}/api/v1/tasks/${encodeURIComponent(taskId)}`,
              {
                headers: { authorization: `Bearer ${backend.bearer}` },
                signal: requestSignal,
              },
            );
            payload = (await taskResponse.json()) as typeof payload;
            if (!taskResponse.ok) {
              return json(
                {
                  error:
                    payload.output?.message ??
                    payload.message ??
                    `QwenCloud image task HTTP ${taskResponse.status}`,
                },
                true,
              );
            }
            if (
              payload.output?.task_status !== "SUCCEEDED" &&
              payload.output?.task_status !== "FAILED" &&
              payload.output?.task_status !== "CANCELED" &&
              payload.output?.task_status !== "UNKNOWN"
            ) {
              await abortableDelay(1_000, requestSignal);
            }
          }
        }
        const images =
          backend.kind === "qwen"
            ? [
                ...(payload.output?.choices ?? []).flatMap((choice) =>
                  (choice.message?.content ?? []).flatMap((part) =>
                    part.image ? [{ url: part.image }] : [],
                  ),
                ),
                ...(payload.output?.results ?? []).flatMap((result) =>
                  result.url ? [{ url: result.url }] : [],
                ),
              ]
            : (payload.data ?? []);
        if (images.length === 0) {
          return json(
            {
              error:
                backend.kind === "qwen"
                  ? "QwenCloud returned no images"
                  : "Imagine returned no images",
            },
            true,
          );
        }
        if (backend.kind === "zai" && images.length !== 1) {
          return json(
            { error: "Z.AI image generation must return exactly one image" },
            true,
          );
        }

        const outDir = join(opts.workspaceRoot, ".agenc", "imagine");
        await mkdir(outDir, { recursive: true });
        const paths: string[] = [];
        for (const image of images) {
          // Muse Image returns WebP. Keep the extension honest so Electron's
          // agenc-media protocol derives a renderable content type.
          let extension =
            backend.kind === "meta"
              ? "webp"
              : backend.kind === "qwen"
                ? "png"
                : backend.kind === "zai"
                  ? "png"
                  : "jpg";
          let bytes: Buffer | undefined;
          if ("b64_json" in image && image.b64_json) {
            bytes = Buffer.from(image.b64_json, "base64");
          } else if (image.url) {
            // Signed URLs are short-lived and provider-controlled. Follow
            // redirects manually so every hop stays on an expected HTTPS
            // host, and stream through a hard byte cap before writing.
            const downloaded = await downloadImage(
              fetchImpl,
              image.url,
              backend,
              requestSignal,
            );
            bytes = downloaded.bytes;
            extension = extensionForImageContentType(
              downloaded.contentType,
              extension,
            );
          }
          if (bytes !== undefined) {
            const filename = `imagine-${randomUUID()}.${extension}`;
            const path = join(outDir, filename);
            await writeFile(path, bytes, { signal: requestSignal });
            paths.push(path);
          }
        }
        if (paths.length === 0) {
          return json(
            { error: "Imagine returned no downloadable images" },
            true,
          );
        }
        return json({
          backend:
            backend.kind === "qwen" ? backend.provider : backend.kind,
          model,
          paths,
          path: paths[0],
          n: paths.length,
        });
      } catch (error) {
        admittedSignal?.throwIfAborted();
        return json(
          {
            error:
              error instanceof Error ? error.message : "Imagine request failed",
          },
          true,
        );
      }
    },
  };
}
