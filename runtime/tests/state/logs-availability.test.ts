import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { logsDatabaseFilesAreAbsent } from "../../src/state/logs-availability.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "logs-availability-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
it("accepts only absent logs and all absent companions", () => {
  expect(logsDatabaseFilesAreAbsent(join(root, "logs"))).toBe(true);
});
it.each(["", "-wal", "-shm", "-journal"])("keeps a visible %s path eager", suffix => {
  const path = join(root, "logs");
  writeFileSync(path + suffix, "");
  expect(logsDatabaseFilesAreAbsent(path)).toBe(false);
});
it("does not mistake a dangling symlink for absence", () => {
  const path = join(root, "logs");
  symlinkSync(join(root, "missing"), path);
  expect(logsDatabaseFilesAreAbsent(path)).toBe(false);
});
it("propagates probe failures other than ENOENT", () => {
  const path = join(root, "file");
  writeFileSync(path, "");
  expect(() => logsDatabaseFilesAreAbsent(join(path, "logs"))).toThrow();
});
