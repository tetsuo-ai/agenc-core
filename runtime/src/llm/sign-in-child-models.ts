/** Check a child's model against the models served by its selected sign-in. */
import type { ProviderFactoryOptions } from "./provider.js";
import type { ProviderEnvironment } from "./provider-options.js";
import { createPinnedProviderFetch } from "./credential-redirect-fetch.js";
import { CHATGPT_BACKEND_BASE_URL, chatGptSubscriptionHeaders } from "./providers/openai/chatgpt-backend.js";
import { LLMAuthenticationError, LLMFundsError, LLMProviderError } from "./errors.js";
import { isProviderFundsFailure } from "./funds.js";
import { refreshOpenAiSubscriptionIfNeeded } from "../utils/openAiOauthCredentials.js";
import { forceRefreshXaiOauthCredentials } from "../utils/xaiOauthCredentials.js";

export interface SignInChildModelCapabilities {
  readonly supportsToolUse?: boolean;
}

function modelEntries(payload: unknown): ReadonlyMap<string, SignInChildModelCapabilities> {
  if (payload === null || typeof payload !== "object") return new Map();
  const value = payload as Record<string, unknown>;
  const pools = [value.data, value.models].filter(Array.isArray) as unknown[][];
  return new Map(pools.flatMap((pool) => pool.flatMap((item): Array<[string, SignInChildModelCapabilities]> => {
    if (typeof item === "string") return [[item, {}]];
    if (item === null || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    const id = [entry.id, entry.slug, entry.model].find((candidate) =>
      typeof candidate === "string" && candidate.length > 0);
    if (typeof id !== "string") return [];
    const capabilities = entry.capabilities !== null && typeof entry.capabilities === "object"
      ? entry.capabilities as Record<string, unknown> : {};
    const tools = [entry.supports_tool_use, entry.supportsToolUse,
      entry.supports_function_calling, capabilities.tool_use, capabilities.tools]
      .find((candidate) => typeof candidate === "boolean");
    return [[id, typeof tools === "boolean" ? { supportsToolUse: tools } : {}]];
  })));
}

export async function assertSignInChildModelEligible(args: {
  readonly provider: string;
  readonly model: string;
  readonly options: ProviderFactoryOptions;
  readonly environment: ProviderEnvironment;
  readonly fetchImpl: typeof fetch;
}): Promise<SignInChildModelCapabilities> {
  const { provider, model, options } = args;
  const home = options.credentialHome;
  if (home === undefined) throw new LLMAuthenticationError(provider, 401, "sign-in is required for this child");
  const chatgpt = provider === "openai";
  const baseURL = chatgpt ? CHATGPT_BACKEND_BASE_URL : "https://api.x.ai/v1";
  const fetchPinned = createPinnedProviderFetch([baseURL], args.fetchImpl);
  const oauth = options.extra?.oauth as { accessToken?: string } | undefined;
  let bearer = chatgpt ? oauth?.accessToken : options.apiKey;
  let accountId = chatgpt ? (options.extra?.defaultHeaders as Record<string, string> | undefined)?.["ChatGPT-Account-ID"] : undefined;
  if (!bearer || (chatgpt && !accountId)) {
    throw new LLMAuthenticationError(provider, 401, "sign-in is required for this child");
  }
  const url = chatgpt ? `${baseURL}/models?client_version=1.0.0` : `${baseURL}/models`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchPinned(url, { headers: {
      Authorization: `Bearer ${bearer}`,
      ...(chatgpt ? { "User-Agent": "agenc", ...chatGptSubscriptionHeaders(accountId!) } : {}),
    } });
    if (response.status === 401 && attempt === 0) {
      try {
        if (chatgpt) {
          const refreshed = await refreshOpenAiSubscriptionIfNeeded(home, args.environment,
            { force: true, rejectedAccessToken: bearer });
          bearer = refreshed.refreshed ? refreshed.credentials?.accessToken : undefined;
          accountId = refreshed.credentials?.accountId;
        } else {
          bearer = (await forceRefreshXaiOauthCredentials(home, bearer))?.accessToken;
        }
      } catch {
        throw new LLMAuthenticationError(provider, 401, "sign-in refresh failed for this child");
      }
      if (!bearer || (chatgpt && !accountId)) {
        throw new LLMAuthenticationError(provider, 401, "sign-in refresh failed for this child");
      }
      continue;
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (isProviderFundsFailure(provider, { status: response.status, body })) {
        const error = new LLMFundsError(provider, response.status);
        Object.assign(error, { headers: response.headers });
        throw error;
      }
      if (response.status === 401 || response.status === 403) {
        throw new LLMAuthenticationError(provider, response.status, "sign-in is required for this child");
      }
      throw new LLMProviderError(provider, "sign-in model list is unavailable", response.status);
    }
    const listed = modelEntries(await response.json());
    const capabilities = listed.get(model);
    if (capabilities === undefined) {
      throw new Error(`Model ${provider}/${model} is not served by this sign-in`);
    }
    return capabilities;
  }
  throw new LLMAuthenticationError(provider, 401, "sign-in is required for this child");
}
