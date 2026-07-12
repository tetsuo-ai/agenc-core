import { spawn } from "node:child_process";

import type { AuthBackend, AuthIdentity, AuthLlmUsage } from "../auth/backend.js";
import { createAuthBackend } from "../auth/selection.js";
import { resolveAgencHome } from "../config/env.js";
import { normalizeProviderSlug } from "../config/resolve-provider.js";
import { defaultConfig } from "../config/schema.js";
import { Box, Text } from "../tui/ink.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { applyProviderSwitch } from "./provider.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import {
  SUBSCRIPTION_MANAGED_DEFAULT_PROVIDER,
  hasHostedManagedAccess,
  subscriptionManagedDefaultModel,
  subscriptionManagedDefaultModelForTier,
  visibleSubscriptionManagedModelsForTier,
} from "./subscription-managed-models.js";

type AuthAction = "login" | "logout" | "whoami" | "subscription" | "usage";

const TUI_AUTH_SESSION_ID = "tui" as const;
const SUBSCRIPTION_URL = "https://id.agenc.ag/subscription" as const;

export const loginCommand: SlashCommand = {
  name: "login",
  description: "Sign in with your AgenC account",
  immediate: true,
  supportsNonInteractive: false,
  execute: async (ctx) => executeAuthCommand("login", ctx),
};

export const logoutCommand: SlashCommand = {
  name: "logout",
  description: "Sign out of your AgenC account",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx) => executeAuthCommand("logout", ctx),
};

export const whoamiCommand: SlashCommand = {
  name: "whoami",
  aliases: ["account"],
  description: "Show the signed-in AgenC account",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx) => executeAuthCommand("whoami", ctx),
};

export const subscriptionCommand: SlashCommand = {
  name: "subscription",
  aliases: ["billing"],
  description: "Show your AgenC plan and billing URL",
  immediate: true,
  supportsNonInteractive: false,
  execute: async (ctx) => executeAuthCommand("subscription", ctx),
};

export const usageCommand: SlashCommand = {
  name: "usage",
  description: "Show hosted model usage for your AgenC plan",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx) => executeAuthCommand("usage", ctx),
};

export const authCommands: readonly SlashCommand[] = [
  loginCommand,
  logoutCommand,
  whoamiCommand,
  subscriptionCommand,
  usageCommand,
];

async function executeAuthCommand(
  action: AuthAction,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  return safeExecute(async () => {
    if (ctx.argsRaw.trim().length > 0) {
      return {
        kind: "error",
        message: `Usage: /${action}`,
      };
    }

    const backend = createSlashAuthBackend(ctx);

    if (action === "login") {
      let result: Awaited<ReturnType<AuthBackend["login"]>>;
      try {
        result = await backend.login({ sessionId: TUI_AUTH_SESSION_ID });
      } finally {
        clearLocalAuthNotice(ctx);
      }
      const tier = await resolveSubscriptionTier(backend);
      const routeMessage = await maybeSelectHostedSubscriptionRoute(ctx, tier);
      return {
        kind: "text",
        text:
          `Logged in as ${formatAgenCAuthIdentity(result.identity)}` +
          formatSubscriptionStatus(tier) +
          (routeMessage !== undefined ? `\n${routeMessage}` : ""),
      };
    }

    if (action === "logout") {
      await backend.logout({ sessionId: TUI_AUTH_SESSION_ID });
      return {
        kind: "text",
        text: "Logged out. Saved BYOK provider keys were kept.",
      };
    }

    const result = await backend.whoami({ sessionId: TUI_AUTH_SESSION_ID });
    if (!result.authenticated) {
      return {
        kind: "text",
        text: "Not logged in. Run /login to sign in with Google.",
      };
    }

    const tier = await resolveSubscriptionTier(backend);
    if (action === "subscription") {
      return {
        kind: "text",
        text: formatSubscriptionCommandResult(tier),
      };
    }
    if (action === "usage") {
      const usage = await resolveLlmUsage(backend);
      return {
        kind: "text",
        text: formatUsageCommandResult(usage.usage, tier, usage.error),
      };
    }

    return {
      kind: "text",
      text: `${formatAgenCAuthIdentity(result.identity)}${formatSubscriptionStatus(tier)}`,
    };
  });
}

