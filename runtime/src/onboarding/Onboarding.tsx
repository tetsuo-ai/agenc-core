import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  resolveProviderSelection,
  resolveProviderSettings,
} from "../config/resolve-provider.js";
import type { AgenCConfig } from "../config/schema.js";
import { resolveAuthManagedKeysEnabled } from "../auth/selection.js";
import {
  hasEntitledRemoteAuthSessionSync,
  hasRemoteAuthSessionSync,
  remoteAuthSessionSubscriptionTierSync,
} from "../auth/session-state.js";
import {
  BUILT_IN_PROVIDER_API_KEY_ENVS,
  BUILT_IN_PROVIDER_BASE_URLS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  listBuiltInProviderInfo,
  normalizeBuiltInProviderSlug,
  type BuiltInProviderSlug,
} from "../llm/registry/provider-info.js";
import { LocalAuthBackend } from "../auth/backends/local.js";
import { ApproveApiKey, maskedApiKeyTail } from "./ApproveApiKey.js";
import {
  maybeTruncateInput,
  type PastedContent,
} from "./inputPaste.js";
import {
  cleanupOldPastes,
  deletePastedText,
  hashPastedText,
  storePastedText,
} from "./pasteStore.js";
import {
  incrementFirstRunOnboardingSeenCount,
  markFirstRunOnboardingComplete,
  shouldShowFirstRunOnboarding,
  type OnboardingEnv,
} from "./projectOnboardingState.js";
import { OnboardingBox as Box, OnboardingText as Text } from "./elements.js";
import { WelcomeV2 } from "./WelcomeV2.js";
import {
  verifyApiKey,
  type VerificationStatus,
} from "./useApiKeyVerification.js";
import { subscriptionManagedDefaultModel } from "../commands/subscription-managed-models.js";

export type FirstRunOnboardingStepId =
  | "preflight"
  | "theme"
  | "provider"
  | "connection-test"
  | "api-key"
  | "security"
  | "terminal-setup";

export type ProviderConnectionStatus =
  | "ready"
  | "needs-key"
  | "auth-failed"
  | "provider-unreachable"
  | "local-unchecked"
  | "local-down";

export interface FirstRunOnboardingStep {
  readonly id: FirstRunOnboardingStepId;
  readonly title: string;
  readonly isComplete: boolean;
}

export interface ProviderConnectionCheck {
  readonly provider: string;
  readonly model: string;
  readonly status: ProviderConnectionStatus;
  readonly ok: boolean;
  readonly detail: string;
  readonly keyEnvVar?: string;
  readonly baseURL?: string;
  readonly canSkip?: boolean;
}

export interface PendingApiKeyApproval {
  readonly provider: BuiltInProviderSlug;
  readonly apiKey: string;
  readonly maskedTail: string;
  readonly pasteHash?: string;
  readonly pasteContent?: string;
  readonly pastePreview?: string;
  readonly verificationStatus: VerificationStatus;
  readonly verificationError?: string;
}

export interface FirstRunOnboardingState {
  readonly currentStepId: FirstRunOnboardingStepId;
  readonly completedStepIds: readonly FirstRunOnboardingStepId[];
  readonly selectedTheme: string;
  readonly selectedProvider: BuiltInProviderSlug;
  readonly selectedModel: string;
  readonly connection: ProviderConnectionCheck | null;
  readonly pastedContents: readonly PastedContent[];
  readonly pendingApiKeyApproval: PendingApiKeyApproval | null;
  readonly error: string | null;
  readonly isCheckingConnection: boolean;
  /** Local runtimes found listening (O-1): annotated in the provider step. */
  readonly detectedLocalProviders: readonly BuiltInProviderSlug[];
}

export interface FirstRunByokAuthBackend {
  saveByokKey(params: {
    readonly provider: string;
    readonly apiKey: string;
  }): unknown | Promise<unknown>;
}

export interface FirstRunOnboardingContext {
  readonly agencHome?: string;
  readonly authBackend?: FirstRunByokAuthBackend;
  readonly config: AgenCConfig;
  readonly cwd?: string;
  readonly env?: OnboardingEnv;
  readonly permissionMode?: string;
  readonly sandboxMode?: string;
  readonly terminalName?: string;
  readonly fetchImpl?: typeof fetch;
  readonly checkLocalProviders?: boolean;
}

export interface FirstRunOnboardingSubmitResult {
  readonly state: FirstRunOnboardingState;
  readonly completed: boolean;
}

export interface UseFirstRunOnboardingOptions extends FirstRunOnboardingContext {
  readonly disabled?: boolean;
  readonly hasInitialPrompt?: boolean;
  readonly isInteractive?: boolean;
  readonly onComplete?: (state: FirstRunOnboardingState) => void | Promise<void>;
}

