/**
 * BrowserManager lifecycle: launch-failure cleanup, shutdown/launch race, and
 * fallback temp-profile safety. launchBrowser is mocked so these run without a
 * real Chromium; the proxy and profile-dir handling are exercised for real.
 *
 * Revert-sensitivity:
 *  - #7: reverting the launch try/catch to leave mkdirSync unguarded means the
 *    proxy is NOT stopped on a profile-dir failure → the stop() spy is never
 *    called → red.
 *  - #8: reverting closeAll to not await #launching means a browser that
 *    finishes launching mid-shutdown survives → running stays true / the child
 *    is never killed → red.
 *  - #9: reverting the temp profile to the predictable pid+timestamp path means
 *    the dir name contains the pid → the not-predictable assertion → red.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { launchBrowserMock, terminationSeam } = vi.hoisted(() => ({
  launchBrowserMock: vi.fn(),
  terminationSeam: {
    failuresRemaining: 0,
    calls: [] as string[],
  },
}));

vi.mock("../../src/browser/cdp.js", () => ({
  launchBrowser: launchBrowserMock,
  CdpConnection: class {},
}));

vi.mock("../../src/utils/supervisedProcess.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/utils/supervisedProcess.js")
  >();
  return {
    ...actual,
    terminateProcessTreeAndWait: async (
      ...args: Parameters<typeof actual.terminateProcessTreeAndWait>
    ): Promise<void> => {
      terminationSeam.calls.push(args[1]?.label ?? "process");
      if (terminationSeam.failuresRemaining > 0) {
        terminationSeam.failuresRemaining -= 1;
        throw new Error("injected process-tree cleanup failure");
      }
      await actual.terminateProcessTreeAndWait(...args);
    },
  };
});

import {
  BrowserManager,
  closeAllBrowserManagers,
} from "../../src/browser/manager.js";
import { BrowserProxy } from "../../src/browser/proxy.js";
import type { BrowserPolicy } from "../../src/browser/config.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";

const BASE_POLICY: BrowserPolicy = {
  headless: true,
  allowPrivateNetwork: false,
  noSandbox: false,
  navigationTimeoutMs: 30_000,
  executablePath: process.execPath, // exists, so executable resolution passes
};

const managers: BrowserManager[] = [];
function track(mgr: BrowserManager): BrowserManager {
  managers.push(mgr);
  return mgr;
}

afterEach(async () => {
  terminationSeam.failuresRemaining = 0;
  while (managers.length > 0) {
    await managers.pop()?.closeAll().catch(() => {});
  }
  await closeAllBrowserManagers().catch(() => {});
  terminationSeam.calls = [];
  launchBrowserMock.mockReset();
});

interface FakeChild extends EventEmitter {
  kill(signal?: string): boolean;
  exitCode: number | null;
  signalCode: string | null;
  killed: boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = (_signal?: string): boolean => {
    child.killed = true;
    child.exitCode = 0;
    setImmediate(() => child.emit("exit", 0, null));
    return true;
  };
  return child;
}

function makeFakeConnection(): {
  closed: boolean;
  close(): void;
  send(): Promise<Record<string, unknown>>;
} {
  return {
    closed: false,
    close(): void {
      this.closed = true;
    },
    send: async () => ({}),
  };
}

function listTempProfiles(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith("agenc-browser-"));
}

const tick = (ms = 50): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await tick(10);
  }
}

interface SpawnedTree {
  readonly child: ChildProcess;
  readonly dir: string;
  readonly marker: string;
}

function spawnTermResistantTree(exitLeaderWhenReady = false): SpawnedTree {
  const dir = mkdtempSync(join(tmpdir(), "agenc-browser-tree-"));
  const marker = join(dir, "tree.json");
  const descendant = `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  leader: process.ppid,
  descendant: process.pid,
}));
setInterval(() => {}, 1000);
`;
  const leader = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
  stdio: "ignore",
});
function ready() {
  if (!fs.existsSync(${JSON.stringify(marker)})) {
    setTimeout(ready, 5);
    return;
  }
  ${exitLeaderWhenReady ? "process.exit(23);" : "setInterval(() => {}, 1000);"}
}
ready();
`;
  return {
    child: spawn(process.execPath, ["-e", leader], {
      stdio: "ignore",
      detached: true,
    }),
    dir,
    marker,
  };
}

function readDescendant(marker: string): number {
  return (JSON.parse(readFileSync(marker, "utf8")) as { descendant: number })
    .descendant;
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

function cleanupTree(tree: SpawnedTree): void {
  if (tree.child.pid !== undefined) {
    try {
      process.kill(-tree.child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  if (existsSync(tree.marker)) {
    try {
      process.kill(readDescendant(tree.marker), "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  rmSync(tree.dir, { recursive: true, force: true });
}

describe("BrowserManager launch failure", () => {
  test("stops the proxy when profile-dir creation fails", async () => {
    const stopSpy = vi.spyOn(BrowserProxy.prototype, "stop");
    // /dev/null is a char device, so mkdirSync under it throws ENOTDIR.
    const mgr = track(
      new BrowserManager({
        policy: { ...BASE_POLICY, profileDir: "/dev/null/nope" },
      }),
    );
    await expect(mgr.page()).rejects.toBeTruthy();
    expect(stopSpy).toHaveBeenCalled();
    expect(launchBrowserMock).not.toHaveBeenCalled();
    stopSpy.mockRestore();
  });
});

describe("BrowserManager shutdown/launch race", () => {
  const testPosix = process.platform === "win32" ? test.skip : test;

  test("closeAll tears down a browser that finished launching mid-shutdown", async () => {
    const child = makeFakeChild();
    let resolveLaunch!: (value: { child: FakeChild; connection: unknown }) => void;
    launchBrowserMock.mockReturnValue(
      new Promise((resolve) => {
        resolveLaunch = resolve;
      }),
    );

    const mgr = track(new BrowserManager({ policy: BASE_POLICY }));
    // Trigger launch; page() parks on the pending launchBrowser.
    const launchTriggered = mgr.page().catch(() => {});
    await tick(); // let #launch reach the launchBrowser await

    // Shutdown races the in-flight launch.
    const closing = mgr.closeAll();
    // The launch now completes, bringing up the (fake) child + connection.
    resolveLaunch({ child, connection: makeFakeConnection() });
    await closing;
    await launchTriggered;

    expect(child.killed).toBe(true);
    expect(mgr.running).toBe(false);
  });

  testPosix(
    "closeAll kills a TERM-resistant descendant before returning",
    async () => {
      const tree = spawnTermResistantTree();
      const mgr = track(new BrowserManager({ policy: BASE_POLICY }));
      try {
        launchBrowserMock.mockResolvedValue({
          child: tree.child,
          connection: makeFakeConnection(),
        });
        await mgr.page().catch(() => {});
        await waitFor(() => existsSync(tree.marker));
        expect(existsSync(tree.marker)).toBe(true);
        const descendant = readDescendant(tree.marker);
        expect(isLivePid(descendant)).toBe(true);

        await mgr.closeAll();
        await waitFor(() => !isLivePid(descendant));

        expect(isLivePid(descendant)).toBe(false);
      } finally {
        await mgr.closeAll().catch(() => {});
        cleanupTree(tree);
      }
    },
    10_000,
  );

  testPosix(
    "waits for unexpected-exit tree cleanup before relaunching",
    async () => {
      const tree = spawnTermResistantTree(true);
      const replacement = makeFakeChild();
      const mgr = track(new BrowserManager({ policy: BASE_POLICY }));
      let aliveAtRelaunch: boolean | undefined;
      try {
        launchBrowserMock
          .mockResolvedValueOnce({
            child: tree.child,
            connection: makeFakeConnection(),
          })
          .mockImplementationOnce(async () => {
            aliveAtRelaunch = isLivePid(readDescendant(tree.marker));
            return {
              child: replacement,
              connection: makeFakeConnection(),
            };
          });

        await mgr.page().catch(() => {});
        await waitFor(() => existsSync(tree.marker));
        expect(existsSync(tree.marker)).toBe(true);
        await waitFor(() => tree.child.exitCode !== null);
        expect(tree.child.exitCode).not.toBeNull();

        await mgr.page().catch(() => {});

        expect(aliveAtRelaunch).toBe(false);
      } finally {
        await mgr.closeAll().catch(() => {});
        cleanupTree(tree);
      }
    },
    10_000,
  );

  test("poisons a failed browser boundary until explicit cleanup succeeds", async () => {
    const child = makeFakeChild();
    launchBrowserMock.mockResolvedValue({
      child,
      connection: makeFakeConnection(),
    });
    const mgr = track(new BrowserManager({ policy: BASE_POLICY }));
    await mgr.page().catch(() => {});

    terminationSeam.failuresRemaining = 1;
    await expect(mgr.closeAll()).rejects.toThrow(
      "injected process-tree cleanup failure",
    );
    expect(launchBrowserMock).toHaveBeenCalledTimes(1);

    await expect(mgr.page()).rejects.toThrow(
      "injected process-tree cleanup failure",
    );
    expect(launchBrowserMock).toHaveBeenCalledTimes(1);

    await expect(mgr.closeAll()).resolves.toBeUndefined();
    expect(child.killed).toBe(true);
  });

  test("retains failed unexpected-exit cleanup without launching a replacement", async () => {
    const child = makeFakeChild();
    launchBrowserMock.mockResolvedValue({
      child,
      connection: makeFakeConnection(),
    });
    const mgr = track(new BrowserManager({ policy: BASE_POLICY }));
    await mgr.page().catch(() => {});

    terminationSeam.failuresRemaining = 1;
    child.exitCode = 23;
    child.emit("exit", 23, null);
    await waitFor(() => terminationSeam.calls.length === 1);

    await expect(mgr.page()).rejects.toThrow(
      "injected process-tree cleanup failure",
    );
    expect(launchBrowserMock).toHaveBeenCalledTimes(1);

    await expect(mgr.closeAll()).resolves.toBeUndefined();
  });

  test("global shutdown settles every browser manager and aggregates failures", async () => {
    const failedChild = makeFakeChild();
    const successfulChild = makeFakeChild();
    launchBrowserMock
      .mockResolvedValueOnce({
        child: failedChild,
        connection: makeFakeConnection(),
      })
      .mockResolvedValueOnce({
        child: successfulChild,
        connection: makeFakeConnection(),
      });
    const first = track(new BrowserManager({ policy: BASE_POLICY }));
    const second = track(new BrowserManager({ policy: BASE_POLICY }));
    await Promise.all([first.page().catch(() => {}), second.page().catch(() => {})]);

    terminationSeam.failuresRemaining = 1;
    await expect(closeAllBrowserManagers()).rejects.toMatchObject({
      name: "AggregateError",
      message: "browser manager shutdown failed",
    });
    expect(successfulChild.killed).toBe(true);
    expect(terminationSeam.calls).toHaveLength(2);

    await expect(closeAllBrowserManagers()).resolves.toBeUndefined();
    expect(failedChild.killed).toBe(true);
  });
});

describe("BrowserManager fallback temp profile", () => {
  test("uses an unpredictable mkdtemp dir with 0700 perms", async () => {
    launchBrowserMock.mockResolvedValue({
      child: makeFakeChild(),
      connection: makeFakeConnection(),
    });
    const before = new Set(listTempProfiles());
    // No agencHome and no profile_dir → the fallback temp branch.
    const mgr = track(new BrowserManager({ policy: BASE_POLICY }));
    await mgr.page().catch(() => {}); // triggers launch → creates the temp dir

    const created = listTempProfiles().filter((n) => !before.has(n));
    expect(created).toHaveLength(1);
    const name = created[0]!;
    const dir = join(tmpdir(), name);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // The predictable "<pid>-<ts>" name the fix replaced would embed the pid.
    expect(name).not.toContain(String(process.pid));

    await mgr.closeAll();
    expect(existsSync(dir)).toBe(false);
  });

  test("forked browser authorities never reuse the root persistent profile", async () => {
    launchBrowserMock.mockResolvedValue({
      child: makeFakeChild(),
      connection: makeFakeConnection(),
    });
    const rootBroker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: tmpdir(),
    });
    const childBroker = rootBroker.forkForCwd(join(tmpdir(), "child-workspace"));
    const mgr = track(
      new BrowserManager({
        agencHome: join(tmpdir(), "persistent-agenc-home"),
        policy: {
          ...BASE_POLICY,
          profileDir: join(tmpdir(), "configured-root-profile"),
        },
        sandboxExecutionBroker: childBroker,
      }),
    );

    await mgr.page().catch(() => {});

    const launchOptions = launchBrowserMock.mock.calls[0]?.[0] as {
      userDataDir: string;
    };
    expect(launchOptions.userDataDir).toContain("agenc-browser-child-");
    expect(launchOptions.userDataDir).not.toContain("configured-root-profile");
  });
});
