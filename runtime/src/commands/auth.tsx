import type {
  AuthBackend,
  AuthIdentity,
} from "../auth/backend.js";
import { createAuthBackend } from "../auth/selection.js";

import { defaultConfig } from "../config/schema.js";

import { openLocalBrowser } from "../utils/browser.js";
import {
  providerEnvironmentFromCommandContext,
  requireCommandConfigStore,
} from "./config-context.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

type AuthAction = "login" | "logout" | "whoami" | "subscription";

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
  description: "Show connected provider usage and balances",
  argumentHint: "[provider]",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx) => executeUsageCommand(ctx),
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

    const controller = action === "login" ? new AbortController() : undefined;
    const backend = createSlashAuthBackend(ctx, controller);

    if (action === "login") {
      let result: Awaited<ReturnType<AuthBackend["login"]>>;
      try {
        result = await backend.login({ sessionId: TUI_AUTH_SESSION_ID });
      } catch (error) {
        if (controller?.signal.aborted) return { kind: "text", text: "Google sign-in cancelled." };
        throw error;
      } finally {
        clearLocalAuthNotice(ctx);
      }
      const tier = await resolveSubscriptionTier(backend);
      return {
        kind: "text",
        text:
          `Logged in as ${formatAgenCAuthIdentity(result.identity)}` +
          formatSubscriptionStatus(tier),
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

    return {
      kind: "text",
      text: `${formatAgenCAuthIdentity(result.identity)}${formatSubscriptionStatus(tier)}`,
    };
  });
}

/**
 * `/usage` shows every connected provider with a usage
 * API, fetched together. `/usage <provider>` shows one provider in detail.
 */
async function executeUsageCommand(
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  return safeExecute(async () => {
    const args = ctx.argsRaw.trim().split(/\s+/u).filter((part) => part.length > 0);
    if (args.length > 1) {
      return { kind: "error", message: "Usage: /usage [provider]" };
    }
    const providerUsage = await import("./provider-usage.js");
    const [provider] = args;
    if (provider !== undefined) {
      return await providerUsage.readProviderUsageDetail(ctx, provider);
    }
    const providers = await providerUsage.readProviderUsageSection(ctx);
    return {
      kind: "text",
      text: providers,
    };
  });
}

function createSlashAuthBackend(ctx: SlashCommandContext, controller?: AbortController): AuthBackend {
  const configStore = requireCommandConfigStore(ctx);
  const agencHome = configStore.homeContext.path;
  const config = configStore.current() ?? defaultConfig();
  return createAuthBackend(config, {
    agencHome,
    env: providerEnvironmentFromCommandContext(ctx),
    remote: {
      loginSignal: controller?.signal,
      onDeviceCode: async ({ verificationUri, userCode }) => {
        if (verificationUri === undefined || controller?.signal.aborted) return;
        const notices = typeof ctx.appState?.setToolJSX === "function"
          ? await import("./auth-menu.js")
          : undefined;
        if (controller?.signal.aborted) return;
        const onCancel = controller === undefined ? undefined : () => controller.abort();
        notices?.showBrowserLoginNotice(ctx, verificationUri, userCode, onCancel);
        try {
          await openUrlInBrowser(verificationUri);
        } catch {
          if (!controller?.signal.aborted) notices?.showCopyUrlLoginNotice(ctx, verificationUri, userCode, onCancel);
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

function clearLocalAuthNotice(ctx: SlashCommandContext): void {
  ctx.appState?.setToolJSX?.({
    jsx: null,
    shouldHidePromptInput: false,
    clearLocalJSX: true,
  });
}

export async function openUrlInBrowser(url: string): Promise<void> {
  await openLocalBrowser(url);
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
  return ` · plan=${tier}`;
}

export function formatSubscriptionCommandResult(tier: string | undefined): string {
  const plan = tier ?? "unknown";
  const lines = [
    `Plan: ${plan}`,
    `Billing: ${SUBSCRIPTION_URL}`,
  ];
  return lines.join("\n");
}
