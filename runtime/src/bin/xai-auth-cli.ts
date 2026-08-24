/**
 * Headless xAI sign-in: `agenc grok-login [device] [--json]` /
 * `agenc grok-logout [--json]`.
 *
 * The TUI slash commands remain the interactive terminal surface. Desktop
 * and other programs use this JSONL entry point so they can show OAuth
 * progress without launching Ink in a pseudo-terminal or screen-scraping it.
 * No token or authorization code is ever written to stdout/stderr.
 */

import { spawn } from "node:child_process";

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

type XaiLoginFlow = "browser" | "device";

/**
 * Browser helpers need only process lookup, the user's home/temp directory,
 * and desktop-session routing. In particular, provider keys, bearer tokens,
 * npm credentials, and AgenC internals must never cross this process boundary.
 * Matching is case-insensitive because Windows environment keys are.
 */
const BROWSER_OPEN_ENV_KEYS = new Set([
  "APPDATA",
  "COMSPEC",
  "DBUS_SESSION_BUS_ADDRESS",
  "DESKTOP_SESSION",
  "DESKTOP_STARTUP_ID",
  "DISPLAY",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SECURITYSESSIONID",
  "SESSIONNAME",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "XAUTHORITY",
  "XDG_CONFIG_HOME",
  "XDG_CURRENT_DESKTOP",
  "XDG_DATA_DIRS",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
  "__CF_USER_TEXT_ENCODING",
]);

export interface BrowserOpenSpawnSpec {
  readonly command: string;
  readonly args: string[];
  readonly options: {
    readonly detached: true;
    readonly stdio: "ignore";
    readonly shell: false;
    readonly env: NodeJS.ProcessEnv;
  };
}

export function buildBrowserOpenEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && BROWSER_OPEN_ENV_KEYS.has(key.toUpperCase())) {
      clean[key] = value;
    }
  }
  return clean;
}

export function buildBrowserOpenSpawnSpec(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): BrowserOpenSpawnSpec {
  const launch =
    platform === "darwin"
      ? { command: "open", args: [url] }
      : platform === "win32"
        ? {
            // Direct argv invocation: OAuth query `&` characters are data,
            // never command separators as they were under `cmd /c start`.
            command: "rundll32.exe",
            args: ["url.dll,FileProtocolHandler", url],
          }
        : { command: "xdg-open", args: [url] };
  return {
    ...launch,
    options: {
      detached: true,
      stdio: "ignore",
      shell: false,
      env: buildBrowserOpenEnvironment(env),
    },
  };
}

export type XaiAuthCliCommand =
  | { readonly kind: "login"; readonly json: boolean; readonly device: boolean }
  | { readonly kind: "logout"; readonly json: boolean }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export interface XaiAuthCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  readonly openUrl?: (url: string) => void | Promise<void>;
}

export interface XaiAuthCliDeps {
  readonly runBrowserLogin: typeof runXaiBrowserLogin;
  readonly runDeviceLogin: typeof runXaiDeviceLogin;
  readonly readCredentials: typeof readXaiOauthCredentials;
  readonly saveCredentials: typeof saveXaiOauthCredentials;
  readonly clearCredentials: typeof clearXaiOauthCredentials;
}

const DEFAULT_XAI_AUTH_CLI_DEPS: XaiAuthCliDeps = {
  runBrowserLogin: runXaiBrowserLogin,
  runDeviceLogin: runXaiDeviceLogin,
  readCredentials: readXaiOauthCredentials,
  saveCredentials: saveXaiOauthCredentials,
  clearCredentials: clearXaiOauthCredentials,
};

export function parseXaiAuthCliArgs(
  argv: readonly string[],
): XaiAuthCliCommand | null {
  const args = argv.filter((entry) => entry.length > 0);
  const positional = args.filter((entry) => !entry.startsWith("--"));
  const json = args.includes("--json");
  const first = positional[0];
  const kind =
    first === "grok-login" || first === "xai-login"
      ? "login"
      : first === "grok-logout" || first === "xai-logout"
        ? "logout"
        : null;
  if (kind === null || first === undefined) return null;
  if (args.includes("--help") || args.includes("-h")) {
    return { kind: "help", text: formatXaiAuthCliHelpText() };
  }

  const allowedPositionals =
    kind === "login" ? new Set([first, "device"]) : new Set([first]);
  const unexpected = args.find(
    (entry) => entry !== "--json" && !allowedPositionals.has(entry),
  );
  if (unexpected !== undefined) {
    return {
      kind: "error",
      message: `${first} does not accept argument '${unexpected}'`,
    };
  }
  if (
    kind === "login" &&
    positional.filter((entry) => entry === "device").length > 1
  ) {
    return {
      kind: "error",
      message: `${first} does not accept argument 'device' more than once`,
    };
  }
  return kind === "login"
    ? { kind, json, device: positional.includes("device") }
    : { kind, json };
}

