import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CdpError, launchBrowser } from "../../src/browser/cdp.js";
import {
  SandboxExecutionBroker,
  type SandboxPreparedSpawn,
} from "../../src/sandbox/execution-broker.js";
import {
  createFailedSpawnChild,
  type FailedSpawnChild,
} from "../helpers/failed-spawn-child.js";

// launchBrowser read child.stdio[3] and awaited cleanup in its "pipes
// missing" branch before any error listener existed. EMFILE and ENFILE leave
// a failed child's stdio undefined (a TypeError), and a failed child with
// null pipe fds reached the cleanup await; either way Node's next-tick spawn
// error was an uncaught exception in the daemon. The children are stand-ins.

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-cdp-spawn-failure-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function brokerReturning(child: FailedSpawnChild): SandboxExecutionBroker {
  const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: dir });
  vi.spyOn(broker, "prepareSpawn").mockImplementation((_surface, command) => {
    const signal = new AbortController().signal;
    return {
      run: (operation) => operation(command, signal),
      start: (operation) => operation(command, signal).value,
      runSync: (operation) => operation(command),
      spawnLifecycleParticipant: () => child as never,
    } satisfies SandboxPreparedSpawn;
  });
  return broker;
}

function launch(broker: SandboxExecutionBroker) {
  return launchBrowser({
    executablePath: "/opt/chromium/chrome",
    userDataDir: join(dir, "profile"),
    headless: true,
    noSandbox: false,
    proxyPort: 4567,
    sandboxExecutionBroker: broker,
  });
}

describe("launchBrowser with a failed spawn", () => {
  test("a spawn that left no stdio reports the spawn error, not a TypeError", async () => {
    const failed = createFailedSpawnChild({
      code: "EMFILE",
      command: "/opt/chromium/chrome",
    });

    const launched = launch(brokerReturning(failed));

    await expect(launched).rejects.toBeInstanceOf(CdpError);
    await expect(launched).rejects.toThrow(/failed to spawn browser: .*EMFILE/u);
    await failed.reported;
    expect(failed.uncaught).toEqual([]);
    expect(failed.groupSignals).toEqual([]);
  });

  test("a failed child with null CDP pipe fds is cleaned up without an uncaught error", async () => {
    const failed = createFailedSpawnChild({
      code: "ENOENT",
      command: "/opt/chromium/chrome",
    });
    // Pipes 0, 1, 3 and 4 were never created; stderr was.
    Object.assign(failed, {
      stdio: [null, null, new PassThrough(), null, null],
      stdin: null,
      stdout: null,
    });

    await expect(launch(brokerReturning(failed))).rejects.toBeInstanceOf(CdpError);
    await failed.reported;
    expect(failed.uncaught).toEqual([]);
    expect(failed.groupSignals).toEqual([]);
  });
});
