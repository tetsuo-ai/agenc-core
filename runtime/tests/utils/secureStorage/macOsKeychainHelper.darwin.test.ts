import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { expect, test } from "vitest";

if (process.platform !== "darwin") {
  throw new Error("the native Keychain helper test requires macOS");
}

test("compiles and performs exact missing/create/update/read/delete Keychain CRUD", () => {
  const testHome = process.env.HOME?.trim();
  if (testHome === undefined || testHome.length === 0) {
    throw new Error("the native Keychain helper test requires HOME");
  }
  mkdirSync(join(testHome, "Library", "Preferences"), {
    recursive: true,
    mode: 0o700,
  });
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
  let originalDefaultCaptured = false;
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
  const expectMissingUserDefault = (result: ReturnType<typeof runSecurity>) => {
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("SecKeychainCopyDomainDefault user:");
  };

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

    const defaultKeychain = runSecurity(["default-keychain", "-d", "user"]);
    if (defaultKeychain.status === 0) {
      expect(defaultKeychain.error).toBeUndefined();
      expect(defaultKeychain.stderr).toBe("");
      [originalDefaultKeychain] = parseKeychainPaths(defaultKeychain.stdout);
      expect(originalDefaultKeychain).toBeDefined();
    } else {
      expectMissingUserDefault(defaultKeychain);
    }
    originalDefaultCaptured = true;

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
    const [
      canonicalPrimaryKeychain,
      canonicalFirstKeychain,
      canonicalSecondKeychain,
    ] = temporaryKeychains.map((keychain) => realpathSync(keychain));
    expect(originalDefaultKeychain).toBeUndefined();
    expectMissingUserDefault(runSecurity(["default-keychain", "-d", "user"]));
    runSecuritySuccessfully([
      "list-keychains",
      "-d",
      "user",
      "-s",
      primaryKeychain,
    ]);
    const soleSearchList = runSecuritySuccessfully([
      "list-keychains",
      "-d",
      "user",
    ]);
    expect(parseKeychainPaths(soleSearchList.stdout)).toEqual([
      canonicalPrimaryKeychain,
    ]);
    expectMissingUserDefault(runSecurity(["default-keychain", "-d", "user"]));
    expect(run("write", first)).toMatchObject({ status: 0, stderr: "" });
    runSecuritySuccessfully([
      "find-generic-password",
      "-a",
      account,
      "-s",
      service,
      primaryKeychain,
    ]);
    expect(run("read")).toMatchObject({
      status: 0,
      stdout: first,
      stderr: "",
    });
    expect(run("delete")).toMatchObject({ status: 0, stderr: "" });

    runSecuritySuccessfully([
      "list-keychains",
      "-d",
      "user",
      "-s",
      firstKeychain,
      secondKeychain,
      primaryKeychain,
    ]);
    const ambiguousSearchList = runSecuritySuccessfully([
      "list-keychains",
      "-d",
      "user",
    ]);
    expect(parseKeychainPaths(ambiguousSearchList.stdout)).toEqual([
      canonicalFirstKeychain,
      canonicalSecondKeychain,
      canonicalPrimaryKeychain,
    ]);
    expectMissingUserDefault(runSecurity(["default-keychain", "-d", "user"]));
    const ambiguousCreateTarget = run("write", first);
    expect(ambiguousCreateTarget.status).toBe(1);
    expect(ambiguousCreateTarget.stderr).toContain("Keychain add failed");
    expect(ambiguousCreateTarget.stderr).toContain("OSStatus -25307");
    for (const keychain of temporaryKeychains) {
      const absent = runSecurity([
        "find-generic-password",
        "-a",
        account,
        "-s",
        service,
        keychain,
      ]);
      expect(absent.status).not.toBe(0);
      expect(absent.stdout).toBe("");
    }
    expect(run("read")).toMatchObject({
      status: 2,
      stdout: "",
      stderr: "",
    });
    runSecuritySuccessfully([
      "list-keychains",
      "-d",
      "user",
      "-s",
      primaryKeychain,
    ]);
    expectMissingUserDefault(runSecurity(["default-keychain", "-d", "user"]));

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
    runSecuritySuccessfully([
      "unlock-keychain",
      "-p",
      keychainPassword,
      primaryKeychain,
    ]);
    const configuredSearchList = runSecuritySuccessfully([
      "list-keychains",
      "-d",
      "user",
    ]);
    expect(parseKeychainPaths(configuredSearchList.stdout)).toEqual([
      canonicalPrimaryKeychain,
    ]);
    const configuredDefaultKeychain = runSecuritySuccessfully([
      "default-keychain",
      "-d",
      "user",
    ]);
    expect(parseKeychainPaths(configuredDefaultKeychain.stdout)).toEqual([
      canonicalPrimaryKeychain,
    ]);

    const initiallyMissing = run("read");
    expect(initiallyMissing.status).toBe(2);
    expect(initiallyMissing.stdout).toBe("");
    expect(initiallyMissing.stderr).toBe("");

    const create = run("write", first);
    expect(create.error?.message ?? create.stderr).toBe("");
    expect(create.status).toBe(0);
    // A different executable may need interactive ACL approval to read secret
    // bytes. Use `security` only to prove the target keychain; the helper below
    // verifies the exact bytes without weakening the item's production ACL.
    runSecuritySuccessfully([
      "find-generic-password",
      "-a",
      account,
      "-s",
      service,
      primaryKeychain,
    ]);
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

    runSecuritySuccessfully([
      "default-keychain",
      "-d",
      "user",
      "-s",
      secondKeychain,
    ]);
    runSecuritySuccessfully([
      "list-keychains",
      "-d",
      "user",
      "-s",
      primaryKeychain,
    ]);
    const outsideSearchAuthority = run("write", first);
    expect(outsideSearchAuthority.status).toBe(1);
    expect(outsideSearchAuthority.stderr).toContain("Keychain add failed");
    expect(outsideSearchAuthority.stderr).toContain("OSStatus -25295");
    for (const keychain of [primaryKeychain, secondKeychain]) {
      const absent = runSecurity([
        "find-generic-password",
        "-a",
        account,
        "-s",
        service,
        keychain,
      ]);
      expect(absent.status).not.toBe(0);
      expect(absent.stdout).toBe("");
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

    runSecuritySuccessfully([
      "list-keychains",
      "-d",
      "user",
      "-s",
      firstKeychain,
      secondKeychain,
      primaryKeychain,
    ]);
    const duplicateSearchList = runSecuritySuccessfully([
      "list-keychains",
      "-d",
      "user",
    ]);
    expect(parseKeychainPaths(duplicateSearchList.stdout)).toEqual([
      canonicalFirstKeychain,
      canonicalSecondKeychain,
      canonicalPrimaryKeychain,
    ]);

    for (const operation of ["read", "write", "delete"] as const) {
      const ambiguousService = `AgenC-native-helper-duplicate-${operation}-${randomUUID()}`;
      const ambiguousAccount = `duplicate-${operation}-${process.pid}`;
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

      const result = spawnSync(
        helper,
        [operation, ambiguousService, ambiguousAccount],
        {
          encoding: "utf8",
          input:
            operation === "write"
              ? JSON.stringify({ primaryApiKey: "replacement" })
              : undefined,
          timeout: 10_000,
        },
      );
      expect(result.status, `${operation} must reject ambiguity`).toBe(1);
      expect(result.stderr, `${operation} must explain ambiguity`).toMatch(
        /multiple Keychain records/u,
      );
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
        expect(
          unchanged.stdout.trim(),
          `${operation} must leave ${keychain} unchanged`,
        ).toBe(value);
      }
    }

    expect(run("write", first)).toMatchObject({ status: 0, stderr: "" });
    runSecuritySuccessfully([
      "find-generic-password",
      "-a",
      account,
      "-s",
      service,
      primaryKeychain,
    ]);
    expect(run("read")).toMatchObject({
      status: 0,
      stdout: first,
      stderr: "",
    });
    expect(run("delete")).toMatchObject({ status: 0, stderr: "" });
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
    if (originalDefaultCaptured) {
      // `-s` without a path unsets the user default, matching the captured
      // no-default state that the test asserted before pointing the default
      // at temporary keychains that are deleted below.
      void runSecurity([
        "default-keychain",
        "-d",
        "user",
        "-s",
        ...(originalDefaultKeychain === undefined
          ? []
          : [originalDefaultKeychain]),
      ]);
    }
    for (const keychain of temporaryKeychains) {
      void runSecurity(["delete-keychain", keychain]);
    }
    rmSync(work, { recursive: true, force: true });
  }
}, 90_000);
