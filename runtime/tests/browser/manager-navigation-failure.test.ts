import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const { launchBrowserMock, markerReadSeam, ownershipSeam, linkSeam, userHomeSeam } = vi.hoisted(() => ({
  launchBrowserMock: vi.fn(),
  markerReadSeam: { path: "", replace: undefined as undefined | (() => void) },
  ownershipSeam: { path: "" },
  linkSeam: { path: "" },
  userHomeSeam: { path: "" },
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    userInfo: ((...args: Parameters<typeof actual.userInfo>) => ({
      ...actual.userInfo(...args),
      homedir: userHomeSeam.path || actual.userInfo(...args).homedir,
    })) as typeof actual.userInfo,
  };
});
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
    lstatSync: ((path: Parameters<typeof actual.lstatSync>[0], ...args: unknown[]) => {
      const info = (actual.lstatSync as (...args: unknown[]) => ReturnType<typeof actual.lstatSync>)(path, ...args);
      if (String(path) === linkSeam.path) {
        return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
          isSymbolicLink: () => true,
        });
      }
      return String(path) === ownershipSeam.path
        ? Object.assign(Object.create(Object.getPrototypeOf(info)), info, { uid: info.uid + 1 })
        : info;
    }) as typeof actual.lstatSync,
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
import { disposeSandboxExecutionBroker, transitionSandboxExecutionBroker } from "../../src/sandbox/execution-lifecycle.js";
import { runAdmittedToolCall } from "../../src/budget/admitted-tool-call.js";
import { bindAdmittedToolHarness } from "../helpers/admitted-tool-harness.js";

let profileRoot = "";
const managers: BrowserManager[] = [];
const PROFILE_MARKER = ".agenc-profile-owner";
const PROFILE_RECOVERY_MARKER = ".agenc-profile-recovery";

function projectProfile(root = profileRoot): string {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 24);
  return join(profileRoot, "browser", "profiles", key);
}

beforeEach(async () => {
  profileRoot = realpathSync.native(await mkdtemp(join(tmpdir(), "agenc-browser-navigation-test-")));
  userHomeSeam.path = profileRoot;
});
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.closeAll();
  await rm(profileRoot, { recursive: true, force: true });
  launchBrowserMock.mockReset();
  markerReadSeam.path = "";
  markerReadSeam.replace = undefined;
  ownershipSeam.path = "";
  linkSeam.path = "";
  userHomeSeam.path = "";
  vi.restoreAllMocks();
});

