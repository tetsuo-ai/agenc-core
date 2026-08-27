import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  parseAgenCConfigCliArgs,
  runAgenCConfigCli,
  type AgenCConfigCliIo,
} from "./config-cli.js";

const temporaryDirectories: string[] = [];

function makeIo(): AgenCConfigCliIo & {
  readonly out: () => string;
  readonly err: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write: (value) => (stdout += String(value), true) },
    stderr: { write: (value) => (stderr += String(value), true) },
    out: () => stdout,
    err: () => stderr,
  } as AgenCConfigCliIo & { readonly out: () => string; readonly err: () => string };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("agenc config migrate", () => {
  test("parses check, apply, and rollback forms", () => {
    expect(parseAgenCConfigCliArgs(["config", "migrate"])).toEqual({
      kind: "migrate",
      action: "check",
      retireSharedSecureStorage: false,
      confirmRetiredWritersStopped: false,
    });
    expect(parseAgenCConfigCliArgs(["config", "migrate", "apply"])).toEqual({
      kind: "migrate",
      action: "apply",
      retireSharedSecureStorage: false,
      confirmRetiredWritersStopped: false,
    });
    expect(parseAgenCConfigCliArgs([
      "config",
      "migrate",
      "apply",
      "--retire-shared-secure-storage",
    ])).toEqual({
      kind: "migrate",
      action: "apply",
      retireSharedSecureStorage: true,
      confirmRetiredWritersStopped: false,
    });
    expect(parseAgenCConfigCliArgs([
      "config",
      "migrate",
      "apply",
      "--confirm-retired-writers-stopped",
      "--retire-shared-secure-storage",
    ])).toEqual({
      kind: "migrate",
      action: "apply",
      retireSharedSecureStorage: true,
      confirmRetiredWritersStopped: true,
    });
    expect(parseAgenCConfigCliArgs([
      "config",
      "migrate",
      "check",
      "--retired-secure-storage-account",
      "historical-user",
    ])).toEqual({
      kind: "migrate",
      action: "check",
      retireSharedSecureStorage: false,
      confirmRetiredWritersStopped: false,
      retiredSecureStorageAccount: "historical-user",
    });
    expect(parseAgenCConfigCliArgs([
      "config",
      "migrate",
      "rollback",
      "migration-id",
    ])).toEqual({ kind: "migrate", action: "rollback", id: "migration-id" });
  });

  test("rejects ambiguous retired-vault account arguments", () => {
    expect(parseAgenCConfigCliArgs([
      "config",
      "migrate",
      "check",
      "--retired-secure-storage-account",
    ])).toMatchObject({ kind: "error" });
    expect(parseAgenCConfigCliArgs([
      "config",
      "migrate",
      "apply",
      "--retired-secure-storage-account",
      "--confirm-retired-writers-stopped",
    ])).toMatchObject({ kind: "error" });
    expect(parseAgenCConfigCliArgs([
      "config",
      "migrate",
      "check",
      "--retired-secure-storage-account",
      "first",
      "--retired-secure-storage-account",
      "second",
    ])).toMatchObject({ kind: "error" });
  });

  test("keeps check read-only and exposes apply/rollback journals", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-config-cli-v2-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    mkdirSync(home, { recursive: true });
    const configPath = join(home, "config.toml");
    const legacy = "configVersion = 1\nmodel = \"legacy\"\n";
    writeFileSync(configPath, legacy, { mode: 0o600 });
    const common = {
      agencHome: home,
      env: {},
      projectRoot,
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
    } as const;

    const checkIo = makeIo();
    expect(await runAgenCConfigCli(
      {
        kind: "migrate",
        action: "check",
        retireSharedSecureStorage: false,
        confirmRetiredWritersStopped: false,
      },
      { ...common, io: checkIo },
    )).toBe(0);
    expect(checkIo.out()).toContain("no files were changed");
    expect(readFileSync(configPath, "utf8")).toBe(legacy);

    const applyIo = makeIo();
    expect(await runAgenCConfigCli(
      {
        kind: "migrate",
        action: "apply",
        retireSharedSecureStorage: false,
        confirmRetiredWritersStopped: false,
      },
      { ...common, io: applyIo },
    )).toBe(0);
    const id = /Applied config migration ([A-Za-z0-9._-]+):/u.exec(applyIo.out())?.[1];
    expect(id).toBeTruthy();
    expect(readFileSync(configPath, "utf8")).toContain('"config_version" = 2');

    const rollbackIo = makeIo();
    expect(await runAgenCConfigCli(
      { kind: "migrate", action: "rollback", id: id! },
      { ...common, io: rollbackIo },
    )).toBe(0);
    expect(rollbackIo.out()).toContain(`Rolled back config migration ${id}`);
    expect(readFileSync(configPath, "utf8")).toBe(legacy);
  });
});
