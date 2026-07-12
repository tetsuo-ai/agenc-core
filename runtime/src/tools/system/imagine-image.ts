/**
 * G3: LIVE Imagine image generation tool (xAI REST /v1/images/generations).
 *
 * Gate stack (fail-closed):
 * 1. Session provider === "grok"
 * 2. Direct xAI host (not OpenRouter)
 * 3. BYOK API key (OAuth-only media is refused until empirically verified)
 *
 * @module
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  createProvider,
  readProviderFactoryOptions,
  readProviderIdentity,
} from "../../llm/provider.js";
import {
  isDirectXaiInferenceHost,
  resolveXaiBearerToken,
} from "../../llm/xai-capability-config.js";
import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";

export interface ImagineImageToolOptions {
  readonly workspaceRoot: string;
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

export function createImagineImageTool(opts: ImagineImageToolOptions): Tool {
  return {
    name: "ImagineImage",
    description:
      "Generate an image with xAI Grok Imagine (POST /v1/images/generations). Only available when the session provider is grok on api.x.ai with either XAI_API_KEY/aliases or /grok-login subscription OAuth. Saves the image under the workspace and returns the path.",
    isReadOnly: false,
    requiresApproval: true,
    concurrencyClass: { kind: "exclusive" },
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        model: {
          type: "string",
          description:
            "grok-imagine-image (default) or grok-imagine-image-quality",
        },
        n: { type: "number", description: "1–10 images (default 1)" },
        aspect_ratio: { type: "string" },
        resolution: { type: "string", enum: ["1k", "2k"] },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const session = opts.getSession();
      const provider = session?.services?.provider;
      if (readProviderIdentity(provider as never) !== "grok") {
        return json(
          {
            error:
              "ImagineImage is only available when the session provider is grok.",
          },
          true,
        );
      }

      const factory = readProviderFactoryOptions(provider as never);
      if (!isDirectXaiInferenceHost(factory.baseURL)) {
        return json(
          {
            error:
              "ImagineImage requires a direct xAI host (api.x.ai). OpenRouter and custom gateways are not supported for Imagine REST.",
          },
          true,
        );
      }

      // Hermes-style: BYOK env wins, else /grok-login OAuth, else session bearer.
      // Subscription Grok Build users authenticate via OAuth — do not require
      // a metered XAI_API_KEY for Imagine.
      const sessionKey =
        typeof factory.apiKey === "string" ? factory.apiKey : undefined;
      const bearer = resolveXaiBearerToken(opts.env ?? process.env, sessionKey);
      if (!bearer) {
        return json(
          {
            error:
              "ImagineImage needs xAI credentials: set XAI_API_KEY (or GROK_API_KEY / AGENC_XAI_API_KEY), or run /grok-login for subscription access.",
          },
          true,
        );
      }

      const prompt = stringValue(args.prompt);
      if (!prompt) return json({ error: "prompt is required" }, true);

      const model =
        stringValue(args.model) ?? "grok-imagine-image";
      if (
        model !== "grok-imagine-image" &&
        model !== "grok-imagine-image-quality"
      ) {
        return json(
          {
            error:
              "model must be grok-imagine-image or grok-imagine-image-quality",
          },
          true,
        );
      }

      const nRaw = typeof args.n === "number" ? args.n : 1;
      const n = Math.max(1, Math.min(10, Math.floor(nRaw)));
      const aspect_ratio = stringValue(args.aspect_ratio);
      if (aspect_ratio !== undefined && !ALLOWED_ASPECT.has(aspect_ratio)) {
        return json({ error: `unsupported aspect_ratio: ${aspect_ratio}` }, true);
      }
      const resolution = stringValue(args.resolution);
      if (
        resolution !== undefined &&
        resolution !== "1k" &&
        resolution !== "2k"
      ) {
        return json({ error: "resolution must be 1k or 2k" }, true);
      }

      const body: Record<string, unknown> = {
        model,
        prompt,
        n,
        response_format: "b64_json",
      };
      if (aspect_ratio !== undefined) body.aspect_ratio = aspect_ratio;
      if (resolution !== undefined) body.resolution = resolution;

      const baseURL = (factory.baseURL ?? "https://api.x.ai/v1").replace(
        /\/$/,
        "",
      );
      const fetchImpl = opts.fetchImpl ?? fetch;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);
      try {
        const res = await fetchImpl(`${baseURL}/images/generations`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
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
                `Imagine HTTP ${res.status}`,
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
          const filename = `imagine-${randomUUID()}.jpg`;
          const path = join(outDir, filename);
          if (image.b64_json) {
            await writeFile(path, Buffer.from(image.b64_json, "base64"));
            paths.push(path);
          } else if (image.url) {
            // URL-only response: download
            const imgRes = await fetchImpl(image.url);
            const buf = Buffer.from(await imgRes.arrayBuffer());
            await writeFile(path, buf);
            paths.push(path);
          }
        }
        if (paths.length === 0) {
          return json({ error: "Imagine returned no downloadable images" }, true);
        }
        return json({
          model,
          paths,
          path: paths[0],
          n: paths.length,
        });
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Imagine request failed",
          },
          true,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

// Silence unused import if tree-shaken in some builds — createProvider used only for types.
void createProvider;
