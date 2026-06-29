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
      const result = await backend.login({ sessionId: TUI_AUTH_SESSION_ID });
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
      text: `${formatAgenCAuthIdentity(result.identity)}${
        tier ? ` · tier=${tier}` : ""
      }`,
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
      onDeviceCode: async ({ verificationUri }) => {
        if (verificationUri === undefined) return;
        showBrowserLoginNotice(ctx, verificationUri);
        try {
          await openUrlInBrowser(verificationUri);
        } catch {
          showCopyUrlLoginNotice(ctx, verificationUri);
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

function showBrowserLoginNotice(ctx: SlashCommandContext, url: string): void {
  openLocalJsxCommand(
    ctx,
    () => (
      <Box flexDirection="column" paddingX={1} borderStyle="round">
        <Text>Sign in with Google to continue.</Text>
        <Text dimColor>Browser opened. Finish sign in there, then return here.</Text>
        <Text dimColor wrap="truncate">
          {url}
        </Text>
      </Box>
    ),
    { shouldHidePromptInput: false },
  );
}

function showCopyUrlLoginNotice(ctx: SlashCommandContext, url: string): void {
  openLocalJsxCommand(
    ctx,
    () => (
      <Box flexDirection="column" paddingX={1} borderStyle="round">
        <Text>Sign in with Google to continue.</Text>
        <Text dimColor>Open this URL in your browser:</Text>
        <Text dimColor wrap="truncate">
          {url}
        </Text>
      </Box>
    ),
    { shouldHidePromptInput: false },
  );
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