export interface UseFirstRunOnboardingResult {
  readonly active: boolean;
  readonly state: FirstRunOnboardingState;
  readonly steps: readonly FirstRunOnboardingStep[];
  readonly currentStep: FirstRunOnboardingStep;
  submit(input: string): Promise<boolean>;
}

const FIRST_RUN_STEP_ORDER: readonly FirstRunOnboardingStepId[] = Object.freeze([
  "preflight",
  "theme",
  "provider",
  "api-key",
  "connection-test",
  "security",
  "terminal-setup",
]);

const STEP_TITLES: Readonly<Record<FirstRunOnboardingStepId, string>> =
  Object.freeze({
    preflight: "Preflight",
    theme: "Theme",
    provider: "Provider",
    "connection-test": "Connection check",
    "api-key": "API key",
    security: "Security",
    "terminal-setup": "Terminal setup",
  });

const THEME_CHOICES = Object.freeze(["dark", "light", "system"] as const);
const LOCAL_PROVIDERS = new Set<BuiltInProviderSlug>([
  "ollama",
  "lmstudio",
  "openai-compatible",
]);
const KEY_REQUIRED_PROVIDERS = new Set<BuiltInProviderSlug>([
  "grok",
  "openai",
  "anthropic",
  "openrouter",
  "groq",
  "deepseek",
  "gemini",
]);
const MANAGED_KEY_PROVIDERS = new Set<BuiltInProviderSlug>([
  "openrouter",
]);

function buildFirstRunOnboardingSteps(
  state: FirstRunOnboardingState,
): readonly FirstRunOnboardingStep[] {
  const completed = new Set(state.completedStepIds);
  return FIRST_RUN_STEP_ORDER.map((id) => ({
    id,
    title: STEP_TITLES[id],
    isComplete: completed.has(id),
  }));
}

function providerDefaultModel(
  provider: BuiltInProviderSlug,
  config: AgenCConfig,
  env: OnboardingEnv | undefined,
): string {
  if (
    MANAGED_KEY_PROVIDERS.has(provider) &&
    resolveAuthManagedKeysEnabled(config) &&
    hasEntitledRemoteAuthSessionSync(env)
  ) {
    return (
      subscriptionManagedDefaultModel(provider) ??
      BUILT_IN_PROVIDER_DEFAULT_MODELS[provider]
    );
  }
  const settings = resolveProviderSettings(provider, config, env);
  return settings?.defaultModel ?? BUILT_IN_PROVIDER_DEFAULT_MODELS[provider];
}

function initialProvider(
  config: AgenCConfig,
  env: OnboardingEnv | undefined,
): BuiltInProviderSlug {
  const envOrShortcut = resolveProviderSelection({
    config: { ...config, model_provider: undefined },
    env,
  });
  if (envOrShortcut !== undefined) return envOrShortcut;
  const configured = normalizeBuiltInProviderSlug(config.model_provider);
  if (resolveAuthManagedKeysEnabled(config) && hasEntitledRemoteAuthSessionSync(env)) {
    return configured === undefined || configured === "grok"
      ? "openrouter"
      : configured;
  }
  return configured ?? "grok";
}

export function createInitialFirstRunOnboardingState(
  context: Pick<FirstRunOnboardingContext, "config" | "env">,
): FirstRunOnboardingState {
  const provider = initialProvider(context.config, context.env);
  const configuredProvider =
    normalizeBuiltInProviderSlug(context.config.model_provider) ?? provider;
  const model =
    configuredProvider === provider && context.config.model !== undefined
      ? context.config.model
      : providerDefaultModel(provider, context.config, context.env);
  return {
    currentStepId: "preflight",
    completedStepIds: [],
    selectedTheme: context.config.outputStyle?.theme?.trim() || "dark",
    selectedProvider: provider,
    selectedModel: model,
    connection: null,
    pastedContents: [],
    pendingApiKeyApproval: null,
    error: null,
    isCheckingConnection: false,
    detectedLocalProviders: [],
  };
}


/**
 * Probe the well-known local runtimes (O-1, onboarding-plan-2026-07): a user
 * with Ollama or LM Studio already running has a ZERO-KEY path to a working
 * agent — the provider step must say so instead of walling them at the
 * api-key step. Short-timeout, parallel, never throws.
 */
export async function detectRunningLocalProviders(
  context: Pick<FirstRunOnboardingContext, "config" | "env" | "fetchImpl" | "checkLocalProviders">,
): Promise<readonly BuiltInProviderSlug[]> {
  if (context.checkLocalProviders === false) return [];
  const candidates: readonly BuiltInProviderSlug[] = ["ollama", "lmstudio"];
  const results = await Promise.all(
    candidates.map(async (provider) => {
      const settings = resolveProviderSettings(provider, context.config, context.env);
      const baseURL = settings?.baseURL ?? BUILT_IN_PROVIDER_BASE_URLS[provider];
      const reachable = await probeLocalProvider({
        provider,
        baseURL,
        ...(context.fetchImpl !== undefined ? { fetchImpl: context.fetchImpl } : {}),
        timeoutMs: 600,
      }).catch(() => false);
      return reachable ? provider : null;
    }),
  );
  return results.filter((p): p is BuiltInProviderSlug => p !== null);
}

