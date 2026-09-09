import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { desktopAuthorityRoot, protectDesktopAuthority } from "../../src/sandbox/desktop-authority-protection.js";
import { canWritePathWithCwd, getWritableRootsWithCwd } from "../../src/sandbox/engine/index.js";
import { effectivePermissionProfile } from "../../src/sandbox/engine/policy-transforms.js";
import { createSeatbeltCommandArgs } from "../../src/sandbox/engine/seatbelt.js";
import { createBwrapCommandArgs } from "../../src/sandbox/linux-launcher/bwrap.js";
import { planLandlockConfinement } from "../../src/sandbox/linux-launcher/landlock-exec.js";
import { parseLinuxSandboxLauncherArgs } from "../../src/sandbox/linux-launcher/cli.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { enforceRuntimeSandboxAttempt, permissionProfileForSandboxMode } from "../../src/tools/runtimes/sandboxing.js";

const roots: string[] = [];
function fixture() {
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "agenc-authority-policy-")));
  roots.push(workspace);
  const home = path.join(workspace, "nested", "custom-agent-state");
  const authority = path.join(home, "desktop-control-authorities");
  mkdirSync(authority, { recursive: true, mode: 0o700 });
  const temp = path.join(workspace, "tmp");
  mkdirSync(temp);
  const profile = protectDesktopAuthority(permissionProfileForSandboxMode("workspace_write", { cwd: workspace }), desktopAuthorityRoot(home));
  return { workspace, home, authority, temp, profile };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("native Desktop authority filesystem reservation", () => {
  it("reserves the exact custom home, independent of cwd depth and explicit grants", () => {
    const f = fixture();
    for (const cwd of [f.workspace, f.home, f.authority]) {
      const profile = effectivePermissionProfile(f.profile, { fileSystem: { entries: [
        { path: { kind: "path", path: f.authority }, access: "write" },
        { path: { kind: "path", path: path.join(f.authority, "fake.json") }, access: "write" },
        { path: { kind: "special", value: { kind: "root" } }, access: "write" },
      ] } });
      expect(canWritePathWithCwd(profile.fileSystem, path.join(f.authority, "fake.json"), cwd, f.temp)).toBe(false);
      expect(getWritableRootsWithCwd(profile.fileSystem, cwd, f.temp).some(root => root.root === f.authority)).toBe(false);
    }
    expect(canWritePathWithCwd(f.profile.fileSystem, path.join(f.home, "plans", "draft.md"), f.workspace, f.temp)).toBe(true);
  });

  it("follows target/home aliases but rejects a symlinked authority directory", () => {
    const f = fixture();
    const alias = path.join(f.workspace, "alias");
    symlinkSync(f.authority, alias);
    expect(canWritePathWithCwd(f.profile.fileSystem, path.join(alias, "fake.json"), f.workspace, f.temp)).toBe(false);
    const homeAlias = path.join(f.workspace, "home-alias");
    symlinkSync(f.home, homeAlias);
    expect(desktopAuthorityRoot(homeAlias)).toBe(f.authority);
    const otherHome = path.join(f.workspace, "other-home");
    mkdirSync(otherHome);
    symlinkSync(f.authority, path.join(otherHome, "desktop-control-authorities"));
    expect(() => desktopAuthorityRoot(otherHome)).toThrow(/symlink/);
  });

  it("hard-denies file-tool writes and ancestor replacement after explicit approval/grants", () => {
    const f = fixture();
    const context = {
      sandboxMode: "workspace_write", approvalResolved: true,
      additionalPermissions: { fileSystem: { entries: [{ path: { kind: "path", path: f.authority }, access: "write" }] } },
      invocation: { turn: { cwd: f.workspace }, session: { services: {
        configStore: { homeContext: { path: f.home } }, runtimeOptions: { sessionTempRoot: f.temp },
      } } },
    } as never;
    for (const target of [path.join(f.authority, "fake.json"), f.authority, f.home, path.dirname(f.home)]) {
      expect(() => enforceRuntimeSandboxAttempt({ context, tool: { name: "Write", metadata: { mutating: true } } as never, args: { file_path: target } })).toThrow(/reserved for the native host/);
    }
    expect(() => enforceRuntimeSandboxAttempt({ context, tool: { name: "Write", metadata: { mutating: true } } as never, args: { file_path: path.join(f.workspace, "normal.txt") } })).not.toThrow();
  });

  it("broker captures home from native environment, not process command env, and retains it across forks", () => {
    const f = fixture();
    const environment = { ...process.env, AGENC_HOME: f.home };
    const broker = new SandboxExecutionBroker({ mode: "workspace_write", cwd: f.workspace, env: environment, sessionTempRoot: f.temp,
      probe: () => ({ kind: "ready", mode: "workspace_write", platform: process.platform }),
    });
    environment.AGENC_HOME = path.join(f.workspace, "attacker-home");
    for (const active of [broker, broker.forkForCwd(f.authority)]) {
      const profile = active.runtimeSandbox("tool")!.permissionProfile;
      expect(profile.fileSystem.reservedReadOnlyPaths).toContain(f.authority);
      expect(canWritePathWithCwd(profile.fileSystem, path.join(f.authority, "forged.json"), active.cwd, f.temp)).toBe(false);
    }
  });

  it("projects macOS hard write and ancestor-rename denies", () => {
    const f = fixture();
    const args = createSeatbeltCommandArgs({ command: ["/bin/true"], fileSystemSandboxPolicy: f.profile.fileSystem,
      networkSandboxPolicy: "disabled", sandboxPolicyCwd: f.workspace, sessionTempRoot: f.temp, enforceManagedNetwork: false });
    expect(args[1]).toContain('(deny file-write* (subpath (param "RESERVED_READ_ONLY_0")))');
    expect(args[1]).toContain('(deny file-write-unlink (literal (param "RESERVED_ANCESTOR_1")))');
    expect(args).toContain(`-DRESERVED_ANCESTOR_1=${f.home}`);
  });

  it("projects Linux namespace anchors before readonly leaves and fails closed in Landlock", () => {
    const f = fixture();
    const command = createBwrapCommandArgs(["/bin/true"], f.profile.fileSystem, f.workspace, f.workspace,
      { mountProc: false, networkMode: "isolated", sessionTempRoot: f.temp });
    const joined = command.args.join("\n");
    expect(joined).toContain(`--bind\n${f.home}\n${f.home}`);
    expect(joined).toContain(`--ro-bind\n${f.authority}\n${f.authority}`);
    expect(joined.indexOf(`--bind\n${f.home}`)).toBeLessThan(joined.indexOf(`--ro-bind\n${f.authority}`));
    expect(planLandlockConfinement({ fileSystem: f.profile.fileSystem, sandboxPolicyCwd: f.workspace,
      sessionTempRoot: f.temp, allowNetworkForProxy: false, inheritedCwd: false })).toMatchObject({ kind: "refused", reason: expect.stringContaining("reserved Desktop authority") });
    const parsed = parseLinuxSandboxLauncherArgs(["--sandbox-policy-cwd", f.workspace, "--command-cwd", f.workspace,
      "--permission-profile", JSON.stringify(f.profile), "--session-temp-root", f.temp, "--", "/bin/true"]);
    expect(parsed.permissionProfile.fileSystem.reservedReadOnlyPaths).toEqual([f.authority]);
    expect(() => createBwrapCommandArgs(["/bin/true"], f.profile.fileSystem, f.workspace, f.workspace,
      { mountProc: false, networkMode: "isolated", sessionTempRoot: f.temp, extraWritableBindRoots: [f.home] })).toThrow(/extra writable bind overlaps/);
  });

  it("reserves missing trust directories without a racy create watcher", () => {
    const f = fixture();
    rmSync(f.authority, { recursive: true });
    const command = createBwrapCommandArgs(["/bin/true"], f.profile.fileSystem, f.workspace, f.workspace,
      { mountProc: false, networkMode: "isolated", sessionTempRoot: f.temp });
    expect(command.args.join("\n")).toContain(`--tmpfs\n${f.authority}\n--remount-ro\n${f.authority}`);
    expect(planLandlockConfinement({ fileSystem: f.profile.fileSystem, sandboxPolicyCwd: f.workspace,
      sessionTempRoot: f.temp, allowNetworkForProxy: false, inheritedCwd: false })).toMatchObject({ kind: "refused" });
  });

  if (process.platform === "darwin") it("blocks real macOS writes, symlink aliases and ancestor replacement with native seatbelt", () => {
    const f = fixture();
    const record = path.join(f.authority, "public.json");
    writeFileSync(record, "native-public-record");
    const alias = path.join(f.workspace, "alias");
    symlinkSync(f.authority, alias);
    for (const cwd of [f.workspace, f.home, f.authority]) {
      const profile = effectivePermissionProfile(f.profile, { fileSystem: { entries: [
        { path: { kind: "path", path: f.authority }, access: "write" },
        { path: { kind: "path", path: record }, access: "write" },
      ] } });
      const command = ["/bin/sh", "-c", [
        'printf forged > "$1"; echo "overwrite:$?"',
        'printf forged > "$2/new.json"; echo "create:$?"',
        '/bin/rm "$1"; echo "unlink:$?"',
        '/bin/ln "$1" "$6"; echo "hardlink:$?"',
        '/bin/mv "$3" "$3-moved"; echo "home-move:$?"',
        '/bin/mv "$4" "$4-moved"; echo "ancestor-move:$?"',
        'printf allowed > "$5"; echo "normal:$?"',
      ].join("\n"), "authority-probe", record, alias, f.home, path.dirname(f.home), path.join(f.workspace, "allowed.txt"), path.join(f.workspace, "hardlink.json")];
      const args = createSeatbeltCommandArgs({ command, fileSystemSandboxPolicy: profile.fileSystem,
        networkSandboxPolicy: "disabled", sandboxPolicyCwd: f.workspace, sessionTempRoot: f.temp, enforceManagedNetwork: false });
      const result = spawnSync("/usr/bin/sandbox-exec", args, { cwd, encoding: "utf8", timeout: 10_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/overwrite:[1-9]/);
      expect(result.stdout).toMatch(/create:[1-9]/);
      expect(result.stdout).toMatch(/unlink:[1-9]/);
      expect(result.stdout).toMatch(/hardlink:[1-9]/);
      expect(result.stdout).toMatch(/home-move:[1-9]/);
      expect(result.stdout).toMatch(/ancestor-move:[1-9]/);
      expect(result.stdout).toContain("normal:0");
      expect(readFileSync(record, "utf8")).toBe("native-public-record");
      expect(existsSync(path.join(f.authority, "new.json"))).toBe(false);
    }
  });
});
