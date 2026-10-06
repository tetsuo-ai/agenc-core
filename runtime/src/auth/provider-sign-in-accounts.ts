/**
 * Which providers take an account sign-in, and the stored account's label.
 * Kept apart from `commands/provider-sign-in.ts` so first-run setup can show
 * "signed in as …" without loading the sign-in flows themselves.
 *
 * @module
 */

import type { HomeContext } from "../config/home.js";
import { readOpenAiOauthCredentials } from "../utils/openAiOauthCredentials.js";
import { readXaiOauthCredentials } from "../utils/xaiOauthCredentials.js";

export type SignInProvider = "openai" | "grok";

export function isSignInProvider(provider: string): provider is SignInProvider {
  return provider === "openai" || provider === "grok";
}

/** The signed-in account's label, or null when there is no sign-in. */
export function signedInAccount(home: HomeContext, provider: SignInProvider): string | null {
  const credential = provider === "openai"
    ? readOpenAiOauthCredentials(home)
    : readXaiOauthCredentials(home);
  if (credential === undefined) return null;
  return credential.accountLabel ?? (provider === "openai" ? "ChatGPT account" : "xAI account");
}
