import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  findAllExecutablesOnCapturedPath,
  findExecutableOnCapturedPath,
} from "../../src/utils/findExecutable.js";

const roots: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

it("does not search an implicit system PATH", async () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-executable-ingress-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const executable = join(
    bin,
    process.platform === "win32" ? "agenc.exe" : "agenc",
  );
  writeFileSync(executable, "test executable\n");
  chmodSync(executable, 0o755);
  process.env.PATH = bin;

  await expect(
    findExecutableOnCapturedPath("agenc", {}, root),
  ).resolves.toBeNull();
  await expect(
    findExecutableOnCapturedPath(
      "agenc",
      process.platform === "win32"
        ? { Path: bin, PATHEXT: ".exe" }
        : { Path: bin },
      root,
    ),
  ).resolves.toBe(executable);
});

it.skipIf(process.platform === "win32")(
  "lists every executable match in PATH order without repeats",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-executable-all-"));
    roots.push(root);
    const dirs = ["first", "not-executable", "second"].map((name) => {
      const dir = join(root, name);
      mkdirSync(dir);
      const path = join(dir, "agenc");
      writeFileSync(path, "#!/bin/sh\n");
      chmodSync(path, name === "not-executable" ? 0o644 : 0o755);
      return dir;
    });
    const missing = join(root, "missing");
    const environment = {
      PATH: [dirs[0], missing, dirs[1], dirs[2], dirs[0]].join(delimiter),
    };

    await expect(
      findAllExecutablesOnCapturedPath("agenc", environment, root),
    ).resolves.toEqual([join(dirs[0]!, "agenc"), join(dirs[2]!, "agenc")]);
    await expect(
      findExecutableOnCapturedPath("agenc", environment, root),
    ).resolves.toBe(join(dirs[0]!, "agenc"));
    await expect(
      findAllExecutablesOnCapturedPath("agenc", {}, root),
    ).resolves.toEqual([]);
  },
);
