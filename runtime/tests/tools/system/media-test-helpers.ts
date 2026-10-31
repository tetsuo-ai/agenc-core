import { join } from "node:path";

import { resolveHomeContext, type HomeContext } from "../../../src/config/home.js";
import {
  isFactoryProvider,
  readProviderFactoryOptions,
  readProviderIdentity,
} from "../../../src/llm/provider.js";
import type { LLMProvider } from "../../../src/llm/types.js";
import { SessionProviderService } from "../../../src/session/provider-service.js";
import {
  createModelFacingTools,
  type ModelFacingToolOptions,
} from "../../../src/bin/model-facing-tools.js";

export function mediaTestHome(workspaceRoot: string) {
  return resolveHomeContext(
    {
      AGENC_HOME: join(workspaceRoot, ".agenc-test-home"),
      HOME: workspaceRoot,
    },
    { platformHome: workspaceRoot },
  );
}

/**
 * A session's own live provider state, as the runtime gives every session:
 * a real provider service over `provider`, seeded with `environment` and
 * `credentialHome`. Tools read it at call time, so `useSessionApiKey` on it
 * reaches them at once.
 */
export function ownProviderState(
  provider: LLMProvider,
  environment: Readonly<Record<string, string | undefined>> = {},
  credentialHome?: HomeContext,
): SessionProviderService {
  const config = (provider as unknown as { readonly config?: { readonly model?: unknown } }).config;
  const model = readProviderFactoryOptions(provider).model ??
    (typeof config?.model === "string" ? config.model : undefined);
  return new SessionProviderService({
    initialProvider: provider,
    ...(isFactoryProvider(provider)
      ? {}
      : {
          initialProviderName: readProviderIdentity(provider) ?? provider.name,
          ...(model !== undefined ? { initialModel: model } : {}),
        }),
    environment,
    ...(credentialHome !== undefined ? { credentialHome } : {}),
  });
}

export function isModelFacingToolRegistered(
  name: string,
  options: ModelFacingToolOptions,
): boolean {
  return createModelFacingTools(options).some((tool) => tool.name === name);
}

/**
 * A slice of Venice's GET /api/v1/models?type=all answer (2026-10-20): the
 * rows the media tools read for prices, voices and video shapes.
 */
export const VENICE_MEDIA_LIST = {
  data: [
    { id: "z-image-turbo", type: "image", model_spec: { pricing: { generation: { usd: 0.01 } }, constraints: { promptCharacterLimit: 1500 } } },
    {
      id: "grok-imagine-image-quality", type: "image",
      model_spec: {
        pricing: { resolutions: { "1K": { usd: 0.06 }, "2K": { usd: 0.09 } } },
        constraints: { defaultResolution: "1K", resolutions: ["1K", "2K"], aspectRatios: ["1:1", "16:9"] },
      },
    },
    {
      id: "gpt-image-2", type: "image",
      model_spec: {
        pricing: {
          resolutions: { "1K": { usd: 0.27 }, "2K": { usd: 0.51 } },
          quality: { "1K": { low: { usd: 0.05 }, high: { usd: 0.27 } } },
        },
        constraints: { defaultResolution: "1K", resolutions: ["1K", "2K"], defaultQuality: "high" },
      },
    },
    { id: "firered-image-edit", type: "inpaint", model_spec: { pricing: { inpaint: { usd: 0.04 } }, constraints: {} } },
    {
      id: "grok-imagine-edit", type: "inpaint",
      model_spec: {
        pricing: {
          inpaint: { usd: 0.03 }, resolutions: { "1K": { usd: 0.03 }, "2K": { usd: 0.04 } },
          inputImages: { included: 0, additional: { usd: 0.0023 } },
        },
        constraints: {},
      },
    },
    { id: "upscaler", type: "upscale", model_spec: { pricing: { upscale: { "2x": { usd: 0.02 }, "4x": { usd: 0.08 } } } } },
    { id: "tts-kokoro", type: "tts", model_spec: { pricing: { input: { usd: 3.5 } }, voices: ["af_alloy", "af_sky"] } },
    {
      id: "tts-elevenlabs-turbo-v2-5", type: "tts",
      model_spec: { pricing: { input: { usd: 62.5 } }, voices: ["Alice", "Aria"], default_format: "mp3", supported_formats: ["mp3"] },
    },
    {
      id: "tts-orpheus", type: "tts",
      model_spec: { pricing: { input: { usd: 62.5 } }, voices: ["dan", "jess"], default_format: "wav", supported_formats: ["wav"] },
    },
    {
      id: "seedance-2-0-text-to-video", type: "video",
      model_spec: { constraints: { model_type: "text-to-video", aspect_ratios: ["16:9", "9:16"], resolutions: ["720p", "480p"], durations: ["5s", "10s"] } },
    },
    {
      id: "minimax-h3-max-turbo-text-to-video", type: "video",
      model_spec: { constraints: { model_type: "text-to-video", aspect_ratios: ["16:9"], resolutions: ["768P", "480P"], durations: ["6s", "10s"] } },
    },
    {
      id: "seedance-2-0-image-to-video", type: "video",
      model_spec: { constraints: { model_type: "image-to-video", aspect_ratios: [], resolutions: ["480p"], durations: ["5s"] } },
    },
    { id: "zai-org-glm-5-2", type: "text", model_spec: { capabilities: { supportsFunctionCalling: true } } },
  ],
};
