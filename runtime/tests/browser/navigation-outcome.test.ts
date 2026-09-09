import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  BrowserActionError,
  BrowserPage,
  readBrowserNavigationFailureReceipt,
} from "../../src/browser/page.js";
import { CdpError, type CdpConnection, type CdpSendOptions } from "../../src/browser/cdp.js";
import { createBrowserTool } from "../../src/tools/BrowserTool/tool.js";
import {
  SandboxExecutionBroker,
  attachSandboxExecutionBroker,
} from "../../src/sandbox/execution-broker.js";
import { disposeSandboxExecutionBroker } from "../../src/sandbox/execution-lifecycle.js";
import { runAdmittedToolCall } from "../../src/budget/admitted-tool-call.js";
import { bindAdmittedToolHarness } from "../helpers/admitted-tool-harness.js";

const URL = "https://example.com/article";
const HTTP2_FAILURE = {
  frameId: "frame-1", loaderId: "loader-1", errorText: "net::ERR_HTTP2_PROTOCOL_ERROR",
};
const brokers: SandboxExecutionBroker[] = [];

afterEach(async () => {
  for (const broker of brokers.splice(0)) await disposeSandboxExecutionBroker(broker);
});

function fakePage(navigate: () => Promise<Record<string, unknown>>) {
  const connection = {
    closed: false,
    send: vi.fn(async (method: string, _params?: unknown, _session?: string, _options?: CdpSendOptions) => {
      if (method === "Page.navigate") return navigate();
      if (method === "Runtime.evaluate") {
        return { result: { value: JSON.stringify({ url: URL, title: "Article" }) } };
      }
      return {};
    }),
    waitFor: vi.fn(async () => ({})),
  };
  const page = new BrowserPage({
    connection: connection as unknown as CdpConnection,
    targetId: "target-1", sessionId: "cdp-session-1", navigationTimeoutMs: 1_000,
  });
  return { page, connection };
}

function fakeBrowser(navigate: () => Promise<Record<string, unknown>>) {
  const { page, connection } = fakePage(navigate);
  const manager = {
    navigate: vi.fn(async (url: string, _tab?: number, signal?: AbortSignal) => {
      await page.navigate(url, signal);
      return page;
    }),
    closeAll: vi.fn(async () => {}),
  };
  const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: process.cwd() });
  brokers.push(broker);
  const tool = createBrowserTool({ manager: manager as never });
  const args: Record<string, unknown> = { action: "navigate", url: URL };
  attachSandboxExecutionBroker(args, broker, "browser");
  return { tool, args, manager, page, connection };
}

describe("known browser navigation outcomes", () => {
  it("attests only the received Page.navigate failure with its exact CDP identity", async () => {
    const { page, connection } = fakePage(async () => HTTP2_FAILURE);
    const error = await page.navigate(URL).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(BrowserActionError);
    expect(readBrowserNavigationFailureReceipt(error)).toEqual({
      command: "Page.navigate", targetId: "target-1", sessionId: "cdp-session-1",
      url: URL, ...HTTP2_FAILURE,
    });
    expect(connection.waitFor).not.toHaveBeenCalled();
    expect(readBrowserNavigationFailureReceipt(new BrowserActionError(
      `navigation failed: ${HTTP2_FAILURE.errorText} (${URL})`,
    ))).toBeUndefined();
    expect(readBrowserNavigationFailureReceipt({ ...readBrowserNavigationFailureReceipt(error) })).toBeUndefined();
  });

  it("keeps the visible error and supplies committed-command evidence, never no-effect", async () => {
    const browser = fakeBrowser(async () => HTTP2_FAILURE);
    const result = await browser.tool.execute(browser.args);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(HTTP2_FAILURE.errorText);
    expect(result.effectDisposition).toEqual({
      disposition: "confirmed_committed", evidenceKind: "provider_receipt",
      evidenceRef: "tool:Browser:cdp-navigation-response",
      evidenceSha256: createHash("sha256").update(JSON.stringify({
        command: "Page.navigate", targetId: "target-1", sessionId: "cdp-session-1",
        url: URL, errorText: HTTP2_FAILURE.errorText,
        frameId: "frame-1", loaderId: "loader-1",
      })).digest("hex"),
    });
    expect(result.content).not.toContain("evidenceSha256");
  });

  it.each(["CDP command timed out: Page.navigate", "CDP connection closed", "CDP command aborted: Page.navigate"])(
    "does not manufacture a receipt for %s", async (message) => {
      const error = new CdpError(message);
      const browser = fakeBrowser(async () => { throw error; });
      const result = await browser.tool.execute(browser.args);
      expect(result).toMatchObject({ isError: true });
      expect(result.effectDisposition).toBeUndefined();
      expect(readBrowserNavigationFailureReceipt(error)).toBeUndefined();
    },
  );

  it("does not accept a malformed error response as success or receipt", async () => {
    const browser = fakeBrowser(async () => ({ errorText: 123 }));
    const result = await browser.tool.execute(browser.args);
    expect(result).toMatchObject({ isError: true });
    expect(result.effectDisposition).toBeUndefined();
  });

  it("does not reuse a received navigation receipt for another URL", async () => {
    const { page } = fakePage(async () => HTTP2_FAILURE);
    const earlier = await page.navigate(URL).catch((error: unknown) => error);
    const browser = fakeBrowser(async () => { throw earlier; });
    browser.args.url = "https://example.com/other";
    const result = await browser.tool.execute(browser.args);
    expect(result.isError).toBe(true);
    expect(result.effectDisposition).toBeUndefined();
  });

  it("keeps a proxy policy refusal distinct from a received network error", async () => {
    const { connection } = fakePage(async () => HTTP2_FAILURE);
    const page = new BrowserPage({
      connection: connection as unknown as CdpConnection,
      targetId: "target-1", sessionId: "session-1", navigationTimeoutMs: 1_000,
      blockReporter: () => "private destination denied",
    });
    const error = await page.navigate(URL).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(BrowserActionError);
    expect(String(error)).toContain("navigation blocked");
    expect(readBrowserNavigationFailureReceipt(error)).toBeUndefined();
  });

  it("preserves abort and transport loss during the post-navigation load wait", async () => {
    for (const stopped of ["abort", "disconnect"]) {
      const controller = new AbortController();
      const { page, connection } = fakePage(async () => ({ frameId: "frame-1" }));
      const error = new CdpError("load wait interrupted");
      connection.waitFor.mockImplementation(async () => {
        if (stopped === "abort") controller.abort();
        else connection.closed = true;
        throw error;
      });
      await expect(page.navigate(URL, controller.signal)).rejects.toBe(error);
      expect(readBrowserNavigationFailureReceipt(error)).toBeUndefined();
    }
  });
});

