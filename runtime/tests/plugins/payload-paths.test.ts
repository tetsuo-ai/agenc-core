import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveManifestRelativePath } from "../../src/plugins/manifest-schema.js";
import { isExcludedPluginPayloadPath } from "../../src/plugins/payload-paths.js";
import { collectMarkdownFiles } from "../../src/plugins/registration/common.js";

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
