import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  readProviderConfig,
  resolveProviderSettings,
} from "../config/resolve-provider.js";
import {
  TUI_THEME_SETTINGS,
  type AgenCConfig,
} from "../config/schema.js";
import {
  createAuthBackend,
  resolveAuthManagedKeysEnabled,
} from "../auth/selection.js";
import type {
  AuthIdentity,
  AuthSubscriptionTier,
} from "../auth/backend.js";
import type { RemoteAuthDeviceCodePrompt } from "../auth/backends/remote.js";
import {
  hasEntitledRemoteAuthSessionSync,
  hasRemoteAuthSessionSync,
  remoteAuthSessionSubscriptionTierSync,
  type RemoteAuthSessionReadContext,
} from "../auth/session-state.js";
import {
  BUILT_IN_PROVIDER_BASE_URLS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  listBuiltInProviderInfo,
  providerApiKeyEnvironmentLabel,
  providerCredentialEnvironmentLabel,
  resolveBuiltInProviderInfo,
  resolveBuiltInProviderSlug,
  type BuiltInProviderOnboardingInfo,
  type BuiltInProviderSlug,
} from "../llm/registry/provider-info.js";
import {
  type ProviderCredentialProvenance,
} from "../llm/registry/provider-ingress.js";
import { isTrustedXaiOauthInferenceBaseUrl } from "../services/xai/oauth.js";
import { LocalAuthBackend } from "../auth/backends/local.js";
import { readLocalByokCredential } from "../auth/native-credentials.js";
import { resolveProviderRuntimeAuthority } from "../llm/provider-options.js";
import { resolveProviderRuntimeRequest } from "../llm/provider-request.js";
import {
  geminiEndpointFor,
} from "../llm/providers/gemini/endpoint-plan.js";
import {
  readGeminiRuntimeOptions,
} from "../llm/providers/gemini/runtime-options.js";
import {
  getGeminiAuthMode,
  resolveGeminiCredentialPlan,
  type GeminiCredentialPlan,
} from "../utils/geminiAuth.js";
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
import {
  getTerminalBackground,
  isTerminalBackgroundDetected,
} from "../utils/terminalBackground.js";
import type { ThemeSetting } from "../utils/theme.js";
import { TerminalSizeContext } from "../tui/ink/components/TerminalSizeContext.js";
import { WelcomeV2 } from "./WelcomeV2.js";
import {
  verifyApiKey,
  verifyPreparedProviderConnection,
  type VerificationStatus,
} from "./useApiKeyVerification.js";
import {
  isFreeSubscriptionManagedModel,
  SUBSCRIPTION_MANAGED_DEFAULT_PROVIDER,
  subscriptionManagedDefaultModel,
  subscriptionManagedDefaultModelForTier,
} from "../commands/subscription-managed-models.js";
import { captureSecureStorageIngress } from "../utils/secureStorage/home.js";

export type FirstRunOnboardingStepId =
  | "preflight"
  | "theme"
  | "provider"
  | "connection-test"
  | "model-access"
  | "security"
  | "terminal-setup";

export type ProviderConnectionStatus =
  | "ready"
  | "credentials-required"
  | "auth-failed"
  | "provider-unreachable"
  | "local-unchecked"
  | "local-model-missing"
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
  /** Human-readable configuration guidance, never evidence of a winning source. */
  readonly credentialLabel?: string;
  /** Exact credential provenance, without credential values. */
  readonly credentialProvenance?: ProviderConnectionCredentialProvenance;
  readonly baseURL?: string;
  readonly canSkip?: boolean;
}

export type ProviderConnectionCredentialProvenance =
  | ProviderCredentialProvenance
  | { readonly kind: "verified-input" };

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
  readonly selectedTheme: ThemeSetting;
  readonly selectedProvider: BuiltInProviderSlug;
  readonly selectedModel: string;
  readonly connection: ProviderConnectionCheck | null;
  readonly pastedContents: readonly PastedContent[];
  readonly pendingApiKeyApproval: PendingApiKeyApproval | null;
  readonly modelAccessInput: "menu" | "api-key";
  readonly authPrompt: OnboardingAuthPrompt | null;
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

export type AgenCAccountLoginResult =
  | {
      readonly ok: true;
      readonly accountLabel: string;
      readonly subscriptionTier: AuthSubscriptionTier;
    }
  | { readonly ok: false; readonly message: string };

export interface OnboardingAuthPrompt {
  readonly heading: string;
  readonly detail: string;
  readonly url: string;
  readonly userCode?: string;
}

export interface FirstRunOnboardingContext {
  readonly agencHome?: string;
  readonly authBackend?: FirstRunByokAuthBackend;
  readonly config: AgenCConfig;
  readonly cwd?: string;
  readonly env?: OnboardingEnv;
  /** Captured home/environment pair used for synchronous remote-auth reads. */
  readonly remoteAuthSessionContext?: RemoteAuthSessionReadContext;
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
  /**
   * Runs AgenC account sign-in (the same remote auth backend as /login).
   * Injectable so wizard tests never open a browser.
   */
  readonly runAgenCAccountLogin?: () => Promise<AgenCAccountLoginResult>;
  /** Reports the URL/code while a browser or device sign-in is pending. */
  readonly onAuthPrompt?: (prompt: OnboardingAuthPrompt) => void;
}

/**
 * Default Grok OAuth sign-in used by the model-access step. Browser PKCE is
 * primary and device code is the headless fallback, matching /grok-login.
 * Lazy imports keep the wizard module light for the non-Grok path.
 */
async function defaultRunGrokOauthLogin(
  context: FirstRunOnboardingContext,
): Promise<GrokOauthLoginResult> {
  try {
    const ingress = captureSecureStorageIngress(
      context.env ?? process.env,
      context.agencHome,
    );
    const [oauth, { openUrlInBrowser }, creds] =
      await Promise.all([
        import("../services/xai/oauth.js"),
        import("../commands/auth.js"),
        import("../utils/xaiOauthCredentials.js"),
      ]);
    let login;
    try {
      login = await oauth.runXaiBrowserLogin({
        onAuthorizeUrl: async (url) => {
          context.onAuthPrompt?.({
            heading: "Sign in with X / xAI",
            detail:
              "Finish the xAI consent flow in your browser. The page may say Grok Build.",
            url,
          });
          await openUrlInBrowser(url).catch(() => {
            // The URL remains visible in the onboarding card.
          });
        },
      });
    } catch (error) {
      if (
        !(error instanceof oauth.XaiOauthError) ||
        error.code !== "callback_failed"
      ) {
        throw error;
      }
      login = await oauth.runXaiDeviceLogin({
        onUserCode: async ({
          userCode,
          verificationUri,
          verificationUriComplete,
        }) => {
          const url = verificationUriComplete ?? verificationUri;
          context.onAuthPrompt?.({
            heading: "Sign in with X / xAI",
            detail:
              "Finish the xAI device sign-in in your browser. The page may say Grok Build.",
            url,
            userCode,
          });
          await openUrlInBrowser(url).catch(() => {
            // The URL and code remain visible in the onboarding card.
          });
        },
      });
    }
    const blob = creds.xaiOauthTokensToBlob(login.tokens, {
      tokenEndpoint: login.tokenEndpoint,
    });
    const saved = creds.saveXaiOauthCredentials(ingress.home, blob);
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
      message:
        `X / xAI sign-in did not complete (${detail}). ` +
        "Try again, use an API key, or configure model access later.",
    };
  }
}

