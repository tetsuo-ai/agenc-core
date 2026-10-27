import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../src/bin/remote-connector.js", () => { throw new Error("disabled command loaded the connector"); });
import { captureRemoteCliRuntimeContext, runAgenCRemoteCli, runRemoteSlash, startRemoteOn } from "../../src/bin/remote-cli.js";

afterEach(() => vi.restoreAllMocks());
it("never loads the connector or touches credentials/network for starts or local cleanup while disabled", async () => {
  const home = mkdtempSync(join(tmpdir(), "remote-inert-"));
  const context = captureRemoteCliRuntimeContext({ AGENC_HOME: home, AGENC_REMOTE_FULL_CONTROL: "1", AGENC_REMOTE_AUTH_TOKEN: "fixture" });
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  mkdirSync(join(home, "remote"));
  writeFileSync(join(home, "remote", "pair.json"), JSON.stringify({ pairingId: "old", hostSecret: "fixture", relayUrl: "wss://relay.test", machineName: "old" }));
  try {
    expect(await runAgenCRemoteCli({ kind: "on", fullControl: true }, context)).toBe(1);
    expect(await startRemoteOn(context, { fullControl: true })).toHaveProperty("message", expect.stringContaining("disabled"));
    expect(await runRemoteSlash("on --full-control", context)).toContain("disabled");
    expect(await runRemoteSlash("status", context)).toContain("old");
    expect(await runAgenCRemoteCli({ kind: "status" }, context)).toBe(0);
    expect(await runRemoteSlash("off", context)).toContain("removed");
    expect(await runAgenCRemoteCli({ kind: "off" }, context)).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
