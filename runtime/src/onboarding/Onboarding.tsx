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
import type { HomeContext } from "../config/home.js";
import { buildProviderModelCatalog } from "../config/provider-model-authority.js";
import { hasSavedProviderKey } from "../auth/provider-keys.js";
import {
  isSignInProvider,
  signedInAccount,
  type SignInProvider,
} from "../auth/provider-sign-in-accounts.js";
import {
  createAuthBackend,
  resolveAuthManagedKeysEnabled,
} from "../auth/selection.js";
import { accountDefaultModel, readAccountModelAccess } from "../auth/account-access.js";
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
  providerLocalModelIdFromCatalog,
  resolveBuiltInProviderInfo,
  resolveBuiltInProviderSlug,
  type BuiltInProviderOnboardingInfo,
  type BuiltInProviderSlug,
} from "../llm/registry/provider-info.js";
import {
  canonicalProviderApiKeyEnvVar,
  missingProviderCredentialEnvironmentLabel,
  resolveProviderApiKeyEnvironment,
  type ProviderCredentialProvenance,
} from "../llm/registry/provider-ingress.js";
import { isTrustedXaiOauthInferenceBaseUrl } from "../services/xai/oauth.js";
import { LocalAuthBackend } from "../auth/backends/local.js";
import { readLocalByokCredential } from "../auth/native-credentials.js";
import { resolveProviderRuntimeAuthority } from "../llm/provider-options.js";
import { resolveProviderRuntimeRequest } from "../llm/provider-request.js";
import { resolveRegisteredModelCatalogEntry } from "../llm/registry/model-catalog.js";
import { isModelAllowed } from "../utils/model/modelAllowlist.js";
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
import { getTheme, type ThemeName, type ThemeSetting } from "../utils/theme.js";
import { applyTextStyles } from "../tui/ink/colorize.js";
import type { Color } from "../tui/ink/styles.js";
import { TerminalSizeContext } from "../tui/ink/components/TerminalSizeContext.js";
import {
  verifyApiKey,
  verifyPreparedProviderConnection,
} from "./useApiKeyVerification.js";
import {
  isFreeSubscriptionManagedModel,
  SUBSCRIPTION_MANAGED_DEFAULT_PROVIDER,
  subscriptionManagedDefaultModel,
  subscriptionManagedDefaultModelForTier,
} from "../commands/subscription-managed-models.js";
import { captureSecureStorageIngress } from "../utils/secureStorage/home.js";

export type FirstRunOnboardingStepId =
  | "theme"
  | "provider"
  | "model-access"
  | "ready";

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
  /** Local providers: the models the running server lists. */
  readonly localModels?: readonly string[];
}

export type ProviderConnectionCredentialProvenance =
  | ProviderCredentialProvenance
  | { readonly kind: "verified-input" }
  | {
      readonly kind: "account";
      readonly provider: SignInProvider;
      readonly account: string;
    };

/**
 * One row of the provider list, worded like the `/providers` screen: the
 * provider's display name and one plain status ("key saved", "env
 * DEEPSEEK_API_KEY", "signed in as …", "not set").
 */
export interface OnboardingProviderRow {
  readonly provider: BuiltInProviderSlug;
  readonly name: string;
  readonly status: string;
  /** Ready to use without another step; Enter checks it and lists its models. */
  readonly connected: boolean;
}

export interface FirstRunOnboardingState {
  readonly currentStepId: FirstRunOnboardingStepId;
  readonly completedStepIds: readonly FirstRunOnboardingStepId[];
  readonly selectedTheme: ThemeSetting;
  readonly selectedProvider: BuiltInProviderSlug;
  readonly selectedModel: string;
  readonly connection: ProviderConnectionCheck | null;
  readonly pastedContents: readonly PastedContent[];
  /**
   * What the model-access card shows: the option menu, the paste field, the
   * result of the readiness check (`connection`) with its follow-ups, or the
   * provider's models once it is connected.
   */
  readonly modelAccessInput: "menu" | "api-key" | "result" | "models";
  /** The models offered once the provider is connected. */
  readonly modelChoices: readonly string[];
  /** The provider list, statuses read when the provider step opens. */
  readonly providerRows: readonly OnboardingProviderRow[];
  /** What the user typed to narrow the provider or model list. */
  readonly listFilter: string;
  /** Whether a failed result may offer "Paste a key" (set with the result). */
  readonly canPasteKey: boolean;
  readonly authPrompt: OnboardingAuthPrompt | null;
  readonly error: string | null;
  readonly isCheckingConnection: boolean;
  /** Local runtimes found listening (O-1): annotated in the provider step. */
  readonly detectedLocalProviders: readonly BuiltInProviderSlug[];
  /**
   * 1-based choice the arrow keys moved to on the current step, or null
   * when the user has not moved: Enter then keeps the step's own default.
   * Reset on every step change.
   */
  readonly highlightedChoice: number | null;
}

export interface FirstRunByokAuthBackend {
  saveByokKey(params: {
    readonly provider: string;
    readonly apiKey: string;
  }): unknown | Promise<unknown>;
}

export type ProviderSignInResult =
  | { readonly ok: true; readonly accountLabel: string }
  | { readonly ok: false; readonly message: string };

export type AgenCAccountLoginResult =
  | {
      readonly ok: true;
      readonly accountLabel: string;
      readonly subscriptionTier: AuthSubscriptionTier;
      readonly managedModel?: string;
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
   * Runs the account sign-in for OpenAI (ChatGPT) or Grok (X / xAI), the
   * same flow as `/providers`, `/openai-login` and `/grok-login`. Injectable
   * so wizard tests never open a browser; the default lazily imports it.
   */
  readonly runProviderSignIn?: (provider: SignInProvider) => Promise<ProviderSignInResult>;
  /**
   * Runs AgenC account sign-in (the same remote auth backend as /login).
   * Injectable so wizard tests never open a browser.
   */
  readonly runAgenCAccountLogin?: () => Promise<AgenCAccountLoginResult>;
  /** Reports the URL/code while a browser or device sign-in is pending. */
  readonly onAuthPrompt?: (prompt: OnboardingAuthPrompt) => void;
}

const SIGN_IN_NAMES: Readonly<Record<SignInProvider, string>> = {
  openai: "ChatGPT",
  grok: "X / xAI",
};

/**
 * Default account sign-in for the model-access step: the shared flow behind
 * `/providers`. Lazy imports keep the wizard module light for the other
 * providers.
 */
