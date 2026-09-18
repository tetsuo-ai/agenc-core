import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalNeovimPathKey } from "../../../src/tui/workbench/buffer/neovim/NeovimPath.js";
import {
  INSTALL_WORKSPACE_WRITE_GATE,
  WORKSPACE_WRITE_MAX_BUFFER_BYTES,
  WORKSPACE_WRITE_MAX_BUFFER_COUNT,
  WORKSPACE_WRITE_MAX_TOTAL_BYTES,
  neovimWorkspaceWriteBufferIsInScope,
  workspaceWriteRequestFromRpcParams,
} from "../../../src/tui/workbench/buffer/neovim/NeovimWorkspaceWriteGate.js";
import type { RpcValue } from "../../../src/tui/workbench/buffer/neovim/NeovimRpc.js";

let sandbox: string | undefined;

afterEach(async () => {
  if (sandbox === undefined) return;
  await rm(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

async function createSandbox(prefix: string): Promise<string> {
  sandbox = await mkdtemp(join(tmpdir(), prefix));
  return sandbox;
}

function writeGateRpcValue(options: {
  readonly path?: string;
  readonly sourcePath?: string;
  readonly buffers: readonly {
    readonly path: string;
    readonly content: string;
    readonly bufferHandle?: number;
    readonly changedtick?: number;
    readonly endOfLine?: boolean;
    readonly dirty?: boolean;
  }[];
}): RpcValue {
  return {
    target: {
      path: options.path ?? "/workspace/target.txt",
      source_path: options.sourcePath ?? options.path ?? "/workspace/target.txt",
      kind: "buffer",
      buffer_handle: 1,
      changedtick: 1,
      end_of_line: true,
      line_start: 1,
      line_end: 1,
    },
    buffers: options.buffers.map((buffer, index) => ({
      path: buffer.path,
      buffer_handle: buffer.bufferHandle ?? index + 1,
      changedtick: buffer.changedtick ?? 1,
      end_of_line: buffer.endOfLine ?? true,
      dirty: buffer.dirty ?? false,
      content: buffer.content,
    })),
  };
}

describe("Neovim workspace write-gate Lua source", () => {
  it("filters by workspace root before reading buffer contents", () => {
    const containment = INSTALL_WORKSPACE_WRITE_GATE.indexOf(
      "agenc_path_is_at_or_within(name, agenc_workspace_root)",
    );
    const readLines = INSTALL_WORKSPACE_WRITE_GATE.indexOf(
      "vim.api.nvim_buf_get_lines",
    );
    expect(INSTALL_WORKSPACE_WRITE_GATE).toContain("select(2, ...)");
    expect(INSTALL_WORKSPACE_WRITE_GATE).toContain("fs_realpath");
    expect(containment).toBeGreaterThan(-1);
    expect(readLines).toBeGreaterThan(containment);
  });

  it("does not lexically collapse symlink/.. with :p before realpath", () => {
    const canonicalize = INSTALL_WORKSPACE_WRITE_GATE.slice(
      INSTALL_WORKSPACE_WRITE_GATE.indexOf("local function agenc_canonical_path"),
      INSTALL_WORKSPACE_WRITE_GATE.indexOf("local function agenc_path_key"),
    );
    expect(canonicalize).toContain("Do not use :p");
    expect(canonicalize).not.toContain("fnamemodify(path, ':p')");
    expect(canonicalize).toContain("fs_realpath");
  });
});

describe("neovimWorkspaceWriteBufferIsInScope", () => {
  it("excludes sibling and parent paths that share a prefix", async () => {
    const root = await createSandbox("agenc-write-gate-prefix-");
    const workspace = join(root, "workspace");
    const sibling = join(root, "workspace-extra");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(sibling, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(workspace, "inside.txt"), "in"),
      writeFile(join(sibling, "outside.txt"), "out"),
    ]);

    expect(
      neovimWorkspaceWriteBufferIsInScope(
        join(workspace, "inside.txt"),
        workspace,
      ),
    ).toBe(true);
    expect(
      neovimWorkspaceWriteBufferIsInScope(
        join(sibling, "outside.txt"),
        workspace,
      ),
    ).toBe(false);
    expect(
      neovimWorkspaceWriteBufferIsInScope(root, workspace),
    ).toBe(false);
  });

  it("treats a symlink into the workspace as in-scope and a symlink out as external", async () => {
    if (process.platform === "win32") return;
    const root = await createSandbox("agenc-write-gate-symlink-");
    const physical = join(root, "physical");
    const workspaceAlias = join(root, "workspace");
    const outside = join(root, "outside");
    await Promise.all([
      mkdir(join(physical, "src"), { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(physical, "src", "app.ts"), "app"),
      writeFile(join(outside, "huge.txt"), "huge"),
      symlink(physical, workspaceAlias, "dir"),
      symlink(outside, join(physical, "escape"), "dir"),
    ]);

    expect(
      neovimWorkspaceWriteBufferIsInScope(
        join(workspaceAlias, "src", "app.ts"),
        workspaceAlias,
      ),
    ).toBe(true);
    expect(
      neovimWorkspaceWriteBufferIsInScope(
        join(outside, "huge.txt"),
        workspaceAlias,
      ),
    ).toBe(false);
    expect(
      neovimWorkspaceWriteBufferIsInScope(
        join(workspaceAlias, "escape", "huge.txt"),
        workspaceAlias,
      ),
    ).toBe(false);
  });

  it("does not treat symlink/.. lexical collapse as workspace containment", async () => {
    if (process.platform === "win32") return;
    const root = await createSandbox("agenc-write-gate-dotdot-");
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(join(outside, "child"), { recursive: true }),
    ]);
    await symlink(join(outside, "child"), join(workspace, "link"), "dir");
    const traversal = `${workspace}${sep}link${sep}..${sep}not-created.txt`;

    expect(neovimWorkspaceWriteBufferIsInScope(traversal, workspace)).toBe(
      false,
    );
  });

  it("compares write-gate paths with the platform identity key", async () => {
    const root = await createSandbox("agenc-write-gate-case-");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const filePath = join(workspace, "File.txt");
    await writeFile(filePath, "ok");

    expect(neovimWorkspaceWriteBufferIsInScope(filePath, workspace)).toBe(true);
    if (process.platform === "win32") {
      expect(canonicalNeovimPathKey(filePath)).toBe(
        canonicalNeovimPathKey(filePath.toUpperCase()),
      );
      expect(
        neovimWorkspaceWriteBufferIsInScope(filePath.toUpperCase(), workspace),
      ).toBe(true);
    } else {
      expect(canonicalNeovimPathKey(filePath)).not.toBe(
        canonicalNeovimPathKey(filePath.toUpperCase()),
      );
    }
  });
});

