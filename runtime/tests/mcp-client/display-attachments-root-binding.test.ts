import { afterEach, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  root: "",
  switched: false,
  switchAncestor: undefined as undefined | (() => Promise<void>),
  descriptorPaths: new Map<number, string>(),
}));

vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const mapPath = (path: string): string => {
    const match = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(path);
    if (!match) return path;
    const target = race.descriptorPaths.get(Number(match[1]));
    if (!target) throw new Error("unknown simulated descriptor");
    return match[2] ? `${target}/${match[2]}` : target;
  };
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => fs.lstat(mapPath(String(args[0])), args[1]),
    realpath: async (...args: Parameters<typeof fs.realpath>) => {
      const requested = String(args[0]);
      const resolved = await fs.realpath(mapPath(requested));
      if (requested === race.root && !race.switched) {
        race.switched = true;
        await race.switchAncestor?.();
      }
      return resolved;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const path = mapPath(String(args[0]));
      const handle = await fs.open(path, args[1], args[2]);
      race.descriptorPaths.set(handle.fd, await fs.realpath(path));
      return handle;
    },
  };
});

import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateDisplayBlock } from "../../src/mcp-client/display-attachments.js";

const directories: string[] = [];
afterEach(async () => {
  race.root = "";
  race.switched = false;
  race.switchAncestor = undefined;
  race.descriptorPaths.clear();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it("rejects a root rebound through an outside symlink after its first resolution", async () => {
  const base = await mkdtemp(join(tmpdir(), "display-bound-root-")); directories.push(base);
  const outside = await mkdtemp(join(tmpdir(), "display-bound-outside-")); directories.push(outside);
  const slot = join(base, "slot"); await mkdir(slot);
  const root = join(slot, "allowed"); await mkdir(root);
  await writeFile(join(root, "answer.txt"), "authorized bytes");
  const outsideRoot = join(outside, "allowed"); await mkdir(outsideRoot);
  await writeFile(join(outsideRoot, "answer.txt"), "OUTSIDE_SECRET_BYTES");
  race.root = root;
  race.switchAncestor = async () => {
    await rename(slot, join(base, "parked"));
    await symlink(outside, slot);
  };
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  try {
    await expect(validateDisplayBlock({ type: "resource_link", uri: pathToFileURL(join(root, "answer.txt")).href, name: "answer.txt" }, [root])).rejects.toThrow();
    expect(race.switched).toBe(true);
  } finally { platform.mockRestore(); }
});
