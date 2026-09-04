import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  StreamProgressCallback,
} from "../../types.js";

export type ZaiProviderConfig = OpenAIProviderConfig;
export type ZaiProviderName = "zai" | "zai-coding-plan";

const NON_CHAT_ZAI_MODEL =
  /(?:^|[/:])(?:glm-image(?:-[a-z0-9]+)*|cogview(?:-[a-z0-9]+)*)(?:$|[_.:])/i;

const ZAI_CODING_PLAN_CHAT_MODELS = new Set(["glm-5.3", "glm-5.3-flash"]);

function assertZaiChatModel(
  providerName: ZaiProviderName,
  model: string | undefined,
): void {
  const normalized = model?.trim();
  if (!normalized) return;
  if (NON_CHAT_ZAI_MODEL.test(normalized)) {
    throw new Error(
      `${providerName} model "${normalized}" is not a chat-completions model; ` +
        "select a GLM chat model. Image generation is available through ImagineImage.",
    );
  }
  if (
    providerName === "zai-coding-plan" &&
    !ZAI_CODING_PLAN_CHAT_MODELS.has(normalized.toLowerCase())
  ) {
    throw new Error(
      `Z.AI Coding Plan model "${normalized}" is not in the current ` +
        "glm-5.3 / glm-5.3-flash chat allowlist",
    );
  }
}

function assertZaiTemperature(
  providerName: ZaiProviderName,
  temperature: number | undefined,
): void {
  if (temperature === undefined) return;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
    throw new RangeError(`${providerName} temperature must be between 0 and 1`);
  }
}

function knownZaiEndpointMode(
  baseURL: string | undefined,
): ZaiProviderName | undefined {
  if (!baseURL) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    return undefined;
  }
  if (parsed.hostname.toLowerCase() !== "api.z.ai") return undefined;
  const path = parsed.pathname.replace(/\/+$/u, "").toLowerCase();
  if (path === "/api/coding/paas/v4") return "zai-coding-plan";
  if (path === "/api/paas/v4") return "zai";
  return undefined;
}

function assertZaiModeConfiguration(
  providerName: ZaiProviderName,
  config: ZaiProviderConfig,
): void {
  const endpointMode = knownZaiEndpointMode(config.baseURL);
  if (endpointMode !== undefined && endpointMode !== providerName) {
    throw new Error(
      `${providerName} cannot use the ${endpointMode} endpoint; ` +
        "Z.AI billing modes require matching keys and Base URLs",
    );
  }
}

class ZaiBaseProvider extends OpenAIProvider {
  private readonly defaultTemperature: number | undefined;
  private readonly zaiProviderName: ZaiProviderName;

  constructor(providerName: ZaiProviderName, config: ZaiProviderConfig) {
    assertZaiChatModel(providerName, config.model);
    assertZaiTemperature(providerName, config.temperature);
    assertZaiModeConfiguration(providerName, config);
    super({
      ...config,
      providerName,
      useResponsesApi: false,
    });
    this.zaiProviderName = providerName;
    this.defaultTemperature = config.temperature;
  }

  override async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const effectiveOptions = this.withDefaultTemperature(options);
    assertZaiChatModel(this.zaiProviderName, effectiveOptions?.model);
    assertZaiTemperature(this.zaiProviderName, effectiveOptions?.temperature);
    return await super.chat(messages, effectiveOptions);
  }

  override async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const effectiveOptions = this.withDefaultTemperature(options);
    assertZaiChatModel(this.zaiProviderName, effectiveOptions?.model);
    assertZaiTemperature(this.zaiProviderName, effectiveOptions?.temperature);
    return await super.chatStream(messages, onChunk, effectiveOptions);
  }

  private withDefaultTemperature(
    options: LLMChatOptions | undefined,
  ): LLMChatOptions | undefined {
    if (
      options?.temperature !== undefined ||
      this.defaultTemperature === undefined
    ) {
      return options;
    }
    return { ...options, temperature: this.defaultTemperature };
  }
}

/** Z.AI Pay-As-You-Go adapter over the OpenAI-compatible GLM chat wire. */
export class ZaiProvider extends ZaiBaseProvider {
  constructor(config: ZaiProviderConfig) {
    super("zai", config);
  }
}

/** Z.AI Coding Plan adapter. Its credential and endpoint are PAYG-isolated. */
export class ZaiCodingPlanProvider extends ZaiBaseProvider {
  constructor(config: ZaiProviderConfig) {
    super("zai-coding-plan", config);
  }
}