function fakeManager(
  navigation: (options: CdpSendOptions) => Promise<Record<string, unknown>>,
  profileDir?: string,
  sandboxExecutionBroker?: SandboxExecutionBroker,
  projectRootMarkers?: readonly string[],
  extraOptions: Partial<ConstructorParameters<typeof BrowserManager>[0]> = {},
) {
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
    ...(sandboxExecutionBroker === undefined
      ? { projectRoot: profileRoot }
      : { sandboxExecutionBroker }),
    ...(projectRootMarkers !== undefined ? { projectRootMarkers } : {}),
    policy: {
      executablePath: process.execPath,
      headless: true, allowPrivateNetwork: false, noSandbox: false, navigationTimeoutMs: 1_000,
      ...(profileDir !== undefined ? { profileDir } : {}),
    },
    ...extraOptions,
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
    expect(existsSync(projectProfile())).toBe(false);
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

describe("project-scoped browser profiles", () => {
  const launchedProfiles = (): string[] =>
    launchBrowserMock.mock.calls.map(
      ([options]) => (options as { userDataDir: string }).userDataDir,
    );

  async function launchThroughTool(cwd: string, projectRootMarkers?: readonly string[]): Promise<void> {
    fakeManager(async () => ({})); // Give each launch a fresh fake CDP connection.
    const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd });
    const tool = createBrowserTool({
      agencHome: profileRoot,
      config: { executable_path: process.execPath },
      projectRootMarkers,
    });
    const args: Record<string, unknown> = { action: "new_tab", url: "about:blank" };
    attachSandboxExecutionBroker(args, broker, "browser");
    try {
      expect((await tool.execute(args)).isError).toBeUndefined();
    } finally {
      await disposeSandboxExecutionBroker(broker);
    }
  }

  it("uses the configured trust markers for distinct browser profile keys", async () => {
    writeFileSync(join(profileRoot, "package.json"), "{}");
    const first = join(profileRoot, "first");
    const second = join(profileRoot, "second");
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, ".project"), "");
    writeFileSync(join(second, ".project"), "");

    await launchThroughTool(first, [".project"]);
    await launchThroughTool(second, [".project"]);
    await launchThroughTool(second, ["package.json"]);

    expect(launchedProfiles()).toEqual([
      projectProfile(first), projectProfile(second), projectProfile(profileRoot),
    ]);
  });

  it("uses a private profile when lexical trust and real workspace roots differ", async () => {
    const lexical = join(profileRoot, "lexical");
    const realProject = join(profileRoot, "real");
    const realWorkspace = join(realProject, "src");
    mkdirSync(join(lexical, ".git"), { recursive: true });
    mkdirSync(join(realProject, ".git"), { recursive: true });
    mkdirSync(realWorkspace);
    symlinkSync(realWorkspace, join(lexical, "workspace"), "dir");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    await launchThroughTool(join(lexical, "workspace"));

    expect(launchedProfiles()[0]).toMatch(/^.*\/agenc-browser-[^/]+$/);
    expect(launchedProfiles()[0]).not.toBe(projectProfile(realProject));
    expect(launchedProfiles()[0]).not.toBe(projectProfile(lexical));
    expect(warning).toHaveBeenCalledOnce();
    expect(String(warning.mock.calls[0]?.[0])).toContain("lexical trust root differs");
  });

  it("closes a running browser on marker reload and launches with the new key", async () => {
    const first = join(profileRoot, "first");
    mkdirSync(first);
    writeFileSync(join(profileRoot, "package.json"), "{}");
    writeFileSync(join(first, ".project"), "");
    let markers: readonly string[] = ["package.json"];
    let notifyReload: (() => void) | undefined;
    const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: first });
    const { manager, connection } = fakeManager(async () => ({}), undefined, broker, markers, {
      projectRootMarkersProvider: () => markers,
      subscribeProjectRootMarkers: (listener) => {
        notifyReload = listener;
        return () => { notifyReload = undefined; };
      },
    });
    await manager.newTab();
    expect(launchedProfiles()).toEqual([projectProfile(profileRoot)]);
    markers = [".project"];
    notifyReload?.();
    await vi.waitFor(() => expect(manager.running).toBe(false));
    connection.closed = false;
    await manager.newTab();
    expect(launchedProfiles()).toEqual([projectProfile(profileRoot), projectProfile(first)]);
  });

  it("closes a private browser when a reload changes only the lexical trust root", async () => {
    const lexical = join(profileRoot, "a");
    const sub = join(lexical, "sub");
    const real = join(profileRoot, "b");
    const work = join(real, "work");
    mkdirSync(sub, { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(sub, ".project"), "");
    writeFileSync(join(lexical, ".root"), "");
    writeFileSync(join(real, ".project"), "");
    writeFileSync(join(real, ".root"), "");
    symlinkSync(work, join(sub, "link"), "dir");
    let markers: readonly string[] = [".project"];
    let notifyReload: (() => void) | undefined;
    const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: join(sub, "link") });
    const { manager, connection } = fakeManager(async () => ({}), undefined, broker, markers, {
      projectRootMarkersProvider: () => markers,
      subscribeProjectRootMarkers: (listener) => {
        notifyReload = listener;
        return () => { notifyReload = undefined; };
      },
    });
    await manager.newTab();
    expect(manager.running).toBe(true);
    const first = launchedProfiles()[0];
    markers = [".root"];
    notifyReload?.();
    await vi.waitFor(() => expect(manager.running).toBe(false));
    connection.closed = false;
    await manager.newTab();
    expect(launchedProfiles()).toHaveLength(2);
    expect(launchedProfiles()[1]).not.toBe(first);
  });

  it("walks roots once per launch and once per reload", async () => {
    const project = join(profileRoot, "project");
    mkdirSync(project);
    writeFileSync(join(project, ".project"), "");
    let notifyReload: (() => void) | undefined;
    const markers = vi.fn(() => [".project"]);
    const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: project });
    const { manager } = fakeManager(async () => ({}), undefined, broker, [".project"], {
      projectRootMarkersProvider: markers,
      subscribeProjectRootMarkers: (listener) => {
        notifyReload = listener;
        return () => { notifyReload = undefined; };
      },
    });
    await manager.newTab();
    await manager.newTab();
    expect(markers).toHaveBeenCalledTimes(1);
    notifyReload?.();
    await manager.newTab();
    expect(markers).toHaveBeenCalledTimes(2);
  });

  it("creates a fresh agencHome inside the user's home privately and keeps a stored profile there", async () => {
    const fresh = join(profileRoot, "fresh-home");
    const { manager } = fakeManager(async () => ({}), undefined, undefined, undefined, {
      agencHome: fresh,
      profileValidationUserHome: profileRoot,
    });
    await manager.newTab();
    const key = createHash("sha256").update(profileRoot).digest("hex").slice(0, 24);
    expect(launchedProfiles()[0]).toBe(join(fresh, "browser", "profiles", key));
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("rejects a macOS ACL that lets another user read the profile chain", async () => {
    const browser = join(profileRoot, "browser");
    const ls = vi.fn((paths: readonly string[]) => paths.map((path) =>
      `${path === browser ? "drwx------+" : "drwx------"} 1 owner staff 0 Sep 23 00:00 ${path}` +
      (path === browser ? "\n 0: user:guest allow list,search,read" : ""),
    ).join("\n") + "\n");
    const { manager } = fakeManager(async () => ({}), undefined, undefined, undefined, {
      profileValidationPlatform: "darwin", profileValidationLs: ls,
    });
    await manager.newTab();
    expect(launchedProfiles()[0]).toMatch(/^.*\/agenc-browser-[^/]+$/);
  });

  it("falls back when agencHome is outside the current user's home", async () => {
    const userHome = join(profileRoot, "user");
    const outside = join(profileRoot, "outside");
    mkdirSync(userHome);
    mkdirSync(outside);
    const { manager } = fakeManager(async () => ({}), undefined, undefined, undefined, {
      agencHome: outside,
      profileValidationUserHome: userHome,
    });
    await manager.newTab();
    expect(launchedProfiles()[0]).toMatch(/^.*\/agenc-browser-[^/]+$/);
  });

  it.skipIf(process.platform === "win32")("rejects a macOS allow-write ACL but accepts a deny ACL", async () => {
    const browser = join(profileRoot, "browser");
    const runLs = (effect: "allow" | "deny") => vi.fn((paths: readonly string[]) =>
      paths.map((path) => `${path === browser ? "drwx------+" : "drwx------"} 1 owner staff 0 Sep 23 00:00 ${path}` +
        (path === browser ? `\n 0: group:everyone ${effect} ${effect === "allow" ? "write" : "delete"}` : ""))
        .join("\n") + "\n");
    const allowLs = runLs("allow");
    const first = fakeManager(async () => ({}), undefined, undefined, undefined, {
      profileValidationPlatform: "darwin", profileValidationLs: allowLs,
    }).manager;
    await first.newTab();
    expect(launchedProfiles()[0]).toMatch(/^.*\/agenc-browser-[^/]+$/);
    expect(allowLs).toHaveBeenCalledOnce();
    expect(allowLs.mock.calls[0]?.[0]).toContain(browser);
    await first.closeAll();

    const denyLs = runLs("deny");
    const second = fakeManager(async () => ({}), undefined, undefined, undefined, {
      profileValidationPlatform: "darwin", profileValidationLs: denyLs,
    }).manager;
    await second.newTab();
    expect(launchedProfiles()[1]).toBe(projectProfile());
    expect(denyLs).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === "win32")("accepts macOS output as this Mac prints it: @ instead of +, and inheritance flags", async () => {
    // A home folder with extended attributes shows "@", not "+", even when it
    // also carries the standard deny ACL.
    const ls = vi.fn((paths: readonly string[]) => paths.map((path, index) =>
      index === 0
        ? `drwxr-xr-x@ 411 owner staff 13152 Sep 23 18:17 ${path}\n 0: group:everyone deny delete`
        : `drwx------+ 1 owner staff 0 Sep 23 00:00 ${path}\n 0: group:everyone inherited deny delete,file_inherit,directory_inherit`,
    ).join("\n") + "\n");
    const { manager } = fakeManager(async () => ({}), undefined, undefined, undefined, {
      profileValidationPlatform: "darwin", profileValidationLs: ls,
    });
    await manager.newTab();
    expect(launchedProfiles()[0]).toBe(projectProfile());
    expect(ls).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === "win32")("checks macOS ACLs on launch and reload, not on each action", async () => {
    let notifyReload: (() => void) | undefined;
    let unsafe = false;
    const browser = join(profileRoot, "browser");
    const ls = vi.fn((paths: readonly string[]) => paths.map((path) =>
      `${path === browser ? "drwx------+" : "drwx------"} 1 owner staff 0 Sep 23 00:00 ${path}` +
      (path === browser ? `\n 0: group:everyone ${unsafe ? "allow write" : "deny delete"}` : ""),
    ).join("\n") + "\n");
    const { manager } = fakeManager(async () => ({}), undefined, undefined, undefined, {
      profileValidationPlatform: "darwin",
      profileValidationLs: ls,
      subscribeProjectRootMarkers: (listener) => {
        notifyReload = listener;
        return () => { notifyReload = undefined; };
      },
    });
    await manager.newTab();
    await manager.newTab();
    expect(ls).toHaveBeenCalledTimes(1);
    notifyReload?.();
    await manager.newTab();
    expect(ls).toHaveBeenCalledTimes(2);
    unsafe = true;
    notifyReload?.();
    await vi.waitFor(() => expect(manager.running).toBe(false));
    expect(ls).toHaveBeenCalledTimes(3);
  });

  it.skipIf(process.platform === "win32")("accepts an agencHome named through a symlinked tmp path", async () => {
    const alias = profileRoot.replace(/^\/private\/tmp\//, "/tmp/").replace(/^\/private\/var\//, "/var/");
    expect(alias).not.toBe(profileRoot);
    const home = join(profileRoot, "home");
    mkdirSync(home);
    const { manager } = fakeManager(async () => ({}), undefined, undefined, undefined, {
      agencHome: join(alias, "home"),
    });
    await manager.newTab();
    const key = createHash("sha256").update(profileRoot).digest("hex").slice(0, 24);
    expect(launchedProfiles()[0]).toBe(join(home, "browser", "profiles", key));
  });

  it("uses a Windows user profile only for contained, junction-free homes", async () => {
    const userHome = join(profileRoot, "windows-user");
    const inside = join(userHome, "agenc");
    const outside = join(profileRoot, "windows-outside");
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside);
    const options = { profileValidationPlatform: "win32" as const, profileValidationUserHome: userHome };
    const first = fakeManager(async () => ({}), undefined, undefined, undefined, {
      ...options, agencHome: inside,
    }).manager;
    await first.newTab();
    const key = createHash("sha256").update(profileRoot).digest("hex").slice(0, 24);
    expect(launchedProfiles()[0]).toBe(join(inside, "browser", "profiles", key));
    await first.closeAll();
    const second = fakeManager(async () => ({}), undefined, undefined, undefined, {
      ...options, agencHome: outside,
    }).manager;
    await second.newTab();
    expect(launchedProfiles()[1]).toMatch(/^.*\/agenc-browser-[^/]+$/);
  });

  it.skipIf(process.platform === "win32")("refuses writable browser chain components", async () => {
    for (const component of ["browser", "profiles"] as const) {
      const path = join(profileRoot, "browser", ...(component === "profiles" ? ["profiles"] : []));
      mkdirSync(path, { recursive: true });
      chmodSync(path, component === "browser" ? 0o770 : 0o777);
      const { manager } = fakeManager(async () => ({}));
      await manager.newTab();
      expect(launchedProfiles().at(-1)).toMatch(/^.*\/agenc-browser-[^/]+$/);
      await manager.closeAll();
      chmodSync(path, 0o700);
    }
  });

  it.skipIf(process.platform === "win32")("refuses a group-writable ancestor even when it is sticky", async () => {
    const ancestor = join(profileRoot, "shared");
    const home = join(ancestor, "home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(ancestor, 0o1777);
    const options = { agencHome: home, projectRoot: profileRoot };
    const first = fakeManager(async () => ({}), undefined, undefined, undefined, options).manager;
    await first.newTab();
    expect(launchedProfiles().at(-1)).toMatch(/^.*\/agenc-browser-[^/]+$/);
    await first.closeAll();
    chmodSync(ancestor, 0o777);
    const second = fakeManager(async () => ({}), undefined, undefined, undefined, options).manager;
    await second.newTab();
    expect(launchedProfiles().at(-1)).toMatch(/^.*\/agenc-browser-[^/]+$/);
  });

  it.skipIf(process.platform === "win32")("refuses a sticky ancestor when its immediate entry has another owner", async () => {
    const shared = join(profileRoot, "shared");
    const entry = join(shared, "entry");
    const home = join(entry, "home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(shared, 0o1777);
    ownershipSeam.path = entry;
    const { manager } = fakeManager(async () => ({}), undefined, undefined, undefined, { agencHome: home });
    await manager.newTab();
    const path = (launchBrowserMock.mock.calls[0]?.[0] as { userDataDir: string }).userDataDir;
    expect(path).toMatch(/^.*\/agenc-browser-[^/]+$/);
  });

  it("refuses a Windows junction reported by lstat in the browser chain", async () => {
    const browser = join(profileRoot, "browser");
    mkdirSync(browser);
    linkSeam.path = browser;
    const { manager } = fakeManager(async () => ({}), undefined, undefined, undefined, {
      profileValidationPlatform: "win32",
      profileValidationUserHome: profileRoot,
    });
    await manager.newTab();
    expect(launchedProfiles()[0]).toMatch(/^.*\/agenc-browser-[^/]+$/);
  });

  it.skipIf(process.platform === "win32")("refuses a link in the browser chain", async () => {
    const elsewhere = join(profileRoot, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(profileRoot, "browser"), "dir");
    const { manager } = fakeManager(async () => ({}));
    await manager.newTab();
    expect(launchedProfiles()[0]).toMatch(/^.*\/agenc-browser-[^/]+$/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("recomputes a transitioned workspace with the same trust markers", async () => {
    const first = join(profileRoot, "first");
    const second = join(profileRoot, "second");
    writeFileSync(join(profileRoot, "package.json"), "{}");
    for (const project of [first, second]) {
      mkdirSync(project);
      writeFileSync(join(project, ".project"), "");
    }
    const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: first });
    const { manager, connection } = fakeManager(async () => ({}), undefined, broker, [".project"]);
    await manager.newTab();
    await manager.closeAll();
    await transitionSandboxExecutionBroker(broker, second);
    connection.closed = false;
    await manager.newTab();

    expect(launchedProfiles()).toEqual([projectProfile(first), projectProfile(second)]);
  });

  it.skipIf(process.platform === "win32")("refuses a planted project profile symlink and warns once", async () => {
    const first = join(profileRoot, "first");
    const second = join(profileRoot, "second");
    mkdirSync(first);
    mkdirSync(second);
    const target = projectProfile(first);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    symlinkSync(target, projectProfile(second), "dir");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: second });
    const { manager, connection } = fakeManager(async () => ({}), undefined, broker);
    await manager.newTab();
    await manager.closeAll();
    connection.closed = false;
    await manager.newTab();

    expect(launchedProfiles()).toHaveLength(2);
    expect(launchedProfiles().every((path) => path.startsWith(join(profileRoot, "agenc-browser-")))).toBe(true);
    expect(existsSync(join(target, PROFILE_MARKER))).toBe(false);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === "win32")("refuses a symlinked profiles root", async () => {
    const elsewhere = join(profileRoot, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    mkdirSync(join(profileRoot, "browser"));
    symlinkSync(elsewhere, join(profileRoot, "browser", "profiles"), "dir");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { manager } = fakeManager(async () => ({}));
    await manager.newTab();

    expect(launchedProfiles()[0]).toMatch(/^.*\/agenc-browser-[^/]+$/);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(warning).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === "win32")("tightens existing profile directories to 0700", async () => {
    const persistent = projectProfile();
    const profiles = join(profileRoot, "browser", "profiles");
    mkdirSync(persistent, { recursive: true, mode: 0o700 });
    chmodSync(profiles, 0o755);
    chmodSync(persistent, 0o755);
    const { manager } = fakeManager(async () => ({}));
    await manager.newTab();

    expect(launchedProfiles()[0]).toBe(persistent);
    expect(statSync(profiles).mode & 0o777).toBe(0o700);
    expect(statSync(persistent).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("refuses a profile reported as foreign owned", async () => {
    const persistent = projectProfile();
    mkdirSync(persistent, { recursive: true, mode: 0o700 });
    ownershipSeam.path = persistent;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { manager } = fakeManager(async () => ({}));
    await manager.newTab();

    expect(launchedProfiles()[0]).not.toBe(persistent);
    expect(launchedProfiles()[0]).toMatch(/^.*\/agenc-browser-[^/]+$/);
    expect(warning).toHaveBeenCalledOnce();
  });

  it("reuses the same profile across sessions in one project", async () => {
    const project = join(profileRoot, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    for (let index = 0; index < 2; index += 1) {
      const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: project });
      const { manager } = fakeManager(async () => ({}), undefined, broker);
      await manager.newTab();
      await manager.closeAll();
    }
    expect(launchedProfiles()).toEqual([projectProfile(project), projectProfile(project)]);
    expect(statSync(join(profileRoot, "browser", "profiles")).mode & 0o777).toBe(0o700);
    expect(statSync(projectProfile(project)).mode & 0o777).toBe(0o700);
  });

  it("isolates different projects and maps a git subfolder to its root", async () => {
    const first = join(profileRoot, "first");
    const nested = join(first, "src", "nested");
    const second = join(profileRoot, "second");
    mkdirSync(join(first, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(second, ".git"), { recursive: true });
    for (const cwd of [nested, second]) {
      const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd });
      const { manager } = fakeManager(async () => ({}), undefined, broker);
      await manager.newTab();
    }
    expect(launchedProfiles()).toEqual([projectProfile(first), projectProfile(second)]);
    expect(launchedProfiles()[0]).not.toBe(launchedProfiles()[1]);
  });

  it("honors a configured profile and leaves the legacy profile unchanged", async () => {
    const project = join(profileRoot, "project");
    const legacy = join(profileRoot, "browser", "profile");
    const configured = join(profileRoot, "configured");
    mkdirSync(project);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "cookie"), "old data");
    const legacyModifiedAt = statSync(legacy).mtimeMs;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: project });
    const configuredManager = fakeManager(async () => ({}), configured, broker).manager;
    await configuredManager.newTab();
    await configuredManager.closeAll();
    const defaultManager = fakeManager(async () => ({}), undefined, broker).manager;
    await defaultManager.newTab();
    await defaultManager.closeAll();
    const nextManager = fakeManager(async () => ({}), undefined, broker).manager;
    await nextManager.newTab();
    expect(launchedProfiles()).toEqual([configured, projectProfile(project), projectProfile(project)]);
    expect(readFileSync(join(legacy, "cookie"), "utf8")).toBe("old data");
    expect(readdirSync(legacy)).toEqual(["cookie"]);
    expect(statSync(legacy).mtimeMs).toBe(legacyModifiedAt);
    expect(info).toHaveBeenCalledTimes(1);
  });
});

// Live run (luna-mac F2): concurrent sessions in one project use the same
// persistent profile. A second session's launch handed itself to the first
// session's still-running browser through the profile's SingletonLock and
// exited, so it failed with "browser did not establish a CDP pipe: CDP pipe
// closed" until the first browser idled out five minutes later.
describe("one shared profile per project", () => {
  const launchedProfiles = (): string[] =>
    launchBrowserMock.mock.calls.map(
      ([options]) => (options as { userDataDir: string }).userDataDir,
    );

  it("gives a concurrent session its own profile and frees the shared one on close", async () => {
    const persistent = projectProfile();
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
    const persistent = projectProfile();
    const { manager: first } = fakeManager(async () => ({ frameId: "frame-1" }));
    await first.newTab();
    expect(existsSync(join(persistent, PROFILE_MARKER))).toBe(true);

    // Reloading this module gives the next manager a separate holder map, as
    // it would have in another daemon.
    vi.resetModules();
    const { BrowserManager: OtherDaemonBrowserManager } = await import("../../src/browser/manager.js");
    const second = new OtherDaemonBrowserManager({
      agencHome: profileRoot,
      projectRoot: profileRoot,
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
    const persistent = projectProfile();
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
    const persistent = projectProfile();
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
    const persistent = projectProfile();
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
    const persistent = projectProfile();
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
    const persistent = projectProfile();
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
    const persistent = projectProfile();
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
    const persistent = projectProfile();
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
    const persistent = projectProfile();
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
    const persistent = projectProfile();
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
    const persistent = projectProfile();
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
    const shared = projectProfile();
    mkdirSync(shared, { recursive: true });
    const otherProject = projectProfile(join(profileRoot, "other-project"));
    mkdirSync(otherProject, { mode: 0o700 });
    writeFileSync(join(otherProject, PROFILE_MARKER), JSON.stringify({
      pid: exited.pid, startedAt: Date.now() - 10_000,
    }));
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
    expect(existsSync(otherProject)).toBe(true);
    expect(readFileSync(join(configuredShared, "marker"), "utf8")).toBe("keep");
  });
});
