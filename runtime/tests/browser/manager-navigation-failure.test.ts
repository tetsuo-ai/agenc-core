import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const { launchBrowserMock, markerReadSeam } = vi.hoisted(() => ({
  launchBrowserMock: vi.fn(),
  markerReadSeam: { path: "", replace: undefined as undefined | (() => void) },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], ...args: unknown[]) => {
      const result = (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...args);
      if (String(path) === markerReadSeam.path && markerReadSeam.replace !== undefined) {
        const replace = markerReadSeam.replace;
        markerReadSeam.replace = undefined;
        replace();
      }
      return result;
    }) as typeof actual.readFileSync,
  };
});
vi.mock("../../src/browser/cdp.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/browser/cdp.js")>(),
  launchBrowser: launchBrowserMock,
}));
vi.mock("../../src/browser/proxy.js", () => ({
  BrowserProxy: class {
    async start() { return 4321; }
    async stop() {}
    takeBlockReason() { return undefined; }
  },
}));
vi.mock("../../src/utils/supervisedProcess.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/utils/supervisedProcess.js")>(),
  terminateProcessTreeAndWait: vi.fn(async () => {}),
  signalProcessTree: vi.fn(),
}));
vi.mock("../../src/session/runtime-options.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/session/runtime-options.js")>(),
  resolveSessionTempRoot: () => profileRoot,
}));

import { BrowserManager } from "../../src/browser/manager.js";
import { CdpError, type CdpConnection, type CdpSendOptions } from "../../src/browser/cdp.js";
import { readBrowserNavigationFailureReceipt } from "../../src/browser/page.js";
import { createBrowserTool } from "../../src/tools/BrowserTool/tool.js";
import {
  SandboxExecutionBroker,
  attachSandboxExecutionBroker,
} from "../../src/sandbox/execution-broker.js";
import { disposeSandboxExecutionBroker } from "../../src/sandbox/execution-lifecycle.js";
import { runAdmittedToolCall } from "../../src/budget/admitted-tool-call.js";
import { bindAdmittedToolHarness } from "../helpers/admitted-tool-harness.js";

let profileRoot = "";
const managers: BrowserManager[] = [];
const PROFILE_MARKER = ".agenc-profile-owner";
const PROFILE_RECOVERY_MARKER = ".agenc-profile-recovery";

beforeEach(async () => {
  profileRoot = await mkdtemp(join(tmpdir(), "agenc-browser-navigation-test-"));
});
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.closeAll();
  await rm(profileRoot, { recursive: true, force: true });
  launchBrowserMock.mockReset();
  markerReadSeam.path = "";
  markerReadSeam.replace = undefined;
  vi.restoreAllMocks();
});

function fakeManager(navigation: (options: CdpSendOptions) => Promise<Record<string, unknown>>, profileDir?: string) {
  let created = 0;
  let currentUrl = "about:blank";
  const connection = {
    closed: false,
    close() { this.closed = true; },
    on: vi.fn(() => () => {}),
    waitFor: vi.fn(async () => ({})),
    send: vi.fn(async (
      method: string,
      params: Record<string, unknown> = {},
      _sessionId?: string,
      options: CdpSendOptions = {},
    ): Promise<Record<string, unknown>> => {
      if (options.signal?.aborted) throw new CdpError(`CDP command aborted: ${method}`);
      if (method === "Target.createTarget") return { targetId: `target-${++created}` };
      if (method === "Target.attachToTarget") return { sessionId: `session-${created}` };
      if (method === "Page.navigate") {
        const result = await navigation(options);
        currentUrl = result.errorText ? "chrome-error://chromewebdata/" : String(params.url);
        return result;
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: JSON.stringify({ url: currentUrl, title: "Test tab" }) } };
      }
      return {};
    }),
  };
  launchBrowserMock.mockResolvedValue({
    child: new EventEmitter() as ChildProcess,
    connection: connection as unknown as CdpConnection,
  });
  const manager = new BrowserManager({
    agencHome: profileRoot,
    policy: {
      executablePath: process.execPath,
      headless: true, allowPrivateNetwork: false, noSandbox: false, navigationTimeoutMs: 1_000,
      ...(profileDir !== undefined ? { profileDir } : {}),
    },
  });
  managers.push(manager);
  return { manager, connection };
}

