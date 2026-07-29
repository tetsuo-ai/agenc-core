import { describe, expect, it, vi } from "vitest";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fsMocks = vi.hoisted(() => ({
  link: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsMocks.link.mockImplementation(actual.link);
  fsMocks.unlink.mockImplementation(actual.unlink);
  return {
    ...actual,
    link: fsMocks.link,
    unlink: fsMocks.unlink,
  };
});

import { renamePathNoClobber } from "../../../src/tui/workbench/project-tree/ProjectTreeStore.js";

describe("project tree regular-file rename fallback", () => {
  it.each(["EXDEV", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"])(
    "uses an exclusive copy when link(2) fails with %s",
    async (code) => {
      const repo = await mkdtemp(join(tmpdir(), "agenc-tree-rename-copy-"));
      const source = join(repo, "source.ts");
      const target = join(repo, "target.ts");

      try {
        await writeFile(source, "source\n", "utf8");
        fsMocks.link.mockRejectedValueOnce(fsError(code));

        await renamePathNoClobber(source, target);

        await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(target, "utf8")).toBe("source\n");
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    },
  );

  it("never overwrites a destination that appears before the fallback copy", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-rename-copy-race-"));
    const source = join(repo, "source.ts");
    const target = join(repo, "target.ts");

    try {
      await writeFile(source, "source\n", "utf8");
      fsMocks.link.mockImplementationOnce(async () => {
        await writeFile(target, "racer\n", "utf8");
        throw fsError("EXDEV");
      });

      await expect(renamePathNoClobber(source, target))
        .rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(source, "utf8")).toBe("source\n");
      expect(await readFile(target, "utf8")).toBe("racer\n");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("rolls back an exclusive copy when removing the source fails", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agenc-tree-rename-copy-rollback-"));
    const source = join(repo, "source.ts");
    const target = join(repo, "target.ts");

    try {
      await writeFile(source, "source\n", "utf8");
      fsMocks.link.mockRejectedValueOnce(fsError("EXDEV"));
      fsMocks.unlink.mockRejectedValueOnce(fsError("EPERM"));

      await expect(renamePathNoClobber(source, target))
        .rejects.toMatchObject({ code: "EPERM" });
      expect(await readFile(source, "utf8")).toBe("source\n");
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated filesystem error: ${code}`), {
    code,
  });
}
