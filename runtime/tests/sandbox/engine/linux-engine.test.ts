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
  findSystemBwrapInPath,
  isUserNamespaceFailure,
  procVersionIndicatesWsl1,
  systemBwrapWarning,
  systemBwrapWarningForPath,
} from "./bwrap.js";

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
      true,
    );

    expect(args.slice(0, 6)).toEqual([
      "--sandbox-policy-cwd",
      "/repo",
      "--command-cwd",
      "/work",
      "--permission-profile",
      JSON.stringify(profile),
    ]);
    expect(args).toContain("--use-legacy-landlock");
    expect(args).toContain("--allow-network-for-proxy");
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
        useLegacyLandlock: false,
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
      agencLinuxSandboxExe: "/opt/agenc-linux-sandbox",
      useLegacyLandlock: false,
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
      agencLinuxSandboxExe: "/opt/agenc-linux-sandbox",
      useLegacyLandlock: false,
      windowsSandboxLevel: "disabled",
      windowsSandboxPrivateDesktop: false,
      platform: "linux",
      isWsl1: true,
    });

    expect(act).toThrowError(
      expect.objectContaining({ code: "writable_linux_sandbox_launcher" }),
    );
  });

  it("detects WSL1 and user namespace failures from command output", () => {
    expect(procVersionIndicatesWsl1("Linux version 4.4.0 Microsoft")).toBe(true);
    expect(procVersionIndicatesWsl1("Linux version 5.15.90 microsoft-standard-WSL2")).toBe(false);
    expect(procVersionIndicatesWsl1("Linux version 5.15.0 WSL1")).toBe(true);
    expect(
      isUserNamespaceFailure({
        stderr: Buffer.from("No permissions to create a new namespace"),
      }),
    ).toBe(true);
  });

  it("suppresses system bubblewrap warnings outside Linux", () => {
    const profile: PermissionProfile = {
      fileSystem: restrictedFileSystemPolicy([
        { path: { kind: "path", path: "/repo" }, access: "write" },
      ]),
      network: "disabled",
    };

    expect(systemBwrapWarning(profile, "darwin")).toBeNull();
    expect(systemBwrapWarning(profile, "win32")).toBeNull();
    expect(systemBwrapWarningForPath(null, "darwin")).toBeNull();
  });

  it("finds trusted system bubblewrap while ignoring cwd-local candidates", () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-bwrap-path-"));
    const cwd = path.join(tmpdir, "workspace");
    const trusted = path.join(tmpdir, "trusted-bin");
    fs.mkdirSync(cwd);
    fs.mkdirSync(trusted);
    const localBwrap = path.join(cwd, "bwrap");
    const trustedBwrap = path.join(trusted, "bwrap");
    fs.writeFileSync(localBwrap, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(trustedBwrap, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const previousPath = process.env["PATH"];
    try {
      delete process.env["PATH"];
      expect(findSystemBwrapInPath(undefined, cwd)).toBeNull();
    } finally {
      if (previousPath === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = previousPath;
      }
    }
    expect(findSystemBwrapInPath("", cwd)).toBeNull();
    expect(findSystemBwrapInPath([cwd, trusted].join(path.delimiter), cwd)).toBe(
      fs.realpathSync(trustedBwrap),
    );
  });

  it("does not mark a relative TMPDIR as writable in fallback compatibility projection", () => {
    const previous = process.env["TMPDIR"];
    const permissions: PermissionProfile = {
      fileSystem: restrictedFileSystemPolicy([
        { path: { kind: "path", path: "/external-write" }, access: "write" },
      ]),
      network: "disabled",
    };
    const runtimePolicy = restrictedFileSystemPolicy([
      { path: { kind: "special", value: { kind: "project_roots" } }, access: "write" },
      { path: { kind: "special", value: { kind: "tmpdir" } }, access: "write" },
    ]);
    try {
      process.env["TMPDIR"] = "relative-tmp";
      expect(
        compatibilitySandboxPolicyForPermissionProfile(
          permissions,
          runtimePolicy,
          "disabled",
          "/repo",
        ),
      ).toMatchObject({ exclude_tmpdir_env_var: true });

      process.env["TMPDIR"] = "/tmp/agenc-compat";
      expect(
        compatibilitySandboxPolicyForPermissionProfile(
          permissions,
          runtimePolicy,
          "disabled",
          "/repo",
        ),
      ).toMatchObject({ exclude_tmpdir_env_var: false });
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
