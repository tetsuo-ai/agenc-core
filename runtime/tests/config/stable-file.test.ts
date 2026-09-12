import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  assertNoSymlinkAncestors,
  ensurePrivateDescendantDirectory,
  readStableDirectory,
  readStableFile,
  sameStableFileIdentity,
  sameStableFileSnapshot,
  StableFileError,
  stableUtf8Text,
} from "../../src/config/stable-file.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agenc-stable-file-"));
  roots.push(root);
  return root;
}

function writeRegularFile(path: string, contents: string | Buffer): void {
  writeFileSync(path, contents, { mode: 0o600 });
}

describe("readStableFile", () => {
  test("returns null for a missing path", async () => {
    const root = fixtureRoot();
    await expect(readStableFile(join(root, "missing.toml"))).resolves.toBeNull();
  });

  test("reads one regular file and pins its identity", async () => {
    const root = fixtureRoot();
    const path = join(root, "config.toml");
    writeRegularFile(path, "config_version = 2\n");

    const snapshot = await readStableFile(path);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.path).toBe(realpathSync(path));
    expect(snapshot?.resolvedPath).toBe(realpathSync(path));
    expect(snapshot?.bytes.toString("utf8")).toBe("config_version = 2\n");
    expect(sameStableFileIdentity(snapshot!, snapshot!)).toBe(true);
    expect(sameStableFileSnapshot(snapshot!, snapshot!)).toBe(true);
  });

  test("rejects a directory and a leaf symlink by default", async () => {
    const root = fixtureRoot();
    const directory = join(root, "dir");
    const target = join(root, "target.toml");
    const alias = join(root, "alias.toml");
    mkdirSync(directory);
    writeRegularFile(target, "ok\n");
    symlinkSync(target, alias);

    await expect(readStableFile(directory)).rejects.toMatchObject({
      name: "StableFileError",
      code: "not-file",
    } satisfies Partial<StableFileError>);
    await expect(readStableFile(alias)).rejects.toMatchObject({
      name: "StableFileError",
      code: "symbolic-link",
    } satisfies Partial<StableFileError>);
  });

  test("reads an opted-in leaf symlink through its real target", async () => {
    const root = fixtureRoot();
    const target = join(root, "target.toml");
    const alias = join(root, "alias.toml");
    writeRegularFile(target, "trusted\n");
    symlinkSync(target, alias);

    const snapshot = await readStableFile(alias, { allowLeafSymlink: true });
    expect(snapshot?.path).toBe(alias);
    expect(snapshot?.resolvedPath).toBe(realpathSync(target));
    expect(snapshot?.bytes.toString("utf8")).toBe("trusted\n");
  });
});

describe("stableUtf8Text", () => {
  test("strips a BOM and canonicalizes line endings unless asked to keep them", () => {
    const bytes = Buffer.from("\uFEFFone\r\ntwo\rthree\n", "utf8");
    expect(stableUtf8Text({ bytes })).toBe("one\ntwo\nthree\n");
    expect(
      stableUtf8Text({ bytes }, { preserveBOM: true, preserveLineEndings: true }),
    ).toBe("\uFEFFone\r\ntwo\rthree\n");
  });
});

describe("readStableDirectory", () => {
  test("lists a regular directory and rejects a symlink or file", async () => {
    const root = fixtureRoot();
    const directory = join(root, "managed");
    const file = join(root, "file");
    const alias = join(root, "alias");
    mkdirSync(directory);
    writeRegularFile(join(directory, "child"), "ok\n");
    writeRegularFile(file, "nope\n");
    symlinkSync(directory, alias, "dir");

    const snapshot = await readStableDirectory(directory);
    expect(snapshot?.path).toBe(realpathSync(directory));
    expect(snapshot?.entries.map((entry) => entry.name)).toEqual(["child"]);

    await expect(readStableDirectory(alias)).rejects.toMatchObject({
      code: "symbolic-link",
    });
    await expect(readStableDirectory(file)).rejects.toMatchObject({
      code: "not-directory",
    });
    await expect(readStableDirectory(join(root, "missing"))).resolves.toBeNull();
  });
});

describe("assertNoSymlinkAncestors", () => {
  test("rejects a symbolic-link ancestor and accepts a regular tree", async () => {
    const root = fixtureRoot();
    const physical = join(root, "physical");
    const alias = join(root, "alias");
    const leaf = join(alias, "policy.toml");
    mkdirSync(physical);
    symlinkSync(physical, alias, "dir");
    writeRegularFile(join(physical, "policy.toml"), "ok\n");

    await expect(assertNoSymlinkAncestors(leaf)).rejects.toMatchObject({
      code: "symbolic-link",
    });
    await expect(
      assertNoSymlinkAncestors(join(physical, "policy.toml")),
    ).resolves.toBeUndefined();
  });
});

describe("ensurePrivateDescendantDirectory", () => {
  test("creates a 0700 descendant under the authority root", async () => {
    const root = fixtureRoot();
    const created = await ensurePrivateDescendantDirectory(root, [
      "secure-storage",
      "vault",
    ]);
    expect(created.canonicalPath).toBe(
      realpathSync(join(root, "secure-storage", "vault")),
    );
    expect(created.path).toBe(join(root, "secure-storage", "vault"));
    expect(statSync(created.canonicalPath).mode & 0o777).toBe(0o700);
  });

  test.each([
    ["empty segments", []],
    ["dot", ["."]],
    ["parent traversal", [".."]],
    ["nested traversal", ["ok", ".."]],
    ["absolute segment", ["/etc"]],
    ["slash in segment", ["a/b"]],
  ] as const)("rejects %s", async (_name, segments) => {
    const root = fixtureRoot();
    await expect(
      ensurePrivateDescendantDirectory(root, segments),
    ).rejects.toMatchObject({ code: "invalid-path" });
  });

  test("rejects a descendant symlink or file component", async () => {
    const root = fixtureRoot();
    const file = join(root, "not-a-dir");
    const linked = join(root, "linked");
    writeRegularFile(file, "nope\n");
    symlinkSync(root, linked, "dir");

    await expect(
      ensurePrivateDescendantDirectory(root, ["not-a-dir"]),
    ).rejects.toMatchObject({ code: "not-directory" });
    await expect(
      ensurePrivateDescendantDirectory(root, ["linked"]),
    ).rejects.toMatchObject({ code: "symbolic-link" });
  });

  test("is idempotent for an already-private directory", async () => {
    const root = fixtureRoot();
    const first = await ensurePrivateDescendantDirectory(root, ["vault"]);
    chmodSync(first.canonicalPath, 0o755);
    const second = await ensurePrivateDescendantDirectory(root, ["vault"]);
    expect(second.canonicalPath).toBe(first.canonicalPath);
  });
});
