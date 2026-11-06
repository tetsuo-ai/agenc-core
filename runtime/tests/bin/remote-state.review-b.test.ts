/**
 * Review B: a revocation counts as done only when pair.json is really gone.
 * existsSync answers false for any error, so a pairing the daemon cannot see
 * (its folder lost the search bit, or belongs to another user) reads as
 * revoked while the file is still on disk and readable to anyone who can see
 * the folder (a connector run with sudo, or after the mode is put back).
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureRemoteCliRuntimeContext,
  pairPath,
  revokeLegacyRemote,
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
  home = mkdtempSync(join(tmpdir(), "remote-state-rvb-"));
  context = captureRemoteCliRuntimeContext({ AGENC_HOME: home });
});
afterEach(() => {
  for (const folder of [home, join(home, "remote")]) {
    try { chmodSync(folder, 0o700); } catch { /* absent */ }
  }
  rmSync(home, { recursive: true, force: true });
});

describe("review B: legacy pairing revocation", () => {
  it("does not count a pairing it cannot see as revoked", () => {
    expect(process.getuid?.()).not.toBe(0);
    writePairFile(context, PAIR);
    // No search bit: the marker cannot be written, pair.json cannot be removed
    // or even looked at, so existsSync says false.
    chmodSync(join(home, "remote"), 0o600);
    const revocation = revokeLegacyRemote(context);
    chmodSync(join(home, "remote"), 0o700);
    // The pairing is still there, secret and all.
    expect(existsSync(pairPath(context))).toBe(true);
    expect(JSON.parse(readFileSync(pairPath(context), "utf8")).hostSecret).toBe("secret");
    expect(revocation.errors.length).toBeGreaterThan(0);
    expect(revocation.revoked).toBe(false);
  });
});
