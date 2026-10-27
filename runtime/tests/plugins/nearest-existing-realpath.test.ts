import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nearestExistingRealpath } from "../../src/plugins/nearest-existing-realpath.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-nearest-realpath-"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("nearestExistingRealpath", () => {
  it("returns the real path of an existing file", async () => {
    const file = join(root, "present.toml");
    await writeFile(file, "ok\n");
    expect(await nearestExistingRealpath(file)).toBe(resolve(file));
  });

  it("keeps the missing tail on the nearest existing ancestor", async () => {
    const missing = join(root, "plugins", "fresh.stage", "plugin.json");
    expect(await nearestExistingRealpath(missing)).toBe(
      join(resolve(root), "plugins", "fresh.stage", "plugin.json"),
    );
  });

  it("walks through a symlink ancestor to the real directory", async () => {
    const real = join(root, "real-home");
    const alias = join(root, "alias-home");
    await mkdir(real);
    await symlink(real, alias);
    expect(await nearestExistingRealpath(join(alias, "missing", "leaf"))).toBe(
      join(resolve(real), "missing", "leaf"),
    );
  });

  it("returns undefined when an ancestor is a file, not a directory", async () => {
    const file = join(root, "not-a-dir");
    await writeFile(file, "ok\n");
    expect(await nearestExistingRealpath(join(file, "child"))).toBeUndefined();
  });
});
