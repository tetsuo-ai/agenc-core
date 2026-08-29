import {
  createProvider,
  resolveBuiltInProviderSlug,
  readProviderFactoryOptions,
  readProviderIdentity,
  type ProviderFactoryOptions,
  type ProviderName,
} from "../../llm/provider.js";
import type { LLMProvider } from "../../llm/types.js";
import type {
  CodePredictionSource,
  OwnedCodePredictionProvider,
} from "./types.js";

interface PredictionForkableProvider extends LLMProvider {
  forkForCodePrediction?(options: {
    readonly provider?: ProviderName;
    readonly model?: string;
    readonly timeoutMs: number;
    readonly maxOutputTokens: number;
  }): LLMProvider | Promise<LLMProvider>;
}

const CROSS_PROVIDER_EXTRA_KEYS = new Set([
  "authBackend",
  "sessionId",
  "subscriptionTier",
  "fetchImpl",
]);

function routeExtra(
  options: ProviderFactoryOptions,
  sameProvider: boolean,
  maxOutputTokens: number,
): Record<string, unknown> {
  const source = options.extra ?? {};
  const extra = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => sameProvider || CROSS_PROVIDER_EXTRA_KEYS.has(key),
    ),
  );
  delete extra.providerFallback;
  delete extra.tools;
  return {
    ...extra,
    maxTokens: maxOutputTokens,
    maxRetries: 0,
    temperature: 0,
  };
}

export async function createOwnedCodePredictionProvider(params: {
  readonly source: CodePredictionSource;
  readonly provider?: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
}): Promise<OwnedCodePredictionProvider> {
  const sourceName = readProviderIdentity(
    params.source.provider,
    params.source.provider.name,
  );
  const requestedName =
    params.provider === undefined
      ? sourceName
      : resolveBuiltInProviderSlug(params.provider);
  if (requestedName === null || requestedName === undefined) {
    throw new Error(
      `code prediction provider is unknown: ${params.provider ?? params.source.provider.name}`,
    );
  }
  const sourceOptions = readProviderFactoryOptions(params.source.provider);
  const sameProvider = sourceName === requestedName;
  // A model identifier is meaningful only within its provider. Inheriting the
  // active route's model while switching providers can silently dispatch an
  // invalid model (for example, an AgenC alias on an OpenAI route).
  const model =
    params.model?.trim() ||
    (sameProvider ? sourceOptions.model?.trim() : undefined);
  const forkable = params.source.provider as PredictionForkableProvider;
  let provider: LLMProvider;
  if (
    typeof forkable.forkForCodePrediction === "function" &&
    sourceName === "agenc"
  ) {
    provider = await forkable.forkForCodePrediction({
      provider: requestedName,
      ...(model !== undefined ? { model } : {}),
      timeoutMs: params.timeoutMs,
      maxOutputTokens: params.maxOutputTokens,
    });
  } else {
    provider = createProvider(requestedName, {
      ...(sameProvider && sourceOptions.apiKey !== undefined
        ? { apiKey: sourceOptions.apiKey }
        : {}),
      ...(sameProvider && sourceOptions.baseURL !== undefined
        ? { baseURL: sourceOptions.baseURL }
        : {}),
      ...(model !== undefined ? { model } : {}),
      tools: [],
      timeoutMs: params.timeoutMs,
      extra: routeExtra(sourceOptions, sameProvider, params.maxOutputTokens),
    });
  }
  const resolvedOptions = readProviderFactoryOptions(provider);
  const resolvedName =
    readProviderIdentity(provider, requestedName) ?? requestedName;
  const resolvedModel = resolvedOptions.model?.trim() || model || "default";
  let disposed = false;
  return {
    provider,
    providerName: resolvedName,
    model: resolvedModel,
    routeKey: [
      params.source.workspaceRoot,
      resolvedName,
      resolvedModel,
      params.timeoutMs,
      params.maxOutputTokens,
    ].join("\0"),
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await provider.dispose?.();
    },
  };
}
