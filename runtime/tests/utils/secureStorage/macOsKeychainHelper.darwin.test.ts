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
  const primaryKeychain = join(work, "primary.keychain-db");
  const firstKeychain = join(work, "duplicate-first.keychain-db");
  const secondKeychain = join(work, "duplicate-second.keychain-db");
  const temporaryKeychains = [primaryKeychain, firstKeychain, secondKeychain];
  const keychainPassword = `fixture-${randomUUID()}`;
  let originalSearchList: string[] | undefined;
  let originalDefaultKeychain: string | undefined;
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
  const runSecuritySuccessfully = (args: string[]) => {
    const result = runSecurity(args);
    expect(result.error?.message ?? result.stderr).toBe("");
    expect(result.status).toBe(0);
    return result;
  };
  const parseKeychainPaths = (stdout: string) =>
    [...stdout.matchAll(/"([^"\r\n]+)"/gu)].map((match) =>
      match[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\"),
    );

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

    const defaultKeychain = runSecurity([
      "default-keychain",
      "-d",
      "user",
    ]);
    if (defaultKeychain.status === 0) {
      expect(defaultKeychain.error).toBeUndefined();
      expect(defaultKeychain.stderr).toBe("");
      [originalDefaultKeychain] = parseKeychainPaths(defaultKeychain.stdout);
      expect(originalDefaultKeychain).toBeDefined();
    } else {
      expect(defaultKeychain.error).toBeUndefined();
      expect(defaultKeychain.stdout).toBe("");
      expect(defaultKeychain.stderr.trim()).toBe(
        "security: SecKeychainCopyDomainDefault user: A default keychain could not be found.",
      );
    }

    const listed = runSecuritySuccessfully(["list-keychains", "-d", "user"]);
    originalSearchList = parseKeychainPaths(listed.stdout);

    for (const keychain of temporaryKeychains) {
      runSecuritySuccessfully([
        "create-keychain",
        "-p",
        keychainPassword,
        keychain,
      ]);
      runSecuritySuccessfully([
        "unlock-keychain",
        "-p",
        keychainPassword,
        keychain,
      ]);
    }
    runSecuritySuccessfully([
      "default-keychain",
      "-d",
      "user",
      "-s",
      primaryKeychain,
    ]);
    runSecuritySuccessfully([
      "list-keychains",
      "-d",
      "user",
      "-s",
      primaryKeychain,
    ]);

    const initiallyMissing = run("read");
    expect(initiallyMissing.status).toBe(2);
    expect(initiallyMissing.stdout).toBe("");
    expect(initiallyMissing.stderr).toBe("");

    const create = run("write", first);
    expect(create.error?.message ?? create.stderr).toBe("");
    expect(create.status).toBe(0);
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

    const ambiguousService = `AgenC-native-helper-duplicate-${randomUUID()}`;
    const ambiguousAccount = `duplicate-account-${process.pid}`;
    for (const [keychain, value] of [
      [firstKeychain, "first-record"],
      [secondKeychain, "second-record"],
    ] as const) {
      runSecuritySuccessfully([
        "add-generic-password",
        "-A",
        "-a",
        ambiguousAccount,
        "-s",
        ambiguousService,
        "-w",
        value,
        keychain,
      ]);
    }
    runSecuritySuccessfully([
      "list-keychains",
      "-d",
      "user",
      "-s",
      firstKeychain,
      secondKeychain,
      primaryKeychain,
    ]);

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
      const unchanged = runSecuritySuccessfully([
        "find-generic-password",
        "-a",
        ambiguousAccount,
        "-s",
        ambiguousService,
        "-w",
        keychain,
      ]);
      expect(unchanged.stdout.trim()).toBe(value);
    }
  } finally {
    void run("delete");
    if (originalDefaultKeychain !== undefined) {
      void runSecurity([
        "default-keychain",
        "-d",
        "user",
        "-s",
        originalDefaultKeychain,
      ]);
    }
    if (originalSearchList !== undefined) {
      void runSecurity([
        "list-keychains",
        "-d",
        "user",
        "-s",
        ...originalSearchList,
      ]);
    }
    for (const keychain of temporaryKeychains) {
      void runSecurity(["delete-keychain", keychain]);
    }
    rmSync(work, { recursive: true, force: true });
  }
}, 90_000);
