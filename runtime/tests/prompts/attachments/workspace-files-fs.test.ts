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
  /** Directory entries handed to the code under test, by readdir or one at a time by opendir. */
  delivered: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (target: string, options?: unknown) => {
      await hooks.beforeRead?.(String(target));
      const result = await actual.readdir(target, options as never);
      hooks.delivered += (result as unknown[]).length;
      return result;
    },
    opendir: async (target: string, options?: unknown) => {
      await hooks.beforeRead?.(String(target));
      const dir = await actual.opendir(target, options as never);
      return {
        path: dir.path,
        read: async () => {
          const entry = await dir.read();
          if (entry !== null) hooks.delivered += 1;
          return entry;
        },
        close: () => dir.close(),
        async *[Symbol.asyncIterator]() {
          for await (const entry of dir) {
            hooks.delivered += 1;
            yield entry;
          }
        },
      };
    },
  };
});

const { listWorkspaceFiles, workspaceFilesProducer } = await import("../../../src/prompts/attachments/workspace-files.js");
const { getAttachmentTrackingState } = await import("../../../src/session/attachment-state.js");

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
  hooks.delivered = 0;
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

describe("bounded work", () => {
  function producerOpts() {
    return {
      sessionKey: {},
      lightMode: true,
      lightWorkspaceFiles: true,
      turnProvenance: { turnId: "turn-1", rootHumanTurn: { turnId: "turn-1", text: "Fix it." } },
      userInput: "Fix it.",
      loadedTools: [],
      messages: [{ role: "user" as const, content: "Fix it." }],
      permissionContext: { mode: "bypassPermissions" } as never,
      cwd: root,
      subagentDepth: 0,
      signal: new AbortController().signal,
      agencHome: path.join(root, ".agenc-home"),
    };
  }

  test("a stalled read never holds the first request past the deadline; the listing is left out", async () => {
    hooks.beforeRead = (dir) => {
      if (dir === root || dir.endsWith(path.basename(root))) return new Promise((resolve) => setTimeout(resolve, 3_000));
      return undefined;
    };
    const opts = producerOpts();
    const started = Date.now();
    const result = await workspaceFilesProducer(opts, getAttachmentTrackingState(opts.sessionKey));
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(result).toEqual([]);
  });

  test("a huge folder is read one entry at a time up to the inspection cap", async () => {
    for (let i = 0; i < 3_000; i += 1) writeFileSync(path.join(root, `f${String(i).padStart(4, "0")}.txt`), "");
    const listing = await listWorkspaceFiles(root);
    expect(listing.truncated).toBe(true);
    expect(listing.entries.length).toBeLessThanOrEqual(50);
    expect(hooks.delivered).toBeLessThanOrEqual(1_000);
  });

  test("many folders: a bounded number is read and the listing stays within 50 names", async () => {
    for (let i = 0; i < 100; i += 1) write(root, `d${String(i).padStart(3, "0")}/x.txt`);
    const listing = await listWorkspaceFiles(root);
    expect(listing.entries.length).toBeLessThanOrEqual(50);
    // The root's 104 entries plus at most 64 folders of one file each.
    expect(hooks.delivered).toBeLessThanOrEqual(100 + 4 + 64);
  });
});
