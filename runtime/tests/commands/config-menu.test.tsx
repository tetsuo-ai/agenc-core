import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { describe, it, vi } from "vitest";

import {
  ConfigMenuView,
  readConfigMenuSnapshot,
} from "./config-menu.js";
import { ConfigStore } from "../config/store.js";
import { defaultConfig, type AgenCConfig } from "../config/schema.js";
import { createRoot } from "../tui/ink.js";
import {
  AppStateProvider,
  getDefaultAppState,
} from "../tui/state/AppState.js";
import type { SlashCommandContext } from "./types.js";

describe("interactive config menu", () => {
  it("refreshes an untouched editor draft when ConfigStore reloads", async () => {
    const initial = configWithEditor("inline", "clean", "never");
    const loaded = configWithEditor("neovim", "user", "always");
    const store = new ConfigStore({
      base: initial,
      env: {},
      loader: async () => loaded,
    });
    const snapshot = readConfigMenuSnapshot({
      session: { services: {} },
      argsRaw: "",
      cwd: "/workspace",
      home: "/home/test",
      agencHome: "/home/test/.agenc",
      configStore: store,
    } as SlashCommandContext);
    const editorIndex = snapshot.rows.findIndex((row) => row.key === "buffer");
    const streams = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: streams.stdin as unknown as NodeJS.ReadStream,
      stdout: streams.stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider initialState={getDefaultAppState()}>
          <ConfigMenuView
            snapshot={{ ...snapshot, activeIndex: editorIndex }}
            store={store}
            agencHome="/home/test/.agenc"
            onDone={() => {}}
          />
        </AppStateProvider>,
      );
      streams.stdin.write("\r");
      await waitForOutput(
        streams.output,
        (output) =>
          output.includes("editorsettings") &&
          output.includes("inline") &&
          output.includes("clean") &&
          output.includes("never"),
      );

      await store.reload();
      await waitForOutput(
        streams.output,
        (output) =>
          output.includes("neovim") &&
          output.includes("user") &&
          output.includes("always"),
      );
    } finally {
      root.unmount();
      streams.stdin.end();
      streams.stdout.end();
    }
  });
});

function configWithEditor(
  provider: "inline" | "neovim" | "external",
  init: "clean" | "user",
  showTabs: "never" | "always",
): AgenCConfig {
  return {
    ...defaultConfig(),
    buffer: {
      ...defaultConfig().buffer,
      provider,
      show_tabs: showTabs,
      neovim: {
        ...defaultConfig().buffer?.neovim,
        init,
      },
    },
  };
}

function createStreams(): {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly output: () => string;
} {
  let output = "";
  const stdin = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (enabled: boolean) => void;
    ref?: () => void;
    unref?: () => void;
  };
  const stdout = new PassThrough() as PassThrough & {
    columns?: number;
    rows?: number;
    isTTY?: boolean;
  };
  stdin.isTTY = true;
  stdin.setRawMode = vi.fn();
  stdin.ref = () => {};
  stdin.unref = () => {};
  stdout.columns = 150;
  stdout.rows = 40;
  stdout.isTTY = true;
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  return { stdin, stdout, output: () => output };
}

async function waitForOutput(
  output: () => string,
  predicate: (output: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + 2_000;
  let rendered = "";
  while (Date.now() < deadline) {
    rendered = stripAnsi(output()).replace(/\s+/gu, "");
    if (predicate(rendered)) return rendered;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for config output:\n${rendered}`);
}
