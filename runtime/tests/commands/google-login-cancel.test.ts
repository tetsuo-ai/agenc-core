import { PassThrough } from "node:stream";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "src/tui/ink.js";
import { resolveHomeContext } from "src/config/home.js";
import { RemoteAuthBackend } from "src/auth/backends/remote.js";
import type { SlashCommandContext } from "src/commands/types.js";
const mocks = vi.hoisted(() => ({ createAuthBackend: vi.fn(), openLocalBrowser: vi.fn(async () => undefined) }));
vi.mock("src/auth/selection.js", () => ({ createAuthBackend: mocks.createAuthBackend }));
vi.mock("src/utils/browser.js", () => ({ openLocalBrowser: mocks.openLocalBrowser }));
import { loginCommand } from "src/commands/auth.js";

describe("Google login cancellation", () => {
  it.each(["\x1b", "\x03"])("cancels with %j and clears the notice", async key => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 30 });
    stdout.resume();
    const root = await createRoot({ stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false });
    const setToolJSX = vi.fn((value: unknown) => root.render((value as { jsx: ReactNode }).jsx));
    let signal: AbortSignal | undefined;
    let finish: (() => void) | undefined;
    mocks.createAuthBackend.mockImplementationOnce((_config, options) => {
      signal = options.remote.loginSignal;
      return new RemoteAuthBackend({ agencHome: "/private/test-home", env: {}, ...options.remote,
        loginFlow: async () => {
          await options.remote.onDeviceCode({ verificationUri: "https://example.test/activate", userCode: "TEST-CODE" });
          return new Promise(resolve => { finish = () => resolve({ token: "late-test-token" }); });
        },
      });
    });
    const configStore = { homeContext: resolveHomeContext({ AGENC_HOME: "/private/test-home" }), current: () => ({}) };
    const ctx = { argsRaw: "", home: "/private", cwd: "/workspace", configStore,
      session: { services: { configStore, providerEnvironment: {} } }, appState: { setToolJSX } } as unknown as SlashCommandContext;
    const pending = loginCommand.execute(ctx);
    try {
      await vi.waitFor(() => expect(setToolJSX).toHaveBeenCalled());
      await new Promise(resolve => setTimeout(resolve, 80));
      stdin.write(key);
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      await expect(pending).resolves.toEqual({ kind: "text", text: "Google sign-in cancelled." });
      expect(setToolJSX).toHaveBeenLastCalledWith({ jsx: null, shouldHidePromptInput: false, clearLocalJSX: true });
    } finally { finish?.(); await pending; root.unmount(); stdin.destroy(); stdout.destroy(); }
  });
});