describe("workspaceWriteRequestFromRpcParams", () => {
  it("ignores oversized external buffers when a workspace root is supplied", async () => {
    const root = await createSandbox("agenc-write-gate-decode-");
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    const workspaceFile = join(workspace, "target.txt");
    const externalFile = join(outside, "huge.txt");
    await Promise.all([
      writeFile(workspaceFile, "small\n"),
      writeFile(externalFile, "x"),
    ]);

    const decoded = workspaceWriteRequestFromRpcParams(
      [
        writeGateRpcValue({
          path: workspaceFile,
          sourcePath: workspaceFile,
          buffers: [
            { path: workspaceFile, content: "small\n", dirty: true },
            {
              path: externalFile,
              content: "x".repeat(WORKSPACE_WRITE_MAX_BUFFER_BYTES + 1),
              bufferHandle: 2,
            },
          ],
        }),
      ],
      workspace,
    );

    expect(decoded).toMatchObject({
      target: { path: workspaceFile, sourcePath: workspaceFile },
      buffers: [
        expect.objectContaining({
          path: workspaceFile,
          content: "small\n",
          dirty: true,
        }),
      ],
    });
    expect(decoded?.buffers).toHaveLength(1);
  });

  it("still rejects an oversized in-workspace buffer", async () => {
    const root = await createSandbox("agenc-write-gate-oversize-");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const workspaceFile = join(workspace, "target.txt");
    await writeFile(workspaceFile, "small\n");

    expect(
      workspaceWriteRequestFromRpcParams(
        [
          writeGateRpcValue({
            path: workspaceFile,
            sourcePath: workspaceFile,
            buffers: [
              {
                path: workspaceFile,
                content: "y".repeat(WORKSPACE_WRITE_MAX_BUFFER_BYTES + 1),
              },
            ],
          }),
        ],
        workspace,
      ),
    ).toBeNull();
  });

  it("still rejects in-workspace buffers that exceed the aggregate byte budget", async () => {
    const root = await createSandbox("agenc-write-gate-total-");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const first = join(workspace, "a.txt");
    const second = join(workspace, "b.txt");
    await Promise.all([writeFile(first, "a"), writeFile(second, "b")]);
    const chunk = "z".repeat(WORKSPACE_WRITE_MAX_TOTAL_BYTES / 2 + 1);

    expect(
      workspaceWriteRequestFromRpcParams(
        [
          writeGateRpcValue({
            path: first,
            sourcePath: first,
            buffers: [
              { path: first, content: chunk },
              { path: second, content: chunk, bufferHandle: 2 },
            ],
          }),
        ],
        workspace,
      ),
    ).toBeNull();
  });

  it("still rejects more in-workspace buffers than the count limit", async () => {
    const root = await createSandbox("agenc-write-gate-count-");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const target = join(workspace, "0.txt");
    const buffers = Array.from(
      { length: WORKSPACE_WRITE_MAX_BUFFER_COUNT + 1 },
      (_, index) => ({
        path: join(workspace, `${index}.txt`),
        content: `${index}\n`,
        bufferHandle: index + 1,
      }),
    );

    expect(
      workspaceWriteRequestFromRpcParams(
        [
          writeGateRpcValue({
            path: target,
            sourcePath: target,
            buffers,
          }),
        ],
        workspace,
      ),
    ).toBeNull();
  });

  it("does not count external buffers toward the in-workspace count limit", async () => {
    const root = await createSandbox("agenc-write-gate-ext-count-");
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    const target = join(workspace, "target.txt");
    const externalBuffers = Array.from(
      { length: WORKSPACE_WRITE_MAX_BUFFER_COUNT + 3 },
      (_, index) => ({
        path: join(outside, `${index}.txt`),
        content: "x\n",
        bufferHandle: index + 2,
      }),
    );

    const decoded = workspaceWriteRequestFromRpcParams(
      [
        writeGateRpcValue({
          path: target,
          sourcePath: target,
          buffers: [
            { path: target, content: "ok\n" },
            ...externalBuffers,
          ],
        }),
      ],
      workspace,
    );

    expect(decoded?.buffers).toEqual([
      expect.objectContaining({ path: target, content: "ok\n" }),
    ]);
  });

  it("keeps a symlink-aliased workspace buffer and drops a symlink escape", async () => {
    if (process.platform === "win32") return;
    const root = await createSandbox("agenc-write-gate-decode-link-");
    const physical = join(root, "physical");
    const workspaceAlias = join(root, "workspace");
    const outside = join(root, "outside");
    await Promise.all([
      mkdir(join(physical, "src"), { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    const aliasedFile = join(workspaceAlias, "src", "app.ts");
    const escapedFile = join(workspaceAlias, "escape", "huge.txt");
    await Promise.all([
      writeFile(join(physical, "src", "app.ts"), "app"),
      writeFile(join(outside, "huge.txt"), "huge"),
      symlink(physical, workspaceAlias, "dir"),
      symlink(outside, join(physical, "escape"), "dir"),
    ]);

    const decoded = workspaceWriteRequestFromRpcParams(
      [
        writeGateRpcValue({
          path: aliasedFile,
          sourcePath: aliasedFile,
          buffers: [
            { path: aliasedFile, content: "app\n" },
            {
              path: escapedFile,
              content: "h".repeat(WORKSPACE_WRITE_MAX_BUFFER_BYTES + 1),
              bufferHandle: 2,
            },
          ],
        }),
      ],
      workspaceAlias,
    );

    expect(decoded?.buffers).toEqual([
      expect.objectContaining({ path: aliasedFile, content: "app\n" }),
    ]);
  });
});
