/**
 * Source-aligned with `src/services/tokenEstimation.ts` at donor commit
 * 0ca43335375beec6e58711b797d5b0c4bb5019b8.
 *
 * Shape differences:
 *   - AgenC keeps deterministic local estimators in `llm/token-estimation.ts`
 *     and layers provider API counting here.
 *   - Provider clients, Bedrock SDK loading, and optional VCR-style caching are
 *     injected so this service does not read API keys or import optional cloud
 *     SDKs until a caller explicitly chooses that path.
 */

import ProviderSdk from "@anthropic-ai/sdk";
import type {
  BetaMessageParam,
  BetaToolUnion,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";

import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
} from "../llm/registry/provider-info.js";
import {
  roughTokenCountEstimationForMessages,
  type TokenEstimationContent,
  type TokenEstimationMessage,
  type TokenizerProviderHint,
} from "../llm/token-estimation.js";
import { isRecord } from "../utils/record.js";

export {
  bytesPerTokenForFileType,
  detectContentType,
  estimateWithBounds,
  getBytesPerTokenForModel,
  getBytesPerTokenForProvider,
  getCompressionRatio,
  getTokenizerConfig,
  getTokenizerConfigForProvider,
  roughTokenCountEstimation,
  roughTokenCountEstimationForContent,
  roughTokenCountEstimationForFileType,
  roughTokenCountEstimationForMessage,
  roughTokenCountEstimationForMessages,
  roughTokenCountEstimationForProvider,
} from "../llm/token-estimation.js";
export type {
  ContentType,
  ModelTokenizerConfig,
  TokenEstimateBounds,
  TokenEstimationContent,
  TokenEstimationMessage,
  TokenizerProviderHint,
} from "../llm/token-estimation.js";

export type TokenCountProvider = "anthropic" | "bedrock" | "vertex";

type AnthropicCountTokensClient = {
  readonly beta: {
    readonly messages: {
      readonly countTokens: (
        input: Record<string, unknown>,
      ) => Promise<{ readonly input_tokens?: number }>;
      readonly create?: (
        input: Record<string, unknown>,
      ) => Promise<{
        readonly usage?: {
          readonly input_tokens?: number;
          readonly cache_creation_input_tokens?: number;
          readonly cache_read_input_tokens?: number;
        };
      }>;
    };
  };
};

type BedrockRuntimeClient = {
  readonly send: (
    command: unknown,
  ) => Promise<{ readonly inputTokens?: number | null }>;
};

type BedrockRuntimeModule = {
  readonly BedrockRuntimeClient?: new (config: Record<string, unknown>) => BedrockRuntimeClient;
  readonly CountTokensCommand: new (input: Record<string, unknown>) => unknown;
};

export type TokenCountCacheWrapper = <T>(
  messages: readonly BetaMessageParam[],
  tools: readonly BetaToolUnion[],
  run: () => Promise<T>,
) => Promise<T>;

export interface CountMessagesTokensOptions {
  readonly provider?: TokenCountProvider;
  readonly model?: string;
  readonly betas?: readonly string[];
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly timeoutMs?: number;
  readonly anthropicClient?: AnthropicCountTokensClient;
  readonly createAnthropicClient?: (
    options: CountMessagesTokensOptions,
  ) => AnthropicCountTokensClient | Promise<AnthropicCountTokensClient>;
  readonly bedrockClient?: BedrockRuntimeClient;
  readonly bedrockRegion?: string;
  readonly bedrockEndpoint?: string;
  readonly loadBedrockRuntimeModule?: () => Promise<BedrockRuntimeModule>;
  readonly resolveInferenceProfileBackingModel?: (
    profileId: string,
  ) => Promise<string | null>;
  readonly withTokenCountCache?: TokenCountCacheWrapper;
  readonly logError?: (error: unknown) => void;
}

export interface CountTokensViaSmallModelOptions extends CountMessagesTokensOptions {
  readonly fallbackModel?: string;
}

const TOKEN_COUNT_THINKING_BUDGET = 1024;
const TOKEN_COUNT_MAX_TOKENS = 2048;
const TOKEN_COUNT_SMALL_MODEL =
  "claude-haiku-4-5"; // branding-scan: allow documented Anthropic API model identifier

