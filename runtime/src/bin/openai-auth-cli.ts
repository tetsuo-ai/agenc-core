/**
 * Headless ChatGPT sign-in: `agenc openai-login [--json]` /
 * `agenc openai-logout [--json]` / `agenc openai-auth-status [--json]` /
 * `agenc openai-models [--json]`.
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
  type OpenAiOauthTokens,
} from "../services/openai/oauth.js";
import {
  exchangeProviderCodeIdTokenForApiKey,
  parseChatgptAccountId,
} from "../services/api/openAiCodeOAuthShared.js";
import {
  clearOpenAiOauthCredentials,
  readOpenAiOauthCredentials,
  refreshOpenAiSubscriptionIfNeeded,
  saveOpenAiOauthCredentials,
  type OpenAiOauthCredentialBlob,
} from "../utils/openAiOauthCredentials.js";
import {
  CHATGPT_BACKEND_ORIGINATOR,
  CHATGPT_MODELS_URL,
} from "../services/api/openAiChatGptBackend.js";

type OpenAiOauthAuthMode = "chatgpt" | "apiKey";

export type OpenAiAuthCliCommand =
  | { readonly kind: "login"; readonly json: boolean }
  | { readonly kind: "logout"; readonly json: boolean }
  | { readonly kind: "status"; readonly json: boolean }
  | { readonly kind: "models"; readonly json: boolean }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export interface OpenAiAuthCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  readonly openUrl?: (url: string) => void | Promise<void>;
}

export interface OpenAiAuthCliDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly readCredentials: typeof readOpenAiOauthCredentials;
  readonly refreshSubscription: typeof refreshOpenAiSubscriptionIfNeeded;
}

const DEFAULT_OPENAI_AUTH_CLI_DEPS: OpenAiAuthCliDeps = {
  fetch: globalThis.fetch,
  readCredentials: readOpenAiOauthCredentials,
  refreshSubscription: refreshOpenAiSubscriptionIfNeeded,
};

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
// Desktop bounds the whole child process at 30s. Leave enough margin for
// Core to emit its own stable JSON error before that outer deadline wins.
const OPENAI_MODELS_TIMEOUT_MS = 15_000;

/** Every stage is bounded: a stalled step reports, it never hangs. */
const API_KEY_EXCHANGE_TIMEOUT_MS = 45_000;

export function parseOpenAiAuthCliArgs(
  argv: readonly string[],
): OpenAiAuthCliCommand | null {
  const args = argv.filter((entry) => entry.length > 0);
  const positional = args.filter((entry) => !entry.startsWith("--"));
  const json = args.includes("--json");
  const first = positional[0];
  const kind =
    first === "openai-login" || first === "chatgpt-login"
      ? "login"
      : first === "openai-logout" || first === "chatgpt-logout"
        ? "logout"
        : first === "openai-auth-status" || first === "chatgpt-auth-status"
          ? "status"
          : first === "openai-models" || first === "chatgpt-models"
            ? "models"
            : null;
  if (kind === null || first === undefined) return null;
  if (args.includes("--help") || args.includes("-h")) {
    return { kind: "help", text: formatOpenAiAuthCliHelpText() };
  }
  const unexpected = args.find(
    (entry) => entry !== first && entry !== "--json",
  );
  if (unexpected !== undefined) {
    return {
      kind: "error",
      message: `${first} does not accept argument '${unexpected}'`,
    };
  }
  return { kind, json };
}

export function formatOpenAiAuthCliHelpText(): string {
  return [
    "Usage: agenc openai-login [--json]",
    "       agenc openai-logout [--json]",
    "       agenc openai-auth-status [--json]",
    "       agenc openai-models [--json]",
    "",
    "Manage the OpenAI sign-in and list models available to its stored credential.",
    "Credentials are read exclusively through AgenC secure storage.",
    "",
    "Options:",
    "  --json   Print machine-readable JSON",
    "",
    "Examples:",
    "  agenc openai-login --json",
    "  agenc openai-auth-status --json",
    "  agenc openai-models --json",
  ].join("\n");
}

