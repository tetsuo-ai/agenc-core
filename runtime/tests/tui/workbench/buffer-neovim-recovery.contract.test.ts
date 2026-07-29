import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  listRecoverySwapFiles,
  discardRecoverySwapFiles,
  preparePrivateNeovimRecovery,
  privateRecoveryChoiceLua,
  privateRecoveryLua,
  recoveryCopyPath,
  recoveryLuaArgument,
} from "../../../src/tui/workbench/buffer/neovim/NeovimRecovery.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("private embedded-Neovim recovery", () => {
  it("creates a stable private workspace recovery root", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-nvim-recovery-"));
    cleanup.push(root);
    const workspace = join(root, "workspace");
    const agencHome = join(root, "home");
    await mkdir(workspace);

    const first = await preparePrivateNeovimRecovery({
      agencHome,
      workspaceRoot: workspace,
    });
    const second = await preparePrivateNeovimRecovery({
      agencHome,
      workspaceRoot: workspace,
    });

    expect(second.root).toBe(first.root);
    expect(first.root).toContain(join("recovery", "neovim"));
    expect(recoveryLuaArgument(first)).toEqual({
      swap: first.swap,
      undo: first.undo,
      shada: first.shada,
    });
    expect(JSON.parse(await readFile(first.manifest, "utf8"))).toMatchObject({
      version: 1,
      workspaceHash: first.workspaceHash,
    });
    if (process.platform !== "win32") {
      expect((await stat(first.root)).mode & 0o777).toBe(0o700);
      expect((await stat(first.manifest)).mode & 0o777).toBe(0o600);
    }
  });

  it("lists unresolved swap files without deleting them", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-nvim-recovery-"));
    cleanup.push(root);
    const paths = await preparePrivateNeovimRecovery({
      agencHome: join(root, "home"),
      workspaceRoot: root,
    });
    const swap = join(paths.swap, "%workspace%dirty.ts.swp");
    await writeFile(swap, "recovery bytes", { mode: 0o600 });

    const listed = await listRecoverySwapFiles(paths);
    expect(listed.map((path) => basename(path))).toEqual(["%workspace%dirty.ts.swp"]);
    expect(await readFile(swap, "utf8")).toBe("recovery bytes");
  });

  it("enforces swap, undo, ShaDa, and private swap permissions after init", () => {
    const lua = privateRecoveryLua();
    expect(lua).toContain("'swapfile', true");
    expect(lua).toContain("'undofile', true");
    expect(lua).toContain("vim.api.nvim_buf_get_name(buffer) ~= ''");
    expect(lua).toContain("'agenc_recovery_pending'");
    expect(lua).toContain("vim.opt.shadafile = recovery.shada");
    expect(lua).toContain("'BufReadPost', 'BufEnter', 'BufWritePost'");
    expect(lua).toContain("vim.defer_fn(function()");
    expect(lua).toContain("enforce_recovery(buffer)");
    expect(lua).toContain("rw-------");
    expect(privateRecoveryChoiceLua()).toContain("vim.v.swapname");
    expect(privateRecoveryChoiceLua()).toContain("nvim_buf_set_var");
    expect(privateRecoveryChoiceLua()).toContain("agenc_buffer_recovery_detected");
    expect(privateRecoveryChoiceLua()).toContain("vim.v.swapchoice = 'o'");
  });

  it("discards only explicitly selected private swaps and keeps siblings", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-nvim-recovery-"));
    cleanup.push(root);
    const paths = await preparePrivateNeovimRecovery({
      agencHome: join(root, "home"),
      workspaceRoot: root,
    });
    const first = join(paths.swap, "first.swp");
    const second = join(paths.swap, "second.swp");
    await Promise.all([
      writeFile(first, "first"),
      writeFile(second, "second"),
    ]);

    await discardRecoverySwapFiles(paths, [first]);

    await expect(readFile(first, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(second, "utf8")).resolves.toBe("second");
    expect(recoveryCopyPath(paths, "/workspace/example.ts", new Date(0))).toContain(
      join("copies", "example.ts.1970-01-01T00-00-00-000Z.recovered"),
    );
  });
});
