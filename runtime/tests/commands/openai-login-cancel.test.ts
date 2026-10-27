import { PassThrough } from "node:stream";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "src/tui/ink.js";
import { resolveHomeContext } from "src/config/home.js";
import type { SlashCommandContext } from "src/commands/types.js";

const mocks = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("src/commands/provider-sign-in.js", () => ({ signInToProvider: mocks.signIn }));
import { openaiLoginCommand } from "src/commands/openai-auth.js";

describe("OpenAI login cancellation", () => {
  it("rejects arguments before starting OAuth", async () => {
    mocks.signIn.mockClear();
    const result = await openaiLoginCommand.execute({ argsRaw: "badargument" } as SlashCommandContext);
    expect(result).toEqual({ kind: "error", message: "Usage: /openai-login" });
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it.each(["\x1b", "\x03"])("cancels with %j and restores the composer", async key => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 30 });
    stdout.resume();
    const root = await createRoot({ stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false });
    const setToolJSX = vi.fn((value: unknown) => root.render((value as { jsx: ReactNode }).jsx));
    let signal: AbortSignal | undefined;
    let finish: (() => void) | undefined;
    mocks.signIn.mockImplementationOnce(async options => {
      signal = options.signal;
      options.onProgress({ heading: "Waiting for ChatGPT", url: "https://example.test/authorize" });
      return new Promise(resolve => {
        finish = () => resolve({ ok: false, cancelled: true, message: "cancelled" });
        signal?.addEventListener("abort", finish!, { once: true });
      });
    });
    const configStore = { homeContext: resolveHomeContext({ AGENC_HOME: "/private/test-home" }), current: () => ({}) };
    const ctx = { argsRaw: "", home: "/private", cwd: "/workspace", configStore,
      session: { services: { configStore, providerEnvironment: {} } }, appState: { setToolJSX } } as unknown as SlashCommandContext;
    const pending = openaiLoginCommand.execute(ctx);
    try {
      await vi.waitFor(() => expect(mocks.signIn).toHaveBeenCalled());
      await new Promise(resolve => setTimeout(resolve, 80));
      stdin.write(key);
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      await expect(pending).resolves.toEqual({ kind: "text", text: "ChatGPT sign-in cancelled." });
      expect(setToolJSX).toHaveBeenLastCalledWith({ jsx: null, shouldHidePromptInput: false, clearLocalJSX: true });
    } finally { finish?.(); await pending; root.unmount(); stdin.destroy(); stdout.destroy(); }
  });
});
