import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalNeovimPath,
  canonicalNeovimPathIsAtOrWithin,
  canonicalNeovimPathKey,
} from "../../../src/tui/workbench/buffer/neovim/NeovimPath.js";
import { workspaceMutationAbsolutePath } from "../../../src/tui/workbench/buffer/providers/neovim/NeovimBufferProvider.js";

describe("embedded Neovim path identity", () => {
  it("keeps missing rename paths in the physical workspace namespace", async () => {
    if (process.platform === "win32") return;
    const sandbox = await mkdtemp(join(tmpdir(), "agenc-nvim-path-"));
    const physicalRoot = join(sandbox, "physical");
    const workspaceAlias = join(sandbox, "workspace");
    const source = join(physicalRoot, "src");
    const destination = join(physicalRoot, "lib");

    try {
      await mkdir(source, { recursive: true });
      await symlink(physicalRoot, workspaceAlias, "dir");

      const aliasedSource = join(workspaceAlias, "src");
      expect(canonicalNeovimPath(aliasedSource)).toBe(source);
      expect(canonicalNeovimPathKey(aliasedSource))
        .toBe(canonicalNeovimPathKey(source));

      await rename(source, destination);

      // The old source no longer exists and a nested future target has never
      // existed. Both must still resolve through the physical workspace
      // ancestor, as Neovim's buffer names do.
      expect(canonicalNeovimPath(aliasedSource)).toBe(source);
      expect(canonicalNeovimPath(join(workspaceAlias, "future", "file.ts")))
        .toBe(join(physicalRoot, "future", "file.ts"));
      expect(
        canonicalNeovimPathIsAtOrWithin(
          join(workspaceAlias, "future", "file.ts"),
          workspaceAlias,
        ),
      ).toBe(true);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("does not lexically collapse a symlink followed by dot-dot into the workspace", async () => {
    if (process.platform === "win32") return;
    const sandbox = await mkdtemp(join(tmpdir(), "agenc-nvim-path-dotdot-"));
    const workspace = join(sandbox, "workspace");
    const outside = join(sandbox, "outside");
    const outsideChild = join(outside, "child");

    try {
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(outsideChild, { recursive: true }),
      ]);
      await symlink(outsideChild, join(workspace, "link"), "dir");
      const traversal =
        `${workspace}${sep}link${sep}..${sep}not-created.txt`;

      expect(canonicalNeovimPath(traversal))
        .toBe(join(outside, "not-created.txt"));
      expect(canonicalNeovimPathIsAtOrWithin(traversal, workspace))
        .toBe(false);
      expect(() =>
        workspaceMutationAbsolutePath(
          workspace,
          `link${sep}..${sep}not-created.txt`,
        )
      ).toThrow(/outside the BUFFER workspace/);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
