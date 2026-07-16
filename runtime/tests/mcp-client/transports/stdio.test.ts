import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

const { terminationSeam } = vi.hoisted(() => ({
  terminationSeam: {
    failuresRemaining: 0,
    calls: [] as ChildProcess[],
  },
}));

vi.mock("../../../src/utils/supervisedProcess.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../src/utils/supervisedProcess.js")
  >();
  return {
    ...actual,
    terminateProcessTreeAndWait: async (
      ...args: Parameters<typeof actual.terminateProcessTreeAndWait>
    ): Promise<void> => {
      terminationSeam.calls.push(args[0]);
      if (terminationSeam.failuresRemaining > 0) {
        terminationSeam.failuresRemaining -= 1;
        throw new Error("injected MCP stdio cleanup failure");
      }
      await actual.terminateProcessTreeAndWait(...args);
    },
  };
});

import type { Logger } from "../../_deps/logger.js";
import { SandboxExecutionBroker } from "../../sandbox/execution-broker.js";
import {
  AGENC_MCP_STDIO_MAX_FRAME_BYTES,
  AgenCStdioClientTransport,
  DEFAULT_STDIO_ENV_VARS,
  createStdioMCPConnection,
  createStdioMCPEnvironment,
} from "./stdio.js";

const tempDirs = new Set<string>();
const explicitDangerBroker = new SandboxExecutionBroker({
  mode: "danger_full_access",
  cwd: process.cwd(),
});

afterEach(async () => {
  terminationSeam.failuresRemaining = 0;
  terminationSeam.calls = [];
  await Promise.all(
    Array.from(tempDirs).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
      tempDirs.delete(dir);
    }),
  );
});

describe("createStdioMCPEnvironment", () => {
  it("copies only default and explicit parent variables, then applies overrides", () => {
    const defaultName = DEFAULT_STDIO_ENV_VARS[0]!;
    const env = createStdioMCPEnvironment(
      { EXTRA_TOKEN: "override" },
      ["EXTRA_TOKEN", "SHELL_FUNC"],
      {
        [defaultName]: "default-value",
        EXTRA_TOKEN: "parent-value",
        SECRET_TOKEN: "must-not-copy",
        SHELL_FUNC: "() { ignored; }",
      },
    );

    expect(env[defaultName]).toBe("default-value");
    expect(env.EXTRA_TOKEN).toBe("override");
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.SHELL_FUNC).toBeUndefined();
  });
});

