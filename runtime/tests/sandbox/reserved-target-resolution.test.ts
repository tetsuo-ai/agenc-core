import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as authority from "../../src/sandbox/desktop-authority-protection.js";
import {
  canWritePathWithCwd,
  canWriteRuntimeOwnedPathWithCwd,
  restrictedFileSystemPolicy,
} from "../../src/sandbox/engine/policy.js";

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reserved-target-"))); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
function policy(reserved: readonly string[]) {
  return restrictedFileSystemPolicy([
    { path: { kind: "path", path: root }, access: "write" },
  ], { reservedReadOnlyPaths: reserved });
}
const checks = [
  { name: "model-directed", check: canWritePathWithCwd },
  { name: "runtime-owned", check: canWriteRuntimeOwnedPathWithCwd },
];

describe.each(checks)("fresh reserved target for $name writes", ({ check }) => {
  it("denies every reserved root regardless of order without denying sibling prefixes", () => {
    const reserved = ["first", "middle", "last"].map(x => path.join(root, x));
    for (const p of reserved) fs.mkdirSync(p);
    for (const order of [reserved, [...reserved].reverse()]) {
      const p = policy(order);
      for (const target of reserved) {
        expect(check(p, target, root, root)).toBe(false);
        expect(check(p, path.join(target, "missing", "leaf"), root, root)).toBe(false);
        expect(check(p, target + "-ordinary", root, root)).toBe(true);
      }
    }
  });

  it("re-resolves a missing leaf after symlink retarget and policy changes", () => {
    const denied = path.join(root, "denied"), allowed = path.join(root, "allowed");
    fs.mkdirSync(denied); fs.mkdirSync(allowed);
    const alias = path.join(root, "alias");
    const p = policy([path.join(root, "unrelated"), denied]);
    fs.symlinkSync(allowed, alias);
    expect(check(p, "alias/new/leaf", root, root)).toBe(true);
    fs.unlinkSync(alias); fs.symlinkSync(denied, alias);
    expect(check(p, "alias/new/leaf", root, root)).toBe(false);
    expect(check(policy([allowed]), "alias/new/leaf", root, root)).toBe(true);
    fs.unlinkSync(alias); fs.symlinkSync(allowed, alias);
    expect(check(policy([allowed]), "alias/new/leaf", root, root)).toBe(false);
    expect(check(p, "alias/new/leaf", root, root)).toBe(true);
  });

  it("uses the supplied cwd for each relative target", () => {
    const denied = path.join(root, "denied"), allowed = path.join(root, "allowed");
    fs.mkdirSync(denied); fs.mkdirSync(allowed);
    const p = policy([denied]);
    expect(check(p, "leaf", allowed, root)).toBe(true);
    expect(check(p, "leaf", denied, root)).toBe(false);
  });

  it.each(["EACCES", "ELOOP"])("propagates %s instead of allowing an unresolved target", code => {
    const error = Object.assign(new Error("resolution failed"), { code });
    vi.spyOn(authority, "canonicalAuthorityPath").mockImplementation(() => { throw error; });
    expect(() => check(policy([path.join(root, "reservation")]), "leaf", root, root)).toThrow(error);
    // The empty reservation set retains its original no-resolution path.
    expect(check(policy([]), "leaf", root, root)).toBe(true);
  });
});