/** Match the route Core will actually use; persisted mode is legacy metadata. */
function resolveOpenAiOauthAuthMode(
  blob: OpenAiOauthCredentialBlob,
): OpenAiOauthAuthMode {
  if (blob.apiKey?.trim()) return "apiKey";
  if (blob.accessToken?.trim() && blob.accountId?.trim()) return "chatgpt";
  return blob.authMode ?? "chatgpt";
}

function isUsableOpenAiOauthCredential(
  blob: OpenAiOauthCredentialBlob,
  authMode: OpenAiOauthAuthMode = resolveOpenAiOauthAuthMode(blob),
): boolean {
  return authMode === "apiKey"
    ? Boolean(blob.apiKey?.trim())
    : Boolean(blob.accessToken?.trim()) && Boolean(blob.accountId?.trim());
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

/**
 * chatgpt_account_id lives under the `https://api.openai.com/auth` claim.
 * Both tokens carry it; prefer the id_token, fall back to the access
 * token (a refresh returns a new access token but never restates the
 * account id, so it is resolved once here and persisted).
 */
function accountIdFromLogin(tokens: OpenAiOauthTokens): string | undefined {
  return (
    parseChatgptAccountId(tokens.idToken) ??
    parseChatgptAccountId(tokens.accessToken)
  );
}

type OpenAiModelsResult =
  | {
      readonly ok: true;
      readonly models: readonly string[];
      readonly authMode: OpenAiOauthAuthMode;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code: string;
    };

function modelDiscoveryFailure(
  error: string,
  code: string,
): OpenAiModelsResult {
  return { ok: false, error, code };
}

function parseOpenAiModelIds(
  payload: unknown,
  authMode: OpenAiOauthAuthMode,
): readonly string[] | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const entries = authMode === "apiKey" ? record.data : record.models;
  if (!Array.isArray(entries)) return null;
  const field = authMode === "apiKey" ? "id" : "slug";
  const models: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const raw = (entry as Record<string, unknown>)[field];
    if (typeof raw !== "string") continue;
    const model = raw.trim();
    if (model.length === 0 || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

async function discoverOpenAiModels(
  deps: OpenAiAuthCliDeps,
): Promise<OpenAiModelsResult> {
  let credential = deps.readCredentials();
  if (credential === undefined) {
    return modelDiscoveryFailure(
      "No OpenAI sign-in is stored.",
      "not_signed_in",
    );
  }

  let authMode = resolveOpenAiOauthAuthMode(credential);
  if (authMode === "chatgpt") {
    try {
      await deps.refreshSubscription();
    } catch {
      return modelDiscoveryFailure(
        "The ChatGPT subscription credential could not be refreshed.",
        "refresh_failed",
      );
    }
    // Refresh may rotate both access and refresh tokens. Always re-read
    // through secure storage instead of retaining the pre-refresh blob.
    credential = deps.readCredentials();
    if (credential === undefined) {
      return modelDiscoveryFailure(
        "No OpenAI sign-in is stored.",
        "not_signed_in",
      );
    }
    authMode = resolveOpenAiOauthAuthMode(credential);
  }

  let url: string;
  let headers: Record<string, string>;
  if (authMode === "apiKey") {
    const apiKey = credential.apiKey?.trim();
    if (!apiKey) {
      return modelDiscoveryFailure(
        "The stored OpenAI API-key credential is incomplete.",
        "invalid_credential",
      );
    }
    url = OPENAI_MODELS_URL;
    headers = { Authorization: `Bearer ${apiKey}` };
  } else {
    const accessToken = credential.accessToken?.trim();
    const accountId = credential.accountId?.trim();
    if (!accessToken || !accountId) {
      return modelDiscoveryFailure(
        "The stored ChatGPT subscription credential is incomplete.",
        "invalid_credential",
      );
    }
    url = CHATGPT_MODELS_URL;
    headers = {
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-ID": accountId,
      originator: CHATGPT_BACKEND_ORIGINATOR,
    };
  }

  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(OPENAI_MODELS_TIMEOUT_MS),
    });
  } catch {
    return modelDiscoveryFailure(
      "OpenAI model discovery request failed.",
      "network_error",
    );
  }
  if (!response.ok) {
    const status = Number.isInteger(response.status) ? response.status : 0;
    return modelDiscoveryFailure(
      `OpenAI model discovery failed (HTTP ${status}).`,
      `http_${status}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return modelDiscoveryFailure(
      "OpenAI model discovery returned an invalid response.",
      "invalid_response",
    );
  }
  const models = parseOpenAiModelIds(payload, authMode);
  if (models === null) {
    return modelDiscoveryFailure(
      "OpenAI model discovery returned an invalid response.",
      "invalid_response",
    );
  }
  return { ok: true, models, authMode };
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
  overrides: Partial<OpenAiAuthCliDeps> = {},
): Promise<number> {
  if (command.kind === "help") {
    io.stdout.write(`${command.text}\n`);
    return 0;
  }
  if (command.kind === "error") {
    io.stderr.write(`agenc: ${command.message}\n`);
    io.stderr.write(`${formatOpenAiAuthCliHelpText()}\n`);
    return 1;
  }
  const deps: OpenAiAuthCliDeps = {
    ...DEFAULT_OPENAI_AUTH_CLI_DEPS,
    ...overrides,
  };
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

  if (command.kind === "models") {
    const result = await discoverOpenAiModels(deps);
    if (command.json) {
      io.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (result.ok) {
      io.stdout.write(
        result.models.length > 0
          ? `${result.models.join("\n")}\n`
          : "No models available.\n",
      );
    } else {
      io.stderr.write(`OpenAI models: ${result.error}\n`);
    }
    return result.ok ? 0 : 1;
  }

  if (command.kind === "status") {
    const existing = deps.readCredentials();
    const authMode =
      existing !== undefined
        ? resolveOpenAiOauthAuthMode(existing)
        : undefined;
    const signedIn =
      existing !== undefined &&
      authMode !== undefined &&
      isUsableOpenAiOauthCredential(existing, authMode);
    emit(
      {
        ok: true,
        signedIn,
        ...(signedIn && authMode !== undefined ? { authMode } : {}),
        ...(signedIn && existing?.accountLabel !== undefined
          ? { account: existing.accountLabel }
          : {}),
      },
      signedIn
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

  // The platform API key is a bonus, not a requirement. Only a ChatGPT
  // account inside an OpenAI platform organization can mint one; every
  // other account authenticates as a subscription, with the access token
  // and account id against the ChatGPT backend. Treating the exchange's
  // 401 as fatal is what made a perfectly good subscription login look
  // broken.
  let apiKey: string | undefined;
  if (login.tokens.idToken !== undefined) {
    try {
      apiKey = await withTimeout(
        exchangeProviderCodeIdTokenForApiKey(login.tokens.idToken),
        API_KEY_EXCHANGE_TIMEOUT_MS,
        "the API key exchange",
      );
    } catch {
      apiKey = undefined;
    }
  }

  const accountId = accountIdFromLogin(login.tokens);
  if (apiKey === undefined && accountId === undefined) {
    return fail(
      "the login produced neither a platform API key nor a ChatGPT " +
        "account id, so there is no way to authenticate with it.",
      "no_credential",
    );
  }

  const mode = apiKey !== undefined ? "apiKey" : "chatgpt";
  const saved = saveOpenAiOauthCredentials({
    ...(apiKey !== undefined ? { apiKey } : {}),
    authMode: mode,
    accessToken: login.tokens.accessToken,
    ...(accountId !== undefined ? { accountId } : {}),
    obtainedAt: Date.now(),
    ...(login.accountLabel !== undefined
      ? { accountLabel: login.accountLabel }
      : {}),
    ...(login.tokens.idToken !== undefined
      ? { idToken: login.tokens.idToken }
      : {}),
    ...(login.tokens.refreshToken !== undefined
      ? { refreshToken: login.tokens.refreshToken }
      : {}),
  });
  if (!saved.success) {
    return fail(
      `signed in, but storing the credential failed: ${saved.warning ?? "unknown error"}`,
      "store_failed",
    );
  }

  const account = login.accountLabel ?? "ChatGPT account";
  emit(
    { ok: true, signedIn: true, account, authMode: mode },
    mode === "apiKey"
      ? `Signed in to ChatGPT as ${account}.`
      : `Signed in to ChatGPT as ${account} (subscription).`,
  );
  return 0;
}
