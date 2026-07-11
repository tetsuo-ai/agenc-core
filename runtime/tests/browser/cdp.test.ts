/**
 * CDP launch-argument hardening and pipe-client robustness.
 *
 * Revert-sensitivity: the egress-flag assertions go red if any of the
 * proxy/host-resolver/WebRTC flags are dropped from buildChromiumArgs; the
 * buffer-cap assertion goes red if CdpConnection stops bounding an unterminated
 * frame (it would hang instead of rejecting).
 */

import { describe, expect, test } from "vitest";
import { PassThrough } from "node:stream";
import { buildChromiumArgs, CdpConnection } from "../../src/browser/cdp.js";

describe("buildChromiumArgs egress hardening", () => {
  const args = buildChromiumArgs({
    executablePath: "/usr/bin/chromium",
    userDataDir: "/tmp/profile",
    headless: true,
    noSandbox: false,
    proxyPort: 4321,
  });

  test("forces all TCP egress through the loopback proxy", () => {
    expect(args).toContain("--proxy-server=127.0.0.1:4321");
    expect(args).toContain("--proxy-bypass-list=<-loopback>");
    expect(args).toContain("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1");
  });

  test("disables non-proxied WebRTC UDP so it cannot bypass the proxy", () => {
    expect(args).toContain(
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    );
  });
});

describe("CdpConnection frame ceiling", () => {
  test("fails closed on an unterminated frame past the cap", async () => {
    const write = new PassThrough();
    const read = new PassThrough();
    // 1 KiB cap so the test needn't push 128 MB.
    const conn = new CdpConnection(write, read, 1024);
    const pending = conn.send("Browser.getVersion");
    // A response frame with no NUL terminator that blows past the cap.
    read.write("x".repeat(4096));
    await expect(pending).rejects.toThrow(/exceeded/);
    expect(conn.closed).toBe(true);
  });

  test("normal NUL-delimited frames still dispatch", async () => {
    const write = new PassThrough();
    const read = new PassThrough();
    const conn = new CdpConnection(write, read, 1024);
    const pending = conn.send("Browser.getVersion");
    // Echo a well-formed result for id 1.
    read.write(JSON.stringify({ id: 1, result: { product: "Test/1.0" } }) + "\0");
    await expect(pending).resolves.toEqual({ product: "Test/1.0" });
    conn.close();
  });
});