describe("AgenCStdioClientTransport", () => {
  it("defaults the child cwd to the sandbox broker authority", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-mcp-stdio-cwd-"));
    tempDirs.add(dir);
    const expectedCwd = await realpath(dir);
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: dir,
    });
    const transport = new AgenCStdioClientTransport(
      {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'server/cwd',params:{cwd:process.cwd()}})+'\\n'); setTimeout(() => {}, 1000);",
        ],
        env: createStdioMCPEnvironment(undefined, undefined),
      },
      undefined,
      broker,
    );
    const message = new Promise((resolve) => {
      transport.onmessage = resolve;
    });

    try {
      await transport.start();
      await expect(message).resolves.toMatchObject({
        method: "server/cwd",
        params: { cwd: expectedCwd },
      });
    } finally {
      await transport.close();
    }
  });

  it("resolves a configured relative cwd from the sandbox broker authority", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-mcp-stdio-relative-cwd-"));
    tempDirs.add(dir);
    const relativeCwd = "server-workspace";
    const expectedCwd = join(dir, relativeCwd);
    await mkdir(expectedCwd);
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: dir,
    });
    const transport = new AgenCStdioClientTransport(
      {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'server/cwd',params:{cwd:process.cwd()}})+'\\n'); setTimeout(() => {}, 1000);",
        ],
        env: createStdioMCPEnvironment(undefined, undefined),
        cwd: relativeCwd,
      },
      undefined,
      broker,
    );
    const message = new Promise((resolve) => {
      transport.onmessage = resolve;
    });

    try {
      await transport.start();
      await expect(message).resolves.toMatchObject({
        method: "server/cwd",
        params: { cwd: expectedCwd },
      });
    } finally {
      await transport.close();
    }
  });

  it("decodes newline-delimited JSON-RPC messages from stdout", async () => {
    const transport = new AgenCStdioClientTransport(
      {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'server/notice',params:{ok:true}})+'\\n'); setTimeout(() => {}, 1000);",
        ],
        env: createStdioMCPEnvironment(undefined, undefined),
      },
      undefined,
      explicitDangerBroker,
    );

    const message = new Promise((resolve) => {
      transport.onmessage = resolve;
    });
    await transport.start();

    await expect(message).resolves.toMatchObject({
      jsonrpc: "2.0",
      method: "server/notice",
      params: { ok: true },
    });
    await transport.close();
  });

  it("accepts a valid JSON-RPC frame larger than one MiB", async () => {
    const payloadBytes = 2 * 1024 * 1024;
    const transport = new AgenCStdioClientTransport(
      {
        command: process.execPath,
        args: [
          "-e",
          `process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'server/large',params:{data:'x'.repeat(${payloadBytes})}})+'\\n'); setTimeout(() => {}, 1000);`,
        ],
        env: createStdioMCPEnvironment(undefined, undefined),
      },
      undefined,
      explicitDangerBroker,
    );
    const message = new Promise<unknown>((resolve) => {
      transport.onmessage = resolve;
    });

    try {
      await transport.start();
      await expect(message).resolves.toMatchObject({
        method: "server/large",
        params: { data: expect.stringMatching(/^x+$/) },
      });
      const received = await message;
      expect(
        (received as { params: { data: string } }).params.data.length,
      ).toBe(payloadBytes);
    } finally {
      await transport.close();
    }
  });

  it("keeps stderrBuffer bounded under a newline-less flood", async () => {
    // Defense-in-depth: a child emitting a long stderr run with no newline
    // must not grow stderrBuffer without bound. The oversized prefix is
    // flushed with a truncation notice; trailing residue keeps accumulating.
    const infoMessages: string[] = [];
    const logger: Logger = {
      debug() {},
      info(message: string) {
        infoMessages.push(message);
      },
      warn() {},
      error() {},
    };
    const transport = new AgenCStdioClientTransport(
      { command: "flooder" },
      logger,
    );

    // Reach into the private newline-less stderr handler/buffer. Treated as an
    // internal here only to assert the cap holds without spawning a real child.
    const internal = transport as unknown as {
      onStderrData: (chunk: Buffer) => void;
      stderrBuffer: Buffer;
    };

    const oneMiB = 1024 * 1024;
    // Stream 5 MiB of newline-less bytes across many chunks.
    for (let i = 0; i < 5; i += 1) {
      internal.onStderrData(Buffer.alloc(oneMiB, 0x61));
      // The retained, unflushed residue must never exceed the 1 MiB cap.
      expect(internal.stderrBuffer.length).toBeLessThanOrEqual(oneMiB);
    }

    // At least one truncation notice must have been logged for the flood.
    expect(infoMessages.some((m) => m.includes("truncated"))).toBe(true);

    // A trailing newline-terminated line still splits and logs normally.
    infoMessages.length = 0;
    internal.onStderrData(Buffer.from("tail-line\n", "utf8"));
    expect(internal.stderrBuffer.length).toBe(0);
    expect(infoMessages.some((m) => m.endsWith("tail-line"))).toBe(true);

    await transport.close();
  });

  it.skipIf(process.platform === "win32")(
    "retains the exact child and retries process-tree termination after failure",
    async () => {
      const transport = new AgenCStdioClientTransport(
        {
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
          env: createStdioMCPEnvironment(undefined, undefined),
        },
        undefined,
        explicitDangerBroker,
      );
      const internal = transport as unknown as {
        child: ChildProcess | undefined;
      };
      let closeNotifications = 0;
      transport.onclose = () => {
        closeNotifications += 1;
      };
      await transport.start();
      const owner = internal.child;
      const pid = owner?.pid;
      if (owner === undefined || pid === undefined) {
        throw new Error("expected spawned MCP stdio child");
      }
      terminationSeam.failuresRemaining = 1;

      try {
        const firstClose = transport.close();
        const concurrentClose = transport.close();
        const firstResults = await Promise.allSettled([
          firstClose,
          concurrentClose,
        ]);
        expect(firstResults).toEqual([
          expect.objectContaining({
            status: "rejected",
            reason: expect.objectContaining({
              message: "injected MCP stdio cleanup failure",
            }),
          }),
          expect.objectContaining({
            status: "rejected",
            reason: expect.objectContaining({
              message: "injected MCP stdio cleanup failure",
            }),
          }),
        ]);
        expect(internal.child).toBe(owner);
        expect(terminationSeam.calls).toEqual([owner]);
        expect(closeNotifications).toBe(0);
        expect(isPidAlive(pid)).toBe(true);

        await expect(transport.close()).resolves.toBeUndefined();
        expect(terminationSeam.calls).toEqual([owner, owner]);
        expect(internal.child).toBeUndefined();
        expect(closeNotifications).toBe(1);
        await waitFor(() => !isPidAlive(pid), `retried MCP process ${pid} exit`);
      } finally {
        terminationSeam.failuresRemaining = 0;
        await transport.close().catch(() => {});
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not settle a connection timeout until the stdio process is reaped",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "agenc-mcp-stdio-timeout-"));
      tempDirs.add(dir);
      const pidFile = join(dir, "server.pid");
      const cleanupFile = join(dir, "cleanup-complete");
      const script = [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.PID_FILE, String(process.pid));",
        "let closing = false;",
        "process.on('SIGTERM', () => {",
        "  if (closing) return;",
        "  closing = true;",
        "  setTimeout(() => {",
        "    fs.writeFileSync(process.env.CLEANUP_FILE, 'closed');",
        "    process.exit(0);",
        "  }, 100);",
        "});",
        "process.stdin.resume();",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      await expect(
        createStdioMCPConnection(
          {
            name: "timeout-cleanup",
            command: process.execPath,
            args: ["-e", script],
            env: { PID_FILE: pidFile, CLEANUP_FILE: cleanupFile },
            timeout: 400,
          },
          undefined,
          undefined,
          undefined,
          explicitDangerBroker,
        ),
      ).rejects.toThrow(
        'MCP stdio connect to "timeout-cleanup" timed out after 400ms',
      );

      const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
      expect(await readFile(cleanupFile, "utf8")).toBe("closed");
      expect(isPidAlive(pid)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "terminates a spawned process group on close",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "agenc-mcp-stdio-"));
      tempDirs.add(dir);
      const pidFile = join(dir, "child.pid");

      const transport = new AgenCStdioClientTransport(
        {
          command: "/bin/sh",
          args: [
            "-c",
            'sleep 300 & child_pid=$!; echo "$child_pid" > "$PID_FILE"; cat >/dev/null',
          ],
          env: createStdioMCPEnvironment({ PID_FILE: pidFile }, undefined),
        },
        undefined,
        explicitDangerBroker,
      );
      await transport.start();

      const childPid = await waitForPidFile(pidFile);
      expect(isPidAlive(childPid)).toBe(true);

      await transport.close();
      await waitFor(
        () => !isPidAlive(childPid),
        `child process ${childPid} exit`,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "reaps residual process-group members after the stdio leader exits unexpectedly",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "agenc-mcp-stdio-residual-"));
      tempDirs.add(dir);
      const pidFile = join(dir, "child.pid");
      const transport = new AgenCStdioClientTransport(
        {
          command: "/bin/sh",
          args: [
            "-c",
            'sleep 300 </dev/null >/dev/null 2>&1 & child_pid=$!; echo "$child_pid" > "$PID_FILE"; exit 0',
          ],
          env: createStdioMCPEnvironment({ PID_FILE: pidFile }, undefined),
        },
        undefined,
        explicitDangerBroker,
      );
      const closed = new Promise<void>((resolve) => {
        transport.onclose = resolve;
      });

      await transport.start();
      const childPid = await waitForPidFile(pidFile);

      await closed;
      await waitFor(
        () => !isPidAlive(childPid),
        `residual child process ${childPid} exit`,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "kills the stdio process tree when a newline-less stdout frame exceeds the cap",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "agenc-mcp-stdio-stdout-cap-"));
      tempDirs.add(dir);
      const pidFile = join(dir, "server.pid");
      const transport = new AgenCStdioClientTransport(
        {
          command: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(process.env.PID_FILE, String(process.pid)); process.stdout.write(Buffer.alloc(${AGENC_MCP_STDIO_MAX_FRAME_BYTES} + 1, 0x61)); setInterval(() => {}, 1000);`,
          ],
          env: createStdioMCPEnvironment({ PID_FILE: pidFile }, undefined),
        },
        undefined,
        explicitDangerBroker,
      );
      const protocolError = new Promise<Error>((resolve) => {
        transport.onerror = resolve;
      });
      const closed = new Promise<void>((resolve) => {
        transport.onclose = resolve;
      });

      await transport.start();
      const pid = await waitForPidFile(pidFile);
      expect((await protocolError).message).toMatch(/stdout frame exceeded/i);
      await closed;
      await waitFor(
        () => !isPidAlive(pid),
        `overflowing stdio process ${pid} exit`,
      );
    },
  );
});

async function waitForPidFile(path: string): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const raw = await readFile(path, "utf8");
      const pid = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for pid file: ${String(lastError)}`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
