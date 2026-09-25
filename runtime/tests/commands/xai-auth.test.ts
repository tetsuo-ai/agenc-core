import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { PassThrough } from "node:stream";
import { createRoot } from "../../src/tui/ink.js";

import type { EnvSnapshot } from "../../src/config/env.js";
import { resolveHomeContext } from "../../src/config/home.js";
import type { ConfigStore } from "../../src/config/store.js";
import type { SlashCommandContext } from "../../src/commands/types.js";

const mocks = vi.hoisted(() => ({
  applyProviderSwitch: vi.fn(async () => ({
    applied: true,
    model: "grok-4.5",
    summary: "Provider switched to grok.",
  })),
  clearXaiOauthCredentials: vi.fn(() => ({ success: true })),
  openUrlInBrowser: vi.fn(async () => undefined),
  readXaiOauthCredentials: vi.fn(() => ({
    accessToken: "stored-token",
    accountLabel: "test@example.com",
  })),
  runXaiBrowserLogin: vi.fn(async () => ({
    identity: { sub: "xai-user" },
    tokenEndpoint: "https://example.test/token",
    tokens: { accessToken: "oauth-token" },
  })),
  runXaiDeviceLogin: vi.fn(),
  saveXaiOauthCredentials: vi.fn(() => ({ success: true })),
  xaiOauthTokensToBlob: vi.fn(() => ({
    accessToken: "oauth-token",
    accountLabel: "test@example.com",
  })),
}));

vi.mock("../../src/services/xai/oauth.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/services/xai/oauth.js")
  >();
  return {
    ...actual,
    runXaiBrowserLogin: mocks.runXaiBrowserLogin,
    runXaiDeviceLogin: mocks.runXaiDeviceLogin,
  };
});

vi.mock("../../src/utils/xaiOauthCredentials.js", () => ({
  clearXaiOauthCredentials: mocks.clearXaiOauthCredentials,
  readXaiOauthCredentials: mocks.readXaiOauthCredentials,
  saveXaiOauthCredentials: mocks.saveXaiOauthCredentials,
  xaiOauthTokensToBlob: mocks.xaiOauthTokensToBlob,
}));

vi.mock("../../src/commands/auth.js", () => ({
  openUrlInBrowser: mocks.openUrlInBrowser,
}));

vi.mock("../../src/commands/provider.js", () => ({
  applyProviderSwitch: mocks.applyProviderSwitch,
}));

import {
  grokLoginCommand,
  grokLogoutCommand,
} from "../../src/commands/xai-auth.js";
import { XaiOauthError } from "../../src/services/xai/oauth.js";

type CommandConfigStore = Pick<ConfigStore, "current" | "homeContext">;

function configStore(name: string): CommandConfigStore {
  return {
    current: () => ({}) as ReturnType<ConfigStore["current"]>,
    homeContext: resolveHomeContext(
      { AGENC_HOME: `/tmp/agenc-xai-auth-${name}` },
      { platformHome: "/tmp" },
    ),
  };
}

