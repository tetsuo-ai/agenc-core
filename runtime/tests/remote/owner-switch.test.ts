import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureRemoteCliRuntimeContext, runAgenCRemoteCli, startRemoteOn } from "../../src/bin/remote-cli.js";

afterEach(() => vi.restoreAllMocks());

it("requires owner configuration even when a shell supplies full-control consent", async () => {
  const home = mkdtempSync(join(tmpdir(), "remote-owner-switch-"));
  const context = captureRemoteCliRuntimeContext({ AGENC_HOME: home, AGENC_REMOTE_FULL_CONTROL: "1" });
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    expect(await startRemoteOn(context, { fullControl: true })).toEqual({
      message: expect.stringMatching(/^Phone remote control is disabled\..*\[remote_control\].*enabled = true[^\n]*$/u),
    });
    expect(await runAgenCRemoteCli({ kind: "on", fullControl: true }, context)).toBe(1);
    expect(stderr.mock.calls.map(([value]) => String(value)).join("")).toContain("AGENC_REMOTE_FULL_CONTROL is ignored");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
