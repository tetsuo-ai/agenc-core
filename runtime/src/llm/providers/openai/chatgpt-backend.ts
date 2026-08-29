import { parseChatgptAccountId } from "../../../services/api/openAiCodeOAuthShared.js";

/** Fixed transport and credential contract for ChatGPT subscription inference. */

// branding-scan: allow factual reference to real provider in endpoint
export const CHATGPT_BACKEND_BASE_URL =
  "https://chatgpt.com/backend-api/codex";

/** Identify AgenC without impersonating a first-party OpenAI client. */
export const CHATGPT_BACKEND_ORIGINATOR = "agenc";

export interface ChatGptSubscriptionCredentialInput {
  /** Deliberately ignored by the subscription backend. */
  readonly apiKey?: string;
  readonly accessToken?: string;
  readonly idToken?: string;
  readonly accountId?: string;
}

export interface ChatGptSubscriptionEnvironment {
  readonly PROVIDER_CODE_API_KEY?: string;
  readonly PROVIDER_CODE_ACCOUNT_ID?: string;
  readonly CHATGPT_ACCOUNT_ID?: string;
}

export interface ResolvedChatGptSubscriptionCredentials {
  readonly bearerToken: string;
  readonly accountId?: string;
  readonly source: "environment" | "native-secure-storage" | "none";
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Resolve a usable native secure storage subscription pair. A platform API key is not
 * accepted here because the ChatGPT backend requires the OAuth access token.
 */
export function resolveStoredChatGptSubscriptionCredentials(
  stored: ChatGptSubscriptionCredentialInput | undefined,
):
  | (ResolvedChatGptSubscriptionCredentials & {
      readonly accountId: string;
      readonly source: "native-secure-storage";
    })
  | undefined {
  const bearerToken = nonEmpty(stored?.accessToken);
  if (bearerToken === undefined) return undefined;
  const accountId =
    nonEmpty(stored?.accountId) ??
    parseChatgptAccountId(stored?.idToken) ??
    parseChatgptAccountId(bearerToken);
  if (accountId === undefined) return undefined;
  return Object.freeze({
    bearerToken,
    accountId,
    source: "native-secure-storage",
  });
}

/**
 * Resolve the one ChatGPT subscription credential order used by every active
 * runtime path: a usable native secure storage sign-in wins, then the explicit
 * ProviderCode environment token, otherwise no credential is available.
 */
export function resolveChatGptSubscriptionCredentials(options: {
  readonly stored?: ChatGptSubscriptionCredentialInput;
  readonly environment: ChatGptSubscriptionEnvironment;
}): ResolvedChatGptSubscriptionCredentials {
  const stored = resolveStoredChatGptSubscriptionCredentials(options.stored);
  if (stored !== undefined) return stored;

  const bearerToken = nonEmpty(options.environment.PROVIDER_CODE_API_KEY);
  if (bearerToken === undefined) {
    return Object.freeze({ bearerToken: "", source: "none" });
  }
  const accountId =
    nonEmpty(options.environment.PROVIDER_CODE_ACCOUNT_ID) ??
    nonEmpty(options.environment.CHATGPT_ACCOUNT_ID) ??
    parseChatgptAccountId(bearerToken);
  return Object.freeze({
    bearerToken,
    ...(accountId === undefined ? {} : { accountId }),
    source: "environment",
  });
}

export function chatGptSubscriptionHeaders(
  accountId: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    "ChatGPT-Account-ID": accountId,
    originator: CHATGPT_BACKEND_ORIGINATOR,
  });
}