async function defaultRunProviderSignIn(
  context: FirstRunOnboardingContext,
  provider: SignInProvider,
): Promise<ProviderSignInResult> {
  const name = SIGN_IN_NAMES[provider];
  try {
    const ingress = captureSecureStorageIngress(
      context.env ?? process.env,
      context.agencHome,
    );
    const [{ signInToProvider }, { env: hostEnv }] = await Promise.all([
      import("../commands/provider-sign-in.js"),
      import("../utils/env.js"),
    ]);
    let url: string | undefined;
    let userCode: string | undefined;
    const result = await signInToProvider({
      provider,
      home: ingress.home,
      environment: ingress.environment,
      canOpenBrowser: !hostEnv.isSSH(),
      onProgress: (progress) => {
        url = progress.url ?? url;
        userCode = progress.userCode ?? userCode;
        // Steps without a link (saving, exchanging the code) keep the last
        // link and code on the card.
        if (url === undefined) return;
        context.onAuthPrompt?.({
          heading: `Sign in with ${name}`,
          detail: progress.heading,
          url,
          ...(userCode === undefined ? {} : { userCode }),
        });
      },
    });
    if (result.ok) return { ok: true, accountLabel: result.account };
    return { ok: false, message: result.message };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message:
        `${name} sign-in did not complete (${detail}). ` +
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
    const access = await readAccountModelAccess(backend);
    const managedModel = accountDefaultModel(access);
    if (subscriptionTier === "free" && managedModel === undefined) {
      return { ok: false, message: "Signed in to AgenC. No active model credits are available right now. Refresh access or choose another model connection." };
    }
    return {
      ok: true,
      accountLabel: authIdentityLabel(login.identity),
      subscriptionTier,
      ...(managedModel === undefined ? {} : { managedModel }),
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
  /** Move the highlighted choice with the arrow keys; no-op on steps without a list. */
  moveSelection(delta: -1 | 1): void;
  /** What the user is typing, which narrows the provider and model lists. */
  setListFilter(text: string): void;
}

const FIRST_RUN_STEP_ORDER: readonly FirstRunOnboardingStepId[] = Object.freeze([
  "theme",
  "provider",
  "model-access",
  "ready",
]);

const STEP_TITLES: Readonly<Record<FirstRunOnboardingStepId, string>> =
  Object.freeze({
    theme: "Theme",
    provider: "Provider",
    "model-access": "Model access",
    ready: "Ready",
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
    "agencHome" | "config" | "env" | "remoteAuthSessionContext"
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
    currentStepId: "theme",
    completedStepIds: [],
    selectedTheme:
      wizardThemeToSetting(context.config.tui?.theme ?? "dark") ??
      "dark",
    selectedProvider: provider,
    selectedModel: model,
    connection: null,
    pastedContents: [],
    modelAccessInput: "menu",
    modelChoices: [],
    providerRows: readOnboardingProviderRows(context),
    listFilter: "",
    canPasteKey: false,
    authPrompt: null,
    error: null,
    isCheckingConnection: false,
    detectedLocalProviders: [],
    highlightedChoice: null,
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

/** Read a credential store without letting a broken one block setup. */
function readOrDefault<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * Where a provider stands, in the words `/providers` uses. Local runtimes
 * start as not running; the probe result is applied when it arrives.
 */
function providerSetupStatus(
  provider: BuiltInProviderSlug,
  context: Pick<
    FirstRunOnboardingContext,
    "agencHome" | "config" | "env" | "remoteAuthSessionContext"
  >,
  home: HomeContext | undefined,
): { readonly status: string; readonly connected: boolean } {
  const env = context.env ?? process.env;
  switch (providerOnboardingInfo(provider).access) {
    case "local":
      return { status: "not running", connected: false };
    case "environment":
      return missingProviderCredentialEnvironmentLabel(provider, env) === undefined
        ? { status: "AWS credentials set", connected: true }
        : { status: "needs AWS credentials", connected: false };
    case "managed":
      return context.remoteAuthSessionContext !== undefined &&
          hasRemoteAuthSessionSync(context.remoteAuthSessionContext)
        ? { status: "AgenC account", connected: true }
        : { status: "needs an AgenC account", connected: false };
    default:
      break;
  }
  if (home !== undefined && isSignInProvider(provider)) {
    const account = readOrDefault(() => signedInAccount(home, provider), null);
    if (account !== null) return { status: `signed in as ${account}`, connected: true };
  }
  const match = resolveProviderApiKeyEnvironment(provider, env);
  if (match !== undefined) return { status: `env ${match.envVar}`, connected: true };
  if (home !== undefined && readOrDefault(() => hasSavedProviderKey(home, provider), false)) {
    return { status: "key saved", connected: true };
  }
  // A paid AgenC account reaches this provider with managed keys.
  if (
    providerOnboardingInfo(provider).supportsManagedKeyAccess &&
    resolveAuthManagedKeysEnabled(context.config) &&
    context.remoteAuthSessionContext !== undefined &&
    hasEntitledRemoteAuthSessionSync(context.remoteAuthSessionContext)
  ) {
    return { status: "AgenC account", connected: true };
  }
  return { status: "not set", connected: false };
}

/** Every provider with its status, in the built-in order. */
function readOnboardingProviderRows(
  context: Pick<
    FirstRunOnboardingContext,
    "agencHome" | "config" | "env" | "remoteAuthSessionContext"
  >,
): readonly OnboardingProviderRow[] {
  // Without a home there is no credential store to read: statuses then come
  // from the environment only.
  const home = context.agencHome === undefined
    ? undefined
    : captureSecureStorageIngress(context.env ?? process.env, context.agencHome).home;
  return providerChoices().map((provider) => ({
    provider,
    name: resolveBuiltInProviderInfo(provider)?.name ?? provider,
    ...providerSetupStatus(provider, context, home),
  }));
}

/** Text that narrows a list: anything but a bare number, which picks by position. */
function activeListFilter(state: FirstRunOnboardingState): string {
  const needle = state.listFilter.trim().toLowerCase();
  return /^\d*$/u.test(needle) ? "" : needle;
}

/**
 * The provider list as the card shows it: local runtimes marked running when
 * the probe found them, connected providers first, then the rest in the
 * built-in order, narrowed by what the user typed.
 */
function providerListRows(
  state: FirstRunOnboardingState,
  filter = activeListFilter(state),
): readonly OnboardingProviderRow[] {
  const detected = new Set(state.detectedLocalProviders);
  const rows = state.providerRows.map((row) =>
    detected.has(row.provider)
      ? { ...row, status: "running", connected: true }
      : row
  );
  const ordered = [
    ...rows.filter((row) => row.connected),
    ...rows.filter((row) => !row.connected),
  ];
  if (filter === "") return ordered;
  return ordered.filter(
    (row) =>
      row.name.toLowerCase().includes(filter) ||
      row.provider.includes(filter),
  );
}

/** The models the model list narrows to. */
function modelListChoices(state: FirstRunOnboardingState): readonly string[] {
  const filter = activeListFilter(state);
  if (filter === "") return state.modelChoices;
  return state.modelChoices.filter((model) => model.toLowerCase().includes(filter));
}

/**
 * Keep what the user is typing on a step with a list, so the card narrows
 * the list as they type. Other steps ignore it: a key pasted on the
 * model-access menu must never land in the card.
 */
export function setFirstRunOnboardingListFilter(
  state: FirstRunOnboardingState,
  text: string,
): FirstRunOnboardingState {
  const listStep =
    state.currentStepId === "provider" ||
    (state.currentStepId === "model-access" && state.modelAccessInput === "models");
  const next = listStep ? text : "";
  if (next === state.listFilter) return state;
  return { ...state, listFilter: next, highlightedChoice: null, error: null };
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
    highlightedChoice: null,
    error: null,
  };
}

/** The model-access options, in the order the menu numbers them. */
type ModelAccessOptionId = "key" | "account" | "sign-in" | "later";

/**
 * What the model-access menu lists for a provider. The key option is the
 * provider's own credential (an API key, a local runtime, AWS credentials);
 * a hosted-only provider has none. The account sign-in (ChatGPT, X / xAI)
 * only applies to OpenAI and Grok.
 */
function modelAccessOptionIds(
  provider: BuiltInProviderSlug,
): readonly ModelAccessOptionId[] {
  const access = providerOnboardingInfo(provider).access;
  return [
    ...(access === "managed" ? [] : ["key" as const]),
    "account",
    ...(isSignInProvider(provider) ? ["sign-in" as const] : []),
    "later",
  ];
}

const MODEL_ACCESS_OPTION_COMMANDS: Readonly<Record<ModelAccessOptionId, string>> = {
  key: "key",
  account: "account",
  "sign-in": "sign-in",
  later: "later",
};

/** Follow-ups offered when the readiness check did not pass. */
type ModelAccessFollowUpId = "paste" | "again" | "continue";

function modelAccessFollowUpIds(
  state: Pick<FirstRunOnboardingState, "canPasteKey">,
): readonly ModelAccessFollowUpId[] {
  return state.canPasteKey
    ? ["paste", "again", "continue"]
    : ["again", "continue"];
}

/** Number of numbered choices the current step lists, 0 when it lists none. */
export function firstRunOnboardingChoiceCount(
  state: FirstRunOnboardingState,
): number {
  switch (state.currentStepId) {
    case "theme":
      return THEME_CHOICES.length;
    case "provider":
      return providerListRows(state).length;
    case "model-access":
      if (state.authPrompt !== null) return 0;
      if (state.modelAccessInput === "menu") {
        return modelAccessOptionIds(state.selectedProvider).length;
      }
      if (state.modelAccessInput === "models") {
        return modelListChoices(state).length;
      }
      if (state.modelAccessInput === "result" && state.connection?.ok !== true) {
        return modelAccessFollowUpIds(state).length;
      }
      return 0;
    default:
      return 0;
  }
}

/**
 * The 1-based choice Enter confirms on a step with a list: the arrow-key
 * selection when the user moved, otherwise the step's own default (the
 * current theme or provider; the first option on the model-access lists).
 */
export function firstRunOnboardingHighlightedChoice(
  state: FirstRunOnboardingState,
): number | null {
  const count = firstRunOnboardingChoiceCount(state);
  if (count === 0) return null;
  const moved = state.highlightedChoice;
  if (moved !== null && moved >= 1 && moved <= count) return moved;
  switch (state.currentStepId) {
    case "theme":
      return Math.max(1, THEME_CHOICES.indexOf(state.selectedTheme) + 1);
    case "provider":
      return Math.max(
        1,
        providerListRows(state).findIndex((row) => row.provider === state.selectedProvider) + 1,
      );
    case "model-access":
      return state.modelAccessInput === "models"
        ? Math.max(1, modelListChoices(state).indexOf(state.selectedModel) + 1)
        : 1;
    default:
      return 1;
  }
}

/** Move the highlighted choice, wrapping at both ends; unchanged on steps without a list. */
export function moveFirstRunOnboardingHighlight(
  state: FirstRunOnboardingState,
  delta: -1 | 1,
): FirstRunOnboardingState {
  const count = firstRunOnboardingChoiceCount(state);
  if (count === 0) return state;
  const current = firstRunOnboardingHighlightedChoice(state) ?? 1;
  const next = ((current - 1 + delta + count) % count) + 1;
  return { ...state, highlightedChoice: next, error: null };
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

/**
 * The provider Enter picks: a position in the list, an exact slug or name,
 * or else the highlighted row of the list narrowed by the typed text.
 */
function parseProvider(
  state: FirstRunOnboardingState,
  raw: string,
): BuiltInProviderSlug | null {
  const input = raw.trim().toLowerCase();
  if (input === "" || input === "next") return state.selectedProvider;
  const rows = providerListRows(state, "");
  const index = Number(input);
  if (Number.isInteger(index) && index >= 1 && index <= rows.length) {
    return rows[index - 1]?.provider ?? state.selectedProvider;
  }
  const bySlug = resolveBuiltInProviderSlug(input);
  if (bySlug !== undefined) return bySlug;
  const byName = rows.find((row) => row.name.toLowerCase() === input);
  if (byName !== undefined) return byName.provider;
  const narrowed = providerListRows(state, input);
  if (narrowed.length === 0) return null;
  // The highlight only counts when it was moved within this same narrowing.
  const highlighted = activeListFilter(state) === input
    ? state.highlightedChoice
    : null;
  return narrowed[(highlighted ?? 1) - 1]?.provider ?? narrowed[0]!.provider;
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
    command === "later" ||
    command === "next" ||
    command === "skip"
  );
}

function isAgenCAccountLoginCommand(command: string): boolean {
  return (
    command === "account" ||
    command === "agenc" ||
    command === "agenc-login" ||
    command === "login"
  );
}

/**
 * The account sign-in a typed command asks for: one provider's by name, or
 * "any" for the selected provider's own.
 */
function signInCommandTarget(command: string): SignInProvider | "any" | null {
  switch (command) {
    case "grok-login":
    case "x":
    case "xai":
    case "xai-login":
      return "grok";
    case "chatgpt":
    case "chatgpt-login":
    case "openai-login":
      return "openai";
    case "sign-in":
    case "signin":
      return "any";
    default:
      return null;
  }
}

function signInMismatchError(target: SignInProvider | "any"): string {
  switch (target) {
    case "grok":
      return "X / xAI sign-in is for Grok. Pick grok in the provider step to use it.";
    case "openai":
      return "ChatGPT sign-in is for OpenAI. Pick OpenAI in the provider step to use it.";
    case "any":
      return "This provider has no account sign-in. Paste a key instead.";
  }
}

function isApiKeyEntryCommand(command: string): boolean {
  return (
    command === "test" ||
    command === "check" ||
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

/** Shorter input outside the paste field is treated as a typo, not a key. */
const MIN_PASTED_KEY_LENGTH = 16;

/** Map menu input (a number, or Enter for the first option) to an option. */
function resolveModelAccessOption(
  state: FirstRunOnboardingState,
  raw: string,
): ModelAccessOptionId | undefined {
  const ids = modelAccessOptionIds(state.selectedProvider);
  const input = lowerCommand(raw);
  if (input === "") return ids[0];
  const index = Number(input);
  return Number.isInteger(index) && index >= 1 && index <= ids.length
    ? ids[index - 1]
    : undefined;
}

/** Whether a pasted one-field key can configure this provider. */
function acceptsPastedKey(
  provider: BuiltInProviderSlug,
  context: FirstRunOnboardingContext,
): boolean {
  if (providerOnboardingInfo(provider).access !== "api-key") return false;
  if (provider !== "gemini") return true;
  const plan = resolveOnboardingGeminiCredentialPlan(context);
  return plan.kind !== "none" ||
    (plan.expected !== "access-token" && plan.expected !== "adc");
}

/** Show a readiness result on the model-access card. */
function withModelAccessResult(
  state: FirstRunOnboardingState,
  connection: ProviderConnectionCheck,
  canPasteKey = false,
): FirstRunOnboardingState {
  return {
    ...state,
    connection,
    canPasteKey,
    modelAccessInput: "result",
    authPrompt: null,
    highlightedChoice: null,
    error: null,
  };
}

const FOLLOW_UP_ALIASES: Readonly<Record<string, ModelAccessFollowUpId>> = {
  paste: "paste",
  key: "paste",
  back: "again",
  again: "again",
  choose: "again",
  continue: "continue",
  later: "continue",
  skip: "continue",
  next: "continue",
};

/**
 * Input on a shown readiness result. Returns null when the input is neither
 * a follow-up nor Enter, so a provider that takes pasted keys can treat it
 * as a replacement key.
 */
function submitModelAccessResult(
  state: FirstRunOnboardingState,
  raw: string,
): FirstRunOnboardingSubmitResult | null {
  const input = lowerCommand(raw);
  if (state.connection?.ok === true) {
    if (input === "back" || input === "again") {
      return {
        state: { ...state, modelAccessInput: "menu", highlightedChoice: null, error: null },
        completed: false,
      };
    }
    if (input === "" || input === "next" || input === "continue") {
      return {
        state: withCompletedStep(state, "model-access", "ready"),
        completed: false,
      };
    }
    return {
      state: { ...state, error: "Press Enter to continue, or type back to choose again." },
      completed: false,
    };
  }
  const ids = modelAccessFollowUpIds(state);
  const index = Number(input);
  const choice = input === ""
    ? ids[0]
    : Number.isInteger(index) && index >= 1 && index <= ids.length
      ? ids[index - 1]
      : FOLLOW_UP_ALIASES[input];
  if (choice === undefined || !ids.includes(choice)) {
    if (ids.includes("paste")) return null;
    return {
      state: { ...state, error: `Choose 1 to ${ids.length}.` },
      completed: false,
    };
  }
  if (choice === "paste") {
    return {
      state: { ...state, modelAccessInput: "api-key", highlightedChoice: null, error: null },
      completed: false,
    };
  }
  if (choice === "again") {
    return {
      state: {
        ...state,
        connection: null,
        modelAccessInput: "menu",
        highlightedChoice: null,
        error: null,
      },
      completed: false,
    };
  }
  const skipError = modelAccessSkipError(state.connection);
  if (skipError !== null) {
    return { state: { ...state, error: skipError }, completed: false };
  }
  return {
    state: withCompletedStep(state, "model-access", "ready"),
    completed: false,
  };
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
    case "ready":
      return "done";
    case "theme":
    case "provider":
      return raw;
    case "model-access":
      // Empty input picks the highlighted option, or continues from a shown
      // result.
      return raw;
  }
}

/** Input on the model list: a position, an exact model, or the highlight. */
function submitModelChoice(
  state: FirstRunOnboardingState,
  raw: string,
): FirstRunOnboardingSubmitResult {
  const input = raw.trim();
  if (input.toLowerCase() === "back") {
    return {
      state: {
        ...state,
        connection: null,
        modelAccessInput: "menu",
        modelChoices: [],
        listFilter: "",
        highlightedChoice: null,
        error: null,
      },
      completed: false,
    };
  }
  const index = Number(input);
  const narrowed = modelListChoices(state);
  const model = input === ""
    ? narrowed[(firstRunOnboardingHighlightedChoice(state) ?? 1) - 1]
    : Number.isInteger(index) && index >= 1 && index <= state.modelChoices.length
      ? state.modelChoices[index - 1]
      : state.modelChoices.find((choice) => choice === input) ??
        (activeListFilter(state) === input.toLowerCase()
          ? narrowed[(firstRunOnboardingHighlightedChoice(state) ?? 1) - 1]
          : modelListChoices({ ...state, listFilter: input })[0]);
  if (model === undefined) {
    return {
      state: { ...state, error: "No model matches that. Delete some letters to see more." },
      completed: false,
    };
  }
  return {
    state: withCompletedStep(
      { ...state, selectedModel: model, listFilter: "" },
      "model-access",
      "ready",
    ),
    completed: false,
  };
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
  return `${base} Paste another key, or press Enter to set up later.`;
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
  if (provenance.kind === "account") return `${SIGN_IN_NAMES[provenance.provider]} sign-in`;
  return provenance.fields.map((field) => field.envVar).join(" + ");
}

/** A provider account sign-in that just finished. */
function signedInConnection(
  provider: SignInProvider,
  model: string,
  account: string,
): ProviderConnectionCheck {
  return {
    provider,
    model,
    status: "ready",
    ok: true,
    detail: provider === "grok"
      ? `Signed in to X / xAI as ${account}. Grok subscription access is ready.`
      : `Signed in to ChatGPT as ${account}. OpenAI access is ready.`,
    credentialProvenance: { kind: "account", provider, account },
  };
}

/** Whether a model is offered for new selections (hidden ones stay resolvable). */
function isOfferedModel(
  provider: BuiltInProviderSlug,
  model: string,
  config: AgenCConfig,
): boolean {
  if (resolveRegisteredModelCatalogEntry({ provider, model })?.visibility === "hide") {
    return false;
  }
  return isModelAllowed(provider, model, config);
}

/**
 * The models to offer once a provider is connected: what a running local
 * server lists, or else the provider's catalog, as `/providers` offers it.
 * The selected and default models come first so Enter keeps them.
 */
function onboardingModelChoices(
  provider: BuiltInProviderSlug,
  selectedModel: string,
  context: Pick<FirstRunOnboardingContext, "config">,
  localModels: readonly string[] | undefined,
): readonly string[] {
  if (localModels !== undefined && localModels.length > 0) {
    return [...new Set(localModels.map((model) => model.trim()).filter((model) => model !== ""))];
  }
  const catalog = buildProviderModelCatalog(context.config)[provider] ?? [];
  const candidates = [
    selectedModel,
    BUILT_IN_PROVIDER_DEFAULT_MODELS[provider],
    ...catalog,
  ].map((model) => providerLocalModelIdFromCatalog(provider, model.trim()));
  return [...new Set(candidates)].filter(
    (model, index) =>
      model !== "" &&
      // The current choice is always offered, even when the catalog hides it.
      (index === 0 || isOfferedModel(provider, model, context.config)),
  );
}

/**
 * After a passed check: list the provider's models so the user picks one.
 * With nothing to choose between, show the result and let Enter continue.
 */
function withModelChoices(
  state: FirstRunOnboardingState,
  connection: ProviderConnectionCheck,
  context: Pick<FirstRunOnboardingContext, "config">,
): FirstRunOnboardingState {
  const models = onboardingModelChoices(
    state.selectedProvider,
    state.selectedModel,
    context,
    connection.localModels,
  );
  if (models.length <= 1) {
    return withModelAccessResult(
      { ...state, selectedModel: models[0] ?? state.selectedModel },
      connection,
    );
  }
  return {
    ...state,
    connection,
    canPasteKey: false,
    modelAccessInput: "models",
    modelChoices: models,
    listFilter: "",
    authPrompt: null,
    highlightedChoice: null,
    error: null,
  };
}

/**
 * Show a finished readiness check: the models when it passed, the result
 * with its follow-ups when it did not. A running local server that lacks the
 * default model still lists what it has, so the user picks one of those.
 */
function withConnectionCheck(
  state: FirstRunOnboardingState,
  connection: ProviderConnectionCheck,
  context: FirstRunOnboardingContext,
): FirstRunOnboardingState {
  if (connection.ok) return withModelChoices(state, connection, context);
  if (
    connection.status === "local-model-missing" &&
    (connection.localModels?.length ?? 0) > 0
  ) {
    return withModelChoices(
      state,
      {
        ...connection,
        status: "ready",
        ok: true,
        detail: "Local provider endpoint is reachable.",
      },
      context,
    );
  }
  return withModelAccessResult(
    state,
    connection,
    acceptsPastedKey(state.selectedProvider, context),
  );
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

async function savePastedApiKey(
  context: FirstRunOnboardingContext,
  paste: { readonly pasteHash?: string; readonly pasteContent?: string },
): Promise<void> {
  if (
    context.agencHome === undefined ||
    paste.pasteHash === undefined ||
    paste.pasteContent === undefined
  ) {
    return;
  }
  await storePastedText({
    agencHome: context.agencHome,
    hash: paste.pasteHash,
    content: paste.pasteContent,
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
        localModels: probe.modelIds,
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
      localModels: probe.modelIds,
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
  // Enter after moving the highlight with the arrow keys confirms that
  // choice; without a move it keeps the step's default as before.
  const highlightedInput =
    rawInput.trim() === "" && state.highlightedChoice !== null
      ? String(firstRunOnboardingHighlightedChoice(state) ?? "")
      : rawInput;
  const raw = defaultOnboardingCommand(
    state,
    normalizeOnboardingCommand(highlightedInput),
  );
  const slashError = onboardingSlashCommandError(raw);
  if (slashError !== null) {
    return {
      state: { ...state, error: slashError },
      completed: false,
    };
  }

  switch (state.currentStepId) {
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
          {
            ...state,
            selectedTheme: theme,
            providerRows: readOnboardingProviderRows(context),
          },
          "theme",
          "provider",
        ),
        completed: false,
      };
    }
    case "provider": {
      const provider = parseProvider(state, raw);
      if (provider === null) {
        return {
          // Never echo the input: it could be a key pasted in the wrong place.
          state: { ...state, error: "No provider matches that. Delete some letters to see more." },
          completed: false,
        };
      }
      const selectedModel = provider === state.selectedProvider
        ? state.selectedModel
        : providerDefaultModel(provider, context);
      const next = withCompletedStep(
        {
          ...state,
          selectedProvider: provider,
          selectedModel,
          connection: null,
          pastedContents: [],
          modelAccessInput: "menu",
          modelChoices: [],
          listFilter: "",
          authPrompt: null,
        },
        "provider",
        "model-access",
      );
      const row = providerListRows(state, "").find((entry) => entry.provider === provider);
      if (row?.connected !== true) return { state: next, completed: false };
      // Already connected: check it now and go straight to its models, as
      // /providers does.
      const connection = await checkOnboardingProviderConnection(
        context,
        provider,
        selectedModel,
      );
      return {
        state: withConnectionCheck(next, connection, context),
        completed: false,
      };
    }
    case "model-access":
      if (state.modelAccessInput === "models") {
        return submitModelChoice(state, raw);
      }
      if (state.modelAccessInput === "result") {
        const followUp = submitModelAccessResult(state, raw);
        if (followUp !== null) return followUp;
      }
      {
        const option = state.modelAccessInput === "menu"
          ? resolveModelAccessOption(state, raw)
          : undefined;
        // In the paste field, Enter alone means set up later, as the footer says.
        const command = option !== undefined
          ? MODEL_ACCESS_OPTION_COMMANDS[option]
          : state.modelAccessInput === "api-key" && lowerCommand(raw) === ""
            ? "later"
            : lowerCommand(raw);
        const signInTarget = signInCommandTarget(command);
        if (
          signInTarget !== null &&
          (!isSignInProvider(state.selectedProvider) ||
            (signInTarget !== "any" && signInTarget !== state.selectedProvider))
        ) {
          return {
            state: { ...state, error: signInMismatchError(signInTarget) },
            completed: false,
          };
        }
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
            result.managedModel === undefined ? SUBSCRIPTION_MANAGED_DEFAULT_PROVIDER : "agenc",
          );
          const hostedModel =
            result.managedModel ?? (hostedProvider === undefined
              ? undefined
              : subscriptionManagedDefaultModelForTier(
                  hostedProvider,
                  result.subscriptionTier,
                ));
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
            state: withModelAccessResult(
              {
                ...state,
                selectedProvider: hostedProvider,
                selectedModel: hostedModel,
              },
              authenticatedConnection(
                hostedProvider,
                hostedModel,
                accessDetail,
              ),
            ),
            completed: false,
          };
        }
        if (signInTarget !== null && isSignInProvider(state.selectedProvider)) {
          const provider = state.selectedProvider;
          const runSignIn =
            context.runProviderSignIn ??
            ((target: SignInProvider) => defaultRunProviderSignIn(context, target));
          const result = await runSignIn(provider);
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
          return {
            state: withModelChoices(
              state,
              signedInConnection(provider, state.selectedModel, result.accountLabel),
              context,
            ),
            completed: false,
          };
        }
        if (isApiKeyEntryCommand(command)) {
          // Check what is already configured first: a key in the environment
          // or in secure storage, a local runtime, a forced Gemini plan, AWS
          // credentials. Only a missing pasteable key opens the paste field.
          const connection = await checkOnboardingProviderConnection(
            context,
            state.selectedProvider,
            state.selectedModel,
          );
          if (
            !connection.ok &&
            connection.status === "credentials-required" &&
            acceptsPastedKey(state.selectedProvider, context)
          ) {
            return {
              state: {
                ...state,
                connection,
                modelAccessInput: "api-key",
                authPrompt: null,
                error: null,
              },
              completed: false,
            };
          }
          return {
            state: withConnectionCheck(state, connection, context),
            completed: false,
          };
        }
        if (command === "back" && state.modelAccessInput === "menu") {
          return {
            state: {
              ...state,
              currentStepId: "provider",
              providerRows: readOnboardingProviderRows(context),
              listFilter: "",
              highlightedChoice: null,
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
                connection: null,
                modelAccessInput: "menu",
                authPrompt: null,
              },
              "model-access",
              "ready",
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
        if (
          state.modelAccessInput !== "api-key" &&
          apiKey.length < MIN_PASTED_KEY_LENGTH
        ) {
          // Outside the paste field, a short word is a mistyped choice, not a
          // key: never send it to the provider.
          const count = firstRunOnboardingChoiceCount(state);
          return {
            state: {
              ...state,
              error: `Choose 1 to ${count}, or paste a key.`,
            },
            completed: false,
          };
        }
        if (apiKey.length === 0 || /\s/.test(apiKey)) {
          return {
            state: {
              ...state,
              error:
                "Paste a single key without spaces, or press Enter to set up later.",
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
        // The provider accepted the key: save it now, the way /providers
        // does. Typing or pasting a key here is the request to use it.
        try {
          await savePastedApiKey(context, pasteCapture);
          await saveOnboardingByokKey(context, state.selectedProvider, apiKey);
        } catch (error) {
          if (context.agencHome !== undefined && pasteCapture.pasteHash !== undefined) {
            await deletePastedText({
              agencHome: context.agencHome,
              hash: pasteCapture.pasteHash,
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
          state: withModelChoices(
            { ...state, pastedContents: pasteCapture.pastedContents },
            verifiedApiKeyConnection(state.selectedProvider, state.selectedModel),
            context,
          ),
          completed: false,
        };
      }
    case "ready":
      {
        const command = raw.trim().toLowerCase();
        if (command !== "done" && command !== "next") {
          return {
            state: {
              ...state,
              error: "Press Enter to start AgenC.",
            },
            completed: false,
          };
        }
      }
      return {
        state: withCompletedStep(state, "ready", null),
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
      const current = stateRef.current;
      const next = { ...current, detectedLocalProviders: detected };
      // A running runtime moves up the list; keep a moved highlight on the
      // same provider rather than on whatever now sits at its position.
      const highlighted = current.currentStepId === "provider" &&
          current.highlightedChoice !== null
        ? providerListRows(current)[current.highlightedChoice - 1]?.provider
        : undefined;
      const moved = highlighted === undefined
        ? next
        : {
            ...next,
            highlightedChoice:
              providerListRows(next).findIndex((row) => row.provider === highlighted) + 1 ||
              null,
          };
      stateRef.current = moved;
      setState(moved);
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

  const moveSelection = useCallback(
    (delta: -1 | 1): void => {
      if (!active || submitInFlight.current) return;
      const next = moveFirstRunOnboardingHighlight(stateRef.current, delta);
      if (next === stateRef.current) return;
      stateRef.current = next;
      setState(next);
    },
    [active],
  );
  const setListFilter = useCallback(
    (text: string): void => {
      if (!active || submitInFlight.current) return;
      const next = setFirstRunOnboardingListFilter(stateRef.current, text);
      if (next === stateRef.current) return;
      stateRef.current = next;
      setState(next);
    },
    [active],
  );
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
            listFilter: "",
          };
          stateRef.current = failedState;
          setState(failedState);
          return true;
        }
        // The composer is cleared after every submit, so the list it was
        // narrowing opens in full again.
        const nextState = {
          ...result.state,
          detectedLocalProviders: stateRef.current.detectedLocalProviders,
          isCheckingConnection: false,
          listFilter: "",
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
    moveSelection,
    setListFilter,
  };
}

/** One row of a setup card. */
type OnboardingCardRow =
  | {
      readonly kind: "choice";
      readonly label: string;
      readonly note: string;
      readonly selected: boolean;
    }
  | { readonly kind: "more"; readonly text: string }
  | { readonly kind: "kv"; readonly label: string; readonly value: string }
  | { readonly kind: "status"; readonly ok: boolean; readonly text: string }
  | { readonly kind: "text"; readonly text: string; readonly strong?: boolean }
  | { readonly kind: "gap" };

/** What a setup card shows: one question, its rows, and an optional hint. */
interface OnboardingCardView {
  readonly lead: string;
  readonly rows: readonly OnboardingCardRow[];
  readonly hint?: string;
}

const THEME_NOTES: Readonly<Record<ThemeSetting, string>> = {
  auto: "matches your terminal background",
  dark: "for dark terminals",
  light: "for light terminals",
  "light-daltonized": "color-blind friendly, light",
  "dark-daltonized": "color-blind friendly, dark",
  "light-ansi": "your terminal's 16 colors, light",
  "dark-ansi": "your terminal's 16 colors, dark",
};

/** Providers visible at once; the rest collapse into "n more" rows. */
const PROVIDER_WINDOW = 8;

const PERMISSION_MODE_NOTES: Readonly<Record<string, string>> = {
  default: "asks before tools that need it",
  acceptEdits: "accepts file edits on its own",
  plan: "read-only, plans before acting",
  auto: "approves allowlisted tools",
  bypassPermissions: "approvals off",
};

const SANDBOX_MODE_NOTES: Readonly<Record<string, string>> = {
  "workspace-write": "limits writes to this workspace",
  "read-only": "no file writes",
  "danger-full-access": "no sandbox",
};

function onboardingEnvironment(
  context: FirstRunOnboardingContext,
): NodeJS.ProcessEnv {
  return context.env ?? process.env;
}

function themeTip(): string {
  // Only give a direction when the background was measured: an unmeasured
  // value is a guessed `dark`, and advising from it is the inverted advice
  // M-ONB-2 removed.
  if (isTerminalBackgroundDetected()) {
    const background = getTerminalBackground();
    return `Tip: your terminal looks ${background}, so "${background}" or "auto" will read best.`;
  }
  return 'Tip: pick "light" on a light terminal and "dark" on a dark one.';
}

function choiceRows(
  state: FirstRunOnboardingState,
  entries: ReadonlyArray<{ readonly label: string; readonly note: string }>,
  offset = 0,
): OnboardingCardRow[] {
  const highlighted = firstRunOnboardingHighlightedChoice(state);
  return entries.map((entry, index) => ({
    kind: "choice",
    label: entry.label,
    note: entry.note,
    selected: highlighted === offset + index + 1,
  }));
}

/**
 * Choice rows for a long list, kept inside a fixed window around the
 * highlight so the card never scrolls off a short terminal or hides the row
 * Enter would pick.
 */
function windowedChoiceRows(
  state: FirstRunOnboardingState,
  entries: ReadonlyArray<{ readonly label: string; readonly note: string }>,
): OnboardingCardRow[] {
  const highlighted = (firstRunOnboardingHighlightedChoice(state) ?? 1) - 1;
  const start = Math.min(
    Math.max(0, highlighted - Math.floor(PROVIDER_WINDOW / 2)),
    Math.max(0, entries.length - PROVIDER_WINDOW),
  );
  const end = Math.min(entries.length, start + PROVIDER_WINDOW);
  const rows: OnboardingCardRow[] = [];
  if (start > 0) rows.push({ kind: "more", text: `↑ ${start} more` });
  rows.push(...choiceRows(state, entries.slice(start, end), start));
  if (end < entries.length) {
    rows.push({ kind: "more", text: `↓ ${entries.length - end} more` });
  }
  return rows;
}

function providerCardView(state: FirstRunOnboardingState): OnboardingCardView {
  const lead = "Which provider should AgenC use?";
  const rows = providerListRows(state);
  if (rows.length === 0) {
    return {
      lead,
      rows: [{ kind: "text", text: "No provider matches that." }],
      hint: "Delete some letters to see more.",
    };
  }
  const running = rows.find(
    (row) => row.status === "running" && state.detectedLocalProviders.includes(row.provider),
  );
  return {
    lead,
    rows: windowedChoiceRows(
      state,
      rows.map((row) => ({ label: row.name, note: row.status })),
    ),
    hint: activeListFilter(state) !== ""
      ? "Enter picks the highlighted provider."
      : running !== undefined
        ? `${running.name} is running on this machine. Pick it to start without a key.`
        : "Type to filter. Enter connects.",
  };
}

function modelsCardView(state: FirstRunOnboardingState): OnboardingCardView {
  const name = resolveBuiltInProviderInfo(state.selectedProvider)?.name ?? state.selectedProvider;
  const lead = `Which ${name} model should AgenC use?`;
  const status: OnboardingCardRow[] = state.connection === null
    ? []
    : [
        { kind: "status", ok: true, text: modelAccessSuccessText(state.connection) },
        { kind: "gap" },
      ];
  const models = modelListChoices(state);
  if (models.length === 0) {
    return {
      lead,
      rows: [...status, { kind: "text", text: "No model matches that." }],
      hint: "Delete some letters to see more.",
    };
  }
  const defaultModel = BUILT_IN_PROVIDER_DEFAULT_MODELS[state.selectedProvider];
  return {
    lead,
    rows: [
      ...status,
      ...windowedChoiceRows(
        state,
        models.map((model) => ({ label: model, note: model === defaultModel ? "default" : "" })),
      ),
    ],
    ...(models.length > PROVIDER_WINDOW ? { hint: "Type to filter." } : {}),
  };
}

function keyOptionEntry(
  state: FirstRunOnboardingState,
  context: FirstRunOnboardingContext,
): { readonly label: string; readonly note: string } {
  const provider = state.selectedProvider;
  const env = onboardingEnvironment(context);
  const access = providerOnboardingInfo(provider).access;
  if (access === "local") {
    // The question above already names the provider; keep the label short
    // so the notes column stays readable.
    return {
      label: "This machine",
      note: "no key needed, check it is running",
    };
  }
  if (access === "environment") {
    const missing = missingProviderCredentialEnvironmentLabel(provider, env);
    return {
      label: "AWS credentials",
      note: missing === undefined
        ? "set in your environment, check them now"
        : `set ${missing} first`,
    };
  }
  if (provider === "gemini") {
    const plan = resolveOnboardingGeminiCredentialPlan(context);
    const label = geminiCredentialLabel(plan);
    if (plan.kind !== "none") return { label, note: "configured, check it now" };
    if (plan.expected === "access-token" || plan.expected === "adc") {
      return { label, note: `set ${label} first` };
    }
    return { label, note: "paste a key next" };
  }
  // Name the variable that is actually set, else the canonical one; a list
  // of aliases ("XAI_API_KEY or GROK_API_KEY") crowds out the notes.
  const match = resolveProviderApiKeyEnvironment(provider, env);
  return {
    label: match?.envVar ??
      canonicalProviderApiKeyEnvVar(provider) ??
      providerApiKeyEnvironmentLabel(provider) ??
      "API key",
    note: match !== undefined
      ? "set in your environment, check it now"
      : "paste a key next",
  };
}

function modelAccessMenuEntries(
  state: FirstRunOnboardingState,
  context: FirstRunOnboardingContext,
): Array<{ readonly label: string; readonly note: string }> {
  return modelAccessOptionIds(state.selectedProvider).map((id) => {
    switch (id) {
      case "key":
        return keyOptionEntry(state, context);
      case "account":
        return {
          label: "AgenC account",
          note: "sign in for hosted models, free plan",
        };
      case "sign-in":
        return state.selectedProvider === "openai"
          ? { label: "ChatGPT account", note: "sign in to use OpenAI with your plan" }
          : { label: "X / xAI account", note: "sign in to use Grok with your subscription" };
      case "later":
        return { label: "Set up later", note: "AgenC can't answer until you do" };
    }
  });
}

function credentialName(connection: ProviderConnectionCheck): string {
  const provenance = connection.credentialProvenance;
  if (provenance?.kind === "environment") {
    return provenance.fields.map((field) => field.envVar).join(" + ");
  }
  return connection.credentialLabel ?? "the provider credential";
}

function providerAccessKind(provider: string): BuiltInProviderOnboardingInfo["access"] | undefined {
  const slug = resolveBuiltInProviderSlug(provider);
  return slug === undefined ? undefined : providerOnboardingInfo(slug).access;
}

/** What a passed readiness check means, in one plain sentence. */
function modelAccessSuccessText(connection: ProviderConnectionCheck): string {
  const provenance = connection.credentialProvenance;
  if (provenance?.kind === "verified-input") {
    return `${connection.provider} accepted the key, and it is saved.`;
  }
  if (provenance?.kind === "oauth") {
    return `${connection.provider} answered. Your xAI sign-in works.`;
  }
  if (provenance?.kind === "account") {
    return `Signed in to ${SIGN_IN_NAMES[provenance.provider]} as ${provenance.account}.`;
  }
  if (provenance?.kind === "environment") {
    if (provenance.fields.some((field) => field.role === "accessKeyId")) {
      return "AWS credentials are set. AgenC checks them on the first request.";
    }
    return `${connection.provider} answered. ${credentialName(connection)} works.`;
  }
  if (connection.status === "ready" && providerAccessKind(connection.provider) === "local") {
    return `${connection.provider} is running and ${connection.model} is available.`;
  }
  return connection.detail;
}

/** Why a readiness check did not pass, in one plain sentence. */
function modelAccessFailureText(connection: ProviderConnectionCheck): string {
  if (connection.status === "credentials-required" && connection.credentialLabel !== undefined) {
    return `No ${connection.credentialLabel} is set, so ${connection.provider} can't answer.`;
  }
  if (connection.status === "auth-failed" && connection.credentialProvenance !== undefined) {
    return `${connection.provider} rejected ${credentialName(connection)}.`;
  }
  return connection.detail;
}

const FOLLOW_UP_LABELS: Readonly<Record<ModelAccessFollowUpId, string>> = {
  paste: "Paste a key",
  again: "Choose again",
  continue: "Continue without a model",
};

function modelAccessCardView(
  state: FirstRunOnboardingState,
  context: FirstRunOnboardingContext,
): OnboardingCardView {
  const lead = `How should AgenC reach ${state.selectedProvider} / ${state.selectedModel}?`;
  if (state.authPrompt !== null) {
    return {
      lead: state.authPrompt.heading,
      rows: [
        { kind: "text", text: state.authPrompt.detail },
        { kind: "gap" },
        ...(state.authPrompt.userCode !== undefined
          ? [{ kind: "kv", label: "Code", value: state.authPrompt.userCode } as const]
          : []),
        { kind: "kv", label: "URL", value: state.authPrompt.url },
      ],
      hint: "Finish sign-in in your browser. AgenC continues on its own.",
    };
  }
  if (state.isCheckingConnection) {
    return {
      lead,
      rows: [{ kind: "text", text: `Checking ${state.selectedProvider}...` }],
    };
  }
  if (state.modelAccessInput === "models") return modelsCardView(state);
  if (state.modelAccessInput === "api-key") {
    const label = keyOptionEntry(state, context).label;
    return {
      lead: `Paste your ${label}.`,
      rows: state.connection?.status === "credentials-required"
        ? [{ kind: "text", text: `No ${label} is set yet.` }]
        : [],
      hint: "AgenC checks the key with the provider, then saves it on this computer.",
    };
  }
  const connection = state.connection;
  if (state.modelAccessInput === "result" && connection !== null) {
    if (connection.ok) {
      return {
        lead,
        rows: [{ kind: "status", ok: true, text: modelAccessSuccessText(connection) }],
      };
    }
    const followUps = modelAccessFollowUpIds(state);
    return {
      lead,
      rows: [
        { kind: "status", ok: false, text: modelAccessFailureText(connection) },
        { kind: "gap" },
        ...choiceRows(
          state,
          followUps.map((id) => ({ label: FOLLOW_UP_LABELS[id], note: "" })),
        ),
      ],
      ...(followUps.includes("paste")
        ? { hint: "You can also paste a key here." }
        : {}),
    };
  }
  return {
    lead,
    rows: choiceRows(state, modelAccessMenuEntries(state, context)),
    ...(acceptsPastedKey(state.selectedProvider, context)
      ? { hint: "You can also paste a key here." }
      : {}),
  };
}

function accessSummary(state: FirstRunOnboardingState): string {
  const connection = state.connection;
  if (connection === null) return "not set up yet";
  if (!connection.ok) return "not working yet";
  const provenance = connection.credentialProvenance;
  if (provenance?.kind === "verified-input") return "pasted key, saved";
  if (provenance?.kind === "oauth") return "xAI sign-in";
  if (provenance?.kind === "account") {
    return `${SIGN_IN_NAMES[provenance.provider]} sign-in`;
  }
  if (provenance?.kind === "environment") return `${credentialName(connection)}, checked`;
  if (providerAccessKind(connection.provider) === "local") return "local, no key needed";
  if (connection.detail.startsWith("Signed in to AgenC")) return "AgenC account";
  return "ready";
}

function withNote(value: string, notes: Readonly<Record<string, string>>): string {
  const note = notes[value];
  return note === undefined ? value : `${value}, ${note}`;
}

function readyCardView(
  state: FirstRunOnboardingState,
  context: FirstRunOnboardingContext,
): OnboardingCardView {
  const permissionMode = context.permissionMode ?? "default";
  const sandboxMode = context.sandboxMode ?? "workspace-write";
  const bypass = permissionMode === "bypassPermissions";
  return {
    lead: "AgenC is set up for this machine.",
    rows: [
      { kind: "kv", label: "Theme", value: state.selectedTheme },
      {
        kind: "kv",
        label: "Model",
        value: `${state.selectedProvider} / ${state.selectedModel}`,
      },
      { kind: "kv", label: "Access", value: accessSummary(state) },
      { kind: "kv", label: "Mode", value: withNote(permissionMode, PERMISSION_MODE_NOTES) },
      // Under a bypass flag the configured sandbox may not be the one in
      // effect (the dangerous flag turns it off), and this card cannot see
      // the daemon's live policy, so it states only what is certain.
      ...(bypass
        ? []
        : [{ kind: "kv", label: "Sandbox", value: withNote(sandboxMode, SANDBOX_MODE_NOTES) } as const]),
      { kind: "kv", label: "Workspace", value: context.cwd ?? process.cwd() },
      ...(bypass
        ? [
            { kind: "gap" } as const,
            { kind: "text", text: "Approvals are off for this run.", strong: true } as const,
          ]
        : []),
    ],
    hint: "Change these later with /config, /model and Shift+Tab.",
  };
}

/** The card for the current step. */
function onboardingCardView(
  state: FirstRunOnboardingState,
  context: FirstRunOnboardingContext,
): OnboardingCardView {
  switch (state.currentStepId) {
    case "theme":
      return {
        lead: "How should AgenC look in this terminal?",
        rows: choiceRows(
          state,
          THEME_CHOICES.map((theme) => ({
            label: theme,
            note: theme === state.selectedTheme
              ? `${THEME_NOTES[theme]} (current)`
              : THEME_NOTES[theme],
          })),
        ),
        hint: themeTip(),
      };
    case "provider":
      return providerCardView(state);
    case "model-access":
      return modelAccessCardView(state, context);
    case "ready":
      return readyCardView(state, context);
  }
}

/** The card as plain lines, for tests and plain-text renderers. */
export function detailLinesForStep(
  state: FirstRunOnboardingState,
  context: FirstRunOnboardingContext,
): readonly string[] {
  const view = onboardingCardView(state, context);
  const rows = view.rows.flatMap((row): string[] => {
    switch (row.kind) {
      case "choice":
        return [`${row.selected ? "›" : " "} ${row.label}${row.note === "" ? "" : `  ${row.note}`}`];
      case "more":
      case "text":
        return [row.text];
      case "kv":
        return [`${row.label}: ${row.value}`];
      case "status":
        return [`${row.ok ? "✓" : "✗"} ${row.text}`];
      case "gap":
        return [];
    }
  });
  return [view.lead, ...rows, ...(view.hint !== undefined ? [view.hint] : [])];
}

export interface FirstRunOnboardingInputPresentation {
  readonly placeholder: string;
  readonly footerHint: string;
  readonly allowEmptySubmit: boolean;
}

const CHOOSE_FOOTER = "↑↓ choose · Enter confirm · /exit leave setup";

export function firstRunOnboardingInputPresentation(
  state: FirstRunOnboardingState,
): FirstRunOnboardingInputPresentation {
  switch (state.currentStepId) {
    case "theme":
      return {
        placeholder: `Enter keeps ${state.selectedTheme}`,
        footerHint: CHOOSE_FOOTER,
        allowEmptySubmit: true,
      };
    case "provider": {
      const rows = providerListRows(state);
      const highlighted = rows[(firstRunOnboardingHighlightedChoice(state) ?? 1) - 1];
      return {
        placeholder: highlighted === undefined
          ? "Type to filter providers"
          : `Enter picks ${highlighted.name}, or type to filter`,
        footerHint: CHOOSE_FOOTER,
        allowEmptySubmit: true,
      };
    }
    case "model-access":
      if (state.modelAccessInput === "models") {
        const highlighted =
          modelListChoices(state)[(firstRunOnboardingHighlightedChoice(state) ?? 1) - 1];
        return {
          placeholder: highlighted === undefined
            ? "Type to filter models"
            : `Enter picks ${highlighted}, or type to filter`,
          footerHint: "↑↓ choose · Enter confirm · back choose again · /exit leave setup",
          allowEmptySubmit: true,
        };
      }
      if (state.modelAccessInput === "api-key") {
        return {
          placeholder: `Paste ${canonicalProviderApiKeyEnvVar(state.selectedProvider) ?? providerApiKeyEnvironmentLabel(state.selectedProvider) ?? "an API key"}`,
          footerHint: "back choose again · Enter set up later · /exit leave setup",
          allowEmptySubmit: true,
        };
      }
      if (state.modelAccessInput === "result" && state.connection?.ok === true) {
        return {
          placeholder: "Enter continues",
          footerHint: "Enter continue · back choose again · /exit leave setup",
          allowEmptySubmit: true,
        };
      }
      return {
        placeholder: providerOnboardingInfo(state.selectedProvider).access === "api-key"
          ? "Choose an option, or paste a key"
          : "Choose an option",
        footerHint: CHOOSE_FOOTER,
        allowEmptySubmit: true,
      };
    case "ready":
      return {
        placeholder: "Enter starts AgenC",
        footerHint: "Enter start AgenC · /exit leave setup",
        allowEmptySubmit: true,
      };
  }
}

export interface OnboardingProps {
  readonly state: FirstRunOnboardingState;
  readonly steps: readonly FirstRunOnboardingStep[];
  readonly currentStep: FirstRunOnboardingStep;
  readonly context: FirstRunOnboardingContext;
}

/** Narrowest and widest the setup card gets. */
const MIN_CARD_WIDTH = 44;
const MAX_CARD_WIDTH = 76;
const MIN_LABEL_WIDTH = 12;

/**
 * The top border of a setup card: the step title in bold on the left, the
 * step counter muted on the right, border line between them. Built as one
 * string because the border renderer embeds a single text.
 */
function setupCardBorderTitle(
  title: string,
  counter: string,
  cardWidth: number,
  themeName: ThemeName,
): string {
  const theme = getTheme(themeName);
  const left = ` ${title} `;
  const right = ` ${counter} `;
  // Corners and one border cell on each side of the embedded text.
  const fill = Math.max(1, cardWidth - 4 - left.length - right.length);
  return (
    applyTextStyles(left, { bold: true, color: theme.text as Color }) +
    applyTextStyles("─".repeat(fill), { color: theme.subtle as Color }) +
    applyTextStyles(right, { color: theme.inactive as Color })
  );
}

function SetupCardRow({
  row,
  labelWidth,
}: {
  readonly row: OnboardingCardRow;
  readonly labelWidth: number;
}): React.ReactElement {
  switch (row.kind) {
    case "choice":
      return (
        <Box flexDirection="row">
          <Box width={labelWidth + 2} flexShrink={0}>
            <ThemedText
              color={row.selected ? "text" : "text2"}
              bold={row.selected}
              wrap="truncate-end"
            >
              {`${row.selected ? "›" : " "} ${row.label}`}
            </ThemedText>
          </Box>
          <ThemedText color={row.selected ? "text2" : "inactive"} wrap="truncate-end">
            {row.note}
          </ThemedText>
        </Box>
      );
    case "more":
      return <ThemedText color="inactive">{`  ${row.text}`}</ThemedText>;
    case "kv":
      return (
        <Box flexDirection="row">
          <Box width={labelWidth} flexShrink={0}>
            <ThemedText color="text" bold>
              {row.label}
            </ThemedText>
          </Box>
          <ThemedText color="text2" wrap="truncate-middle">
            {row.value}
          </ThemedText>
        </Box>
      );
    case "status":
      return (
        <ThemedText color="text" bold>
          {`${row.ok ? "✓" : "✗"} ${row.text}`}
        </ThemedText>
      );
    case "text":
      return (
        <ThemedText color={row.strong ? "text" : "text2"} bold={row.strong === true}>
          {row.text}
        </ThemedText>
      );
    case "gap":
      return <Box height={1} />;
  }
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
  const [themeName, setThemeSetting] = useTheme();
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
  const cardWidth = Math.max(MIN_CARD_WIDTH, Math.min(MAX_CARD_WIDTH, columns - 2));
  const view = onboardingCardView(state, context);
  const stepNumber = Math.max(1, steps.findIndex((step) => step.id === currentStep.id) + 1);
  const borderTitle = setupCardBorderTitle(
    currentStep.title,
    `${stepNumber} of ${steps.length}`,
    cardWidth,
    themeName,
  );
  const labelWidth = Math.max(
    MIN_LABEL_WIDTH,
    ...view.rows.map((row) =>
      row.kind === "choice" || row.kind === "kv" ? row.label.length + 2 : 0
    ),
  );

  // Terminals can't change font size, so hierarchy comes from weight and ink:
  // the step title sits in the border in bold, the question is full ink, the
  // highlighted choice is bold, values and notes are a step down, and hints
  // and the step counter are muted. Same card language as the trust prompt.
  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <ThemedText color="text" bold>
        agenc.
      </ThemedText>
      <ThemedText color="inactive">
        Set up once, then start working. Change anything later with /config.
      </ThemedText>
      <ThemedBox
        flexDirection="column"
        width={cardWidth}
        borderStyle="round"
        borderColor="subtle"
        borderText={{ content: borderTitle, position: "top", align: "start", offset: 1 }}
        paddingX={2}
        paddingY={1}
        marginTop={1}
      >
        <ThemedText color="text">{view.lead}</ThemedText>
        {view.rows.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {view.rows.map((row, index) => (
              <SetupCardRow key={`${row.kind}-${index}`} row={row} labelWidth={labelWidth} />
            ))}
          </Box>
        ) : null}
        {view.hint !== undefined ? (
          <Box marginTop={1}>
            <ThemedText color="inactive">{view.hint}</ThemedText>
          </Box>
        ) : null}
        {state.error !== null ? (
          <Box marginTop={1}>
            <ThemedText color="warning">{state.error}</ThemedText>
          </Box>
        ) : null}
      </ThemedBox>
    </Box>
  );
}
