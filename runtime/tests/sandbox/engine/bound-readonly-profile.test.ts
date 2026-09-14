import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { BoundReadOnlyCwdIdentity } from "../../../src/sandbox/bound-readonly-cwd.js";
import { INHERITED_CWD_SANDBOX_PATH } from "../../../src/sandbox/linux-launcher/config.js";
import {
  restrictedFileSystemPolicy,
  unrestrictedFileSystemPolicy,
  type FileSystemSandboxEntry,
  type PermissionProfile,
} from "../../../src/sandbox/engine/index.js";
import { narrowBoundReadOnlyProfile } from "../../../src/sandbox/engine/bound-readonly-profile.js";

const SESSION_TEMP = "/tmp/agenc-test-session-root";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function identity(path: string): BoundReadOnlyCwdIdentity {
  return { path, dev: "1", ino: "2", mode: "16832" };
}

function profile(
  entries: readonly FileSystemSandboxEntry[],
  network: PermissionProfile["network"] = "enabled",
): PermissionProfile {
  return { fileSystem: restrictedFileSystemPolicy(entries), network };
}

function inheritedRead(entries: readonly FileSystemSandboxEntry[]) {
  return [
    ...entries,
    { path: { kind: "path" as const, path: INHERITED_CWD_SANDBOX_PATH }, access: "read" as const },
  ];
}

describe("narrowBoundReadOnlyProfile", () => {
  test("keeps only uncovered sibling roots, forces them read-only, and disables the network", () => {
    const workspace = "/repo/workspace";
    const sibling = "/repo/other";
    const narrowed = narrowBoundReadOnlyProfile(
      profile([
        { path: { kind: "path", path: workspace }, access: "write" },
        { path: { kind: "path", path: join(workspace, "src") }, access: "write" },
        { path: { kind: "path", path: sibling }, access: "write" },
      ]),
      identity(workspace),
      "/repo",
      SESSION_TEMP,
    );
    expect(narrowed.network).toBe("disabled");
    expect(narrowed.fileSystem).toEqual({
      kind: "restricted",
      entries: inheritedRead([
        { path: { kind: "path", path: sibling }, access: "read" },
      ]),
    });
  });

  test("treats a parent or filesystem-root grant as coverage without retaining it", () => {
    const workspace = "/repo/workspace";
    const narrowed = narrowBoundReadOnlyProfile(
      profile([{ path: { kind: "special", value: { kind: "root" } }, access: "read" }]),
      identity(workspace),
      workspace,
      SESSION_TEMP,
    );
    expect(narrowed.fileSystem.entries).toEqual(inheritedRead([]));
  });

  test("refuses unrestricted, deny, and glob policy that a descriptor bind cannot represent", () => {
    const workspace = "/repo/workspace";
    expect(() =>
      narrowBoundReadOnlyProfile(
        { fileSystem: unrestrictedFileSystemPolicy(), network: "disabled" },
        identity(workspace),
        workspace,
        SESSION_TEMP,
      ),
    ).toThrow("cannot represent read-deny or glob policy entries");
    expect(() =>
      narrowBoundReadOnlyProfile(
        profile([{ path: { kind: "path", path: join(workspace, "secret.txt") }, access: "none" }]),
        identity(workspace),
        workspace,
        SESSION_TEMP,
      ),
    ).toThrow("cannot represent read-deny or glob policy entries");
    expect(() =>
      narrowBoundReadOnlyProfile(
        profile([{ path: { kind: "glob", pattern: join(workspace, "*.txt") }, access: "read" }]),
        identity(workspace),
        workspace,
        SESSION_TEMP,
      ),
    ).toThrow("cannot represent read-deny or glob policy entries");
  });

  test("refuses a bind that no admitted directory grant covers", () => {
    expect(() =>
      narrowBoundReadOnlyProfile(
        profile([{ path: { kind: "path", path: "/repo/other" }, access: "read" }]),
        identity("/repo/workspace"),
        "/repo",
        SESSION_TEMP,
      ),
    ).toThrow("not wholly covered by a directory read grant");
  });

  test("refuses an aliased sibling grant that would reopen the bound directory", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-bound-readonly-profile-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const alias = join(root, "alias");
    mkdirSync(workspace);
    symlinkSync(workspace, alias, "dir");
    expect(() =>
      narrowBoundReadOnlyProfile(
        profile([
          { path: { kind: "path", path: workspace }, access: "read" },
          { path: { kind: "path", path: alias }, access: "read" },
        ]),
        identity(workspace),
        root,
        join(root, "tmp"),
      ),
    ).toThrow("cannot retain an aliased read root");
  });
});
