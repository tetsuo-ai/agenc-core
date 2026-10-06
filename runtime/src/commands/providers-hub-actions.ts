/**
 * What the `/providers` screen does: check and save a pasted key, switch to a
 * provider and model and keep them as the default, and remove a saved key.
 * Switching goes through the same checks as `/provider <name> <model>`.
 *
 * @module
 */

import { removeProviderKey, saveProviderKey } from "../auth/provider-keys.js";
import { AgenCConfigEditsBuilder } from "../config/edit.js";
import type { ProviderSlug } from "../config/provider-model-authority.js";
import { resolveBuiltInProviderInfo } from "../llm/registry/provider-info.js";
import { verifyApiKey } from "../onboarding/useApiKeyVerification.js";
import {
  providerEnvironmentFromCommandContext,
  readCommandConfig,
  requireCommandConfigStore,
} from "./config-context.js";
import { switchProviderModel } from "./provider.js";
import type { SlashCommandContext } from "./types.js";

export type ProvidersHubActionResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };

/** Check a pasted key against the provider, then save it on this computer. */
export async function connectProviderWithKey(
  ctx: SlashCommandContext,
  provider: ProviderSlug,
  apiKey: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<ProvidersHubActionResult> {
  const key = apiKey.trim();
  if (key.length === 0) return { ok: false, message: "Paste a key first." };
  if (/\s/.test(key)) return { ok: false, message: "A key has no spaces. Paste it again." };
  const configStore = requireCommandConfigStore(ctx);
  const verification = await verifyApiKey({
    provider,
    apiKey: key,
    config: readCommandConfig(ctx) ?? configStore.current(),
    env: providerEnvironmentFromCommandContext(ctx),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  if (verification.status !== "valid") {
    return {
      ok: false,
      message: verification.error?.trim() || "The provider did not accept this key.",
    };
  }
  saveProviderKey(configStore.homeContext, provider, key);
  return { ok: true, message: "Key checked and saved." };
}

/**
 * Switch to a provider and model, then keep them as the default for new
 * sessions. Saving runs only after the switch is accepted, so a refused
 * switch never changes the default.
 */
export async function chooseProviderModel(
  ctx: SlashCommandContext,
  provider: ProviderSlug,
  model: string,
): Promise<ProvidersHubActionResult> {
  const outcome = await switchProviderModel(ctx, provider, model);
  if (!outcome.applied && !outcome.unchanged) {
    return { ok: false, message: outcome.message };
  }
  const name = resolveBuiltInProviderInfo(outcome.provider)?.name ?? outcome.provider;
  try {
    // The config store's own home: the one its reload reads and the key
    // store writes, never a default resolved from the process.
    await new AgenCConfigEditsBuilder(requireCommandConfigStore(ctx).homeContext.path)
      .setModelSelection(outcome.provider, outcome.model)
      .apply();
    await requireCommandConfigStore(ctx).reload();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: true,
      message: `Using ${name} · ${outcome.model}. Could not save it as the default: ${reason}`,
    };
  }
  return {
    ok: true,
    message: `Using ${name} · ${outcome.model}, saved as the default.`,
  };
}

/** Remove a key saved on this computer. Environment keys stay untouched. */
export function forgetProviderKey(
  ctx: SlashCommandContext,
  provider: ProviderSlug,
): ProvidersHubActionResult {
  const removed = removeProviderKey(requireCommandConfigStore(ctx).homeContext, provider);
  return removed
    ? { ok: true, message: "Saved key removed. The current session keeps it until you switch." }
    : { ok: false, message: "No saved key for this provider." };
}
