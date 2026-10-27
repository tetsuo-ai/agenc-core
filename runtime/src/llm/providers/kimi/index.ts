import { KIMI_CHAT_MODELS, isKimiK3Model } from "../../registry/kimi-models.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  StreamProgressCallback,
} from "../../types.js";
import { BUILT_IN_PROVIDER_BASE_URLS } from "../../registry/provider-info.js";
import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import { getSelectedProviderEnvironment } from "../../../utils/model/providers.js";

export type KimiProviderConfig = OpenAIProviderConfig;

export { KIMI_CHAT_MODELS } from "../../registry/kimi-models.js";

const KIMI_CHAT_MODEL_SET = new Set<string>(KIMI_CHAT_MODELS);
const KIMI_GLOBAL_BASE_URL = BUILT_IN_PROVIDER_BASE_URLS.kimi;

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
  if (
    baseURL !== KIMI_GLOBAL_BASE_URL &&
    baseURL !== `${KIMI_GLOBAL_BASE_URL}/`
  ) {
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
    // Moonshot limits stop to five strings, each at most 32 UTF-8 bytes.
    // https://platform.kimi.ai/docs/api/chat
    if (stripped?.stopSequences && (stripped.stopSequences.length > 5 ||
      stripped.stopSequences.some(stop => Buffer.byteLength(stop, "utf8") > 32))) {
      throw new RangeError("Kimi accepts at most five stop sequences of at most 32 UTF-8 bytes each");
    }
    const model = stripped?.model?.trim() || this.configuredKimiModel;
    let cacheTtl = stripped?.promptCacheTtl;
    if (cacheTtl === undefined && isKimiK3Model(model)) {
      // Session-scoped environment preserves daemon/client isolation.
      let configured: string | undefined;
      try { configured = getSelectedProviderEnvironment().AGENC_KIMI_CACHE_TTL; } catch { /* No bound session. */ }
      if (configured !== undefined && configured !== "5m" && configured !== "1h") {
        throw new RangeError("AGENC_KIMI_CACHE_TTL must be 5m or 1h");
      }
      cacheTtl = configured;
    }
    const defaultMaxOutputTokens = isKimiK3Model(model)
      ? 131_072
      : 32_768;
    return {
      ...stripped,
      ...(cacheTtl !== undefined ? { promptCacheTtl: cacheTtl } : {}),
      ...(stripped?.maxOutputTokens === undefined
        ? {
            maxOutputTokens:
              this.configuredMaxTokens ?? defaultMaxOutputTokens,
          }
        : {}),
    };
  }
}
