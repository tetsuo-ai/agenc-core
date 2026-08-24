/**
 * Resolve provider construction inputs at an ingress boundary.
 *
 * `createProvider()` deliberately does not read `process.env`. Callers that
 * accept environment configuration resolve it once, against the session's
 * immutable environment snapshot, and pass the resulting options into the
 * factory. Credentials are inputs for an already-selected provider; they
 * never participate in provider selection here.
 */

import {
  assertNoObsoleteConfigEnvironment,
  assertNoObsoleteProviderSelectors,
} from "../config/env.js";
import { assertNoRemovedSimpleModeEnvironment } from "../session/runtime-options.js";
import { canonicalSessionEnvironmentKeys } from "../session/environment.js";
import {
  getGeminiAuthMode,
  getGeminiProjectIdHint,
  resolveGeminiCredential,
} from "../utils/geminiAuth.js";
import { resolveGrokProviderApiKey } from "./xai-capability-config.js";
import { resolveSecureStorageHome } from "../utils/secureStorage/home.js";
import type { ProviderFactoryOptions, ProviderName } from "./provider.js";

export type ProviderEnvironment = Readonly<
  Record<string, string | undefined>
>;

const API_KEY_ENV: Readonly<
  Partial<Record<ProviderName, readonly string[]>>
> = Object.freeze({
  grok: Object.freeze(["XAI_API_KEY", "GROK_API_KEY"]),
  openai: Object.freeze(["OPENAI_API_KEY"]),
  anthropic: Object.freeze(["ANTHROPIC_API_KEY"]),
  lmstudio: Object.freeze(["LMSTUDIO_API_KEY"]),
  "openai-compatible": Object.freeze([
    "OPENAI_COMPATIBLE_API_KEY",
    "OPENAI_API_KEY",
  ]),
  openrouter: Object.freeze(["OPENROUTER_API_KEY"]),
  groq: Object.freeze(["GROQ_API_KEY"]),
  deepseek: Object.freeze(["DEEPSEEK_API_KEY"]),
  gemini: Object.freeze(["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
  mistral: Object.freeze(["MISTRAL_API_KEY"]),
  "nvidia-nim": Object.freeze(["NVIDIA_API_KEY"]),
  minimax: Object.freeze(["MINIMAX_API_KEY"]),
  github: Object.freeze(["GITHUB_TOKEN", "GH_TOKEN"]),
  "amazon-bedrock": Object.freeze([
    "AWS_BEDROCK_ACCESS_KEY_ID",
    "AWS_ACCESS_KEY_ID",
  ]),
  agenc: Object.freeze(["AGENC_API_KEY"]),
});

const BASE_URL_ENV: Readonly<
  Partial<Record<ProviderName, readonly string[]>>
> = Object.freeze({
  grok: Object.freeze(["XAI_BASE_URL", "GROK_BASE_URL"]),
  openai: Object.freeze(["OPENAI_BASE_URL"]),
  anthropic: Object.freeze(["ANTHROPIC_BASE_URL"]),
  ollama: Object.freeze(["OLLAMA_BASE_URL"]),
  lmstudio: Object.freeze(["LMSTUDIO_BASE_URL"]),
  "openai-compatible": Object.freeze([
    "OPENAI_COMPATIBLE_BASE_URL",
    "OPENAI_BASE_URL",
    "OPENAI_API_BASE",
  ]),
  openrouter: Object.freeze(["OPENROUTER_BASE_URL"]),
  groq: Object.freeze(["GROQ_BASE_URL"]),
  deepseek: Object.freeze(["DEEPSEEK_BASE_URL"]),
  gemini: Object.freeze(["GEMINI_BASE_URL"]),
  mistral: Object.freeze(["MISTRAL_BASE_URL"]),
  "nvidia-nim": Object.freeze(["NVIDIA_BASE_URL"]),
  minimax: Object.freeze(["MINIMAX_BASE_URL"]),
  github: Object.freeze(["GITHUB_BASE_URL"]),
  "amazon-bedrock": Object.freeze(["AWS_BEDROCK_BASE_URL"]),
  agenc: Object.freeze(["AGENC_BASE_URL"]),
});

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function firstEnvironmentValue(
  env: ProviderEnvironment,
  names: readonly string[] | undefined,
): string | undefined {
  if (names === undefined) return undefined;
  for (const name of names) {
    const value = nonEmpty(env[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function mergeExtra(
  requested: Readonly<Record<string, unknown>> | undefined,
  resolved: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const merged = { ...resolved, ...(requested ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Copy an environment so later process-global mutation cannot affect a session. */
export function snapshotProviderEnvironment(
  env: ProviderEnvironment,
): ProviderEnvironment {
  assertNoRemovedSimpleModeEnvironment(env);
  assertNoObsoleteConfigEnvironment(env);
  assertNoObsoleteProviderSelectors(env);
  return Object.freeze(
    Object.fromEntries(
      canonicalSessionEnvironmentKeys(env).flatMap(key =>
        env[key] === undefined ? [] : [[key, env[key]]],
      ),
    ),
  );
}

/**
 * Resolve credentials and endpoint metadata for an explicit provider/model.
 * The provider and model are never inferred from credential names or values.
 */
export function resolveProviderFactoryOptions(
  provider: ProviderName,
  requested: ProviderFactoryOptions,
  env: ProviderEnvironment,
): ProviderFactoryOptions {
  const snapshot = snapshotProviderEnvironment(env);
  const home = requested.credentialHome ?? resolveSecureStorageHome();
  const environmentApiKey = firstEnvironmentValue(snapshot, API_KEY_ENV[provider]);
  let apiKey = provider === "grok"
    ? resolveGrokProviderApiKey(
        home,
        requested.apiKey ?? environmentApiKey,
        snapshot,
      )
    : nonEmpty(requested.apiKey) ?? environmentApiKey;
  const baseURL =
    nonEmpty(requested.baseURL) ??
    firstEnvironmentValue(snapshot, BASE_URL_ENV[provider]);

  const resolvedExtra: Record<string, unknown> = {};
  if (provider === "openai") {
    const organization = nonEmpty(snapshot.OPENAI_ORGANIZATION);
    const project = nonEmpty(snapshot.OPENAI_PROJECT);
    if (organization !== undefined) resolvedExtra.organization = organization;
    if (project !== undefined) resolvedExtra.project = project;
  }

  if (provider === "gemini") {
    const authMode = getGeminiAuthMode(snapshot);
    const accessToken = nonEmpty(snapshot.GEMINI_ACCESS_TOKEN);
    const project = getGeminiProjectIdHint(snapshot);
    const location =
      nonEmpty(snapshot.GEMINI_VERTEX_LOCATION) ??
      nonEmpty(snapshot.GOOGLE_CLOUD_LOCATION) ??
      nonEmpty(snapshot.GOOGLE_CLOUD_REGION) ??
      nonEmpty(snapshot.CLOUD_ML_REGION);
    const cachedContent = nonEmpty(snapshot.GEMINI_CACHED_CONTENT);
    if (authMode === "access-token" || authMode === "adc") {
      resolvedExtra.authMode = "oauth";
      apiKey = undefined;
    }
    if (accessToken !== undefined) resolvedExtra.accessToken = accessToken;
    if (project !== undefined) resolvedExtra.project = project;
    if (location !== undefined) resolvedExtra.location = location;
    if (cachedContent !== undefined) resolvedExtra.cachedContent = cachedContent;
    resolvedExtra.resolveCredential = () =>
      resolveGeminiCredential(snapshot);
  }

  if (provider === "amazon-bedrock") {
    const secretAccessKey =
      nonEmpty(snapshot.AWS_BEDROCK_SECRET_ACCESS_KEY) ??
      nonEmpty(snapshot.AWS_SECRET_ACCESS_KEY);
    const sessionToken =
      nonEmpty(snapshot.AWS_BEDROCK_SESSION_TOKEN) ??
      nonEmpty(snapshot.AWS_SESSION_TOKEN);
    const region =
      nonEmpty(snapshot.AWS_BEDROCK_REGION) ??
      nonEmpty(snapshot.AWS_REGION) ??
      nonEmpty(snapshot.AWS_DEFAULT_REGION);
    if (secretAccessKey !== undefined) {
      resolvedExtra.secretAccessKey = secretAccessKey;
    }
    if (sessionToken !== undefined) resolvedExtra.sessionToken = sessionToken;
    if (region !== undefined) resolvedExtra.region = region;
    if (apiKey !== undefined) resolvedExtra.accessKeyId = apiKey;
  }

  const extra = mergeExtra(requested.extra, resolvedExtra);
  return {
    credentialHome: requested.credentialHome ?? home,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(requested.model !== undefined ? { model: requested.model } : {}),
    ...(requested.tools !== undefined ? { tools: [...requested.tools] } : {}),
    ...(requested.timeoutMs !== undefined
      ? { timeoutMs: requested.timeoutMs }
      : {}),
    ...(extra !== undefined ? { extra } : {}),
  };
}