function authIdentityLabel(identity: AuthIdentity | undefined): string {
  return (
    identity?.displayName?.trim() ||
    identity?.email?.trim() ||
    identity?.accountId?.trim() ||
    "AgenC account"
  );
}

function reportAgenCDeviceCode(
  context: FirstRunOnboardingContext,
  prompt: RemoteAuthDeviceCodePrompt,
): void {
  if (prompt.verificationUri === undefined) return;
  context.onAuthPrompt?.({
    heading: "Sign in or create an AgenC account",
    detail:
      "Finish the browser sign-in. New users can create their account in the same flow.",
    url: prompt.verificationUri,
    ...(prompt.userCode !== undefined ? { userCode: prompt.userCode } : {}),
  });
}

async function defaultRunAgenCAccountLogin(
  context: FirstRunOnboardingContext,
): Promise<AgenCAccountLoginResult> {
  try {
    const ingress = captureSecureStorageIngress(
      context.env ?? process.env,
      context.agencHome,
    );
    const { openUrlInBrowser } = await import("../commands/auth.js");
    const backend = createAuthBackend(context.config, {
      agencHome: ingress.home.path,
      env: ingress.environment,
      remote: {
        onDeviceCode: async (prompt) => {
          reportAgenCDeviceCode(context, prompt);
          if (prompt.verificationUri === undefined) return;
          await openUrlInBrowser(prompt.verificationUri).catch(() => {
            // The URL and optional code remain visible in the onboarding card.
          });
        },
      },
    });
    const login = await backend.login({ sessionId: "tui" });
    const subscriptionTier = await backend.getSubscriptionTier({
      sessionId: "tui",
    });
    return {
      ok: true,
      accountLabel: authIdentityLabel(login.identity),
      subscriptionTier,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message:
        `AgenC account sign-in did not complete (${detail}). ` +
        "Try again, use another access method, or configure model access later.",
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
  "model-access",
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
    "model-access": "Model access",
    security: "Security",
    "terminal-setup": "Terminal setup",
  });

const THEME_CHOICES: readonly ThemeSetting[] = TUI_THEME_SETTINGS;

/**
 * Accept exactly the canonical `ThemeSetting` vocabulary. Returns undefined
 * for anything unknown so stale onboarding state cannot corrupt config.
 */
export function wizardThemeToSetting(
  choice: string,
): ThemeSetting | undefined {
  return THEME_CHOICES.find((theme) => theme === choice);
}

function providerOnboardingInfo(
  provider: BuiltInProviderSlug,
): BuiltInProviderOnboardingInfo {
  const info = resolveBuiltInProviderInfo(provider);
  if (info === undefined) {
    throw new Error(`Missing built-in provider metadata for ${provider}`);
  }
  return info.onboarding;
}

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
  context: Pick<
    FirstRunOnboardingContext,
    "config" | "env" | "remoteAuthSessionContext"
  >,
): string {
  if (
    providerOnboardingInfo(provider).supportsManagedKeyAccess &&
    resolveAuthManagedKeysEnabled(context.config) &&
    context.remoteAuthSessionContext !== undefined &&
    hasRemoteAuthSessionSync(context.remoteAuthSessionContext)
  ) {
    return (
      subscriptionManagedDefaultModelForTier(
        provider,
        remoteAuthSessionSubscriptionTierSync(
          context.remoteAuthSessionContext,
        ),
      ) ??
      subscriptionManagedDefaultModel(provider) ??
      BUILT_IN_PROVIDER_DEFAULT_MODELS[provider]
    );
  }
  if (provider === "gemini") {
    return readProviderConfig(context.config, provider)?.default_model?.trim() ||
      BUILT_IN_PROVIDER_DEFAULT_MODELS[provider];
  }
  const settings = resolveProviderSettings(provider, context.config, context.env);
  return settings?.defaultModel ?? BUILT_IN_PROVIDER_DEFAULT_MODELS[provider];
}

function initialProvider(
  context: Pick<FirstRunOnboardingContext, "config">,
): BuiltInProviderSlug {
  return resolveBuiltInProviderSlug(context.config.model_provider) ?? "grok";
}

export function createInitialFirstRunOnboardingState(
  context: Pick<
    FirstRunOnboardingContext,
    "config" | "env" | "remoteAuthSessionContext"
  >,
): FirstRunOnboardingState {
  const provider = initialProvider(context);
  const configuredProvider =
    resolveBuiltInProviderSlug(context.config.model_provider) ?? provider;
  const model =
    configuredProvider === provider && context.config.model !== undefined
      ? context.config.model
      : providerDefaultModel(provider, context);
  return {
    currentStepId: "preflight",
    completedStepIds: [],
    selectedTheme:
      wizardThemeToSetting(context.config.tui?.theme ?? "dark") ??
      "dark",
    selectedProvider: provider,
    selectedModel: model,
    connection: null,
    pastedContents: [],
    pendingApiKeyApproval: null,
    modelAccessInput: "menu",
    authPrompt: null,
    error: null,
    isCheckingConnection: false,
    detectedLocalProviders: [],
  };
}


/**
 * Probe the well-known local runtimes (O-1, onboarding-plan-2026-07): a user
 * with Ollama or LM Studio already running has a credential-free path to a working
 * agent — the provider step must say so instead of walling them at the
 * model-access step. Short-timeout, parallel, never throws.
 */
export async function detectRunningLocalProviders(
  context: Pick<FirstRunOnboardingContext, "config" | "env" | "fetchImpl" | "checkLocalProviders">,
): Promise<readonly BuiltInProviderSlug[]> {
  if (context.checkLocalProviders === false) return [];
  const candidates = listBuiltInProviderInfo()
    .filter((provider) => provider.onboarding.access === "local")
    .map((provider) => provider.id);
  const results = await Promise.all(
    candidates.map(async (provider) => {
      const settings = resolveProviderSettings(provider, context.config, context.env);
      const baseURL = settings?.baseURL ?? BUILT_IN_PROVIDER_BASE_URLS[provider];
      const probe = await probeLocalProvider({
        provider,
        baseURL,
        ...(context.fetchImpl !== undefined ? { fetchImpl: context.fetchImpl } : {}),
        timeoutMs: 600,
      }).catch(() => ({ reachable: false, modelIds: null }));
      return probe.reachable ? provider : null;
    }),
  );
  return results.filter((p): p is BuiltInProviderSlug => p !== null);
}

