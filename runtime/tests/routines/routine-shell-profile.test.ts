/**
 * A scheduled routine's shell profile: the workspace is its only writable
 * root. The session temp root, configured extra writable folders and granted
 * permissions are dropped, never downgraded into read-only carve-outs.
 */
import { describe, expect, it } from "vitest";

import { restrictedFileSystemPolicy, type PermissionProfile } from "../../src/sandbox/engine/index.js";
import { confineRoutineProfile } from "../../src/tools/runtimes/sandboxing.js";

describe("routine shell profile", () => {
  it("keeps only the workspace writable, and every read and denial as it was", () => {
    const profile: PermissionProfile = {
      fileSystem: restrictedFileSystemPolicy([
        { path: { kind: "special", value: { kind: "root" } }, access: "read" },
        { path: { kind: "special", value: { kind: "project_roots" } }, access: "write" },
        { path: { kind: "special", value: { kind: "tmpdir" } }, access: "write" },
        { path: { kind: "path", path: "/home/me/.cache" }, access: "write" },
        { path: { kind: "path", path: "/workspace/sub" }, access: "write" },
        { path: { kind: "special", value: { kind: "project_roots", subpath: "build" } }, access: "write" },
        { path: { kind: "path", path: "/workspace/secret" }, access: "none" },
      ], { includePlatformDefaults: true }),
      network: "disabled",
    };
    const confined = confineRoutineProfile(profile);
    expect(confined.network).toBe("disabled");
    expect(confined.fileSystem).toMatchObject({ kind: "restricted", includePlatformDefaults: true });
    expect(confined.fileSystem.entries).toEqual([
      { path: { kind: "special", value: { kind: "root" } }, access: "read" },
      { path: { kind: "special", value: { kind: "project_roots" } }, access: "write" },
      { path: { kind: "path", path: "/workspace/secret" }, access: "none" },
    ]);
  });

  it("leaves a profile without a restricted file system alone; such a routine does not start", () => {
    const unrestricted: PermissionProfile = { fileSystem: { kind: "unrestricted", entries: [] }, network: "enabled" };
    expect(confineRoutineProfile(unrestricted)).toBe(unrestricted);
  });
});