describe("failed browser navigation retains its target", () => {
  it("keeps a first failed navigation inspectable and reuses its tab on the next navigate", async () => {
    const response = vi.fn()
      .mockResolvedValueOnce({ frameId: "frame-1", errorText: "net::ERR_HTTP2_PROTOCOL_ERROR" })
      .mockResolvedValue({ frameId: "frame-1" });
    const { manager, connection } = fakeManager(response);
    const error = await manager.navigate("https://example.com/first").catch((failure: unknown) => failure);
    expect(readBrowserNavigationFailureReceipt(error)).toMatchObject({
      targetId: "target-1", sessionId: "session-1", errorText: "net::ERR_HTTP2_PROTOCOL_ERROR",
    });
    expect(await manager.listTabs()).toEqual([{
      id: 1, active: true, title: "Test tab", url: "chrome-error://chromewebdata/",
    }]);
    await manager.navigate("https://example.com/second");
    expect(await manager.listTabs()).toMatchObject([{ id: 1, url: "https://example.com/second" }]);
    expect(connection.send.mock.calls.filter(([method]) => method === "Target.createTarget")).toHaveLength(1);
  });

  it("keeps a new_tab navigation failure addressable by its tab id", async () => {
    const { manager, connection } = fakeManager(async () => ({ errorText: "net::ERR_HTTP2_PROTOCOL_ERROR" }));
    await expect(manager.newTab("https://example.com/first")).rejects.toThrow("navigation failed");
    expect(await manager.listTabs()).toHaveLength(1);
    await manager.closeTab(1);
    expect(connection.send).toHaveBeenCalledWith("Target.closeTarget", { targetId: "target-1" });
    expect(await manager.listTabs()).toEqual([]);
  });

  it.each(["navigate", "new_tab"] as const)("propagates the caller signal throughout first %s", async (action) => {
    const { manager, connection } = fakeManager(async () => ({ frameId: "frame-1" }));
    const controller = new AbortController();
    if (action === "navigate") await manager.navigate("https://example.com/", undefined, controller.signal);
    else await manager.newTab("https://example.com/", controller.signal);
    for (const method of ["Target.createTarget", "Target.attachToTarget", "Page.enable", "Runtime.enable", "DOM.enable", "Page.navigate"]) {
      const call = connection.send.mock.calls.find(([called]) => called === method);
      expect(call?.[3]?.signal, method).toBe(controller.signal);
    }
  });

  it("keeps a first-navigation abort unknown and its already-created tab tracked", async () => {
    const started = Promise.withResolvers<void>();
    const { manager } = fakeManager(async (options) => new Promise((_resolve, reject) => {
      started.resolve();
      if (!options.signal) {
        reject(new Error("missing caller signal"));
        return;
      }
      options.signal.addEventListener("abort", () => reject(new CdpError("CDP command aborted: Page.navigate")), { once: true });
    }));
    const controller = new AbortController();
    const pending = manager.navigate("https://example.com/", undefined, controller.signal)
      .catch((error: unknown) => error);
    await started.promise;
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(CdpError);
    expect(readBrowserNavigationFailureReceipt(error)).toBeUndefined();
    expect(await manager.listTabs()).toHaveLength(1);
  });
});

