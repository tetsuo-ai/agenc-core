/**
 * Headless ChatGPT sign-in: `agenc openai-login [--json]` /
 * `agenc openai-logout [--json]` / `agenc openai-auth-status [--json]`.
 *
 * The TUI slash command is for humans at a terminal. Programs — the
 * desktop app above all — need an entry point that prints a result and
 * exits, with no Ink overlay to hide the outcome behind and no screen
 * scraping to guess at it. JSON mode emits structured progress records and
 * ends with one result record plus an exit code.
 */

import { spawn } from "node:child_process";

import {
  OpenAiOauthError,
  runOpenAiBrowserLogin,
} from "../services/openai/oauth.js";
import {
  completeOpenAiLogin,
  OpenAiLoginCompletionError,
} from "../services/openai/login.js";
import {
  clearOpenAiOauthCredentials,
  readOpenAiOauthCredentials,
} from "../utils/openAiOauthCredentials.js";
import type { HomeContext } from "../config/home.js";
import type { ProviderEnvironment } from "../llm/provider-options.js";

export type OpenAiAuthCliCommand =
  | { readonly kind: "login"; readonly json: boolean }
  | { readonly kind: "logout"; readonly json: boolean }
  | { readonly kind: "status"; readonly json: boolean }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

export interface OpenAiAuthCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  readonly openUrl?: (url: string) => void | Promise<void>;
}

export interface OpenAiAuthCliRuntime {
  readonly home: HomeContext;
  readonly environment: ProviderEnvironment;
}

export function parseOpenAiAuthCliArgs(
  argv: readonly string[],
): OpenAiAuthCliCommand | null {
  const action = argv[0];
  const kind =
    action === "openai-login" || action === "chatgpt-login"
      ? "login"
      : action === "openai-logout" || action === "chatgpt-logout"
        ? "logout"
        : action === "openai-auth-status" || action === "chatgpt-auth-status"
          ? "status"
          : null;
  if (kind === null) return null;

  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    return { kind: "help" };
  }
  if (rest.length === 0) return { kind, json: false };
  if (rest.length === 1 && rest[0] === "--json") {
    return { kind, json: true };
  }
  return {
    kind: "error",
    message: `OpenAI auth command '${action}' accepts only --json or --help`,
  };
}

export function formatOpenAiAuthCliHelpText(): string {
  return [
    "Usage:",
    "  agenc openai-login [--json]",
    "  agenc openai-logout [--json]",
    "  agenc openai-auth-status [--json]",
    "",
    "Sign in with ChatGPT for the OpenAI provider. A stored sign-in wins over",
    "OPENAI_API_KEY only while the selected provider is openai. Logout removes",
    "the stored credential and returns OpenAI authentication to the environment.",
    "",
    "Aliases: chatgpt-login, chatgpt-logout, chatgpt-auth-status",
  ].join("\n");
}

function openUrlDetached(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {
    // The URL is printed either way; a missing opener is not fatal.
  });
  child.unref();
}

export async function runOpenAiAuthCli(
  command: OpenAiAuthCliCommand,
  runtime: OpenAiAuthCliRuntime,
  io: OpenAiAuthCliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  if (command.kind === "help") {
    io.stdout.write(`${formatOpenAiAuthCliHelpText()}\n`);
    return 0;
  }
  if (command.kind === "error") {
    io.stderr.write(`agenc: ${command.message}\n`);
    io.stderr.write(`${formatOpenAiAuthCliHelpText()}\n`);
    return 1;
  }

  const emit = (payload: Record<string, unknown>, plain: string): void => {
    io.stdout.write(
      command.json ? `${JSON.stringify(payload)}\n` : `${plain}\n`,
    );
  };
  const fail = (error: string, code?: string): number => {
    if (command.json) {
      io.stdout.write(
        `${JSON.stringify({ ok: false, error, ...(code !== undefined ? { code } : {}) })}\n`,
      );
    } else {
      io.stderr.write(`Sign-in failed: ${error}\n`);
    }
    return 1;
  };

  if (command.kind === "status") {
    const existing = readOpenAiOauthCredentials(runtime.home);
    emit(
      {
        ok: true,
        signedIn: existing !== undefined,
        ...(existing?.accountLabel !== undefined
          ? { account: existing.accountLabel }
          : {}),
      },
      existing !== undefined
        ? `Signed in to ChatGPT as ${existing.accountLabel ?? "ChatGPT account"}.`
        : "No ChatGPT sign-in stored.",
    );
    return 0;
  }

  if (command.kind === "logout") {
    const existing = readOpenAiOauthCredentials(runtime.home);
    if (existing === undefined) {
      emit({ ok: true, signedIn: false }, "No ChatGPT sign-in stored.");
      return 0;
    }
    const result = clearOpenAiOauthCredentials(runtime.home);
    if (!result.success) {
      return fail(result.warning ?? "could not clear the stored sign-in");
    }
    emit({ ok: true, signedIn: false }, "Signed out of ChatGPT.");
    return 0;
  }

  let login;
  try {
    login = await runOpenAiBrowserLogin({
      environment: runtime.environment,
      onAuthorizeUrl: async (url) => {
        if (command.json) {
          io.stdout.write(`${JSON.stringify({ stage: "authorize", url })}\n`);
        } else {
          io.stdout.write(`Opening the browser to sign in:\n${url}\n`);
        }
        if (io.openUrl !== undefined) await io.openUrl(url);
        else openUrlDetached(url);
      },
      onStage: (stage) => {
        if (command.json) io.stdout.write(`${JSON.stringify({ stage })}\n`);
      },
    });
  } catch (error) {
    if (error instanceof OpenAiOauthError) {
      return fail(error.message, error.code);
    }
    return fail(error instanceof Error ? error.message : String(error));
  }

  let completion;
  try {
    completion = await completeOpenAiLogin({
      home: runtime.home,
      environment: runtime.environment,
      login,
    });
  } catch (error) {
    if (error instanceof OpenAiLoginCompletionError) {
      return fail(error.message, error.code);
    }
    return fail(error instanceof Error ? error.message : String(error));
  }

  const { account, authMode } = completion;
  emit(
    { ok: true, signedIn: true, account, authMode },
    authMode === "apiKey"
      ? `Signed in to ChatGPT as ${account}.`
      : `Signed in to ChatGPT as ${account} (subscription).`,
  );
  return 0;
}
