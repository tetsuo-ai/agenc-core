import type {
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  StreamProgressCallback,
} from "../../types.js";
import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type KimiProviderConfig = OpenAIProviderConfig;

export const KIMI_CHAT_MODELS = Object.freeze([
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k2.6",
] as const);

const KIMI_CHAT_MODEL_SET = new Set<string>(KIMI_CHAT_MODELS);
const KIMI_GLOBAL_BASE_URL = "https://api.moonshot.ai/v1";

function assertKimiChatModel(model: string | undefined): void {
  if (model === undefined) return;
  if (KIMI_CHAT_MODEL_SET.has(model)) return;
  throw new Error(
    `kimi model ${JSON.stringify(model)} is not in Moonshot's current global chat allowlist`,
  );
}

function withoutFixedSamplingControls(
  options: LLMChatOptions | undefined,
): LLMChatOptions | undefined {
  if (options?.temperature === undefined) return options;
  const { temperature: _temperature, ...rest } = options;
  return rest;
}

function assertKimiGlobalEndpoint(baseURL: string | undefined): void {
  if (baseURL === undefined) return;
  if (baseURL.replace(/\/+$/u, "") !== KIMI_GLOBAL_BASE_URL) {
    throw new Error(
      `kimi is bound to Moonshot's global endpoint ${KIMI_GLOBAL_BASE_URL}`,
    );
  }
}

/** Moonshot's native global Kimi chat-completions provider. */
export class KimiProvider extends OpenAIProvider {
  private readonly configuredKimiModel: string;
  private readonly configuredMaxTokens: number | undefined;

  constructor(config: KimiProviderConfig) {
    assertKimiChatModel(config.model);
    assertKimiGlobalEndpoint(config.baseURL);
    super({
      ...config,
      baseURL: config.baseURL ?? KIMI_GLOBAL_BASE_URL,
      providerName: "kimi",
      useResponsesApi: false,
    });
    this.configuredKimiModel = config.model;
    this.configuredMaxTokens = config.maxTokens;
  }

  override async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    assertKimiChatModel(options?.model);
    return await super.chat(messages, this.withKimiDefaults(options));
  }

  override async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    assertKimiChatModel(options?.model);
    return await super.chatStream(
      messages,
      onChunk,
      this.withKimiDefaults(options),
    );
  }

  private withKimiDefaults(
    options: LLMChatOptions | undefined,
  ): LLMChatOptions {
    const stripped = withoutFixedSamplingControls(options);
    const model = stripped?.model?.trim() || this.configuredKimiModel;
    const defaultMaxOutputTokens = model.toLowerCase() === "kimi-k3"
      ? 131_072
      : 32_768;
    return {
      ...(stripped ?? {}),
      ...(stripped?.maxOutputTokens === undefined
        ? {
            maxOutputTokens:
              this.configuredMaxTokens ?? defaultMaxOutputTokens,
          }
        : {}),
    };
  }
}
