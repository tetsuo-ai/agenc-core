import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, vi } from "vitest";

import { launchBrowser } from "../../src/browser/cdp.js";
import {
  SandboxExecutionBroker,
  type SandboxPreparedSpawn,
} from "../../src/sandbox/execution-broker.js";

test.skipIf(process.platform === "win32")("POSIX gate publishes the child PID before Chromium starts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agenc-browser-gate-test-"));
  const started = join(dir, "started");
  const worker = `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(started)}, "started");
const data = Buffer.alloc(65536);
const n = fs.readSync(3, data, 0, data.length, null);
const request = JSON.parse(data.subarray(0, n).toString("utf8").split("\\0")[0]);
fs.writeSync(4, JSON.stringify({ id: request.id, result: { product: "test" } }) + "\\0");
setInterval(() => {}, 1000);
`;
  const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: dir });
  vi.spyOn(broker, "prepareSpawn").mockImplementation((_surface, command) => {
    const transformed = {
      program: process.execPath,
      args: ["-e", worker],
      cwd: dir,
      env: command.env,
    };
    const signal = new AbortController().signal;
    return {
      run: operation => operation(transformed, signal),
      start: operation => operation(transformed, signal).value,
      runSync: operation => operation(transformed),
      spawnLifecycleParticipant: (_participantName, operation) => operation(transformed),
    } satisfies SandboxPreparedSpawn;
  });
  let observedPid: number | undefined;
  try {
    const launched = await launchBrowser({
      executablePath: process.execPath,
      userDataDir: dir,
      headless: true,
      noSandbox: false,
      proxyPort: 4567,
      sandboxExecutionBroker: broker,
      onSpawn: child => {
        observedPid = child.pid;
        const deadline = Date.now() + 200;
        while (Date.now() < deadline) { /* Let a direct spawn reach the worker. */ }
        expect(existsSync(started)).toBe(false);
      },
    });
    try {
      expect(observedPid).toBe(launched.child.pid);
      expect(existsSync(started)).toBe(true);
    } finally {
      launched.connection.close();
      if (launched.child.pid !== undefined) process.kill(-launched.child.pid, "SIGKILL");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
