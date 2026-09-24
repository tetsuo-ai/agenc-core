import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveManifestRelativePath } from "../../src/plugins/manifest-schema.js";
import { isExcludedPluginPayloadPath } from "../../src/plugins/payload-paths.js";
import { collectMarkdownFiles } from "../../src/plugins/registration/common.js";
import { createPluginFromPath } from "../../src/plugins/loader.js";

it("refuses filesystem aliases of excluded component directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "agenc-excluded-component-"));
  for (const alias of ["./.GIT", "./.Git/commands", "./.git.", "./.GIT ", "./.GIT\\commands"]) {
    expect(() => resolveManifestRelativePath(root, "commands", alias)).toThrow();
  }
  expect(isExcludedPluginPayloadPath("C:\\plugin", "C:\\plugin\\.GIT.\\hello.md")).toBe(true);
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "hello.md"), "# Unsigned command\n");
  await mkdir(join(root, ".git", "commands"));
  await writeFile(join(root, ".git", "commands", "injected.md"), "# Injected command\n");
  await symlink(join(root, ".git"), join(root, "commands-alias"));
  expect(() => resolveManifestRelativePath(root, "commands", "./commands-alias")).toThrow();
  expect(await collectMarkdownFiles(join(root, ".git"), root)).toEqual([]);
  expect(await collectMarkdownFiles(join(root, ".git", "commands"), root)).toEqual([]);
  expect(await collectMarkdownFiles(join(root, "commands-alias"), root)).toEqual([]);
});

it("never resolves components to mutable signature or install metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "agenc-unsigned-metadata-"));
  const metadata = join(root, ".agenc-plugin");
  await mkdir(metadata);
  for (const name of ["signature.json", "agenc-install.json"] as const) {
    const path = join(metadata, name);
    const alias = join(root, `${name}.json`);
    await writeFile(path, JSON.stringify({ content: "first" }));
    await symlink(path, alias);
    for (const content of ["first", "changed after verification"]) {
      await writeFile(path, JSON.stringify({ content }));
      for (const reference of [`./.agenc-plugin/${name}`, `./${name}.json`]) {
        expect(() => resolveManifestRelativePath(root, "commands.probe.source", reference))
          .toThrow();
        await writeFile(join(metadata, "plugin.json"), JSON.stringify({
          name: "metadata-test", commands: { probe: { source: reference } },
        }));
        const loaded = await createPluginFromPath(root, { source: root, enabled: true });
        expect(loaded.plugin).toBeNull();
        expect(loaded.errors.some((issue) => issue.type === "manifest")).toBe(true);
      }
    }
  }
});
