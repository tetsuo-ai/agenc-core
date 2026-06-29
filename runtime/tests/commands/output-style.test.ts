import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_OUTPUT_STYLE_NAME,
  clearAllOutputStylesCache,
} from "../constants/outputStyles.js";
import {
  getOriginalCwd,
  setOriginalCwd,
} from "../bootstrap/state.js";
import type { Session } from "../session/session.js";
import { outputStyleCommand, outputStyleNewCommand } from "./output-style.js";
import type { SlashCommandContext } from "./types.js";

function stubSession(): Session {
  return {
    services: {},
    nextInternalSubId: () => "sub-output-style-test",
    emit: () => {},
  } as unknown as Session;
}

function stubCtx(
  cwd: string,
  argsRaw = "",
  appState?: SlashCommandContext["appState"],
): SlashCommandContext {
  return {
    session: stubSession(),
    argsRaw,
    cwd,
    home: "/home/test",
    ...(appState !== undefined ? { appState } : {}),
  };
}

describe("output-style commands", () => {
  const originalCwd = getOriginalCwd();
  const tempDirs: string[] = [];

  afterEach(() => {
    setOriginalCwd(originalCwd);
    clearAllOutputStylesCache();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "agenc-output-style-"));
    tempDirs.push(dir);
    setOriginalCwd(dir);
    return dir;
  }

  it("lists available styles outside the TUI", async () => {
    const cwd = tempProject();

    const result = await outputStyleCommand.execute(stubCtx(cwd));

    expect(result.kind).toBe("text");
    if (result.kind !== "text") throw new Error("expected text");
    expect(result.text).toContain("Output styles:");
    expect(result.text).toContain(DEFAULT_OUTPUT_STYLE_NAME);
    expect(result.text).toContain("Explanatory");
    expect(result.text).toContain("/output-style <name>");
  });

  it("opens a local picker when TUI app-state is wired", async () => {
    const cwd = tempProject();
    const setToolJSX = vi.fn();

    const result = await outputStyleCommand.execute(
      stubCtx(cwd, "", { setToolJSX }),
    );

    expect(result.kind).toBe("skip");
    expect(setToolJSX).toHaveBeenCalledWith(
      expect.objectContaining({
        isLocalJSXCommand: true,
        shouldHidePromptInput: true,
      }),
    );
  });

  it("switches the active style through local settings and updates app state", async () => {
    const cwd = tempProject();
    let appState: unknown = { settings: {} };
    const setAppState = vi.fn((updater: (prev: unknown) => unknown) => {
      appState = updater(appState);
    });

    const result = await outputStyleCommand.execute(
      stubCtx(cwd, "explanatory", { setAppState }),
    );

    expect(result).toEqual({
      kind: "text",
      text: 'Output style switched to "Explanatory".',
    });
    const settings = JSON.parse(
      readFileSync(join(cwd, ".agenc", "settings.local.json"), "utf8"),
    ) as { outputStyle?: string };
    expect(settings.outputStyle).toBe("Explanatory");
    expect(appState).toEqual({ settings: { outputStyle: "Explanatory" } });
  });

  it("returns a clear error for unknown styles", async () => {
    const cwd = tempProject();

    const result = await outputStyleCommand.execute(
      stubCtx(cwd, "does-not-exist"),
    );

    expect(result.kind).toBe("text");
    if (result.kind !== "text") throw new Error("expected text");
    expect(result.text).toContain('Unknown output style "does-not-exist"');
  });

  it("turns /output-style:new into an agent-authored project style prompt", async () => {
    const cwd = tempProject();

    const result = await outputStyleNewCommand.execute(
      stubCtx(cwd, "terse Short replies"),
    );

    expect(result.kind).toBe("prompt");
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.content).toContain(
      "Create a new project output style at .agenc/output-styles/terse.md",
    );
    expect(result.content).toContain("name: terse");
    expect(result.content).toContain("description: Short replies");
  });
});
