import childProcess, { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { armDaemonExitWatchdog } from "../../src/app-server/daemon-exit-watchdog.js";

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe.skipIf(process.platform === "win32")("daemon final exit watchdog", () => {
  it("refuses to signal a live process that is not its parent", async () => {
    let command: Parameters<typeof spawn> | undefined;
    const fake = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), unref: vi.fn(), kill: vi.fn(),
    });
    vi.spyOn(childProcess, "spawn").mockImplementation((...args: Parameters<typeof spawn>) => {
      command = args;
      queueMicrotask(() => fake.stdout.end("armed\n"));
      return fake as unknown as ReturnType<typeof spawn>;
    });
    syncBuiltinESMExports();
    await armDaemonExitWatchdog();
    expect(command?.[2]).toMatchObject({ cwd: "/", detached: true, env: { PATH: "/usr/bin:/bin" } });
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = once(unrelated, "exit");
    try {
      const script = command![1]![1] as string;
      const helper = spawnSync(process.execPath, ["-e", script, String(unrelated.pid), "20"], {
        encoding: "utf8", timeout: 2_000,
      });
      expect(helper.status, helper.stderr).toBe(0);
      expect(helper.stdout).toBe("");
      expect(unrelated.exitCode).toBeNull();
      expect(unrelated.signalCode).toBeNull();
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    } finally {
      unrelated.kill("SIGKILL");
      await exited;
    }
  });

  it.each([false, true])("preserves normal exit or forces self-exit when watchdog spawn fails (%s)", (failSpawn) => {
    const source = new URL("../../src/app-server/daemon-exit-watchdog.ts", import.meta.url).href;
    const script = `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { armDaemonExitWatchdog } from ${JSON.stringify(source)};
      if (${failSpawn}) {
        childProcess.spawn = () => { throw new Error('EAGAIN'); };
        syncBuiltinESMExports();
      }
      await armDaemonExitWatchdog();
      console.log('durable cleanup complete');
      process.exit(7);
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 5_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.stdout).toBe("durable cleanup complete\n");
    if (failSpawn) expect(child.signal).toBe("SIGKILL");
    else expect(child.status, child.stderr).toBe(7);
  });
});
