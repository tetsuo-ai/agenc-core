import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { linkDirectory, writeUtf8 } from "../helpers/directory-link.js";
import { loadPlugins } from "../../src/plugins/loader.js";
import { PLUGIN_MANIFEST_RELATIVE_PATH } from "../../src/plugins/manifest.js";
import { loadPluginCommands } from "../../src/plugins/registration/load-plugin-commands.js";

const roots: string[] = [];
const SECRET = "OUTSIDE_PLUGIN_SECRET_BYTES";
const INSIDE = "INSIDE_PLUGIN_COMMAND_BODY";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("plugin root containment", () => {
  test("loads a regular command file below the plugin root", async () => {
    const { pluginStorageRoot, workspaceRoot, pluginRoot } = await workspace();
    await writePlugin(pluginRoot, "safe-plugin");
    await writeUtf8(join(pluginRoot, "commands", "ok.md"), `# ok\n${INSIDE}\n`);

    const loaded = await loadPlugins({
      pluginStorageRoot,
      workspaceRoot,
      config: { plugins: { enabled: true } },
    });
    const plugin = loaded.enabled.find((entry) => entry.name === "safe-plugin");
    expect(plugin).toBeDefined();
    const commands = await loadPluginCommands({
      plugins: loaded.enabled,
      pluginStorageRoot,
      workspaceRoot,
    });
    const ok = commands.find((command) => command.name === "safe-plugin:ok");
    expect(ok).toBeDefined();
    const prompt = await ok?.getPromptForCommand?.("", {});
    expect(JSON.stringify(prompt)).toContain(INSIDE);
    expect(JSON.stringify(prompt)).not.toContain(SECRET);
  });

  test("rejects an outbound commands directory link before the outside file is read", async () => {
    const { pluginStorageRoot, workspaceRoot, pluginRoot, root } = await workspace();
    await writePlugin(pluginRoot, "escape-plugin");
    const outsideDir = join(root, "outside-commands");
    const leaked = join(outsideDir, "leak.md");
    await writeUtf8(leaked, `# leak\n${SECRET}\n`);
    await linkDirectory(outsideDir, join(pluginRoot, "commands"));

    const loaded = await loadPlugins({
      pluginStorageRoot,
      workspaceRoot,
      config: { plugins: { enabled: true } },
    });
    const plugin = loaded.enabled.find((entry) => entry.name === "escape-plugin");
    expect(plugin).toBeDefined();
    expect(plugin?.commands.map((command) => command.name)).not.toContain("leak");

    const issues = [...loaded.errors, ...(plugin?.errors ?? [])];
    expect(issues.some((issue) => issue.path?.includes("commands") === true)).toBe(true);
    expect(JSON.stringify(issues)).not.toContain(SECRET);

    const commands = await loadPluginCommands({
      plugins: loaded.enabled,
      pluginStorageRoot,
      workspaceRoot,
    });
    const prompts = await Promise.all(
      commands.map((command) => command.getPromptForCommand?.("", {}) ?? []),
    );
    expect(JSON.stringify(prompts)).not.toContain(SECRET);
  });
});

async function workspace(): Promise<{
  readonly root: string;
  readonly pluginStorageRoot: string;
  readonly workspaceRoot: string;
  readonly pluginRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agenc-plugin-root-containment-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const pluginStorageRoot = join(root, "home", "plugins");
  const pluginRoot = join(workspaceRoot, ".agents", "plugins", "sample");
  await mkdir(pluginStorageRoot, { recursive: true });
  return { root, pluginStorageRoot, workspaceRoot, pluginRoot };
}

async function writePlugin(pluginRoot: string, name: string): Promise<void> {
  await writeUtf8(
    join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH),
    `${JSON.stringify({ name }, null, 2)}\n`,
  );
}
