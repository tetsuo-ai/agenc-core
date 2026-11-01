/**
 * The workspace file listing under a changing or slow filesystem: folders swapped for links during the walk,
 * and reads that stall or return very large folders.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  beforeRead: undefined as undefined | ((dir: string) => void | Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (target: string, options?: unknown) => {
      await hooks.beforeRead?.(String(target));
      return actual.readdir(target, options as never);
    },
    opendir: async (target: string, options?: unknown) => {
      await hooks.beforeRead?.(String(target));
      return actual.opendir(target, options as never);
    },
  };
});

const { listWorkspaceFiles } = await import("../../../src/prompts/attachments/workspace-files.js");

let root: string;
let outside: string;

function write(base: string, rel: string, text = "x\n"): void {
  const file = path.join(base, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agenc-ws-race-"));
  outside = mkdtempSync(path.join(tmpdir(), "agenc-ws-outside-"));
  mkdirSync(path.join(root, ".git"));
  write(root, ".git/HEAD", "ref: refs/heads/main\n");
  write(root, "README.md");
  write(root, "src/cli.js");
  write(root, "src/deep/inner.js");
  write(root, "test/cli.test.js");
  write(outside, "secret.txt");
  write(outside, "deep/private.txt");
});

afterEach(() => {
  hooks.beforeRead = undefined;
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("workspace listing under a changing filesystem", () => {
  test("drops a queued folder that a link replaced before it was read", async () => {
    let swapped = false;
    hooks.beforeRead = (dir) => {
      if (!swapped && dir.endsWith(`${path.sep}src`)) {
        swapped = true;
        renameSync(dir, `${dir}-moved`);
        symlinkSync(outside, dir);
      }
    };
    const listing = await listWorkspaceFiles(root);
    expect(swapped).toBe(true);
    expect(listing.entries.join("\n")).not.toContain("secret.txt");
    expect(listing.entries).toEqual(expect.arrayContaining(["README.md", "test/cli.test.js"]));
  });

  test("drops a folder whose parent became a link while the walk was under way", async () => {
    let swapped = false;
    hooks.beforeRead = (dir) => {
      // Reading test/ comes after src/ was listed and before src/deep/ is read.
      if (!swapped && dir.endsWith(`${path.sep}test`)) {
        swapped = true;
        renameSync(path.join(root, "src"), path.join(root, "src-moved"));
        symlinkSync(outside, path.join(root, "src"));
      }
    };
    const listing = await listWorkspaceFiles(root);
    expect(swapped).toBe(true);
    expect(listing.entries.join("\n")).not.toContain("private.txt");
  });
});