function managedSubscriptionTier(
  tier: string | undefined,
): tier is "free" | "pro" | "team" | "enterprise" {
  return tier === "free" || tier === "pro" || tier === "team" || tier === "enterprise";
}

function readSessionProvider(ctx: SlashCommandContext): string | undefined {
  const peekState = (ctx.session as unknown as {
    state?: { unsafePeek?: () => unknown };
  }).state?.unsafePeek;
  const rawState =
    typeof peekState === "function"
      ? (peekState.call((ctx.session as unknown as { state?: unknown }).state) as {
          sessionConfiguration?: {
            provider?: { slug?: string };
          };
        })
      : null;
  const directConfig = (ctx.session as unknown as {
    sessionConfiguration?: {
      provider?: { slug?: string };
    };
  }).sessionConfiguration;
  return rawState?.sessionConfiguration?.provider?.slug ??
    directConfig?.provider?.slug;
}

async function maybeSelectHostedSubscriptionRoute(
  ctx: SlashCommandContext,
  tier: string | undefined,
): Promise<string | undefined> {
  if (!managedSubscriptionTier(tier)) return undefined;
  const config = ctx.configStore?.current() ?? defaultConfig();
  if (!hasHostedManagedAccess(config, process.env)) return undefined;

  const currentProvider =
    normalizeProviderSlug(readSessionProvider(ctx)) ??
    normalizeProviderSlug(config.model_provider) ??
    "grok";
  if (currentProvider === SUBSCRIPTION_MANAGED_DEFAULT_PROVIDER) {
    return undefined;
  }

  const configuredProvider = normalizeProviderSlug(config.model_provider);
  if (
    configuredProvider !== undefined &&
    configuredProvider !== "grok" &&
    configuredProvider !== SUBSCRIPTION_MANAGED_DEFAULT_PROVIDER
  ) {
    return (
      "Hosted models ready through OpenRouter. Your configured provider was kept; " +
      "run /provider openrouter to switch."
    );
  }

  if (currentProvider !== "grok") {
    return (
      "Hosted models ready through OpenRouter. Your current provider was kept; " +
      "run /provider openrouter to switch."
    );
  }

  const defaultModel = subscriptionManagedDefaultModelForTier(
    SUBSCRIPTION_MANAGED_DEFAULT_PROVIDER,
    tier,
  );
  if (defaultModel === undefined) return undefined;
  const summary = await applyProviderSwitch(
    ctx.session,
    SUBSCRIPTION_MANAGED_DEFAULT_PROVIDER,
    defaultModel,
  );
  if (!summary.startsWith("Provider switched ") && !summary.startsWith("Provider switch staged:")) {
    return `Hosted models ready, but the automatic OpenRouter switch was blocked: ${summary}`;
  }
  updateHostedRouteChrome(ctx, defaultModel);
  return (
    `Hosted ${tier === "free" ? "free " : ""}route selected: ${SUBSCRIPTION_MANAGED_DEFAULT_PROVIDER} / ` +
    `${defaultModel}. Run /model to choose another hosted model.`
  );
}

function updateHostedRouteChrome(
  ctx: SlashCommandContext,
  model: string,
): void {
  if (typeof ctx.appState?.setAppState === "function") {
    ctx.appState.setAppState((prev: unknown): unknown => {
      if (typeof prev !== "object" || prev === null) return prev;
      return {
        ...prev,
        mainLoopModel: model,
        mainLoopModelForSession: model,
      };
    });
    return;
  }
  ctx.appState?.setModel?.(model);
}

