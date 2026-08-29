import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pluginsCommand } from "./plugins.js";
import type { SlashCommandContext } from "./types.js";
import { ConfigStore } from "../config/store.js";

function makeCtx(
  appState?: SlashCommandContext["appState"],
): SlashCommandContext {
  const workspaceRoot = "/tmp/project";
  return {
    session: {
      services: {
        configStore: new ConfigStore({
          home: "/tmp/agenc-plugin-command-home",
          env: {},
          cwd: workspaceRoot,
          projectRoot: workspaceRoot,
        }),
        runtimeOptions: {
          simpleMode: false,
          stdinDataMode: false,
          remoteMode: false,
          sessionTempRoot: tmpdir(),
          pluginStorageRoot: join(tmpdir(), "agenc-plugin-command-test"),
          allowUntrustedHooks: false,
        },
      },
    } as SlashCommandContext["session"],
    argsRaw: "",
    cwd: workspaceRoot,
    home: "/tmp",
    appState,
  };
}

describe("pluginsCommand", () => {
  it("falls back to text when plugin AppState is unavailable", async () => {
    const result = await pluginsCommand.execute(makeCtx());

    expect(result).toEqual({
      kind: "text",
      text: "Plugin state is not available in this session.",
    });
  });

  it("opens the v2 plugins menu when running in the interactive TUI", async () => {
    const setToolJSX = vi.fn();
    const result = await pluginsCommand.execute(
      makeCtx({
        getAppState: () => ({
          plugins: {
            enabled: [{ name: "alpha", version: "1.2.3" }],
            disabled: [{ name: "beta" }],
            errors: [{ message: "failed to load gamma" }],
            needsRefresh: true,
          },
        }),
        setToolJSX,
      }),
    );

    expect(result).toEqual({ kind: "skip" });
    expect(setToolJSX).toHaveBeenCalledOnce();
    expect(setToolJSX).toHaveBeenCalledWith(
      expect.objectContaining({
        isLocalJSXCommand: true,
        shouldHidePromptInput: true,
        jsx: expect.anything(),
      }),
    );
  });
});
