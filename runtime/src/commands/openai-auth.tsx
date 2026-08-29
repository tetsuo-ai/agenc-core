/**
 * /openai-login and /openai-logout — Sign in with ChatGPT for OpenAI
 * access without an OPENAI_API_KEY in the environment.
 *
 * Browser PKCE uses one captured loopback authority. The shared completion
 * path stores either an exchanged platform API key or the subscription access
 * token/account pair; both command surfaces consume the same native record.
 */

import { Box, Text } from "../tui/ink.js";
import {
  OpenAiOauthError,
  runOpenAiBrowserLogin,
} from "../services/openai/oauth.js";
import {
  clearOpenAiOauthCredentials,
  readOpenAiOauthCredentials,
} from "../utils/openAiOauthCredentials.js";
import {
  completeOpenAiLogin,
  OpenAiLoginCompletionError,
} from "../services/openai/login.js";
import { openUrlInBrowser } from "./auth.js";
import {
  providerEnvironmentFromCommandContext,
  requireCommandConfigStore,
} from "./config-context.js";
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
  description: "Sign in to ChatGPT for OpenAI models",
  immediate: true,
  supportsNonInteractive: false,
  execute: async (ctx) => executeOpenAiLogin(ctx),
};

export const openaiLogoutCommand: SlashCommand = {
  name: "openai-logout",
  aliases: ["chatgpt-logout"],
  description: "Sign out of ChatGPT for OpenAI models",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx) =>
    safeExecute(async () => {
      const home = requireCommandConfigStore(ctx).homeContext;
      const existing = readOpenAiOauthCredentials(home);
      if (existing === undefined) {
        return { kind: "text", text: "No ChatGPT sign-in stored." };
      }
      const result = clearOpenAiOauthCredentials(home);
      if (!result.success) {
        return {
          kind: "error",
          message: `Could not clear the ChatGPT sign-in: ${result.warning ?? "unknown error"}`,
        };
      }
      const label = existing.accountLabel ? ` (${existing.accountLabel})` : "";
      return {
        kind: "text",
        text: `Signed out of ChatGPT${label}. The stored credential was deleted.`,
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
    const home = requireCommandConfigStore(ctx).homeContext;
    const environment = providerEnvironmentFromCommandContext(ctx);
    let login;
    try {
      login = await runOpenAiBrowserLogin({
        environment,
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

    showLoginNotice(ctx, {
      heading: "Saving the ChatGPT sign-in…",
      url: "",
    });
    let completion;
    try {
      completion = await completeOpenAiLogin({
        home,
        environment,
        login,
      });
    } catch (error) {
      if (error instanceof OpenAiLoginCompletionError) {
        return {
          kind: "error",
          message: `Sign-in failed: ${error.message} (${error.code}).`,
        };
      }
      return {
        kind: "error",
        message: `Sign-in failed: ${error instanceof Error ? error.message : String(error)}.`,
      };
    } finally {
      clearLoginNotice(ctx);
    }

    const who = completion.account;
    const lines = [`Signed in to ChatGPT as ${who}.`];
    if (completion.authMode === "chatgpt") {
      lines[0] = `Signed in to ChatGPT as ${who} (subscription).`;
    }
    const switchOutcome = await applyProviderSwitch(ctx.session, "openai");
    lines.push(switchOutcome.summary);
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
