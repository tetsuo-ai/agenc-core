import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { findExecutableOnCapturedPath } from "../../src/utils/findExecutable.js";

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
