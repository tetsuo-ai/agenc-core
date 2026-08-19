import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  AGENC_LINUX_PROC_IDENTITY_MAX_BYTES,
  AgenCDaemonProcessScanIncompleteError,
  findLinuxAgenCDaemonProcesses,
  inspectLinuxAgenCDaemonProcess,
  isAgenCDaemonInstanceIdentity,
  isCanonicalAgenCDaemonEntrypointPath,
  readBoundedLinuxProcIdentityFile,
  readAgenCDarwinProcessStart,
  sameAgenCDaemonInstanceIdentity,
} from "./daemon-instance-identity.js";

describe("daemon instance identity", () => {
  it("fails closed when a proc identity file exceeds the fixed read budget", async () => {
    let remaining = AGENC_LINUX_PROC_IDENTITY_MAX_BYTES + 1;
    let closeCount = 0;
    const handle = {
      read: async (buffer: Uint8Array, offset: number, length: number) => {
        const bytesRead = Math.min(length, remaining);
        buffer.fill(0x61, offset, offset + bytesRead);
        remaining -= bytesRead;
        return { bytesRead };
      },
      close: async () => {
        closeCount += 1;
      },
    };

    await expect(
      readBoundedLinuxProcIdentityFile(
        "/proc/test/cmdline",
        async () => handle,
      ),
    ).rejects.toBeInstanceOf(AgenCDaemonProcessScanIncompleteError);
    expect(closeCount).toBe(1);
  });

  it("pins Darwin ps locale and cwd independently of the parent environment", async () => {
    const query = vi.fn(async () => "Wed Aug 19 13:00:01 2026\n");

    await expect(readAgenCDarwinProcessStart(4242, query)).resolves.toBe(
      "darwin-lstart-seconds:Wed Aug 19 13:00:01 2026",
    );
    expect(query).toHaveBeenCalledExactlyOnceWith(
      "/bin/ps",
      ["-o", "lstart=", "-p", "4242"],
      {
        cwd: "/",
        encoding: "utf8",
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
        maxBuffer: 4_096,
        timeout: 5_000,
      },
    );
  });

  it("requires and compares the complete identity tuple", () => {
    const identity = {
      pid: 4242,
      instanceId: "instance-a",
      processStart: "linux:boot:start",
      runtimeVersion: "1.2.3",
      commit: "abc123",
      buildTime: "2026-08-19T00:00:00.000Z",
    };
    expect(isAgenCDaemonInstanceIdentity(identity)).toBe(true);
    expect(sameAgenCDaemonInstanceIdentity(identity, { ...identity })).toBe(
      true,
    );
    expect(
      sameAgenCDaemonInstanceIdentity(identity, {
        ...identity,
        commit: "different",
      }),
    ).toBe(false);
  });

  it("recognizes only the canonical shipped runtime entrypoint layout", async () => {
    await expect(
      isCanonicalAgenCDaemonEntrypointPath(join(process.cwd(), "bin", "agenc")),
    ).resolves.toBe(true);

    const root = await mkdtemp(join(tmpdir(), "agenc-entrypoint-near-match-"));
    const entrypoint = join(root, "bin", "agenc");
    try {
      await mkdir(join(root, "bin"), { recursive: true });
      await writeFile(entrypoint, "setInterval(() => {}, 1_000);\n");
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "unrelated-package",
          bin: { agenc: "bin/agenc" },
        }),
      );
      await expect(
        isCanonicalAgenCDaemonEntrypointPath(entrypoint),
      ).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")(
    "fails closed when the bounded Linux process scan cannot be completed",
    async () => {
      await expect(
        findLinuxAgenCDaemonProcesses(
          {
            entrypointPath: join(process.cwd(), "bin", "agenc"),
            pid: process.pid,
            platform: "linux",
            isPidRunning: () => true,
          },
          join(tmpdir(), "agenc-scan-budget-home"),
          "any-install",
          { maxProcessEntries: 0 },
        ),
      ).rejects.toBeInstanceOf(AgenCDaemonProcessScanIncompleteError);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "ignores an unrelated process whose cwd identity cannot be proved",
    async () => {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1_000)", "unrelated-process"],
        { stdio: "ignore" },
      );
      const cwdError = Object.assign(new Error("injected unreadable cwd"), {
        code: "EACCES",
      });
      const readProcessCwdPath = vi.fn(async () => {
        throw cwdError;
      });

      try {
        await once(child, "spawn");
        await expect(
          findLinuxAgenCDaemonProcesses(
            {
              entrypointPath: join(process.cwd(), "bin", "agenc"),
              pid: process.pid,
              platform: "linux",
              isPidRunning: (pid) =>
                pid === child.pid && child.exitCode === null,
            },
            join(tmpdir(), "agenc-unrelated-daemon-home"),
            "any-install",
            { readProcessCwdPath },
          ),
        ).resolves.toEqual([]);
        expect(readProcessCwdPath).not.toHaveBeenCalled();
      } finally {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited.catch(() => {});
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "ignores a missing agenc path without the foreground daemon tail",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agenc-nondaemon-argv-"));
      const missingEntrypoint = join(root, "missing", "bin", "agenc");
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1_000)", missingEntrypoint, "status"],
        { stdio: "ignore" },
      );
      const readProcessCwdPath = vi.fn(async () => process.cwd());

      try {
        await once(child, "spawn");
        await expect(
          findLinuxAgenCDaemonProcesses(
            {
              entrypointPath: join(process.cwd(), "bin", "agenc"),
              pid: process.pid,
              platform: "linux",
              isPidRunning: (pid) =>
                pid === child.pid && child.exitCode === null,
            },
            join(root, "daemon-home"),
            "any-install",
            { readProcessCwdPath },
          ),
        ).resolves.toEqual([]);
        expect(readProcessCwdPath).not.toHaveBeenCalled();
      } finally {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited.catch(() => {});
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "fails closed for a missing agenc path with the foreground daemon tail",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agenc-daemon-argv-"));
      const missingEntrypoint = join(root, "missing", "bin", "agenc");
      const child = spawn(
        process.execPath,
        [
          "-e",
          "setInterval(() => {}, 1_000)",
          missingEntrypoint,
          "daemon",
          "start",
          "--foreground",
        ],
        { stdio: "ignore" },
      );
      const readProcessCwdPath = vi.fn(async () => process.cwd());

      try {
        await once(child, "spawn");
        await expect(
          findLinuxAgenCDaemonProcesses(
            {
              entrypointPath: join(process.cwd(), "bin", "agenc"),
              pid: process.pid,
              platform: "linux",
              isPidRunning: (pid) =>
                pid === child.pid && child.exitCode === null,
            },
            join(root, "daemon-home"),
            "any-install",
            { readProcessCwdPath },
          ),
        ).rejects.toBeInstanceOf(AgenCDaemonProcessScanIncompleteError);
        expect(readProcessCwdPath).toHaveBeenCalledExactlyOnceWith(
          `/proc/${child.pid}`,
        );
      } finally {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited.catch(() => {});
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "matches a relative daemon entrypoint and fails closed when its cwd proof fails",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agenc-candidate-cwd-"));
      const daemonHome = join(root, "daemon-home");
      const entrypoint = join(root, "daemon-entrypoint.js");
      await mkdir(daemonHome, { recursive: true });
      await writeFile(entrypoint, "setInterval(() => {}, 1_000);\n");
      const child = spawn(
        process.execPath,
        ["./daemon-entrypoint.js", "daemon", "start", "--foreground"],
        {
          cwd: root,
          env: { ...process.env, AGENC_HOME: daemonHome },
          stdio: "ignore",
        },
      );

      try {
        await once(child, "spawn");
        const host = {
          entrypointPath: entrypoint,
          pid: process.pid,
          platform: "linux" as const,
          isPidRunning: (pid: number) =>
            pid === child.pid && child.exitCode === null,
        };
        await expect(
          findLinuxAgenCDaemonProcesses(host, daemonHome, "exact"),
        ).resolves.toEqual([
          expect.objectContaining({
            pid: child.pid,
          }),
        ]);

        const cwdError = Object.assign(new Error("injected unreadable cwd"), {
          code: "EACCES",
        });
        const readProcessCwdPath = vi.fn(async () => {
          throw cwdError;
        });
        await expect(
          findLinuxAgenCDaemonProcesses(host, daemonHome, "exact", {
            readProcessCwdPath,
          }),
        ).rejects.toBeInstanceOf(AgenCDaemonProcessScanIncompleteError);
        expect(readProcessCwdPath).toHaveBeenCalledExactlyOnceWith(
          `/proc/${child.pid}`,
        );
      } finally {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited.catch(() => {});
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("streams proc entries only to the bounded sentinel and preserves close failure context", async () => {
    let nextPid = 100;
    const read = vi.fn(async () => ({
      name: String(nextPid++),
      isDirectory: () => true,
    }));
    const closeError = new Error("injected proc directory close failure");
    const close = vi.fn(async () => {
      throw closeError;
    });

    const error = await findLinuxAgenCDaemonProcesses(
      {
        entrypointPath: "/opt/agenc/bin/agenc",
        pid: 99,
        platform: "linux",
        isPidRunning: () => false,
      },
      "/tmp/agenc-test-home",
      "any-install",
      {
        maxProcessEntries: 1,
        openProcDirectory: async () => ({ read, close }),
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).cause).toBeInstanceOf(
      AgenCDaemonProcessScanIncompleteError,
    );
    expect((error as AggregateError).errors).toContain(closeError);
    expect(read).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform !== "linux")(
    "matches a symlinked daemon home by stable directory identity",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agenc-home-alias-"));
      const actualHome = join(root, "actual-home");
      const aliasHome = join(root, "alias-home");
      const entrypoint = join(root, "daemon-entrypoint.js");
      await mkdir(actualHome, { recursive: true });
      await symlink(actualHome, aliasHome, "dir");
      await writeFile(entrypoint, "setInterval(() => {}, 1_000);\n");
      const child = spawn(
        process.execPath,
        [entrypoint, "daemon", "start", "--foreground"],
        {
          env: { ...process.env, AGENC_HOME: aliasHome },
          stdio: "ignore",
        },
      );

      try {
        await once(child, "spawn");
        const host = {
          entrypointPath: entrypoint,
          pid: process.pid,
          platform: "linux" as const,
          isPidRunning: (pid: number) =>
            pid === child.pid && child.exitCode === null,
        };
        await expect(
          inspectLinuxAgenCDaemonProcess(child.pid!, host, actualHome, "exact"),
        ).resolves.toMatchObject({ pid: child.pid });
        await expect(
          inspectLinuxAgenCDaemonProcess(
            child.pid!,
            host,
            join(root, "missing-home"),
            "exact",
          ),
        ).rejects.toBeInstanceOf(AgenCDaemonProcessScanIncompleteError);
      } finally {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited.catch(() => {});
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "rejects a same-home daemon-shaped process with only a matching basename",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agenc-daemon-near-match-"));
      const daemonHome = join(root, "home");
      const entrypoint = join(root, "custom", "bin", "agenc");
      await mkdir(join(root, "custom", "bin"), { recursive: true });
      await mkdir(daemonHome, { recursive: true });
      await writeFile(entrypoint, "setInterval(() => {}, 1_000);\n");
      const child = spawn(
        process.execPath,
        [entrypoint, "daemon", "start", "--foreground"],
        {
          env: { ...process.env, AGENC_HOME: daemonHome },
          stdio: "ignore",
        },
      );

      try {
        await once(child, "spawn");
        await expect(
          inspectLinuxAgenCDaemonProcess(
            child.pid!,
            {
              entrypointPath: join(process.cwd(), "bin", "agenc"),
              pid: process.pid,
              platform: "linux",
              isPidRunning: (pid) =>
                pid === child.pid && child.exitCode === null,
            },
            daemonHome,
            "any-install",
          ),
        ).resolves.toBeNull();
      } finally {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited.catch(() => {});
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