function commandContext(
  environment: EnvSnapshot,
  store: CommandConfigStore = configStore("canonical"),
): SlashCommandContext {
  return {
    session: {
      services: {
        configStore: store,
        providerService: { environment: () => environment },
      },
    } as SlashCommandContext["session"],
    argsRaw: "",
    cwd: "/workspace",
    home: "/tmp",
    configStore: store as SlashCommandContext["configStore"],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("xAI auth command authority", () => {
  beforeEach(() => {
    // The flow choice depends on whether the TUI runs in an SSH session; pin
    // "local" so these cases do not inherit the developer's own shell.
    for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) vi.stubEnv(name, "");
  });

  test("uses the device flow over SSH and never opens a browser on the remote host", async () => {
    // The loopback callback and the launched browser both live on the remote
    // machine, so the browser flow could only time out with input paused.
    vi.stubEnv("SSH_CONNECTION", "203.0.113.7 50000 198.51.100.2 22");
    const setToolJSX = vi.fn();
    mocks.runXaiDeviceLogin.mockImplementationOnce(async (options: {
      onUserCode: (info: { userCode: string; verificationUri: string }) => void;
    }) => {
      await options.onUserCode({ userCode: "TEST-CODE", verificationUri: "https://auth.x.ai/activate" });
      const notices = JSON.stringify(setToolJSX.mock.calls);
      expect(notices).toContain("Open this URL in a browser on your own device to sign in:");
      expect(notices).toContain("https://auth.x.ai/activate");
      expect(notices).toContain("TEST-CODE");
      return {
        identity: { sub: "xai-user" }, tokenEndpoint: "https://auth.x.ai/oauth2/token",
        tokens: { accessToken: "oauth-token" },
      };
    });
    await expect(grokLoginCommand.execute({
      ...commandContext(Object.freeze({})), argsRaw: "", appState: { setToolJSX },
    })).resolves.toMatchObject({ kind: "text" });
    expect(mocks.runXaiDeviceLogin).toHaveBeenCalledOnce();
    expect(mocks.runXaiBrowserLogin).not.toHaveBeenCalled();
    expect(mocks.openUrlInBrowser).not.toHaveBeenCalled();
  });

  test.each([
    { flow: "device", key: "\x1b" }, { flow: "device", key: "\x03" },
    { flow: "browser", key: "\x1b" }, { flow: "browser", key: "\x03" },
    { flow: "discovery", key: "\x1b" }, { flow: "discovery", key: "\x03" },
  ])("cancels a pending $flow login on $key without storing tokens", async ({ flow, key }) => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true, ref() {}, unref() {}, setRawMode() {},
    });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 30 });
    stdout.resume();
    const root = await createRoot({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false, patchConsole: false,
    });
    const setToolJSX = vi.fn((value: unknown) => {
      root.render((value as { jsx: ReactNode }).jsx);
    });
    let signal: AbortSignal | undefined;
    let finishLogin: (() => void) | undefined;
    const loginMock = flow === "device" ? mocks.runXaiDeviceLogin : mocks.runXaiBrowserLogin;
    loginMock.mockImplementationOnce(async (options?: {
      signal?: AbortSignal;
      onUserCode?: (info: { userCode: string; verificationUri: string }) => void | Promise<void>;
      onAuthorizeUrl?: (url: string) => void | Promise<void>;
    }) => {
      signal = options?.signal;
      if (flow === "device") {
        await options?.onUserCode?.({ userCode: "TEST-CODE", verificationUri: "https://auth.x.ai/activate" });
      } else if (flow === "browser") {
        await options?.onAuthorizeUrl?.("https://auth.x.ai/oauth2/authorize");
      }
      return new Promise<{ identity: { sub: string }; tokenEndpoint: string; tokens: { accessToken: string } }>((resolve, reject) => {
        finishLogin = () => resolve({
          identity: { sub: "cancelled-user" },
          tokenEndpoint: "https://auth.x.ai/oauth2/token",
          tokens: { accessToken: "late-token" },
        });
        signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
      });
    });
    const ctx = { ...commandContext(Object.freeze({})), argsRaw: flow === "device" ? "device" : "", appState: { setToolJSX } };
    const pending = grokLoginCommand.execute(ctx);
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      stdin.write(key);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(signal?.aborted).toBe(true);
      await expect(pending).resolves.toEqual({ kind: "text", text: "xAI sign-in cancelled." });
      expect(mocks.saveXaiOauthCredentials).not.toHaveBeenCalled();
      expect(mocks.applyProviderSwitch).not.toHaveBeenCalled();
      if (flow !== "device") expect(mocks.runXaiDeviceLogin).not.toHaveBeenCalled();
      expect(setToolJSX).toHaveBeenLastCalledWith({
        jsx: null, shouldHidePromptInput: false, clearLocalJSX: true,
      });
    } finally {
      finishLogin?.();
      await pending;
      root.unmount();
      stdin.destroy();
      stdout.destroy();
    }
  });

  test("retains device fallback and the same cancellation signal when the callback port is unavailable", async () => {
    let browserSignal: AbortSignal | undefined;
    mocks.runXaiBrowserLogin.mockImplementationOnce(async (options?: { signal?: AbortSignal }) => {
      browserSignal = options?.signal;
      throw new XaiOauthError("callback_failed", "Test callback port unavailable");
    });
    mocks.runXaiDeviceLogin.mockImplementationOnce(async (options: { signal?: AbortSignal }) => {
      expect(options.signal).toBe(browserSignal);
      expect(options.signal?.aborted).toBe(false);
      return {
        identity: { sub: "xai-user" }, tokenEndpoint: "https://auth.x.ai/oauth2/token",
        tokens: { accessToken: "oauth-token" },
      };
    });
    await expect(grokLoginCommand.execute(commandContext(Object.freeze({}))))
      .resolves.toMatchObject({ kind: "text" });
    expect(mocks.runXaiDeviceLogin).toHaveBeenCalledOnce();
    expect(mocks.saveXaiOauthCredentials).toHaveBeenCalledOnce();
  });

  test.each(["device", "browser"])("does not save a late %s result after cancellation", async (flow) => {
    const setToolJSX = vi.fn();
    const loginMock = flow === "device" ? mocks.runXaiDeviceLogin : mocks.runXaiBrowserLogin;
    loginMock.mockImplementationOnce(async (options?: {
      onUserCode?: (info: { userCode: string; verificationUri: string }) => void;
      onAuthorizeUrl?: (url: string) => void;
    }) => {
      if (flow === "device") options?.onUserCode?.({ userCode: "TEST-CODE", verificationUri: "https://auth.x.ai/activate" });
      else options?.onAuthorizeUrl?.("https://auth.x.ai/oauth2/authorize");
      const notice = setToolJSX.mock.calls.at(-1)?.[0] as { jsx: { props: { onCancel: () => void } } };
      notice.jsx.props.onCancel();
      // Simulate a provider completing despite cancellation of its request.
      return {
        identity: { sub: "cancelled-user" },
        tokenEndpoint: "https://auth.x.ai/oauth2/token",
        tokens: { accessToken: "late-token" },
      };
    });
    const result = await grokLoginCommand.execute({
      ...commandContext(Object.freeze({})), argsRaw: flow === "device" ? "device" : "", appState: { setToolJSX },
    });
    expect(result).toEqual({ kind: "text", text: "xAI sign-in cancelled." });
    expect(mocks.saveXaiOauthCredentials).not.toHaveBeenCalled();
    expect(mocks.applyProviderSwitch).not.toHaveBeenCalled();
  });

  test("shows a manual-open hint when device browser startup fails", async () => {
    const setToolJSX = vi.fn();
    mocks.openUrlInBrowser.mockRejectedValueOnce(new Error("No graphical browser environment"));
    mocks.runXaiDeviceLogin.mockImplementationOnce(async (options: {
      onUserCode: (info: { userCode: string; verificationUri: string }) => void;
    }) => {
      await options.onUserCode({ userCode: "TEST-CODE", verificationUri: "https://auth.x.ai/activate" });
      const notices = JSON.stringify(setToolJSX.mock.calls);
      expect(notices).toContain("Open this URL in your browser to sign in:");
      expect(notices).toContain("https://auth.x.ai/activate");
      expect(notices).toContain("TEST-CODE");
      return {
        identity: { sub: "xai-user" }, tokenEndpoint: "https://auth.x.ai/oauth2/token",
        tokens: { accessToken: "oauth-token" },
      };
    });
    await expect(grokLoginCommand.execute({
      ...commandContext(Object.freeze({})), argsRaw: "device", appState: { setToolJSX },
    })).resolves.toMatchObject({ kind: "text" });
  });

  test.each(["device", "browser"])("continues %s login while the browser opener is pending and ignores its late failure", async (flow) => {
    const setToolJSX = vi.fn();
    let rejectBrowser: ((error: Error) => void) | undefined;
    mocks.openUrlInBrowser.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectBrowser = reject;
    }));
    const loginMock = flow === "device" ? mocks.runXaiDeviceLogin : mocks.runXaiBrowserLogin;
    loginMock.mockImplementationOnce(async (options?: {
      onUserCode?: (info: { userCode: string; verificationUri: string }) => void | Promise<void>;
      onAuthorizeUrl?: (url: string) => void | Promise<void>;
    }) => {
      if (flow === "device") await options?.onUserCode?.({ userCode: "TEST-CODE", verificationUri: "https://auth.x.ai/activate" });
      else await options?.onAuthorizeUrl?.("https://auth.x.ai/oauth2/authorize");
      return {
        identity: { sub: "xai-user" }, tokenEndpoint: "https://auth.x.ai/oauth2/token",
        tokens: { accessToken: "oauth-token" },
      };
    });
    let completed = false;
    const pending = grokLoginCommand.execute({
      ...commandContext(Object.freeze({})), argsRaw: flow === "device" ? "device" : "", appState: { setToolJSX },
    }).then((result) => { completed = true; return result; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(completed).toBe(true);
      await expect(pending).resolves.toMatchObject({ kind: "text" });
      expect(setToolJSX).toHaveBeenLastCalledWith({
        jsx: null, shouldHidePromptInput: false, clearLocalJSX: true,
      });
      const notices = setToolJSX.mock.calls.length;
      rejectBrowser?.(new Error("late browser failure"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(setToolJSX).toHaveBeenCalledTimes(notices);
    } finally {
      rejectBrowser?.(new Error("test cleanup"));
      await pending;
    }
  });

  test.each([
    ["login", grokLoginCommand],
    ["logout", grokLogoutCommand],
  ])("rejects conflicting ConfigStores before %s credential mutation", async (_, command) => {
    const sessionStore = configStore("session");
    const contextStore = configStore("context");
    const ctx = commandContext(Object.freeze({}), sessionStore);
    ctx.configStore = contextStore as SlashCommandContext["configStore"];

    await expect(command.execute(ctx)).resolves.toEqual({
      kind: "error",
      message: "Slash command received conflicting ConfigStore authorities",
    });
    expect(mocks.runXaiBrowserLogin).not.toHaveBeenCalled();
    expect(mocks.readXaiOauthCredentials).not.toHaveBeenCalled();
    expect(mocks.saveXaiOauthCredentials).not.toHaveBeenCalled();
    expect(mocks.clearXaiOauthCredentials).not.toHaveBeenCalled();
  });

  test("does not report an ambient API key absent from the captured environment", async () => {
    vi.stubEnv("XAI_API_KEY", "ambient-key");

    const result = await grokLoginCommand.execute(
      commandContext(Object.freeze({})),
    );

    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).not.toContain("API key is also set");
    }
  });

  test("reports an API key present in the captured environment", async () => {
    vi.stubEnv("XAI_API_KEY", "");

    const result = await grokLoginCommand.execute(
      commandContext(Object.freeze({ XAI_API_KEY: "captured-key" })),
    );

    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("API key is also set");
    }
  });

  test("keeps the authorization URL visible when the browser launcher fails", async () => {
    const setToolJSX = vi.fn();
    const context = commandContext(Object.freeze({}));
    context.appState = { setToolJSX };
    mocks.openUrlInBrowser.mockRejectedValueOnce(new Error("Browser launcher failed"));
    mocks.runXaiBrowserLogin.mockImplementationOnce(async (options?: {
      onAuthorizeUrl?: (url: string) => Promise<void>;
    }) => {
      await options?.onAuthorizeUrl?.("https://example.test/authorize");
      const notices = JSON.stringify(setToolJSX.mock.calls);
      expect(notices).toContain("Open this URL in your browser to sign in:");
      expect(notices).toContain("https://example.test/authorize");
      return {
        identity: { sub: "xai-user" },
        tokenEndpoint: "https://example.test/token",
        tokens: { accessToken: "oauth-token" },
      };
    });
    await expect(grokLoginCommand.execute(context)).resolves.toMatchObject({ kind: "text" });
    expect(mocks.openUrlInBrowser).toHaveBeenCalledWith("https://example.test/authorize");
  });
});
