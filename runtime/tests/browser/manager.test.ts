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
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { launchBrowserMock } = vi.hoisted(() => ({
  launchBrowserMock: vi.fn(),
}));

vi.mock("../../src/browser/cdp.js", () => ({
  launchBrowser: launchBrowserMock,
  CdpConnection: class {},
}));

import { BrowserManager } from "../../src/browser/manager.js";
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
  while (managers.length > 0) {
    await managers.pop()?.closeAll().catch(() => {});
  }
  launchBrowserMock.mockReset();
});

interface FakeChild extends EventEmitter {
  kill(signal?: string): boolean;
  exitCode: number | null;
  killed: boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.exitCode = null;
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
