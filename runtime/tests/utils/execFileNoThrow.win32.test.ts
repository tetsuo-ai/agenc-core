import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { execFileNoThrowWithCwd } from "../../src/utils/execFileNoThrow.js";

if (process.platform !== "win32") {
  throw new Error("the native .cmd compatibility test requires Windows");
}

let directory: string | undefined;

afterEach(() => {
  if (directory !== undefined) {
    rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

test("execFileNoThrowWithCwd preserves Windows .cmd compatibility", async () => {
  directory = mkdtempSync(join(tmpdir(), "agenc-execfile-"));
  const file = join(directory, "hello.cmd");
  writeFileSync(file, "@echo off\r\necho hello\r\n");

  const result = await execFileNoThrowWithCwd(file, []);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("hello");
});
