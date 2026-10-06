/**
 * Account sign-in for the providers that offer one (OpenAI with a ChatGPT
 * account, Grok with an X / xAI account), shared by `/openai-login`,
 * `/grok-login` and the `/providers` screen. Progress is reported through
 * `onProgress`; the caller decides how to show it. Signing in never switches
 * the session's provider.
 *
 * The headings and the "Sign-in failed:" prefix are kept word for word: the
 * desktop app's hidden-terminal runner matches on them.
 *
 * @module
 */

import type { HomeContext } from "../config/home.js";
import type { ProviderEnvironment } from "../llm/provider-environment.js";
import {
  completeOpenAiLogin,
  OpenAiLoginCompletionError,
} from "../services/openai/login.js";
import { OpenAiOauthError, runOpenAiBrowserLogin } from "../services/openai/oauth.js";
import {
  runXaiBrowserLogin,
  runXaiDeviceLogin,
  XaiOauthError,
  type XaiBrowserLoginResult,
} from "../services/xai/oauth.js";
import { clearOpenAiOauthCredentials } from "../utils/openAiOauthCredentials.js";
import {
  clearXaiOauthCredentials,
  saveXaiOauthCredentials,
  xaiOauthTokensToBlob,
} from "../utils/xaiOauthCredentials.js";
import {
  isSignInProvider,
  signedInAccount,
  type SignInProvider,
} from "../auth/provider-sign-in-accounts.js";
import { openUrlInBrowser } from "./auth.js";

export { isSignInProvider, signedInAccount, type SignInProvider };

export type SignInProgress = {
  readonly heading: string;
  readonly url?: string;
  readonly userCode?: string;
};

export type SignInResult =
  | {
      readonly ok: true;
      readonly account: string;
      /** OpenAI only: a ChatGPT subscription sign-in rather than an exchanged key. */
      readonly subscription?: boolean;
    }
  | { readonly ok: false; readonly cancelled: boolean; readonly message: string };

export type SignInOptions = {
  readonly provider: SignInProvider;
  readonly home: HomeContext;
  readonly environment: ProviderEnvironment;
  readonly onProgress: (progress: SignInProgress) => void;
  readonly signal?: AbortSignal;
  /** Grok: skip the browser callback and use a device code. */
  readonly device?: boolean;
  /** Grok: whether a browser can open on this machine (false over SSH). */
  readonly canOpenBrowser?: boolean;
  readonly openUrl?: (url: string) => Promise<void>;
};

/** Delete the stored sign-in. */
export function signOutOfProvider(
  home: HomeContext,
  provider: SignInProvider,
): { readonly ok: boolean; readonly message: string } {
  const account = signedInAccount(home, provider);
  const name = provider === "openai" ? "ChatGPT" : "xAI";
  if (account === null) return { ok: false, message: `No ${name} sign-in stored.` };
  const result = provider === "openai"
    ? clearOpenAiOauthCredentials(home)
    : clearXaiOauthCredentials(home);
  if (!result.success) {
    return {
      ok: false,
      message: `Could not clear the ${name} sign-in: ${result.warning ?? "unknown error"}`,
    };
  }
  return { ok: true, message: `Signed out of ${name} (${account}).` };
}

export async function signInToProvider(options: SignInOptions): Promise<SignInResult> {
  return options.provider === "openai" ? signInToOpenAi(options) : signInToXai(options);
}

