import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import {
  assertWindowsPrivatePathSecurity,
} from "../../../src/agents/workflow-private-path.js";
import { createCsvOutputRootCapability, writeCsvOutput } from "./csv-output.js";

const NATIVE_CSV_TEST_TIMEOUT_MS = 90_000;

test("publishes through native hardlinks and removes every staging entry", async () => {
  await withNativeCsvRoot(async (root) => {
    const capability = createCsvOutputRootCapability(root);
    const requestedTarget = join(root, "native-publication.csv");
    const canonicalTarget = join(
      capability.canonicalRoot,
      "native-publication.csv",
    );
    const expected = "id,value\n1,secret\n";
    const artifact = await withPoisonedWindowsProcessEnvironment(() =>
      writeCsvOutput({
        capability,
        jobId: "native-publication",
        requestedPath: requestedTarget,
        mode: "create_new",
        headers: ["id", "value"],
        rows: [["1", "secret"]],
      }));

    expect(artifact).toMatchObject({
      path: canonicalTarget,
      bytes: Buffer.byteLength(expected, "utf8"),
      sha256: createHash("sha256").update(expected).digest("hex"),
    });
    await expect(readFile(canonicalTarget, "utf8")).resolves.toBe(expected);
    const published = await lstat(canonicalTarget, { bigint: true });
    expect(published.isFile()).toBe(true);
    expect(published.nlink).toBe(1n);
    await expect(readdir(root)).resolves.toEqual(["native-publication.csv"]);
  });
}, NATIVE_CSV_TEST_TIMEOUT_MS);

test("rejects an inheritable foreign read ACE before creating staging entries", async () => {
  await withNativeCsvRoot(async (root) => {
    const capability = createCsvOutputRootCapability(root);
    await installForeignInheritedReadAce(root);
    const target = join(root, "native-acl-rejection.csv");

    await expect(
      withPoisonedWindowsProcessEnvironment(() =>
        writeCsvOutput({
          capability,
          jobId: "native-acl-rejection",
          requestedPath: target,
          mode: "create_new",
          headers: ["value"],
          rows: [["secret"]],
        })),
    ).rejects.toThrow(/inherited read/u);
    await expect(readdir(root)).resolves.toEqual([]);
  });
}, NATIVE_CSV_TEST_TIMEOUT_MS);

async function withNativeCsvRoot(
  action: (root: string) => Promise<void>,
): Promise<void> {
  assertSupportedNativePlatform();
  const temporaryParent =
    process.platform === "win32" ? userInfo().homedir : tmpdir();
  const root = await mkdtemp(
    join(temporaryParent, "agenc-csv-output-native-"),
  );
  let actionError: unknown;
  try {
    assertWindowsPrivatePathSecurity(root, "directory", true);
    await action(root);
  } catch (error) {
    actionError = error;
  }

  let cleanupError: unknown;
  try {
    if (process.platform === "darwin") {
      execFileSync("/bin/chmod", ["-N", root], {
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
      });
    }
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }

  if (actionError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [actionError, cleanupError],
      "native CSV test and cleanup both failed",
    );
  }
  if (actionError !== undefined) throw actionError;
  if (cleanupError !== undefined) throw cleanupError;
}

async function withPoisonedWindowsProcessEnvironment<T>(
  action: () => Promise<T>,
): Promise<T> {
  if (process.platform !== "win32") return action();
  const poisoned = {
    PATH: String.raw`C:\attacker`,
    SystemRoot: String.raw`C:\attacker`,
    WINDIR: String.raw`C:\attacker`,
  } as const;
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(poisoned)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    return await action();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function installForeignInheritedReadAce(root: string): Promise<void> {
  if (process.platform === "darwin") {
    await chmod(root, 0o755);
    execFileSync(
      "/bin/chmod",
      ["+a", "everyone allow read,file_inherit", root],
      { env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } },
    );
    return;
  }
  execFileSync(
    "icacls.exe",
    [root, "/grant", "*S-1-5-32-545:(OI)(CI)(IO)(GR)"],
    { encoding: "buffer", windowsHide: true },
  );
}

function assertSupportedNativePlatform(): void {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error(
      `CSV native filesystem tests require Darwin or Windows, received ${process.platform}`,
    );
  }
}
