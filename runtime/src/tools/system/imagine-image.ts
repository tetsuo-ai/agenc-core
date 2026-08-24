/**
 * G3: LIVE Imagine image generation tool (xAI REST /v1/images/generations).
 *
 * Gate stack (fail-closed):
 * 1. Session provider === "grok"
 * 2. Direct xAI host (not OpenRouter)
 * 3. /grok-login OAuth (wins) or BYOK aliases
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
import {
  CHATGPT_BACKEND_ORIGINATOR,
  readOpenAiSubscriptionAuth,
  type OpenAiSubscriptionAuth,
} from "../../utils/openAiOauthCredentials.js";
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

function abortSignalFromArgs(
  args: Record<string, unknown>,
): AbortSignal | undefined {
  const signal = args.__abortSignal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/**
 * Ask the ChatGPT backend for a picture and return its bytes.
 *
 * A subscription sign-in has no platform API key, so `/v1/images/generations`
 * — the endpoint the xAI branch below uses, and which OpenAI mirrors — is
 * closed to it. What is open is the same Responses endpoint the session
 * already talks to, with the server-side `image_generation` tool.
 *
 * Verified against gpt-5.6-sol: the request is refused outright unless
 * `stream` is true (`{"detail":"Stream must be set to true"}`), and the
 * finished picture arrives on the `response.output_item.done` event for the
 * `image_generation_call` item, base64 in `result`, extension in
 * `output_format`. The `partial_image` events carry earlier drafts of the
 * same picture and are ignored.
 */
async function generateViaChatgptBackend(params: {
  readonly auth: OpenAiSubscriptionAuth;
  readonly model: string;
  readonly prompt: string;
  readonly fetchImpl: typeof fetch;
  readonly signal: AbortSignal;
}): Promise<
  { readonly bytes: Buffer; readonly format: string; readonly revisedPrompt?: string }
  | { readonly error: string }
> {
  const res = await params.fetchImpl(`${params.auth.baseUrl}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${params.auth.accessToken}`,
      "ChatGPT-Account-ID": params.auth.accountId,
      originator: CHATGPT_BACKEND_ORIGINATOR,
    },
    body: JSON.stringify({
      model: params.model,
      store: false,
      stream: true,
      tools: [{ type: "image_generation" }],
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: params.prompt }],
        },
      ],
    }),
    signal: params.signal,
  });
  const text = await res.text();
  if (!res.ok) {
    return { error: `image generation HTTP ${res.status}: ${text.slice(0, 300)}` };
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (raw.length === 0 || raw === "[DONE]") continue;
    let event: { type?: unknown; item?: unknown };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== "response.output_item.done") continue;
    const item =
      event.item !== null && typeof event.item === "object"
        ? (event.item as Record<string, unknown>)
        : undefined;
    if (item?.type !== "image_generation_call") continue;
    const result = item.result;
    if (typeof result !== "string" || result.length === 0) continue;
    return {
      bytes: Buffer.from(result, "base64"),
      format: typeof item.output_format === "string" ? item.output_format : "png",
      ...(typeof item.revised_prompt === "string"
        ? { revisedPrompt: item.revised_prompt }
        : {}),
    };
  }
  return { error: "the model answered without producing an image" };
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
      const admittedSignal = abortSignalFromArgs(args);
      admittedSignal?.throwIfAborted();
      const session = opts.getSession();
      const provider = session?.services?.provider;
      const identity = readProviderIdentity(provider as never);
      const factory = readProviderFactoryOptions(provider as never);

      // OpenAI reaches the same capability by a different door: the
      // server-side image_generation tool on the Responses endpoint, which
      // is the only one a subscription sign-in can open.
      if (identity === "openai") {
        const prompt = stringValue(args.prompt);
        if (!prompt) return json({ error: "prompt is required" }, true);
        const auth = readOpenAiSubscriptionAuth();
        if (auth === undefined) {
          return json(
            {
              error:
                "ImagineImage on openai needs a ChatGPT subscription sign-in (run the OpenAI sign-in); a platform API key uses a different endpoint that is not wired here yet.",
            },
            true,
          );
        }
        const sessionModel =
          typeof factory.model === "string" ? factory.model.trim() : "";
        const timeout = AbortSignal.timeout(180_000);
        try {
          const generated = await generateViaChatgptBackend({
            auth,
            model: sessionModel.length > 0 ? sessionModel : "gpt-5.6-sol",
            prompt,
            fetchImpl: opts.fetchImpl ?? fetch,
            signal: admittedSignal
              ? AbortSignal.any([admittedSignal, timeout])
              : timeout,
          });
          if ("error" in generated) return json({ error: generated.error }, true);
          const outDir = join(opts.workspaceRoot, ".agenc", "imagine");
          await mkdir(outDir, { recursive: true });
          const path = join(outDir, `imagine-${randomUUID()}.${generated.format}`);
          await writeFile(path, generated.bytes);
          return json({
            model: sessionModel.length > 0 ? sessionModel : "gpt-5.6-sol",
            paths: [path],
            path,
            n: 1,
            ...(generated.revisedPrompt !== undefined
              ? { revised_prompt: generated.revisedPrompt }
              : {}),
          });
        } catch (error) {
          admittedSignal?.throwIfAborted();
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "image generation request failed",
            },
            true,
          );
        }
      }

      if (identity !== "grok") {
        return json(
          {
            error: `ImagineImage has no image route for the ${identity ?? "current"} provider. Switch the session to grok or openai.`,
          },
          true,
        );
      }

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

      const model = stringValue(args.model) ?? "grok-imagine-image";
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
      const timeoutSignal = AbortSignal.timeout(120_000);
      const requestSignal = admittedSignal
        ? AbortSignal.any([admittedSignal, timeoutSignal])
        : timeoutSignal;
      try {
        const res = await fetchImpl(`${baseURL}/images/generations`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
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
              error: payload.error?.message ?? `Imagine HTTP ${res.status}`,
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
            await writeFile(path, Buffer.from(image.b64_json, "base64"), {
              signal: requestSignal,
            });
            paths.push(path);
          } else if (image.url) {
            // URL-only response: download
            const imgRes = await fetchImpl(image.url, {
              signal: requestSignal,
            });
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

// Silence unused import if tree-shaken in some builds — createProvider used only for types.
void createProvider;