async function signInToOpenAi(options: SignInOptions): Promise<SignInResult> {
  const openUrl = options.openUrl ?? openUrlInBrowser;
  let login;
  try {
    login = await raceAbort(
      runOpenAiBrowserLogin({
        environment: options.environment,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onAuthorizeUrl: async (url) => {
          options.onProgress({ heading: "Sign in with your ChatGPT account to continue.", url });
          try {
            await openUrl(url);
          } catch {
            options.onProgress({ heading: "Open this URL in your browser to sign in:", url });
          }
        },
        onStage: (stage) => {
          options.onProgress({
            heading:
              stage === "callback_received"
                ? "Browser sign-in received; completing…"
                : "Exchanging the login code…",
          });
        },
      }),
      options.signal,
    );
  } catch (error) {
    if (options.signal?.aborted) return cancelled();
    if (error instanceof OpenAiOauthError && error.code === "callback_failed") {
      return failed(
        `Sign-in failed: could not open the callback listener (${error.message}). ` +
          "Close whatever holds the port and retry /openai-login.",
      );
    }
    if (error instanceof OpenAiOauthError) {
      return failed(`Sign-in failed: ${error.message} (${error.code}).`);
    }
    throw error;
  }
  options.onProgress({ heading: "Saving the ChatGPT sign-in…" });
  try {
    const completion = await completeOpenAiLogin({
      home: options.home,
      environment: options.environment,
      login,
    });
    return {
      ok: true,
      account: completion.account,
      subscription: completion.authMode === "chatgpt",
    };
  } catch (error) {
    if (error instanceof OpenAiLoginCompletionError) {
      return failed(`Sign-in failed: ${error.message} (${error.code}).`);
    }
    return failed(`Sign-in failed: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

async function signInToXai(options: SignInOptions): Promise<SignInResult> {
  const controller = new AbortController();
  const forward = () => controller.abort();
  options.signal?.addEventListener("abort", forward, { once: true });
  try {
    const login = options.device === true || options.canOpenBrowser === false
      ? await xaiDeviceFlow(options, controller.signal)
      : await xaiBrowserFlowWithDeviceFallback(options, controller.signal);
    if (controller.signal.aborted) return cancelled();
    const blob = xaiOauthTokensToBlob(login.tokens, { tokenEndpoint: login.tokenEndpoint });
    const saved = saveXaiOauthCredentials(options.home, blob);
    if (!saved.success) {
      return failed(`Signed in, but storing tokens failed: ${saved.warning ?? "unknown error"}`);
    }
    return { ok: true, account: blob.accountLabel ?? login.identity.sub ?? "xAI account" };
  } catch (error) {
    if (controller.signal.aborted) return cancelled();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", forward);
  }
}

async function xaiBrowserFlowWithDeviceFallback(
  options: SignInOptions,
  signal: AbortSignal,
): Promise<XaiBrowserLoginResult> {
  const openUrl = options.openUrl ?? openUrlInBrowser;
  let pending = true;
  options.onProgress({ heading: "Preparing xAI browser sign-in..." });
  try {
    return await runXaiBrowserLogin({
      signal,
      onAuthorizeUrl: (url) => {
        options.onProgress({ heading: "Sign in with your X / xAI account to continue.", url });
        // Browser startup must not delay the callback wait or cancellation.
        void openUrl(url).catch(() => {
          if (!pending || signal.aborted) return;
          options.onProgress({ heading: "Open this URL in your browser to sign in:", url });
        });
      },
    });
  } catch (error) {
    // Loopback unavailable (e.g. the Grok CLI holds the port, or a headless
    // host): fall back to the device-code flow.
    if (!signal.aborted && error instanceof XaiOauthError && error.code === "callback_failed") {
      return xaiDeviceFlow(options, signal);
    }
    throw error;
  } finally {
    pending = false;
  }
}

async function xaiDeviceFlow(
  options: SignInOptions,
  signal: AbortSignal,
): Promise<XaiBrowserLoginResult> {
  const openUrl = options.openUrl ?? openUrlInBrowser;
  let pending = true;
  options.onProgress({ heading: "Requesting an xAI device sign-in code..." });
  try {
    return await runXaiDeviceLogin({
      signal,
      onUserCode: ({ userCode, verificationUri, verificationUriComplete }) => {
        const url = verificationUriComplete ?? verificationUri;
        if (options.canOpenBrowser === false) {
          // A browser launched here would open on the remote desktop.
          options.onProgress({
            heading: "Open this URL in a browser on your own device to sign in:",
            url,
            userCode,
          });
          return;
        }
        options.onProgress({ heading: "Sign in with your X / xAI account to continue.", url, userCode });
        // Browser startup must not delay polling or prevent cancellation.
        void openUrl(url).catch(() => {
          if (!pending || signal.aborted) return;
          options.onProgress({ heading: "Open this URL in your browser to sign in:", url, userCode });
        });
      },
    });
  } finally {
    pending = false;
  }
}

/**
 * Stop waiting the moment the caller cancels. The ChatGPT login also closes
 * its callback listener on the same signal; the code exchange after the
 * callback cannot be cancelled, so this keeps the screen from waiting on it.
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(new Error("cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function cancelled(): SignInResult {
  return { ok: false, cancelled: true, message: "Sign-in cancelled." };
}

function failed(message: string): SignInResult {
  return { ok: false, cancelled: false, message };
}
