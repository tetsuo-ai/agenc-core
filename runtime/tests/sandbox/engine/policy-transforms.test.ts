import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  effectivePermissionProfile,
  intersectPermissionProfiles,
  mergePermissionProfiles,
  normalizeAdditionalPermissions,
  shouldRequirePlatformSandbox,
} from "./policy-transforms.js";
import {
  canWritePathWithCwd,
  externalFileSystemPolicy,
  getReadableRootsWithCwd,
  getUnreadableRootsWithCwd,
  getWritableRootsWithCwd,
  hasFullDiskReadAccess,
  hasFullDiskWriteAccess,
  includePlatformDefaults,
  restrictedFileSystemPolicy,
  resolveAccessWithCwd,
  resolveSpecialPath,
  unrestrictedFileSystemPolicy,
} from "./index.js";

describe("sandbox permission profile transforms", () => {
  it("normalizes relative permission paths and rejects writable globs", () => {
    expect(
      normalizeAdditionalPermissions(
        {
          fileSystem: {
            entries: [
              { path: { kind: "path", path: "src" }, access: "read" },
            ],
          },
        },
        "/repo",
      ),
    ).toEqual({
      fileSystem: {
        entries: [
          { path: { kind: "path", path: "/repo/src" }, access: "read" },
        ],
      },
    });
    expect(() =>
      normalizeAdditionalPermissions({
        fileSystem: {
          entries: [
            { path: { kind: "glob", pattern: "**/*.pem" }, access: "read" },
          ],
        },
      }),
    ).toThrow(/glob file system permissions only support deny-read/u);
  });

  it("preserves symlinked permission roots during normalization", () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-sandbox-policy-"));
    const realRoot = path.join(tmpdir, "real");
    const linkRoot = path.join(tmpdir, "link");
    fs.mkdirSync(realRoot);
    fs.symlinkSync(realRoot, linkRoot, "dir");

    const normalized = normalizeAdditionalPermissions(
      {
        fileSystem: {
          entries: [
            { path: { kind: "path", path: linkRoot }, access: "write" },
          ],
        },
      },
      tmpdir,
    );

    expect(normalized.fileSystem?.entries).toEqual([
      { path: { kind: "path", path: linkRoot }, access: "write" },
    ]);
  });

  it("merges profile grants while preserving constraining glob depth", () => {
    const merged = mergePermissionProfiles(
      {
        fileSystem: {
          entries: [
            { path: { kind: "glob", pattern: "**/*.pem" }, access: "none" },
          ],
          globScanMaxDepth: 2,
        },
      },
      {
        network: { enabled: true },
        fileSystem: {
          entries: [
            { path: { kind: "path", path: "/repo" }, access: "write" },
          ],
        },
      },
    );

    expect(merged).toEqual({
      network: { enabled: true },
      fileSystem: {
        entries: [
          { path: { kind: "glob", pattern: "**/*.pem" }, access: "none" },
          { path: { kind: "path", path: "/repo" }, access: "write" },
        ],
        globScanMaxDepth: 2,
      },
    });
  });

  it("intersects file grants and carries only deny rules that constrain accepted grants", () => {
    const granted = intersectPermissionProfiles(
      {
        fileSystem: {
          entries: [
            { path: { kind: "path", path: "/repo" }, access: "write" },
            { path: { kind: "glob", pattern: "secrets/**/*.pem" }, access: "none" },
          ],
          globScanMaxDepth: 3,
        },
        network: { enabled: true },
      },
      {
        fileSystem: {
          entries: [
            { path: { kind: "path", path: "/repo/src" }, access: "read" },
          ],
        },
        network: { enabled: false },
      },
      "/repo",
    );

    expect(granted).toEqual({
      fileSystem: {
        entries: [
          { path: { kind: "path", path: "/repo/src" }, access: "read" },
        ],
      },
    });
  });

  it("rejects granted paths covered by requested read-deny globs", () => {
    const granted = intersectPermissionProfiles(
      {
        fileSystem: {
          entries: [
            { path: { kind: "path", path: "/repo" }, access: "write" },
            { path: { kind: "glob", pattern: "secrets/**/*.pem" }, access: "none" },
          ],
          globScanMaxDepth: 3,
        },
      },
      {
        fileSystem: {
          entries: [
            { path: { kind: "path", path: "/repo/secrets/key.pem" }, access: "read" },
          ],
        },
      },
      "/repo",
    );

    expect(granted).toEqual({});
  });

  it("keeps broad grants while retaining nested deny carveouts", () => {
    const granted = intersectPermissionProfiles(
      {
        fileSystem: {
          entries: [
            { path: { kind: "path", path: "/repo" }, access: "write" },
            { path: { kind: "path", path: "/repo/secrets" }, access: "none" },
          ],
        },
      },
      {
        fileSystem: {
          entries: [
            { path: { kind: "path", path: "/repo" }, access: "write" },
          ],
        },
      },
      "/repo",
    );

    expect(granted).toEqual({
      fileSystem: {
        entries: [
          { path: { kind: "path", path: "/repo" }, access: "write" },
          { path: { kind: "path", path: "/repo/secrets" }, access: "none" },
        ],
      },
    });
  });

  it("rejects concrete grants covered by requested glob variants", () => {
    const cases = [
      ["/repo/secret/key[0-9].pem", "/repo/secret/key1.pem"],
      ["/repo/app/file?.txt", "/repo/app/file7.txt"],
      ["/repo/app/*.pem", "/repo/app/key.pem"],
      ["/repo/**/*.env", "/repo/nested/.env"],
      ["/repo/[", "/repo/["],
    ] as const;

    for (const [pattern, grantedPath] of cases) {
      const granted = intersectPermissionProfiles(
        {
          fileSystem: {
            entries: [
              { path: { kind: "path", path: "/repo" }, access: "write" },
              { path: { kind: "glob", pattern }, access: "none" },
            ],
            globScanMaxDepth: 3,
          },
        },
        {
          fileSystem: {
            entries: [
              { path: { kind: "path", path: grantedPath }, access: "read" },
            ],
          },
        },
        "/repo",
      );

      expect(granted, pattern).toEqual({});
    }
  });

  it("does not make cwd writable for read-only restricted policies", () => {
    const readOnly = restrictedFileSystemPolicy([
      { path: { kind: "special", value: { kind: "root" } }, access: "read" },
    ]);

    expect(getWritableRootsWithCwd(readOnly, "/repo")).toEqual([]);
    expect(canWritePathWithCwd(readOnly, "/repo/package.json", "/repo")).toBe(false);
  });

  it("resolves relative base policy paths against the sandbox policy cwd", () => {
    const relativeRead = restrictedFileSystemPolicy([
      { path: { kind: "path", path: "src" }, access: "read" },
    ]);

    expect(getReadableRootsWithCwd(relativeRead, "/repo")).toEqual(["/repo/src"]);
    expect(resolveAccessWithCwd(relativeRead, "/repo/src/index.ts", "/repo")).toBe(
      "read",
    );
    expect(resolveAccessWithCwd(relativeRead, "/other/src/index.ts", "/repo")).toBe(
      "none",
    );
  });

  it("only resolves tmpdir special paths from an absolute TMPDIR", () => {
    const previous = process.env["TMPDIR"];
    try {
      delete process.env["TMPDIR"];
      expect(resolveSpecialPath({ kind: "tmpdir" }, "/repo")).toBeNull();

      process.env["TMPDIR"] = "";
      expect(resolveSpecialPath({ kind: "tmpdir" }, "/repo")).toBeNull();

      process.env["TMPDIR"] = "relative-tmp";
      expect(resolveSpecialPath({ kind: "tmpdir" }, "/repo")).toBeNull();

      process.env["TMPDIR"] = "/tmp/agenc-special";
      expect(resolveSpecialPath({ kind: "tmpdir" }, "/repo")).toBe(
        "/tmp/agenc-special",
      );
    } finally {
      if (previous === undefined) {
        delete process.env["TMPDIR"];
      } else {
        process.env["TMPDIR"] = previous;
      }
    }
  });

  it("keeps project-root special subpaths inside the cwd", () => {
    expect(
      resolveSpecialPath({ kind: "project_roots", subpath: "src" }, "/repo"),
    ).toBe("/repo/src");
    expect(
      resolveSpecialPath({ kind: "project_roots", subpath: "/etc" }, "/repo"),
    ).toBeNull();
    expect(
      resolveSpecialPath(
        { kind: "project_roots", subpath: "../outside" },
        "/repo",
      ),
    ).toBeNull();
    expect(
      resolveSpecialPath(
        { kind: "project_roots", subpath: "safe/../../outside" },
        "/repo",
      ),
    ).toBeNull();
  });

  it("applies specific carveouts and protected metadata over broader writes", () => {
    const workspaceWrite = restrictedFileSystemPolicy([
      { path: { kind: "path", path: "/repo" }, access: "write" },
      { path: { kind: "path", path: "/repo/secrets" }, access: "none" },
    ]);
    const explicitMetadataWrite = restrictedFileSystemPolicy([
      { path: { kind: "path", path: "/repo" }, access: "write" },
      { path: { kind: "path", path: "/repo/.git/config" }, access: "write" },
    ]);

    expect(canWritePathWithCwd(workspaceWrite, "/repo/src/index.ts", "/repo")).toBe(true);
    expect(canWritePathWithCwd(workspaceWrite, "/repo/secrets/key.pem", "/repo")).toBe(false);
    expect(canWritePathWithCwd(workspaceWrite, "/repo/.git/config", "/repo")).toBe(false);
    expect(canWritePathWithCwd(explicitMetadataWrite, "/repo/.git/config", "/repo")).toBe(true);
    expect(getWritableRootsWithCwd(workspaceWrite, "/repo")[0]?.readOnlySubpaths).toContain(
      "/repo/secrets",
    );
  });

  it("preserves raw symlink carveouts under writable roots", () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-sandbox-policy-"));
    const repo = path.join(tmpdir, "repo");
    const realPrivate = path.join(repo, "private");
    const linkedPrivate = path.join(repo, "linked-private");
    fs.mkdirSync(realPrivate, { recursive: true });
    fs.symlinkSync(realPrivate, linkedPrivate, "dir");
    const policy = restrictedFileSystemPolicy([
      { path: { kind: "path", path: repo }, access: "write" },
      { path: { kind: "path", path: linkedPrivate }, access: "read" },
    ]);

    const [root] = getWritableRootsWithCwd(policy, repo);

    expect(root?.root).toBe(repo);
    expect(root?.readOnlySubpaths).toContain(linkedPrivate);
  });

  it("recognizes restricted filesystem-root grants and platform defaults", () => {
    const rootRead = restrictedFileSystemPolicy([
      { path: { kind: "special", value: { kind: "root" } }, access: "read" },
    ]);
    const rootWrite = restrictedFileSystemPolicy([
      { path: { kind: "special", value: { kind: "root" } }, access: "write" },
    ]);
    const minimalRead = restrictedFileSystemPolicy([
      { path: { kind: "special", value: { kind: "minimal" } }, access: "read" },
    ]);
    const rootDeny = restrictedFileSystemPolicy([
      { path: { kind: "special", value: { kind: "root" } }, access: "read" },
      { path: { kind: "special", value: { kind: "root" } }, access: "none" },
    ]);

    expect(hasFullDiskReadAccess(rootRead)).toBe(true);
    expect(hasFullDiskWriteAccess(rootRead)).toBe(false);
    expect(hasFullDiskReadAccess(rootWrite)).toBe(true);
    expect(hasFullDiskWriteAccess(rootWrite)).toBe(true);
    expect(includePlatformDefaults(minimalRead)).toBe(true);
    expect(getUnreadableRootsWithCwd(rootDeny, "/repo")).toEqual([]);
  });

  it("computes effective sandbox requirements from filesystem and network policy", () => {
    const effective = effectivePermissionProfile(
      {
        fileSystem: restrictedFileSystemPolicy([
          { path: { kind: "path", path: "/repo" }, access: "write" },
        ]),
        network: "restricted",
      },
      {
        network: { enabled: true },
        fileSystem: {
          entries: [
            { path: { kind: "path", path: "/tmp/agenc-extra" }, access: "read" },
          ],
        },
      },
    );

    expect(effective.network).toBe("enabled");
    expect(effective.fileSystem.entries).toHaveLength(2);
    expect(
      shouldRequirePlatformSandbox(effective.fileSystem, effective.network, false),
    ).toBe(true);
    expect(
      shouldRequirePlatformSandbox(
        unrestrictedFileSystemPolicy(),
        "enabled",
        false,
      ),
    ).toBe(false);
    expect(
      shouldRequirePlatformSandbox(externalFileSystemPolicy(), "disabled", false),
    ).toBe(false);
  });
});
