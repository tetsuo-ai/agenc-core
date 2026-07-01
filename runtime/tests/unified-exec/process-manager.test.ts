import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";

import {
  permissionProfileFromRuntimePermissions,
  restrictedFileSystemPolicy,
  unrestrictedFileSystemPolicy,
  type SandboxExecRequest,
  type SandboxManager,
  type SandboxTransformRequest,
} from "../sandbox/engine/index.js";
import { UnifiedExecError } from "./types.js";
import { UnifiedExecProcessManager } from "./process-manager.js";

function passthroughSandboxManager(): Pick<SandboxManager, "selectInitial" | "transform"> {
  return {
    selectInitial: () => "linux_seccomp",
    transform: (request): SandboxExecRequest => ({
      command: [request.command.program, ...request.command.args],
      cwd: request.command.cwd,
      env: request.command.env,
      sandbox: request.sandbox,
      windowsSandboxLevel: request.windowsSandboxLevel,
      windowsSandboxPrivateDesktop: request.windowsSandboxPrivateDesktop,
      permissionProfile: request.permissions,
      fileSystemSandboxPolicy: request.permissions.fileSystem,
      networkSandboxPolicy: request.permissions.network,
      arg0: "agenc-sandbox-test",
    }),
  };
}

function ptyCompatibleSandboxManager(): Pick<SandboxManager, "selectInitial" | "transform"> {
  return {
    selectInitial: () => "linux_seccomp",
    transform: (request): SandboxExecRequest => ({
      command: [request.command.program, ...request.command.args],
      cwd: request.command.cwd,
      env: request.command.env,
      sandbox: request.sandbox,
      windowsSandboxLevel: request.windowsSandboxLevel,
      windowsSandboxPrivateDesktop: request.windowsSandboxPrivateDesktop,
      permissionProfile: request.permissions,
      fileSystemSandboxPolicy: request.permissions.fileSystem,
      networkSandboxPolicy: request.permissions.network,
    }),
  };
}

function installFakePty(
  manager: UnifiedExecProcessManager,
  onSpawn?: (
    file: string,
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
    },
  ) => void,
): void {
  (manager as unknown as {
    loadPty: () => Promise<{
      spawn(
        file: string,
        args: readonly string[],
        options: {
          readonly cwd?: string;
          readonly env?: Record<string, string>;
        },
      ): {
        readonly pid: number;
        write(data: string): void;
        resize(columns: number, rows: number): void;
        kill(signal?: string): void;
        onData(listener: (data: string) => void): { dispose(): void };
        onExit(
          listener: (event: {
            readonly exitCode: number;
            readonly signal?: number | string;
          }) => void,
        ): { dispose(): void };
      };
    }>;
  }).loadPty = async () => ({
    spawn(file, args, options) {
      onSpawn?.(file, args, options);
      let exitListener:
        | ((event: { readonly exitCode: number; readonly signal?: number | string }) => void)
        | null = null;
      return {
        pid: 0,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => {
          exitListener?.({ exitCode: 143, signal: "SIGTERM" });
        }),
        onData: () => ({ dispose: vi.fn() }),
        onExit: (listener) => {
          exitListener = listener;
          return { dispose: vi.fn() };
        },
      };
    },
  });
}

function markerPids(marker: string): number[] {
  if (process.platform === "win32") return [];
  try {
    const output = execFileSync("ps", ["-eo", "pid=,args="], {
      encoding: "utf8",
    });
    return output
      .split("\n")
      .flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        if (match === null) return [];
        const pid = Number(match[1]);
        const args = match[2] ?? "";
        return pid !== process.pid && args.includes(marker) ? [pid] : [];
      });
  } catch {
    return [];
  }
}

async function waitForMarker(
  marker: string,
  present: boolean,
  timeoutMs = 5_000,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((markerPids(marker).length > 0) === present) {
      return true;
    }
    await delay(50);
  }
  return false;
}

function killMarker(marker: string): void {
  for (const pid of markerPids(marker)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Best-effort test cleanup.
    }
  }
}