function providerChoices(): readonly BuiltInProviderSlug[] {
  return Object.freeze(
    [...listBuiltInProviderInfo()]
      .sort((left, right) => left.onboarding.order - right.onboarding.order)
      .map((provider) => provider.id),
  );
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

function parseTheme(raw: string, current: ThemeSetting): ThemeSetting | null {
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
): BuiltInProviderSlug | null {
  const input = raw.trim().toLowerCase();
  if (input === "" || input === "next") return current;
  const choices = providerChoices();
  const index = Number(input);
  if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
    return choices[index - 1] ?? current;
  }
  const bySlug = resolveBuiltInProviderSlug(input);
  if (bySlug !== undefined) return bySlug;
  const byName = listBuiltInProviderInfo().find(
    (info) => info.name.toLowerCase() === input,
  );
  return byName?.id ?? null;
}

function invalidCommandError(raw: string, expected: string): string | null {
  return raw.trim().toLowerCase() === expected
    ? null
    : `Press Enter to continue, or type ${expected}.`;
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

function isConfigureLaterCommand(command: string): boolean {
  return (
    command === "" ||
    command === "4" ||
    command === "later" ||
    command === "next" ||
    command === "skip"
  );
}

function isAgenCAccountLoginCommand(command: string): boolean {
  return (
    command === "1" ||
    command === "account" ||
    command === "agenc" ||
    command === "agenc-login" ||
    command === "login"
  );
}

function isGrokOauthLoginCommand(command: string): boolean {
  return (
    command === "2" ||
    command === "grok-login" ||
    command === "x" ||
    command === "xai" ||
    command === "xai-login"
  );
}

function isApiKeyEntryCommand(command: string): boolean {
  return (
    command === "3" ||
    command === "api" ||
    command === "api-key" ||
    command === "key"
  );
}

function modelAccessSkipError(
  connection: ProviderConnectionCheck | null,
): string | null {
  if (connection?.canSkip !== false) return null;
  return (
    `${connection.credentialLabel ?? "A provider credential"} is required before continuing ` +
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

function defaultOnboardingCommand(
  state: FirstRunOnboardingState,
  raw: string,
): string {
  if (raw.trim() !== "") return raw;
  switch (state.currentStepId) {
    case "preflight":
    case "connection-test":
    case "security":
      return "next";
    case "terminal-setup":
      return "done";
    case "theme":
    case "provider":
      return raw;
    case "model-access":
      // Empty input intentionally means "continue without saving" on the
      // ordinary credential step. Never choose for the user once a verified
      // key is awaiting the explicit yes/no persistence decision.
      return state.pendingApiKeyApproval === null ? raw : "";
  }
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
  return "Onboarding is active. Press Enter to continue setup, or use /exit, Ctrl-C twice, or Ctrl-D twice to leave.";
}

function apiKeyVerificationErrorMessage(error: string | undefined): string {
  const base = error?.trim() || "API key verification failed.";
  return `${base} Press Enter to continue without saving, or paste a replacement key.`;
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
    credentialLabel: providerApiKeyEnvironmentLabel(provider),
    credentialProvenance: { kind: "verified-input" },
  };
}

function providerConnectionCredentialProvenanceLabel(
  provenance: ProviderConnectionCredentialProvenance | undefined,
): string | undefined {
  if (provenance === undefined) return undefined;
  if (provenance.kind === "oauth") return "xAI OAuth";
  if (provenance.kind === "verified-input") return "pasted API key";
  return provenance.fields.map((field) => field.envVar).join(" + ");
}

function authenticatedConnection(
  provider: BuiltInProviderSlug,
  model: string,
  detail: string,
): ProviderConnectionCheck {
  return {
    provider,
    model,
    status: "ready",
    ok: true,
    detail,
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
  const ingress = captureSecureStorageIngress(
    context.env ?? process.env,
    context.agencHome,
  );
  await new LocalAuthBackend({
    agencHome: ingress.home.path,
    env: ingress.environment,
  }).saveByokKey({ provider, apiKey });
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

async function probeLocalProvider(params: {
  readonly provider: BuiltInProviderSlug;
  readonly baseURL: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<{
  readonly reachable: boolean;
  readonly modelIds: readonly string[] | null;
}> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (fetchImpl === undefined) return { reachable: false, modelIds: null };
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
    if (!response.ok) return { reachable: false, modelIds: null };
    const payload: unknown = await readLocalProviderCatalog(response).catch(
      () => null,
    );
    return {
      reachable: true,
      modelIds: localProviderModelIds(params.provider, payload),
    };
  } catch {
    return { reachable: false, modelIds: null };
  } finally {
    clearTimeout(timer);
  }
}

const LOCAL_PROVIDER_CATALOG_MAX_BYTES = 1024 * 1024;

async function readLocalProviderCatalog(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > LOCAL_PROVIDER_CATALOG_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(
          `Local provider model catalog exceeds ${LOCAL_PROVIDER_CATALOG_MAX_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be closed after cancellation.
    }
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

function localProviderModelIds(
  provider: BuiltInProviderSlug,
  payload: unknown,
): readonly string[] | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const entries = provider === "ollama" ? record.models : record.data;
  if (!Array.isArray(entries)) return null;
  const ids = entries.flatMap((entry): string[] => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const model = entry as Record<string, unknown>;
    const candidates = provider === "ollama"
      ? [model.name, model.model]
      : [model.id];
    return candidates.filter(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.trim().length > 0,
    );
  });
  return [...new Set(ids)];
}

function hasLocalProviderModel(
  provider: BuiltInProviderSlug,
  modelIds: readonly string[],
  selectedModel: string,
): boolean {
  const selected = selectedModel.trim();
  if (provider !== "ollama") return modelIds.includes(selected);
  const withoutLatestTag = (model: string): string =>
    model.trim().replace(/:latest$/u, "");
  const normalizedSelected = withoutLatestTag(selected);
  return modelIds.some(
    (modelId) => withoutLatestTag(modelId) === normalizedSelected,
  );
}

function geminiCredentialLabel(plan: GeminiCredentialPlan): string {
  if (plan.kind === "api-key") {
    return "GEMINI_API_KEY or GOOGLE_API_KEY";
  }
  if (plan.kind === "access-token") return plan.source;
  if (plan.kind === "adc") {
    return plan.source === "GOOGLE_APPLICATION_CREDENTIALS"
      ? "GOOGLE_APPLICATION_CREDENTIALS"
      : "well-known Google ADC credentials";
  }
  if (plan.expected === "access-token") return "GEMINI_ACCESS_TOKEN";
  if (plan.expected === "adc") {
    return plan.configuredPath === undefined
      ? "Google ADC credentials"
      : `an existing ADC credential file at ${plan.configuredPath}`;
  }
  if (plan.expected === "api-key") {
    return "GEMINI_API_KEY or GOOGLE_API_KEY (or a saved Gemini BYOK key)";
  }
  return "a Gemini API key, GEMINI_ACCESS_TOKEN, or Google ADC credentials";
}

function configuredGeminiCredentialLabel(environment: NodeJS.ProcessEnv): string {
  try {
    const mode = getGeminiAuthMode(environment);
    if (mode === "access-token") return "GEMINI_ACCESS_TOKEN";
    if (mode === "adc") return "Google ADC credentials";
    if (mode === "api-key") {
      return "GEMINI_API_KEY or GOOGLE_API_KEY (or a saved Gemini BYOK key)";
    }
  } catch {
    // The canonical resolver returns the invalid-mode detail to the caller.
  }
  return "Gemini credential and endpoint configuration";
}

function geminiCredentialSourceLabel(
  plan: Exclude<GeminiCredentialPlan, { kind: "none" | "adc" }>,
): string {
  return plan.kind === "api-key" && plan.source === "saved-byok"
    ? "saved Gemini BYOK"
    : plan.source;
}

function resolveOnboardingGeminiCredentialPlan(
  context: FirstRunOnboardingContext,
): GeminiCredentialPlan {
  const ingress = captureSecureStorageIngress(
    context.env ?? process.env,
    context.agencHome,
  );
  return resolveGeminiCredentialPlan(ingress.environment, {
    savedApiKey: readLocalByokCredential(ingress.home, "gemini")?.apiKey,
  });
}

export async function checkOnboardingProviderConnection(
  context: FirstRunOnboardingContext,
  provider: BuiltInProviderSlug,
  model: string,
): Promise<ProviderConnectionCheck> {
  const ingress = captureSecureStorageIngress(
    context.env ?? process.env,
    context.agencHome,
  );
  const environment = ingress.environment;
  const runtimeRequest = resolveProviderRuntimeRequest({
    provider,
    model,
    config: context.config,
    environment,
    credentialHome: ingress.home,
  });
  let authority: Awaited<ReturnType<typeof resolveProviderRuntimeAuthority>>;
  try {
    authority = await resolveProviderRuntimeAuthority(
      provider,
      runtimeRequest.requested,
      environment,
      {
        readSavedApiKey: async (candidateProvider) =>
          readLocalByokCredential(ingress.home, candidateProvider)?.apiKey,
      },
    );
  } catch (error) {
    return {
      provider,
      model,
      status: "credentials-required",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      credentialLabel:
        providerCredentialEnvironmentLabel(provider) ?? "provider credentials",
    };
  }
  let geminiRuntime: ReturnType<typeof readGeminiRuntimeOptions> = undefined;
  if (provider === "gemini") {
    geminiRuntime = readGeminiRuntimeOptions(authority.factoryOptions.extra);
    if (geminiRuntime === undefined) {
      return {
        provider,
        model,
        status: "credentials-required",
        ok: false,
        detail: "Gemini runtime authority was not resolved",
        credentialLabel: configuredGeminiCredentialLabel(environment),
      };
    }
  }
  const baseURL = geminiRuntime === undefined
    ? authority.factoryOptions.baseURL ?? BUILT_IN_PROVIDER_BASE_URLS[provider]
    : geminiEndpointFor(geminiRuntime.endpointPlan);
  const credentialLabel = provider === "gemini"
    ? geminiCredentialLabel(geminiRuntime!.credentialPlan)
    : providerCredentialEnvironmentLabel(provider) ??
      (authority.credential.status === "missing"
        ? authority.credential.missingLabel
        : undefined);
  const credentialProvenance = "provenance" in authority.credential
    ? authority.credential.provenance
    : undefined;
  const onboarding = providerOnboardingInfo(provider);

  if (onboarding.access === "managed") {
    return {
      provider,
      model,
      status: "credentials-required",
      ok: false,
      detail: "Hosted AgenC requires account auth; choose a BYOK provider for this first-run path.",
    };
  }

  if (onboarding.access === "local") {
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
    const probe = await probeLocalProvider({
      provider,
      baseURL,
      fetchImpl: context.fetchImpl,
    });
    if (!probe.reachable) {
      return {
        provider,
        model,
        status: "local-down",
        ok: false,
        detail: "Local provider endpoint did not respond; start it before the first model turn.",
        baseURL,
      };
    }
    if (probe.modelIds === null) {
      return {
        provider,
        model,
        status: "local-down",
        ok: false,
        detail: "Local provider endpoint did not return a readable model catalog.",
        baseURL,
      };
    }
    if (!hasLocalProviderModel(provider, probe.modelIds, model)) {
      return {
        provider,
        model,
        status: "local-model-missing",
        ok: false,
        detail:
          provider === "ollama"
            ? `Selected model ${model} is not installed in Ollama; run \`ollama pull ${model}\` before the first model turn.`
            : `Selected model ${model} is not listed by the local provider; load it before the first model turn.`,
        baseURL,
      };
    }
    return {
      provider,
      model,
      status: "ready",
      ok: true,
      detail: `Local provider endpoint is reachable and model ${model} is available.`,
      baseURL,
    };
  }

  if (onboarding.access === "environment") {
    if (
      authority.credential.status !== "ready" &&
      authority.credential.status !== "missing"
    ) {
      return {
        provider,
        model,
        status: "credentials-required",
        ok: false,
        detail: "Provider credential metadata is unavailable.",
        ...(credentialLabel !== undefined ? { credentialLabel } : {}),
        baseURL,
      };
    }
    if (authority.credential.status === "missing") {
      return {
        provider,
        model,
        status: "credentials-required",
        ok: false,
        detail: `Set ${authority.credential.missingLabel} before the first model turn.`,
        ...(credentialLabel !== undefined ? { credentialLabel } : {}),
        ...(credentialProvenance !== undefined
          ? { credentialProvenance }
          : {}),
        baseURL,
      };
    }
    return {
      provider,
      model,
      status: "ready",
      ok: true,
      detail:
        "Required AWS SigV4 credential fields are present. AgenC will verify them on the first signed Bedrock request.",
      ...(credentialLabel !== undefined ? { credentialLabel } : {}),
      ...(credentialProvenance !== undefined
        ? { credentialProvenance }
        : {}),
      baseURL,
    };
  }

  if (provider === "gemini") {
    const credentialPlan = geminiRuntime!.credentialPlan;
    if (credentialPlan.kind === "none") {
      return {
        provider,
        model,
        status: "credentials-required",
        ok: false,
        detail: `Set ${credentialLabel} before the first model turn, or continue and add it later.`,
        credentialLabel,
        baseURL,
      };
    }
    if (credentialPlan.kind === "adc") {
      return {
        provider,
        model,
        status: "ready",
        ok: true,
        detail:
          `Google ADC credential file selected via ${credentialPlan.source}. ` +
          "AgenC will exchange and refresh its access token on model requests.",
        credentialLabel,
        baseURL,
      };
    }
    const remote = await verifyPreparedProviderConnection({
      provider,
      factoryOptions: authority.factoryOptions,
      environment,
      ...(context.fetchImpl !== undefined
        ? { fetchImpl: context.fetchImpl }
        : {}),
    });
    if (remote.status !== "valid") {
      const authFailed = remote.status === "invalid";
      return {
        provider,
        model,
        status: authFailed ? "auth-failed" : "provider-unreachable",
        ok: false,
        detail: authFailed
          ? `Provider rejected ${geminiCredentialSourceLabel(credentialPlan)}.`
          : "Provider readiness check did not complete; verify network access and retry.",
        credentialLabel,
        ...(credentialProvenance !== undefined
          ? { credentialProvenance }
          : {}),
        baseURL,
      };
    }
    return {
      provider,
      model,
      status: "ready",
      ok: true,
      detail: `Gemini credential found via ${geminiCredentialSourceLabel(credentialPlan)}.`,
      credentialLabel,
      ...(credentialProvenance !== undefined ? { credentialProvenance } : {}),
      baseURL,
    };
  }

  if (
    onboarding.supportsManagedKeyAccess &&
    authority.credential.status === "missing" &&
    resolveAuthManagedKeysEnabled(context.config) &&
    context.remoteAuthSessionContext !== undefined &&
    hasRemoteAuthSessionSync(context.remoteAuthSessionContext)
  ) {
    const tier =
      remoteAuthSessionSubscriptionTierSync(
        context.remoteAuthSessionContext,
      ) ?? "unknown";
    if (
      tier === "free" &&
      isFreeSubscriptionManagedModel(provider, model)
    ) {
      return {
        provider,
        model,
        status: "ready",
        ok: true,
        detail: "AgenC account is signed in. Free hosted model access is ready.",
        baseURL,
      };
    }
    if (!hasEntitledRemoteAuthSessionSync(context.remoteAuthSessionContext)) {
      const keyLabel = credentialLabel ?? "a BYOK API key";
      return {
        provider,
        model,
        status: "credentials-required",
        ok: false,
        detail:
          `AgenC account is signed in on the ${tier} plan. ` +
          `Managed provider keys require an active AgenC subscription; paste ${keyLabel} to continue.`,
        ...(credentialLabel !== undefined ? { credentialLabel } : {}),
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

  const apiKey = authority.factoryOptions.apiKey?.trim();
  const authToken = authority.factoryOptions.authToken?.trim();
  if (
    authority.credential.status === "ready" &&
    authority.credential.mode === "openai-oauth"
  ) {
    return {
      provider,
      model,
      status: "ready",
      ok: true,
      detail:
        "OpenAI sign-in is configured. AgenC will verify it on the first model request.",
      ...(credentialLabel !== undefined ? { credentialLabel } : {}),
      baseURL,
    };
  }
  const preparedCredential = apiKey || authToken;
  if (preparedCredential !== undefined && preparedCredential.length > 0) {
    if (
      provider === "grok" &&
      authority.credential.status === "ready" &&
      authority.credential.mode === "xai-oauth" &&
      !isTrustedXaiOauthInferenceBaseUrl(baseURL)
    ) {
      return {
        provider,
        model,
        status: "auth-failed",
        ok: false,
        detail:
          "Refusing to send the stored xAI OAuth credential to a custom Grok base URL.",
        ...(credentialLabel !== undefined ? { credentialLabel } : {}),
        credentialProvenance,
        baseURL,
      };
    }
    const remote = await verifyPreparedProviderConnection({
      provider,
      factoryOptions: authority.factoryOptions,
      environment,
      ...(context.fetchImpl !== undefined
        ? { fetchImpl: context.fetchImpl }
        : {}),
    });
    if (remote.status !== "valid") {
      const authFailed = remote.status === "invalid";
      return {
        provider,
        model,
        status: authFailed ? "auth-failed" : "provider-unreachable",
        ok: false,
        detail: authFailed
          ? `Provider rejected ${providerConnectionCredentialProvenanceLabel(credentialProvenance) ?? "the configured API key"}.`
          : "Provider readiness check did not complete; verify network access and retry.",
        ...(credentialLabel !== undefined ? { credentialLabel } : {}),
        ...(credentialProvenance !== undefined
          ? { credentialProvenance }
          : {}),
        baseURL,
      };
    }
    return {
      provider,
      model,
      status: "ready",
      ok: true,
      detail: credentialProvenance === undefined
        ? "Provider credential found."
        : `Provider credential found via ${providerConnectionCredentialProvenanceLabel(credentialProvenance)}.`,
      ...(credentialLabel !== undefined ? { credentialLabel } : {}),
      ...(credentialProvenance !== undefined ? { credentialProvenance } : {}),
      baseURL,
    };
  }

  return {
    provider,
    model,
    status: "credentials-required",
    ok: false,
    detail: `Set ${credentialLabel ?? "the provider API key"} before the first model turn, or continue and add it later.`,
    ...(credentialLabel !== undefined ? { credentialLabel } : {}),
    baseURL,
  };
}

export async function submitFirstRunOnboardingInput(
  state: FirstRunOnboardingState,
  rawInput: string,
  context: FirstRunOnboardingContext,
): Promise<FirstRunOnboardingSubmitResult> {
  const raw = defaultOnboardingCommand(
    state,
    normalizeOnboardingCommand(rawInput),
  );
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
          state: {
            ...state,
            error: `Choose a theme number or one of: ${THEME_CHOICES.join(", ")}.`,
          },
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
      const provider = parseProvider(raw, state.selectedProvider);
      if (provider === null) {
        return {
          state: { ...state, error: "Choose a provider number or slug." },
          completed: false,
        };
      }
      const selectedModel = provider === state.selectedProvider
        ? state.selectedModel
        : providerDefaultModel(provider, context);
      return {
        state: withCompletedStep(
          {
            ...state,
            selectedProvider: provider,
            selectedModel,
            connection: null,
            pastedContents: [],
            pendingApiKeyApproval: null,
            modelAccessInput: "menu",
            authPrompt: null,
          },
          "provider",
          "model-access",
        ),
        completed: false,
      };
    }
    case "connection-test": {
      const command = raw.trim().toLowerCase();
      if (command !== "next" && command !== "test") {
        return {
          state: {
            ...state,
            error: "Press Enter to run the connection check, or type test.",
          },
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
    case "model-access":
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
              "model-access",
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
            ["model-access", "connection-test"],
            "security",
          ),
          completed: false,
        };
      }
      {
        const command = lowerCommand(raw);
        if (isAgenCAccountLoginCommand(command)) {
          const runLogin =
            context.runAgenCAccountLogin ??
            (() => defaultRunAgenCAccountLogin(context));
          const result = await runLogin();
          if (!result.ok) {
            return {
              state: {
                ...state,
                authPrompt: null,
                error: result.message,
              },
              completed: false,
            };
          }
          if (!resolveAuthManagedKeysEnabled(context.config)) {
            return {
              state: {
                ...state,
                authPrompt: null,
                error:
                  `Signed in as ${result.accountLabel}, but hosted model access ` +
                  "is disabled in this AgenC configuration. Choose an API key " +
                  "or configure model access later.",
              },
              completed: false,
            };
          }
          const hostedProvider = resolveBuiltInProviderSlug(
            SUBSCRIPTION_MANAGED_DEFAULT_PROVIDER,
          );
          const hostedModel =
            hostedProvider === undefined
              ? undefined
              : subscriptionManagedDefaultModelForTier(
                  hostedProvider,
                  result.subscriptionTier,
                );
          if (hostedProvider === undefined || hostedModel === undefined) {
            return {
              state: {
                ...state,
                authPrompt: null,
                error:
                  `Signed in as ${result.accountLabel}, but no hosted model is ` +
                  `available for the ${result.subscriptionTier} plan. ` +
                  "Choose another access method or configure model access later.",
              },
              completed: false,
            };
          }
          const accessDetail =
            result.subscriptionTier === "free"
              ? `Signed in to AgenC as ${result.accountLabel}. Free hosted model access is ready.`
              : `Signed in to AgenC as ${result.accountLabel}. Hosted model access for the ${result.subscriptionTier} plan is ready.`;
          return {
            state: withCompletedSteps(
              {
                ...state,
                selectedProvider: hostedProvider,
                selectedModel: hostedModel,
                connection: authenticatedConnection(
                  hostedProvider,
                  hostedModel,
                  accessDetail,
                ),
                modelAccessInput: "menu",
                authPrompt: null,
              },
              ["model-access", "connection-test"],
              "security",
            ),
            completed: false,
          };
        }
        if (isGrokOauthLoginCommand(command)) {
          const runLogin =
            context.runGrokOauthLogin ??
            (() => defaultRunGrokOauthLogin(context));
          const result = await runLogin();
          if (!result.ok) {
            return {
              state: {
                ...state,
                authPrompt: null,
                error: result.message,
              },
              completed: false,
            };
          }
          const provider: BuiltInProviderSlug = "grok";
          const model = providerDefaultModel(provider, context);
          return {
            state: withCompletedSteps(
              {
                ...state,
                selectedProvider: provider,
                selectedModel: model,
                connection: authenticatedConnection(
                  provider,
                  model,
                  `Signed in to X / xAI as ${result.accountLabel}. Grok subscription access is ready.`,
                ),
                modelAccessInput: "menu",
                authPrompt: null,
              },
              ["model-access", "connection-test"],
              "security",
            ),
            completed: false,
          };
        }
        if (isApiKeyEntryCommand(command)) {
          const access = providerOnboardingInfo(state.selectedProvider).access;
          if (state.selectedProvider === "gemini") {
            const plan = resolveOnboardingGeminiCredentialPlan(context);
            if (plan.kind !== "none") {
              return {
                state: withCompletedStep(
                  {
                    ...state,
                    modelAccessInput: "menu",
                    authPrompt: null,
                    error: null,
                  },
                  "model-access",
                  "connection-test",
                ),
                completed: false,
              };
            }
            if (plan.expected === "access-token" || plan.expected === "adc") {
              return {
                state: {
                  ...state,
                  modelAccessInput: "menu",
                  authPrompt: null,
                  error:
                    `Set ${geminiCredentialLabel(plan)}. A pasted API key ` +
                    `cannot override GEMINI_AUTH_MODE=${plan.mode}.`,
                },
                completed: false,
              };
            }
          }
          if (access === "environment") {
            return {
              state: {
                ...state,
                modelAccessInput: "menu",
                authPrompt: null,
                error:
                  `Amazon Bedrock uses AWS SigV4 credentials. Set ${providerCredentialEnvironmentLabel(state.selectedProvider) ?? "the required AWS credential fields"}; one-field API-key storage is not supported.`,
              },
              completed: false,
            };
          }
          if (access !== "api-key") {
            return {
              state: withCompletedStep(
                {
                  ...state,
                  modelAccessInput: "menu",
                  authPrompt: null,
                },
                "model-access",
                "connection-test",
              ),
              completed: false,
            };
          }
          return {
            state: {
              ...state,
              modelAccessInput: "api-key",
              authPrompt: null,
              error: null,
            },
            completed: false,
          };
        }
        if (command === "back" && state.modelAccessInput === "api-key") {
          return {
            state: {
              ...state,
              modelAccessInput: "menu",
              authPrompt: null,
              error: null,
            },
            completed: false,
          };
        }
        if (isConfigureLaterCommand(command)) {
          const skipError = modelAccessSkipError(state.connection);
          if (skipError !== null) {
            return {
              state: { ...state, error: skipError },
              completed: false,
            };
          }
          return {
            state: withCompletedStep(
              {
                ...state,
                modelAccessInput: "menu",
                authPrompt: null,
              },
              "model-access",
              "connection-test",
            ),
            completed: false,
          };
        }
        if (
          providerOnboardingInfo(state.selectedProvider).access ===
            "environment"
        ) {
          return {
            state: {
              ...state,
              modelAccessInput: "menu",
              authPrompt: null,
              error:
                `Amazon Bedrock uses AWS SigV4 credentials. Set ${providerCredentialEnvironmentLabel(state.selectedProvider) ?? "the required AWS credential fields"}; pasted one-field API keys cannot configure it.`,
            },
            completed: false,
          };
        }
        if (state.selectedProvider === "gemini") {
          const ingress = captureSecureStorageIngress(
            context.env ?? process.env,
            context.agencHome,
          );
          const authMode = getGeminiAuthMode(ingress.environment);
          if (authMode === "access-token" || authMode === "adc") {
            return {
              state: {
                ...state,
                modelAccessInput: "menu",
                authPrompt: null,
                error:
                  `A pasted API key cannot override GEMINI_AUTH_MODE=${authMode}. ` +
                  `Set ${authMode === "access-token" ? "GEMINI_ACCESS_TOKEN" : "Google ADC credentials"}.`,
              },
              completed: false,
            };
          }
        }
        const apiKey = normalizeApiKeyEntry(raw);
        if (apiKey.length === 0 || /\s/.test(apiKey)) {
          return {
            state: {
              ...state,
              error:
                "Press Enter to continue without saving, or paste a single API key without whitespace.",
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
            state: {
              ...state,
              error: "Press Enter to finish onboarding, or type done.",
            },
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
    if (!active) return;
    let cancelled = false;
    void detectRunningLocalProviders(options).then((detected) => {
      if (cancelled || detected.length === 0) return;
      const next = { ...stateRef.current, detectedLocalProviders: detected };
      stateRef.current = next;
      setState(next);
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
      // Keep the ref authoritative for async submissions. Mirroring React
      // state back into it from a passive effect lets an older committed
      // render overwrite a newer transition when input arrives quickly.
      const checkingState = {
        ...stateRef.current,
        authPrompt: null,
        error: null,
        isCheckingConnection: true,
      };
      stateRef.current = checkingState;
      setState(checkingState);
      try {
        const submitContext: FirstRunOnboardingContext = {
          ...options,
          onAuthPrompt: (prompt) => {
            const promptState = {
              ...stateRef.current,
              authPrompt: prompt,
              error: null,
            };
            stateRef.current = promptState;
            setState(promptState);
            options.onAuthPrompt?.(prompt);
          },
        };
        let result: FirstRunOnboardingSubmitResult;
        try {
          result = await submitFirstRunOnboardingInput(
            checkingState,
            input,
            submitContext,
          );
        } catch (error) {
          const failedState = {
            ...stateRef.current,
            authPrompt: null,
            error: error instanceof Error ? error.message : String(error),
            isCheckingConnection: false,
          };
          stateRef.current = failedState;
          setState(failedState);
          return true;
        }
        const nextState = {
          ...result.state,
          detectedLocalProviders: stateRef.current.detectedLocalProviders,
          isCheckingConnection: false,
        };
        stateRef.current = nextState;
        setState(nextState);
        if (result.completed) {
          await options.onComplete?.(nextState);
          if (options.agencHome !== undefined) {
            markFirstRunOnboardingComplete({
              agencHome: options.agencHome,
              selectedProvider: nextState.selectedProvider,
              selectedModel: nextState.selectedModel,
              selectedTheme: nextState.selectedTheme,
              completedStepIds: nextState.completedStepIds,
            });
          }
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

function credentialInstructionForConnection(
  connection: ProviderConnectionCheck | null,
): string {
  if (connection === null) {
    return "Paste an API key to verify it, or press Enter to continue without saving.";
  }
  if (connection.status === "ready") {
    if (
      connection.credentialProvenance?.kind === "environment" &&
      connection.credentialProvenance.fields.some(
        (field) => field.role === "accessKeyId",
      )
    ) {
      return "AWS SigV4 credential fields are present. AgenC will verify them on the first signed Bedrock request.";
    }
    const source = providerConnectionCredentialProvenanceLabel(
      connection.credentialProvenance,
    );
    if (source !== undefined) {
      return `${source} is present and verified. Press Enter to continue, or paste a replacement key.`;
    }
    return "Provider credential is verified. Press Enter to continue, or paste a replacement key.";
  }
  if (connection.credentialLabel === undefined) {
    return "Paste an API key to verify it, or press Enter to continue.";
  }
  if (connection.canSkip === false) {
    return `Paste ${connection.credentialLabel} to verify it before continuing.`;
  }
  if (
    connection.status === "auth-failed" ||
    connection.status === "provider-unreachable"
  ) {
    const source = providerConnectionCredentialProvenanceLabel(
      connection.credentialProvenance,
    ) ?? connection.credentialLabel;
    return `${source} did not verify. Press Enter to continue without saving, or paste a replacement key.`;
  }
  return `Paste ${connection.credentialLabel} to verify it, or press Enter to add it later.`;
}

function modelAccessInstructionForProvider(
  provider: BuiltInProviderSlug,
  geminiPlan?: GeminiCredentialPlan,
): string {
  if (provider === "gemini" && geminiPlan !== undefined) {
    if (geminiPlan.kind !== "none") {
      return `${geminiCredentialLabel(geminiPlan)} is configured. Press Enter to use it, or type back to choose another access method.`;
    }
    if (geminiPlan.expected === "access-token" || geminiPlan.expected === "adc") {
      return `Set ${geminiCredentialLabel(geminiPlan)}, then press Enter to continue. A pasted API key cannot override GEMINI_AUTH_MODE=${geminiPlan.mode}.`;
    }
    return `Paste ${geminiCredentialLabel(geminiPlan)} to verify it, or press Enter to add it later.`;
  }
  const credentialLabel = providerApiKeyEnvironmentLabel(provider);
  const onboarding = providerOnboardingInfo(provider);
  if (onboarding.access === "managed") {
    return "This provider requires AgenC account auth. Choose the account sign-in option to continue.";
  }
  if (onboarding.access !== "api-key") {
    if (onboarding.access === "environment") {
      return `Set ${providerCredentialEnvironmentLabel(provider) ?? "the required provider credential fields"} in the environment, then press Enter to continue.`;
    }
    return "This provider can continue without a BYOK API key. Press Enter to continue.";
  }
  if (credentialLabel === undefined) {
    return "Paste an API key to verify it, or press Enter to add it later.";
  }
  return `Paste ${credentialLabel} to verify it, or press Enter to add it later.`;
}

function securityLinesForContext(
  context: FirstRunOnboardingContext,
): readonly string[] {
  if (context.permissionMode === "bypassPermissions") {
    return [
      "Permission mode: bypassPermissions (--dangerously-bypass-approvals-and-sandbox skips tool approval prompts).",
      "Sandbox: danger-full-access (--dangerously-bypass-approvals-and-sandbox disables workspace sandboxing for this session).",
      "Press Enter to continue with --dangerously-bypass-approvals-and-sandbox, or restart without --dangerously-bypass-approvals-and-sandbox for prompts and sandboxing.",
    ];
  }
  return [
    `Permission mode: ${context.permissionMode ?? "default"}`,
    `Sandbox: ${context.sandboxMode ?? "workspace-write"}`,
    "Press Enter to keep these defaults.",
  ];
}

export interface FirstRunOnboardingInputPresentation {
  readonly placeholder: string;
  readonly footerHint: string;
  readonly allowEmptySubmit: boolean;
}

export function firstRunOnboardingInputPresentation(
  state: FirstRunOnboardingState,
): FirstRunOnboardingInputPresentation {
  const standardFooter =
    "Enter confirms the shown default · type a listed choice to change it · /exit leaves setup";
  switch (state.currentStepId) {
    case "preflight":
      return {
        placeholder: "Press Enter to start setup",
        footerHint: standardFooter,
        allowEmptySubmit: true,
      };
    case "theme":
      return {
        placeholder: `Press Enter to keep ${state.selectedTheme}, or type 1–${THEME_CHOICES.length}`,
        footerHint: standardFooter,
        allowEmptySubmit: true,
      };
    case "provider":
      return {
        placeholder: `Press Enter to keep ${state.selectedProvider}, or type a provider number`,
        footerHint: standardFooter,
        allowEmptySubmit: true,
      };
    case "model-access":
      if (state.pendingApiKeyApproval !== null) {
        return {
          placeholder: "Type yes to save this key, or no to discard it",
          footerHint:
            "Saving a verified key always requires an explicit yes · /exit leaves setup",
          allowEmptySubmit: false,
        };
      }
      if (state.modelAccessInput === "api-key") {
        const credentialLabel =
          providerApiKeyEnvironmentLabel(state.selectedProvider) ?? "API key";
        return {
          placeholder: `Paste ${credentialLabel}, type back, or press Enter to configure later`,
          footerHint:
            "Keys are verified before an explicit save confirmation · /exit leaves setup",
          allowEmptySubmit: true,
        };
      }
      return {
        placeholder: "Choose 1–4, or paste a provider API key directly",
        footerHint:
          "No slash commands needed · Enter chooses Configure later · /exit leaves setup",
        allowEmptySubmit: true,
      };
    case "connection-test":
      return {
        placeholder: `Press Enter to test ${state.selectedProvider}`,
        footerHint: standardFooter,
        allowEmptySubmit: true,
      };
    case "security":
      return {
        placeholder: "Press Enter to keep these security defaults",
        footerHint: standardFooter,
        allowEmptySubmit: true,
      };
    case "terminal-setup":
      return {
        placeholder: "Press Enter to finish onboarding",
        footerHint: standardFooter,
        allowEmptySubmit: true,
      };
  }
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
          ? ["--dangerously-bypass-approvals-and-sandbox is active: tool approvals and workspace sandboxing are bypassed for this session."]
          : []),
        "Onboarding input only. Use /exit, Ctrl-C twice, or Ctrl-D twice to leave.",
        "Press Enter to continue (or type next).",
      ];
    case "theme": {
      // The TUI colours text but does NOT repaint the terminal's own
      // background, so a light theme on a dark terminal (or vice versa) reads
      // as grey-on-black. The terminal background is already detected for the
      // 'auto' mode (COLORFGBG seed + OSC 11 watcher) — surface it here so the
      // user picks with that context instead of discovering the mismatch.
      const terminalBackground = getTerminalBackground();
      // Only give a directional recommendation when the background was actually
      // measured. Most terminals don't export $COLORFGBG, so an unmeasured value
      // is a guessed `dark` — asserting "your terminal looks dark" there is the
      // exact inverted advice this tip was added to prevent (M-ONB-2).
      const themeTip = isTerminalBackgroundDetected()
        ? `Tip: your terminal background looks ${terminalBackground} — ${
            terminalBackground === "light" ? '"light" or "auto"' : '"dark" or "auto"'
          } will read best here.`
        : `Tip: couldn't detect your terminal background — if it's light, pick "light" or "auto"; if dark, "dark" or "auto".`;
      return [
        ...THEME_CHOICES.map((theme, index) =>
          `${index + 1}. ${theme}${theme === state.selectedTheme ? " (current)" : ""}`
        ),
        themeTip,
        `Press Enter to keep ${state.selectedTheme}, or type a number or theme name.`,
      ];
    }
    case "provider": {
      const detected = new Set(state.detectedLocalProviders);
      return [
        ...providerChoices().map((provider, index) =>
          `${index + 1}. ${provider}${provider === state.selectedProvider ? " (current)" : ""}${detected.has(provider) ? " — detected, running locally, no key needed" : ""}`
        ),
        ...(detected.size > 0
          ? [
              `Tip: ${[...detected][0]} is already running on this machine — pick it for a zero-key start.`,
            ]
          : []),
        `Press Enter to keep ${state.selectedProvider}, or type a number or provider slug.`,
      ];
    }
    case "connection-test":
      return state.isCheckingConnection
        ? ["Checking provider readiness..."]
        : [
            `Provider: ${state.selectedProvider}`,
            `Model: ${state.selectedModel}`,
            "Press Enter to run the connection check (or type test).",
          ];
    case "model-access": {
      const geminiPlan = state.selectedProvider === "gemini"
        ? resolveOnboardingGeminiCredentialPlan(context)
        : undefined;
      if (state.pendingApiKeyApproval !== null) {
        return [];
      }
      if (state.authPrompt !== null) {
        return [
          state.authPrompt.heading,
          state.authPrompt.detail,
          ...(state.authPrompt.userCode !== undefined
            ? [`Code: ${state.authPrompt.userCode}`]
            : []),
          `URL: ${state.authPrompt.url}`,
          "Finish sign-in in your browser; AgenC will continue automatically.",
        ];
      }
      if (state.modelAccessInput === "menu") {
        const credentialLabel =
          providerApiKeyEnvironmentLabel(state.selectedProvider);
        const billingProvider =
          state.selectedProvider === "grok" ? "xAI" : state.selectedProvider;
        const onboarding = providerOnboardingInfo(state.selectedProvider);
        const providerAccess = state.selectedProvider === "gemini" &&
            geminiPlan !== undefined
          ? geminiPlan.kind === "none"
            ? geminiPlan.expected === "access-token" || geminiPlan.expected === "adc"
              ? `Use Gemini with ${geminiCredentialLabel(geminiPlan)}. A one-field BYOK key cannot override GEMINI_AUTH_MODE=${geminiPlan.mode}.`
              : `Use Gemini with ${geminiCredentialLabel(geminiPlan)}.`
            : `Use Gemini with configured ${geminiCredentialLabel(geminiPlan)}.`
          : onboarding.access === "managed"
          ? `Use ${state.selectedProvider} through AgenC account auth.`
          : onboarding.access === "api-key"
            ? `Use ${credentialLabel ?? `a ${state.selectedProvider} API key`} — requests are billed by ${billingProvider}.`
            : onboarding.access === "environment"
              ? `Use ${state.selectedProvider} with ${providerCredentialEnvironmentLabel(state.selectedProvider) ?? "its required environment credentials"} — one-field API-key storage is not supported.`
            : `Use ${state.selectedProvider} directly — no account sign-in or provider API key required.`;
        return [
          `Provider: ${state.selectedProvider}`,
          `Model: ${state.selectedModel}`,
          "1. Sign in or create an AgenC account — use hosted models; free accounts get the free-model catalog.",
          "2. Sign in with X / xAI — use Grok through an eligible X or xAI subscription.",
          `3. ${providerAccess}`,
          "4. Configure later — continue without signing in or saving a key.",
          ...(geminiPlan?.kind === "none" &&
            (geminiPlan.expected === "access-token" ||
              geminiPlan.expected === "adc")
            ? ["Choose a number. Configure the forced Gemini credential source before testing."]
            : ["Choose a number. You can also paste a provider API key directly."]),
        ];
      }
      const connection = state.connection;
      if (connection === null) {
        return [
          `Provider: ${state.selectedProvider}`,
          modelAccessInstructionForProvider(state.selectedProvider, geminiPlan),
          "Type back to choose a different access method.",
        ];
      }
      return [
        connection.detail,
        credentialInstructionForConnection(connection),
        "Type back to choose a different access method.",
        ...(state.pastedContents.length > 0
          ? [`Captured ${state.pastedContents.length} large paste privately.`]
          : []),
      ];
    }
    case "security":
      return [
        ...(state.connection?.ok === true
          ? [`Model access: ${state.connection.detail}`]
          : []),
        ...securityLinesForContext(context),
      ];
    case "terminal-setup":
      return [
        `Terminal: ${context.terminalName ?? "terminal"}`,
        "Press Enter to finish onboarding (or type done).",
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
  if (
    /^(Choose |Finish |Onboarding input only|Or type |Press Enter|Tip:|Type )/u.test(
      line,
    )
  ) {
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
    // instructions ("Press Enter…") from the data/choices above them.
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
    state.currentStepId === "model-access" &&
    state.pendingApiKeyApproval !== null;

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
