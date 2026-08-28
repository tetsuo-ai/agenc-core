import type { HomeContext } from "../../config/home.js";
import type { ProviderRuntimeExtra } from "../provider.js";
import type { ProviderEnvironment } from "../provider-options.js";
import type { ProviderBinding } from "../../session/provider-service.js";
import { isGrokComposerModel } from "../providers/grok/acp-adapter.js";
import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  providerCredentialEnvironmentLabel,
  resolveBuiltInProviderSlug,
  type BuiltInProviderSlug,
} from "./provider-info.js";

export type ProviderConnectionTransport =
  | "anthropic"
  | "openai-compatible"
  | "native";

export interface BoundProviderConnection {
  /** The real selected provider. This is never replaced by its wire protocol. */
  readonly provider: BuiltInProviderSlug;
  /** The compatibility client family, separate from provider identity. */
  readonly transport: ProviderConnectionTransport;
  readonly model: string;
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly authToken?: string;
  readonly credentialHome?: HomeContext;
  readonly timeoutMs?: number;
  readonly extra: Readonly<ProviderRuntimeExtra>;
  /** Session-captured process inputs used only for proxying and diagnostics. */
  readonly environment: ProviderEnvironment;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function transportForProvider(
  provider: BuiltInProviderSlug,
  model: string,
  extra: Readonly<ProviderRuntimeExtra>,
): ProviderConnectionTransport {
  if (
    provider === "agenc" ||
    extra.managedCredential === true ||
    (provider === "grok" &&
      (extra.grokAcp !== undefined || isGrokComposerModel(model)))
  ) {
    return "native";
  }
  switch (provider) {
    case "anthropic":
      return "anthropic";
    case "github":
      return model.toLowerCase().includes("claude-")
        ? "anthropic"
        : "openai-compatible";
    case "gemini":
    case "amazon-bedrock":
      return "native";
    default:
      return "openai-compatible";
  }
}

function snapshotPreparedValue(
  value: unknown,
  seen: WeakMap<object, unknown>,
): unknown {
  if (value === null || typeof value !== "object") return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  if (Array.isArray(value)) {
    const snapshot: unknown[] = [];
    seen.set(value, snapshot);
    snapshot.push(...value.map((entry) => snapshotPreparedValue(entry, seen)));
    return Object.freeze(snapshot);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const snapshot: Record<string, unknown> = Object.create(prototype);
  seen.set(value, snapshot);
  for (const [key, entry] of Object.entries(value)) {
    snapshot[key] = snapshotPreparedValue(entry, seen);
  }
  return Object.freeze(snapshot);
}

export function snapshotProviderRuntimeExtra(
  extra: Readonly<Record<string, unknown>> | undefined,
): Readonly<ProviderRuntimeExtra> {
  return snapshotPreparedValue(
    extra ?? {},
    new WeakMap<object, unknown>(),
  ) as Readonly<ProviderRuntimeExtra>;
}

/**
 * Project the immutable provider connection from a prepared session binding.
 * Credential, endpoint, model, timeout, and adapter extras have already been
 * resolved at provider ingress; this function never performs another merge.
 */
export function projectBoundProviderConnection(options: {
  readonly binding: ProviderBinding;
  readonly environment?: ProviderEnvironment;
}): BoundProviderConnection {
  const provider = resolveBuiltInProviderSlug(options.binding.provider);
  if (provider === undefined) {
    throw new Error(`unknown bound provider "${options.binding.provider}"`);
  }
  const factoryOptions = options.binding.factoryOptions;
  const model =
    nonEmpty(factoryOptions.model) ?? nonEmpty(options.binding.model);
  if (model === undefined) {
    throw new Error(`${provider} provider binding has no prepared model`);
  }
  const bindingModel = nonEmpty(options.binding.model);
  if (bindingModel !== undefined && bindingModel !== model) {
    throw new Error(
      `${provider} provider binding model does not match its prepared factory options`,
    );
  }
  const baseURL = nonEmpty(factoryOptions.baseURL);
  const apiKey = nonEmpty(factoryOptions.apiKey);
  const authToken = nonEmpty(factoryOptions.authToken);
  if (authToken !== undefined && provider !== "anthropic") {
    throw new Error(`${provider} provider binding cannot carry authToken`);
  }
  if (apiKey !== undefined && authToken !== undefined) {
    throw new Error(
      `${provider} provider binding has more than one prepared credential`,
    );
  }
  const extra = snapshotProviderRuntimeExtra(factoryOptions.extra);
  const credentials = BUILT_IN_PROVIDER_DEFINITIONS[provider].credentials;
  const hasPreparedOAuth =
    extra.authMode === "oauth" &&
    typeof (extra.oauth as { readonly accessToken?: unknown } | undefined)
      ?.accessToken === "string";
  const hasManagedCredential = extra.managedCredential === true;
  const hasNativeGrokAcp =
    provider === "grok" &&
    (extra.grokAcp !== undefined || isGrokComposerModel(model));
  const hasNativeGemini =
    provider === "gemini" && extra.gemini !== undefined;
  if (
    credentials.kind === "api-key" &&
    credentials.apiKey.required &&
    apiKey === undefined &&
    authToken === undefined &&
    !hasPreparedOAuth &&
    !hasManagedCredential &&
    !hasNativeGrokAcp &&
    !hasNativeGemini
  ) {
    const credentialLabel =
      provider === "anthropic"
        ? "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN"
        : providerCredentialEnvironmentLabel(provider) ?? "API key";
    throw new Error(
      `${credentialLabel} is required for ${BUILT_IN_PROVIDER_DEFINITIONS[provider].name} provider`,
    );
  }
  const transport = transportForProvider(provider, model, extra);
  if (transport !== "native" && baseURL === undefined) {
    throw new Error(`${provider} provider binding has no prepared base URL`);
  }
  return Object.freeze({
    provider,
    transport,
    model,
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(authToken !== undefined ? { authToken } : {}),
    ...(factoryOptions.credentialHome !== undefined
      ? { credentialHome: factoryOptions.credentialHome }
      : {}),
    ...(factoryOptions.timeoutMs !== undefined
      ? { timeoutMs: factoryOptions.timeoutMs }
      : {}),
    extra,
    environment: Object.freeze({ ...(options.environment ?? {}) }),
  });
}
