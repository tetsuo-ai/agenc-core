/**
 * Zero data retention (ZDR) for the provider and model a session uses.
 *
 * Request side: OpenRouter is the one provider with a per-request ZDR control
 * (`provider.zdr`), and AgenC sends it unless the config turns it off.
 *
 * Display side: `resolveZeroDataRetentionStatus` decides what the status
 * line's ZDR badge shows. It says "zdr" only when retention is guaranteed: the
 * request-level control is on, the provider's policy keeps nothing, or the
 * server runs on this computer. It says "retained" when the provider keeps
 * data by default (including providers whose ZDR is an account setting AgenC
 * cannot see), when ZDR is turned off, or when the model has no ZDR endpoint.
 * It says "unknown" when the request goes to an address whose policy AgenC
 * cannot know: a local-class provider pointed at another machine, or a
 * provider that would otherwise be ZDR pointed at a custom address.
 *
 * @module
 */

import { isIP } from "node:net";

import type { EnvSnapshot } from "../config/env.js";
import { resolveProviderSettings } from "../config/resolve-provider.js";
import type { AgenCConfig } from "../config/schema.js";
import { openRouterModelHasZdrEndpoint } from "./registry/openrouter-zdr-endpoints.js";
import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  resolveBuiltInProviderSlug,
  type BuiltInProviderSlug,
} from "./registry/provider-info.js";
import { PROVIDER_RETENTION } from "./registry/provider-retention.js";
import { VENICE_MODELS, type VeniceModel } from "./registry/venice-models.js";

/**
 * OpenRouter requests carry `provider.zdr = true` unless
 * `[providers.openrouter] zero_data_retention = false`.
 */
export function openRouterZeroDataRetentionEnabled(
  config: AgenCConfig | undefined,
): boolean {
  return config?.providers?.openrouter?.zero_data_retention !== false;
}

/** The one-line hint for using a model that has no ZDR endpoint. */
export const OPENROUTER_ZDR_OFF_HINT =
  "To use it, set zero_data_retention = false under [providers.openrouter].";

export type ZeroDataRetentionState = "zdr" | "retained" | "unknown";

export interface ZeroDataRetentionStatus {
  readonly provider: BuiltInProviderSlug;
  readonly state: ZeroDataRetentionState;
  /** One plain sentence: why, and where ZDR lives when it is off. */
  readonly reason: string;
}

interface Endpoint {
  /** No override, or an override to the provider's own host. */
  readonly builtIn: boolean;
  readonly loopback: boolean;
  readonly host?: string;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  } catch {
    return undefined;
  }
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const family = isIP(host);
  if (family === 4) return host.startsWith("127.");
  if (family === 6) return host === "::1" || host === "0:0:0:0:0:0:0:1";
  return false;
}

function resolveEndpoint(
  provider: BuiltInProviderSlug,
  config: AgenCConfig,
  env: EnvSnapshot,
): Endpoint {
  const override = resolveProviderSettings(provider, config, env)?.baseURL;
  const builtIn = BUILT_IN_PROVIDER_DEFINITIONS[provider].baseURL;
  const host = hostOf(override ?? builtIn);
  return {
    builtIn: override === undefined || (host !== undefined && host === hostOf(builtIn)),
    loopback: host !== undefined && isLoopbackHost(host),
    ...(host === undefined ? {} : { host }),
  };
}

function status(
  provider: BuiltInProviderSlug,
  state: ZeroDataRetentionState,
  reason: string,
): ZeroDataRetentionStatus {
  return Object.freeze({ provider, state, reason });
}

function customAddress(host: string | undefined): string {
  return host === undefined ? "a custom address" : host;
}

/**
 * What the status line's ZDR badge shows for this provider and model.
 * Undefined for a provider AgenC does not know.
 */
export function resolveZeroDataRetentionStatus(params: {
  readonly provider: string;
  readonly model: string;
  readonly config?: AgenCConfig;
  readonly env?: EnvSnapshot;
  /** Venice's live list when the TUI has read it; the bundled list otherwise. */
  readonly veniceModels?: readonly VeniceModel[];
}): ZeroDataRetentionStatus | undefined {
  const provider = resolveBuiltInProviderSlug(params.provider);
  if (provider === undefined) return undefined;
  const config = params.config ?? {};
  if (provider === "agenc") return undefined;
  const facts = PROVIDER_RETENTION[provider];
  const endpoint = resolveEndpoint(provider, config, params.env ?? {});
  switch (facts.retention) {
    case "local":
      if (!endpoint.loopback) {
        return status(provider, "unknown", `Requests go to ${customAddress(endpoint.host)}, whose retention AgenC cannot see.`);
      }
      // A generic OpenAI-compatible server on this computer can be a proxy
      // (LiteLLM, a login proxy) that forwards to a cloud API.
      return provider === "openai-compatible"
        ? status(provider, "unknown", "Requests go to a server on this computer, which may forward them to a cloud API whose retention AgenC cannot see.")
        : status(provider, "zdr", "Runs on this computer, so nothing leaves it.");
    case "request-zdr": {
      if (!openRouterZeroDataRetentionEnabled(config)) {
        return status(provider, "retained", "Zero data retention is off under [providers.openrouter], so endpoints may keep data.");
      }
      if (!endpoint.builtIn) {
        return status(provider, "unknown", `Requests ask for zero retention but go to ${customAddress(endpoint.host)}.`);
      }
      if (openRouterModelHasZdrEndpoint(params.model) === false) {
        return status(provider, "retained", `OpenRouter has no zero-retention endpoint for this model and refuses it. ${OPENROUTER_ZDR_OFF_HINT}`);
      }
      return status(provider, "zdr", "Every request carries provider.zdr, so OpenRouter uses only endpoints that keep nothing. OpenRouter itself keeps prompts only if your account turned on prompt logging.");
    }
    case "no-retention":
      return !endpoint.builtIn
        ? status(provider, "unknown", `Requests go to ${customAddress(endpoint.host)} instead of the provider's own address.`)
        : status(provider, "zdr", facts.summary);
    case "per-model": {
      if (!endpoint.builtIn) {
        return status(provider, "unknown", `Requests go to ${customAddress(endpoint.host)} instead of the provider's own address.`);
      }
      const model = (params.veniceModels ?? VENICE_MODELS).find(entry => entry.model === params.model.trim());
      if (model?.zeroDataRetention === true) {
        return status(provider, "zdr", "This is a private Venice model, which keeps nothing.");
      }
      return model === undefined
        ? status(provider, "unknown", "Venice does not list this model, so its retention is unknown.")
        : status(provider, "retained", "This anonymized model runs on a third-party host that may keep data.");
    }
    case "account-level":
    case "retains":
      return status(provider, "retained", facts.summary);
  }
}
