/**
 * The models an OpenAI ChatGPT sign-in's account lists, and the default Core
 * takes from them.
 *
 * Core reads the list as `agenc openai-models` does (bin/openai-models-cli.ts):
 * GET <CHATGPT_BACKEND_BASE_URL>/models?client_version=1.0.0 with the
 * sign-in's access token and ChatGPT account id. The request is pinned to that
 * endpoint, and a 401 refreshes the sign-in once, as a child's model check
 * does (sign-in-child-models.ts). The whole read, refresh included, has one
 * deadline, and a list read in this process is kept for ten minutes per home
 * and account, so a daemon's sessions do not ask again at every start. Only
 * model ids come back.
 *
 * @module
 */

import type { HomeContext } from "../../../config/home.js";
import type { ProviderEnvironment } from "../../provider-options.js";
import { createPinnedProviderFetch } from "../../credential-redirect-fetch.js";
import { providerAuthPreference } from "../../provider-auth-selection.js";
import { chatGptDefaultModel } from "../../registry/openai-chatgpt-default.js";
import {
  readOpenAiOauthCredentials,
  refreshOpenAiSubscriptionIfNeeded,
} from "../../../utils/openAiOauthCredentials.js";
import {
  CHATGPT_BACKEND_BASE_URL,
  chatGptSubscriptionHeaders,
  resolveStoredChatGptSubscriptionCredentials,
} from "./chatgpt-backend.js";

const LIST_TIMEOUT_MS = 5_000;
const LIST_CACHE_MS = 10 * 60_000;

/** Lists read in this process, by home and ChatGPT account. */
const listCache = new Map<string, { readonly at: number; readonly models: readonly string[] }>();

/** Forget every list this process read (tests, and a sign-in that changed). */
export function clearChatGptAccountModelCache(): void {
  listCache.clear();
}

export interface ChatGptAccountModelsOptions {
  readonly home: HomeContext;
  readonly environment: ProviderEnvironment;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Whether OpenAI requests from this home go through its ChatGPT sign-in, by
 * the rule the provider applies (provider-options.ts): never with the
 * `api-key` auth setting, never when the stored sign-in holds an exchanged
 * platform key (unless auth is `oauth`), and only with a usable access token
 * and account id.
 */
export function openAiUsesChatGptSignIn(
  home: HomeContext,
  environment: ProviderEnvironment,
): boolean {
  const preference = providerAuthPreference("openai", environment);
  if (preference === "api-key") return false;
  const stored = readOpenAiOauthCredentials(home);
  if (stored?.apiKey !== undefined && preference !== "oauth") return false;
  return resolveStoredChatGptSubscriptionCredentials(stored) !== undefined;
}

/** The listed model ids; an entry the backend marks other than `visibility: "list"` is left out. */
function modelIds(payload: unknown): string[] {
  if (payload === null || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const pools = [record.data, record.models].filter(Array.isArray) as unknown[][];
  const ids = pools.flatMap((pool) => pool.flatMap((entry): string[] => {
    if (typeof entry === "string") return [entry];
    if (entry === null || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.visibility === "string" && item.visibility !== "list") return [];
    const id = [item.id, item.slug, item.model].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    return id === undefined ? [] : [id];
  }));
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))];
}

/**
 * The model ids the signed-in ChatGPT account lists, in the backend's order.
 * Undefined when OpenAI does not use a ChatGPT sign-in here, or when the list
 * cannot be read within the deadline (refused, empty, offline, too slow).
 */
export async function readChatGptAccountModels(
  options: ChatGptAccountModelsOptions,
): Promise<readonly string[] | undefined> {
  let subscription;
  try {
    if (!openAiUsesChatGptSignIn(options.home, options.environment)) return undefined;
    subscription = resolveStoredChatGptSubscriptionCredentials(readOpenAiOauthCredentials(options.home));
  } catch {
    return undefined;
  }
  if (subscription === undefined) return undefined;
  const key = `${options.home.path}\u0000${subscription.accountId}`;
  const cached = listCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < LIST_CACHE_MS) return cached.models;
  const timeoutMs = options.timeoutMs ?? LIST_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The refresh after a 401 has no signal of its own: the deadline stops the
  // wait, and a refresh still running finishes on its own.
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref?.();
  });
  try {
    const models = await Promise.race([readListed(options, subscription, signal), expired]);
    if (models !== undefined) listCache.set(key, { at: Date.now(), models });
    return models;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function readListed(
  options: ChatGptAccountModelsOptions,
  first: NonNullable<ReturnType<typeof resolveStoredChatGptSubscriptionCredentials>>,
  signal: AbortSignal,
): Promise<readonly string[] | undefined> {
  let subscription: ReturnType<typeof resolveStoredChatGptSubscriptionCredentials> = first;
  const fetchPinned = createPinnedProviderFetch([CHATGPT_BACKEND_BASE_URL], options.fetchImpl ?? fetch);
  for (let attempt = 0; attempt < 2 && subscription !== undefined; attempt += 1) {
    const response = await fetchPinned(`${CHATGPT_BACKEND_BASE_URL}/models?client_version=1.0.0`, {
      signal,
      headers: {
        Authorization: `Bearer ${subscription.bearerToken}`,
        "User-Agent": "agenc",
        ...chatGptSubscriptionHeaders(subscription.accountId),
      },
    });
    if (response.status === 401 && attempt === 0) {
      const refreshed = await refreshOpenAiSubscriptionIfNeeded(options.home, options.environment, {
        force: true, rejectedAccessToken: subscription.bearerToken,
      });
      subscription = refreshed.refreshed
        ? resolveStoredChatGptSubscriptionCredentials(refreshed.credentials)
        : undefined;
      continue;
    }
    if (!response.ok) return undefined;
    const models = modelIds(await response.json());
    return models.length > 0 ? models : undefined;
  }
  return undefined;
}

/**
 * The OpenAI model to start a ChatGPT sign-in on: GPT-6.2 Astra when its
 * account lists it, otherwise the best model it lists (chatGptDefaultModel).
 * Undefined when OpenAI does not use a ChatGPT sign-in here or its list cannot
 * be read; the caller keeps the provider default then.
 */
export async function chatGptAccountDefaultModel(
  options: ChatGptAccountModelsOptions & { readonly now?: Date },
): Promise<{ readonly model: string; readonly listed: readonly string[] } | undefined> {
  const listed = await readChatGptAccountModels(options);
  if (listed === undefined) return undefined;
  const model = chatGptDefaultModel(listed, options.now);
  return model === undefined ? undefined : { model, listed };
}
