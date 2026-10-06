/**
 * Provider API keys saved on this computer (native secure storage), keyed the
 * same way the provider runtime reads them back (`readLocalByokCredential`).
 * The `/providers` screen saves and removes keys here; first-run setup saves
 * through `LocalAuthBackend.saveByokKey`, which writes the same record.
 *
 * @module
 */

import type { HomeContext } from "../config/home.js";
import { normalizeProviderIdentity } from "../provider-identity.js";
import {
  clearLocalByokCredential,
  readLocalByokCredential,
  storeLocalByokCredential,
} from "./native-credentials.js";

function keyOwner(provider: string): string {
  const normalized = normalizeProviderIdentity(provider, "local provider credential");
  if (normalized === undefined) {
    throw new Error("provider is required to save an API key");
  }
  return normalized;
}

/** A pasted key: one token with no spaces inside. */
export function normalizeApiKeyInput(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) throw new Error("Paste a key first.");
  if (/\s/.test(trimmed)) throw new Error("A key has no spaces. Paste it again.");
  return trimmed;
}

export function saveProviderKey(
  home: HomeContext,
  provider: string,
  apiKey: string,
  now: () => Date = () => new Date(),
): void {
  const owner = keyOwner(provider);
  storeLocalByokCredential(home, owner, {
    provider: owner,
    apiKey: normalizeApiKeyInput(apiKey),
    savedAt: now().toISOString(),
  });
}

/** Remove a saved key. Returns whether one was saved. */
export function removeProviderKey(home: HomeContext, provider: string): boolean {
  return clearLocalByokCredential(home, keyOwner(provider));
}

export function hasSavedProviderKey(home: HomeContext, provider: string): boolean {
  const apiKey = readLocalByokCredential(home, keyOwner(provider))?.apiKey;
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}
