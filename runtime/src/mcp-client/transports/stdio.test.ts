import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgenCStdioClientTransport,
  DEFAULT_STDIO_ENV_VARS,
  createStdioMCPEnvironment,
} from "./stdio.js";

const tempDirs = new Set<string>();

afterEach(async () => {
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
  it("decodes newline-delimited JSON-RPC messages from stdout", async () => {
    const transport = new AgenCStdioClientTransport({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'server/notice',params:{ok:true}})+'\\n'); setTimeout(() => {}, 1000);",
      ],
      env: createStdioMCPEnvironment(undefined, undefined),
    });

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

  it.skipIf(process.platform === "win32")(
    "terminates a spawned process group on close",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "agenc-mcp-stdio-"));
      tempDirs.add(dir);
      const pidFile = join(dir, "child.pid");

      const transport = new AgenCStdioClientTransport({
        command: "/bin/sh",
        args: [
          "-c",
          'sleep 300 & child_pid=$!; echo "$child_pid" > "$PID_FILE"; cat >/dev/null',
        ],
        env: createStdioMCPEnvironment({ PID_FILE: pidFile }, undefined),
      });
      await transport.start();

      const childPid = await waitForPidFile(pidFile);
      expect(isPidAlive(childPid)).toBe(true);

      await transport.close();
      await waitFor(() => !isPidAlive(childPid), `child process ${childPid} exit`);
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
