import { spawn } from "node:child_process";

import type { AuthBackend, AuthIdentity } from "../auth/backend.js";
import { createAuthBackend } from "../auth/selection.js";
import { resolveAgencHome } from "../config/env.js";
import { defaultConfig } from "../config/schema.js";
import { Box, Text } from "../tui/ink.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

type AuthAction = "login" | "logout" | "whoami";

const TUI_AUTH_SESSION_ID = "tui" as const;

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

export const authCommands: readonly SlashCommand[] = [
  loginCommand,
  logoutCommand,
  whoamiCommand,
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
      return {
        kind: "text",
        text: `Logged in as ${formatAgenCAuthIdentity(result.identity)}`,
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
    return {
      kind: "text",
      text: `${formatAgenCAuthIdentity(result.identity)}${formatSubscriptionStatus(tier)}`,
    };
  });
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

async function openUrlInBrowser(url: string): Promise<void> {
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
