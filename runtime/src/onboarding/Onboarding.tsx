import React, {
  useCallback,
  useContext,
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
import { Box } from "../tui/ink.js";
import ThemedBox from "../tui/components/design-system/ThemedBox.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { useTheme } from "../tui/components/design-system/ThemeProvider.js";
import { getSystemThemeName } from "../utils/systemTheme.js";
import type { ThemeSetting } from "../utils/theme.js";
import { TerminalSizeContext } from "../tui/ink/components/TerminalSizeContext.js";
import { WelcomeV2 } from "./WelcomeV2.js";
import {
  DEFAULT_PROVIDER_VERIFY_TIMEOUT_MS,
  isKeyRejectedStatus,
  providerVerificationUrl,
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

export type GrokOauthLoginResult =
  | { readonly ok: true; readonly accountLabel: string }
  | { readonly ok: false; readonly message: string };

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
  /**
   * Runs the X / xAI OAuth sign-in for the grok provider (browser PKCE flow —
   * the same one behind /grok-login). Injectable so wizard tests never open a
   * browser; the default lazily imports the real flow.
   */
  readonly runGrokOauthLogin?: () => Promise<GrokOauthLoginResult>;
}

/**
 * Default grok OAuth sign-in used by the api-key step's `login` input: the
 * browser PKCE loopback flow with tokens persisted exactly like /grok-login.
 * Lazy imports keep the wizard module light for the non-grok path.
 */
async function defaultRunGrokOauthLogin(): Promise<GrokOauthLoginResult> {
  try {
    const [{ runXaiBrowserLogin }, { openUrlInBrowser }, creds] =
      await Promise.all([
        import("../services/xai/oauth.js"),
        import("../commands/auth.js"),
        import("../utils/xaiOauthCredentials.js"),
      ]);
    const login = await runXaiBrowserLogin({
      onAuthorizeUrl: (url) => {
        void openUrlInBrowser(url);
      },
    });
    const blob = creds.xaiOauthTokensToBlob(login.tokens, {
      tokenEndpoint: login.tokenEndpoint,
    });
    const saved = creds.saveXaiOauthCredentials(blob);
    if (!saved.success) {
      return {
        ok: false,
        message: `Signed in, but storing tokens failed: ${saved.warning ?? "unknown error"}`,
      };
    }
    return {
      ok: true,
      accountLabel: blob.accountLabel ?? login.identity.sub ?? "xAI account",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Browser sign-in did not complete (${detail}). Paste XAI_API_KEY instead, or run /grok-login device after setup.`,
    };
  }
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

/**
 * Map a wizard theme choice to the config `ThemeSetting` the ThemeProvider
 * consumes. The wizard says "system"; the theme engine calls that "auto".
 * Returns undefined for anything unknown so callers can no-op safely.
 */
export function wizardThemeToSetting(
  choice: string,
): ThemeSetting | undefined {
  if (choice === "dark") return "dark";
  if (choice === "light") return "light";
  if (choice === "system") return "auto";
  return undefined;
}
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
  const timer = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? DEFAULT_PROVIDER_VERIFY_TIMEOUT_MS,
  );
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  try {
    const response = await fetchImpl(
      providerVerificationUrl(params.provider, params.baseURL),
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
      const authFailed =
        remote.status !== undefined && isKeyRejectedStatus(provider, remote.status);
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
        // Grok: `login` runs the X / xAI OAuth sign-in instead of a pasted
        // key. On success the step advances to the connection test, which
        // verifies the stored OAuth bearer through the same provider
        // resolution the session will use (OAuth always wins over env BYOK).
        if (
          state.selectedProvider === "grok" &&
          (command === "login" ||
            command === "grok-login" ||
            command === "xai-login")
        ) {
          const runLogin =
            context.runGrokOauthLogin ?? defaultRunGrokOauthLogin;
          const result = await runLogin();
          if (!result.ok) {
            return {
              state: { ...state, error: result.message },
              completed: false,
            };
          }
          return {
            state: withCompletedStep(
              { ...state, error: null },
              "api-key",
              "connection-test",
            ),
            completed: false,
          };
        }
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
    case "theme": {
      // The TUI colours text but does NOT repaint the terminal's own
      // background, so a light theme on a dark terminal (or vice versa) reads
      // as grey-on-black. The terminal background is already detected for the
      // 'auto' mode (COLORFGBG seed + OSC 11 watcher) — surface it here so the
      // user picks with that context instead of discovering the mismatch.
      const terminalBackground = getSystemThemeName();
      const readable =
        terminalBackground === "light" ? '"light" or "system"' : '"dark" or "system"';
      return [
        ...THEME_CHOICES.map((theme, index) =>
          `${index + 1}. ${theme}${theme === state.selectedTheme ? " (current)" : ""}`
        ),
        `Tip: your terminal background looks ${terminalBackground} — ${readable} will read best here.`,
        "Type a number or theme name.",
      ];
    }
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
      // Grok has a keyless path: the X / xAI OAuth sign-in behind
      // /grok-login (subscription access; always wins over env BYOK).
      // Offer it here so first-run users are not funneled into creating a
      // console.x.ai key they may not need.
      const grokLoginOffer =
        state.selectedProvider === "grok"
          ? [
              "Or type login to sign in with your X / xAI account — no API key needed.",
            ]
          : [];
      const connection = state.connection;
      if (connection === null) {
        return [
          `Provider: ${state.selectedProvider}`,
          apiKeyInstructionForProvider(state.selectedProvider, context),
          ...grokLoginOffer,
        ];
      }
      return [
        connection.detail,
        apiKeyInstructionForConnection(connection),
        ...grokLoginOffer,
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

/**
 * A detail line classified for layout. A terminal can't change font size, so
 * hierarchy + tidy distribution come from colour, weight, column alignment and
 * grouping (a blank line between the data/choices and the action hints).
 */
type OnboardingDetailEntry =
  | { readonly kind: "choice"; readonly num: string; readonly text: string; readonly current: boolean }
  | { readonly kind: "kv"; readonly label: string; readonly value: string }
  | { readonly kind: "hint"; readonly text: string }
  | { readonly kind: "plain"; readonly text: string };

function classifyOnboardingDetail(line: string): OnboardingDetailEntry {
  const choice = /^(\d+)\.\s+(.*)$/u.exec(line);
  if (choice) {
    return {
      kind: "choice",
      num: choice[1] ?? "",
      text: choice[2] ?? "",
      current: /\(current\)\s*$/u.test(line),
    };
  }
  if (/^(Type |Or type |Tip:|Onboarding input only)/u.test(line)) {
    return { kind: "hint", text: line };
  }
  const kv = /^([A-Za-z][A-Za-z ]+):\s+(.*)$/u.exec(line);
  if (kv) {
    return { kind: "kv", label: kv[1] ?? "", value: kv[2] ?? "" };
  }
  return { kind: "plain", text: line };
}

function OnboardingDetailRow({
  entry,
  labelWidth,
}: {
  readonly entry: OnboardingDetailEntry;
  readonly labelWidth: number;
}): React.ReactElement {
  switch (entry.kind) {
    case "choice":
      return (
        <Box flexDirection="row">
          <ThemedText color="agenc" bold>
            {entry.current ? "▸ " : "  "}
          </ThemedText>
          <ThemedText color="agenc" bold>
            {entry.num}.{" "}
          </ThemedText>
          <ThemedText color={entry.current ? "text" : "text2"} bold={entry.current}>
            {entry.text}
          </ThemedText>
        </Box>
      );
    case "kv":
      // Two aligned columns (label padded to the widest label), like the cold
      // welcome panel — values line up instead of hanging off ragged labels.
      return (
        <Box flexDirection="row">
          <ThemedText color="inactive">{`${entry.label.padEnd(labelWidth)}   `}</ThemedText>
          <ThemedText color="text" wrap="truncate-middle">
            {entry.value}
          </ThemedText>
        </Box>
      );
    case "hint":
      return <ThemedText color="inactive">{entry.text}</ThemedText>;
    default:
      return <ThemedText color="text2">{entry.text}</ThemedText>;
  }
}

function renderOnboardingDetail(lines: readonly string[]): React.ReactNode[] {
  const entries = lines.map(classifyOnboardingDetail);
  const labelWidth = entries.reduce(
    (max, entry) => (entry.kind === "kv" ? Math.max(max, entry.label.length) : max),
    0,
  );
  const nodes: React.ReactNode[] = [];
  entries.forEach((entry, index) => {
    const previous = entries[index - 1];
    // A blank line before the first hint after any content splits the action
    // instructions ("Type next…") from the data/choices above them.
    if (entry.kind === "hint" && previous !== undefined && previous.kind !== "hint") {
      nodes.push(<Box key={`gap-${index}`} height={1} />);
    }
    nodes.push(
      <OnboardingDetailRow key={lines[index]} entry={entry} labelWidth={labelWidth} />,
    );
  });
  return nodes;
}

export function Onboarding({
  state,
  steps,
  currentStep,
  context,
}: OnboardingProps): React.ReactElement {
  // Apply the theme choice LIVE (and persist it — the provider's setter saves
  // to global config). Selecting "light" previously only landed in
  // onboarding.json, which nothing reads for rendering, so the session stayed
  // dark and the choice silently evaporated. The seed value on mount is
  // deliberately NOT applied: re-running the wizard must not overwrite the
  // user's configured theme until they actually change the selection.
  const [, setThemeSetting] = useTheme();
  const appliedThemeRef = useRef<string | null>(null);
  useEffect(() => {
    const mapped = wizardThemeToSetting(state.selectedTheme);
    if (mapped === undefined) return;
    if (appliedThemeRef.current === null) {
      appliedThemeRef.current = state.selectedTheme;
      return;
    }
    if (appliedThemeRef.current === state.selectedTheme) return;
    appliedThemeRef.current = state.selectedTheme;
    setThemeSetting?.(mapped);
  }, [state.selectedTheme, setThemeSetting]);

  const terminalSize = useContext(TerminalSizeContext);
  const columns =
    terminalSize && Number.isFinite(terminalSize.columns)
      ? terminalSize.columns
      : 80;
  // Cap at 84 so the longest preflight hint ("Onboarding input only. Use
  // /exit, Ctrl-C twice, or Ctrl-D twice to leave.") fits on one line on a
  // normal-width terminal instead of wrapping with a ragged hanging indent.
  const cardWidth = Math.max(40, Math.min(84, columns - 2));
  const detailLines = detailLinesForStep(state, context);
  const showApproval =
    state.currentStepId === "api-key" && state.pendingApiKeyApproval !== null;

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <WelcomeV2
        provider={state.selectedProvider}
        model={state.selectedModel}
      />

      {/* The active step is a single accent card (same language as the trust
          dialog): purple border, the step title as a bright heading, and the
          detail lines rendered with real hierarchy. */}
      <ThemedBox
        flexDirection="column"
        width={cardWidth}
        borderStyle="round"
        borderColor="agenc"
        paddingX={2}
        paddingY={1}
        marginTop={1}
      >
        <ThemedText color="agenc" bold>
          {currentStep.title}
        </ThemedText>
        <Box height={1} />
        {showApproval && state.pendingApiKeyApproval !== null ? (
          <ApproveApiKey
            provider={state.pendingApiKeyApproval.provider}
            maskedTail={state.pendingApiKeyApproval.maskedTail}
            status={state.pendingApiKeyApproval.verificationStatus}
            error={state.pendingApiKeyApproval.verificationError}
            pastePreview={state.pendingApiKeyApproval.pastePreview}
          />
        ) : (
          renderOnboardingDetail(detailLines)
        )}
        {state.error !== null ? (
          <Box marginTop={1}>
            <ThemedText color="warning">{state.error}</ThemedText>
          </Box>
        ) : null}
      </ThemedBox>

      {/* Progress rail: done = green ✓, current = purple ▸ (bright title),
          pending = dim ·. Replaces the flat [x]/[>]/[ ] ASCII markers. */}
      <Box flexDirection="column" marginTop={1}>
        {steps.map((step) => {
          const isCurrent = step.id === currentStep.id;
          const marker = step.isComplete ? "✓" : isCurrent ? "▸" : "·";
          const markerColor = step.isComplete
            ? "success"
            : isCurrent
              ? "agenc"
              : "muted3";
          const titleColor = isCurrent ? "text" : step.isComplete ? "text2" : "inactive";
          return (
            <Box key={step.id} flexDirection="row">
              <ThemedText color={markerColor} bold={isCurrent}>
                {marker}{" "}
              </ThemedText>
              <ThemedText color={titleColor} bold={isCurrent}>
                {step.title}
              </ThemedText>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
