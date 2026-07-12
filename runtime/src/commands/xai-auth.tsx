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

import { Box, Text } from "../tui/ink.js";
import {
  runXaiBrowserLogin,
  runXaiDeviceLogin,
  XaiOauthError,
  type XaiBrowserLoginResult,
} from "../services/xai/oauth.js";
import {
  clearXaiOauthCredentials,
  readXaiOauthCredentials,
  saveXaiOauthCredentials,
  xaiOauthTokensToBlob,
} from "../utils/xaiOauthCredentials.js";
import { resolveApiKey } from "../config/env.js";
import { openUrlInBrowser } from "./auth.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { applyProviderSwitch } from "./provider.js";
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
  execute: async () =>
    safeExecute(async () => {
      const existing = readXaiOauthCredentials();
      if (existing === undefined) {
        return { kind: "text", text: "No xAI sign-in stored." };
      }
      const result = clearXaiOauthCredentials();
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
    const arg = ctx.argsRaw.trim().toLowerCase();
    if (arg !== "" && arg !== "device") {
      return {
        kind: "error",
        message: "Usage: /grok-login [device]",
      };
    }

    let login: XaiBrowserLoginResult;
    try {
      login = arg === "device"
        ? await runDeviceFlow(ctx)
        : await runBrowserFlowWithDeviceFallback(ctx);
    } finally {
      clearLoginNotice(ctx);
    }

    const blob = xaiOauthTokensToBlob(login.tokens, {
      tokenEndpoint: login.tokenEndpoint,
    });
    const saved = saveXaiOauthCredentials(blob);
    if (!saved.success) {
      return {
        kind: "error",
        message: `Signed in, but storing tokens failed: ${saved.warning ?? "unknown error"}`,
      };
    }

    const who = blob.accountLabel ?? login.identity.sub ?? "xAI account";
    const lines = [`Signed in to xAI as ${who}.`];

    // OAuth always wins over env BYOK — switch to grok regardless of keys.
    const switchSummary = await applyProviderSwitch(ctx.session, "grok");
    lines.push(switchSummary);
    lines.push("Run /model to pick a Grok model (e.g. grok-4.5).");
    lines.push(
      "This sign-in takes precedence over any XAI_API_KEY / GROK_API_KEY " +
        "in the environment (subscription Grok Build access).",
    );
    const envKey = resolveApiKey(process.env);
    if (envKey !== undefined) {
      lines.push(
        "Note: an API key is also set in the environment but is ignored " +
          "while you are signed in. /grok-logout to fall back to API-key billing.",
      );
    }
    lines.push(
      "If requests fail with 403 'no active Grok subscription', make sure " +
        "your X and grok.com accounts use the same email.",
    );
    return { kind: "text", text: lines.join("\n") };
  });
}

async function runBrowserFlowWithDeviceFallback(
  ctx: SlashCommandContext,
): Promise<XaiBrowserLoginResult> {
  try {
    return await runXaiBrowserLogin({
      onAuthorizeUrl: async (url) => {
        showLoginNotice(ctx, {
          heading: "Sign in with your X / xAI account to continue.",
          url,
        });
        try {
          await openUrlInBrowser(url);
        } catch {
          showLoginNotice(ctx, {
            heading: "Open this URL in your browser to sign in:",
            url,
          });
        }
      },
    });
  } catch (error) {
    // Loopback unavailable (e.g. the Grok CLI holds port 56121, or a
    // headless host): fall back to the device-code flow.
    if (error instanceof XaiOauthError && error.code === "callback_failed") {
      return runDeviceFlow(ctx);
    }
    throw error;
  }
}

async function runDeviceFlow(
  ctx: SlashCommandContext,
): Promise<XaiBrowserLoginResult> {
  return runXaiDeviceLogin({
    onUserCode: async ({ userCode, verificationUri, verificationUriComplete }) => {
      const url = verificationUriComplete ?? verificationUri;
      showLoginNotice(ctx, {
        heading: "Sign in with your X / xAI account to continue.",
        url,
        userCode,
      });
      try {
        await openUrlInBrowser(url);
      } catch {
        // URL is already displayed; nothing else to do.
      }
    },
  });
}

function showLoginNotice(
  ctx: SlashCommandContext,
  info: { heading: string; url: string; userCode?: string },
): void {
  openLocalJsxCommand(
    ctx,
    () => (
      <Box flexDirection="column" paddingX={1} borderStyle="round">
        <Text>{info.heading}</Text>
        <Text dimColor>
          The consent page may say "Grok Build" — that is xAI's shared sign-in.
        </Text>
        {info.userCode ? <Text>Code: {info.userCode}</Text> : null}
        <Text dimColor>URL: {info.url}</Text>
      </Box>
    ),
    { shouldHidePromptInput: false },
  );
}

function clearLoginNotice(ctx: SlashCommandContext): void {
  ctx.appState?.setToolJSX?.({
    jsx: null,
    shouldHidePromptInput: false,
    clearLocalJSX: true,
  });
}
