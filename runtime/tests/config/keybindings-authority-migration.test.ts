import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parseToml } from "../../src/config/loader.js";
import {
  applyConfigV2Migration,
  checkConfigV2Migration,
  rollbackConfigV2Migration,
} from "../../src/config/migration.js";
import { serializeConfigToml } from "../../src/config/serialize.js";

const roots: string[] = [];

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "agenc-keybinding-migration-"));
  roots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}

function options(root: string, id: string) {
  return {
    env: {},
    home: join(root, "home"),
    cwd: join(root, "project"),
    projectRoot: join(root, "project"),
    managedConfigPath: join(root, "managed", "config.toml"),
    managedSettingsPath: join(root, "managed", "managed-settings.json"),
    globalStatePath: join(root, "missing-state.json"),
    id,
  } as const;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("retired keybinding JSON authority migration", () => {
  test("converts actions and null unbindings, archives, and rolls back exactly", async () => {
    const root = temp();
    const home = join(root, "home");
    const source = join(home, "keybindings.json");
    const target = join(home, "config.toml");
    const sourceText = `${JSON.stringify({
      $schema: "urn:agenc:keybindings:schema",
      $docs: "urn:agenc:docs:keybindings",
      bindings: [
        {
          context: "Chat",
          bindings: {
            "ctrl+x ctrl+e": "chat:externalEditor",
            "shift+tab": null,
          },
        },
        { context: "Global", bindings: {} },
      ],
    }, null, 2)}\n`;
    write(source, sourceText);

    const plan = await checkConfigV2Migration(options(root, "keybindings"));
    expect(plan.conflicts).toEqual([]);
    expect(plan.archivePaths).toContain(source);
    expect(plan.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "$schema", action: "drop" }),
      expect.objectContaining({ field: "$docs", action: "drop" }),
      expect.objectContaining({
        sourcePath: source,
        field: "bindings",
        action: "migrate",
        target: "tui.keybindings",
      }),
    ]));
    const planned = parseToml(
      plan.writes.find((write) => write.targetPath === target)?.content ?? "",
    );
    expect(planned).toMatchObject({
      config_version: 2,
      tui: {
        keybindings: [
          {
            context: "Chat",
            bindings: { "ctrl+x ctrl+e": "chat:externalEditor" },
            unbind: ["shift+tab"],
          },
          { context: "Global", bindings: {} },
        ],
      },
    });

    await applyConfigV2Migration(plan);
    expect(existsSync(source)).toBe(false);
    expect(existsSync(`${source}.migrated-v2-keybindings`)).toBe(true);
    expect(parseToml(readFileSync(target, "utf8"))).toMatchObject(planned);

    await rollbackConfigV2Migration("keybindings", { env: {}, home });
    expect(readFileSync(source, "utf8")).toBe(sourceText);
    expect(existsSync(`${source}.migrated-v2-keybindings`)).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  test("blocks disagreement with existing canonical keybindings", async () => {
    const root = temp();
    const home = join(root, "home");
    const source = join(home, "keybindings.json");
    write(join(home, "config.toml"), serializeConfigToml({
      config_version: 2,
      tui: {
        keybindings: [{
          context: "Chat",
          bindings: { "ctrl+y": "chat:submit" },
        }],
      },
    }));
    write(source, JSON.stringify({
      bindings: [{
        context: "Chat",
        bindings: { "ctrl+y": "chat:newline" },
      }],
    }));

    const plan = await checkConfigV2Migration(options(root, "conflict"));
    expect(plan.conflicts).toContainEqual(expect.objectContaining({
      sourcePath: source,
      field: "tui.keybindings",
      reason: expect.stringMatching(/refuses to choose/u),
    }));
    expect(plan.writes).toEqual([]);
  });

  test.each([
    [
      "duplicate JSON keys",
      '{"bindings":[{"context":"Chat","bindings":{"ctrl+y":"chat:submit","ctrl+y":"chat:newline"}}]}',
      /duplicate keys/u,
    ],
    [
      "unknown action",
      JSON.stringify({ bindings: [{ context: "Chat", bindings: { a: "chat:nope" } }] }),
      /unknown action/u,
    ],
    [
      "command outside Chat",
      JSON.stringify({ bindings: [{ context: "Global", bindings: { a: "command:todos" } }] }),
      /only in the "Chat" context/u,
    ],
    [
      "normalized alias conflict",
      JSON.stringify({ bindings: [
        { context: "Chat", bindings: { "option+x": "chat:submit" } },
        { context: "Chat", bindings: { "alt+x": "chat:newline" } },
      ] }),
      /no lossless canonical transform/u,
    ],
  ])("blocks malformed %s without a partial write", async (_label, text, reason) => {
    const root = temp();
    const source = join(root, "home", "keybindings.json");
    write(source, text);

    const plan = await checkConfigV2Migration(options(root, "malformed"));
    expect(plan.conflicts).toContainEqual(expect.objectContaining({
      sourcePath: source,
      reason: expect.stringMatching(reason),
    }));
    expect(plan.writes).toEqual([]);
    expect(existsSync(source)).toBe(true);
  });
});