// Live run (luna-mac F2): GPT models fill every optional field, so the first
// navigate arrived with "tab_id":0 and was answered "no open tabs", which was
// filed as an unknown outcome and refused the next Browser call until /resolve.
describe("tab ids a model fills in", () => {
  const brokers: SandboxExecutionBroker[] = [];
  afterEach(async () => {
    for (const broker of brokers.splice(0)) await disposeSandboxExecutionBroker(broker);
  });

  function browserTool(manager: BrowserManager) {
    const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: process.cwd() });
    brokers.push(broker);
    const tool = createBrowserTool({ manager });
    const call = (args: Record<string, unknown>) => {
      const withBroker = { ...args };
      attachSandboxExecutionBroker(withBroker, broker, "browser");
      return withBroker;
    };
    return { tool, call };
  }

  it("treats tab_id 0 as the default tab and opens the first page", async () => {
    const { manager } = fakeManager(async () => ({ frameId: "frame-1" }));
    const { tool, call } = browserTool(manager);
    const harness = bindAdmittedToolHarness({ workspaceRoot: process.cwd(), label: "browser-tab-zero" });
    const dispatch = (callId: string, args: Record<string, unknown>) => {
      const prepared = call(args);
      return runAdmittedToolCall({
        session: harness.session, tool, args: prepared,
        turnId: "turn-browser-tab-zero", callId,
        invoke: async ({ crossEffectBoundary }) => { crossEffectBoundary(); return tool.execute(prepared); },
      });
    };
    const first = await dispatch("filled-navigate", { action: "navigate", url: "https://example.com/", tab_id: 0 });
    expect(first.isError, String(first.content)).not.toBe(true);
    expect(first.content).toContain("Navigated to https://example.com/");
    const snapshot = await dispatch("filled-snapshot", { action: "snapshot", tab_id: 0 });
    expect(snapshot.isError, String(snapshot.content)).not.toBe(true);
    expect(harness.events.filter((event) => event.msg.type === "effect_unknown_outcome")).toHaveLength(0);
    expect(await manager.listTabs()).toMatchObject([{ id: 1, active: true }]);
  });

  it("refuses an unknown tab id with no effect so the next call still runs", async () => {
    const { manager } = fakeManager(async () => ({ frameId: "frame-1" }));
    const { tool, call } = browserTool(manager);
    const harness = bindAdmittedToolHarness({ workspaceRoot: process.cwd(), label: "browser-tab-unknown" });
    const dispatch = (callId: string, args: Record<string, unknown>) => {
      const prepared = call(args);
      return runAdmittedToolCall({
        session: harness.session, tool, args: prepared,
        turnId: "turn-browser-tab-unknown", callId,
        invoke: async ({ crossEffectBoundary }) => { crossEffectBoundary(); return tool.execute(prepared); },
      });
    };
    for (const [callId, args] of [
      ["no-tabs-yet", { action: "snapshot" }],
      ["navigate-missing-tab", { action: "navigate", url: "https://example.com/", tab_id: 7 }],
    ] as const) {
      const refused = await dispatch(callId, args);
      expect(refused.isError).toBe(true);
      expect(refused.effectDisposition?.disposition, callId).toBe("confirmed_no_effect");
    }
    expect(launchBrowserMock).not.toHaveBeenCalled();
    expect(existsSync(join(profileRoot, "browser", "profile"))).toBe(false);
    const opened = await dispatch("first-navigate", { action: "navigate", url: "https://example.com/" });
    expect(opened.isError, String(opened.content)).not.toBe(true);
    for (const [callId, args] of [
      ["snapshot-missing-tab", { action: "snapshot", tab_id: 9 }],
      ["click-missing-tab", { action: "click", ref: "e1", tab_id: 9 }],
      ["close-missing-tab", { action: "close_tab", tab_id: 9 }],
    ] as const) {
      const refused = await dispatch(callId, args);
      expect(refused.isError).toBe(true);
      expect(String(refused.content)).toMatch(/no tab with id 9/);
      expect(refused.effectDisposition?.disposition, callId).toBe("confirmed_no_effect");
    }
    expect(harness.events.filter((event) => event.msg.type === "effect_unknown_outcome")).toHaveLength(0);
    await expect(dispatch("after-refusals", { action: "snapshot" })).resolves.toMatchObject({
      content: expect.any(String),
    });
    expect(await manager.listTabs()).toMatchObject([{ id: 1 }]);
  });

  it("requires a real tab id for select_tab and close_tab", async () => {
    const { manager } = fakeManager(async () => ({ frameId: "frame-1" }));
    const { tool, call } = browserTool(manager);
    for (const action of ["select_tab", "close_tab"] as const) {
      const refused = await tool.execute(call({ action, tab_id: 0 }));
      expect(refused.isError).toBe(true);
      expect(refused.content).toBe(`${action} requires tab_id`);
      expect(refused.effectDisposition?.disposition).toBe("confirmed_no_effect");
    }
    expect(launchBrowserMock).not.toHaveBeenCalled();
  });
});

