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
import {
  BUILT_IN_PROVIDER_API_KEY_ENVS,
  BUILT_IN_PROVIDER_BASE_URLS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  listBuiltInProviderInfo,
  normalizeBuiltInProviderSlug,
  type BuiltInProviderSlug,
} from "../llm/registry/provider-info.js";
import {
  incrementFirstRunOnboardingSeenCount,
  markFirstRunOnboardingComplete,
  shouldShowFirstRunOnboarding,
  type OnboardingEnv,
} from "./projectOnboardingState.js";
import { OnboardingBox as Box, OnboardingText as Text } from "./elements.js";
import { WelcomeV2 } from "./WelcomeV2.js";

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
  | "local-down"
  | "unknown-provider";

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
}

export interface FirstRunOnboardingState {
  readonly currentStepId: FirstRunOnboardingStepId;
  readonly completedStepIds: readonly FirstRunOnboardingStepId[];
  readonly selectedTheme: string;
  readonly selectedProvider: BuiltInProviderSlug;
  readonly selectedModel: string;
  readonly connection: ProviderConnectionCheck | null;
  readonly error: string | null;
  readonly isCheckingConnection: boolean;
}

export interface FirstRunOnboardingContext {
  readonly agencHome?: string;
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
  readonly onComplete?: (state: FirstRunOnboardingState) => void;
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
  "connection-test",
  "api-key",
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

export function buildFirstRunOnboardingSteps(
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
  const settings = resolveProviderSettings(provider, config, env);
  return settings?.defaultModel ?? BUILT_IN_PROVIDER_DEFAULT_MODELS[provider];
}

function initialProvider(
  config: AgenCConfig,
  env: OnboardingEnv | undefined,
): BuiltInProviderSlug {
  return (
    resolveProviderSelection({
      config,
      env,
      fallback: "grok",
    }) ?? "grok"
  );
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
    error: null,
    isCheckingConnection: false,
  };
}

export function providerChoices(): readonly BuiltInProviderSlug[] {
  const preferredOrder: readonly BuiltInProviderSlug[] = Object.freeze([
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
  ]);
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

function parseProvider(raw: string, current: BuiltInProviderSlug): BuiltInProviderSlug | null {
  const input = raw.trim().toLowerCase();
  if (input === "" || input === "next") return current;
  const choices = providerChoices();
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
  raw: string,
  context: FirstRunOnboardingContext,
): Promise<FirstRunOnboardingSubmitResult> {
  switch (state.currentStepId) {
    case "preflight":
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
      const provider = parseProvider(raw, state.selectedProvider);
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
          },
          "provider",
          "connection-test",
        ),
        completed: false,
      };
    }
    case "connection-test": {
      const command = raw.trim().toLowerCase();
      if (command !== "" && command !== "next" && command !== "test") {
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
          "api-key",
        ),
        completed: false,
      };
    }
    case "api-key":
      return {
        state: withCompletedStep(state, "api-key", "security"),
        completed: false,
      };
    case "security":
      return {
        state: withCompletedStep(state, "security", "terminal-setup"),
        completed: false,
      };
    case "terminal-setup":
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
    if (!active || recordedSeen.current || options.agencHome === undefined) {
      return;
    }
    recordedSeen.current = true;
    incrementFirstRunOnboardingSeenCount({ agencHome: options.agencHome });
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
          setActive(false);
          options.onComplete?.(nextState);
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

function detailLinesForStep(
  state: FirstRunOnboardingState,
  context: FirstRunOnboardingContext,
): readonly string[] {
  switch (state.currentStepId) {
    case "preflight":
      return [
        `Workspace: ${context.cwd ?? process.cwd()}`,
        `AgenC home: ${context.agencHome ?? "not configured"}`,
        "Type next to continue.",
      ];
    case "theme":
      return [
        ...THEME_CHOICES.map((theme, index) =>
          `${index + 1}. ${theme}${theme === state.selectedTheme ? " (current)" : ""}`
        ),
        "Type a number or theme name.",
      ];
    case "provider":
      return [
        ...providerChoices().map((provider, index) =>
          `${index + 1}. ${provider}${provider === state.selectedProvider ? " (current)" : ""}`
        ),
        "Type a number or provider slug.",
      ];
    case "connection-test":
      return state.isCheckingConnection
        ? ["Checking provider readiness..."]
        : [
            `Provider: ${state.selectedProvider}`,
            `Model: ${state.selectedModel}`,
            "Type test or next to run the connection check.",
          ];
    case "api-key": {
      const connection = state.connection;
      if (connection === null) {
        return ["Connection check has not run yet. Type next to continue."];
      }
      return [
        connection.detail,
        connection.keyEnvVar === undefined
          ? "Type next to continue."
          : `Type next after setting ${connection.keyEnvVar}, or continue and add it later.`,
      ];
    }
    case "security":
      return [
        `Permission mode: ${context.permissionMode ?? "default"}`,
        `Sandbox: ${context.sandboxMode ?? "workspace-write"}`,
        "Type next to keep these defaults.",
      ];
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
        {detailLinesForStep(state, context).map((line) => (
          <Text key={line} dimColor>{line}</Text>
        ))}
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

export default Onboarding;
