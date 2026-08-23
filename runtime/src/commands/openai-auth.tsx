/**
 * /openai-login and /openai-logout — Sign in with ChatGPT for OpenAI
 * access without an OPENAI_API_KEY in the environment.
 *
 * Browser PKCE with a loopback callback on the shared CLI client's
 * well-known port; the login's id_token is exchanged (RFC 8693) for a
 * platform API key, which is what gets stored and consumed — the wire
 * path stays plain API-key auth.
 */

import { Box, Text } from "../tui/ink.js";
import {
  OpenAiOauthError,
  runOpenAiBrowserLogin,
} from "../services/openai/oauth.js";
import { exchangeProviderCodeIdTokenForApiKey } from "../services/api/openAiCodeOAuthShared.js";
import {
  clearOpenAiOauthCredentials,
  readOpenAiOauthCredentials,
  saveOpenAiOauthCredentials,
} from "../utils/openAiOauthCredentials.js";
import { openUrlInBrowser } from "./auth.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { applyProviderSwitch } from "./provider.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export const openaiLoginCommand: SlashCommand = {
  name: "openai-login",
  aliases: ["chatgpt-login"],
  description: "Sign in with your ChatGPT account to use OpenAI models",
  immediate: true,
  supportsNonInteractive: false,
  execute: async (ctx) => executeOpenAiLogin(ctx),
};

export const openaiLogoutCommand: SlashCommand = {
  name: "openai-logout",
  aliases: ["chatgpt-logout"],
  description: "Sign out of the ChatGPT account used for OpenAI",
  immediate: true,
  supportsNonInteractive: true,
  execute: async () =>
    safeExecute(async () => {
      const existing = readOpenAiOauthCredentials();
      if (existing === undefined) {
        return { kind: "text", text: "No ChatGPT sign-in stored." };
      }
      const result = clearOpenAiOauthCredentials();
      if (!result.success) {
        return {
          kind: "error",
          message: `Could not clear the ChatGPT sign-in: ${result.warning ?? "unknown error"}`,
        };
      }
      const label = existing.accountLabel ? ` (${existing.accountLabel})` : "";
      return {
        kind: "text",
        text: `Signed out of ChatGPT${label}. The stored key was deleted.`,
      };
    }),
};

export const openaiAuthCommands: readonly SlashCommand[] = [
  openaiLoginCommand,
  openaiLogoutCommand,
];

async function executeOpenAiLogin(
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  return safeExecute(async () => {
    let login;
    try {
      login = await runOpenAiBrowserLogin({
        onAuthorizeUrl: async (url) => {
          showLoginNotice(ctx, {
            heading: "Sign in with your ChatGPT account to continue.",
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
        // Painted stage markers: the desktop tails this hidden TUI, so
        // each stage names where a stall happens instead of six silent
        // minutes.
        onStage: (stage) => {
          showLoginNotice(ctx, {
            heading:
              stage === "callback_received"
                ? "Browser sign-in received; completing…"
                : "Exchanging the login code…",
            url: "",
          });
        },
      });
    } catch (error) {
      if (error instanceof OpenAiOauthError && error.code === "callback_failed") {
        return {
          kind: "error",
          message:
            `Sign-in failed: could not open the callback listener (${error.message}). ` +
            "Close whatever holds the port and retry /openai-login.",
        };
      }
      // Stable "Sign-in failed:" prefix — the desktop's hidden-PTY runner
      // matches on it; anything else scrolls past unseen and the runner
      // sits out its full timeout, which reads as "nothing happened".
      if (error instanceof OpenAiOauthError) {
        return {
          kind: "error",
          message: `Sign-in failed: ${error.message} (${error.code}).`,
        };
      }
      throw error;
    } finally {
      clearLoginNotice(ctx);
    }

    if (login.tokens.idToken === undefined) {
      return {
        kind: "error",
        message:
          "Signed in, but the login carried no id_token to exchange for an API key.",
      };
    }
    showLoginNotice(ctx, {
      heading: "Exchanging the login for an API key…",
      url: "",
    });
    let apiKey: string;
    try {
      apiKey = await exchangeProviderCodeIdTokenForApiKey(
        login.tokens.idToken,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        kind: "error",
        message:
          `Sign-in failed: ChatGPT accepted the login, but exchanging it for an ` +
          `API key was rejected — ${detail} If your ChatGPT account has no ` +
          `OpenAI platform organization, sign in is not available for it; use an ` +
          `OPENAI_API_KEY instead.`,
      };
    }
    const saved = saveOpenAiOauthCredentials({
      apiKey,
      obtainedAt: Date.now(),
      ...(login.accountLabel !== undefined
        ? { accountLabel: login.accountLabel }
        : {}),
      idToken: login.tokens.idToken,
      ...(login.tokens.refreshToken !== undefined
        ? { refreshToken: login.tokens.refreshToken }
        : {}),
    });
    if (!saved.success) {
      return {
        kind: "error",
        message: `Signed in, but storing the key failed: ${saved.warning ?? "unknown error"}`,
      };
    }

    const who = login.accountLabel ?? "ChatGPT account";
    const lines = [`Signed in to ChatGPT as ${who}.`];
    const switchSummary = await applyProviderSwitch(ctx.session, "openai");
    lines.push(switchSummary);
    lines.push(
      "This sign-in takes precedence over any OPENAI_API_KEY in the " +
        "environment. /openai-logout to fall back to the env key.",
    );
    return { kind: "text", text: lines.join("\n") };
  });
}

function showLoginNotice(
  ctx: SlashCommandContext,
  info: { heading: string; url: string },
): void {
  openLocalJsxCommand(
    ctx,
    () => (
      <Box flexDirection="column" paddingX={1} borderStyle="round">
        <Text>{info.heading}</Text>
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
