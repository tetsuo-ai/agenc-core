import fs from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWritableRootPathsWithCwd,
  getWritableRootsWithCwd,
  nestedGitFindings,
  restrictedFileSystemPolicy,
  type FileSystemSandboxPolicy,
} from "../../../src/sandbox/engine/policy.js";
import { protectAgencHomeUnderWritableRoot } from "../../../src/sandbox/agenc-home-protection.js";
import { permissionProfileForSandboxMode } from "../../../src/tools/runtimes/sandboxing.js";

// Every tool call computes the sandbox's writable roots, and that computation
// walks each root for nested repositories. A FileRead on 0.19.31 was slower
// than on 0.19.30 because the walk built a path for every entry it listed,
// files included, where 0.19.30 skipped a file before building its path; a
// writable /tmp holds the runtime's compile cache (hundreds of files). These
// cases keep the walk to directories and `.git` entries, and keep a caller
// that only needs the root paths from walking at all.
let base: string, workspace: string, temp: string;
beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "walk-cost-")));
  workspace = join(base, "workspace");
  temp = join(base, "tmp");
  fs.mkdirSync(join(workspace, "src"), { recursive: true });
  fs.mkdirSync(join(temp, "compile-cache"), { recursive: true });
  for (let i = 0; i < 200; i += 1) {
    fs.writeFileSync(join(workspace, "src", `file-${i}.txt`), "x\n");
    fs.writeFileSync(join(temp, "compile-cache", `file-${i}.bin`), "x\n");
  }
  fs.symlinkSync(join(workspace, "src"), join(workspace, "linked-src"));
  // One standalone nested repository and one nested gitfile pointer.
  fs.mkdirSync(join(workspace, "vendor", "lib", ".git", "objects"), { recursive: true });
  fs.writeFileSync(join(workspace, "vendor", "lib", ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(join(workspace, "pkg"), { recursive: true });
  fs.writeFileSync(join(workspace, "pkg", ".git"), "gitdir: ../unresolvable\n");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

const workspaceWrite = (): FileSystemSandboxPolicy => restrictedFileSystemPolicy([
  { path: { kind: "special", value: { kind: "root" } }, access: "read" },
  { path: { kind: "path", path: workspace }, access: "write" },
  { path: { kind: "path", path: temp }, access: "write" },
]);

describe("nested-repository walk cost", () => {
  it("builds a path only for directories and .git entries, with the same findings", () => {
    const joins = vi.spyOn(path, "join");
    const findings = nestedGitFindings(workspace, [workspace, temp]);
    const calls = [...joins.mock.calls];
    joins.mockRestore();
    const fileJoins = calls.filter((args) => /^file-\d+\.(?:txt|bin)$/.test(String(args.at(-1))));
    expect(fileJoins).toEqual([]);
    // The symlink is not descended into and gets no path either.
    expect(calls.filter((args) => args.at(-1) === "linked-src")).toEqual([]);
    expect(findings.repoDirs).toEqual([path.join(workspace, "vendor", "lib", ".git")]);
    expect([...findings.descentPoints].sort()).toEqual([
      path.join(workspace, "pkg", ".git"),
      path.join(workspace, "vendor", "lib", ".git"),
    ]);
    expect(findings.pointerFiles).toEqual([path.join(workspace, "pkg", ".git")]);
  });

  it("keeps the writable roots and their carve-outs unchanged", () => {
    const roots = getWritableRootsWithCwd(workspaceWrite(), workspace, temp);
    const byRoot = new Map(roots.map((root) => [root.root, root]));
    const ws = byRoot.get(workspace)!;
    expect(ws.nestedRepoGitDirs?.sort()).toEqual([
      path.join(workspace, "pkg", ".git"),
      path.join(workspace, "vendor", "lib", ".git"),
    ]);
    // The nested repository's surface and the descent-point gitfile stay read-only.
    expect(ws.readOnlySubpaths).toContain(path.join(workspace, "vendor", "lib", ".git", "hooks"));
    expect(ws.readOnlySubpaths).toContain(path.join(workspace, "vendor", "lib", ".git", "config"));
    expect(ws.readOnlySubpaths).toContain(path.join(workspace, "pkg", ".git"));
    expect(byRoot.get(temp)?.nestedRepoGitDirs).toBeUndefined();
  });
});

describe("writable root paths without carve-outs", () => {
  it("lists exactly the roots getWritableRootsWithCwd lists, in order", () => {
    const profiles: FileSystemSandboxPolicy[] = [
      workspaceWrite(),
      permissionProfileForSandboxMode("workspace_write", { cwd: workspace }).fileSystem,
      permissionProfileForSandboxMode("read_only", { cwd: workspace }).fileSystem,
      permissionProfileForSandboxMode("danger_full_access", { cwd: workspace }).fileSystem,
      restrictedFileSystemPolicy([
        { path: { kind: "special", value: { kind: "root" } }, access: "read" },
        { path: { kind: "path", path: workspace }, access: "write" },
        { path: { kind: "path", path: join(workspace, "src") }, access: "read" },
        { path: { kind: "path", path: join(workspace, "vendor") }, access: "write" },
      ], { reservedReadOnlyPaths: [join(workspace, "reserved")] }),
    ];
    for (const policy of profiles) {
      expect(getWritableRootPathsWithCwd(policy, workspace, temp))
        .toEqual(getWritableRootsWithCwd(policy, workspace, temp).map((root) => root.root));
    }
  });

  it("decides the AgenC home protection without walking any writable root", () => {
    const home = join(workspace, "agenc-home");
    fs.mkdirSync(home);
    const profile = permissionProfileForSandboxMode("workspace_write", { cwd: workspace });
    const readdir = vi.spyOn(fs, "readdirSync");
    const protectedProfile = protectAgencHomeUnderWritableRoot(profile, home, workspace, temp);
    expect(readdir.mock.calls.filter(([dir]) => dir === workspace || dir === temp)).toEqual([]);
    // Home inside the workspace is still reserved read-only; home outside every
    // writable root leaves the profile as it was.
    expect(protectedProfile).not.toBe(profile);
    expect(protectedProfile.fileSystem.reservedReadOnlyPaths).toContain(home);
    const outside = join(base, "elsewhere-home");
    fs.mkdirSync(outside);
    expect(protectAgencHomeUnderWritableRoot(profile, outside, workspace, temp)).toBe(profile);
  });
});
