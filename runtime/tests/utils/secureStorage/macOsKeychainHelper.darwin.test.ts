import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { expect, test } from "vitest";

if (process.platform !== "darwin") {
  throw new Error("the native Keychain helper test requires macOS");
}

test("compiles and performs exact missing/create/update/read/delete Keychain CRUD", () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-keychain-helper-test-"));
  const source = resolve(
    import.meta.dirname,
    "../../../native/agenc-keychain-helper.c",
  );
  const helper = join(work, "agenc-keychain-helper");
  const service = `AgenC-native-helper-test-${randomUUID()}`;
  const account = `test-account-雪-${process.pid}`;
  const first = JSON.stringify({ primaryApiKey: `first-${randomUUID()}` });
  const second = JSON.stringify({ primaryApiKey: `second-${randomUUID()}` });
  const securityPath = "/usr/bin/security";
  const firstKeychain = join(work, "duplicate-first.keychain-db");
  const secondKeychain = join(work, "duplicate-second.keychain-db");
  const keychainPassword = `fixture-${randomUUID()}`;
  let originalSearchList: string[] | undefined;
  const run = (operation: "read" | "write" | "delete", input?: string) =>
    spawnSync(helper, [operation, service, account], {
      encoding: "utf8",
      input,
      timeout: 10_000,
    });
  const runSecurity = (args: string[]) =>
    spawnSync(securityPath, args, {
      encoding: "utf8",
      timeout: 10_000,
    });

  try {
    const compile = spawnSync(
      process.env.CC?.trim() || "cc",
      [
        "-O2",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-D_FORTIFY_SOURCE=2",
        "-fstack-protector-strong",
        "-framework",
        "Security",
        "-framework",
        "CoreFoundation",
        "-o",
        helper,
        source,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(compile.error?.message ?? compile.stderr).toBe("");
    expect(compile.status).toBe(0);

    const initiallyMissing = run("read");
    expect(initiallyMissing.status).toBe(2);
    expect(initiallyMissing.stdout).toBe("");
    expect(initiallyMissing.stderr).toBe("");

    const create = run("write", first);
    expect(create.status).toBe(0);
    expect(create.stderr).toBe("");
    expect(run("read")).toMatchObject({
      status: 0,
      stdout: first,
      stderr: "",
    });

    const update = run("write", second);
    expect(update.status).toBe(0);
    expect(update.stderr).toBe("");
    expect(run("read")).toMatchObject({
      status: 0,
      stdout: second,
      stderr: "",
    });

    const remove = run("delete");
    expect(remove.status).toBe(0);
    expect(remove.stderr).toBe("");
    const missingAgain = run("delete");
    expect(missingAgain.status).toBe(2);
    expect(missingAgain.stdout).toBe("");
    expect(missingAgain.stderr).toBe("");

    const listed = runSecurity(["list-keychains", "-d", "user"]);
    expect(listed.status).toBe(0);
    originalSearchList = [...listed.stdout.matchAll(/"([^"\r\n]+)"/gu)].map(
      (match) => match[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\"),
    );
    expect(originalSearchList.length).toBeGreaterThan(0);
    for (const keychain of [firstKeychain, secondKeychain]) {
      expect(
        runSecurity(["create-keychain", "-p", keychainPassword, keychain])
          .status,
      ).toBe(0);
      expect(
        runSecurity(["unlock-keychain", "-p", keychainPassword, keychain])
          .status,
      ).toBe(0);
    }

    const ambiguousService = `AgenC-native-helper-duplicate-${randomUUID()}`;
    const ambiguousAccount = `duplicate-account-${process.pid}`;
    for (const [keychain, value] of [
      [firstKeychain, "first-record"],
      [secondKeychain, "second-record"],
    ] as const) {
      expect(
        runSecurity([
          "add-generic-password",
          "-A",
          "-a",
          ambiguousAccount,
          "-s",
          ambiguousService,
          "-w",
          value,
          keychain,
        ]).status,
      ).toBe(0);
    }
    expect(
      runSecurity([
        "list-keychains",
        "-d",
        "user",
        "-s",
        firstKeychain,
        secondKeychain,
        ...originalSearchList,
      ]).status,
    ).toBe(0);

    const ambiguousRun = (
      operation: "read" | "write" | "delete",
      input?: string,
    ) =>
      spawnSync(helper, [operation, ambiguousService, ambiguousAccount], {
        encoding: "utf8",
        input,
        timeout: 10_000,
      });
    for (const result of [
      ambiguousRun("read"),
      ambiguousRun("write", JSON.stringify({ primaryApiKey: "replacement" })),
      ambiguousRun("delete"),
    ]) {
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/multiple Keychain records/u);
    }
    for (const [keychain, value] of [
      [firstKeychain, "first-record"],
      [secondKeychain, "second-record"],
    ] as const) {
      const unchanged = runSecurity([
        "find-generic-password",
        "-a",
        ambiguousAccount,
        "-s",
        ambiguousService,
        "-w",
        keychain,
      ]);
      expect(unchanged.status).toBe(0);
      expect(unchanged.stdout.trim()).toBe(value);
    }
  } finally {
    void run("delete");
    if (originalSearchList !== undefined) {
      void runSecurity([
        "list-keychains",
        "-d",
        "user",
        "-s",
        ...originalSearchList,
      ]);
    }
    void runSecurity(["delete-keychain", firstKeychain]);
    void runSecurity(["delete-keychain", secondKeychain]);
    rmSync(work, { recursive: true, force: true });
  }
}, 90_000);
