import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listTuiCommandList } from "../../src/commands.js";
import {
  dispatchSlashCommand,
  parseSlashCommand,
} from "../../src/commands/dispatcher.js";
import { buildDefaultRegistry } from "../../src/commands/registry.js";
import { themeCommand } from "../../src/commands/theme.js";
import type {
  SlashCommandContext,
  SlashCommandResult,
} from "../../src/commands/types.js";
import type { AgenCConfig } from "../../src/config/schema.js";
import { ConfigStore } from "../../src/config/store.js";

const VALID_NAMES =
  "auto, dark, light, light-daltonized, dark-daltonized, light-ansi, dark-ansi, olive";

describe("/theme", () => {
  let home: string;
  let cwd: string;
  let store: ConfigStore;

  async function openStore(cliOverrides?: AgenCConfig): Promise<ConfigStore> {
    const next = new ConfigStore({
      home,
      env: { AGENC_HOME: home },
      cwd,
      ...(cliOverrides !== undefined ? { cliOverrides } : {}),
    });
    await next.reload();
    return next;
  }

  function context(extra: Partial<SlashCommandContext> = {}): SlashCommandContext {
    return {
      argsRaw: "",
      cwd,
      home,
      configStore: store,
      session: { services: { configStore: store } },
      ...extra,
    } as unknown as SlashCommandContext;
  }

  async function run(line: string): Promise<SlashCommandResult> {
    const parsed = parseSlashCommand(line);
    expect(parsed).not.toBeNull();
    const outcome = await dispatchSlashCommand(
      parsed!,
      context(),
      buildDefaultRegistry({ surface: "daemon-tui" }),
    );
    return outcome.result;
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "agenc-theme-command-"));
    cwd = join(home, "workspace");
    await mkdir(cwd);
    store = await openStore();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("is a built-in, immediate command on both slash surfaces", () => {
    for (const registry of [
      buildDefaultRegistry(),
      buildDefaultRegistry({ surface: "daemon-tui" }),
    ]) {
      expect(registry.find("theme")).toBe(themeCommand);
    }
    expect(themeCommand.immediate).toBe(true);
    const listed = listTuiCommandList().find((command) => command.name === "theme");
    expect(listed).toMatchObject({
      type: "local",
      description: "Choose the color theme (opens a picker)",
      argumentHint: "[name]",
    });
  });

  it("sets a theme directly and keeps it for the next session", async () => {
    expect(store.current().tui?.theme).toBe("olive");

    expect(await run("/theme dark")).toEqual({
      kind: "text",
      text: "Theme set to dark (black and purple, for dark terminals).",
    });
    expect(store.current().tui?.theme).toBe("dark");
    const saved = await readFile(join(home, "config.toml"), "utf8");
    expect(saved).toContain('["tui"]\n"theme" = "dark"');

    // A restart reads the same user config.toml.
    const restarted = await openStore();
    expect(restarted.current().tui?.theme).toBe("dark");
  });

  it("accepts a name in any case and keeps other tui settings", async () => {
    expect(await run("/theme  LIGHT ")).toMatchObject({ kind: "text" });
    expect(await run("/theme auto")).toEqual({
      kind: "text",
      text: "Theme set to auto (olive on dark terminals, light on light ones).",
    });
    const restarted = await openStore();
    expect(restarted.current().tui).toMatchObject({
      theme: "auto",
      showTurnDuration: true,
    });
  });

  it("rejects an unknown name, lists the valid names and saves nothing", async () => {
    expect(await run("/theme neon")).toEqual({
      kind: "error",
      message: `Unknown theme "neon". Choose one of: ${VALID_NAMES}.`,
    });
    expect(store.current().tui?.theme).toBe("olive");
    await expect(readFile(join(home, "config.toml"), "utf8")).rejects.toThrow();
  });

  it("says which layer keeps another theme in effect", async () => {
    store = await openStore({ tui: { theme: "light" } });

    expect(await run("/theme dark")).toEqual({
      kind: "text",
      text: "Saved dark to your config, but a command-line option sets light, so light stays in effect.",
    });
    const userOnly = await openStore();
    expect(userOnly.current().tui?.theme).toBe("dark");
  });

  it("opens the picker in the TUI and lists the themes elsewhere", async () => {
    const shown: unknown[] = [];
    const opened = await themeCommand.execute(context({
      appState: { setToolJSX: (value: unknown) => shown.push(value) },
    }));
    expect(opened).toEqual({ kind: "skip" });
    expect(shown).toEqual([
      expect.objectContaining({ isLocalJSXCommand: true, shouldHidePromptInput: true }),
    ]);

    const listed = await themeCommand.execute(context());
    expect(listed.kind).toBe("text");
    const text = (listed as { text: string }).text;
    expect(text.split("\n")[0]).toBe("Theme: olive");
    expect(text).toContain("olive             olive, cream and wine, for dark terminals (current)");
    expect(text).toContain("light-daltonized  color-blind friendly, light");
    expect(text.split("\n").at(-1)).toBe("Use /theme <name> to change it.");
  });
});
