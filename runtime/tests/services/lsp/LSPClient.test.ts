import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { createLSPClient } from "./LSPClient.js";
import { SandboxExecutionBroker } from "../../sandbox/execution-broker.js";
import { explicitDangerBroker } from "../../helpers/explicit-danger-boundary.js";

const EXITING_SERVER = "setTimeout(() => process.exit(1), 10)";
const CLEAN_EXIT_SERVER = "setTimeout(() => process.exit(0), 10)";
const CLOSE_CONNECTION_SERVER = `
setTimeout(() => {
  process.stdout.end();
}, 10);
setInterval(() => {}, 1000);
`;
const JSON_RPC_SERVER = `
let buffer = Buffer.alloc(0);
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}
function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
    setTimeout(() => send({ jsonrpc: "2.0", method: "custom/event", params: { ok: true } }), 5);
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") {
    process.exit(0);
  }
}
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length: (\\d+)/i.exec(header);
    if (!match) throw new Error("missing content length");
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body));
  }
});
`;

function termResistantLspTree(marker: string): string {
  const descendant = `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  leader: process.ppid,
  descendant: process.pid,
}));
setInterval(() => {}, 1000);
`;
  return `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
  stdio: "ignore",
});
${JSON_RPC_SERVER}
`;
}

function termResistantCrashingTree(marker: string): string {
  const descendant = `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  leader: process.ppid,
  descendant: process.pid,
}));
setInterval(() => {}, 1000);
`;
  return `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
  stdio: "ignore",
});
function crashWhenReady() {
  if (!fs.existsSync(${JSON.stringify(marker)})) {
    setTimeout(crashWhenReady, 5);
    return;
  }
  process.exit(31);
}
crashWhenReady();
`;
}

