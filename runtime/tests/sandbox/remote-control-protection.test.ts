import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { remoteControlAuthorityPaths, protectRemoteControlAuthority } from "../../src/sandbox/remote-control-protection.js";
import { canWritePathWithCwd } from "../../src/sandbox/engine/policy.js";
import { classifyShellWorkspaceWritePolicy } from "../../src/llm/shell-write-policy.js";
import { checkProtectedPathSafety } from "../../src/permissions/protected-paths.js";
import { ConfigStore } from "../../src/config/store.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { effectivePermissionProfile } from "../../src/sandbox/engine/policy-transforms.js";
import { enforceRuntimeSandboxAttempt, permissionProfileForSandboxMode } from "../../src/tools/runtimes/sandboxing.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remote-protect-")); roots.push(root);
  const home = join(root, "custom-home"), managed = join(root, "managed"), temp = join(root, "temp");
  for (const p of [home, managed, temp]) mkdirSync(p);
  writeFileSync(join(home, "config.toml"), "config_version = 2\n");
  return { root, home, managed, temp, paths: remoteControlAuthorityPaths(home, managed) };
}

it.each(["read_only", "workspace_write", "danger_full_access", "external_sandbox"] as const)("protects owner writes in %s after explicit approval and grants", mode => {
  const f = fixture();
  const alias = join(f.root, "alias.toml"); symlinkSync(join(f.home, "config.toml"), alias);
  const context = { sandboxMode: mode, approvalResolved: true, invocation: { turn: { cwd: f.root }, session: { services: { configStore: { homeContext: { path: f.home }, managedPaths: { root: f.managed } }, runtimeOptions: { sessionTempRoot: f.temp } } } } } as never;
  for (const target of [...f.paths, join(f.managed, "config.d", "99-enable.toml"), alias, f.home, f.managed]) {
    expect(() => enforceRuntimeSandboxAttempt({ context, tool: { name: "Write", metadata: { mutating: true } } as never, args: { file_path: target } })).toThrow(/owner-only/);
  }
});

it("preserves kernel reservations against additional grants and symlink aliases", () => {
  const f = fixture();
  const profile = effectivePermissionProfile(protectRemoteControlAuthority(permissionProfileForSandboxMode("workspace_write", { cwd: f.root }), f.paths), { fileSystem: { entries: [{ path: { kind: "special", value: { kind: "root" } }, access: "write" }] } });
  for (const target of [...f.paths, join(f.managed, "config.d", "new.toml")]) expect(canWritePathWithCwd(profile.fileSystem, target, f.root, f.temp)).toBe(false);
  expect(canWritePathWithCwd(profile.fileSystem, join(f.root, "ordinary.txt"), f.root, f.temp)).toBe(true);
});

it("does not let bypass shell consent or classifiers authorize owner configuration", () => {
  const f = fixture();
  const store = new ConfigStore({ home: f.home, managedConfigPath: join(f.managed, "config.toml") });
  runWithCanonicalSettingsAuthority(store as never, () => {
    for (const target of [join(f.home, "config.toml"), join(f.managed, "config.d", "enable.toml")]) {
      expect(checkProtectedPathSafety(target, [target])).toMatchObject({ safe: false, classifierApprovable: false });
      const result = classifyShellWorkspaceWritePolicy({ toolName: "exec_command", args: { command: `echo enabled=true > ${target}` }, workspaceRoot: f.root, protectedRoots: f.paths, allowWorkspaceWrites: true, allowWorkspaceDeletions: true, bypassesApprovalsAndSandbox: true });
      expect(result.blocked).toBe(true);
    }
  });
});

it("protects the destination when the owner config itself is a dotfile symlink", () => {
  const f = fixture();
  const destination = join(f.root, "dotfiles", "owner.toml");
  mkdirSync(join(f.root, "dotfiles"));
  rmSync(join(f.home, "config.toml"));
  symlinkSync(destination, join(f.home, "config.toml"));
  // Cover both a dangling destination an agent might create and an existing
  // destination it might edit, rather than just aliases into a regular file.
  for (const exists of [false, true]) {
    if (exists) writeFileSync(destination, "config_version = 2\n");
    const paths = remoteControlAuthorityPaths(f.home, f.managed);
    expect(paths).toContain(destination);
    const profile = protectRemoteControlAuthority(permissionProfileForSandboxMode("workspace_write", { cwd: f.root }), paths);
    expect(canWritePathWithCwd(profile.fileSystem, destination, f.root, f.temp)).toBe(false);
  }
});
