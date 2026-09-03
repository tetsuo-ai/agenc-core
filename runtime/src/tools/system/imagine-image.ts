/**
 * LIVE image generation tool with provider-independent media backends.
 *
 * Backend routing (fail-closed and credential-isolated):
 * 1. Meta reasoning sessions prefer Meta Muse Image + MODEL_API_KEY.
 * 2. Any reasoning provider may use independent xAI credentials.
 * 3. Direct Grok sessions retain their session bearer/base URL compatibility.
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
    };

type BackendResolution =
  | { readonly backend: ImageBackend }
  | { readonly error: string };

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
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

  return {
    error:
      "ImagineImage needs a media backend credential: MODEL_API_KEY for Meta Muse Image, or /grok-login, XAI_API_KEY, or GROK_API_KEY for xAI Imagine.",
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

export function createImagineImageTool(opts: ImagineImageToolOptions): Tool {
  return {
    name: "ImagineImage",
    description:
      "Generate an image with the configured media backend and save it under the workspace. Meta reasoning sessions prefer Muse Image when MODEL_API_KEY is configured; any reasoning provider may use an independent xAI Imagine backend configured with /grok-login, XAI_API_KEY, or GROK_API_KEY.",
    isReadOnly: false,
    requiresApproval: true,
    concurrencyClass: { kind: "exclusive" },
    // Image generation uses an internal 120s timeout (AbortSignal.timeout); the
    // 30s default tool timeout could cut a slow generation just short. Give the
    // harness backstop 2.5min so it always exceeds the tool's own timeout.
    timeoutMs: 150_000,
    recoveryCategory: "side-effecting",
    admissionEstimate: () => ({
      maxInputTokens: 0,
      maxOutputTokens: 0,
      maxCostUsd: null,
    }),
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        model: {
          type: "string",
          description:
            "Backend-specific model: muse-image-1.0 for Meta, or grok-imagine-image / grok-imagine-image-quality for xAI. Omit to use the selected backend default.",
        },
        n: { type: "number", description: "1–10 images (default 1)" },
        aspect_ratio: { type: "string" },
        resolution: { type: "string", enum: ["1k", "2k"] },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
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
        (backend.kind === "meta" ? "muse-image-1.0" : "grok-imagine-image");
      if (backend.kind === "meta") {
        if (model !== "muse-image-1.0") {
          return json({ error: "Meta image model must be muse-image-1.0" }, true);
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
      const n = Math.max(1, Math.min(10, Math.floor(nRaw)));
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

      const body: Record<string, unknown> =
        backend.kind === "meta"
          ? { model, prompt, size: metaImageSize(aspect_ratio), n }
          : { model, prompt, n, response_format: "b64_json" };
      if (backend.kind === "xai") {
        if (aspect_ratio !== undefined) body.aspect_ratio = aspect_ratio;
        if (resolution !== undefined) body.resolution = resolution;
      }

      const fetchImpl = opts.fetchImpl ?? fetch;
      const timeoutSignal = AbortSignal.timeout(120_000);
      const requestSignal = admittedSignal
        ? AbortSignal.any([admittedSignal, timeoutSignal])
        : timeoutSignal;
      try {
        const res = await fetchImpl(`${backend.baseURL}/images/generations`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${backend.bearer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: requestSignal,
        });
        const payload = (await res.json()) as {
          data?: readonly { b64_json?: string; url?: string }[];
          error?: { message?: string };
        };
        if (!res.ok) {
          return json(
            {
              error:
                payload.error?.message ??
                `${backend.kind === "meta" ? "Muse Image" : "Imagine"} HTTP ${res.status}`,
            },
            true,
          );
        }
        const images = payload.data ?? [];
        if (images.length === 0) {
          return json({ error: "Imagine returned no images" }, true);
        }

        const outDir = join(opts.workspaceRoot, ".agenc", "imagine");
        await mkdir(outDir, { recursive: true });
        const paths: string[] = [];
        for (const image of images) {
          // Muse Image returns WebP. Keep the extension honest so Electron's
          // agenc-media protocol derives a renderable content type.
          const extension = backend.kind === "meta" ? "webp" : "jpg";
          const filename = `imagine-${randomUUID()}.${extension}`;
          const path = join(outDir, filename);
          if (image.b64_json) {
            await writeFile(path, Buffer.from(image.b64_json, "base64"), {
              signal: requestSignal,
            });
            paths.push(path);
          } else if (image.url) {
            // URL-only response: download
            const imgRes = await fetchImpl(image.url, {
              signal: requestSignal,
            });
            if (!imgRes.ok) {
              return json(
                {
                  error: `Image download HTTP ${imgRes.status}`,
                },
                true,
              );
            }
            const buf = Buffer.from(await imgRes.arrayBuffer());
            await writeFile(path, buf, { signal: requestSignal });
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
          backend: backend.kind,
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
