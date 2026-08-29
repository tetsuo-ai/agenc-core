import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  SandboxManager,
  SandboxTransformError,
  compatibilitySandboxPolicyForPermissionProfile,
  createLinuxSandboxCommandArgsForPermissionProfile,
  restrictedFileSystemPolicy,
  unrestrictedFileSystemPolicy,
  type PermissionProfile,
} from "./index.js";
import {
  procVersionIndicatesWsl1,
} from "./bwrap.js";
import { resolveAgentRuntimeOptions } from "../../../src/session/runtime-options.js";

const TEST_SESSION_TEMP_ROOT = "/tmp/agenc-linux-engine-session-root";

describe("Linux sandbox engine", () => {
  it("serializes permission profiles for the Linux launcher handoff", () => {
    const profile: PermissionProfile = {
      fileSystem: restrictedFileSystemPolicy([
        { path: { kind: "path", path: "/work" }, access: "write" },
      ]),
      network: "restricted",
    };

    const args = createLinuxSandboxCommandArgsForPermissionProfile(
      ["/bin/echo", "ok"],
      "/work",
      profile,
      "/repo",
      true,
      "/session-temp",
      false,
    );

    expect(args.slice(0, 6)).toEqual([
      "--sandbox-policy-cwd",
      "/repo",
      "--command-cwd",
      "/work",
      "--permission-profile",
      JSON.stringify(profile),
    ]);
    expect(args).toContain("--allow-network-for-proxy");
    expect(args).toContain("--session-temp-root");
    expect(args).toContain("/session-temp");
    expect(args.slice(args.indexOf("--"))).toEqual(["--", "/bin/echo", "ok"]);
  });

  it("selects a platform sandbox only when policy requirements demand one", () => {
    const manager = new SandboxManager();
    const restricted = restrictedFileSystemPolicy([
      { path: { kind: "path", path: "/repo" }, access: "write" },
    ]);

    expect(
      manager.selectInitial({
        fileSystemPolicy: restricted,
        networkPolicy: "enabled",
        preference: "auto",
        windowsSandboxLevel: "disabled",
        hasManagedNetworkRequirements: false,
        platform: "linux",
      }),
    ).toBe("linux_seccomp");
    expect(
      manager.selectInitial({
        fileSystemPolicy: unrestrictedFileSystemPolicy(),
        networkPolicy: "enabled",
        preference: "auto",
        windowsSandboxLevel: "disabled",
        hasManagedNetworkRequirements: false,
        platform: "linux",
      }),
    ).toBe("none");
    expect(
      manager.selectInitial({
        fileSystemPolicy: restricted,
        networkPolicy: "disabled",
        preference: "forbid",
        windowsSandboxLevel: "disabled",
        hasManagedNetworkRequirements: true,
        platform: "linux",
      }),
    ).toBe("none");
  });

  it("fails closed for the unimplemented Windows sandbox transform", () => {
    const manager = new SandboxManager();
    const act = () =>
      manager.transform({
        command: {
          program: "cmd.exe",
          args: ["/c", "echo ok"],
          cwd: "C:\\repo",
          env: {},
        },
        permissions: {
          fileSystem: restrictedFileSystemPolicy([
            { path: { kind: "path", path: "C:\\repo" }, access: "write" },
          ]),
          network: "disabled",
        },
        sandbox: "windows_restricted_token",
        enforceManagedNetwork: false,
        sandboxPolicyCwd: "C:\\repo",
        sessionTempRoot: "C:\\Temp",
        windowsSandboxLevel: "low",
        windowsSandboxPrivateDesktop: false,
        platform: "win32",
      });

    expect(act).toThrow(SandboxTransformError);
    expect(act).toThrow(/refusing to run unsandboxed/);
  });

  it("wraps Linux commands with effective additional permissions", () => {
    const manager = new SandboxManager();
    const result = manager.transform({
      command: {
        program: "/bin/echo",
        args: ["ok"],
        cwd: "/repo",
        env: {
          PATH: "/repo/fake-bin:/usr/bin",
          NODE_OPTIONS: "--require=/repo/preload.cjs",
          NODE_PATH: "/repo/node-modules",
          LD_PRELOAD: "/repo/inject.so",
          DYLD_INSERT_LIBRARIES: "/repo/inject.dylib",
        },
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: {
            entries: [
              { path: { kind: "path", path: "/tmp/agenc-extra" }, access: "read" },
            ],
          },
        },
      },
      permissions: {
        fileSystem: restrictedFileSystemPolicy([
          { path: { kind: "path", path: "/repo" }, access: "write" },
        ]),
        network: "restricted",
      },
      sandbox: "linux_seccomp",
      enforceManagedNetwork: true,
      network: { env: { HTTP_PROXY: "http://127.0.0.1:8080" } },
      sandboxPolicyCwd: "/repo",
      sessionTempRoot: "/session-temp",
      agencLinuxSandboxExe: "/opt/agenc-linux-sandbox",
      windowsSandboxLevel: "disabled",
      windowsSandboxPrivateDesktop: false,
      platform: "linux",
    });

    expect(result.command.slice(0, 2)).toEqual([
      fs.realpathSync(process.execPath),
      "/opt/agenc-linux-sandbox",
    ]);
    expect(result.arg0).toBe(path.basename(fs.realpathSync(process.execPath)));
    expect(result.env.PATH).toBe("/repo/fake-bin:/usr/bin");
    expect(result.env).not.toHaveProperty("NODE_OPTIONS");
    expect(result.env).not.toHaveProperty("NODE_PATH");
    expect(result.env).not.toHaveProperty("LD_PRELOAD");
    expect(result.env).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
    expect(result.command).toContain("--allow-network-for-proxy");
    const profileIndex = result.command.indexOf("--permission-profile");
    const serialized = result.command[profileIndex + 1];
    expect(JSON.parse(serialized ?? "{}")).toMatchObject({
      network: "enabled",
      fileSystem: {
        kind: "restricted",
        entries: [
          { path: { kind: "path", path: "/repo" }, access: "write" },
          { path: { kind: "path", path: "/tmp/agenc-extra" }, access: "read" },
        ],
      },
    });
  });

  it("serializes descriptor-bound cwd explicitly and narrows it to read-only filesystem authority", () => {
    const manager = new SandboxManager();
    const result = manager.transform({
      command: {
        program: "/bin/echo",
        args: ["ok"],
        cwd: ".",
        cwdBinding: "inherited_readonly",
        env: { PATH: "/usr/bin" },
      },
      permissions: {
        fileSystem: restrictedFileSystemPolicy([
          {
            path: { kind: "special", value: { kind: "root" } },
            access: "read",
          },
          {
            path: { kind: "special", value: { kind: "project_roots" } },
            access: "write",
          },
        ]),
        network: "disabled",
      },
      sandbox: "linux_seccomp",
      enforceManagedNetwork: false,
      sandboxPolicyCwd: "/repo",
      sessionTempRoot: "/session-temp",
      agencLinuxSandboxExe: "/opt/agenc-linux-sandbox",
      windowsSandboxLevel: "disabled",
      windowsSandboxPrivateDesktop: false,
      platform: "linux",
      isWsl1: false,
    });

    expect(result.command).toContain("--inherited-readonly-command-cwd");
    expect(result.command).not.toContain("--command-cwd");
    expect(result.command).not.toContain("/repo");
    expect(result.command).not.toContain("--sandbox-policy-cwd");
    const profileIndex = result.command.indexOf("--permission-profile");
    const serialized = JSON.parse(result.command[profileIndex + 1] ?? "{}");
    expect(serialized.fileSystem.entries).toEqual([
      {
        path: { kind: "special", value: { kind: "root" } },
        access: "read",
      },
    ]);
    expect(serialized.fileSystem.entries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ access: "write" })]),
    );
    expect(result.permissionProfile).toEqual(serialized);
    expect(result.fileSystemSandboxPolicy).toEqual(serialized.fileSystem);
  });

  it("rejects inherited cwd binding unless cwd is exactly dot", () => {
    const manager = new SandboxManager();
    expect(() =>
      manager.transform({
        command: {
          program: "/bin/echo",
          args: ["ok"],
          cwd: "/repo",
          cwdBinding: "inherited_readonly",
          env: { PATH: "/usr/bin" },
        },
        permissions: {
          fileSystem: restrictedFileSystemPolicy([
            {
              path: { kind: "special", value: { kind: "root" } },
              access: "read",
            },
          ]),
          network: "disabled",
        },
        sandbox: "linux_seccomp",
        enforceManagedNetwork: false,
        sandboxPolicyCwd: "/repo",
        sessionTempRoot: "/session-temp",
        agencLinuxSandboxExe: "/opt/agenc-linux-sandbox",
        windowsSandboxLevel: "disabled",
        windowsSandboxPrivateDesktop: false,
        platform: "linux",
        isWsl1: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_inherited_cwd" }));
  });

  it("rejects a Linux launcher writable by a nominally restricted profile", () => {
    const manager = new SandboxManager();
    const act = () => manager.transform({
      command: {
        program: "/bin/echo",
        args: ["ok"],
        cwd: "/repo",
        env: { PATH: "/usr/bin" },
      },
      permissions: {
        fileSystem: restrictedFileSystemPolicy([
          { path: { kind: "special", value: { kind: "root" } }, access: "write" },
        ]),
        network: "disabled",
      },
      sandbox: "linux_seccomp",
      enforceManagedNetwork: false,
      sandboxPolicyCwd: "/repo",
      sessionTempRoot: "/session-temp",
      agencLinuxSandboxExe: "/opt/agenc-linux-sandbox",
      windowsSandboxLevel: "disabled",
      windowsSandboxPrivateDesktop: false,
      platform: "linux",
      isWsl1: true,
    });

    expect(act).toThrowError(
      expect.objectContaining({ code: "writable_linux_sandbox_launcher" }),
    );
  });

  it("detects WSL1 from kernel version strings", () => {
    expect(procVersionIndicatesWsl1("Linux version 4.4.0 Microsoft")).toBe(true);
    expect(procVersionIndicatesWsl1("Linux version 5.15.90 microsoft-standard-WSL2")).toBe(false);
    expect(procVersionIndicatesWsl1("Linux version 5.15.0 WSL1")).toBe(true);
  });

  it("uses canonical AGENC_TMPDIR authority for compatibility projection and ignores TMPDIR", () => {
    const previous = process.env["TMPDIR"];
    const permissions: PermissionProfile = {
      fileSystem: restrictedFileSystemPolicy([
        { path: { kind: "path", path: "/external-write" }, access: "write" },
      ]),
      network: "disabled",
    };
    const canonical = resolveAgentRuntimeOptions({
      AGENC_TMPDIR: "/tmp/agenc-compat-session",
      TMPDIR: "/tmp/generic-must-not-win",
    }).sessionTempRoot;
    if (canonical === undefined) {
      throw new Error("expected canonical session temp root");
    }
    const runtimePolicy = restrictedFileSystemPolicy([
      { path: { kind: "special", value: { kind: "project_roots" } }, access: "write" },
      { path: { kind: "path", path: canonical }, access: "write" },
    ]);
    try {
      process.env["TMPDIR"] = "/tmp/generic-must-not-win";
      expect(
        compatibilitySandboxPolicyForPermissionProfile(
          permissions,
          runtimePolicy,
          "disabled",
          "/repo",
          canonical,
        ),
      ).toMatchObject({ exclude_tmpdir_env_var: false });

      expect(
        compatibilitySandboxPolicyForPermissionProfile(
          permissions,
          runtimePolicy,
          "disabled",
          "/repo",
          "/tmp/agenc-other-session",
        ),
      ).toMatchObject({ exclude_tmpdir_env_var: true });
    } finally {
      if (previous === undefined) {
        delete process.env["TMPDIR"];
      } else {
        process.env["TMPDIR"] = previous;
      }
    }
  });

  it("runs a generated Linux launcher argv through a real helper subprocess", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-sandbox-engine-"));
    const helper = path.join(tmpdir, "agenc-linux-sandbox-helper.js");
    fs.writeFileSync(
      helper,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({",
        "  argv: process.argv.slice(2),",
        "  cwd: process.cwd(),",
        "  marker: process.env.AGENC_SANDBOX_TEST_MARKER,",
        "}));",
      ].join("\n"),
      { mode: 0o755 },
    );

    const profile: PermissionProfile = {
      fileSystem: restrictedFileSystemPolicy([
        { path: { kind: "path", path: tmpdir }, access: "write" },
      ]),
      network: "disabled",
    };
    const args = createLinuxSandboxCommandArgsForPermissionProfile(
      ["/bin/echo", "ok"],
      tmpdir,
      profile,
      tmpdir,
      false,
      tmpdir,
      false,
    );
    const child = spawn(helper, args, {
      cwd: tmpdir,
      env: { ...process.env, AGENC_SANDBOX_TEST_MARKER: "spawned" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output = await collectChildProcessOutput(child);
    const parsed = JSON.parse(output.stdout);
    expect(output.code).toBe(0);
    expect(parsed.cwd).toBe(tmpdir);
    expect(parsed.marker).toBe("spawned");
    expect(parsed.argv).toEqual(args);
  });

  it("projects permission profiles to compatibility sandbox policies", () => {
    expect(
      compatibilitySandboxPolicyForPermissionProfile(
        {
          fileSystem: unrestrictedFileSystemPolicy(),
          network: "enabled",
        },
        unrestrictedFileSystemPolicy(),
        "enabled",
        "/repo",
        TEST_SESSION_TEMP_ROOT,
      ),
    ).toEqual({ kind: "danger_full_access" });
    expect(
      compatibilitySandboxPolicyForPermissionProfile(
        {
          fileSystem: restrictedFileSystemPolicy([
            { path: { kind: "special", value: { kind: "root" } }, access: "read" },
          ]),
          network: "disabled",
        },
        restrictedFileSystemPolicy([]),
        "disabled",
        "/repo",
        TEST_SESSION_TEMP_ROOT,
      ),
    ).toMatchObject({ kind: "read_only" });
    expect(
      compatibilitySandboxPolicyForPermissionProfile(
        {
          fileSystem: restrictedFileSystemPolicy([
            { path: { kind: "special", value: { kind: "project_roots" } }, access: "write" },
          ]),
          network: "restricted",
        },
        restrictedFileSystemPolicy([]),
        "restricted",
        "/repo",
        TEST_SESSION_TEMP_ROOT,
      ),
    ).toMatchObject({ kind: "workspace_write" });
    const narrowedFileSystem = restrictedFileSystemPolicy([
      { path: { kind: "special", value: { kind: "project_roots" } }, access: "write" },
      { path: { kind: "path", path: "/repo/blocked" }, access: "read" },
    ]);
    const narrowed = compatibilitySandboxPolicyForPermissionProfile(
      {
        fileSystem: narrowedFileSystem,
        network: "disabled",
      },
      narrowedFileSystem,
      "disabled",
      "/repo",
      TEST_SESSION_TEMP_ROOT,
    );
    expect(narrowed).toMatchObject({ kind: "workspace_write" });
    if (narrowed.kind !== "workspace_write") {
      throw new Error("expected workspace-write compatibility projection");
    }
    expect(narrowed.writable_roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          root: "/repo",
          read_only_subpaths: expect.arrayContaining(["/repo/blocked"]),
        }),
      ]),
    );
  });
});

function collectChildProcessOutput(child: ReturnType<typeof spawn>): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