const ANTHROPIC_CLI_20250219_BETA_HEADER =
  "claude-code-20250219"; // branding-scan: allow provider-defined Anthropic beta header
const INTERLEAVED_THINKING_BETA_HEADER = "interleaved-thinking-2025-05-14";
const CONTEXT_MANAGEMENT_BETA_HEADER = "context-management-2025-06-27";

export const VERTEX_COUNT_TOKENS_ALLOWED_BETAS = new Set([
  ANTHROPIC_CLI_20250219_BETA_HEADER,
  INTERLEAVED_THINKING_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
]);

const defaultCacheWrapper: TokenCountCacheWrapper = async (
  _messages,
  _tools,
  run,
) => run();

export async function countTokensWithAPI(
  content: string,
  options: CountMessagesTokensOptions = {},
): Promise<number | null> {
  if (!content) {
    return 0;
  }

  return countMessagesTokensWithAPI(
    [{ role: "user", content }],
    [],
    options,
  );
}

export async function countMessagesTokensWithAPI(
  messages: readonly BetaMessageParam[],
  tools: readonly BetaToolUnion[],
  options: CountMessagesTokensOptions = {},
): Promise<number | null> {
  const withTokenCountCache =
    options.withTokenCountCache ?? defaultCacheWrapper;
  return withTokenCountCache(messages, tools, async () => {
    try {
      const provider = options.provider ?? "anthropic";
      const model = options.model ?? BUILT_IN_PROVIDER_DEFAULT_MODELS.anthropic;
      const betas = options.betas ?? [];
      const containsThinking = hasThinkingBlocks(messages);

      if (provider === "bedrock") {
        return countTokensWithBedrock({
          model,
          messages,
          tools,
          betas,
          containsThinking,
          options,
        });
      }

      const client = await resolveAnthropicClient(options);
      if (!client) {
        return null;
      }
      const filteredBetas =
        provider === "vertex"
          ? betas.filter((beta) => VERTEX_COUNT_TOKENS_ALLOWED_BETAS.has(beta))
          : betas;

      const response = await client.beta.messages.countTokens({
        model,
        messages:
          messages.length > 0 ? messages : [{ role: "user", content: "foo" }],
        ...(tools.length > 0 ? { tools } : {}),
        ...(filteredBetas.length > 0 ? { betas: filteredBetas } : {}),
        ...(containsThinking
          ? {
            thinking: {
              type: "enabled",
              budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
            },
          }
          : {}),
      });

      return typeof response.input_tokens === "number"
        ? response.input_tokens
        : null;
    } catch (error) {
      options.logError?.(error);
      return null;
    }
  });
}

export async function countTokensViaHaikuFallback(
  messages: readonly BetaMessageParam[],
  tools: readonly BetaToolUnion[],
  options: CountTokensViaSmallModelOptions = {},
): Promise<number | null> {
  try {
    const containsThinking = hasThinkingBlocks(messages);
    const model = resolveFallbackTokenCountModel(options, containsThinking);
    const client = await resolveAnthropicClient({ ...options, model });
    const create = client?.beta.messages.create;
    if (!create) {
      return null;
    }

    const normalizedMessages = stripToolSearchFieldsFromMessages(messages);
    const messagesToSend =
      normalizedMessages.length > 0
        ? normalizedMessages
        : [{ role: "user", content: "count" } satisfies BetaMessageParam];
    const betas =
      (options.provider ?? "anthropic") === "vertex"
        ? (options.betas ?? []).filter((beta) =>
          VERTEX_COUNT_TOKENS_ALLOWED_BETAS.has(beta),
        )
        : (options.betas ?? []);

    const response = await create({
      model,
      max_tokens: containsThinking ? TOKEN_COUNT_MAX_TOKENS : 1,
      messages: messagesToSend,
      ...(tools.length > 0 ? { tools } : {}),
      ...(betas.length > 0 ? { betas } : {}),
      ...(containsThinking
        ? {
          thinking: {
            type: "enabled",
            budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
          },
        }
        : {}),
    });

    const usage = response.usage;
    if (!usage) {
      return null;
    }
    return (
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0)
    );
  } catch (error) {
    options.logError?.(error);
    return null;
  }
}

