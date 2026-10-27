import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { RemoteAuthBackend } from "src/auth/backends/remote.js";

describe("remote login cancellation", () => {
  it("settles cancellation and refuses a late token", async () => {
    const home = await mkdtemp(join(tmpdir(), "remote-login-cancel-"));
    const controller = new AbortController();
    let finish!: (value: { token: string }) => void;
    const backend = new RemoteAuthBackend({ agencHome: home, env: {}, loginSignal: controller.signal,
      loginFlow: () => new Promise(resolve => { finish = resolve; }) });
    let settled = false;
    const pending = backend.login().then(() => { settled = true; return "success"; }, () => { settled = true; return "cancelled"; });
    try {
      controller.abort();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(settled).toBe(true);
      finish({ token: "late-test-token" });
      expect(await pending).toBe("cancelled");
      expect(await backend.whoami()).toMatchObject({ authenticated: false });
    } finally { finish({ token: "late-test-token" }); await pending; await rm(home, { recursive: true, force: true }); }
  });
});
