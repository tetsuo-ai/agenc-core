import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createNodeDaemonCliHost, requestAgenCDaemonShutdown, statusAgenCDaemon,
  resolveAgenCDaemonPidPath, readAgenCDaemonPid,
} from "../../src/app-server/daemon-control.js";
import { daemonInstanceIdentityFromRuntimeInfo, readDaemonRuntimeInfo, resolveAgenCDaemonRuntimeInfoPath } from "../../src/app-server/daemon-runtime-info.js";

// A FIFO open with no writer occupies libuv forever, just like an unanswered
// macOS privacy prompt. Run the actual daemon and CLI exit boundary in a child.
describe.skipIf(process.platform === "win32")("daemon exit with a blocked filesystem worker", () => {
  it.each(["exit", "status"])("bounds acknowledged shutdown with a stuck worker (%s)", async (check) => {
    const home = await mkdtemp(join(tmpdir(), "agenc-blocked-exit-"));
    const fifo = join(home, "blocked-open");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const daemonUrl = new URL("../../src/app-server/daemon-cli.ts", import.meta.url).href;
    const mainUrl = new URL("../../src/bin/cli-process-main.ts", import.meta.url).href;
    const script = `
      import { open, readFileSync } from 'node:fs';
      import { registerHooks } from 'node:module';
      registerHooks({ load(url, context, next) {
        if (url.endsWith('.md')) return {
          format: 'module', shortCircuit: true,
          source: 'export default ' + JSON.stringify(readFileSync(new URL(url), 'utf8')),
        };
        return next(url, context);
      }});
      const { runAgenCDaemonCli } = await import(${JSON.stringify(daemonUrl)});
      const { runCliProcessMain } = await import(${JSON.stringify(mainUrl)});
      await runCliProcessMain(async () => {
        const code = await runAgenCDaemonCli({ kind: 'command', action: 'run' }, {
          enterDaemonHome: true,
          requireNativePeerCredentialForConnections: false,
          beforeDaemonReady: async () => {
            open(${JSON.stringify(fifo)}, 'r', () => { throw new Error('FIFO unexpectedly opened'); });
            await new Promise(resolve => setTimeout(resolve, 100));
          },
        });
        console.log('CLEANED');
        return code;
      });`;
    const env = { ...process.env, AGENC_HOME: home, AGENC_DAEMON_WEBSOCKET_PORT: "0" };
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => { output += String(data); });
    child.stderr.on("data", (data) => { output += String(data); });
    const exited = once(child, "exit");
    try {
      const host = { ...createNodeDaemonCliHost(), env };
      const pidPath = resolveAgenCDaemonPidPath(env, home);
      await expect.poll(async () => {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(output);
        return readAgenCDaemonPid(pidPath);
      }, { timeout: 15_000, message: output }).toBe(child.pid);
      const identity = daemonInstanceIdentityFromRuntimeInfo(readDaemonRuntimeInfo(resolveAgenCDaemonRuntimeInfoPath(home)));
      expect(identity).not.toBeNull();
      const started = Date.now();
      await requestAgenCDaemonShutdown(host, identity!);
      await expect.poll(() => output, { timeout: 5_000 }).toContain("CLEANED");
      let status = "";
      const sink = { write: (chunk: string | Uint8Array) => { status += String(chunk); return true; } };
      if (check === "status" && child.exitCode === null && child.signalCode === null) {
        await statusAgenCDaemon(host, { stdout: sink, stderr: sink });
        expect(status).not.toContain("AgenC daemon stopped");
      }
      await expect.poll(() => child.exitCode !== null || child.signalCode !== null, {
        timeout: 6_000, message: output,
      }).toBe(true);
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(child.signalCode).toBe("SIGKILL");
      status = "";
      await statusAgenCDaemon(host, { stdout: sink, stderr: sink });
      expect(status).toContain("AgenC daemon stopped");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});
