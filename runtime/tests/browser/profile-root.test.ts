import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveBrowserProfileProjectSync,
  resolveBrowserProjectRootSync,
} from "../../src/browser/profile-root.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "agenc-browser-profile-"));
  roots.push(root);
  return root;
}

describe("resolveBrowserProjectRootSync", () => {
  it("names the repo root from a nested cwd, not the folder the browser opened", () => {
    const repo = tempDir();
    mkdirSync(join(repo, ".git"));
    const nested = join(repo, "packages", "web");
    mkdirSync(nested, { recursive: true });

    expect(resolveBrowserProjectRootSync(nested)).toBe(realpathSync.native(repo));
    expect(resolveBrowserProjectRootSync(nested)).not.toBe(resolve(nested));
  });
});

describe("resolveBrowserProfileProjectSync", () => {
  it("treats a symlink into another repo as a different stored profile", () => {
    const realRepo = tempDir();
    const lexicalRepo = tempDir();
    mkdirSync(join(realRepo, ".git"));
    mkdirSync(join(lexicalRepo, ".git"));
    const nested = join(realRepo, "src");
    mkdirSync(nested);
    const link = join(lexicalRepo, "opened");
    symlinkSync(nested, link);

    const viaLink = resolveBrowserProfileProjectSync(link);
    expect(viaLink.root).toBe(realpathSync.native(realRepo));
    expect(viaLink.lexicalRoot).toBe(realpathSync.native(lexicalRepo));
    expect(viaLink.trustRootMismatch).toBe(true);

    const viaReal = resolveBrowserProfileProjectSync(nested);
    expect(viaReal.root).toBe(viaLink.root);
    expect(viaReal.lexicalRoot).toBe(viaReal.root);
    expect(viaReal.trustRootMismatch).toBe(false);
  });
});