function isLivePid(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      const state = stat.slice(closeParen + 2).trim().split(/\s+/)[0];
      return state !== "Z" && state !== "X";
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceKillPid(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("createLSPClient", () => {
  const testPosix = process.platform === "win32" ? test.skip : test;

  testPosix(
    "stop kills a TERM-resistant descendant before it returns",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "agenc-lsp-tree-"));
      const marker = join(dir, "tree.json");
      const client = createLSPClient("process-tree", {
        sandboxExecutionBroker: explicitDangerBroker,
      });
      let descendant: number | undefined;
      try {
        await client.start(process.execPath, [
          "-e",
          termResistantLspTree(marker),
        ]);
        await waitFor(() => existsSync(marker), 2_000);
        expect(existsSync(marker)).toBe(true);
        const tree = JSON.parse(await readFile(marker, "utf8")) as {
          descendant: number;
        };
        descendant = tree.descendant;
        expect(isLivePid(descendant)).toBe(true);

        await client.stop();
        await waitFor(() => !isLivePid(descendant!), 2_000);

        expect(isLivePid(descendant)).toBe(false);
      } finally {
        await client.stop().catch(() => {});
        forceKillPid(descendant);
        await rm(dir, { recursive: true, force: true });
      }
    },
    10_000,
  );

  testPosix(
    "cleans a crashed server tree before reporting it restartable",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "agenc-lsp-crash-tree-"));
      const marker = join(dir, "tree.json");
      let reported = false;
      let descendant: number | undefined;
      const client = createLSPClient("crash-tree", {
        sandboxExecutionBroker: explicitDangerBroker,
        onCrash: () => {
          reported = true;
        },
      });
      try {
        await client.start(process.execPath, [
          "-e",
          termResistantCrashingTree(marker),
        ]);
        await waitFor(() => existsSync(marker), 2_000);
        expect(existsSync(marker)).toBe(true);
        descendant = (
          JSON.parse(await readFile(marker, "utf8")) as { descendant: number }
        ).descendant;
        await waitFor(() => reported, 2_000);

        expect(reported).toBe(true);
        expect(isLivePid(descendant)).toBe(false);
      } finally {
        await client.stop().catch(() => {});
        forceKillPid(descendant);
        await rm(dir, { recursive: true, force: true });
      }
    },
    10_000,
  );

  test("clears closed process state so a crashed server can be started again", async () => {
    let crashCount = 0;
    const client = createLSPClient("crashy", {
      onCrash: () => {
        crashCount += 1;
      },
      sandboxExecutionBroker: explicitDangerBroker,
    });

    await client.start(process.execPath, ["-e", EXITING_SERVER]);
    await waitFor(() => crashCount === 1);
    expect(crashCount).toBe(1);

    await client.start(process.execPath, ["-e", EXITING_SERVER]);
    await waitFor(() => crashCount === 2);
    expect(crashCount).toBe(2);
  });

  test("reports unexpected clean exits and can be started again", async () => {
    const terminalEvents: string[] = [];
    const client = createLSPClient("clean-exit", {
      onCrash: (error) => {
        terminalEvents.push(error.message);
      },
      sandboxExecutionBroker: explicitDangerBroker,
    });

    await client.start(process.execPath, ["-e", CLEAN_EXIT_SERVER]);
    await waitFor(() => terminalEvents.length === 1);
    expect(terminalEvents).toEqual([
      "LSP server clean-exit exited unexpectedly with code 0",
    ]);

    await client.start(process.execPath, ["-e", CLEAN_EXIT_SERVER]);
    await waitFor(() => terminalEvents.length === 2);
    expect(terminalEvents).toHaveLength(2);
  });

  test("reports unexpected JSON-RPC connection close", async () => {
    const terminalEvents: string[] = [];
    const client = createLSPClient("close", {
      onCrash: (error) => {
        terminalEvents.push(error.message);
      },
      sandboxExecutionBroker: explicitDangerBroker,
    });

    await client.start(process.execPath, ["-e", CLOSE_CONNECTION_SERVER]);
    await waitFor(() => terminalEvents.length === 1);

    expect(terminalEvents).toEqual([
      "LSP server close connection closed unexpectedly",
    ]);
    expect(client.isInitialized).toBe(false);
  });

  test("scrubs inherited secrets while preserving explicit config env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-lsp-env-"));
    const output = join(dir, "env.json");
    try {
      const client = createLSPClient("env", {
        sandboxExecutionBroker: explicitDangerBroker,
        baseEnv: {
          PATH: process.env.PATH,
          HOME: "/home/test",
          OPENAI_API_KEY: "secret",
          OPENROUTER_API_KEY: "openrouter-secret",
          GOOGLE_API_KEY: "google-secret",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc",
          INPUT_OPENAI_API_KEY: "duplicated",
          INPUT_GEMINI_API_KEY: "duplicated-gemini",
        },
      });

      await client.start(process.execPath, [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env));`,
      ], {
        env: { LSP_EXPLICIT_ENV: "kept" },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const env = JSON.parse(await readFile(output, "utf8")) as Record<
        string,
        string | undefined
      >;
      expect(env.HOME).toBe("/home/test");
      expect(env.LSP_EXPLICIT_ENV).toBe("kept");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.GOOGLE_API_KEY).toBeUndefined();
      expect(env.INPUT_OPENAI_API_KEY).toBeUndefined();
      expect(env.INPUT_GEMINI_API_KEY).toBeUndefined();
      expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("re-registers handlers after restart", async () => {
    const client = createLSPClient("jsonrpc", {
      sandboxExecutionBroker: explicitDangerBroker,
    });
    let notificationCount = 0;
    client.onNotification("custom/event", () => {
      notificationCount += 1;
    });

    await client.start(process.execPath, ["-e", JSON_RPC_SERVER]);
    await client.initialize({
      processId: process.pid,
      capabilities: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await client.stop();

    await client.start(process.execPath, ["-e", JSON_RPC_SERVER]);
    await client.initialize({
      processId: process.pid,
      capabilities: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await client.stop();

    expect(notificationCount).toBe(2);
  });

  test("rejects an LSP process before spawn when its sandbox boundary is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-lsp-uncovered-"));
    const marker = join(dir, "escaped");
    try {
      const client = createLSPClient("uncovered");

      await expect(
        client.start(process.execPath, [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "escaped")`,
        ], { cwd: dir }),
      ).rejects.toMatchObject({
        code: "sandbox_surface_uncovered",
        surface: "lsp",
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects an LSP process before spawn when required isolation is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-lsp-unavailable-"));
    const marker = join(dir, "escaped");
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: dir,
      probe: () => ({
        kind: "unavailable",
        mode: "workspace_write",
        platform: process.platform,
        reason: "probe: injected LSP namespace failure",
        remediation: "repair sandbox support",
      }),
    });
    try {
      const client = createLSPClient("unavailable", {
        sandboxExecutionBroker: broker,
      });

      await expect(
        client.start(process.execPath, [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "escaped")`,
        ], { cwd: dir }),
      ).rejects.toMatchObject({
        code: "sandbox_probe_failed",
        surface: "lsp",
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("spawns only the command transformed by the authenticated boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-lsp-transform-"));
    const output = join(dir, "spawn.json");
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: dir,
    });
    const prepareSpawn = vi.spyOn(broker, "prepareSpawn").mockImplementation(
      (_surface, command) => ({
        program: process.execPath,
        args: [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify({ cwd: process.cwd(), env: process.env.LSP_TRANSFORMED_ENV, argv0: process.argv0 }))`,
        ],
        cwd: dir,
        env: { ...command.env, LSP_TRANSFORMED_ENV: "present" },
        argv0: "agenc-lsp-sandboxed",
      }),
    );
    try {
      const client = createLSPClient("transformed", {
        sandboxExecutionBroker: broker,
      });

      await client.start("untrusted-original-command", ["--must-not-run"], {
        cwd: dir,
      });
      await waitFor(() => existsSync(output));

      expect(prepareSpawn).toHaveBeenCalledWith("lsp", {
        program: "untrusted-original-command",
        args: ["--must-not-run"],
        cwd: dir,
        env: expect.any(Object),
      });
      const observed = JSON.parse(
        await readFile(output, "utf8"),
      ) as Record<string, string>;
      expect(observed).toEqual({
        cwd: dir,
        env: "present",
        argv0: "agenc-lsp-sandboxed",
      });
    } finally {
      prepareSpawn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
