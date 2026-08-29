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

const { injectedReleaseError } = vi.hoisted(() => ({
  injectedReleaseError: Object.assign(
    new Error("injected migration lock release failure"),
    { code: "ENOTDIR" },
  ),
}));

vi.mock("../../src/config/authority-lock.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../src/config/authority-lock.js")
  >();
  return {
    ...original,
    runWithConfigAuthorityLocks: async <T>(
      paths: readonly string[],
      operation: () => T | Promise<T>,
    ) => {
      const outcome = await original.runWithConfigAuthorityLocks(
        paths,
        operation,
      );
      const postOperationReleaseErrors = Object.freeze([
        ...outcome.postOperationReleaseErrors,
        injectedReleaseError,
      ]);
      if (outcome.status === "failed") {
        original.attachConfigAuthorityReleaseErrors(
          outcome.error,
          postOperationReleaseErrors,
        );
        return Object.freeze({
          status: "failed" as const,
          error: outcome.error,
          postOperationReleaseErrors,
        });
      }
      return Object.freeze({
        status: "succeeded" as const,
        value: outcome.value,
        postOperationReleaseErrors,
      });
    },
  };
});

import {
  applyConfigV2Migration,
  checkConfigV2Migration,
  rollbackConfigV2Migration,
} from "../../src/config/migration.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agenc-migration-release-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function migrationPlan(root: string, id: string) {
  const home = join(root, "home");
  const configPath = join(home, "config.toml");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(configPath, "configVersion = 1\n", {
    flag: "wx",
    mode: 0o600,
  });
  const plan = await checkConfigV2Migration({
    env: {},
    home,
    projectRoot: join(root, "project"),
    managedConfigPath: join(root, "managed", "config.toml"),
    managedSettingsPath: join(root, "managed", "managed-settings.json"),
    globalStatePath: join(root, "missing-global.json"),
    id,
    scope: "all",
  });
  return { configPath, plan };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("migration authority release diagnostics", () => {
  test("returns a completed migration result after release failure", async () => {
    const root = temporaryDirectory();
    const { configPath, plan } = await migrationPlan(
      root,
      "completed-release-failure",
    );
    expect(plan.conflicts).toEqual([]);

    await expect(applyConfigV2Migration(plan)).resolves.toMatchObject({
      id: "completed-release-failure",
      writes: 1,
    });
    expect(readFileSync(configPath, "utf8")).toContain('"config_version" = 2');
    await expect(rollbackConfigV2Migration(
      "completed-release-failure",
      { env: {}, home: join(root, "home") },
    )).resolves.toMatchObject({
      id: "completed-release-failure",
      restored: 1,
    });
    expect(readFileSync(configPath, "utf8")).toBe("configVersion = 1\n");
  });

  test("keeps a migration failure primary and attaches release diagnostics", async () => {
    const root = temporaryDirectory();
    const { configPath, plan } = await migrationPlan(
      root,
      "failed-release-failure",
    );
    writeFileSync(configPath, "# changed after check\n", { flag: "a" });

    let caught: unknown;
    try {
      await applyConfigV2Migration(plan);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/input changed after check/u);
    expect(
      (caught as Error & { postOperationReleaseErrors?: readonly Error[] })
        .postOperationReleaseErrors,
    ).toEqual([injectedReleaseError]);
  });
});
