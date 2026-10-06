import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { resolveAccessWithCwd, type FileSystemSandboxEntry, type PermissionProfile } from "../../src/sandbox/engine/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(aliased = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-linked-metadata-policy-")));
  roots.push(root);
  const prefix = aliased ? join(root, "alias") : root;
  if (aliased) symlinkSync(root, prefix, "dir");
  const project = join(prefix, "project");
  const child = join(project, ".agenc-worktrees", "worker");
  const metadata = join(project, ".git");
  const admin = join(metadata, "worktrees", "worker");
  mkdirSync(admin, { recursive: true });
  mkdirSync(child, { recursive: true });
  writeFileSync(join(child, ".git"), `gitdir: ${admin}\n`);
  writeFileSync(join(admin, "commondir"), "../..\n");
  writeFileSync(join(admin, "gitdir"), `${join(child, ".git")}\n`);
  const entries: FileSystemSandboxEntry[] = [
    { path: { kind: "path", path: project }, access: "write" },
    { path: { kind: "path", path: metadata }, access: "write" },
    { path: { kind: "path", path: join(metadata, "config") }, access: "read" },
    { path: { kind: "path", path: join(metadata, "hooks") }, access: "read" },
    { path: { kind: "path", path: join(metadata, "private") }, access: "none" },
    { path: { kind: "path", path: join(project, "read-only-docs") }, access: "read" },
  ];
  const profile: PermissionProfile = { fileSystem: { kind: "restricted", entries }, network: "disabled" };
  const broker = new SandboxExecutionBroker({ mode: "workspace_write", cwd: project, permissionProfile: profile, sessionTempRoot: join(root, "temp") });
  const authority = () => broker.forkForCwd(child).executionAuthority().permissionProfile!;
  return { root, project, child, metadata, admin, broker, profile, authority };
}

function entryPaths(profile: PermissionProfile) {
  return profile.fileSystem.entries.map(entry => entry.path.kind === "path" ? entry.path.path : "");
}

describe("linked worktree metadata authority", () => {
  it("keeps existing common metadata writes and restrictions while rebasing workspace paths", () => {
    const f = fixture();
    const fork = f.authority();
    expect(entryPaths(fork)).toEqual([
      f.child, f.metadata, join(f.metadata, "config"), join(f.metadata, "hooks"),
      join(f.metadata, "private"), join(f.child, "read-only-docs"),
    ]);
    expect(resolveAccessWithCwd(fork.fileSystem, join(f.metadata, "index"), f.child, f.root)).toBe("write");
    expect(resolveAccessWithCwd(fork.fileSystem, join(f.metadata, "config"), f.child, f.root)).toBe("read");
    expect(resolveAccessWithCwd(fork.fileSystem, join(f.metadata, "private", "secret"), f.child, f.root)).toBe("none");
    expect(resolveAccessWithCwd(fork.fileSystem, join(f.root, "outside"), f.child, f.root)).toBe("none");
    expect(fork.network).toBe("disabled");
    expect(entryPaths(f.broker.executionAuthority().permissionProfile!)[0]).toBe(f.project);
  });

  it("does not invent a metadata grant when none was present", () => {
    const f = fixture();
    const broker = new SandboxExecutionBroker({ mode: "workspace_write", cwd: f.project, sessionTempRoot: f.root, permissionProfile: { fileSystem: { kind: "restricted", entries: [{ path: { kind: "path", path: f.project }, access: "write" }] }, network: "disabled" } });
    const fork = broker.forkForCwd(f.child).executionAuthority().permissionProfile!;
    expect(entryPaths(fork)).toEqual([f.child]);
    expect(resolveAccessWithCwd(fork.fileSystem, join(f.metadata, "config"), f.child, f.root)).toBe("none");
  });

  it.skipIf(process.platform === "win32")("preserves existing metadata authority through a symlinked workspace prefix", () => {
    const f = fixture(true);
    const fork = f.authority();
    expect(entryPaths(fork)).toContain(f.metadata);
    expect(entryPaths(fork)).not.toContain(join(f.child, ".git", "config"));
    expect(resolveAccessWithCwd(fork.fileSystem, join(f.metadata, "index"), f.child, f.root)).toBe("write");
    expect(resolveAccessWithCwd(fork.fileSystem, join(f.metadata, "config"), f.child, f.root)).toBe("read");
    expect(resolveAccessWithCwd(fork.fileSystem, join(f.metadata, "private", "secret"), f.child, f.root)).toBe("none");
    expect(resolveAccessWithCwd(fork.fileSystem, join(f.root, "outside"), f.child, f.root)).toBe("none");
  });

  for (const bad of ["malformed", "outside", "wrong-common", "wrong-backlink", "missing-admin", "oversized", "hardlink"] as const) {
    it.each(process.platform === "win32" ? [false] : [false, true])(`does not preserve common grants for a ${bad} pointer with aliased prefix %s`, (aliased) => {
      const f = fixture(aliased);
      switch (bad) {
        case "malformed": writeFileSync(join(f.child, ".git"), "not a gitdir\n"); break;
        case "outside": writeFileSync(join(f.child, ".git"), `gitdir: ${join(f.root, "foreign", "worker")}\n`); break;
        case "wrong-common": writeFileSync(join(f.admin, "commondir"), f.root); break;
        case "wrong-backlink": writeFileSync(join(f.admin, "gitdir"), join(f.metadata, "config")); break;
        case "missing-admin": rmSync(f.admin, { recursive: true }); break;
        case "oversized": writeFileSync(join(f.child, ".git"), "x".repeat(4097)); break;
        case "hardlink": linkSync(join(f.child, ".git"), join(f.root, "hardlink")); break;
      }
      const fork = f.authority();
      expect(entryPaths(fork)).not.toContain(f.metadata);
      expect(resolveAccessWithCwd(fork.fileSystem, join(f.metadata, "config"), f.child, f.root)).toBe("none");
      expect(resolveAccessWithCwd(fork.fileSystem, join(f.root, "foreign"), f.child, f.root)).toBe("none");
    });
  }

  it.skipIf(process.platform === "win32").each([false, true])("rejects symlinked git records and admin directories with aliased prefix %s", (aliased) => {
    for (const target of ["pointer", "admin", "commondir", "gitdir"]) {
      const f = fixture(aliased);
      if (target === "pointer") {
        const original = join(f.root, "pointer");
        writeFileSync(original, `gitdir: ${f.admin}\n`);
        rmSync(join(f.child, ".git"));
        symlinkSync(original, join(f.child, ".git"));
      } else if (target === "admin") {
        const alternate = join(f.metadata, "elsewhere");
        mkdirSync(alternate);
        writeFileSync(join(alternate, "commondir"), "..");
        writeFileSync(join(alternate, "gitdir"), join(f.child, ".git"));
        rmSync(f.admin, { recursive: true });
        symlinkSync(alternate, f.admin);
      } else {
        const original = join(f.root, `${target}-record`);
        writeFileSync(original, target === "commondir" ? f.metadata : join(f.child, ".git"));
        rmSync(join(f.admin, target));
        symlinkSync(original, join(f.admin, target));
      }
      const fork = f.authority();
      expect(entryPaths(fork)).not.toContain(f.metadata);
      expect(resolveAccessWithCwd(fork.fileSystem, join(f.metadata, "config"), f.child, f.root)).toBe("none");
    }
  });
});
