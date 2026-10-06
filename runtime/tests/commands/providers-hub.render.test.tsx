import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { ProvidersHubView, type ProvidersHubServices } from "./providers-hub.js";
import type { ProvidersHubRow, ProvidersHubSnapshot } from "./providers-hub-snapshot.js";
import { renderPtyRows } from "../../scripts/check-tui-e2e/harness.mjs";
import { createRoot } from "../tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../tui/state/AppState.js";

function row(overrides: Partial<ProvidersHubRow> & Pick<ProvidersHubRow, "provider" | "name">): ProvidersHubRow {
  return {
    access: "api-key",
    connection: "not-set",
    status: "not set",
    model: "model-a",
    keySaved: false,
    ...overrides,
  };
}

const deepseek = row({
  provider: "deepseek",
  name: "DeepSeek",
  connection: "current",
  status: "key saved",
  model: "deepseek-flash",
  keySaved: true,
});
const groq = row({ provider: "groq", name: "Groq", model: "llama-3.3" });
const ollama = row({ provider: "ollama", name: "Ollama", access: "local", connection: "connected", status: "local" });

const snapshot: ProvidersHubSnapshot = {
  currentProvider: "deepseek",
  currentModel: "deepseek-flash",
  rows: [deepseek, groq, ollama],
};

function fakeServices(overrides: Partial<ProvidersHubServices> = {}): ProvidersHubServices {
  return {
    reload: () => ({
      ...snapshot,
      rows: [deepseek, { ...groq, connection: "connected", status: "key saved", keySaved: true }, ollama],
    }),
    probeLocal: async () => new Set(),
    modelsFor: (provider) =>
      provider === "groq"
        ? [{ model: "llama-3.3", displayModel: "llama-3.3", current: false, isDefault: true }]
        : [
            { model: "deepseek-flash", displayModel: "deepseek-flash", current: true, isDefault: false },
            { model: "deepseek-pro", displayModel: "deepseek-pro", current: false, isDefault: false },
          ],
    connect: vi.fn(async () => ({ ok: true as const, message: "Key checked and saved." })),
    choose: vi.fn(async () => ({ ok: true as const, message: "saved" })),
    forget: vi.fn(() => ({ ok: true as const, message: "Saved key removed." })),
    signIn: vi.fn(async () => ({ ok: true as const, account: "ana@example.com" })),
    signOut: vi.fn(() => ({ ok: true as const, message: "Signed out of xAI (ana@example.com)." })),
    setAuth: vi.fn(async () => ({ ok: true as const, message: "Saved. New sessions use the API key." })),
    ...overrides,
  };
}

async function mount(element: React.ReactNode) {
  const stdin = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (enabled: boolean) => void;
    ref?: () => void;
    unref?: () => void;
  };
  const stdout = new PassThrough() as PassThrough & { columns?: number; rows?: number; isTTY?: boolean };
  stdin.isTTY = true;
  stdin.setRawMode = vi.fn();
  stdin.ref = () => {};
  stdin.unref = () => {};
  stdout.columns = 120;
  stdout.rows = 30;
  stdout.isTTY = true;
  let written = "";
  stdout.on("data", (chunk: Buffer) => {
    written += chunk.toString("utf8");
  });
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  root.render(
    <AppStateProvider initialState={getDefaultAppState()}>{element}</AppStateProvider>,
  );
  await sleep();
  return {
    /** The screen as a terminal shows it now, lowercased (popup titles render in capitals). */
    screen(): string {
      return (renderPtyRows(written, { cols: 120, rows: 30 }) as string[])
        .join("\n")
        .toLowerCase();
    },
    async press(...keys: string[]) {
      for (const key of keys) {
        stdin.write(key);
        await sleep();
      }
    },
    unmount: () => root.unmount(),
  };
}

