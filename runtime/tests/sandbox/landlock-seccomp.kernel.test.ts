import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  landlockLaunchArgs,
  probeLandlock,
  resolveLandlockRun,
} from "../../src/sandbox/landlock-run.js";
import {
  restrictedFileSystemPolicy,
  type PermissionProfile,
} from "../../src/sandbox/engine/index.js";
import { createNetworkSeccompProgram } from "../../src/sandbox/linux-launcher/landlock.js";
import { runLinuxSandboxMain } from "../../src/sandbox/linux-launcher/linux-run-main.js";
import { preferredBubblewrapLauncher } from "../../src/sandbox/linux-launcher/launcher.js";

const PYTHON = "/usr/bin/python3";
const work: string[] = [];

afterAll(() => {
  for (const dir of work) fs.rmSync(dir, { recursive: true, force: true });
});

function withTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  work.push(dir);
  return dir;
}

function hasTrustedCompiler(): boolean {
  return ["/usr/bin/cc", "/bin/cc"].some((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function effectiveCapabilities(): bigint {
  const status = fs.readFileSync("/proc/self/status", "utf8");
  const value = /^CapEff:\s*([0-9a-f]+)$/imu.exec(status)?.[1];
  if (value === undefined) {
    throw new Error("/proc/self/status did not report CapEff");
  }
  return BigInt(`0x${value}`);
}

function assertKernelLaneCapabilities(): void {
  expect(process.platform).toBe("linux");
  expect(typeof process.getuid).toBe("function");
  expect(process.getuid!()).toBeGreaterThan(0);
  expect(effectiveCapabilities()).toBe(0n);
  expect(process.env.AGENC_TEST_OS_BOUNDARY).toBeUndefined();
  expect(hasTrustedCompiler()).toBe(true);
  expect(fs.existsSync(PYTHON)).toBe(true);

  const launcher = resolveLandlockRun();
  expect(launcher).toBeDefined();
  if (launcher === undefined) {
    throw new Error("the Landlock launcher is unavailable");
  }
  expect(probeLandlock(launcher)).toBe("full");
}

function runWithSeccomp(program: Buffer, command: readonly string[]) {
  const launcher = resolveLandlockRun();
  expect(launcher).toBeDefined();
  if (launcher === undefined) {
    throw new Error("the Landlock launcher is unavailable");
  }

  const dir = withTempDir("landlock-seccomp-kernel-");
  const programPath = path.join(dir, "network.bpf");
  fs.writeFileSync(programPath, program);
  const programFd = fs.openSync(programPath, "r");
  try {
    return spawnSync(
      launcher,
      [...landlockLaunchArgs({ readOnly: ["/"], seccompFd: 3 }), ...command],
      {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe", programFd],
      },
    );
  } finally {
    fs.closeSync(programFd);
  }
}

function workspaceWriteProfile(workspace: string): PermissionProfile {
  return {
    fileSystem: restrictedFileSystemPolicy(
      [
        { path: { kind: "special", value: { kind: "root" } }, access: "read" },
        { path: { kind: "path", path: workspace }, access: "write" },
      ],
      { includePlatformDefaults: true },
    ),
    network: "disabled",
  };
}

function readOnlyProfile(): PermissionProfile {
  return {
    fileSystem: restrictedFileSystemPolicy(
      [
        {
          path: { kind: "special", value: { kind: "root" } },
          access: "read",
        },
      ],
      { includePlatformDefaults: true },
    ),
    network: "disabled",
  };
}

async function runFallback(
  profile: PermissionProfile,
  workspace: string,
  command: readonly string[],
): Promise<{ exitCode: number; stderr: string[] }> {
  const stderr: string[] = [];
  const exitCode = await runLinuxSandboxMain(
    [
      "--sandbox-policy-cwd",
      workspace,
      "--command-cwd",
      workspace,
      "--permission-profile",
      JSON.stringify(profile),
      "--",
      ...command,
    ],
    {
      preferredLauncher: () => null,
      onStderr: (line) => stderr.push(line),
    },
  );
  return { exitCode, stderr };
}

async function runInheritedFallback(
  profile: PermissionProfile,
  command: readonly string[],
): Promise<{ exitCode: number; stderr: string[] }> {
  const stderr: string[] = [];
  const exitCode = await runLinuxSandboxMain(
    [
      "--inherited-readonly-command-cwd",
      "--permission-profile",
      JSON.stringify(profile),
      "--no-proc",
      "--",
      ...command,
    ],
    {
      preferredLauncher: () => null,
      onStderr: (line) => stderr.push(line),
    },
  );
  return { exitCode, stderr };
}

describe("Landlock and seccomp on the native kernel", () => {
  const SOCKET_PROBE = [
    PYTHON,
    "-c",
    "import socket\n" +
      "try:\n" +
      "  socket.socket(socket.AF_INET)\n" +
      "  print('inet-open')\n" +
      "except PermissionError:\n" +
      "  print('inet-denied')\n" +
      "socket.socket(socket.AF_UNIX)\n" +
      "print('unix-open')",
  ] as const;

  it("the same BPF program AgenC hands bwrap denies AF_INET and keeps AF_UNIX", () => {
    assertKernelLaneCapabilities();
    const program = createNetworkSeccompProgram("restricted");
    const run = runWithSeccomp(program, [...SOCKET_PROBE]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("inet-denied");
    expect(run.stdout).toContain("unix-open");
  });

  it("filesystem and network confinement hold in one run", () => {
    assertKernelLaneCapabilities();
    const program = createNetworkSeccompProgram("restricted");
    const dir = withTempDir("landlock-seccomp-combined-");
    const target = path.join(dir, "combined.txt");
    const run = runWithSeccomp(program, [
      "/bin/sh",
      "-c",
      `if echo x > ${target} 2>/dev/null; then echo write-open; else echo write-denied; fi; ` +
        `${PYTHON} -c "import socket\ntry:\n  socket.socket(socket.AF_INET)\n  print('inet-open')\nexcept PermissionError:\n  print('inet-denied')"`,
    ]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("write-denied");
    expect(run.stdout).toContain("inet-denied");
  });

  it("runs a descriptor-bound read in a git workspace with writes and network removed", async () => {
    assertKernelLaneCapabilities();
    const root = withTempDir("agenc-landlock-bound-read-");
    const workspace = path.join(root, "workspace");
    const unexpectedWrite = path.join(workspace, "unexpected.txt");
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(workspace, ".git"));
    fs.writeFileSync(path.join(workspace, "sentinel.txt"), "bound-read\n");
    const savedCwd = process.cwd();
    process.chdir(workspace);
    try {
      const read = await runInheritedFallback(readOnlyProfile(), [
        "/bin/sh",
        "-c",
        'test "$(cat sentinel.txt)" = bound-read',
      ]);
      expect(read).toEqual({ exitCode: 0, stderr: [] });

      const write = await runInheritedFallback(readOnlyProfile(), [
        "/bin/sh",
        "-c",
        `printf unexpected > ${unexpectedWrite}`,
      ]);
      expect(write.exitCode).not.toBe(0);
      expect(fs.existsSync(unexpectedWrite)).toBe(false);

      const network = await runInheritedFallback(readOnlyProfile(), [
        PYTHON,
        "-c",
        "import socket, sys\n" +
          "try:\n" +
          "  socket.socket(socket.AF_INET)\n" +
          "except PermissionError:\n" +
          "  sys.exit(0)\n" +
          "sys.exit(9)",
      ]);
      expect(network.exitCode).toBe(0);
    } finally {
      process.chdir(savedCwd);
    }
  });

  it("uses Landlock when installed bubblewrap cannot create namespaces", async () => {
    assertKernelLaneCapabilities();
    const root = withTempDir("agenc-landlock-bwrap-denied-");
    const workspace = path.join(root, "workspace");
    const trusted = path.join(root, "trusted-bin");
    fs.mkdirSync(workspace);
    fs.mkdirSync(trusted);
    const fakeBwrap = path.join(trusted, "bwrap");
    fs.writeFileSync(
      fakeBwrap,
      [
        "#!/bin/sh",
        'if [ "$1" = "--help" ]; then',
        "  echo '--argv0 --ro-bind-fd'",
        "  exit 0",
        "fi",
        "echo 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' >&2",
        "exit 1",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    const capture = path.join(workspace, "result.txt");
    const stderr: string[] = [];

    const exitCode = await runLinuxSandboxMain(
      [
        "--sandbox-policy-cwd",
        workspace,
        "--command-cwd",
        workspace,
        "--permission-profile",
        JSON.stringify(workspaceWriteProfile(workspace)),
        "--",
        "/bin/sh",
        "-c",
        `printf fallback-ok > ${capture}`,
      ],
      {
        preferredLauncher: (options = {}) =>
          preferredBubblewrapLauncher({
            ...options,
            searchPath: trusted,
            trustedDirectories: [trusted],
          }),
        onStderr: (line) => stderr.push(line),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(fs.readFileSync(capture, "utf8")).toBe("fallback-ok");
  });

  it("confines writes to the workspace when bubblewrap is unavailable", async () => {
    assertKernelLaneCapabilities();
    const workspace = withTempDir("agenc-landlock-fallback-ws-");
    const outside = withTempDir("agenc-landlock-fallback-out-");
    const inside = path.join(workspace, "made.txt");
    const escaped = path.join(outside, "escaped.txt");

    const ok = await runFallback(workspaceWriteProfile(workspace), workspace, [
      "/bin/sh",
      "-c",
      `echo confined > ${inside}`,
    ]);
    expect(ok.exitCode).toBe(0);
    expect(fs.readFileSync(inside, "utf8")).toBe("confined\n");

    const denied = await runFallback(
      workspaceWriteProfile(workspace),
      workspace,
      ["/bin/sh", "-c", `echo escaped > ${escaped}`],
    );
    expect(denied.exitCode).not.toBe(0);
    expect(fs.existsSync(escaped)).toBe(false);
  });

  it("keeps /proc unreadable, closing the same-uid environ channel", async () => {
    assertKernelLaneCapabilities();
    const workspace = withTempDir("agenc-landlock-fallback-proc-");
    const capture = path.join(workspace, "proc.txt");
    const denied = await runFallback(
      workspaceWriteProfile(workspace),
      workspace,
      ["/bin/sh", "-c", `cat /proc/self/status > ${capture}`],
    );
    expect(denied.exitCode).not.toBe(0);
    expect(fs.readFileSync(capture, "utf8")).toBe("");
  });

  it("applies the network seccomp program when the policy disables network", async () => {
    assertKernelLaneCapabilities();
    const workspace = withTempDir("agenc-landlock-fallback-net-");
    const verdict = path.join(workspace, "net.txt");
    const probe = await runFallback(
      workspaceWriteProfile(workspace),
      workspace,
      [
        PYTHON,
        "-c",
        "import socket\n" +
          "out = open(" +
          JSON.stringify(verdict) +
          ", 'w')\n" +
          "try:\n" +
          "  socket.socket(socket.AF_INET)\n" +
          "  out.write('inet-open')\n" +
          "except PermissionError:\n" +
          "  out.write('inet-denied')\n" +
          "out.close()",
      ],
    );
    expect(probe.exitCode).toBe(0);
    expect(fs.readFileSync(verdict, "utf8")).toBe("inet-denied");
  });
});
