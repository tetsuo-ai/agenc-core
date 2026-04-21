/**
 * Provider factory — single entrypoint for provider construction.
 *
 * Per `docs/plan/TODO.MD` Tranche 5 §D, AgenC ships with one concrete
 * provider (Grok) and a scaffold for the 8 others that land in T13:
 * OpenAI, Anthropic, Ollama, LMStudio, OpenRouter, Groq (distinct from
 * xAI Grok), DeepSeek, Gemini. This module is the routing boundary —
 * callers ask for a provider by name and receive an `LLMProvider`.
 *
 * Invariant I-13 (mid-stream provider/model switch) funnels through
 * this factory so the Session's `pendingProviderSwitch` can be
 * materialised into a new live provider at the next turn boundary
 * without the phase code knowing which provider it's talking to.
 *
 * Adding a new provider in T13:
 *   1. Add its name to `ProviderName`.
 *   2. Add a case in `createProvider` that constructs the adapter.
 *   3. Optionally register capability metadata (T13 capability registry).
 *
 * @module
 */

import { resolveApiKey } from "../config/env.js";
import { GrokProvider } from "./grok/index.js";
import type { GrokProviderConfig } from "./grok/index.js";
import type { LLMProvider, LLMTool } from "./types.js";
import { OpenAIProvider } from "./providers/openai/index.js";
import type { OpenAIProviderConfig } from "./providers/openai/index.js";
import { AnthropicProvider } from "./providers/anthropic/index.js";
import type { AnthropicProviderConfig } from "./providers/anthropic/index.js";

/**
 * Canonical provider name set. Additions land in T13; Grok is the
 * only live adapter shipped in T5.
 */
export type ProviderName =
  | "grok"
  | "openai"
  | "anthropic"
  | "ollama"
  | "lmstudio"
  | "openrouter"
  | "groq"
  | "deepseek"
  | "gemini";

/**
 * Shared construction options. Each provider gets the subset it
 * cares about; unknown fields are ignored. Per-provider adapters
 * may expose richer configs (see `GrokProviderConfig`); use the
 * typed form when you need provider-specific knobs.
 */
export interface ProviderFactoryOptions {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly model?: string;
  readonly tools?: ReadonlyArray<LLMTool>;
  readonly timeoutMs?: number;
  /** Optional per-provider extra config (escape hatch). */
  readonly extra?: Record<string, unknown>;
}

export const FACTORY_PROVIDER_MARKER = Symbol.for("agenc.factoryProvider");

type FactoryMarkedProvider = LLMProvider & {
  [FACTORY_PROVIDER_MARKER]?: true;
};

export function isFactoryProvider(provider: LLMProvider): boolean {
  return (provider as FactoryMarkedProvider)[FACTORY_PROVIDER_MARKER] === true;
}

function markFactoryProvider<T extends LLMProvider>(provider: T): T {
  Object.defineProperty(provider, FACTORY_PROVIDER_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return provider;
}

/**
 * Error thrown when a provider name is recognised but the adapter
 * for it hasn't landed yet. T13 replaces each throw with a real
 * constructor call.
 */
export class ProviderNotImplementedError extends Error {
  constructor(public readonly provider: ProviderName) {
    super(
      `provider "${provider}" is not implemented yet — adapter lands in T13 (docs/plan/TODO.MD §Tranche 13)`,
    );
    this.name = "ProviderNotImplementedError";
  }
}

/**
 * Factory: route to the right adapter for a provider name.
 *
 * Codex analogue: `client.rs::get_client()` dispatches on the
 * `ModelProviderInfo` kind. AgenC keeps the switch explicit because
 * the adapter set is small and the capability metadata lives in a
 * separate T13 registry.
 *
 * @throws ProviderNotImplementedError for openai/anthropic/ollama/etc
 *         until T13 lands the adapter.
 */
export function createProvider(
  name: ProviderName,
  opts: ProviderFactoryOptions,
): LLMProvider {
  switch (name) {
    case "grok": {
      const apiKey = opts.apiKey ?? resolveApiKey(process.env);
      if (!apiKey) {
        throw new Error(
          "grok provider requires apiKey — set XAI_API_KEY in the environment",
        );
      }
      if (!opts.model) {
        throw new Error(
          "grok provider requires model — set AGENC_MODEL or pass in factory options",
        );
      }
      const cfg: GrokProviderConfig = {
        apiKey,
        model: opts.model,
        tools: opts.tools ? [...opts.tools] : undefined,
        ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      };
      return markFactoryProvider(new GrokProvider(cfg));
    }
    case "openai": {
      const cfg: OpenAIProviderConfig = {
        apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY,
        model: opts.model ?? process.env.OPENAI_MODEL ?? "",
        tools: opts.tools ? [...opts.tools] : undefined,
        baseURL: opts.baseURL ?? process.env.OPENAI_BASE_URL,
        ...(process.env.OPENAI_ORGANIZATION
          ? { organization: process.env.OPENAI_ORGANIZATION }
          : {}),
        ...(process.env.OPENAI_PROJECT
          ? { project: process.env.OPENAI_PROJECT }
          : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      };
      if (!cfg.model) {
        throw new Error(
          "openai provider requires model — set OPENAI_MODEL or pass model in factory options",
        );
      }
      return markFactoryProvider(new OpenAIProvider(cfg));
    }
    case "anthropic": {
      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          "anthropic provider requires apiKey — set ANTHROPIC_API_KEY or pass apiKey in the provider config",
        );
      }
      if (!opts.model) {
        throw new Error(
          "anthropic provider requires model — set ANTHROPIC_MODEL or pass model in factory options",
        );
      }
      const cfg: AnthropicProviderConfig = {
        apiKey,
        model: opts.model,
        tools: opts.tools ? [...opts.tools] : undefined,
        ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      };
      return markFactoryProvider(new AnthropicProvider(cfg));
    }
    case "ollama":
    case "lmstudio":
    case "openrouter":
    case "groq":
    case "deepseek":
    case "gemini":
      throw new ProviderNotImplementedError(name);
    default: {
      // Exhaustive check: TypeScript enforces this, but a runtime
      // guard catches string-typed callers that bypass the compiler.
      const _exhaustive: never = name;
      void _exhaustive;
      throw new Error(`unknown provider: ${String(name)}`);
    }
  }
}

/**
 * Resolve provider name from the AGENC_PROVIDER env var (default
 * "grok"). Exported so `bin/agenc.ts` + T11 slash-commands + T13
 * provider-registry can share the same default.
 */
export function resolveProviderNameFromEnv(): ProviderName {
  const raw = (process.env.AGENC_PROVIDER ?? "grok").toLowerCase().trim();
  const known: ReadonlyArray<ProviderName> = [
    "grok",
    "openai",
    "anthropic",
    "ollama",
    "lmstudio",
    "openrouter",
    "groq",
    "deepseek",
    "gemini",
  ];
  if ((known as readonly string[]).includes(raw)) return raw as ProviderName;
  throw new Error(
    `AGENC_PROVIDER="${raw}" is not a known provider (accepted: ${known.join(", ")})`,
  );
}
