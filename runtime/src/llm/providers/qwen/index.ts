import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type QwenProviderConfig = OpenAIProviderConfig;

export type QwenCloudProviderName = "qwen" | "qwen-token-plan";

const NON_CHAT_QWEN_MODEL =
  /(?:^|[/:])(?:qwen-image|qwen-audio|qwen-tts|qwen-asr|wan\d|qwen.*(?:embedding|rerank))(?:$|[-_.:])/i;
const TOKEN_PLAN_QWEN_CHAT_MODELS = new Set([
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-flash",
]);

function assertQwenChatModel(
  providerName: QwenCloudProviderName,
  model: string | undefined,
): void {
  const normalized = model?.trim();
  if (!normalized) return;
  if (NON_CHAT_QWEN_MODEL.test(normalized)) {
    throw new Error(
      `${providerName} model "${normalized}" is not a chat-completions model; ` +
        "select a Qwen text/vision chat model. Image generation is available through ImagineImage.",
    );
  }
  if (
    providerName === "qwen-token-plan" &&
    !TOKEN_PLAN_QWEN_CHAT_MODELS.has(normalized.toLowerCase())
  ) {
    throw new Error(
      `qwen-token-plan model "${normalized}" is not in the current Token Plan Qwen chat allowlist`,
    );
  }
}

function knownEndpointMode(baseURL: string | undefined): QwenCloudProviderName | undefined {
  if (!baseURL) return undefined;
  let hostname: string;
  try {
    hostname = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (hostname.startsWith("token-plan.")) return "qwen-token-plan";
  if (
    hostname === "dashscope-intl.aliyuncs.com" ||
    hostname === "dashscope.aliyuncs.com" ||
    hostname.endsWith(".maas.aliyuncs.com")
  ) {
    return "qwen";
  }
  return undefined;
}

function assertQwenCloudModeConfiguration(
  providerName: QwenCloudProviderName,
  config: QwenProviderConfig,
): void {
  const apiKey = config.apiKey?.trim();
  if (providerName === "qwen" && apiKey?.startsWith("sk-sp-")) {
    throw new Error(
      "qwen Pay-As-You-Go cannot use a Token Plan sk-sp- key; select qwen-token-plan instead",
    );
  }
  if (
    providerName === "qwen-token-plan" &&
    apiKey?.startsWith("sk-") &&
    !apiKey.startsWith("sk-sp-")
  ) {
    throw new Error(
      "qwen-token-plan requires its dedicated sk-sp- key; Pay-As-You-Go keys are not interchangeable",
    );
  }
  const endpointMode = knownEndpointMode(config.baseURL);
  if (endpointMode !== undefined && endpointMode !== providerName) {
    throw new Error(
      `${providerName} cannot use the ${endpointMode} endpoint; QwenCloud billing modes require matching keys and Base URLs`,
    );
  }
}

/** QwenCloud Pay-As-You-Go adapter over the OpenAI-compatible chat wire. */
export class QwenProvider extends OpenAIProvider {
  constructor(config: QwenProviderConfig) {
    assertQwenChatModel("qwen", config.model);
    assertQwenCloudModeConfiguration("qwen", config);
    super({
      ...config,
      providerName: "qwen",
      useResponsesApi: false,
    });
  }
}

/** QwenCloud Token Plan adapter. Its key and endpoint are isolated from PAYG. */
export class QwenTokenPlanProvider extends OpenAIProvider {
  constructor(config: QwenProviderConfig) {
    assertQwenChatModel("qwen-token-plan", config.model);
    assertQwenCloudModeConfiguration("qwen-token-plan", config);
    super({
      ...config,
      providerName: "qwen-token-plan",
      useResponsesApi: false,
    });
  }
}
