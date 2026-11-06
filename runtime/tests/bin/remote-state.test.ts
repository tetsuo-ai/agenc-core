import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureRemoteCliRuntimeContext,
  pairPath,
  revokeLegacyRemote,
  stopMarker,
  writePairFile,
  type RemoteCliRuntimeContext,
} from "../../src/bin/remote-state.js";

const PAIR = {
  pairingId: "pairing",
  hostSecret: "secret",
  machineName: "fixture",
  relayUrl: "wss://relay.invalid",
  backendUrl: "https://backend.invalid",
  createdAt: "2026-11-01T00:00:00.000Z",
};

let home: string;
let context: RemoteCliRuntimeContext;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "remote-state-"));
  context = captureRemoteCliRuntimeContext({ AGENC_HOME: home });
});
afterEach(() => {
  for (const folder of [home, join(home, "remote")]) {
    try { chmodSync(folder, 0o700); } catch { /* absent */ }
  }
  rmSync(home, { recursive: true, force: true });
});

describe("legacy pairing revocation", () => {
  it("removes the pairing when the stop marker cannot be written", () => {
    writePairFile(context, PAIR);
    mkdirSync(join(home, "remote", "stopped"));
    const revocation = revokeLegacyRemote(context);
    expect(revocation.revoked).toBe(true);
    expect(revocation.errors).toHaveLength(1);
    expect(existsSync(pairPath(context))).toBe(false);
  });

  it("reports a pairing that could not be removed", () => {
    writePairFile(context, PAIR);
    chmodSync(join(home, "remote"), 0o500);
    const revocation = revokeLegacyRemote(context);
    expect(revocation.revoked).toBe(false);
    expect(revocation.errors).toHaveLength(2);
    expect(existsSync(pairPath(context))).toBe(true);
  });

  it("changes the marker and removes the pairing when both can be written", () => {
    writePairFile(context, PAIR);
    const before = stopMarker(context);
    const revocation = revokeLegacyRemote(context);
    expect(revocation).toEqual({ revoked: true, errors: [] });
    expect(stopMarker(context)).not.toBe(before);
    expect(existsSync(pairPath(context))).toBe(false);
  });

  it("has nothing to revoke without a pairing, even when nothing can be written", () => {
    chmodSync(home, 0o500);
    const revocation = revokeLegacyRemote(context);
    expect(revocation.revoked).toBe(true);
    expect(revocation.errors.length).toBeGreaterThan(0);
  });
});
