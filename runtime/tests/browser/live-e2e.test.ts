/**
 * Live-browser end-to-end test for the Browser tool.
 *
 * Gated behind AGENC_BROWSER_E2E=1 (mirrors the DevNet/`AGENC_TUI_DESIGN_BROWSER`
 * opt-in precedent) so `npm test` stays hermetic — a real Chromium is not a
 * hermetic dependency. When enabled it drives a real headless browser against a
 * loopback fixture site and proves: navigation + snapshot, ref-addressed form
 * fill + submit, ref stability across re-snapshot, multi-tab, and a live SSRF
 * block of a metadata address.
 *
 * Enable locally:  AGENC_BROWSER_E2E=1 npm --workspace=@tetsuo-ai/runtime run \
 *   test -- tests/browser/live-e2e.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BrowserManager } from "../../src/browser/manager.js";
import { resolveBrowserExecutable } from "../../src/browser/executable.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

const LIVE = process.env.AGENC_BROWSER_E2E === "1";

const FIXTURE_HTML = `<!doctype html><html><head><title>Fixture</title></head>
<body>
  <h1>Login</h1>
  <form action="/submitted" method="get">
    <label>Username <input id="u" name="u" type="text"></label>
    <label>Password <input id="p" name="p" type="password"></label>
    <button type="submit">Sign in</button>
  </form>
</body></html>`;

const SUBMITTED_HTML = `<!doctype html><html><head><title>Welcome</title></head>
<body><h1>Signed in</h1><p id="ok">Welcome back</p></body></html>`;

describe.skipIf(!LIVE)("Browser tool live e2e", () => {
  let server: Server;
  let base: string;
  // Local dev target → allow private network so the loopback fixture is
  // reachable; the metadata block is asserted independently below.
  const manager = new BrowserManager({
    policy: {
      headless: true,
      allowPrivateNetwork: true,
      noSandbox: process.env.AGENC_BROWSER_NO_SANDBOX === "1",
      navigationTimeoutMs: 30_000,
    },
    idleShutdownMs: 120_000,
    sandboxExecutionBroker: explicitDangerBroker,
  });

  beforeAll(async () => {
    // Fail loudly (not skip) if opted in but no browser is present.
    expect(
      resolveBrowserExecutable(process.env.AGENC_BROWSER_EXECUTABLE),
      "AGENC_BROWSER_E2E=1 but no Chromium-family browser found",
    ).toBeTruthy();
    server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url.startsWith("/submitted")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(SUBMITTED_HTML);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await manager.closeAll();
    await new Promise<void>((r) => server.close(() => r()));
  });

  test("navigates and snapshots a page with refs", async () => {
    const page = await manager.navigate(`${base}/`);
    const snapshot = await page.snapshot();
    expect(snapshot).toContain("Sign in");
    expect(snapshot).toMatch(/\[ref=e\d+\]/);
  }, 60_000);

  test("fills a form by ref and submits, reaching the result page", async () => {
    const page = await manager.navigate(`${base}/`);
    const snapshot = await page.snapshot();
    // Find the username textbox ref and the submit button ref from the outline.
    const textboxRef = /- (?:textbox) "Username".*\[ref=(e\d+)\]/.exec(snapshot)?.[1];
    const buttonRef = /- button "Sign in" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
    expect(textboxRef, snapshot).toBeDefined();
    expect(buttonRef, snapshot).toBeDefined();

    await page.type(textboxRef!, "alice", false);
    await page.click(buttonRef!);
    const info = await page.info();
    expect(info.url).toContain("/submitted");
    const text = await page.getText(5_000);
    expect(text).toContain("Signed in");
  }, 60_000);

  test("refs are stable across a re-snapshot of the same page", async () => {
    const page = await manager.navigate(`${base}/`);
    const first = await page.snapshot();
    const second = await page.snapshot();
    const firstButton = /- button "Sign in" \[ref=(e\d+)\]/.exec(first)?.[1];
    const secondButton = /- button "Sign in" \[ref=(e\d+)\]/.exec(second)?.[1];
    expect(firstButton).toBeDefined();
    expect(secondButton).toBe(firstButton);
  }, 60_000);

  test("supports multiple tabs", async () => {
    const tab = await manager.newTab(`${base}/`);
    expect(tab.id).toBeGreaterThan(0);
    const tabs = await manager.listTabs();
    expect(tabs.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test("captures a screenshot as PNG bytes", async () => {
    const page = await manager.navigate(`${base}/`);
    const shot = await page.screenshot("png", false);
    expect(shot.mime).toBe("image/png");
    expect(Buffer.from(shot.base64, "base64").length).toBeGreaterThan(100);
  }, 60_000);

  test("blocks navigation to a cloud-metadata address (live SSRF)", async () => {
    // Even with allowPrivateNetwork the metadata endpoint is refused; the proxy
    // fails the connection and navigate() surfaces the block.
    await expect(
      manager.navigate("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/block/i);
  }, 60_000);
});
