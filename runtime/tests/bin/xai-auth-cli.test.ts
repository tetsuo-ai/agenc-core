import { describe, expect, it, vi } from "vitest";

import {
  buildBrowserOpenEnvironment,
  buildBrowserOpenSpawnSpec,
  formatXaiAuthCliHelpText,
  parseXaiAuthCliArgs,
  runXaiAuthCli,
  type XaiAuthCliDeps,
  type XaiAuthCliIo,
} from "./xai-auth-cli.js";
import {
  XaiOauthError,
  type XaiBrowserLoginResult,
} from "../services/xai/oauth.js";
import type { XaiOauthCredentialBlob } from "../utils/xaiOauthCredentials.js";

function createIo(): XaiAuthCliIo & {
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

function readJsonLines(io: ReturnType<typeof createIo>): unknown[] {
  return io
    .stdoutText()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const LOGIN_RESULT = {
  tokens: {
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
  },
  identity: { email: "developer@example.com", sub: "account-1" },
  tokenEndpoint: "https://auth.x.ai/oauth2/token",
} satisfies XaiBrowserLoginResult;

function createDeps(
  overrides: Partial<XaiAuthCliDeps> = {},
): XaiAuthCliDeps {
  return {
    runBrowserLogin: vi.fn(async () => LOGIN_RESULT),
    runDeviceLogin: vi.fn(async () => LOGIN_RESULT),
    readCredentials: vi.fn(() => undefined),
    saveCredentials: vi.fn(() => ({ success: true })),
    clearCredentials: vi.fn(() => ({ success: true })),
    ...overrides,
  };
}

describe("browser opener hardening", () => {
  it("passes a Windows OAuth URL as one shell-free rundll32 argument", () => {
    const url =
      "https://auth.x.ai/oauth2/authorize?state=opaque&scope=openid%20email&referrer=agenc";
    const launch = buildBrowserOpenSpawnSpec(url, "win32", {
      PATH: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
    });

    expect(launch.command).toBe("rundll32.exe");
    expect(launch.args).toEqual(["url.dll,FileProtocolHandler", url]);
    expect(launch.args).not.toContain("/c");
    expect(launch.args).not.toContain("start");
    expect(launch.options.shell).toBe(false);
  });

  it("retains only browser-session environment and strips credentials", () => {
    const source: NodeJS.ProcessEnv = {
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/Users/developer",
      TMPDIR: "/tmp/session/",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/501/bus",
      XDG_RUNTIME_DIR: "/run/user/501",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\developer",
      XAI_API_KEY: "xai-secret",
      GROK_API_KEY: "grok-secret",
      OPENAI_API_KEY: "openai-secret",
      AGENC_AUTH_TOKEN: "agenc-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GH_TOKEN: "github-secret",
      NPM_TOKEN: "npm-secret",
      NODE_OPTIONS: "--require=/tmp/injected.js",
    };

    const clean = buildBrowserOpenEnvironment(source);

    expect(clean).toMatchObject({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/Users/developer",
      TMPDIR: "/tmp/session/",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/501/bus",
      XDG_RUNTIME_DIR: "/run/user/501",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\developer",
    });
    expect(clean).not.toHaveProperty("XAI_API_KEY");
    expect(clean).not.toHaveProperty("GROK_API_KEY");
    expect(clean).not.toHaveProperty("OPENAI_API_KEY");
    expect(clean).not.toHaveProperty("AGENC_AUTH_TOKEN");
    expect(clean).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(clean).not.toHaveProperty("GH_TOKEN");
    expect(clean).not.toHaveProperty("NPM_TOKEN");
    expect(clean).not.toHaveProperty("NODE_OPTIONS");
    expect(Object.values(clean)).not.toEqual(
      expect.arrayContaining([
        "xai-secret",
        "grok-secret",
        "openai-secret",
        "agenc-secret",
        "aws-secret",
        "github-secret",
        "npm-secret",
      ]),
    );
  });

  it("uses the same scrubbed, shell-free boundary on macOS and Linux", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/Users/developer",
      DISPLAY: ":0",
      XAI_API_KEY: "must-not-leak",
    };
    const mac = buildBrowserOpenSpawnSpec(
      "https://auth.x.ai/a",
      "darwin",
      env,
    );
    const linux = buildBrowserOpenSpawnSpec(
      "https://auth.x.ai/b",
      "linux",
      env,
    );

    expect(mac).toMatchObject({
      command: "open",
      args: ["https://auth.x.ai/a"],
      options: {
        shell: false,
        env: {
          PATH: "/usr/bin",
          HOME: "/Users/developer",
          DISPLAY: ":0",
        },
      },
    });
    expect(linux).toMatchObject({
      command: "xdg-open",
      args: ["https://auth.x.ai/b"],
      options: {
        shell: false,
        env: {
          PATH: "/usr/bin",
          HOME: "/Users/developer",
          DISPLAY: ":0",
        },
      },
    });
    expect(mac.options.env).not.toHaveProperty("XAI_API_KEY");
    expect(linux.options.env).not.toHaveProperty("XAI_API_KEY");
  });
});