export function formatXaiAuthCliHelpText(): string {
  return [
    "Usage: agenc grok-login [device] [--json]",
    "       agenc grok-logout [--json]",
    "",
    "Manage the X / xAI sign-in used for Grok subscription access.",
    "Browser PKCE is primary; device-code login is the automatic fallback.",
    "Credentials are stored exclusively through AgenC secure storage.",
    "",
    "Arguments:",
    "  device   Start with xAI's device-code flow instead of loopback OAuth",
    "",
    "Options:",
    "  --json   Print machine-readable JSON Lines progress and result events",
    "",
    "Examples:",
    "  agenc grok-login --json",
    "  agenc grok-login device --json",
    "  agenc grok-logout --json",
  ].join("\n");
}

function openUrlDetached(url: string): void {
  const launch = buildBrowserOpenSpawnSpec(url);
  const child = spawn(launch.command, launch.args, launch.options);
  child.on("error", () => {
    // The URL is emitted before opening; a missing opener is not fatal.
  });
  child.unref();
}

async function openLoginUrl(io: XaiAuthCliIo, url: string): Promise<void> {
  try {
    if (io.openUrl !== undefined) await io.openUrl(url);
    else openUrlDetached(url);
  } catch {
    // The URL and device code remain visible to the caller.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runXaiAuthCli(
  command: XaiAuthCliCommand,
  io: XaiAuthCliIo = { stdout: process.stdout, stderr: process.stderr },
  overrides: Partial<XaiAuthCliDeps> = {},
): Promise<number> {
  if (command.kind === "help") {
    io.stdout.write(`${command.text}\n`);
    return 0;
  }
  if (command.kind === "error") {
    io.stderr.write(`agenc: ${command.message}\n`);
    io.stderr.write(`${formatXaiAuthCliHelpText()}\n`);
    return 1;
  }

  const deps: XaiAuthCliDeps = {
    ...DEFAULT_XAI_AUTH_CLI_DEPS,
    ...overrides,
  };
  const emitProgress = (
    payload: Record<string, unknown>,
    plain: string,
  ): void => {
    if (command.json) io.stdout.write(`${JSON.stringify(payload)}\n`);
    else io.stdout.write(`${plain}\n`);
  };
  const emitResult = (
    payload: Record<string, unknown>,
    plain: string,
  ): void => {
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
      io.stderr.write(`xAI authentication failed: ${error}\n`);
    }
    return 1;
  };

  if (command.kind === "logout") {
    const existing = deps.readCredentials();
    if (existing === undefined) {
      emitResult({ ok: true, signedIn: false }, "No xAI sign-in stored.");
      return 0;
    }
    const cleared = deps.clearCredentials();
    if (!cleared.success) {
      return fail(
        cleared.warning ?? "could not clear the stored xAI sign-in",
        "store_failed",
      );
    }
    emitResult({ ok: true, signedIn: false }, "Signed out of xAI.");
    return 0;
  }

  let flow: XaiLoginFlow = command.device ? "device" : "browser";
  const runDeviceFlow = async (): Promise<XaiBrowserLoginResult> =>
    deps.runDeviceLogin({
      onUserCode: async (info) => {
        const url = info.verificationUriComplete ?? info.verificationUri;
        emitProgress(
          {
            stage: "device_authorize",
            flow: "device",
            url,
            userCode: info.userCode,
            verificationUri: info.verificationUri,
            ...(info.verificationUriComplete !== undefined
              ? { verificationUriComplete: info.verificationUriComplete }
              : {}),
          },
          `Open ${url} and enter code ${info.userCode}.`,
        );
        await openLoginUrl(io, url);
      },
    });

  let login: XaiBrowserLoginResult;
  try {
    if (command.device) {
      login = await runDeviceFlow();
    } else {
      try {
        login = await deps.runBrowserLogin({
          onAuthorizeUrl: async (url) => {
            emitProgress(
              { stage: "authorize", flow: "browser", url },
              `Opening the browser to sign in:\n${url}`,
            );
            await openLoginUrl(io, url);
          },
          onStage: (stage) => {
            emitProgress(
              { stage, flow: "browser" },
              stage === "callback_received"
                ? "Browser sign-in received."
                : "Exchanging the xAI authorization code.",
            );
          },
        });
      } catch (error) {
        if (!(error instanceof XaiOauthError) || error.code !== "callback_failed") {
          throw error;
        }
        flow = "device";
        emitProgress(
          {
            stage: "device_fallback",
            from: "browser",
            to: "device",
            code: error.code,
            error: error.message,
          },
          `Browser callback unavailable (${error.message}); using device login.`,
        );
        login = await runDeviceFlow();
      }
    }
  } catch (error) {
    return fail(
      errorText(error),
      error instanceof XaiOauthError ? error.code : undefined,
    );
  }

  const blob = xaiOauthTokensToBlob(login.tokens, {
    tokenEndpoint: login.tokenEndpoint,
  });
  const saved = deps.saveCredentials(blob);
  if (!saved.success) {
    return fail(
      `signed in, but storing the credential failed: ${saved.warning ?? "unknown error"}`,
      "store_failed",
    );
  }

  const account =
    blob.accountLabel ??
    login.identity.email ??
    login.identity.name ??
    login.identity.sub ??
    "xAI account";
  emitResult(
    { ok: true, signedIn: true, account, flow },
    `Signed in to xAI as ${account}.`,
  );
  return 0;
}