describe("browser admitted effect settlement", () => {
  it("records a received navigation error as committed and permits a later operation", async () => {
    const response = vi.fn()
      .mockResolvedValueOnce(HTTP2_FAILURE)
      .mockResolvedValue({ frameId: "frame-1" });
    const browser = fakeBrowser(response);
    const harness = bindAdmittedToolHarness({ workspaceRoot: process.cwd(), label: "browser-known" });
    const invoke = () => browser.tool.execute(browser.args);
    const first = await runAdmittedToolCall({
      session: harness.session, tool: browser.tool, args: browser.args,
      turnId: "turn-browser-known", callId: "known-failure",
      invoke: async ({ crossEffectBoundary }) => { crossEffectBoundary(); return invoke(); },
    });
    expect(first.isError).toBe(true);
    expect(harness.events.filter((event) => event.msg.type === "effect_unknown_outcome")).toHaveLength(0);
    expect(harness.events.find((event) => event.msg.type === "effect_result")?.msg).toMatchObject({
      type: "effect_result", payload: { outcome: "committed", effectBoundary: "crossed" },
    });
    await expect(runAdmittedToolCall({
      session: harness.session, tool: browser.tool, args: browser.args,
      turnId: "turn-browser-known", callId: "next-navigation",
      invoke: async ({ crossEffectBoundary }) => { crossEffectBoundary(); return invoke(); },
    })).resolves.toMatchObject({ content: expect.stringContaining("Navigated to") });
    expect(browser.manager.navigate).toHaveBeenCalledTimes(2);
  });

  it("keeps real unknown outcomes gated and never resolves an older record", async () => {
    const browser = fakeBrowser(async () => { throw new CdpError("CDP connection closed"); });
    const harness = bindAdmittedToolHarness({ workspaceRoot: process.cwd(), label: "browser-unknown" });
    await runAdmittedToolCall({
      session: harness.session, tool: browser.tool, args: browser.args,
      turnId: "turn-browser-unknown", callId: "lost-ack",
      invoke: async ({ crossEffectBoundary }) => {
        crossEffectBoundary(); return browser.tool.execute(browser.args);
      },
    });
    expect(harness.events.find((event) => event.msg.type === "effect_unknown_outcome")?.msg).toMatchObject({
      type: "effect_unknown_outcome", payload: {
        callId: "lost-ack", requiresReview: true,
        reason: "tool_error_result_without_authoritative_effect_disposition",
      },
    });
    const later = vi.fn(async () => ({ content: "must not execute" }));
    await expect(runAdmittedToolCall({
      session: harness.session, tool: browser.tool, args: browser.args,
      turnId: "turn-browser-unknown", callId: "later-navigation", invoke: later,
    })).rejects.toThrow("live effect settlement is unresolved");
    expect(later).not.toHaveBeenCalled();
    expect(browser.manager.navigate).toHaveBeenCalledOnce();
    expect(harness.events.filter((event) => event.msg.type === "effect_review_resolved")).toHaveLength(0);
  });
});