function createSlashAuthBackend(ctx: SlashCommandContext): AuthBackend {
  const agencHome = ctx.agencHome ?? resolveAgencHome(process.env);
  const config = ctx.configStore?.current() ?? defaultConfig();
  return createAuthBackend(config, {
    agencHome,
    env: process.env,
    remote: {
      onDeviceCode: async ({ verificationUri, userCode }) => {
        if (verificationUri === undefined) return;
        showBrowserLoginNotice(ctx, verificationUri, userCode);
        try {
          await openUrlInBrowser(verificationUri);
        } catch {
          showCopyUrlLoginNotice(ctx, verificationUri, userCode);
        }
      },
    },
  });
}

async function resolveSubscriptionTier(
  backend: AuthBackend,
): Promise<string | undefined> {
  try {
    return await backend.getSubscriptionTier({ sessionId: TUI_AUTH_SESSION_ID });
  } catch {
    return undefined;
  }
}

async function resolveLlmUsage(
  backend: AuthBackend,
): Promise<{
  readonly error?: string;
  readonly usage?: AuthLlmUsage;
}> {
  try {
    return { usage: await backend.getLlmUsage({ sessionId: TUI_AUTH_SESSION_ID }) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function showBrowserLoginNotice(
  ctx: SlashCommandContext,
  url: string,
  userCode: string | undefined,
): void {
  openLocalJsxCommand(
    ctx,
    () => (
      <Box flexDirection="column" paddingX={1} borderStyle="round">
        <Text>Sign in with Google to continue.</Text>
        <Text dimColor>Browser opened. Finish sign in there, then return here.</Text>
        {userCode ? <Text dimColor>Code: {userCode}</Text> : null}
        <Text dimColor>URL: {url}</Text>
      </Box>
    ),
    { shouldHidePromptInput: false },
  );
}

function showCopyUrlLoginNotice(
  ctx: SlashCommandContext,
  url: string,
  userCode: string | undefined,
): void {
  openLocalJsxCommand(
    ctx,
    () => (
      <Box flexDirection="column" paddingX={1} borderStyle="round">
        <Text>Sign in with Google to continue.</Text>
        <Text dimColor>Open this URL in your browser:</Text>
        {userCode ? <Text dimColor>Code: {userCode}</Text> : null}
        <Text dimColor>URL: {url}</Text>
      </Box>
    ),
    { shouldHidePromptInput: false },
  );
}

function clearLocalAuthNotice(ctx: SlashCommandContext): void {
  ctx.appState?.setToolJSX?.({
    jsx: null,
    shouldHidePromptInput: false,
    clearLocalJSX: true,
  });
}

export async function openUrlInBrowser(url: string): Promise<void> {
  const { command, args } = browserOpenCommand(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function browserOpenCommand(url: string): {
  readonly command: string;
  readonly args: readonly string[];
} {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

function formatAgenCAuthIdentity(identity: AuthIdentity | undefined): string {
  if (identity === undefined) return "AgenC user";
  const name =
    identity.displayName?.trim() ||
    identity.email?.trim() ||
    identity.accountId?.trim() ||
    "AgenC user";
  const detail = [
    identity.accountId?.trim() ? `id=${identity.accountId.trim()}` : undefined,
    identity.email?.trim() ? `email=${identity.email.trim()}` : undefined,
    identity.plan?.trim() ? `plan=${identity.plan.trim()}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return detail.length > 0 ? `${name} (${detail.join(", ")})` : name;
}

function formatSubscriptionStatus(tier: string | undefined): string {
  if (tier === undefined) return "";
  if (tier === "pro" || tier === "team" || tier === "enterprise") {
    return ` · plan=${tier} · managed keys available`;
  }
  return ` · plan=${tier} · managed keys require Pro (https://id.agenc.ag/pricing)`;
}

export function formatSubscriptionCommandResult(tier: string | undefined): string {
  const plan = tier ?? "unknown";
  const lines = [
    `Plan: ${plan}`,
    `Billing: ${SUBSCRIPTION_URL}`,
  ];
  if (plan === "pro" || plan === "team" || plan === "enterprise") {
    const provider = "openrouter";
    const models = visibleSubscriptionManagedModelsForTier(provider, plan);
    const defaultModel = subscriptionManagedDefaultModel(provider);
    lines.push(
      "Managed models: enabled",
      "Model access: hosted by AgenC",
      `Available models: ${models.length} managed OpenRouter routes`,
      defaultModel !== undefined
        ? `Default route: /model ${provider}:${defaultModel}`
        : "Default route: run /provider",
      "Choose/switch models with /provider.",
    );
  } else if (plan === "free") {
    const provider = "openrouter";
    const models = visibleSubscriptionManagedModelsForTier(provider, "free");
    if (models.length > 0) {
      const defaultModel = subscriptionManagedDefaultModelForTier(provider, "free");
      lines.push(
        "Free hosted models: enabled",
        "Paid model allowance: upgrade to Pro",
        `Available free models: ${models.length} OpenRouter routes`,
        defaultModel !== undefined
          ? `Default free route: /model ${provider}:${defaultModel}`
          : "Default free route: run /provider",
        "BYOK still works without a subscription.",
      );
    } else {
      lines.push(
        "Managed model access requires Pro or higher.",
        "BYOK still works without a subscription.",
      );
    }
  } else {
    lines.push(
      "Managed model access requires Pro or higher.",
      "BYOK still works without a subscription.",
    );
  }
  return lines.join("\n");
}

export function formatUsageCommandResult(
  usage: AuthLlmUsage | undefined,
  fallbackTier: string | undefined,
  error?: string,
): string {
  if (usage === undefined) {
    return [
      `Plan: ${fallbackTier ?? "unknown"}`,
      "Managed model usage is temporarily unavailable.",
      ...(error !== undefined ? [`Reason: ${error}`] : []),
      `Billing: ${SUBSCRIPTION_URL}`,
    ].join("\n");
  }

  const allowance = usage.modelAllowance;
  const lines = [
    `Plan: ${usage.subscriptionTier}`,
    `Managed models: ${usage.managedModelsEnabled ? "enabled" : "not enabled"}`,
  ];

  if (
    allowance.status === "free" &&
    usage.managedModelsEnabled &&
    allowance.allowedModelCount > 0
  ) {
    lines.push(
      "Free hosted models: enabled",
      "Paid usage: not active",
      `Models: ${allowance.allowedModelCount} free hosted routes`,
      "Free hosted routes do not consume Pro usage allowance.",
      `Billing: ${SUBSCRIPTION_URL}`,
    );
    return lines.join("\n");
  }

  if (!usage.managedModelsEnabled || allowance.status === "free") {
    lines.push(
      "Hosted model usage requires Pro or higher.",
      "BYOK still works without a subscription.",
      `Billing: ${SUBSCRIPTION_URL}`,
    );
    return lines.join("\n");
  }

  if (allowance.status === "unavailable") {
    lines.push("Usage: temporarily unavailable");
  } else {
    if (allowance.status === "pending") {
      lines.push("Usage: ready, no hosted model usage yet");
    } else {
      lines.push(`Usage: ${allowance.status}`);
    }
    if (allowance.includedUsd !== undefined) {
      lines.push(`Included usage: ${formatUsd(allowance.includedUsd)}`);
    }
    if (allowance.usedUsd !== undefined) {
      lines.push(`Used: ${formatUsd(allowance.usedUsd)}`);
    }
    if (allowance.remainingUsd !== undefined) {
      lines.push(`Remaining: ${formatUsd(allowance.remainingUsd)}`);
    }
    if (allowance.percentUsed !== undefined) {
      lines.push(`Used percent: ${formatPercent(allowance.percentUsed)}`);
    }
  }

  if (allowance.resetsAt !== undefined) {
    lines.push(`Resets: ${formatDate(allowance.resetsAt)}`);
  }
  lines.push(
    `Models: ${allowance.allowedModelCount} hosted routes`,
    "Token counts vary by model, so usage is tracked as included USD.",
  );
  return lines.join("\n");
}

function formatUsd(value: number): string {
  const decimals = value > 0 && value < 1 ? 4 : 2;
  return `$${value.toFixed(decimals)}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return parsed.toISOString();
}
