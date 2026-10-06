/**
 * /grok-login and /grok-logout — Sign in with X / xAI OAuth for
 * subscription-based Grok access (SuperGrok / X Premium), no XAI_API_KEY.
 *
 * Browser PKCE with a loopback callback is the primary flow (it carries the
 * `referrer=agenc` attribution xAI asked for); RFC 8628 device code is the
 * headless fallback (`/grok-login device`, or automatic when the loopback
 * port is unavailable). The consent screen may be labeled "Grok Build"
 * because xAI's shared CLI OAuth client is used.
 */

import { env as hostEnv } from "../utils/env.js";
import {
  clearXaiOauthCredentials,
  readXaiOauthCredentials,
} from "../utils/xaiOauthCredentials.js";
import { resolveApiKey } from "../config/env.js";
import {
  providerEnvironmentFromCommandContext,
  requireCommandConfigStore,
} from "./config-context.js";
import { signInToProvider } from "./provider-sign-in.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export const grokLoginCommand: SlashCommand = {
  name: "grok-login",
  aliases: ["xai-login"],
  description: "Sign in with your X / xAI account to use Grok",
  immediate: true,
  supportsNonInteractive: false,
  execute: async (ctx) => executeGrokLogin(ctx),
};

export const grokLogoutCommand: SlashCommand = {
  name: "grok-logout",
  aliases: ["xai-logout"],
  description: "Sign out of the X / xAI account used for Grok",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx) =>
    safeExecute(async () => {
      const home = requireCommandConfigStore(ctx).homeContext;
      const existing = readXaiOauthCredentials(home);
      if (existing === undefined) {
        return { kind: "text", text: "No xAI sign-in stored." };
      }
      const result = clearXaiOauthCredentials(home);
      if (!result.success) {
        return {
          kind: "error",
          message: `Could not clear xAI sign-in: ${result.warning ?? "unknown error"}`,
        };
      }
      const label = existing.accountLabel ? ` (${existing.accountLabel})` : "";
      return {
        kind: "text",
        text: `Signed out of xAI${label}. Local tokens were deleted.`,
      };
    }),
};

export const xaiAuthCommands: readonly SlashCommand[] = [
  grokLoginCommand,
  grokLogoutCommand,
];

async function executeGrokLogin(
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  return safeExecute(async () => {
    const home = requireCommandConfigStore(ctx).homeContext;
    const environment = providerEnvironmentFromCommandContext(ctx);
    const arg = ctx.argsRaw.trim().toLowerCase();
    if (arg !== "" && arg !== "device") {
      return {
        kind: "error",
        message: "Usage: /grok-login [device]",
      };
    }

    // Keep notices synchronous after loading so cancellation and browser
    // fallback cannot paint a notice after the login has completed.
    const showLoginNotice = typeof ctx.appState?.setToolJSX === "function"
      ? (await import("./xai-auth-menu.js")).showLoginNotice
      : () => {};
    const controller = new AbortController();
    const onCancel = () => controller.abort();
    let result;
    try {
      // The browser flow redirects to 127.0.0.1 on THIS machine and opens
      // the browser on THIS machine's desktop. Over SSH the user sees
      // neither, so a remote session goes straight to the device code.
      result = await signInToProvider({
        provider: "grok",
        home,
        environment,
        signal: controller.signal,
        device: arg === "device",
        canOpenBrowser: !hostEnv.isSSH(),
        onProgress: (progress) => {
          showLoginNotice(ctx, {
            heading: progress.heading,
            url: progress.url ?? "",
            ...(progress.userCode === undefined ? {} : { userCode: progress.userCode }),
            onCancel,
          });
        },
      });
    } finally {
      clearLoginNotice(ctx);
    }
    if (!result.ok) {
      return result.cancelled
        ? { kind: "text", text: "xAI sign-in cancelled." }
        : { kind: "error", message: result.message };
    }

    const lines = [
      `Signed in to xAI as ${result.account}.`,
      "Open /providers to use Grok with this account.",
      "Unless auth is set to api-key, this sign-in is used before any " +
        "XAI_API_KEY / GROK_API_KEY in the environment (subscription Grok Build access).",
    ];
    if (resolveApiKey(environment) !== undefined) {
      lines.push(
        "Note: an API key is also set in the environment. /grok-logout to fall back to API-key billing.",
      );
    }
    lines.push(
      "If requests fail with 403 'no active Grok subscription', make sure " +
        "your X and grok.com accounts use the same email.",
    );
    return { kind: "text", text: lines.join("\n") };
  });
}

function clearLoginNotice(ctx: SlashCommandContext): void {
  ctx.appState?.setToolJSX?.({
    jsx: null,
    shouldHidePromptInput: false,
    clearLocalJSX: true,
  });
}
