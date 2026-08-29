import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const lockFailure = vi.hoisted(() =>
  new Error("injected rollback authority acquisition failure")
);

vi.mock("../../src/config/authority-lock.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../src/config/authority-lock.js")
  >();
  return {
    ...original,
    runWithConfigAuthorityLocks: async () => {
      throw lockFailure;
    },
  };
});

import { rollbackConfigV2Migration } from "../../src/config/migration.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("migration rollback lock ordering", () => {
  test("does not recover or rewrite any journal artifact before authority acquisition", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-rollback-prelock-"));
    roots.push(root);
    const home = join(root, "home");
    const id = "prelock-recovery-refused";
    const directory = join(home, "migrations", "config-v2", id);
    const journalPath = join(directory, "journal.json");
    const publicationStage = join(
      directory,
      "journal.json.tmp-123-12345678-1234-4234-8234-123456789abc",
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(journalPath, "journal-sentinel", { mode: 0o600 });
    writeFileSync(publicationStage, "stage-sentinel", { mode: 0o600 });

    await expect(rollbackConfigV2Migration(id, {
      env: {},
      home,
      platformHome: root,
    })).rejects.toBe(lockFailure);

    expect(readFileSync(journalPath, "utf8")).toBe("journal-sentinel");
    expect(readFileSync(publicationStage, "utf8")).toBe("stage-sentinel");
  });
});