describe("xAI auth CLI", () => {
  it("parses aliases, device mode, help, and invalid arguments", () => {
    expect(parseXaiAuthCliArgs(["grok-login", "--json"])).toEqual({
      kind: "login",
      json: true,
      device: false,
    });
    expect(parseXaiAuthCliArgs(["--json", "xai-login", "device"])).toEqual({
      kind: "login",
      json: true,
      device: true,
    });
    expect(parseXaiAuthCliArgs(["xai-logout"])).toEqual({
      kind: "logout",
      json: false,
    });
    expect(parseXaiAuthCliArgs(["grok-login", "--help"])).toEqual({
      kind: "help",
      text: formatXaiAuthCliHelpText(),
    });
    expect(parseXaiAuthCliArgs(["grok-logout", "device"])).toEqual({
      kind: "error",
      message: "grok-logout does not accept argument 'device'",
    });
    expect(parseXaiAuthCliArgs(["grok-login", "--wat"])).toEqual({
      kind: "error",
      message: "grok-login does not accept argument '--wat'",
    });
    expect(parseXaiAuthCliArgs(["login"])).toBeNull();
  });

  it("emits browser PKCE stages, saves the credential, and never prints tokens", async () => {
    const openUrl = vi.fn(async () => undefined);
    const io = { ...createIo(), openUrl };
    const saveCredentials = vi.fn(
      (_blob: XaiOauthCredentialBlob) => ({ success: true }),
    );
    const runBrowserLogin: XaiAuthCliDeps["runBrowserLogin"] = vi.fn(
      async (options) => {
        await options.onAuthorizeUrl("https://auth.x.ai/authorize?state=opaque");
        options.onStage?.("callback_received");
        options.onStage?.("exchanging_code");
        return LOGIN_RESULT;
      },
    );
    const deps = createDeps({ runBrowserLogin, saveCredentials });

    const code = await runXaiAuthCli(
      { kind: "login", json: true, device: false },
      io,
      deps,
    );

    expect(code).toBe(0);
    expect(readJsonLines(io)).toEqual([
      {
        stage: "authorize",
        flow: "browser",
        url: "https://auth.x.ai/authorize?state=opaque",
      },
      { stage: "callback_received", flow: "browser" },
      { stage: "exchanging_code", flow: "browser" },
      {
        ok: true,
        signedIn: true,
        account: "developer@example.com",
        flow: "browser",
      },
    ]);
    expect(openUrl).toHaveBeenCalledWith(
      "https://auth.x.ai/authorize?state=opaque",
    );
    expect(saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        tokenEndpoint: "https://auth.x.ai/oauth2/token",
      }),
    );
    expect(io.stdoutText()).not.toMatch(/access-secret|refresh-secret/);
    expect(io.stderrText()).toBe("");
  });

  it("reports loopback failure and device authorization details before succeeding", async () => {
    const openUrl = vi.fn(async () => undefined);
    const io = { ...createIo(), openUrl };
    const runBrowserLogin: XaiAuthCliDeps["runBrowserLogin"] = vi.fn(
      async () => {
        throw new XaiOauthError(
          "callback_failed",
          "Port 56121 is already in use.",
        );
      },
    );
    const runDeviceLogin: XaiAuthCliDeps["runDeviceLogin"] = vi.fn(
      async (options) => {
        await options.onUserCode({
          userCode: "ABCD-1234",
          verificationUri: "https://auth.x.ai/activate",
          verificationUriComplete:
            "https://auth.x.ai/activate?user_code=ABCD-1234",
        });
        return LOGIN_RESULT;
      },
    );
    const deps = createDeps({ runBrowserLogin, runDeviceLogin });

    const code = await runXaiAuthCli(
      { kind: "login", json: true, device: false },
      io,
      deps,
    );

    expect(code).toBe(0);
    expect(readJsonLines(io)).toEqual([
      {
        stage: "device_fallback",
        from: "browser",
        to: "device",
        code: "callback_failed",
        error: "Port 56121 is already in use.",
      },
      {
        stage: "device_authorize",
        flow: "device",
        url: "https://auth.x.ai/activate?user_code=ABCD-1234",
        userCode: "ABCD-1234",
        verificationUri: "https://auth.x.ai/activate",
        verificationUriComplete:
          "https://auth.x.ai/activate?user_code=ABCD-1234",
      },
      {
        ok: true,
        signedIn: true,
        account: "developer@example.com",
        flow: "device",
      },
    ]);
    expect(openUrl).toHaveBeenCalledWith(
      "https://auth.x.ai/activate?user_code=ABCD-1234",
    );
    expect(io.stdoutText()).not.toMatch(/access-secret|refresh-secret/);
  });

  it("supports an explicit device flow without attempting loopback OAuth", async () => {
    const io = createIo();
    const runBrowserLogin = vi.fn<XaiAuthCliDeps["runBrowserLogin"]>();
    const runDeviceLogin: XaiAuthCliDeps["runDeviceLogin"] = vi.fn(
      async (options) => {
        await options.onUserCode({
          userCode: "CODE-1",
          verificationUri: "https://auth.x.ai/activate",
        });
        return LOGIN_RESULT;
      },
    );
    const deps = createDeps({ runBrowserLogin, runDeviceLogin });

    const code = await runXaiAuthCli(
      { kind: "login", json: true, device: true },
      io,
      deps,
    );

    expect(code).toBe(0);
    expect(runBrowserLogin).not.toHaveBeenCalled();
    expect(readJsonLines(io)[0]).toEqual({
      stage: "device_authorize",
      flow: "device",
      url: "https://auth.x.ai/activate",
      userCode: "CODE-1",
      verificationUri: "https://auth.x.ai/activate",
    });
  });

  it("returns a structured typed OAuth error", async () => {
    const io = createIo();
    const runBrowserLogin: XaiAuthCliDeps["runBrowserLogin"] = vi.fn(
      async () => {
        throw new XaiOauthError(
          "access_denied",
          "xAI sign-in was not completed.",
        );
      },
    );

    const code = await runXaiAuthCli(
      { kind: "login", json: true, device: false },
      io,
      createDeps({ runBrowserLogin }),
    );

    expect(code).toBe(1);
    expect(readJsonLines(io)).toEqual([
      {
        ok: false,
        error: "xAI sign-in was not completed.",
        code: "access_denied",
      },
    ]);
    expect(io.stderrText()).toBe("");
  });

  it("returns store_failed when secure storage rejects a completed login", async () => {
    const io = createIo();
    const code = await runXaiAuthCli(
      { kind: "login", json: true, device: false },
      io,
      createDeps({
        saveCredentials: () => ({
          success: false,
          warning: "secure storage unavailable",
        }),
      }),
    );

    expect(code).toBe(1);
    expect(readJsonLines(io)).toEqual([
      {
        ok: false,
        error:
          "signed in, but storing the credential failed: secure storage unavailable",
        code: "store_failed",
      },
    ]);
  });

  it("logs out through the same structured surface", async () => {
    const io = createIo();
    const clearCredentials = vi.fn(() => ({ success: true }));
    const code = await runXaiAuthCli(
      { kind: "logout", json: true },
      io,
      createDeps({
        readCredentials: () => ({ accessToken: "stored-secret" }),
        clearCredentials,
      }),
    );

    expect(code).toBe(0);
    expect(readJsonLines(io)).toEqual([{ ok: true, signedIn: false }]);
    expect(clearCredentials).toHaveBeenCalledOnce();
    expect(io.stdoutText()).not.toContain("stored-secret");
  });

  it("returns a structured error when secure storage cannot clear logout", async () => {
    const io = createIo();
    const code = await runXaiAuthCli(
      { kind: "logout", json: true },
      io,
      createDeps({
        readCredentials: () => ({ accessToken: "stored-secret" }),
        clearCredentials: () => ({
          success: false,
          warning: "keychain is locked",
        }),
      }),
    );

    expect(code).toBe(1);
    expect(readJsonLines(io)).toEqual([
      {
        ok: false,
        error: "keychain is locked",
        code: "store_failed",
      },
    ]);
    expect(io.stdoutText()).not.toContain("stored-secret");
    expect(io.stderrText()).toBe("");
  });
});
