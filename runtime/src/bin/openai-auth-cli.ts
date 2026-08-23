/**
 * Headless ChatGPT sign-in: `agenc openai-login [--json]` /
 * `agenc openai-logout [--json]` / `agenc openai-auth-status [--json]`.
 *
 * The TUI slash command is for humans at a terminal. Programs — the
 * desktop app above all — need an entry point that prints a result and
 * exits, with no Ink overlay to hide the outcome behind and no screen
 * scraping to guess at it. Every branch here ends in exactly one JSON
 * line (or one plain line) and an exit code.
 */

import { spawn } from "node:child_process";

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

export type OpenAiAuthCliCommand =
  | { readonly kind: "login"; readonly json: boolean }
  | { readonly kind: "logout"; readonly json: boolean }
  | { readonly kind: "status"; readonly json: boolean };

export interface OpenAiAuthCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  readonly openUrl?: (url: string) => void | Promise<void>;
}

/** Every stage is bounded: a stalled step reports, it never hangs. */
const API_KEY_EXCHANGE_TIMEOUT_MS = 45_000;

export function parseOpenAiAuthCliArgs(
  argv: readonly string[],
): OpenAiAuthCliCommand | null {
  const args = argv.filter((entry) => entry.length > 0);
  const positional = args.filter((entry) => !entry.startsWith("--"));
  const json = args.includes("--json");
  const first = positional[0];
  if (first === "openai-login" || first === "chatgpt-login") {
    return { kind: "login", json };
  }
  if (first === "openai-logout" || first === "chatgpt-logout") {
    return { kind: "logout", json };
  }
  if (first === "openai-auth-status" || first === "chatgpt-auth-status") {
    return { kind: "status", json };
  }
  return null;
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

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
          ms,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runOpenAiAuthCli(
  command: OpenAiAuthCliCommand,
  io: OpenAiAuthCliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
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
    const existing = readOpenAiOauthCredentials();
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
    const existing = readOpenAiOauthCredentials();
    if (existing === undefined) {
      emit({ ok: true, signedIn: false }, "No ChatGPT sign-in stored.");
      return 0;
    }
    const result = clearOpenAiOauthCredentials();
    if (!result.success) {
      return fail(result.warning ?? "could not clear the stored sign-in");
    }
    emit({ ok: true, signedIn: false }, "Signed out of ChatGPT.");
    return 0;
  }

  let login;
  try {
    login = await runOpenAiBrowserLogin({
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

  if (login.tokens.idToken === undefined) {
    return fail(
      "the login carried no id_token to exchange for an API key",
      "no_id_token",
    );
  }

  let apiKey: string;
  try {
    apiKey = await withTimeout(
      exchangeProviderCodeIdTokenForApiKey(login.tokens.idToken),
      API_KEY_EXCHANGE_TIMEOUT_MS,
      "the API key exchange",
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The common rejection is worth naming plainly: OpenAI only mints an
    // API key for a login whose id_token carries an organization, i.e. a
    // ChatGPT account attached to a platform org. A personal Plus/Pro
    // account is not, and no amount of retrying changes that.
    if (/missing organization_id|invalid_subject_token/i.test(detail)) {
      return fail(
        "this ChatGPT account is not attached to an OpenAI platform " +
          "organization, so OpenAI will not issue an API key for it. Use an " +
          "OPENAI_API_KEY from platform.openai.com instead, or sign in with " +
          "an account that belongs to a platform organization.",
        "no_platform_org",
      );
    }
    return fail(
      `ChatGPT accepted the login, but exchanging it for an API key failed — ${detail}.`,
      "exchange_failed",
    );
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
    return fail(
      `signed in, but storing the key failed: ${saved.warning ?? "unknown error"}`,
      "store_failed",
    );
  }

  const account = login.accountLabel ?? "ChatGPT account";
  emit(
    { ok: true, signedIn: true, account },
    `Signed in to ChatGPT as ${account}.`,
  );
  return 0;
}