function providerChoices(
  context?: Pick<FirstRunOnboardingContext, "config" | "env">,
): readonly BuiltInProviderSlug[] {
  const proHostedReady =
    context !== undefined &&
    resolveAuthManagedKeysEnabled(context.config) &&
    hasEntitledRemoteAuthSessionSync(context.env);
  const preferredOrder: readonly BuiltInProviderSlug[] = Object.freeze(
    proHostedReady
      ? [
          "openrouter",
          "grok",
          "openai",
          "anthropic",
          "ollama",
          "lmstudio",
          "openai-compatible",
          "groq",
          "deepseek",
          "gemini",
          "agenc",
        ]
      : [
          "grok",
          "openai",
          "anthropic",
          "ollama",
          "lmstudio",
          "openai-compatible",
          "openrouter",
          "groq",
          "deepseek",
          "gemini",
          "agenc",
        ],
  );
  const available = new Set(listBuiltInProviderInfo().map((info) => info.id));
  return preferredOrder.filter((provider) => available.has(provider));
}

function withCompletedStep(
  state: FirstRunOnboardingState,
  id: FirstRunOnboardingStepId,
  next: FirstRunOnboardingStepId | null,
): FirstRunOnboardingState {
  const completed = new Set(state.completedStepIds);
  completed.add(id);
  return {
    ...state,
    completedStepIds: [...completed],
    ...(next !== null ? { currentStepId: next } : {}),
    error: null,
  };
}

function withCompletedSteps(
  state: FirstRunOnboardingState,
  ids: readonly FirstRunOnboardingStepId[],
  next: FirstRunOnboardingStepId | null,
): FirstRunOnboardingState {
  const completed = new Set(state.completedStepIds);
  for (const id of ids) completed.add(id);
  return {
    ...state,
    completedStepIds: [...completed],
    ...(next !== null ? { currentStepId: next } : {}),
    error: null,
  };
}

function parseTheme(raw: string, current: string): string | null {
  const input = raw.trim().toLowerCase();
  if (input === "" || input === "next") return current;
  const index = Number(input);
  if (
    Number.isInteger(index) &&
    index >= 1 &&
    index <= THEME_CHOICES.length
  ) {
    return THEME_CHOICES[index - 1] ?? current;
  }
  return THEME_CHOICES.find((theme) => theme === input) ?? null;
}

function parseProvider(
  raw: string,
  current: BuiltInProviderSlug,
  context: Pick<FirstRunOnboardingContext, "config" | "env">,
): BuiltInProviderSlug | null {
  const input = raw.trim().toLowerCase();
  if (input === "" || input === "next") return current;
  const choices = providerChoices(context);
  const index = Number(input);
  if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
    return choices[index - 1] ?? current;
  }
  const bySlug = normalizeBuiltInProviderSlug(input);
  if (bySlug !== undefined) return bySlug;
  const byName = listBuiltInProviderInfo().find(
    (info) => info.name.toLowerCase() === input,
  );
  return byName?.id ?? null;
}

function invalidCommandError(raw: string, expected: string): string | null {
  return raw.trim().toLowerCase() === expected
    ? null
    : `Type ${expected} to continue.`;
}

function normalizeApiKeyEntry(raw: string): string {
  const trimmed = raw.trim();
  const assignment = trimmed.match(/^[A-Z0-9_]+_API_KEY\s*=\s*(.+)$/u);
  const candidate = assignment?.[1] ?? trimmed;
  return stripMatchingQuotes(candidate.trim());
}

function stripMatchingQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function lowerCommand(raw: string): string {
  return raw.trim().toLowerCase();
}

function isSkipApiKeyCommand(command: string): boolean {
  return command === "" || command === "next" || command === "skip";
}

function apiKeySkipError(
  connection: ProviderConnectionCheck | null,
): string | null {
  if (connection?.canSkip !== false) return null;
  return (
    `${connection.keyEnvVar ?? "A provider API key"} is required before continuing ` +
    `with ${connection.provider}. Paste a BYOK key or choose another provider.`
  );
}

function normalizeOnboardingCommand(raw: string): string {
  const input = raw.trim().toLowerCase();
  if (input === "/next") return "next";
  if (input === "/skip") return "skip";
  if (input === "/done") return "done";
  if (input === "/test") return "test";
  return raw;
}

function approvalAnswer(command: string): "yes" | "no" | null {
  if (command === "y" || command === "yes") return "yes";
  if (command === "n" || command === "no" || command === "skip") return "no";
  return null;
}