describe("UnifiedExecProcessManager", () => {
  test("runs one-shot non-PTY commands without returning a session id", async () => {
    const manager = new UnifiedExecProcessManager({ cwd: process.cwd() });

    const result = await manager.execCommand({
      cmd: "printf agenc-runtime",
      yield_time_ms: 250,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("agenc-runtime");
    expect(result.process_id).toBeUndefined();
  });

  test("transforms restricted commands through the configured sandbox manager", async () => {
    const transforms: SandboxTransformRequest[] = [];
    const selections: Array<{
      readonly hasManagedNetworkRequirements: boolean;
    }> = [];
    const commandCwd = process.cwd();
    const sandboxPolicyCwd = dirname(commandCwd);
    const networkPolicyDecider = {
      decide: () => ({ decision: "allow" as const }),
    };
    const blockedRequestObserver = { onBlockedRequest: () => undefined };
    const manager = new UnifiedExecProcessManager({
      cwd: sandboxPolicyCwd,
      sandboxManager: {
        selectInitial: (request) => {
          selections.push(request);
          return "linux_seccomp";
        },
        transform: (request): SandboxExecRequest => {
          transforms.push(request);
          return {
            command: [
              process.execPath,
              "-e",
              "process.stdout.write('sandboxed')",
            ],
            cwd: request.command.cwd,
            env: request.command.env,
            sandbox: request.sandbox,
            windowsSandboxLevel: request.windowsSandboxLevel,
            windowsSandboxPrivateDesktop:
              request.windowsSandboxPrivateDesktop,
            permissionProfile: request.permissions,
            fileSystemSandboxPolicy: request.permissions.fileSystem,
            networkSandboxPolicy: request.permissions.network,
            arg0: "agenc-sandbox-test",
          };
        },
      },
    });
    const permissionProfile = permissionProfileFromRuntimePermissions(
      restrictedFileSystemPolicy(),
      "enabled",
    );

    const result = await manager.execCommand({
      cmd: "printf host-command",
      workdir: commandCwd,
      yield_time_ms: 250,
      runtimeSandbox: {
        permissionProfile,
        sandboxPolicyCwd,
        preference: "require",
        agencLinuxSandboxExe: "/opt/agenc-linux-sandbox",
        networkPolicyDecider,
        blockedRequestObserver,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sandboxed");
    expect(transforms).toHaveLength(1);
    expect(transforms[0]).toMatchObject({
      permissions: permissionProfile,
      sandbox: "linux_seccomp",
      sandboxPolicyCwd,
      command: expect.objectContaining({ cwd: commandCwd }),
    });
    expect(selections).toEqual([
      expect.objectContaining({ hasManagedNetworkRequirements: false }),
    ]);
    expect(transforms[0]?.networkPolicyDecider).toBe(networkPolicyDecider);
    expect(transforms[0]?.blockedRequestObserver).toBe(blockedRequestObserver);
  });

  test("network policy interfaces alone do not force managed network sandboxing", async () => {
    const transforms: SandboxTransformRequest[] = [];
    const selections: Array<{
      readonly hasManagedNetworkRequirements: boolean;
      readonly preference: string;
    }> = [];
    const networkPolicyDecider = { decide: () => ({ decision: "allow" as const }) };
    const blockedRequestObserver = { onBlockedRequest: () => undefined };
    const manager = new UnifiedExecProcessManager({
      cwd: process.cwd(),
      sandboxManager: {
        selectInitial: (request) => {
          selections.push(request);
          return "none";
        },
        transform: (request): SandboxExecRequest => {
          transforms.push(request);
          return {
            command: [request.command.program, ...request.command.args],
            cwd: request.command.cwd,
            env: request.command.env,
            sandbox: request.sandbox,
            windowsSandboxLevel: request.windowsSandboxLevel,
            windowsSandboxPrivateDesktop:
              request.windowsSandboxPrivateDesktop,
            permissionProfile: request.permissions,
            fileSystemSandboxPolicy: request.permissions.fileSystem,
            networkSandboxPolicy: request.permissions.network,
          };
        },
      },
    });
    const permissionProfile = permissionProfileFromRuntimePermissions(
      unrestrictedFileSystemPolicy(),
      "enabled",
    );

    const result = await manager.execCommand({
      cmd: "printf host-command",
      yield_time_ms: 250,
      runtimeSandbox: {
        permissionProfile,
        sandboxPolicyCwd: process.cwd(),
        preference: "auto",
        networkPolicyDecider,
        blockedRequestObserver,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("host-command");
    expect(selections).toEqual([
      expect.objectContaining({
        preference: "auto",
        hasManagedNetworkRequirements: false,
      }),
    ]);
    expect(transforms).toHaveLength(1);
    expect(transforms[0]).toMatchObject({ sandbox: "none" });
    expect(transforms[0]?.networkPolicyDecider).toBe(networkPolicyDecider);
    expect(transforms[0]?.blockedRequestObserver).toBe(blockedRequestObserver);
  });

  test("keeps non-PTY long-running commands pollable but stdin-closed", async () => {
    const manager = new UnifiedExecProcessManager({ cwd: process.cwd() });
    try {
      const started = await manager.execCommand({
        cmd: "node -e \"setTimeout(()=>console.log('late-output'), 350)\"",
        yield_time_ms: 250,
      });

      expect(started.process_id).toEqual(expect.any(Number));
      await expect(
        manager.writeStdin({
          session_id: started.process_id!,
          chars: "ignored\n",
          yield_time_ms: 250,
        }),
      ).rejects.toMatchObject({
        code: "stdin_closed",
      } satisfies Partial<UnifiedExecError>);

      const polled = await manager.writeStdin({
        session_id: started.process_id!,
        chars: "",
        yield_time_ms: 5_000,
      });
      expect(polled.stdout).toContain("late-output");
      expect(polled.process_id).toBeUndefined();
    } finally {
      await manager.closeAll("test_cleanup");
    }
  });

  test(
    "persists PTY shell state across write_stdin calls",
    async () => {
      const manager = new UnifiedExecProcessManager({ cwd: process.cwd() });
      try {
        const started = await manager.execCommand({
          cmd: "bash -i",
          tty: true,
          yield_time_ms: 250,
        });

        expect(started.process_id).toEqual(expect.any(Number));
        const sessionId = started.process_id!;

        await manager.writeStdin({
          session_id: sessionId,
          chars: "export AGENC_UNIFIED_EXEC_TEST=ok\n",
          yield_time_ms: 250,
        });
        const echoed = await manager.writeStdin({
          session_id: sessionId,
          chars: "printf \"$AGENC_UNIFIED_EXEC_TEST\\n\"\n",
          yield_time_ms: 250,
        });

        expect(echoed.stdout).toContain("ok");
        expect(echoed.process_id).toBe(sessionId);
      } finally {
        await manager.closeAll("test_cleanup");
      }
    },
    10_000,
  );

  test.skipIf(process.platform === "win32")(
    "aborting a yielded PTY poll terminates the foreground child process",
    async () => {
      const manager = new UnifiedExecProcessManager({ cwd: process.cwd() });
      const controller = new AbortController();
      const marker = `agenc-unified-pty-abort-${process.pid}-${Date.now()}`;
      try {
        const started = await manager.execCommand({
          cmd: "bash -i",
          tty: true,
          yield_time_ms: 250,
          __abortSignal: controller.signal,
        });
        const sessionId = started.process_id!;

        await manager.writeStdin({
          session_id: sessionId,
          chars: `bash -lc 'exec -a ${marker} sleep 30'\n`,
          yield_time_ms: 250,
        });
        expect(await waitForMarker(marker, true)).toBe(true);

        const polled = manager.writeStdin({
          session_id: sessionId,
          chars: "",
          yield_time_ms: 5_000,
          __abortSignal: controller.signal,
        });
        await delay(100);
        controller.abort("interrupted");
        await polled;

        expect(await waitForMarker(marker, false)).toBe(true);
      } finally {
        await manager.closeAll("test_cleanup");
        killMarker(marker);
      }
    },
    10_000,
  );

  test(
    "rejects restricted write_stdin for a non-sandboxed PTY session",
    async () => {
      const manager = new UnifiedExecProcessManager({ cwd: process.cwd() });
      const permissionProfile = permissionProfileFromRuntimePermissions(
        restrictedFileSystemPolicy(),
        "enabled",
      );
      try {
        const started = await manager.execCommand({
          cmd: "bash -i",
          tty: true,
          yield_time_ms: 250,
        });

        await expect(
          manager.writeStdin({
            session_id: started.process_id!,
            chars: "",
            yield_time_ms: 250,
            runtimeSandbox: {
              permissionProfile,
              sandboxPolicyCwd: process.cwd(),
              preference: "require",
            },
          }),
        ).rejects.toMatchObject({
          code: "write_stdin",
        } satisfies Partial<UnifiedExecError>);

        await expect(
          manager.writeStdin({
            session_id: started.process_id!,
            chars: "printf denied\\n",
            yield_time_ms: 250,
            runtimeSandbox: {
              permissionProfile,
              sandboxPolicyCwd: process.cwd(),
              preference: "require",
            },
          }),
        ).rejects.toMatchObject({
          code: "write_stdin",
        } satisfies Partial<UnifiedExecError>);
      } finally {
        await manager.closeAll("test_cleanup");
      }
    },
    10_000,
  );

  test("preserves sandbox argv0 for restricted PTY sessions", async () => {
    const permissionProfile = permissionProfileFromRuntimePermissions(
      restrictedFileSystemPolicy(),
      "enabled",
    );
    const manager = new UnifiedExecProcessManager({
      cwd: process.cwd(),
      sandboxManager: passthroughSandboxManager(),
    });
    let spawned:
      | { readonly file: string; readonly args: readonly string[] }
      | undefined;
    installFakePty(manager, (file, args) => {
      spawned = { file, args };
    });

    try {
      const started = await manager.execCommand({
        cmd: "bash -i",
        tty: true,
        yield_time_ms: 250,
        runtimeSandbox: {
          permissionProfile,
          sandboxPolicyCwd: process.cwd(),
          preference: "require",
        },
      });

      expect(started.process_id).toEqual(expect.any(Number));
      expect(spawned?.file).toBe(process.execPath);
      expect(spawned?.args[0]).toBe("-e");
      expect(spawned?.args).toEqual(
        expect.arrayContaining(["agenc-sandbox-test", "bash -i"]),
      );
    } finally {
      await manager.closeAll("test_cleanup");
    }
  });

  test("rejects write_stdin when sandbox-affecting fields differ", async () => {
    const permissionProfile = permissionProfileFromRuntimePermissions(
      restrictedFileSystemPolicy(),
      "enabled",
    );
    const runtimeSandbox = {
      permissionProfile,
      sandboxPolicyCwd: process.cwd(),
      preference: "require" as const,
    };
    const manager = new UnifiedExecProcessManager({
      cwd: process.cwd(),
      sandboxManager: ptyCompatibleSandboxManager(),
    });
    installFakePty(manager);
    try {
      const started = await manager.execCommand({
        cmd: "bash -i",
        tty: true,
        yield_time_ms: 250,
        runtimeSandbox,
      });
      const sessionId = started.process_id!;

      await expect(
        manager.writeStdin({
          session_id: sessionId,
          chars: "",
          yield_time_ms: 250,
          runtimeSandbox: {
            ...runtimeSandbox,
            preference: "auto",
          },
        }),
      ).rejects.toMatchObject({ code: "write_stdin" } satisfies Partial<UnifiedExecError>);
      await expect(
        manager.writeStdin({
          session_id: sessionId,
          chars: "",
          yield_time_ms: 250,
          runtimeSandbox: {
            ...runtimeSandbox,
            enforceManagedNetwork: true,
          },
        }),
      ).rejects.toMatchObject({ code: "write_stdin" } satisfies Partial<UnifiedExecError>);
      await expect(
        manager.writeStdin({
          session_id: sessionId,
          chars: "",
          yield_time_ms: 250,
          runtimeSandbox: {
            ...runtimeSandbox,
            network: { env: { HTTP_PROXY: "http://127.0.0.1:9" } },
          },
        }),
      ).rejects.toMatchObject({ code: "write_stdin" } satisfies Partial<UnifiedExecError>);
    } finally {
      await manager.closeAll("test_cleanup");
    }
  });

  test(
    "allows restricted write_stdin for a compatible sandboxed PTY session",
    async () => {
      const startProfile = permissionProfileFromRuntimePermissions(
        restrictedFileSystemPolicy([
          { path: { kind: "special", value: { kind: "project_roots" } }, access: "write" },
          { path: { kind: "path", path: "/repo/blocked" }, access: "read" },
        ]),
        "enabled",
      );
      const writeProfile = permissionProfileFromRuntimePermissions(
        restrictedFileSystemPolicy([
          { path: { kind: "path", path: "/repo/blocked" }, access: "read" },
          { path: { kind: "special", value: { kind: "project_roots" } }, access: "write" },
        ]),
        "enabled",
      );
      const runtimeSandbox = {
        permissionProfile: startProfile,
        sandboxPolicyCwd: process.cwd(),
        preference: "require" as const,
      };
      const writeRuntimeSandbox = {
        ...runtimeSandbox,
        permissionProfile: writeProfile,
      };
      const manager = new UnifiedExecProcessManager({
        cwd: process.cwd(),
        sandboxManager: ptyCompatibleSandboxManager(),
      });
      try {
        const started = await manager.execCommand({
          cmd: "bash -i",
          tty: true,
          yield_time_ms: 250,
          runtimeSandbox,
        });
        const echoed = await manager.writeStdin({
          session_id: started.process_id!,
          chars: "printf sandboxed-stdin\\n",
          yield_time_ms: 250,
          runtimeSandbox: writeRuntimeSandbox,
        });

        expect(echoed.stdout).toContain("sandboxed-stdin");
      } finally {
        await manager.closeAll("test_cleanup");
      }
    },
    10_000,
  );

  test("force-kills abandoned non-tty processes once maxTimeoutMs elapses", async () => {
    // Regression: a non-tty exec_command with no explicit timeoutMs used to
    // have no hard kill — the model could yield and forget, leaving the
    // child running indefinitely. We saw this in the wild with three
    // `./agenc -c 'echo hi' --dump-tokens` zombies burning ~97% CPU each
    // for 95+ minutes after the agent moved on. The reference runtime
    // always enforces a timeout; we now do too.
    const manager = new UnifiedExecProcessManager({
      cwd: process.cwd(),
      maxTimeoutMs: 400,
    });
    try {
      const started = await manager.execCommand({
        cmd: "node -e \"setInterval(()=>{}, 1000)\"",
        yield_time_ms: 250,
      });
      // Yielded while still running — model gets a session_id.
      expect(started.process_id).toEqual(expect.any(Number));
      // Wait past the hard timeout, then poll. The hard-kill caused the
      // child to exit; the next writeStdin observes the terminal exitState
      // and returns the final result with no process_id (indicating the
      // session is gone). exit_code is null because the kernel killed the
      // child by signal rather than letting it exit cleanly.
      await new Promise((r) => setTimeout(r, 800));
      const polled = await manager.writeStdin({
        session_id: started.process_id!,
        chars: "",
        yield_time_ms: 250,
      });
      expect(polled.process_id).toBeUndefined();
      expect(polled.exit_code).toBeNull();
      // And the slot is fully released — a second poll should now reject.
      await expect(
        manager.writeStdin({
          session_id: started.process_id!,
          chars: "",
          yield_time_ms: 250,
        }),
      ).rejects.toMatchObject({
        code: "unknown_process",
      } satisfies Partial<UnifiedExecError>);
    } finally {
      await manager.closeAll("test_cleanup");
    }
  });

  test("respects explicit timeoutMs for tty calls (default does not apply)", async () => {
    // tty=true is the interactive-session path. We deliberately exempt tty
    // from the default hard timeout so persistent shells stay
    // alive across write_stdin polls. This test asserts that exemption.
    const manager = new UnifiedExecProcessManager({
      cwd: process.cwd(),
      maxTimeoutMs: 200,
    });
    try {
      const started = await manager.execCommand({
        cmd: "bash -i",
        tty: true,
        yield_time_ms: 250,
      });
      expect(started.process_id).toEqual(expect.any(Number));
      // Wait past `maxTimeoutMs`. The session should still be alive.
      await new Promise((r) => setTimeout(r, 500));
      const polled = await manager.writeStdin({
        session_id: started.process_id!,
        chars: "",
        yield_time_ms: 250,
      });
      expect(polled.process_id).toBe(started.process_id);
    } finally {
      await manager.closeAll("test_cleanup");
    }
  }, 10_000);

  test("closeAll terminates live PTY sessions", async () => {
    const manager = new UnifiedExecProcessManager({ cwd: process.cwd() });
    const started = await manager.execCommand({
      cmd: "bash -i",
      tty: true,
      yield_time_ms: 250,
    });
    expect(started.process_id).toEqual(expect.any(Number));

    await manager.closeAll("test_cleanup");

    await expect(
      manager.writeStdin({
        session_id: started.process_id!,
        chars: "",
      }),
    ).rejects.toMatchObject({
      code: "unknown_process",
    } satisfies Partial<UnifiedExecError>);
  }, 10_000);
});
