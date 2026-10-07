/**
 * /openai-login and /openai-logout — Sign in with ChatGPT for OpenAI
 * access without an OPENAI_API_KEY in the environment.
 *
 * Browser PKCE uses one captured loopback authority. The shared completion
 * path stores either an exchanged platform API key or the subscription access
 * token/account pair; both command surfaces consume the same native record.
 * Signing in does not switch the session's provider; /providers does.
 */

import {
  clearOpenAiOauthCredentials,
  readOpenAiOauthCredentials,
} from "../utils/openAiOauthCredentials.js";
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
    // Load once before registering synchronous stage callbacks.
    const showLoginNotice = typeof ctx.appState?.setToolJSX === "function"
      ? (await import("./openai-auth-menu.js")).showLoginNotice
      : () => {};
    let result;
    try {
      // Painted stage markers: the desktop tails this hidden TUI, so each
      // stage names where a stall happens instead of six silent minutes.
      result = await signInToProvider({
        provider: "openai",
        home,
        environment,
        onProgress: (progress) => {
          showLoginNotice(ctx, { heading: progress.heading, url: progress.url ?? "" });
        },
      });
    } finally {
      clearLoginNotice(ctx);
    }
    // Stable "Sign-in failed:" prefix: the desktop's hidden-PTY runner
    // matches on it.
    if (!result.ok) return { kind: "error", message: result.message };

    const subscription = result.subscription === true ? " (subscription)" : "";
    return {
      kind: "text",
      text: [
        `Signed in to ChatGPT as ${result.account}${subscription}.`,
        "Open /providers to use OpenAI with this account.",
        "Unless auth is set to api-key, this sign-in is used before any " +
          "OPENAI_API_KEY in the environment. /openai-logout to fall back to the env key.",
      ].join("\n"),
    };
  });
}

function clearLoginNotice(ctx: SlashCommandContext): void {
  ctx.appState?.setToolJSX?.({
    jsx: null,
    shouldHidePromptInput: false,
    clearLocalJSX: true,
  });
}
