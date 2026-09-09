import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

const { launchBrowserMock } = vi.hoisted(() => ({ launchBrowserMock: vi.fn() }));
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

import { BrowserManager } from "../../src/browser/manager.js";
import { CdpError, type CdpConnection, type CdpSendOptions } from "../../src/browser/cdp.js";
import { readBrowserNavigationFailureReceipt } from "../../src/browser/page.js";

let profileRoot = "";
const managers: BrowserManager[] = [];

beforeEach(async () => {
  profileRoot = await mkdtemp(join(tmpdir(), "agenc-browser-navigation-test-"));
});
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.closeAll();
  await rm(profileRoot, { recursive: true, force: true });
  launchBrowserMock.mockReset();
});

function fakeManager(navigation: (options: CdpSendOptions) => Promise<Record<string, unknown>>) {
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
