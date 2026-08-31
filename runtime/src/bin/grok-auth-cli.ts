/**
 * Headless X / xAI sign-in: `agenc grok-login [device] [--json]` /
 * `agenc grok-logout [--json]` / `agenc grok-auth-status [--json]`.
 *
 * The interactive TUI flow retired with the xai provider slug, but the
 * desktop app signs users into subscription Grok through this CLI: JSON
 * mode emits one structured progress record per OAuth stage (authorize,
 * callback_received, exchanging_code, device_fallback, device_authorize)
 * and ends with one result record plus an exit code. Browser PKCE with a
 * loopback callback is the primary flow; the RFC 8628 device code is the
 * fallback when the loopback port is unavailable, or forced with the
 * `device` argument.
 */

import {
  createHeadlessEmitters,
  openUrlDetached,
} from "./headless-cli-io.js";
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
import type { HomeContext } from "../config/home.js";

export type GrokAuthCliCommand =
  | { readonly kind: "login"; readonly json: boolean; readonly device: boolean }
  | { readonly kind: "logout"; readonly json: boolean }
  | { readonly kind: "status"; readonly json: boolean }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

export interface GrokAuthCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  readonly openUrl?: (url: string) => void | Promise<void>;
}

export interface GrokAuthCliRuntime {
  readonly home: HomeContext;
}

export function parseGrokAuthCliArgs(
  argv: readonly string[],
): GrokAuthCliCommand | null {
  const action = argv[0];
  const kind =
    action === "grok-login" || action === "xai-login"
      ? "login"
      : action === "grok-logout" || action === "xai-logout"
        ? "logout"
        : action === "grok-auth-status" || action === "xai-auth-status"
          ? "status"
          : null;
  if (kind === null) return null;

  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    return { kind: "help" };
  }
  const flags = new Set(rest);
  const json = flags.delete("--json");
  const device = kind === "login" && flags.delete("device");
  if (flags.size > 0) {
    return {
      kind: "error",
      message:
        kind === "login"
          ? `Grok auth command '${action}' accepts only [device] and --json`
          : `Grok auth command '${action}' accepts only --json or --help`,
    };
  }
  return kind === "login"
    ? { kind, json, device }
    : { kind, json };
}

export function formatGrokAuthCliHelpText(): string {
  return [
    "Usage:",
    "  agenc grok-login [device] [--json]",
    "  agenc grok-logout [--json]",
    "  agenc grok-auth-status [--json]",
    "",
    "Sign in with your X / xAI account for subscription Grok access — no",
    "XAI_API_KEY needed. The browser PKCE flow is used by default; pass",
    "`device` (or lose the loopback port) for the RFC 8628 device-code flow.",
    "The consent screen may be labeled \"Grok Build\": that is xAI's shared",
    "CLI OAuth client. A stored sign-in wins over XAI_API_KEY / GROK_API_KEY",
    "while the selected provider is grok; logout returns to API-key billing.",
    "",
    "Aliases: xai-login, xai-logout, xai-auth-status",
  ].join("\n");
}

export async function runGrokAuthCli(
  command: GrokAuthCliCommand,
  runtime: GrokAuthCliRuntime,
  io: GrokAuthCliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  if (command.kind === "help") {
    io.stdout.write(`${formatGrokAuthCliHelpText()}\n`);
    return 0;
  }
  if (command.kind === "error") {
    io.stderr.write(`agenc: ${command.message}\n`);
    io.stderr.write(`${formatGrokAuthCliHelpText()}\n`);
    return 1;
  }

  const { emit, fail } = createHeadlessEmitters(
    command.json,
    io,
    "Sign-in failed",
  );

  if (command.kind === "status") {
    const existing = readXaiOauthCredentials(runtime.home);
    emit(
      {
        ok: true,
        signedIn: existing !== undefined,
        ...(existing?.accountLabel !== undefined
          ? { account: existing.accountLabel }
          : {}),
      },
      existing !== undefined
        ? `Signed in to xAI as ${existing.accountLabel ?? "xAI account"}.`
        : "No xAI sign-in stored.",
    );
    return 0;
  }

  if (command.kind === "logout") {
    const existing = readXaiOauthCredentials(runtime.home);
    if (existing === undefined) {
      emit({ ok: true, signedIn: false }, "No xAI sign-in stored.");
      return 0;
    }
    const result = clearXaiOauthCredentials(runtime.home);
    if (!result.success) {
      return fail(result.warning ?? "could not clear the stored sign-in");
    }
    emit({ ok: true, signedIn: false }, "Signed out of xAI.");
    return 0;
  }

  const openUrl = async (url: string): Promise<void> => {
    if (io.openUrl !== undefined) await io.openUrl(url);
    else openUrlDetached(url);
  };
  const progress = (
    payload: Record<string, unknown>,
    plain: string,
  ): void => {
    if (command.json) {
      io.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      io.stdout.write(`${plain}\n`);
    }
  };

  const runDeviceFlow = (): Promise<XaiBrowserLoginResult> =>
    runXaiDeviceLogin({
      onUserCode: async ({ userCode, verificationUri, verificationUriComplete }) => {
        const url = verificationUriComplete ?? verificationUri;
        progress(
          { stage: "device_authorize", flow: "device", url, userCode },
          `Sign in with your X / xAI account:\n${url}\nCode: ${userCode}`,
        );
        await openUrl(url);
      },
    });

  let login: XaiBrowserLoginResult;
  try {
    if (command.device) {
      login = await runDeviceFlow();
    } else {
      try {
        login = await runXaiBrowserLogin({
          onAuthorizeUrl: async (url) => {
            progress(
              { stage: "authorize", flow: "browser", url },
              `Opening the browser to sign in:\n${url}`,
            );
            await openUrl(url);
          },
          onStage: (stage) => {
            if (command.json) {
              io.stdout.write(`${JSON.stringify({ stage })}\n`);
            }
          },
        });
      } catch (error) {
        // Loopback unavailable (another CLI holds the port, or a headless
        // host): fall back to the device-code flow.
        if (error instanceof XaiOauthError && error.code === "callback_failed") {
          progress(
            { stage: "device_fallback", flow: "device" },
            "Browser callback unavailable; falling back to the device-code flow.",
          );
          login = await runDeviceFlow();
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    if (error instanceof XaiOauthError) {
      return fail(error.message, error.code);
    }
    return fail(error instanceof Error ? error.message : String(error));
  }

  const blob = xaiOauthTokensToBlob(login.tokens, {
    tokenEndpoint: login.tokenEndpoint,
  });
  const saved = saveXaiOauthCredentials(runtime.home, blob);
  if (!saved.success) {
    return fail(
      `signed in, but storing tokens failed: ${saved.warning ?? "unknown error"}`,
    );
  }

  const account = blob.accountLabel ?? login.identity.sub ?? "xAI account";
  emit(
    { ok: true, signedIn: true, account },
    `Signed in to xAI as ${account}. This sign-in takes precedence over any ` +
      "XAI_API_KEY / GROK_API_KEY while the selected provider is grok.",
  );
  return 0;
}