export function roughTokenCountEstimationForServiceMessages(
  messages: readonly TokenEstimationMessage[],
  hint: TokenizerProviderHint = {},
): number {
  return roughTokenCountEstimationForMessages(
    normalizeAttachmentsForTokenEstimation(messages),
    hint,
  );
}

export function normalizeAttachmentsForTokenEstimation(
  messages: readonly TokenEstimationMessage[],
): readonly TokenEstimationMessage[] {
  return messages.map((message) => {
    if (message.type !== "attachment" || message.attachment === undefined) {
      return message;
    }
    const { attachment: _attachment, ...rest } = message;
    return {
      ...rest,
      content: normalizeAttachmentContent(_attachment),
    };
  });
}

function normalizeAttachmentContent(
  attachment: unknown,
): TokenEstimationContent {
  if (!isRecord(attachment)) {
    return attachment as TokenEstimationContent;
  }
  if (attachment.kind === "image_mention" && Array.isArray(attachment.images)) {
    return attachment.images.map(() => ({ type: "image" }));
  }
  if (attachment.kind === "pdf_mention" && Array.isArray(attachment.pdfs)) {
    return attachment.pdfs.map(() => ({ type: "document" }));
  }
  if (
    attachment.type === "edited_image_file" ||
    attachment.kind === "edited_image_file" ||
    attachment.kind === "image"
  ) {
    return { type: "image" };
  }
  if (
    attachment.type === "pdf" ||
    attachment.kind === "pdf"
  ) {
    return { type: "document" };
  }
  if (attachment.kind === "edited_text_file" && typeof attachment.snippet === "string") {
    return attachment.snippet;
  }
  if (attachment.kind === "file_mention" && Array.isArray(attachment.files)) {
    return attachment.files
      .map((file) => isRecord(file) && typeof file.content === "string" ? file.content : "")
      .filter((content) => content.length > 0)
      .join("\n\n");
  }
  if ("content" in attachment) {
    return attachment.content as TokenEstimationContent;
  }
  if ("message" in attachment && isRecord(attachment.message)) {
    return attachment.message.content as TokenEstimationContent;
  }
  return attachment as TokenEstimationContent;
}

export function hasThinkingBlocks(
  messages: readonly BetaMessageParam[],
): boolean {
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          isRecord(block) &&
          (block.type === "thinking" || block.type === "redacted_thinking")
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

export function stripToolSearchFieldsFromMessages(
  messages: readonly BetaMessageParam[],
): BetaMessageParam[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) {
      return message;
    }

    return {
      ...message,
      content: message.content.map((block) => {
        if (isRecord(block) && block.type === "tool_use") {
          return {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          } as unknown;
        }

        if (isRecord(block) && block.type === "tool_result") {
          const content = block.content;
          if (Array.isArray(content)) {
            const filteredContent = content.filter(
              (entry) => !isToolReferenceBlock(entry),
            );
            if (filteredContent.length === 0) {
              return {
                ...block,
                content: [{ type: "text", text: "[tool references]" }],
              };
            }
            if (filteredContent.length !== content.length) {
              return {
                ...block,
                content: filteredContent,
              };
            }
          }
        }

        return block;
      }) as BetaMessageParam["content"],
    } as BetaMessageParam;
  });
}

export function isToolReferenceBlock(value: unknown): boolean {
  return isRecord(value) && value.type === "tool_reference";
}

export function isBedrockFoundationModel(modelId: string): boolean {
  return extractBedrockModelIdFromArn(modelId).startsWith("anthropic.");
}

export function extractBedrockModelIdFromArn(modelId: string): string {
  if (!modelId.startsWith("arn:")) {
    return modelId;
  }
  const lastSlashIndex = modelId.lastIndexOf("/");
  return lastSlashIndex >= 0 ? modelId.slice(lastSlashIndex + 1) : modelId;
}

export async function resolveBedrockCountModelId(
  model: string,
  options: Pick<CountMessagesTokensOptions, "resolveInferenceProfileBackingModel"> = {},
): Promise<string | null> {
  const modelId = extractBedrockModelIdFromArn(model);
  if (isBedrockFoundationModel(modelId)) {
    return modelId;
  }
  return options.resolveInferenceProfileBackingModel?.(modelId) ?? null;
}

