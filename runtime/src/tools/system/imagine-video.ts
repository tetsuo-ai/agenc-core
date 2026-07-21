/**
 * LIVE Imagine **video** generation (xAI REST).
 *
 * Text-to-video and image-to-video via:
 *   POST /v1/videos/generations  → request_id
 *   GET  /v1/videos/{request_id} → poll until done
 *
 * Auth (same as Hermes video_gen/xai): `/grok-login` OAuth **wins** over
 * BYOK; subscription SuperGrok / Grok Build users can generate video.
 *
 * Gate stack (fail-closed):
 * 1. Session provider === "grok"
 * 2. Direct xAI host (not OpenRouter)
 * 3. OAuth or BYOK credentials
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
import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";

export interface ImagineVideoToolOptions {
  readonly workspaceRoot: string;
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

export function createImagineVideoTool(opts: ImagineVideoToolOptions): Tool {
  return {
    name: "ImagineVideo",
    description:
      "Generate a video with xAI Grok Imagine (text-to-video or image-to-video). " +
      "Uses POST /v1/videos/generations + poll. Available when session provider is grok " +
      "on api.x.ai with /grok-login OAuth (preferred) or XAI_API_KEY. Saves the MP4 under the workspace.",
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
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
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
    },
    execute: async (args) => {
      const admittedSignal = abortSignalFromArgs(args);
      admittedSignal?.throwIfAborted();
      const session = opts.getSession();
      const provider = session?.services?.provider;
      if (readProviderIdentity(provider as never) !== "grok") {
        return json(
          {
            error:
              "ImagineVideo is only available when the session provider is grok.",
          },
          true,
        );
      }

      const factory = readProviderFactoryOptions(provider as never);
      if (!isDirectXaiInferenceHost(factory.baseURL)) {
        return json(
          {
            error:
              "ImagineVideo requires a direct xAI host (api.x.ai). OpenRouter is not supported for Imagine video REST.",
          },
          true,
        );
      }

      const sessionKey =
        typeof factory.apiKey === "string" ? factory.apiKey : undefined;
      const bearer = resolveXaiBearerToken(opts.env ?? process.env, sessionKey);
      if (!bearer) {
        return json(
          {
            error:
              "ImagineVideo needs xAI credentials: /grok-login (subscription) or XAI_API_KEY / GROK_API_KEY / AGENC_XAI_API_KEY.",
          },
          true,
        );
      }

      const prompt = stringValue(args.prompt);
      if (!prompt) return json({ error: "prompt is required" }, true);

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
        return json(
          {
            error:
              "image_url and reference_image_urls cannot be combined on xAI",
          },
          true,
        );
      }
      if (refRaw.length > MAX_REFERENCE_IMAGES) {
        return json(
          {
            error: `reference_image_urls supports at most ${MAX_REFERENCE_IMAGES} images`,
          },
          true,
        );
      }
      const reference_images: { url: string }[] = [];
      for (const r of refRaw) {
        const url = await imageRefToUrl(r, opts.workspaceRoot, admittedSignal);
        if (url) reference_images.push({ url });
      }

      const modality =
        imageUrl || reference_images.length > 0 ? "image" : "text";
      let model = stringValue(args.model);
      if (!model) {
        model =
          modality === "image" ? IMAGE_TO_VIDEO_MODEL : TEXT_TO_VIDEO_MODEL;
      }

      let duration =
        typeof args.duration === "number" && Number.isFinite(args.duration)
          ? Math.floor(args.duration)
          : 8;
      if (duration < 1) duration = 1;
      if (duration > 15) duration = 15;
      if (reference_images.length > 0 && duration > 10) duration = 10;

      let aspect_ratio = stringValue(args.aspect_ratio) ?? "16:9";
      if (!VALID_ASPECT.has(aspect_ratio)) aspect_ratio = "16:9";
      let resolution = (stringValue(args.resolution) ?? "720p").toLowerCase();
      if (!VALID_RESOLUTIONS.has(resolution)) resolution = "720p";

      const body: Record<string, unknown> = {
        model,
        prompt,
        duration,
        aspect_ratio,
        resolution,
      };
      if (imageUrl) body.image = { url: imageUrl };
      if (reference_images.length > 0) {
        body.reference_images = reference_images;
      }

      const baseURL = (factory.baseURL ?? "https://api.x.ai/v1").replace(
        /\/$/,
        "",
      );
      const fetchImpl = opts.fetchImpl ?? fetch;
      const headers = {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      };

      try {
        const submitRes = await fetchImpl(`${baseURL}/videos/generations`, {
          method: "POST",
          headers: {
            ...headers,
            "x-idempotency-key": randomUUID(),
          },
          body: JSON.stringify(body),
          ...(admittedSignal !== undefined
            ? { signal: admittedSignal }
            : {}),
        });
        const submitJson = (await submitRes.json()) as {
          request_id?: string;
          error?: { message?: string };
        };
        if (!submitRes.ok) {
          return json(
            {
              error:
                submitJson.error?.message ??
                `Imagine video submit HTTP ${submitRes.status}`,
            },
            true,
          );
        }
        const requestId = submitJson.request_id;
        if (!requestId) {
          return json(
            { error: "xAI video response did not include request_id" },
            true,
          );
        }

        const pollInterval = opts.pollIntervalMs ?? 5_000;
        const pollTimeout = opts.pollTimeoutMs ?? 240_000;
        let elapsed = 0;
        let lastStatus = "queued";
        let doneBody: Record<string, unknown> | undefined;

        while (elapsed < pollTimeout) {
          const pollRes = await fetchImpl(`${baseURL}/videos/${requestId}`, {
            method: "GET",
            headers,
            ...(admittedSignal !== undefined
              ? { signal: admittedSignal }
              : {}),
          });
          const pollJson = (await pollRes.json()) as Record<string, unknown> & {
            status?: string;
            error?: { message?: string };
            video?: { url?: string };
            url?: string;
          };
          if (!pollRes.ok) {
            return json(
              {
                error:
                  pollJson.error?.message ??
                  `Imagine video poll HTTP ${pollRes.status}`,
              },
              true,
            );
          }
          lastStatus = String(pollJson.status ?? "").toLowerCase();
          if (lastStatus === "done") {
            doneBody = pollJson;
            break;
          }
          if (
            lastStatus === "failed" ||
            lastStatus === "error" ||
            lastStatus === "expired" ||
            lastStatus === "cancelled"
          ) {
            return json(
              {
                error: `Imagine video ${lastStatus}: ${
                  pollJson.error?.message ?? "upstream failure"
                }`,
                request_id: requestId,
              },
              true,
            );
          }
          await sleep(pollInterval, admittedSignal);
          elapsed += pollInterval;
        }

        if (!doneBody) {
          return json(
            {
              error: `Imagine video timed out after ${pollTimeout}ms (last status: ${lastStatus})`,
              request_id: requestId,
            },
            true,
          );
        }

        const videoUrl =
          (doneBody.video as { url?: string } | undefined)?.url ??
          (typeof doneBody.url === "string" ? doneBody.url : undefined);
        if (!videoUrl) {
          return json(
            {
              error: "Imagine video completed but returned no video URL",
              request_id: requestId,
              status: lastStatus,
            },
            true,
          );
        }

        const outDir = join(opts.workspaceRoot, ".agenc", "imagine");
        await mkdir(outDir, { recursive: true });
        const path = join(outDir, `imagine-video-${randomUUID()}.mp4`);

        const videoRes = await fetchImpl(
          videoUrl,
          admittedSignal === undefined ? {} : { signal: admittedSignal },
        );
        if (!videoRes.ok) {
          return json(
            {
              error: `Failed to download video URL (HTTP ${videoRes.status})`,
              url: videoUrl,
              request_id: requestId,
            },
            true,
          );
        }
        const buf = Buffer.from(await videoRes.arrayBuffer());
        await writeFile(path, buf, { signal: admittedSignal });

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
