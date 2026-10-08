import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalizeHomePath, InvalidHomePathError } from "../../src/config/home.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-home-cache-")));
let work = "";
let serial = 0;

beforeEach(() => {
  work = join(root, `case-${++serial}`);
  mkdirSync(work);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
});

/** The uncached algorithm: realpath of the deepest existing ancestor plus the missing tail. */
function reference(path: string): string {
  const missing: string[] = [];
  let ancestor = path.normalize("NFC");
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return join(realpathSync(ancestor), ...missing).normalize("NFC");
}

function agree(path: string): string {
  const value = canonicalizeHomePath(path);
  expect(value).toBe(reference(path));
  return value;
}

describe("cached home canonicalization", () => {
  it("follows a symlinked home when the link is retargeted", () => {
    mkdirSync(join(work, "a"));
    mkdirSync(join(work, "b"));
    symlinkSync(join(work, "a"), join(work, "home"));
    expect(agree(join(work, "home"))).toBe(join(work, "a"));
    unlinkSync(join(work, "home"));
    symlinkSync(join(work, "b"), join(work, "home"));
    expect(agree(join(work, "home"))).toBe(join(work, "b"));
  });

  it("follows a renamed target when the symlink is moved with it", () => {
    mkdirSync(join(work, "a"));
    symlinkSync(join(work, "a"), join(work, "home"));
    expect(agree(join(work, "home"))).toBe(join(work, "a"));
    renameSync(join(work, "a"), join(work, "a2"));
    unlinkSync(join(work, "home"));
    symlinkSync(join(work, "a2"), join(work, "home"));
    expect(agree(join(work, "home"))).toBe(join(work, "a2"));
  });

  it("re-resolves when a missing home is later created as a symlink elsewhere", () => {
    mkdirSync(join(work, "elsewhere"));
    expect(agree(join(work, "home", "nested"))).toBe(join(work, "home", "nested"));
    symlinkSync(join(work, "elsewhere"), join(work, "home"));
    expect(agree(join(work, "home", "nested"))).toBe(join(work, "elsewhere", "nested"));
  });

  it("re-resolves when the existing ancestor disappears or stops being a directory", () => {
    mkdirSync(join(work, "parent"));
    expect(agree(join(work, "parent", "home"))).toBe(join(work, "parent", "home"));
    rmSync(join(work, "parent"), { recursive: true });
    expect(agree(join(work, "parent", "home"))).toBe(join(work, "parent", "home"));
    writeFileSync(join(work, "parent"), "not a directory");
    expect(() => canonicalizeHomePath(join(work, "parent", "home"))).toThrow(InvalidHomePathError);
  });

  it("re-resolves when the ancestor is replaced by another directory at the same path", () => {
    mkdirSync(join(work, "real"));
    symlinkSync(join(work, "real"), join(work, "link"));
    expect(agree(join(work, "link", "home"))).toBe(join(work, "real", "home"));
    rmSync(join(work, "real"), { recursive: true });
    mkdirSync(join(work, "real"));
    expect(agree(join(work, "link", "home"))).toBe(join(work, "real", "home"));
  });

  it("still rejects relative paths before consulting the cache", () => {
    expect(() => canonicalizeHomePath("relative/home")).toThrow(InvalidHomePathError);
  });

  it("does not repeat the realpath walk while nothing changed", async () => {
    vi.resetModules();
    let realpaths = 0;
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        realpathSync: ((path: string) => {
          realpaths += 1;
          return actual.realpathSync(path);
        }) as typeof actual.realpathSync,
      };
    });
    const home = await import("../../src/config/home.js");
    mkdirSync(join(work, "home"));
    const first = home.canonicalizeHomePath(join(work, "home"));
    const second = home.canonicalizeHomePath(join(work, "home"));
    expect(second).toBe(first);
    expect(realpaths).toBe(1);
  });
});