export function resolveFallbackTokenCountModel(
  options: CountTokensViaSmallModelOptions,
  containsThinking: boolean,
): string {
  if (options.fallbackModel) {
    return options.fallbackModel;
  }
  if (
    containsThinking &&
    (options.provider === "bedrock" || options.provider === "vertex")
  ) {
    return options.model ?? BUILT_IN_PROVIDER_DEFAULT_MODELS.anthropic;
  }
  return TOKEN_COUNT_SMALL_MODEL;
}

async function countTokensWithBedrock({
  model,
  messages,
  tools,
  betas,
  containsThinking,
  options,
}: {
  readonly model: string;
  readonly messages: readonly BetaMessageParam[];
  readonly tools: readonly BetaToolUnion[];
  readonly betas: readonly string[];
  readonly containsThinking: boolean;
  readonly options: CountMessagesTokensOptions;
}): Promise<number | null> {
  try {
    const module = await loadBedrockRuntimeModule(options);
    if (!module) {
      return null;
    }
    const client = await resolveBedrockRuntimeClient(options, module);
    if (!client) {
      return null;
    }
    const modelId = await resolveBedrockCountModelId(model, options);
    if (!modelId) {
      return null;
    }

    const requestBody = {
      anthropic_version: "bedrock-2023-05-31",
      messages:
        messages.length > 0 ? messages : [{ role: "user", content: "foo" }],
      max_tokens: containsThinking ? TOKEN_COUNT_MAX_TOKENS : 1,
      ...(tools.length > 0 ? { tools } : {}),
      ...(betas.length > 0 ? { anthropic_beta: betas } : {}),
      ...(containsThinking
        ? {
          thinking: {
            type: "enabled",
            budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
          },
        }
        : {}),
    };

    const command = new module.CountTokensCommand({
      modelId,
      input: {
        invokeModel: {
          body: new TextEncoder().encode(JSON.stringify(requestBody)),
        },
      },
    });
    const response = await client.send(command);
    return typeof response.inputTokens === "number"
      ? response.inputTokens
      : null;
  } catch (error) {
    options.logError?.(error);
    return null;
  }
}

async function resolveAnthropicClient(
  options: CountMessagesTokensOptions,
): Promise<AnthropicCountTokensClient | null> {
  if (options.anthropicClient) {
    return options.anthropicClient;
  }
  if (options.createAnthropicClient) {
    return options.createAnthropicClient(options);
  }
  if (!options.apiKey) {
    return null;
  }
  return new ProviderSdk({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    maxRetries: 1,
    timeout: options.timeoutMs,
  }) as unknown as AnthropicCountTokensClient;
}

async function resolveBedrockRuntimeClient(
  options: CountMessagesTokensOptions,
  module?: BedrockRuntimeModule,
): Promise<BedrockRuntimeClient | null> {
  if (options.bedrockClient) {
    return options.bedrockClient;
  }
  const resolvedModule = module ?? await loadBedrockRuntimeModule(options);
  const ClientCtor = resolvedModule?.BedrockRuntimeClient;
  if (!ClientCtor) {
    return null;
  }
  return new ClientCtor({
    ...(options.bedrockRegion ? { region: options.bedrockRegion } : {}),
    ...(options.bedrockEndpoint ? { endpoint: options.bedrockEndpoint } : {}),
  });
}

async function loadBedrockRuntimeModule(
  options: CountMessagesTokensOptions,
): Promise<BedrockRuntimeModule | null> {
  if (options.loadBedrockRuntimeModule) {
    return options.loadBedrockRuntimeModule();
  }
  try {
    // Literal specifier so esbuild discovers @aws-sdk/client-bedrock-runtime
    // as an external dep at bundle time. The previous indirection
    // through importOptionalRuntimeModule(specifier) defeated static
    // discovery because the parameter type was string; esbuild could not
    // see what was being imported.
    return (await import(
      "@aws-sdk/client-bedrock-runtime"
    )) as unknown as BedrockRuntimeModule;
  } catch (error) {
    options.logError?.(error);
    return null;
  }
}