// Live run (luna-mac F2): every session's manager launched Chromium on the one
// persistent profile. A second session's launch handed itself to the first
// session's still-running browser through the profile's SingletonLock and
// exited, so it failed with "browser did not establish a CDP pipe: CDP pipe
// closed" until the first browser idled out five minutes later.
describe("one shared profile across sessions", () => {
  const launchedProfiles = (): string[] =>
    launchBrowserMock.mock.calls.map(
      ([options]) => (options as { userDataDir: string }).userDataDir,
    );

  it("gives a concurrent session its own profile and frees the shared one on close", async () => {
    const persistent = join(profileRoot, "browser", "profile");
    const { manager: first } = fakeManager(async () => ({ frameId: "frame-1" }));
    const { manager: second } = fakeManager(async () => ({ frameId: "frame-1" }));
    await Promise.all([first.newTab(), second.newTab()]);

    const [firstProfile, secondProfile] = launchedProfiles();
    expect([firstProfile, secondProfile]).toContain(persistent);
    const firstHoldsShared = firstProfile === persistent;
    const isolated = firstHoldsShared ? secondProfile! : firstProfile!;
    expect(isolated).not.toBe(persistent);
    expect(statSync(isolated).mode & 0o777).toBe(0o700);
    expect(existsSync(join(isolated, PROFILE_MARKER))).toBe(true);

    await (firstHoldsShared ? second : first).closeAll();
    expect(existsSync(isolated)).toBe(false);
    expect(existsSync(persistent)).toBe(true);

    await (firstHoldsShared ? first : second).closeAll();
    expect(existsSync(join(persistent, PROFILE_MARKER))).toBe(false);
    const { manager: third } = fakeManager(async () => ({ frameId: "frame-1" }));
    await third.newTab();
    expect(launchedProfiles()[2]).toBe(persistent);
  });

  it("claims the shared profile before another daemon can launch on it", async () => {
    const persistent = join(profileRoot, "browser", "profile");
    const { manager: first } = fakeManager(async () => ({ frameId: "frame-1" }));
    await first.newTab();
    expect(existsSync(join(persistent, PROFILE_MARKER))).toBe(true);

    // Reloading this module gives the next manager a separate holder map, as
    // it would have in another daemon.
    vi.resetModules();
    const { BrowserManager: OtherDaemonBrowserManager } = await import("../../src/browser/manager.js");
    const second = new OtherDaemonBrowserManager({
      agencHome: profileRoot,
      policy: {
        executablePath: process.execPath,
        headless: true, allowPrivateNetwork: false, noSandbox: false, navigationTimeoutMs: 1_000,
      },
    });
    managers.push(second);
    await second.newTab();
    expect(launchedProfiles()).toHaveLength(2);
    expect(launchedProfiles()[0]).toBe(persistent);
    expect(launchedProfiles()[1]).not.toBe(persistent);
  });

  it("reclaims a shared profile after a recovery owner dies", async () => {
    const persistent = join(profileRoot, "browser", "profile");
    mkdirSync(persistent, { recursive: true, mode: 0o700 });
    const exited = spawnSync(process.execPath, ["-e", ""]);
    for (const name of [PROFILE_MARKER, PROFILE_RECOVERY_MARKER]) {
      const path = join(persistent, name);
      writeFileSync(path, JSON.stringify({
        pid: exited.pid, startedAt: Date.now() - 10_000, id: `dead-${name}`,
      }));
      const old = new Date(Date.now() - 90_000);
      utimesSync(path, old, old);
    }
    const { manager } = fakeManager(async () => ({ frameId: "frame-1" }));
    await manager.newTab();
    expect(launchedProfiles()[0]).toBe(persistent);
    expect(existsSync(join(persistent, PROFILE_RECOVERY_MARKER))).toBe(false);
  });

  it("keeps a replacement recovery marker when the dead owner check races a new claim", async () => {
    const persistent = join(profileRoot, "browser", "profile");
    mkdirSync(persistent, { recursive: true, mode: 0o700 });
    const recoveryPath = join(persistent, PROFILE_RECOVERY_MARKER);
    const deadPid = 999_999_991;
    writeFileSync(recoveryPath, JSON.stringify({
      pid: deadPid, startedAt: Date.now() - 10_000, id: "old-recovery",
    }));
    const replacement = JSON.stringify({
      pid: process.pid, startedAt: Date.now(), id: "new-recovery",
    });
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === deadPid && signal === 0) {
        writeFileSync(recoveryPath, replacement);
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
      return realKill(pid, signal);
    });
    const { manager } = fakeManager(async () => ({ frameId: "frame-1" }));
    await manager.newTab();
    expect(launchedProfiles()[0]).not.toBe(persistent);
    expect(readFileSync(recoveryPath, "utf8")).toBe(replacement);
    kill.mockRestore();
  });

  it("refuses to overwrite a claim replaced after reading its identity", async () => {
    const persistent = join(profileRoot, "browser", "profile");
    const path = join(persistent, PROFILE_MARKER);
    const { manager, connection } = fakeManager(async () => ({ frameId: "frame-1" }));
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, "pid", { value: process.pid });
    let replacement = "";
    markerReadSeam.path = path;
    markerReadSeam.replace = () => {
      const claimed = JSON.parse(readFileSync(path, "utf8")) as {
        pid: number; startedAt: number; id: string;
      };
      replacement = JSON.stringify({ ...claimed, id: "other-claim" });
      writeFileSync(path, replacement);
    };
    launchBrowserMock.mockImplementationOnce(async (options: {
      onSpawn?: (child: ChildProcess) => void;
    }) => {
      options.onSpawn?.(child);
      return { child, connection };
    });
    await expect(manager.newTab()).rejects.toThrow("browser profile claim changed");
    expect(readFileSync(path, "utf8")).toBe(replacement);
  });

  it("reclaims an old empty claim left by a crash before the marker write", async () => {
    const persistent = join(profileRoot, "browser", "profile");
    mkdirSync(persistent, { recursive: true, mode: 0o700 });
    const path = join(persistent, PROFILE_MARKER);
    writeFileSync(path, "");
    const old = new Date(Date.now() - 90_000);
    utimesSync(path, old, old);
    const { manager } = fakeManager(async () => ({ frameId: "frame-1" }));
    await manager.newTab();
    expect(launchedProfiles()[0]).toBe(persistent);
  });

  it.skipIf(process.platform === "win32")("does not reclaim a dead daemon's claim while its detached browser is still starting", async () => {
    const persistent = join(profileRoot, "browser", "profile");
    mkdirSync(persistent, { recursive: true, mode: 0o700 });
    const exited = spawnSync(process.execPath, ["-e", ""]);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true, stdio: "ignore",
    });
    try {
      writeFileSync(join(persistent, PROFILE_MARKER), JSON.stringify({
        pid: exited.pid, startedAt: Date.now() - 10_000, browserPid: child.pid,
      }));
      const { manager } = fakeManager(async () => ({ frameId: "frame-1" }));
      await manager.newTab();
      expect(existsSync(join(persistent, "SingletonLock"))).toBe(false);
      expect(launchedProfiles()[0]).not.toBe(persistent);
    } finally {
      if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
    }
  });

  it("reclaims a marker whose live pid belongs to a different process", async () => {
    const persistent = join(profileRoot, "browser", "profile");
    mkdirSync(persistent, { recursive: true, mode: 0o700 });
    writeFileSync(join(persistent, PROFILE_MARKER), JSON.stringify({
      pid: process.pid, startedAt: Date.now() - 60_000,
    }));
    const old = new Date(Date.now() - 90_000);
    utimesSync(join(persistent, PROFILE_MARKER), old, old);
    const { manager } = fakeManager(async () => ({ frameId: "frame-1" }));
    await manager.newTab();
    expect(launchedProfiles()[0]).toBe(persistent);
  });

  it.skipIf(process.platform === "win32")("removes a private profile whose owner pid was reused", async () => {
    const privateDir = await mkdtemp(join(profileRoot, "agenc-browser-"));
    writeFileSync(join(privateDir, PROFILE_MARKER), JSON.stringify({
      pid: process.pid, startedAt: Date.now() - 60_000,
    }));
    const old = new Date(Date.now() - 90_000);
    utimesSync(join(privateDir, PROFILE_MARKER), old, old);
    const { manager } = fakeManager(async () => ({ frameId: "frame-1" }));
    await manager.newTab();
    expect(existsSync(privateDir)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("keeps a dead daemon's private profile while its detached browser is starting", async () => {
    const privateDir = await mkdtemp(join(profileRoot, "agenc-browser-"));
    const exited = spawnSync(process.execPath, ["-e", ""]);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true, stdio: "ignore",
    });
    try {
      writeFileSync(join(privateDir, PROFILE_MARKER), JSON.stringify({
        pid: exited.pid, startedAt: Date.now() - 90_000, browserPid: child.pid,
      }));
      const { manager } = fakeManager(async () => ({ frameId: "frame-1" }));
      await manager.newTab();
      expect(existsSync(privateDir)).toBe(true);
    } finally {
      if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
    }
  });

  it("waits for the unrecorded child startup window before reclaiming a dead claim", async () => {
    const persistent = join(profileRoot, "browser", "profile");
    mkdirSync(persistent, { recursive: true, mode: 0o700 });
    const exited = spawnSync(process.execPath, ["-e", ""]);
    writeFileSync(join(persistent, PROFILE_MARKER), JSON.stringify({
      pid: exited.pid, startedAt: Date.now() - 10_000,
    }));
    const { manager } = fakeManager(async () => ({ frameId: "frame-1" }));
    await manager.newTab();
    expect(launchedProfiles()[0]).not.toBe(persistent);
  });

  it.skipIf(process.platform === "win32")("reclaims a dead gated claim before Chromium was released", async () => {
    const persistent = join(profileRoot, "browser", "profile");
    mkdirSync(persistent, { recursive: true, mode: 0o700 });
    const exited = spawnSync(process.execPath, ["-e", ""]);
    writeFileSync(join(persistent, PROFILE_MARKER), JSON.stringify({
      pid: exited.pid, startedAt: Date.now() - 10_000, gated: true,
    }));
    const { manager } = fakeManager(async () => ({ frameId: "frame-1" }));
    await manager.newTab();
    expect(launchedProfiles()[0]).toBe(persistent);
  });

  it("records the spawned browser pid in the shared claim before CDP is ready", async () => {
    const persistent = join(profileRoot, "browser", "profile");
    const { manager, connection } = fakeManager(async () => ({ frameId: "frame-1" }));
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, "pid", { value: process.pid });
    launchBrowserMock.mockImplementationOnce(async (options: {
      onSpawn?: (child: ChildProcess) => void;
    }) => {
      options.onSpawn?.(child);
      expect(JSON.parse(readFileSync(join(persistent, PROFILE_MARKER), "utf8"))).toMatchObject({
        browserPid: process.pid,
      });
      return { child, connection };
    });
    await manager.newTab();
  });

  it.skipIf(process.platform === "win32")("keeps a private profile while its daemon is launching", async () => {
    const launching = await mkdtemp(join(profileRoot, "agenc-browser-child-"));
    writeFileSync(join(launching, PROFILE_MARKER), JSON.stringify({
      pid: process.pid,
      startedAt: Date.now() - process.uptime() * 1_000,
    }));
    const { manager } = fakeManager(async () => ({ frameId: "frame-1" }));
    await manager.newTab();
    expect(existsSync(launching)).toBe(true);
  });

  it("leaves a profile to the live Chromium that holds its SingletonLock", async () => {
    if (process.platform === "win32") {
      expect(process.platform).toBe("win32");
      return;
    }
    const persistent = join(profileRoot, "browser", "profile");
    mkdirSync(persistent, { recursive: true, mode: 0o700 });
    const lock = join(persistent, "SingletonLock");
    // A browser in another process: this test process stands in for it.
    symlinkSync(`${hostname()}-${process.pid}`, lock);
    const { manager: blocked } = fakeManager(async () => ({ frameId: "frame-1" }));
    await blocked.newTab();
    expect(launchedProfiles()[0]).not.toBe(persistent);
    await blocked.closeAll();

    // A lock left by a browser that has exited does not keep the profile.
    const exited = spawnSync(process.execPath, ["-e", ""]);
    unlinkSync(lock);
    symlinkSync(`${hostname()}-${exited.pid}`, lock);
    writeFileSync(join(persistent, PROFILE_MARKER), JSON.stringify({
      pid: exited.pid,
      startedAt: Date.now() - 10_000,
    }));
    const old = new Date(Date.now() - 90_000);
    utimesSync(join(persistent, PROFILE_MARKER), old, old);
    const { manager: reused } = fakeManager(async () => ({ frameId: "frame-1" }));
    await reused.newTab();
    expect(launchedProfiles()[1]).toBe(persistent);
  });

  it.skipIf(process.platform === "win32")("removes only stale private profiles before the next launch", async () => {
    const stale = await mkdtemp(join(profileRoot, "agenc-browser-"));
    const staleChild = await mkdtemp(join(profileRoot, "agenc-browser-child-"));
    const exited = spawnSync(process.execPath, ["-e", ""]);
    for (const dir of [stale, staleChild]) {
      const path = join(dir, PROFILE_MARKER);
      writeFileSync(path, JSON.stringify({
        pid: exited.pid, startedAt: Date.now() - 10_000,
      }));
      const old = new Date(Date.now() - 90_000);
      utimesSync(path, old, old);
    }
    symlinkSync(`${hostname()}-${exited.pid}`, join(staleChild, "SingletonLock"));
    const live = await mkdtemp(join(profileRoot, "agenc-browser-"));
    symlinkSync(`${hostname()}-${process.pid}`, join(live, "SingletonLock"));
    const uncertain = await mkdtemp(join(profileRoot, "agenc-browser-"));
    writeFileSync(join(uncertain, "SingletonLock"), "unreadable lock format");
    const unclaimed = await mkdtemp(join(profileRoot, "agenc-browser-"));
    const unrelated = join(profileRoot, "unrelated");
    mkdirSync(unrelated);
    const linked = join(profileRoot, "agenc-browser-child-abcdef");
    symlinkSync(unrelated, linked, "dir");
    const shared = join(profileRoot, "browser", "profile");
    mkdirSync(shared, { recursive: true });
    const configuredShared = join(profileRoot, "agenc-browser-abcdef");
    mkdirSync(configuredShared, { mode: 0o700 });
    writeFileSync(join(configuredShared, "marker"), "keep");

    const { manager } = fakeManager(async () => ({ frameId: "frame-1" }), configuredShared);
    await manager.navigate("about:blank");

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(staleChild)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(uncertain)).toBe(true);
    expect(existsSync(unclaimed)).toBe(true);
    expect(existsSync(linked)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(shared)).toBe(true);
    expect(readFileSync(join(configuredShared, "marker"), "utf8")).toBe("keep");
  });
});
