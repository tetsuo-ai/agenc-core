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

import { useContext, useState } from "react";

import { Box, Text, useInput } from "../tui/ink.js";
import { setClipboard } from "../tui/ink/termio/osc.js";
import { TerminalWriteContext } from "../tui/ink/useTerminalNotification.js";
import { env as hostEnv } from "../utils/env.js";
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

    const controller = new AbortController();
    let login: XaiBrowserLoginResult;
    try {
      // The browser flow redirects to 127.0.0.1 on THIS machine and opens
      // the browser on THIS machine's desktop. Over SSH the user sees neither:
      // their own browser cannot reach the loopback callback, so the sign-in
      // waited out its timeout with input paused. The device-code flow works
      // from any browser, so a remote session goes straight to it.
      const remote = hostEnv.isSSH();
      login = arg === "device" || remote
        ? await runDeviceFlow(ctx, controller, { openBrowser: !remote })
        : await runBrowserFlowWithDeviceFallback(ctx, controller);
      if (controller.signal.aborted) {
        return { kind: "text", text: "xAI sign-in cancelled." };
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return { kind: "text", text: "xAI sign-in cancelled." };
      }
      throw error;
    } finally {
      clearLoginNotice(ctx);
    }

    const blob = xaiOauthTokensToBlob(login.tokens, {
      tokenEndpoint: login.tokenEndpoint,
    });
    const saved = saveXaiOauthCredentials(home, blob);
    if (!saved.success) {
      return {
        kind: "error",
        message: `Signed in, but storing tokens failed: ${saved.warning ?? "unknown error"}`,
      };
    }

    const who = blob.accountLabel ?? login.identity.sub ?? "xAI account";
    const lines = [`Signed in to xAI as ${who}.`];

    // OAuth always wins over env BYOK — switch to grok regardless of keys.
    const switchOutcome = await applyProviderSwitch(ctx.session, "grok");
    lines.push(switchOutcome.summary);
    lines.push("Run /model to pick a Grok model (e.g. grok-4.5).");
    lines.push(
      "This sign-in takes precedence over any XAI_API_KEY / GROK_API_KEY " +
        "in the environment (subscription Grok Build access).",
    );
    const envKey = resolveApiKey(environment);
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
  controller: AbortController,
): Promise<XaiBrowserLoginResult> {
  const onCancel = () => controller.abort();
  let pending = true;
  showLoginNotice(ctx, {
    heading: "Preparing xAI browser sign-in...", url: "", onCancel,
  });
  try {
    return await runXaiBrowserLogin({
      signal: controller.signal,
      onAuthorizeUrl: (url) => {
        showLoginNotice(ctx, {
          heading: "Sign in with your X / xAI account to continue.",
          url, onCancel,
        });
        // Browser startup must not delay the callback wait or cancellation.
        void openUrlInBrowser(url).catch(() => {
          if (!pending || controller.signal.aborted) return;
          showLoginNotice(ctx, {
            heading: "Open this URL in your browser to sign in:",
            url, onCancel,
          });
        });
      },
    });
  } catch (error) {
    // Loopback unavailable (e.g. the Grok CLI holds port 56121, or a
    // headless host): fall back to the device-code flow.
    if (!controller.signal.aborted && error instanceof XaiOauthError && error.code === "callback_failed") {
      return runDeviceFlow(ctx, controller);
    }
    throw error;
  } finally {
    pending = false;
  }
}

async function runDeviceFlow(
  ctx: SlashCommandContext,
  controller: AbortController,
  options: { readonly openBrowser?: boolean } = {},
): Promise<XaiBrowserLoginResult> {
  const onCancel = () => controller.abort();
  let pending = true;
  showLoginNotice(ctx, {
    heading: "Requesting an xAI device sign-in code...", url: "", onCancel,
  });
  try {
    return await runXaiDeviceLogin({
      signal: controller.signal,
      onUserCode: ({ userCode, verificationUri, verificationUriComplete }) => {
        const url = verificationUriComplete ?? verificationUri;
        if (options.openBrowser === false) {
          // A browser launched here would open on the remote desktop.
          showLoginNotice(ctx, {
            heading: "Open this URL in a browser on your own device to sign in:",
            url, userCode, onCancel,
          });
          return;
        }
        showLoginNotice(ctx, {
          heading: "Sign in with your X / xAI account to continue.",
          url, userCode, onCancel,
        });
        // Browser startup must not delay polling or prevent cancellation.
        void openUrlInBrowser(url).catch(() => {
          if (!pending || controller.signal.aborted) return;
          showLoginNotice(ctx, {
            heading: "Open this URL in your browser to sign in:",
            url, userCode, onCancel,
          });
        });
      },
    });
  } finally {
    pending = false;
  }
}

type LoginNoticeInfo = {
  heading: string;
  url: string;
  userCode?: string;
  onCancel?: () => void;
};

function LoginNotice(info: LoginNoticeInfo) {
  const writeRaw = useContext(TerminalWriteContext);
  const [copied, setCopied] = useState(false);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      info.onCancel?.();
      return;
    }
    // The fullscreen TUI owns the mouse, so the URL cannot be selected with a
    // plain drag. `c` sends it to the clipboard (OSC 52 / tmux buffer), which
    // also reaches the local clipboard over SSH.
    if (input === "c" && !key.ctrl && !key.meta && info.url) {
      void setClipboard(info.url)
        .then((sequence) => {
          if (sequence) writeRaw?.(sequence);
          setCopied(true);
        })
        .catch(() => {});
    }
  }, { isActive: info.onCancel !== undefined });
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round">
      <Text>{info.heading}</Text>
      <Text dimColor>
        The consent page may say "Grok Build" — that is xAI's shared sign-in.
      </Text>
      {info.userCode ? <Text>Code: {info.userCode}</Text> : null}
      {info.url ? <Text>URL: {info.url}</Text> : null}
      {info.url ? (
        <Text dimColor>
          {copied ? "URL copied to the clipboard." : "Press c to copy the URL."}
        </Text>
      ) : null}
      {info.onCancel ? (
        <Text dimColor>
          Waiting for the sign-in to finish; typing is paused. Esc or Ctrl+C cancels.
        </Text>
      ) : null}
    </Box>
  );
}

function showLoginNotice(
  ctx: SlashCommandContext,
  info: LoginNoticeInfo,
): void {
  openLocalJsxCommand(
    ctx,
    () => <LoginNotice {...info} />,
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
