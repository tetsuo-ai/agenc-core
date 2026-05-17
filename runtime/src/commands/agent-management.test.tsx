import { describe, expect, it, vi } from "vitest";

import agentsCommand from "./agent-management.js";
import type { SlashCommandContext } from "./types.js";

function makeCtx(
  appState?: SlashCommandContext["appState"],
): SlashCommandContext {
  return {
    session: { services: {} } as SlashCommandContext["session"],
    argsRaw: "",
    cwd: "/tmp/project",
    home: "/tmp",
    appState,
  };
}

describe("agentsCommand", () => {
  it("falls back to an interactive-only error without the TUI bridge", async () => {
    const result = await agentsCommand.execute(makeCtx());

    expect(result).toEqual({
      kind: "error",
      message: "/agents requires the interactive TUI.",
    });
  });

  it("opens the v2 agents menu when running in the interactive TUI", async () => {
    const setToolJSX = vi.fn();
    const result = await agentsCommand.execute(makeCtx({ setToolJSX }));

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
