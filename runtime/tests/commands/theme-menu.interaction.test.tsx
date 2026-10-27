import React from "react";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dispatchSlashCommand,
  parseSlashCommand,
} from "../../src/commands/dispatcher.js";
import { buildDefaultRegistry } from "../../src/commands/registry.js";
import { themeCommand } from "../../src/commands/theme.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
import { ConfigStore } from "../../src/config/store.js";
import {
  ThemeProvider,
  useTheme,
  useThemeSetting,
} from "../../src/tui/components/design-system/ThemeProvider.js";
import { createRoot, type Root } from "../../src/tui/ink/root.js";
import Text from "../../src/tui/ink/components/Text.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";

const delay = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

type Seen = { theme: string; setting: string };
type SetTheme = ReturnType<typeof useTheme>[1];

describe("/theme picker", () => {
  let home: string;
  let cwd: string;
  let store: ConfigStore;
  let root: Root;
  let stdin: PassThrough;
  let output: string;
  let seen: Seen;
  let setJsx: ((jsx: React.ReactNode) => void) | null;
  let pendingJsx: React.ReactNode;
  let setTheme: SetTheme | null;

  async function openStore(): Promise<ConfigStore> {
    const next = new ConfigStore({ home, env: { AGENC_HOME: home }, cwd });
    await next.reload();
    return next;
  }

  /** Reports the theme on screen and the saved setting, as App content would see them. */
  function Probe(): React.ReactNode {
    const [theme, set] = useTheme();
    const setting = useThemeSetting();
    seen = { theme, setting };
    setTheme = set;
    return <Text>{`on screen ${theme}`}</Text>;
  }

  /** Stands in for the App's local-JSX slot: shows what /theme opens until it closes. */
  function Slot(): React.ReactNode {
    const [jsx, set] = React.useState<React.ReactNode>(pendingJsx);
    React.useEffect(() => {
      setJsx = set;
      return () => {
        setJsx = null;
      };
    }, []);
    return <>{jsx}</>;
  }

  function context(argsRaw = ""): SlashCommandContext {
    return {
      argsRaw,
      cwd,
      home,
      configStore: store,
      session: { services: { configStore: store } },
      appState: {
        setToolJSX: (value: { jsx: React.ReactNode }) => {
          if (setJsx === null) pendingJsx = value.jsx;
          else setJsx(value.jsx);
        },
      },
    } as unknown as SlashCommandContext;
  }

  async function mount(authority: ConfigStore = store, rows = 40): Promise<void> {
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows });
    stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      ref() {},
      unref() {},
      setRawMode() {},
    });
    output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    root = await createRoot({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    root.render(
      <ThemeProvider settingsAuthority={authority}>
        <Probe />
        <Slot />
      </ThemeProvider>,
    );
    await delay();
  }

  async function openPicker(): Promise<void> {
    expect(await themeCommand.execute(context())).toEqual({ kind: "skip" });
    await delay();
  }

  async function press(key: string): Promise<void> {
    stdin.write(key);
    await delay();
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "agenc-theme-picker-"));
    cwd = join(home, "workspace");
    await mkdir(cwd);
    store = await openStore();
    pendingJsx = null;
    setJsx = null;
    setTheme = null;
  });

  afterEach(async () => {
    root?.unmount();
    stdin?.end();
    await rm(home, { recursive: true, force: true });
  });

  it("lists every theme with the saved one highlighted", async () => {
    await mount();
    await openPicker();
    // TTY output can encode spaces with cursor movement rather than bytes.
    const rows = stripAnsi(output).split(/\r?\n/u).map((row) => row.replace(/\s+/gu, ""));
    // No frame: a title row with the key hints, then one row per theme.
    expect(rows).toContain("THEME↑↓preview·↵save·esccancel");
    expect(rows).toContain("›oliveolive,creamandwine,fordarkterminals(current)");
    for (const row of [
      "autooliveondarkterminals,lightonlightones",
      "darkblackandpurple,fordarkterminals",
      "lightforlightterminals",
      "light-daltonizedcolor-blindfriendly,light",
      "dark-daltonizedcolor-blindfriendly,dark",
      "light-ansiyourterminal's16colors,light",
      "dark-ansiyourterminal's16colors,dark",
    ]) {
      expect(rows).toContain(row);
    }
    expect(rows.some((row) => /[│┌└]/u.test(row))).toBe(false);
    // Only the highlighted row carries the marker.
    expect(rows.filter((row) => row.includes("›"))).toHaveLength(1);
    // A sample conversation under the list, drawn with the message and diff components.
    for (const row of ["preview", "❯Fixtheloginredirect", '12-returnredirect("/")', "12+returnredirect(next)"]) {
      expect(rows).toContain(row);
    }
    expect(seen).toEqual({ theme: "olive", setting: "olive" });
  });

  it("leaves the sample out on a short terminal and keeps every theme row", async () => {
    await mount(store, 12);
    await openPicker();
    const rows = stripAnsi(output).split(/\r?\n/u).map((row) => row.replace(/\s+/gu, ""));
    expect(rows).toContain("THEME↑↓preview·↵save·esccancel");
    expect(rows).toContain("autooliveondarkterminals,lightonlightones");
    expect(rows).toContain("›oliveolive,creamandwine,fordarkterminals(current)");
    expect(rows).not.toContain("preview");
  });

  it("previews each theme as the selection moves and Esc puts back the saved one", async () => {
    await mount();
    await openPicker();

    await press(UP);
    await vi.waitFor(() => expect(seen).toEqual({ theme: "dark-ansi", setting: "olive" }));
    await press(UP);
    await vi.waitFor(() => expect(seen).toEqual({ theme: "light-ansi", setting: "olive" }));
    await press(DOWN);
    await vi.waitFor(() => expect(seen).toEqual({ theme: "dark-ansi", setting: "olive" }));

    // A preview is not a save.
    expect(store.current().tui?.theme).toBe("olive");
    await expect(readFile(join(home, "config.toml"), "utf8")).rejects.toThrow();

    await press(ESC);
    await vi.waitFor(() => expect(seen).toEqual({ theme: "olive", setting: "olive" }));
    expect(stripAnsi(output.slice(-400))).not.toContain("esc cancel");
    expect(store.current().tui?.theme).toBe("olive");
  });

  it("puts the saved theme back when something else closes the picker", async () => {
    await mount();
    await openPicker();
    await press(UP);
    await vi.waitFor(() => expect(seen.theme).toBe("dark-ansi"));

    // Ctrl+C and other commands clear the slot without telling the picker.
    setJsx?.(null);
    await vi.waitFor(() => expect(seen).toEqual({ theme: "olive", setting: "olive" }));
  });

  it("saves the highlighted theme on Enter, and a restart keeps it", async () => {
    await mount();
    await openPicker();
    await press(DOWN); // auto
    await press(DOWN); // dark
    await vi.waitFor(() => expect(seen).toEqual({ theme: "dark", setting: "olive" }));

    await press(ENTER);
    await vi.waitFor(() => expect(store.current().tui?.theme).toBe("dark"));
    await vi.waitFor(() => expect(seen).toEqual({ theme: "dark", setting: "dark" }));
    expect(await readFile(join(home, "config.toml"), "utf8")).toContain('["tui"]\n"theme" = "dark"');

    // Restart: a new store over the same home, a new provider, no picker.
    root.unmount();
    stdin.end();
    pendingJsx = null;
    store = await openStore();
    expect(store.current().tui?.theme).toBe("dark");
    await mount(store);
    await vi.waitFor(() => expect(seen).toEqual({ theme: "dark", setting: "dark" }));
  });

  it("Enter on the theme already saved just closes", async () => {
    await mount();
    await openPicker();
    await press(ENTER);
    await delay();
    expect(seen).toEqual({ theme: "olive", setting: "olive" });
    await expect(readFile(join(home, "config.toml"), "utf8")).rejects.toThrow();
  });

  it("/theme dark switches the open TUI at once", async () => {
    await mount();
    const outcome = await dispatchSlashCommand(
      parseSlashCommand("/theme dark")!,
      context(),
      buildDefaultRegistry({ surface: "daemon-tui" }),
    );
    expect(outcome.result).toEqual({
      kind: "text",
      text: "Theme set to dark (black and purple, for dark terminals).",
    });
    await vi.waitFor(() => expect(seen).toEqual({ theme: "dark", setting: "dark" }));

    const unknown = await dispatchSlashCommand(
      parseSlashCommand("/theme neon")!,
      context(),
      buildDefaultRegistry({ surface: "daemon-tui" }),
    );
    expect(unknown.result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Choose one of: auto, dark, light"),
    });
    await delay();
    expect(seen).toEqual({ theme: "dark", setting: "dark" });
  });

  it("follows a hand edit of config.toml once /config reload reads it", async () => {
    await mount();
    await writeFile(
      join(home, "config.toml"),
      'config_version = 2\n\n[tui]\ntheme = "light"\n',
    );
    await store.reload();
    await vi.waitFor(() => expect(seen).toEqual({ theme: "light", setting: "light" }));
  });

  it("saves a direct switch, as first-run setup makes, through the bound store", async () => {
    await mount();
    // A key press runs outside any settings scope; the provider saves through
    // the store it was given.
    setTheme?.("light-ansi");
    await vi.waitFor(() => expect(store.current().tui?.theme).toBe("light-ansi"));
    expect(seen).toEqual({ theme: "light-ansi", setting: "light-ansi" });
    expect(await readFile(join(home, "config.toml"), "utf8")).toContain('"theme" = "light-ansi"');
  });
});