function onboardingSlashCommandError(raw: string): string | null {
  const input = raw.trim();
  if (input.startsWith("$") && input.length > 1) {
    return "Onboarding is active. Finish setup before loading $skills, or use /exit, Ctrl-C twice, or Ctrl-D twice to leave.";
  }
  if (!input.startsWith("/") || input.length <= 1) return null;
  return "Onboarding is active. Type next or skip to continue setup, or use /exit, Ctrl-C twice, or Ctrl-D twice to leave.";
}

function apiKeyVerificationErrorMessage(error: string | undefined): string {
  const base = error?.trim() || "API key verification failed.";
  return `${base} Type next or skip to continue without saving, or paste a replacement key.`;
}

function verifiedApiKeyConnection(
  provider: BuiltInProviderSlug,
  model: string,
): ProviderConnectionCheck {
  return {
    provider,
    model,
    status: "ready",
    ok: true,
    detail: "Provider API key verified.",
    keyEnvVar: BUILT_IN_PROVIDER_API_KEY_ENVS[provider],
  };
}

function captureApiKeyPaste(
  state: FirstRunOnboardingState,
  raw: string,
): {
  readonly pasteHash?: string;
  readonly pasteContent?: string;
  readonly pastePreview?: string;
  readonly pastedContents: readonly PastedContent[];
} {
  const pasteResult = maybeTruncateInput(raw, state.pastedContents);
  const latest =
    pasteResult.pastedContents.length > state.pastedContents.length
      ? pasteResult.pastedContents[pasteResult.pastedContents.length - 1]
      : undefined;
  if (latest === undefined) {
    return { pastedContents: pasteResult.pastedContents };
  }
  const pastePreview = pasteResult.input.match(
    /\[Pasted content #[^\]]+\]/u,
  )?.[0];
  const hash = hashPastedText(latest.content);
  return {
    pasteHash: hash,
    pasteContent: latest.content,
    ...(pastePreview !== undefined ? { pastePreview } : {}),
    pastedContents: pasteResult.pastedContents,
  };
}

async function saveOnboardingByokKey(
  context: FirstRunOnboardingContext,
  provider: BuiltInProviderSlug,
  apiKey: string,
): Promise<void> {
  if (context.authBackend !== undefined) {
    await context.authBackend.saveByokKey({ provider, apiKey });
    return;
  }
  if (context.agencHome === undefined) {
    throw new Error("AgenC home is required to save a BYOK API key");
  }
  await new LocalAuthBackend({ agencHome: context.agencHome }).saveByokKey({
    provider,
    apiKey,
  });
}

async function saveApprovedApiKeyPaste(
  context: FirstRunOnboardingContext,
  approval: PendingApiKeyApproval,
): Promise<void> {
  if (
    context.agencHome === undefined ||
    approval.pasteHash === undefined ||
    approval.pasteContent === undefined
  ) {
    return;
  }
  await storePastedText({
    agencHome: context.agencHome,
    hash: approval.pasteHash,
    content: approval.pasteContent,
  });
}

function localModelsUrl(provider: BuiltInProviderSlug, baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  if (provider === "ollama") return `${trimmed.replace(/\/v1$/i, "")}/api/tags`;
  if (trimmed.endsWith("/models")) return trimmed;
  if (/\/(?:v\d+(?:beta)?|api\/v\d+)$/i.test(trimmed)) {
    return `${trimmed}/models`;
  }
  return `${trimmed}/v1/models`;
}

function remoteModelsUrl(provider: BuiltInProviderSlug, baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  if (provider === "gemini" && !/\/openai$/i.test(trimmed)) {
    return `${trimmed}/openai/models`;
  }
  if (trimmed.endsWith("/models")) return trimmed;
  if (/\/(?:v\d+(?:beta)?|api\/v\d+)$/i.test(trimmed)) {
    return `${trimmed}/models`;
  }
  return `${trimmed}/v1/models`;
}

function remoteProviderHeaders(
  provider: BuiltInProviderSlug,
  apiKey: string,
): Readonly<Record<string, string>> {
  if (provider === "anthropic") {
    return {
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey,
    };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

async function probeLocalProvider(params: {
  readonly provider: BuiltInProviderSlug;
  readonly baseURL: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<boolean> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (fetchImpl === undefined) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 750);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  try {
    const response = await fetchImpl(
      localModelsUrl(params.provider, params.baseURL),
      {
        method: "GET",
        signal: controller.signal,
      },
    );
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeRemoteProvider(params: {
  readonly provider: BuiltInProviderSlug;
  readonly baseURL: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<{ readonly ok: boolean; readonly status?: number }> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (fetchImpl === undefined) return { ok: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 1_500);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  try {
    const response = await fetchImpl(
      remoteModelsUrl(params.provider, params.baseURL),
      {
        method: "GET",
        headers: remoteProviderHeaders(params.provider, params.apiKey),
        signal: controller.signal,
      },
    );
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkOnboardingProviderConnection(
  context: FirstRunOnboardingContext,
  provider: BuiltInProviderSlug,
  model: string,
): Promise<ProviderConnectionCheck> {
  const settings = resolveProviderSettings(provider, context.config, context.env);
  const baseURL =
    settings?.baseURL ?? BUILT_IN_PROVIDER_BASE_URLS[provider];
  const keyEnvVar =
    settings?.apiKeyEnvVar ?? BUILT_IN_PROVIDER_API_KEY_ENVS[provider];

  if (provider === "agenc") {
    return {
      provider,
      model,
      status: "needs-key",
      ok: false,
      detail: "Hosted AgenC requires account auth; choose a BYOK provider for this first-run path.",
    };
  }

  if (LOCAL_PROVIDERS.has(provider)) {
    if (context.checkLocalProviders === false) {
      return {
        provider,
        model,
        status: "local-unchecked",
        ok: true,
        detail: "Local provider check skipped; AgenC will use the configured local endpoint.",
        baseURL,
      };
    }
    const reachable = await probeLocalProvider({
      provider,
      baseURL,
      fetchImpl: context.fetchImpl,
    });
    return {
      provider,
      model,
      status: reachable ? "ready" : "local-down",
      ok: reachable,
      detail: reachable
        ? "Local provider endpoint is reachable."
        : "Local provider endpoint did not respond; start it before the first model turn.",
      baseURL,
    };
  }

  if (!KEY_REQUIRED_PROVIDERS.has(provider)) {
    return {
      provider,
      model,
      status: "ready",
      ok: true,
      detail: "Provider is available without a local API key.",
      baseURL,
    };
  }

  if (
    MANAGED_KEY_PROVIDERS.has(provider) &&
    resolveAuthManagedKeysEnabled(context.config) &&
    hasRemoteAuthSessionSync(context.env)
  ) {
    if (!hasEntitledRemoteAuthSessionSync(context.env)) {
      const tier =
        remoteAuthSessionSubscriptionTierSync(context.env) ?? "unknown";
      const keyLabel = keyEnvVar ?? "a BYOK API key";
      return {
        provider,
        model,
        status: "needs-key",
        ok: false,
        detail:
          `AgenC account is signed in on the ${tier} plan. ` +
          `Managed provider keys require an active AgenC subscription; paste ${keyLabel} to continue.`,
        ...(keyEnvVar !== undefined ? { keyEnvVar } : {}),
        baseURL,
        canSkip: false,
      };
    }
    return {
      provider,
      model,
      status: "ready",
      ok: true,
      detail: "AgenC Pro is signed in. Hosted OpenRouter model access is ready.",
      baseURL,
    };
  }

  const apiKey = settings?.apiKey?.trim();
  if (apiKey !== undefined && apiKey.length > 0) {
    const remote = await probeRemoteProvider({
      provider,
      baseURL,
      apiKey,
      fetchImpl: context.fetchImpl,
    });
    if (!remote.ok) {
      const authFailed = remote.status === 401 || remote.status === 403;
      return {
        provider,
        model,
        status: authFailed ? "auth-failed" : "provider-unreachable",
        ok: false,
        detail: authFailed
          ? `Provider rejected ${keyEnvVar ?? "the configured API key"}.`
          : "Provider readiness check did not complete; verify network access and retry.",
        ...(keyEnvVar !== undefined ? { keyEnvVar } : {}),
        baseURL,
      };
    }
    return {
      provider,
      model,
      status: "ready",
      ok: true,
      detail: keyEnvVar === undefined
        ? "Provider credential found in config."
        : `Provider credential found via ${keyEnvVar}.`,
      ...(keyEnvVar !== undefined ? { keyEnvVar } : {}),
      baseURL,
    };
  }

  return {
    provider,
    model,
    status: "needs-key",
    ok: false,
    detail: `Set ${keyEnvVar ?? "the provider API key"} before the first model turn, or continue and add it later.`,
    ...(keyEnvVar !== undefined ? { keyEnvVar } : {}),
    baseURL,
  };
}

export async function submitFirstRunOnboardingInput(
  state: FirstRunOnboardingState,
  rawInput: string,
  context: FirstRunOnboardingContext,
): Promise<FirstRunOnboardingSubmitResult> {
  const raw = normalizeOnboardingCommand(rawInput);
  const slashError = onboardingSlashCommandError(raw);
  if (slashError !== null) {
    return {
      state: { ...state, error: slashError },
      completed: false,
    };
  }

  switch (state.currentStepId) {
    case "preflight":
      {
        const error = invalidCommandError(raw, "next");
        if (error !== null) {
          return {
            state: { ...state, error },
            completed: false,
          };
        }
      }
      return {
        state: withCompletedStep(state, "preflight", "theme"),
        completed: false,
      };
    case "theme": {
      const theme = parseTheme(raw, state.selectedTheme);
      if (theme === null) {
        return {
          state: { ...state, error: "Choose 1, 2, 3, dark, light, or system." },
          completed: false,
        };
      }
      return {
        state: withCompletedStep(
          { ...state, selectedTheme: theme },
          "theme",
          "provider",
        ),
        completed: false,
      };
    }
    case "provider": {
      const provider = parseProvider(raw, state.selectedProvider, context);
      if (provider === null) {
        return {
          state: { ...state, error: "Choose a provider number or slug." },
          completed: false,
        };
      }
      const selectedModel = providerDefaultModel(
        provider,
        context.config,
        context.env,
      );
      return {
        state: withCompletedStep(
          {
            ...state,
            selectedProvider: provider,
            selectedModel,
            connection: null,
            pastedContents: [],
            pendingApiKeyApproval: null,
          },
          "provider",
          "api-key",
        ),
        completed: false,
      };
    }
    case "connection-test": {
      const command = raw.trim().toLowerCase();
      if (command !== "next" && command !== "test") {
        return {
          state: { ...state, error: "Type test or next to run the connection check." },
          completed: false,
        };
      }
      const connection = await checkOnboardingProviderConnection(
        context,
        state.selectedProvider,
        state.selectedModel,
      );
      return {
        state: withCompletedStep(
          { ...state, connection },
          "connection-test",
          "security",
        ),
        completed: false,
      };
    }
    case "api-key":
      if (state.pendingApiKeyApproval !== null) {
        const answer = approvalAnswer(lowerCommand(raw));
        if (answer === null) {
          return {
            state: {
              ...state,
              error: "Type yes to save this key or no to continue without saving.",
            },
            completed: false,
          };
        }
        if (answer === "no") {
          return {
            state: withCompletedStep(
              { ...state, pendingApiKeyApproval: null },
              "api-key",
              "connection-test",
            ),
            completed: false,
          };
        }
        try {
          await saveApprovedApiKeyPaste(
            context,
            state.pendingApiKeyApproval,
          );
          await saveOnboardingByokKey(
            context,
            state.pendingApiKeyApproval.provider,
            state.pendingApiKeyApproval.apiKey,
          );
        } catch (error) {
          if (
            context.agencHome !== undefined &&
            state.pendingApiKeyApproval.pasteHash !== undefined
          ) {
            await deletePastedText({
              agencHome: context.agencHome,
              hash: state.pendingApiKeyApproval.pasteHash,
            }).catch(() => {
              /* best effort */
            });
          }
          return {
            state: {
              ...state,
              error:
                error instanceof Error
                  ? error.message
                  : "Could not save the BYOK API key.",
            },
            completed: false,
          };
        }
        return {
          state: withCompletedSteps(
            {
              ...state,
              pendingApiKeyApproval: null,
              connection: verifiedApiKeyConnection(
                state.selectedProvider,
                state.selectedModel,
              ),
            },
            ["api-key", "connection-test"],
            "security",
          ),
          completed: false,
        };
      }
      {
        const command = lowerCommand(raw);
        if (isSkipApiKeyCommand(command)) {
          const skipError = apiKeySkipError(state.connection);
          if (skipError !== null) {
            return {
              state: { ...state, error: skipError },
              completed: false,
            };
          }
          return {
            state: withCompletedStep(state, "api-key", "connection-test"),
            completed: false,
          };
        }
        const apiKey = normalizeApiKeyEntry(raw);
        if (apiKey.length === 0 || /\s/.test(apiKey)) {
          return {
            state: {
              ...state,
              error:
                "Type next or skip to continue without saving, or paste a single API key without whitespace.",
            },
            completed: false,
          };
        }
        const pasteCapture = captureApiKeyPaste(state, raw);
        const verification = await verifyApiKey({
          provider: state.selectedProvider,
          apiKey,
          config: context.config,
          env: context.env,
          fetchImpl: context.fetchImpl,
        });
        if (verification.status !== "valid") {
          return {
            state: {
              ...state,
              error: apiKeyVerificationErrorMessage(verification.error),
            },
            completed: false,
          };
        }
        return {
          state: {
            ...state,
            pastedContents: pasteCapture.pastedContents,
            pendingApiKeyApproval: {
              provider: state.selectedProvider,
              apiKey,
              maskedTail: maskedApiKeyTail(apiKey),
              ...(pasteCapture.pasteHash !== undefined
                ? { pasteHash: pasteCapture.pasteHash }
                : {}),
              ...(pasteCapture.pasteContent !== undefined
                ? { pasteContent: pasteCapture.pasteContent }
                : {}),
              ...(pasteCapture.pastePreview !== undefined
                ? { pastePreview: pasteCapture.pastePreview }
                : {}),
              verificationStatus: verification.status,
              ...(verification.error !== undefined
                ? { verificationError: verification.error }
                : {}),
            },
            error: null,
          },
          completed: false,
        };
      }
    case "security":
      {
        const error = invalidCommandError(raw, "next");
        if (error !== null) {
          return {
            state: { ...state, error },
            completed: false,
          };
        }
      }
      return {
        state: withCompletedStep(state, "security", "terminal-setup"),
        completed: false,
      };
    case "terminal-setup":
      {
        const command = raw.trim().toLowerCase();
        if (command !== "done") {
          return {
            state: { ...state, error: "Type done to finish onboarding." },
            completed: false,
          };
        }
      }
      return {
        state: withCompletedStep(state, "terminal-setup", null),
        completed: true,
      };
  }
}

function currentStepFor(
  state: FirstRunOnboardingState,
  steps: readonly FirstRunOnboardingStep[],
): FirstRunOnboardingStep {
  return steps.find((step) => step.id === state.currentStepId) ?? steps[0]!;
}

export function useFirstRunOnboardingController(
  options: UseFirstRunOnboardingOptions,
): UseFirstRunOnboardingResult {
  const initialState = useMemo(
    () => createInitialFirstRunOnboardingState(options),
    [options.config, options.env],
  );
  const shouldStart = options.disabled === true
    ? false
    : shouldShowFirstRunOnboarding({
      agencHome: options.agencHome,
      env: options.env,
      hasInitialPrompt: options.hasInitialPrompt,
      isInteractive: options.isInteractive,
    });
  const [active, setActive] = useState(shouldStart);
  const [state, setState] = useState(initialState);
  const stateRef = useRef(initialState);
  const recordedSeen = useRef(false);
  const submitInFlight = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void detectRunningLocalProviders(options).then((detected) => {
      if (cancelled || detected.length === 0) return;
      setState((current) => {
        const next = { ...current, detectedLocalProviders: detected };
        stateRef.current = next;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [active, options.config, options.env]);

  useEffect(() => {
    if (!active || recordedSeen.current || options.agencHome === undefined) {
      return;
    }
    recordedSeen.current = true;
    incrementFirstRunOnboardingSeenCount({ agencHome: options.agencHome });
    void cleanupOldPastes({ agencHome: options.agencHome }).catch(() => {
      /* best effort */
    });
  }, [active, options.agencHome]);

  const submit = useCallback(
    async (input: string): Promise<boolean> => {
      if (!active) return false;
      if (submitInFlight.current) return true;
      submitInFlight.current = true;
      setState((current) => {
        const next = { ...current, isCheckingConnection: true };
        stateRef.current = next;
        return next;
      });
      try {
        const result = await submitFirstRunOnboardingInput(
          stateRef.current,
          input,
          options,
        );
        const nextState = {
          ...result.state,
          isCheckingConnection: false,
        };
        stateRef.current = nextState;
        setState(nextState);
        if (result.completed) {
          if (options.agencHome !== undefined) {
            markFirstRunOnboardingComplete({
              agencHome: options.agencHome,
              selectedProvider: nextState.selectedProvider,
              selectedModel: nextState.selectedModel,
              selectedTheme: nextState.selectedTheme,
              completedStepIds: nextState.completedStepIds,
            });
          }
          await options.onComplete?.(nextState);
          setActive(false);
        }
        return true;
      } finally {
        submitInFlight.current = false;
      }
    },
    [active, options],
  );

  const steps = useMemo(() => buildFirstRunOnboardingSteps(state), [state]);
  return {
    active,
    state,
    steps,
    currentStep: currentStepFor(state, steps),
    submit,
  };
}

function apiKeyInstructionForConnection(
  connection: ProviderConnectionCheck | null,
): string {
  if (connection === null) {
    return "Paste an API key to verify it, or type next to continue without saving.";
  }
  if (connection.status === "ready") {
    if (connection.keyEnvVar !== undefined) {
      return `${connection.keyEnvVar} is present and verified. Type next to continue, or paste a replacement key.`;
    }
    return "Provider credential is verified. Type next to continue, or paste a replacement key.";
  }
  if (connection.keyEnvVar === undefined) {
    return "Paste an API key to verify it, or type next or skip to continue.";
  }
  if (connection.canSkip === false) {
    return `Paste ${connection.keyEnvVar} to verify it before continuing.`;
  }
  if (
    connection.status === "auth-failed" ||
    connection.status === "provider-unreachable"
  ) {
    return `${connection.keyEnvVar} did not verify. Type next or skip to continue without saving, or paste a replacement key.`;
  }
  return `Paste ${connection.keyEnvVar} to verify it, or type next or skip to add it later.`;
}

function apiKeyInstructionForProvider(
  provider: BuiltInProviderSlug,
  context: FirstRunOnboardingContext,
): string {
  const keyEnvVar = BUILT_IN_PROVIDER_API_KEY_ENVS[provider];
  if (
    MANAGED_KEY_PROVIDERS.has(provider) &&
    resolveAuthManagedKeysEnabled(context.config) &&
    hasEntitledRemoteAuthSessionSync(context.env)
  ) {
    return "Your Pro account can use hosted model access here. Type next to verify it.";
  }
  if (!KEY_REQUIRED_PROVIDERS.has(provider)) {
    return "This provider can continue without a BYOK API key. Type next to continue.";
  }
  if (keyEnvVar === undefined) {
    return "Paste an API key to verify it, or type next or skip to add it later.";
  }
  return `Paste ${keyEnvVar} to verify it, or type next or skip to add it later.`;
}

function securityLinesForContext(
  context: FirstRunOnboardingContext,
): readonly string[] {
  if (context.permissionMode === "bypassPermissions") {
    return [
      "Permission mode: bypassPermissions (--yolo skips tool approval prompts).",
      "Sandbox: danger-full-access (--yolo disables workspace sandboxing for this session).",
      "Type next to continue with --yolo, or restart without --yolo for prompts and sandboxing.",
    ];
  }
  return [
    `Permission mode: ${context.permissionMode ?? "default"}`,
    `Sandbox: ${context.sandboxMode ?? "workspace-write"}`,
    "Type next to keep these defaults.",
  ];
}

export function detailLinesForStep(
  state: FirstRunOnboardingState,
  context: FirstRunOnboardingContext,
): readonly string[] {
  switch (state.currentStepId) {
    case "preflight":
      return [
        `Workspace: ${context.cwd ?? process.cwd()}`,
        `AgenC home: ${context.agencHome ?? "not configured"}`,
        ...(context.permissionMode === "bypassPermissions"
          ? ["--yolo is active: tool approvals and workspace sandboxing are bypassed for this session."]
          : []),
        "Onboarding input only. Use /exit, Ctrl-C twice, or Ctrl-D twice to leave.",
        "Type next to continue.",
      ];
    case "theme":
      return [
        ...THEME_CHOICES.map((theme, index) =>
          `${index + 1}. ${theme}${theme === state.selectedTheme ? " (current)" : ""}`
        ),
        "Type a number or theme name.",
      ];
    case "provider": {
      const detected = new Set(state.detectedLocalProviders);
      return [
        ...providerChoices(context).map((provider, index) =>
          `${index + 1}. ${provider}${provider === state.selectedProvider ? " (current)" : ""}${detected.has(provider) ? " — detected, running locally, no key needed" : ""}`
        ),
        ...(detected.size > 0
          ? [
              `Tip: ${[...detected][0]} is already running on this machine — pick it for a zero-key start.`,
            ]
          : []),
        "Type a number or provider slug.",
      ];
    }
    case "connection-test":
      return state.isCheckingConnection
        ? ["Checking provider readiness..."]
        : [
            `Provider: ${state.selectedProvider}`,
            `Model: ${state.selectedModel}`,
            "Type test or next to run the connection check.",
          ];
    case "api-key": {
      if (state.pendingApiKeyApproval !== null) {
        return [];
      }
      const connection = state.connection;
      if (connection === null) {
        return [
          `Provider: ${state.selectedProvider}`,
          apiKeyInstructionForProvider(state.selectedProvider, context),
        ];
      }
      return [
        connection.detail,
        apiKeyInstructionForConnection(connection),
        ...(state.pastedContents.length > 0
          ? [`Captured ${state.pastedContents.length} large paste privately.`]
          : []),
      ];
    }
    case "security":
      return securityLinesForContext(context);
    case "terminal-setup":
      return [
        `Terminal: ${context.terminalName ?? "terminal"}`,
        "Type done to finish onboarding.",
      ];
  }
}

export interface OnboardingProps {
  readonly state: FirstRunOnboardingState;
  readonly steps: readonly FirstRunOnboardingStep[];
  readonly currentStep: FirstRunOnboardingStep;
  readonly context: FirstRunOnboardingContext;
}

export function Onboarding({
  state,
  steps,
  currentStep,
  context,
}: OnboardingProps): React.ReactElement {
  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <WelcomeV2
        provider={state.selectedProvider}
        model={state.selectedModel}
      />
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{currentStep.title}</Text>
        {state.currentStepId === "api-key" &&
        state.pendingApiKeyApproval !== null ? (
          <ApproveApiKey
            provider={state.pendingApiKeyApproval.provider}
            maskedTail={state.pendingApiKeyApproval.maskedTail}
            status={state.pendingApiKeyApproval.verificationStatus}
            error={state.pendingApiKeyApproval.verificationError}
            pastePreview={state.pendingApiKeyApproval.pastePreview}
          />
        ) : (
          detailLinesForStep(state, context).map((line) => (
            <Text key={line} dimColor>{line}</Text>
          ))
        )}
        {state.error !== null ? <Text>{state.error}</Text> : null}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {steps.map((step) => {
          const marker = step.isComplete
            ? "[x]"
            : step.id === currentStep.id
              ? "[>]"
              : "[ ]";
          return (
            <Text key={step.id} dimColor={step.id !== currentStep.id}>
              {marker} {step.title}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
