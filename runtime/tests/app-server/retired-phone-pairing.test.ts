import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  retiredPhonePairingPath,
  revokeRetiredPhonePairing,
} from "../../src/app-server/retired-phone-pairing.js";

let home: string;
const folder = () => join(home, "remote");
const marker = () => join(folder(), "stopped");

function writePairing(): void {
  mkdirSync(folder(), { recursive: true, mode: 0o700 });
  writeFileSync(retiredPhonePairingPath(home), JSON.stringify({ pairingId: "pairing", hostSecret: "secret" }), { mode: 0o600 });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "retired-phone-pairing-"));
});
afterEach(() => {
  for (const path of [home, folder()]) {
    try { chmodSync(path, 0o700); } catch { /* absent */ }
  }
  rmSync(home, { recursive: true, force: true });
});

describe("retired phone pairing revocation", () => {
  it("has nothing to do without the folder, and creates nothing", () => {
    expect(revokeRetiredPhonePairing(home)).toEqual({ revoked: true, errors: [] });
    expect(existsSync(folder())).toBe(false);
  });

  it("removes the pairing, then the marker and the empty folder", () => {
    writePairing();
    writeFileSync(marker(), "connector-activation");
    expect(revokeRetiredPhonePairing(home)).toEqual({ revoked: true, errors: [] });
    expect(existsSync(retiredPhonePairingPath(home))).toBe(false);
    expect(existsSync(folder())).toBe(false);
  });

  it("keeps other files in the folder", () => {
    writePairing();
    writeFileSync(join(folder(), ".oauth_token"), "unrelated");
    expect(revokeRetiredPhonePairing(home).revoked).toBe(true);
    expect(existsSync(retiredPhonePairingPath(home))).toBe(false);
    expect(readFileSync(join(folder(), ".oauth_token"), "utf8")).toBe("unrelated");
    expect(existsSync(marker())).toBe(false);
  });

  it("removes the pairing when the stop marker cannot be written", () => {
    writePairing();
    mkdirSync(marker());
    const revocation = revokeRetiredPhonePairing(home);
    expect(revocation.revoked).toBe(true);
    expect(revocation.errors).toHaveLength(1);
    expect(existsSync(retiredPhonePairingPath(home))).toBe(false);
  });

  it("reports a pairing that could not be removed", () => {
    writePairing();
    chmodSync(folder(), 0o500);
    const revocation = revokeRetiredPhonePairing(home);
    expect(revocation.revoked).toBe(false);
    expect(revocation.errors).toHaveLength(2);
    chmodSync(folder(), 0o700);
    expect(existsSync(retiredPhonePairingPath(home))).toBe(true);
  });

  it("does not count a pairing it cannot see as revoked", () => {
    expect(process.getuid?.()).not.toBe(0);
    writePairing();
    // No search bit: the marker cannot be written, and pair.json can be
    // neither removed nor looked at.
    chmodSync(folder(), 0o600);
    const revocation = revokeRetiredPhonePairing(home);
    chmodSync(folder(), 0o700);
    expect(JSON.parse(readFileSync(retiredPhonePairingPath(home), "utf8")).hostSecret).toBe("secret");
    expect(revocation.errors.length).toBeGreaterThan(0);
    expect(revocation.revoked).toBe(false);
  });
});
