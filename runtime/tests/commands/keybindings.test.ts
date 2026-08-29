import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createKeybindingsCommand } from "../../src/commands/keybindings.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
import { parseToml } from "../../src/config/loader.js";
import { ConfigStore } from "../../src/config/store.js";
import type { Session } from "../../src/session/session.js";

const roots: string[] = [];

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "agenc-keybindings-command-"));
  roots.push(root);
  return root;
}

function context(store: ConfigStore, argsRaw = ""): SlashCommandContext {
  return {
    session: { services: {} } as unknown as Session,
    argsRaw,
    cwd: store.projectRoot,
    home: store.homeContext.platformHome,
    agencHome: store.agencHome,
    configStore: store,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("/keybindings canonical writer", () => {
  test("scaffolds through config.toml, opens a private snapshot, and reloads", async () => {
    const root = temp();
    const home = join(root, "home");
    const project = join(root, "project");
    const store = new ConfigStore({ home, cwd: project, projectRoot: project, env: {} });
    await store.reload();
    const spawner = vi.fn(async (_command: string, args: readonly string[]) => {
      expect(args).toHaveLength(1);
      expect(args[0]).toMatch(/\.agenc-config-edit-[^/]+\/config\.toml$/u);
      return 0;
    });
    const command = createKeybindingsCommand({
      env: { EDITOR: "editor-test" },
      spawner,
    });

    const result = await command.execute(context(store));
    expect(result).toEqual(expect.objectContaining({ kind: "text" }));
    expect(spawner).toHaveBeenCalledOnce();
    const target = join(home, "config.toml");
    expect(parseToml(readFileSync(target, "utf8"))).toMatchObject({
      config_version: 2,
      tui: {
        keybindings: [{
          context: "Chat",
          bindings: { "ctrl+x ctrl+e": "chat:externalEditor" },
        }],
      },
    });
    expect(store.current().tui?.keybindings).toHaveLength(1);

    await command.execute(context(store));
    expect(parseToml(readFileSync(target, "utf8")).tui.keybindings).toHaveLength(1);
  });

  test("rejects arguments before creating config", async () => {
    const root = temp();
    const home = join(root, "home");
    const project = join(root, "project");
    const store = new ConfigStore({ home, cwd: project, projectRoot: project, env: {} });
    await store.reload();
    const command = createKeybindingsCommand({ spawner: vi.fn() });

    expect(await command.execute(context(store, "extra"))).toEqual({
      kind: "error",
      message: "Usage: /keybindings",
    });
    expect(existsSync(join(home, "config.toml"))).toBe(false);
  });
});