function sleep(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("providers screen", () => {
  it("lists providers with one status each and filters as you type", async () => {
    const screen = await mount(
      <ProvidersHubView initial={snapshot} services={fakeServices()} onDone={() => {}} />,
    );
    try {
      const first = screen.screen();
      // The local probe found nothing running, so only DeepSeek is connected.
      expect(first).toContain("providers · 1 connected");
      expect(first).toContain("not running");
      expect(first).toContain("in use · key saved");
      expect(first).toContain("groq");
      expect(first).toContain("not set");

      await screen.press("g", "r");
      const filtered = screen.screen();
      expect(filtered).toContain("filter: gr");
      expect(filtered).toContain("groq");
      expect(filtered).not.toContain("deepseek");
    } finally {
      screen.unmount();
    }
  });

  it("asks for a key on a provider that is not set, then shows its models", async () => {
    const services = fakeServices();
    const screen = await mount(
      <ProvidersHubView initial={snapshot} services={services} onDone={() => {}} />,
    );
    try {
      await screen.press("g", "r", "o", "q", "\r");
      const keyPanel = screen.screen();
      expect(keyPanel).toContain("groq api key");
      expect(keyPanel).toContain("checks it with groq");

      await screen.press("g", "s", "k", "-", "1");
      expect(screen.screen()).not.toContain("gsk-1");
      await screen.press("\r");
      await sleep(60);

      expect(services.connect).toHaveBeenCalledWith("groq", "gsk-1");
      const models = screen.screen();
      expect(models).toContain("llama-3.3");
      expect(models).toContain("groq · 1 model · key saved");
    } finally {
      screen.unmount();
    }
  });

  it("uses a model, saves it, and closes", async () => {
    const services = fakeServices();
    const onDone = vi.fn();
    const screen = await mount(
      <ProvidersHubView initial={snapshot} initialProvider="deepseek" services={services} onDone={onDone} />,
    );
    try {
      const models = screen.screen();
      expect(models).toContain("deepseek-flash");
      expect(models).toContain("in use");
      expect(models).toContain("remove saved key");

      await screen.press("\u001b[B", "\r");
      await sleep(60);
      expect(services.choose).toHaveBeenCalledWith("deepseek", "deepseek-pro");
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      screen.unmount();
    }
  });

  it("removes a saved key from the model list", async () => {
    const services = fakeServices();
    const screen = await mount(
      <ProvidersHubView initial={snapshot} initialProvider="deepseek" services={services} onDone={() => {}} />,
    );
    try {
      screen.screen();
      // deepseek-flash, deepseek-pro, Replace API key, Remove saved key
      await screen.press("\u001b[B", "\u001b[B", "\u001b[B", "\r");
      expect(services.forget).toHaveBeenCalledWith("deepseek");
      expect(screen.screen()).toContain("saved key removed.");
    } finally {
      screen.unmount();
    }
  });

  it("explains a local provider that is not running", async () => {
    const screen = await mount(
      <ProvidersHubView initial={snapshot} services={fakeServices()} onDone={() => {}} />,
    );
    try {
      await sleep(60);
      await screen.press("o", "l", "l", "\r");
      const info = screen.screen();
      expect(info).toContain("ollama runs on this computer and is not answering.");
      expect(info).toContain("check again");
    } finally {
      screen.unmount();
    }
  });
});

describe("account sign-in on the providers screen", () => {
  const grokNotSet = row({ provider: "grok", name: "xAI Grok", model: "grok-4.6" });
  const grokSignedIn: ProvidersHubRow = {
    ...grokNotSet,
    connection: "connected",
    status: "signed in as ana@example.com",
    keySaved: true,
    signIn: { account: "ana@example.com", keyAvailable: true, using: "account", setting: "auto" },
  };
  const withGrok = (grok: ProvidersHubRow): ProvidersHubSnapshot => ({
    ...snapshot,
    rows: [deepseek, grok, groq, ollama],
  });
  const grokModels = () => [
    { model: "grok-4.6", displayModel: "grok-4.6", current: false, isDefault: true },
  ];

  it("offers sign-in or a key, shows the browser step, then the models", async () => {
    let finish: (value: { ok: true; account: string }) => void = () => {};
    const signIn = vi.fn(
      (_provider: string, onProgress: (progress: { heading: string; url?: string; userCode?: string }) => void) => {
        onProgress({
          heading: "Sign in with your X / xAI account to continue.",
          url: "https://auth.x.ai/activate",
          userCode: "WXYZ-1234",
        });
        return new Promise<{ ok: true; account: string }>((resolve) => {
          finish = resolve;
        });
      },
    );
    const services = fakeServices({
      reload: () => withGrok(grokSignedIn),
      modelsFor: grokModels,
      signIn: signIn as ProvidersHubServices["signIn"],
    });
    const screen = await mount(
      <ProvidersHubView initial={withGrok(grokNotSet)} services={services} onDone={() => {}} />,
    );
    try {
      await screen.press("x", "a", "i", "\r");
      const choices = screen.screen();
      expect(choices).toContain("sign in with your x account");
      expect(choices).toContain("paste an api key");

      await screen.press("\r");
      const waiting = screen.screen();
      expect(signIn).toHaveBeenCalledWith("grok", expect.any(Function), expect.any(AbortSignal));
      expect(waiting).toContain("xai grok sign-in");
      expect(waiting).toContain("https://auth.x.ai/activate");
      expect(waiting).toContain("wxyz-1234");

      finish({ ok: true, account: "ana@example.com" });
      await sleep(60);
      const models = screen.screen();
      expect(models).toContain("signed in as ana@example.com");
      expect(models).toContain("grok-4.6");
      expect(models).toContain("sign out (ana@example.com)");
      expect(models).toContain("use the api key instead of your account");
    } finally {
      screen.unmount();
    }
  });

  it("cancels a pending sign-in with esc", async () => {
    const signIn = vi.fn(
      (_provider: string, _onProgress: unknown, signal: AbortSignal) =>
        new Promise<{ ok: false; cancelled: true; message: string }>((resolve) => {
          signal.addEventListener("abort", () =>
            resolve({ ok: false, cancelled: true, message: "Sign-in cancelled." }),
          );
        }),
    );
    const services = fakeServices({
      reload: () => withGrok(grokNotSet),
      signIn: signIn as unknown as ProvidersHubServices["signIn"],
    });
    const screen = await mount(
      <ProvidersHubView initial={withGrok(grokNotSet)} services={services} onDone={() => {}} />,
    );
    try {
      await screen.press("x", "a", "i", "\r", "\r");
      expect(screen.screen()).toContain("esc to cancel");
      await screen.press("\u001b");
      await sleep(60);
      expect((signIn.mock.calls[0]?.[2] as AbortSignal).aborted).toBe(true);
      expect(screen.screen()).toContain("connect with");
    } finally {
      screen.unmount();
    }
  });

  it("switches the saved choice to the API key", async () => {
    const services = fakeServices({ reload: () => withGrok(grokSignedIn), modelsFor: grokModels });
    const screen = await mount(
      <ProvidersHubView
        initial={withGrok(grokSignedIn)}
        initialProvider="grok"
        services={services}
        onDone={() => {}}
      />,
    );
    try {
      // grok-4.6, Sign out, Use the API key instead
      await screen.press("\u001b[B", "\u001b[B", "\r");
      await sleep(60);
      expect(services.setAuth).toHaveBeenCalledWith("grok", "api-key");
      expect(screen.screen()).toContain("saved. new sessions use the api key.");
    } finally {
      screen.unmount();
    }
  });
});
