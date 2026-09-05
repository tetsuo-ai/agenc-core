import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDarwinPlatformProtectionVerifier,
  createPlatformProtectionVerifier,
  DARWIN_PLATFORM_PROTECTION_VERIFIER_ID,
} from "../../src/eval-contract/platform-protection.js";
import { sha256Digest } from "../../src/eval-contract/canonical-json.js";

const onDarwin = process.platform === "darwin";

describe.skipIf(!onDarwin)("darwin platform protection verifier", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  const scratch = (): string => {
    const root = mkdtempSync(join(tmpdir(), "agenc-platform-protection-"));
    roots.push(root);
    return root;
  };

  it("pins a stable digest and is the platform verifier on macOS", () => {
    const verifier = createDarwinPlatformProtectionVerifier();
    expect(verifier.verifierDigest).toBe(sha256Digest(DARWIN_PLATFORM_PROTECTION_VERIFIER_ID));
    expect(createPlatformProtectionVerifier()?.verifierDigest).toBe(verifier.verifierDigest);
  });

  it("accepts a private directory and file owned by this user", async () => {
    const root = scratch();
    const dir = join(root, "evidence");
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, "ledger.jsonl");
    writeFileSync(file, "x", { mode: 0o600 });
    const verifier = createDarwinPlatformProtectionVerifier();
    expect(await verifier.verify(dir, "directory")).toBe(true);
    expect(await verifier.verify(file, "ledger")).toBe(true);
  });

  it("rejects group or world access, symlinks, missing paths and the wrong kind", async () => {
    const root = scratch();
    const dir = join(root, "evidence");
    mkdirSync(dir, { mode: 0o750 });
    const file = join(root, "note.txt");
    writeFileSync(file, "x", { mode: 0o600 });
    symlinkSync(file, join(root, "link"));
    const verifier = createDarwinPlatformProtectionVerifier();
    expect(await verifier.verify(dir, "directory")).toBe(false);
    chmodSync(dir, 0o700);
    expect(await verifier.verify(dir, "directory")).toBe(true);
    expect(await verifier.verify(join(root, "link"), "ledger")).toBe(false);
    expect(await verifier.verify(join(root, "missing"), "ledger")).toBe(false);
    expect(await verifier.verify(file, "directory")).toBe(false);
  });

  it("rejects an artifact that carries an ACL entry even with mode 0700", async () => {
    const root = scratch();
    const dir = join(root, "evidence");
    mkdirSync(dir, { mode: 0o700 });
    execFileSync("/bin/chmod", ["+a", "everyone allow read", dir]);
    const verifier = createDarwinPlatformProtectionVerifier();
    expect(await verifier.verify(dir, "directory")).toBe(false);
    execFileSync("/bin/chmod", ["-a", "everyone allow read", dir]);
    expect(await verifier.verify(dir, "directory")).toBe(true);
  });
});
