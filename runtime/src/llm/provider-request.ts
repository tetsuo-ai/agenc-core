import type { HomeContext } from "../config/home.js";
import {
  resolveProviderSettings,
  type ResolvedProviderSettings,
} from "../config/resolve-provider.js";
import type { AgenCConfig } from "../config/schema.js";
import type { ProviderFallbackLadderOptions } from "./api/fallback-ladder.js";
import type {
  ProviderFactoryOptions,
  ProviderName,
} from "./provider.js";
import type { ProviderEnvironment } from "./provider-options.js";
import { resolveXaiCapabilityExtra } from "./xai-capability-config.js";

export interface ProviderRuntimeRequest {
  readonly requested: ProviderFactoryOptions;
  readonly settings: ResolvedProviderSettings | undefined;
}

function providerFallbackOptions(params: {
  readonly provider: ProviderName;
  readonly model: string;
  readonly settings: ResolvedProviderSettings | undefined;
}): ProviderFallbackLadderOptions | undefined {
  const targets = params.settings?.fallbackTargets;
  if (!targets || targets.length === 0) return undefined;
  return {
    provider: params.provider,
    model: params.model,
    targets,
    ...(params.settings?.fallbackMaxFailures !== undefined
      ? { maxFailures: params.settings.fallbackMaxFailures }
      : {}),
    ...(params.settings?.fallbackStatuses !== undefined &&
    params.settings.fallbackStatuses.length > 0
      ? { statuses: params.settings.fallbackStatuses }
      : {}),
  };
}

/** Build the non-credential request for startup and later provider switches. */
export function resolveProviderRuntimeRequest(params: {
  readonly provider: ProviderName;
  readonly model: string;
  readonly config: AgenCConfig;
  readonly environment: ProviderEnvironment;
  readonly credentialHome?: HomeContext;
  readonly tools?: ProviderFactoryOptions["tools"];
  readonly baseExtra?: Readonly<Record<string, unknown>>;
  readonly executionAdmissionRequired?: boolean;
}): ProviderRuntimeRequest {
  const settings = resolveProviderSettings(
    params.provider,
    params.config,
    params.environment,
  );
  const providerFallback = params.executionAdmissionRequired === true
    ? undefined
    : providerFallbackOptions({
        provider: params.provider,
        model: params.model,
        settings,
      });
  const extra = {
    ...(params.baseExtra ?? {}),
    ...(settings?.contextWindowTokens !== undefined
      ? { contextWindowTokens: settings.contextWindowTokens }
      : {}),
    ...(settings?.maxOutputTokens !== undefined
      ? { maxTokens: settings.maxOutputTokens }
      : {}),
    ...(params.executionAdmissionRequired === true
      ? { maxRetries: 0 }
      : providerFallback !== undefined
        ? { providerFallback }
        : {}),
    ...resolveXaiCapabilityExtra({
      provider: params.provider,
      baseURL: settings?.baseURL,
      grokCapabilities: params.config.providers?.grok,
      env: params.environment,
    }),
  };
  return Object.freeze({
    settings,
    requested: Object.freeze({
      ...(params.credentialHome !== undefined
        ? { credentialHome: params.credentialHome }
        : {}),
      ...(settings?.baseURL !== undefined ? { baseURL: settings.baseURL } : {}),
      model: params.model,
      ...(settings?.timeoutMs !== undefined
        ? { timeoutMs: settings.timeoutMs }
        : {}),
      ...(params.tools !== undefined ? { tools: [...params.tools] } : {}),
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    }),
  });
}
