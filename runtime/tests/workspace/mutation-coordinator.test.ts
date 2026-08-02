import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AGENC_DAEMON_INTERNAL_METHODS } from "../../src/app-server/protocol/index.js";
import { createApplyPatchTool } from "../../src/tools/apply-patch/tool.js";
import { createFileEditTool } from "../../src/tools/system/file-edit.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import { SESSION_ID_ARG } from "../../src/tools/system/filesystem.js";
import { createFileWriteTool } from "../../src/tools/system/file-write.js";
import { createNotebookEditTool } from "../../src/tools/system/notebook-edit.js";
import { createFilesystemTools } from "../../src/tools/system/filesystem.js";
import {
  captureWorkspaceAuthoritativeDirtySnapshots,
  WorkspaceMutationCoordinator,
  WorkspaceMutationCoordinatorError,
  WorkspaceMutationCoordinatorRegistry,
  sha256,
  workspaceMutationCoordinators,
  workspaceMutationProposalToolResult,
} from "../../src/workspace/mutation-coordinator.js";

const temporaryPaths: string[] = [];
const originalAgencHome = process.env.AGENC_HOME;

async function tempDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function workspaceMutationStatePath(
  workspaceRoot: string,
  agencHome: string,
  fileName: "ledger-v1.jsonl" | "quarantine-v1.json",
): string {
  const key = createHash("sha256")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 32);
  return join(agencHome, "workspace-mutations", key, fileName);
}

afterEach(async () => {
  if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = originalAgencHome;
  workspaceMutationCoordinators.clearForTests();
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("WorkspaceMutationCoordinator", () => {
  it.runIf(process.platform === "linux")(
    "keeps POSIX NFC and NFD Editor buffer identities distinct",
    async () => {
      const workspaceRoot = await tempDirectory("agenc-coherence-unicode-");
      const agencHome = await tempDirectory("agenc-coherence-home-");
      const nfcPath = join(workspaceRoot, "caf\u00e9.ts");
      const nfdPath = join(workspaceRoot, "cafe\u0301.ts");
      const nfcContent = "export const nfcIdentity = true;\n";
      const nfdContent = "export const nfdIdentity = true;\n";
      const coordinator = new WorkspaceMutationCoordinator({
        workspaceRoot,
        agencHome,
      });
      const lease = coordinator.acquire({
        workspaceRoot,
        editorInstanceId: "unicode-editor",
      });

      coordinator.sync({
        workspaceRoot,
        editorInstanceId: "unicode-editor",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 0,
        buffers: [
          {
            path: nfcPath,
            bufferHandle: 1,
            changedtick: 1,
            contentSha256: sha256(nfcContent),
            dirty: true,
            content: nfcContent,
          },
          {
            path: nfdPath,
            bufferHandle: 2,
            changedtick: 1,
            contentSha256: sha256(nfdContent),
            dirty: true,
            content: nfdContent,
          },
        ],
      });
      await coordinator.flushQuarantinePersistence();

      expect(coordinator.resolvePath(nfcPath)).toBe(nfcPath);
      expect(coordinator.resolvePath(nfdPath)).toBe(nfdPath);
      expect(coordinator.authoritativeRead(nfcPath)).toMatchObject({
        authority: "editor_dirty",
        content: nfcContent,
      });
      expect(coordinator.authoritativeRead(nfdPath)).toMatchObject({
        authority: "editor_dirty",
        content: nfdContent,
      });
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps normalization-sensitive Darwin volume siblings distinct",
    async () => {
      const platformDescriptor = Object.getOwnPropertyDescriptor(
        process,
        "platform",
      );
      if (platformDescriptor === undefined) {
        throw new Error("process.platform descriptor is unavailable");
      }
      Object.defineProperty(process, "platform", {
        ...platformDescriptor,
        value: "darwin",
      });
      try {
        const workspaceRoot = await tempDirectory("agenc-coherence-darwin-");
        const agencHome = await tempDirectory("agenc-coherence-darwin-home-");
        const nfcPath = join(workspaceRoot, "caf\u00e9.ts");
        const nfdPath = join(workspaceRoot, "cafe\u0301.ts");
        const nfcContent = "export const nfcIdentity = true;\n";
        const nfdContent = "export const nfdIdentity = true;\n";
        await writeFile(nfcPath, "nfc disk\n", "utf8");
        await writeFile(nfdPath, "nfd disk\n", "utf8");
        const coordinator = new WorkspaceMutationCoordinator({
          workspaceRoot,
          agencHome,
        });
        const lease = coordinator.acquire({
          workspaceRoot,
          editorInstanceId: "darwin-unicode-editor",
        });
        coordinator.sync({
          workspaceRoot,
          editorInstanceId: lease.editorInstanceId,
          leaseToken: lease.leaseToken,
          epoch: lease.epoch,
          sequence: 0,
          buffers: [
            {
              path: nfcPath,
              bufferHandle: 1,
              changedtick: 1,
              contentSha256: sha256(nfcContent),
              dirty: true,
              content: nfcContent,
            },
            {
              path: nfdPath,
              bufferHandle: 2,
              changedtick: 1,
              contentSha256: sha256(nfdContent),
              dirty: true,
              content: nfdContent,
            },
          ],
        });
        await coordinator.flushQuarantinePersistence();

        expect(coordinator.resolvePath(nfcPath)).toBe(nfcPath);
        expect(coordinator.resolvePath(nfdPath)).toBe(nfdPath);
        expect(coordinator.authoritativeRead(nfcPath)).toMatchObject({
          authority: "editor_dirty",
          content: nfcContent,
        });
        expect(coordinator.authoritativeRead(nfdPath)).toMatchObject({
          authority: "editor_dirty",
          content: nfdContent,
        });
      } finally {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    },
  );

  it("migrates persisted state only after proving the existing canonical root", async () => {
    const parent = await tempDirectory("agenc-coherence-canonical-legacy-");
    const agencHome = await tempDirectory(
      "agenc-coherence-canonical-legacy-home-",
    );
    const workspaceRoot = join(parent, "workspace");
    const persistedAlias = `${parent}/./workspace`;
    await mkdir(workspaceRoot);
    const legacyQuarantinePath = workspaceMutationStatePath(
      persistedAlias,
      agencHome,
      "quarantine-v1.json",
    );
    await mkdir(dirname(legacyQuarantinePath), { recursive: true });
    const content = "legacy dirty content\n";
    await writeFile(
      legacyQuarantinePath,
      `${JSON.stringify({
        version: 1,
        workspaceRoot: persistedAlias,
        entries: [
          {
            path: `${persistedAlias}/buffer.ts`,
            contentSha256: sha256(content),
            contentBytes: Buffer.byteLength(content),
            changedtick: 1,
            epoch: 1,
            editorInstanceId: "legacy-canonical-editor",
            authority: "editor_dirty",
          },
        ],
        proposalCommitments: [],
        proposalReceipts: [],
        mutationIntents: [],
        topologyIntents: [],
        changeSequence: 0,
        changes: [],
      })}\n`,
      "utf8",
    );
    const runtimeQuarantinePath = workspaceMutationStatePath(
      workspaceRoot,
      agencHome,
      "quarantine-v1.json",
    );

    const firstRegistry = new WorkspaceMutationCoordinatorRegistry({
      agencHome,
    });
    expect(
      firstRegistry.getOrCreate(workspaceRoot).hasProtectedEditorPaths(),
    ).toBe(true);
    expect(firstRegistry.hasProtectedEditorAuthority(workspaceRoot)).toBe(true);
    await expect(stat(legacyQuarantinePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(runtimeQuarantinePath)).resolves.toMatchObject({
      isFile: expect.any(Function),
    });

    const secondRegistry = new WorkspaceMutationCoordinatorRegistry({
      agencHome,
    });
    expect(
      secondRegistry.getOrCreate(workspaceRoot).hasProtectedEditorPaths(),
    ).toBe(true);
    expect(secondRegistry.hasProtectedEditorAuthority(workspaceRoot)).toBe(true);
  });

  it.runIf(process.platform === "linux")(
    "does not migrate persisted Darwin state across distinct normalization siblings",
    async () => {
      const platformDescriptor = Object.getOwnPropertyDescriptor(
        process,
        "platform",
      );
      if (platformDescriptor === undefined) {
        throw new Error("process.platform descriptor is unavailable");
      }
      const parent = await tempDirectory("agenc-coherence-sensitive-state-");
      const agencHome = await tempDirectory(
        "agenc-coherence-sensitive-state-home-",
      );
      const nfcWorkspaceRoot = join(parent, "caf\u00e9");
      const nfdWorkspaceRoot = join(parent, "cafe\u0301");
      await mkdir(nfcWorkspaceRoot);
      await mkdir(nfdWorkspaceRoot);
      const nfdQuarantinePath = workspaceMutationStatePath(
        nfdWorkspaceRoot,
        agencHome,
        "quarantine-v1.json",
      );
      const nfcQuarantinePath = workspaceMutationStatePath(
        nfcWorkspaceRoot,
        agencHome,
        "quarantine-v1.json",
      );
      await mkdir(dirname(nfdQuarantinePath), { recursive: true });
      const content = "normalization-sensitive dirty content\n";
      await writeFile(
        nfdQuarantinePath,
        `${JSON.stringify({
          version: 1,
          workspaceRoot: nfdWorkspaceRoot,
          entries: [
            {
              path: join(nfdWorkspaceRoot, "buffer.ts"),
              contentSha256: sha256(content),
              contentBytes: Buffer.byteLength(content),
              changedtick: 1,
              epoch: 1,
              editorInstanceId: "sensitive-darwin-editor",
              authority: "editor_dirty",
            },
          ],
          proposalCommitments: [],
          proposalReceipts: [],
          mutationIntents: [],
          topologyIntents: [],
          changeSequence: 0,
          changes: [],
        })}\n`,
        "utf8",
      );

      Object.defineProperty(process, "platform", {
        ...platformDescriptor,
        value: "darwin",
      });
      try {
        const registry = new WorkspaceMutationCoordinatorRegistry({ agencHome });
        expect(
          registry.getOrCreate(nfcWorkspaceRoot).hasProtectedEditorPaths(),
        ).toBe(false);
        expect(registry.hasProtectedEditorAuthority(nfcWorkspaceRoot)).toBe(
          false,
        );
        expect(
          registry.getOrCreate(nfdWorkspaceRoot).hasProtectedEditorPaths(),
        ).toBe(true);
        await expect(stat(nfdQuarantinePath)).resolves.toMatchObject({
          isFile: expect.any(Function),
        });
        await expect(stat(nfcQuarantinePath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects persisted authority when its workspace path is retargeted",
    async () => {
      const parent = await tempDirectory("agenc-coherence-retarget-");
      const agencHome = await tempDirectory("agenc-coherence-retarget-home-");
      const workspaceRoot = join(parent, "workspace");
      const displaced = join(parent, "workspace-displaced");
      const outside = join(parent, "outside");
      await mkdir(workspaceRoot);
      await mkdir(outside);
      const quarantinePath = workspaceMutationStatePath(
        workspaceRoot,
        agencHome,
        "quarantine-v1.json",
      );
      await mkdir(dirname(quarantinePath), { recursive: true });
      await writeFile(
        quarantinePath,
        `${JSON.stringify({
          version: 1,
          workspaceRoot,
          entries: [],
          proposalCommitments: [],
          proposalReceipts: [],
          mutationIntents: [],
          topologyIntents: [],
          changeSequence: 0,
          changes: [],
        })}\n`,
        "utf8",
      );
      await rename(workspaceRoot, displaced);
      await symlink(outside, workspaceRoot, "dir");
      const registry = new WorkspaceMutationCoordinatorRegistry({ agencHome });

      expect(() => registry.hasProtectedEditorAuthority(workspaceRoot)).toThrow(
        /path identity changed/u,
      );
      await expect(stat(quarantinePath)).resolves.toMatchObject({
        isFile: expect.any(Function),
      });
    },
  );

  it("rejects persisted authority whose workspace root is a file", async () => {
    const parent = await tempDirectory("agenc-coherence-file-root-");
    const agencHome = await tempDirectory("agenc-coherence-file-root-home-");
    const workspaceRoot = join(parent, "not-a-directory");
    await writeFile(workspaceRoot, "ordinary file\n", "utf8");
    const quarantinePath = workspaceMutationStatePath(
      workspaceRoot,
      agencHome,
      "quarantine-v1.json",
    );
    await mkdir(dirname(quarantinePath), { recursive: true });
    await writeFile(
      quarantinePath,
      `${JSON.stringify({
        version: 1,
        workspaceRoot,
        entries: [],
        proposalCommitments: [],
        proposalReceipts: [],
        mutationIntents: [],
        topologyIntents: [],
        changeSequence: 0,
        changes: [],
      })}\n`,
      "utf8",
    );
    const registry = new WorkspaceMutationCoordinatorRegistry({ agencHome });

    expect(() => registry.hasProtectedEditorAuthority(workspaceRoot)).toThrow(
      /path identity changed/u,
    );
    await expect(stat(quarantinePath)).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
  });

  it.each([
    ["overlong", `/${"a".repeat(4_097)}`],
    ["too deeply segmented", `/${"a/".repeat(1_024)}workspace`],
  ])(
    "rejects an %s persisted root before traversing it",
    async (_kind, persistedRoot) => {
      const parent = await tempDirectory("agenc-coherence-bounded-root-");
      const agencHome = await tempDirectory(
        "agenc-coherence-bounded-root-home-",
      );
      const quarantinePath = workspaceMutationStatePath(
        persistedRoot,
        agencHome,
        "quarantine-v1.json",
      );
      await mkdir(dirname(quarantinePath), { recursive: true });
      await writeFile(
        quarantinePath,
        `${JSON.stringify({
          version: 1,
          workspaceRoot: persistedRoot,
          entries: [],
          proposalCommitments: [],
          proposalReceipts: [],
          mutationIntents: [],
          topologyIntents: [],
          changeSequence: 0,
          changes: [],
        })}\n`,
        "utf8",
      );
      const registry = new WorkspaceMutationCoordinatorRegistry({ agencHome });

      expect(() => registry.hasProtectedEditorAuthority(parent)).toThrow(
        /path identity changed/u,
      );
      await expect(stat(quarantinePath)).resolves.toMatchObject({
        isFile: expect.any(Function),
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects persisted authority when an ancestor symlink is retargeted",
    async () => {
      const parent = await tempDirectory("agenc-coherence-ancestor-retarget-");
      const agencHome = await tempDirectory(
        "agenc-coherence-ancestor-retarget-home-",
      );
      const originalParent = join(parent, "original");
      const outsideParent = join(parent, "outside");
      const aliasParent = join(parent, "alias");
      const workspaceRoot = join(aliasParent, "workspace");
      await mkdir(join(originalParent, "workspace"), { recursive: true });
      await mkdir(join(outsideParent, "workspace"), { recursive: true });
      await symlink(originalParent, aliasParent, "dir");
      const quarantinePath = workspaceMutationStatePath(
        workspaceRoot,
        agencHome,
        "quarantine-v1.json",
      );
      await mkdir(dirname(quarantinePath), { recursive: true });
      await writeFile(
        quarantinePath,
        `${JSON.stringify({
          version: 1,
          workspaceRoot,
          entries: [],
          proposalCommitments: [],
          proposalReceipts: [],
          mutationIntents: [],
          topologyIntents: [],
          changeSequence: 0,
          changes: [],
        })}\n`,
        "utf8",
      );
      await rm(aliasParent);
      await symlink(outsideParent, aliasParent, "dir");
      const registry = new WorkspaceMutationCoordinatorRegistry({ agencHome });

      expect(() => registry.hasProtectedEditorAuthority(workspaceRoot)).toThrow(
        /path identity changed/u,
      );
      await expect(stat(quarantinePath)).resolves.toMatchObject({
        isFile: expect.any(Function),
      });
    },
  );

  it("emits a content-free live proposal reference bound to the replacement hash", () => {
    const beforeText = "const value = 1;\n";
    const afterText = "const value = 2;\n";
    const result = workspaceMutationProposalToolResult({
      proposalId: "proposal-live-hash",
      workspaceRoot: "/workspace",
      path: "/workspace/value.ts",
      beforeText,
      afterText,
      baseContentSha256: sha256(beforeText),
      baseChangedtick: 17,
      bufferHandle: 7,
      source: "file_edit",
    });

    expect(result).toMatchObject({
      isError: true,
      metadata: {
        workspaceMutation: {
          kind: "editor_proposal",
          proposalId: "proposal-live-hash",
          baseContentSha256: sha256(beforeText),
          afterContentSha256: sha256(afterText),
          baseChangedtick: 17,
          bufferHandle: 7,
        },
      },
    });
    expect(JSON.stringify(result.metadata)).not.toContain(beforeText);
    expect(JSON.stringify(result.metadata)).not.toContain(afterText);
  });

  it("tracks one revisioned editor lease and reads dirty content exactly", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "unicode.ts");
    await writeFile(path, "const value = 'disk';\n");

    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-a",
    });
    expect(lease.sequence).toBe(-1);
    const content = "const value = '雪';\n";
    const synced = coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-a",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 7,
          changedtick: 41,
          contentSha256: sha256(content),
          dirty: true,
          content,
        },
      ],
    });
    await coordinator.flushQuarantinePersistence();

    expect(synced.dirtyPaths).toEqual([path]);
    expect(
      coordinator.acquire({
        workspaceRoot,
        editorInstanceId: "editor-a",
      }),
    ).toMatchObject({
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
    });
    expect(coordinator.authoritativeRead(path)).toMatchObject({
      authority: "editor_dirty",
      content,
      changedtick: 41,
      bufferHandle: 7,
    });
    expect(() =>
      coordinator.acquire({
        workspaceRoot,
        editorInstanceId: "editor-b",
      }),
    ).toThrowError(WorkspaceMutationCoordinatorError);
  });

  it("quarantines dirty paths when a lease expires and fails closed", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    let now = 100;
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
      now: () => now,
      leaseTtlMs: 10,
    });
    const path = join(workspaceRoot, "dirty.ts");
    const content = "unsaved\n";
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-a",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-a",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 1,
          changedtick: 2,
          contentSha256: sha256(content),
          dirty: true,
          content,
        },
      ],
    });

    now = 111;
    expect(() => coordinator.authoritativeRead(path)).toThrow(
      /may contain unsaved changes/u,
    );
    const admission = await coordinator.prepareMutation({
      path,
      source: "file_edit",
      beforeText: content,
      afterText: "replacement\n",
    });
    expect(admission).toMatchObject({
      decision: "blocked",
      code: "STALE_EDITOR_BUFFER",
    });
  });

  it("hydrates dirty quarantine after coordinator recreation", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "restart-dirty.ts");
    const diskContent = "disk state\n";
    const editorContent = "unsaved editor state\n";
    await writeFile(path, diskContent);

    const first = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = first.acquire({
      workspaceRoot,
      editorInstanceId: "editor-before-restart",
    });
    first.sync({
      workspaceRoot,
      editorInstanceId: "editor-before-restart",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 3,
          changedtick: 17,
          contentSha256: sha256(editorContent),
          dirty: true,
          content: editorContent,
        },
      ],
    });
    const ledgerKey = createHash("sha256")
      .update(workspaceRoot)
      .digest("hex")
      .slice(0, 32);
    const quarantinePath = join(
      agencHome,
      "workspace-mutations",
      ledgerKey,
      "quarantine-v1.json",
    );
    await expect
      .poll(async () => {
        try {
          const parsed = JSON.parse(await readFile(quarantinePath, "utf8")) as {
            entries?: unknown[];
          };
          return parsed.entries?.length ?? 0;
        } catch {
          return 0;
        }
      })
      .toBe(1);

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    expect(restarted.stalePaths()).toEqual([path]);
    expect(() => restarted.authoritativeRead(path)).toThrow(
      /may contain unsaved changes/u,
    );
    await expect(
      restarted.prepareMutation({
        path,
        source: "file_write",
        beforeText: diskContent,
        afterText: "replacement\n",
      }),
    ).resolves.toMatchObject({
      decision: "blocked",
      code: "STALE_EDITOR_BUFFER",
    });
    expect(await readFile(path, "utf8")).toBe(diskContent);

    const reconnectLease = restarted.acquire({
      workspaceRoot,
      editorInstanceId: "editor-before-restart",
    });
    const reconnect = (buffer: {
      readonly changedtick: number;
      readonly contentSha256: string;
      readonly dirty: boolean;
      readonly content?: string;
    }) =>
      restarted.sync({
        workspaceRoot,
        editorInstanceId: "editor-before-restart",
        leaseToken: reconnectLease.leaseToken,
        epoch: reconnectLease.epoch,
        sequence: 0,
        buffers: [
          {
            path,
            bufferHandle: 4,
            ...buffer,
          },
        ],
      });

    expect(() =>
      reconnect({
        changedtick: 18,
        contentSha256: sha256("different saved state\n"),
        dirty: false,
      }),
    ).toThrow(/recovered dirty revision/u);
    expect(() =>
      reconnect({
        changedtick: 17,
        contentSha256: sha256("different dirty state\n"),
        dirty: true,
        content: "different dirty state\n",
      }),
    ).toThrow(/recovered dirty revision/u);
    expect(() =>
      reconnect({
        changedtick: 16,
        contentSha256: sha256(editorContent),
        dirty: true,
        content: editorContent,
      }),
    ).toThrow(/older than 17/u);
    expect(restarted.stalePaths()).toEqual([path]);

    expect(
      reconnect({
        changedtick: 17,
        contentSha256: sha256(editorContent),
        dirty: true,
        content: editorContent,
      }),
    ).toMatchObject({
      accepted: true,
      dirtyPaths: [path],
      stalePaths: [],
    });
    expect(restarted.authoritativeRead(path)).toMatchObject({
      authority: "editor_dirty",
      content: editorContent,
      changedtick: 17,
    });
  });

  it("lets a restarted TUI adopt only the exact quarantined dirty revision under its new instance", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "restart-adoption.ts");
    const dirty = "exact recovered bytes\n";
    const mismatch = "different recovered bytes\n";
    const first = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const firstLease = first.acquire({
      workspaceRoot,
      editorInstanceId: "editor-before-tui-crash",
    });
    first.sync({
      workspaceRoot,
      editorInstanceId: firstLease.editorInstanceId,
      leaseToken: firstLease.leaseToken,
      epoch: firstLease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 3,
          changedtick: 17,
          contentSha256: sha256(dirty),
          contentBytes: Buffer.byteLength(dirty),
          dirty: true,
          content: dirty,
        },
      ],
    });
    await first.flushQuarantinePersistence();

    expect(() =>
      first.acquire({
        workspaceRoot,
        editorInstanceId: "editor-while-owner-is-live",
      }),
    ).toThrow(/authoritative editor/u);

    const mismatchedRestart = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const mismatchedLease = mismatchedRestart.acquire({
      workspaceRoot,
      editorInstanceId: "editor-after-tui-crash-mismatch",
    });
    expect(() =>
      mismatchedRestart.sync({
        workspaceRoot,
        editorInstanceId: mismatchedLease.editorInstanceId,
        leaseToken: mismatchedLease.leaseToken,
        epoch: mismatchedLease.epoch,
        sequence: 0,
        buffers: [
          {
            path,
            bufferHandle: 4,
            changedtick: 18,
            contentSha256: sha256(mismatch),
            contentBytes: Buffer.byteLength(mismatch),
            dirty: true,
            content: mismatch,
          },
        ],
      }),
    ).toThrow(/recovered dirty revision|different editor instance/u);
    const exactRestart = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const exactLease = exactRestart.acquire({
      workspaceRoot,
      editorInstanceId: "editor-after-tui-crash-exact",
    });
    const otherWorkspaceRoot = await tempDirectory(
      "agenc-coherence-other-workspace-",
    );
    expect(() =>
      exactRestart.sync({
        workspaceRoot: otherWorkspaceRoot,
        editorInstanceId: exactLease.editorInstanceId,
        leaseToken: exactLease.leaseToken,
        epoch: exactLease.epoch,
        sequence: 0,
        buffers: [],
      }),
    ).toThrow(/durable workspace scope/u);
    expect(
      exactRestart.sync({
        workspaceRoot,
        editorInstanceId: exactLease.editorInstanceId,
        leaseToken: exactLease.leaseToken,
        epoch: exactLease.epoch,
        sequence: 0,
        buffers: [
          {
            path,
            bufferHandle: 5,
            // Neovim assigns changedtick inside one process. A real :recover
            // may recreate exact unsaved bytes at a lower tick.
            changedtick: 4,
            contentSha256: sha256(dirty),
            contentBytes: Buffer.byteLength(dirty),
            dirty: true,
            content: dirty,
          },
        ],
      }),
    ).toMatchObject({
      accepted: true,
      dirtyPaths: [path],
      stalePaths: [],
    });
    expect(exactRestart.authoritativeRead(path)).toMatchObject({
      authority: "editor_dirty",
      content: dirty,
      bufferHandle: 5,
      changedtick: 4,
    });
  });

  it("rebinds durable proposal bases after exact cross-process buffer recovery", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "restart-proposal-base.ts");
    const base = "unsaved proposal base\n";
    const candidate = "reviewed proposal candidate\n";
    const first = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const firstLease = first.acquire({
      workspaceRoot,
      editorInstanceId: "editor-before-process-restart",
    });
    first.sync({
      workspaceRoot,
      editorInstanceId: firstLease.editorInstanceId,
      leaseToken: firstLease.leaseToken,
      epoch: firstLease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 31,
          changedtick: 27,
          contentSha256: sha256(base),
          contentBytes: Buffer.byteLength(base),
          dirty: true,
          content: base,
        },
      ],
    });
    const admission = await first.prepareMutation({
      path,
      source: "file_edit",
      beforeText: base,
      afterText: candidate,
    });
    if (admission.decision !== "proposal") {
      throw new Error("expected an editor proposal");
    }
    await first.flushQuarantinePersistence();

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const restartedLease = restarted.acquire({
      workspaceRoot,
      editorInstanceId: "editor-after-process-restart",
    });
    restarted.sync({
      workspaceRoot,
      editorInstanceId: restartedLease.editorInstanceId,
      leaseToken: restartedLease.leaseToken,
      epoch: restartedLease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 44,
          changedtick: 3,
          contentSha256: sha256(base),
          contentBytes: Buffer.byteLength(base),
          dirty: true,
          content: base,
        },
      ],
    });

    await expect(
      restarted.proposalStatus({
        workspaceRoot,
        editorInstanceId: restartedLease.editorInstanceId,
        leaseToken: restartedLease.leaseToken,
        epoch: restartedLease.epoch,
        proposalId: admission.proposal.proposalId,
      }),
    ).resolves.toMatchObject({
      status: "committed",
      baseChangedtick: 3,
      bufferHandle: 44,
    });
    await expect(
      restarted.applyProposal({
        workspaceRoot,
        editorInstanceId: restartedLease.editorInstanceId,
        leaseToken: restartedLease.leaseToken,
        epoch: restartedLease.epoch,
        proposalId: admission.proposal.proposalId,
        changedtick: 4,
        contentSha256: sha256(candidate),
        content: candidate,
      }),
    ).resolves.toMatchObject({
      applied: true,
      proposalId: admission.proposal.proposalId,
      changedtick: 4,
    });
  });

  it("makes an omitted dirty revision exactly adoptable only after its live owner expires", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "expired-owner-recovery.ts");
    const dirty = "recover after owner expiry\n";
    let now = 100;
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
      now: () => now,
      leaseTtlMs: 10,
    });
    const firstLease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-before-process-crash",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: firstLease.editorInstanceId,
      leaseToken: firstLease.leaseToken,
      epoch: firstLease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 8,
          changedtick: 3,
          contentSha256: sha256(dirty),
          contentBytes: Buffer.byteLength(dirty),
          dirty: true,
          content: dirty,
        },
      ],
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: firstLease.editorInstanceId,
      leaseToken: firstLease.leaseToken,
      epoch: firstLease.epoch,
      sequence: 1,
      buffers: [],
    });
    expect(() =>
      coordinator.acquire({
        workspaceRoot,
        editorInstanceId: "editor-before-owner-expiry",
      }),
    ).toThrow(/authoritative editor/u);

    now = 111;
    const recoveredLease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-after-owner-expiry",
    });
    expect(
      coordinator.sync({
        workspaceRoot,
        editorInstanceId: recoveredLease.editorInstanceId,
        leaseToken: recoveredLease.leaseToken,
        epoch: recoveredLease.epoch,
        sequence: 0,
        buffers: [
          {
            path,
            bufferHandle: 9,
            changedtick: 3,
            contentSha256: sha256(dirty),
            contentBytes: Buffer.byteLength(dirty),
            dirty: true,
            content: dirty,
          },
        ],
      }),
    ).toMatchObject({
      accepted: true,
      dirtyPaths: [path],
      stalePaths: [],
    });
    await coordinator.flushQuarantinePersistence();
  });

  it("blocks an uncoordinated shell fence on quarantined authority after restart", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "restart-shell-fence.ts");
    const editorContent = "unsaved editor state\n";
    await writeFile(path, "disk state\n");

    const firstRegistry = new WorkspaceMutationCoordinatorRegistry({
      agencHome,
    });
    const first = firstRegistry.getOrCreate(workspaceRoot);
    const lease = firstRegistry.acquireEditor(workspaceRoot, {
      workspaceRoot,
      editorInstanceId: "editor-before-shell-restart",
    });
    first.sync({
      workspaceRoot,
      editorInstanceId: "editor-before-shell-restart",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 1,
          changedtick: 2,
          contentSha256: sha256(editorContent),
          contentBytes: Buffer.byteLength(editorContent, "utf8"),
          dirty: true,
          content: editorContent,
        },
      ],
    });
    await first.flushQuarantinePersistence();

    const restartedRegistry = new WorkspaceMutationCoordinatorRegistry({
      agencHome,
    });
    const shellAcquire = {
      workspaceRoot,
      editorInstanceId: "tui-shell-after-restart",
      requireUnprotectedWorkspace: true,
    } as Parameters<WorkspaceMutationCoordinatorRegistry["acquireEditor"]>[1];
    expect(() =>
      restartedRegistry.acquireEditor(workspaceRoot, shellAcquire),
    ).toThrow(
      /protected Editor authority|Cannot verify persisted Editor authority/u,
    );

    expect(() =>
      restartedRegistry.acquireEditor(workspaceRoot, {
        workspaceRoot,
        editorInstanceId: "editor-reconnecting-after-restart",
      }),
    ).not.toThrow();
  });

  it("blocks an uncoordinated shell fence when quarantine hydration fails", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const quarantinePath = workspaceMutationStatePath(
      workspaceRoot,
      agencHome,
      "quarantine-v1.json",
    );
    await mkdir(dirname(quarantinePath), { recursive: true });
    await writeFile(quarantinePath, "{not-json");

    const restartedRegistry = new WorkspaceMutationCoordinatorRegistry({
      agencHome,
    });
    const shellAcquire = {
      workspaceRoot,
      editorInstanceId: "tui-shell-after-corrupt-restart",
      requireUnprotectedWorkspace: true,
    } as Parameters<WorkspaceMutationCoordinatorRegistry["acquireEditor"]>[1];
    expect(() =>
      restartedRegistry.acquireEditor(workspaceRoot, shellAcquire),
    ).toThrow(
      /protected Editor authority|Cannot verify persisted Editor authority/u,
    );
  });

  it("rejects overlapping parent and child Editor leases", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const childRoot = join(workspaceRoot, "pkg");
    await mkdir(childRoot);

    const parentFirst = new WorkspaceMutationCoordinatorRegistry({ agencHome });
    parentFirst.acquireEditor(workspaceRoot, {
      workspaceRoot,
      editorInstanceId: "parent-editor",
    });
    expect(() =>
      parentFirst.acquireEditor(childRoot, {
        workspaceRoot: childRoot,
        editorInstanceId: "child-editor",
      }),
    ).toThrow(/overlaps protected Editor authority/u);

    const childFirst = new WorkspaceMutationCoordinatorRegistry({ agencHome });
    childFirst.acquireEditor(childRoot, {
      workspaceRoot: childRoot,
      editorInstanceId: "child-editor",
    });
    expect(() =>
      childFirst.acquireEditor(workspaceRoot, {
        workspaceRoot,
        editorInstanceId: "parent-editor",
      }),
    ).toThrow(/overlaps protected Editor authority/u);
  });

  it("does not let a nested clean coordinator shadow quarantined parent authority", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    process.env.AGENC_HOME = agencHome;
    const childRoot = join(workspaceRoot, "pkg");
    const path = join(childRoot, "dirty.ts");
    const diskContent = "disk parent state\n";
    const editorContent = "unsaved parent state\n";
    await mkdir(childRoot);
    await writeFile(path, diskContent);

    const parent = workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const lease = workspaceMutationCoordinators.acquireEditor(workspaceRoot, {
      workspaceRoot,
      editorInstanceId: "parent-before-restart",
    });
    parent.sync({
      workspaceRoot,
      editorInstanceId: "parent-before-restart",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 1,
          changedtick: 3,
          contentSha256: sha256(editorContent),
          contentBytes: Buffer.byteLength(editorContent, "utf8"),
          dirty: true,
          content: editorContent,
        },
      ],
    });
    await parent.flushQuarantinePersistence();

    workspaceMutationCoordinators.clearForTests();
    workspaceMutationCoordinators.getOrCreate(childRoot);

    expect(() =>
      workspaceMutationCoordinators.acquireEditor(childRoot, {
        workspaceRoot: childRoot,
        editorInstanceId: "child-after-restart",
      }),
    ).toThrow(/overlaps protected Editor authority/u);

    const read = await createFileReadTool({
      allowedPaths: [workspaceRoot],
    }).execute({
      file_path: path,
      [SESSION_ID_ARG]: "nested-authority-read",
    });
    expect(read.isError).toBe(true);
    expect(read.content).toMatch(/may contain unsaved changes|must reconnect/u);

    await expect(
      createFileWriteTool({
        allowedPaths: [workspaceRoot],
      }).execute({
        file_path: path,
        content: "child replacement\n",
        [SESSION_ID_ARG]: "nested-authority-write",
      }),
    ).rejects.toThrow(/may contain unsaved changes|must reconnect/u);
    expect(await readFile(path, "utf8")).toBe(diskContent);
  });

  it("discovers quarantined child authority before a parent Editor acquires", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const childRoot = join(workspaceRoot, "pkg");
    const path = join(childRoot, "dirty.ts");
    const editorContent = "unsaved child state\n";
    await mkdir(childRoot);
    await writeFile(path, "disk child state\n");

    const childRegistry = new WorkspaceMutationCoordinatorRegistry({
      agencHome,
    });
    const child = childRegistry.getOrCreate(childRoot);
    const lease = childRegistry.acquireEditor(childRoot, {
      workspaceRoot: childRoot,
      editorInstanceId: "child-before-restart",
    });
    child.sync({
      workspaceRoot: childRoot,
      editorInstanceId: "child-before-restart",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 1,
          changedtick: 2,
          contentSha256: sha256(editorContent),
          contentBytes: Buffer.byteLength(editorContent, "utf8"),
          dirty: true,
          content: editorContent,
        },
      ],
    });
    await child.flushQuarantinePersistence();

    const restartedRegistry = new WorkspaceMutationCoordinatorRegistry({
      agencHome,
    });
    expect(() =>
      restartedRegistry.acquireEditor(workspaceRoot, {
        workspaceRoot,
        editorInstanceId: "parent-after-restart",
      }),
    ).toThrow(/overlaps protected Editor authority/u);
    expect(() =>
      restartedRegistry.beginToolOperation(
        workspaceRoot,
        "parent-shell-after-restart",
      ),
    ).toThrow(/protected Editor authority/u);
    const readOperation = restartedRegistry.beginReadToolOperation(
      workspaceRoot,
      "parent-read-after-restart",
    );
    expect(readOperation.requiresStrictCandidateReads).toBe(true);
    const siblingRoot = join(workspaceRoot, "sibling");
    await mkdir(siblingRoot);
    expect(() =>
      restartedRegistry.acquireEditor(siblingRoot, {
        workspaceRoot: siblingRoot,
        editorInstanceId: "sibling-during-parent-read",
      }),
    ).toThrow(/active tool/u);
    restartedRegistry.endToolOperation(readOperation.token);
    expect(
      restartedRegistry.acquireEditor(siblingRoot, {
        workspaceRoot: siblingRoot,
        editorInstanceId: "sibling-after-parent-read",
      }).editorInstanceId,
    ).toBe("sibling-after-parent-read");
  });

  it.runIf(process.platform !== "win32")(
    "keeps the Editor-acquisition fence attached after the admitted root is renamed",
    async () => {
      const workspaceRoot = await tempDirectory("agenc-coherence-fenced-root-");
      const displacedRoot = `${workspaceRoot}-displaced`;
      temporaryPaths.push(displacedRoot);
      const registry = new WorkspaceMutationCoordinatorRegistry();
      const operation = registry.beginReadToolOperation(
        workspaceRoot,
        "renamed-root-read",
      );

      await rename(workspaceRoot, displacedRoot);
      const nestedRoot = join(displacedRoot, "nested");
      await mkdir(nestedRoot);

      expect(() =>
        registry.acquireEditor(nestedRoot, {
          workspaceRoot: nestedRoot,
          editorInstanceId: "renamed-root-editor",
        }),
      ).toThrow(/active tool/u);

      registry.endToolOperation(operation.token);
      expect(
        registry.acquireEditor(nestedRoot, {
          workspaceRoot: nestedRoot,
          editorInstanceId: "post-read-editor",
        }).editorInstanceId,
      ).toBe("post-read-editor");
    },
  );

  it.runIf(process.platform !== "win32")(
    "captures the admitted dirty identity after a pathname exchange",
    async () => {
      const workspaceRoot = await tempDirectory(
        "agenc-coherence-captured-root-",
      );
      const displacedRoot = `${workspaceRoot}-displaced`;
      temporaryPaths.push(displacedRoot);
      const outsideRoot = await tempDirectory(
        "agenc-coherence-captured-outside-",
      );
      process.env.AGENC_HOME = await tempDirectory(
        "agenc-coherence-captured-home-",
      );
      const dirtyPath = join(workspaceRoot, "dirty.ts");
      const dirtyContent = "authoritative editor bytes\n";
      await writeFile(dirtyPath, "stale disk bytes\n", "utf8");
      const coordinator = workspaceMutationCoordinators.getOrCreate(
        workspaceRoot,
      );
      const lease = coordinator.acquire({
        workspaceRoot,
        editorInstanceId: "captured-root-editor",
      });
      coordinator.sync({
        workspaceRoot,
        editorInstanceId: lease.editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 0,
        buffers: [
          {
            path: dirtyPath,
            bufferHandle: 1,
            changedtick: 1,
            contentSha256: sha256(dirtyContent),
            dirty: true,
            content: dirtyContent,
          },
        ],
      });
      await coordinator.flushQuarantinePersistence();

      await rename(workspaceRoot, displacedRoot);
      await writeFile(
        join(outsideRoot, "dirty.ts"),
        "replacement path bytes\n",
        "utf8",
      );
      await symlink(outsideRoot, workspaceRoot, "dir");

      const capture = captureWorkspaceAuthoritativeDirtySnapshots(
        workspaceRoot,
        { includeDescendants: true },
      );
      expect(capture.snapshots).toHaveLength(1);
      expect(capture.snapshots[0]).toMatchObject({
        path: dirtyPath,
        content: dirtyContent,
        authority: "editor_dirty",
      });
      expect(capture.isCurrent()).toBe(true);
    },
  );

  it("quarantines last-known-clean loaded paths after a daemon crash", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "clean-before-crash.ts");
    const content = "export const clean = true;\n";
    await writeFile(path, content);
    const first = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = first.acquire({
      workspaceRoot,
      editorInstanceId: "editor-before-clean-crash",
    });
    first.sync({
      workspaceRoot,
      editorInstanceId: "editor-before-clean-crash",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 4,
          changedtick: 2,
          contentSha256: sha256(content),
          contentBytes: Buffer.byteLength(content, "utf8"),
          dirty: false,
        },
      ],
    });
    await first.flushQuarantinePersistence();

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });

    expect(restarted.authorityForPath(path)).toBe("stale_dirty");
    await expect(
      restarted.prepareMutation({
        path,
        source: "file_write",
        beforeText: content,
        afterText: "replacement\n",
      }),
    ).resolves.toMatchObject({
      decision: "blocked",
      code: "STALE_EDITOR_BUFFER",
    });
  });

  it("fails closed when durable quarantine contains an unsafe entry", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const outsideRoot = await tempDirectory("agenc-coherence-outside-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "inside.ts");
    await writeFile(path, "disk\n");
    const ledgerKey = createHash("sha256")
      .update(workspaceRoot)
      .digest("hex")
      .slice(0, 32);
    const quarantineDirectory = join(
      agencHome,
      "workspace-mutations",
      ledgerKey,
    );
    await mkdir(quarantineDirectory, { recursive: true });
    await writeFile(
      join(quarantineDirectory, "quarantine-v1.json"),
      JSON.stringify({
        version: 1,
        workspaceRoot,
        entries: [
          {
            path: join(outsideRoot, "secret.ts"),
            contentSha256: sha256("unsaved\n"),
            changedtick: 4,
            epoch: 1,
          },
        ],
      }),
    );

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    expect(restarted.authorityForPath(path)).toBe("stale_dirty");
    expect(() => restarted.authoritativeRead(path)).toThrow(
      /may contain unsaved changes/u,
    );
    await expect(
      restarted.prepareMutation({
        path,
        source: "file_edit",
        beforeText: "disk\n",
        afterText: "changed\n",
      }),
    ).resolves.toMatchObject({
      decision: "blocked",
      code: "STALE_EDITOR_BUFFER",
    });
  });

  it("refuses an oversized quarantine before replacing the last readable snapshot", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-oversized-quarantine",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-oversized-quarantine",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [],
    });
    await coordinator.flushQuarantinePersistence();
    const longRelativePrefix = Array.from(
      { length: 12 },
      (_, index) => `segment-${index}-${"x".repeat(80)}`,
    ).join("/");
    const buffers = Array.from({ length: 512 }, (_, index) => {
      const content = `dirty-${index}\n`;
      return {
        path: join(workspaceRoot, longRelativePrefix, `buffer-${index}.ts`),
        bufferHandle: index,
        changedtick: 1,
        contentSha256: sha256(content),
        dirty: true,
        content,
      };
    });
    expect(() =>
      coordinator.sync({
        workspaceRoot,
        editorInstanceId: "editor-oversized-quarantine",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 1,
        buffers,
      }),
    ).toThrow(/quarantine exceeds/u);

    const quarantinePath = workspaceMutationStatePath(
      workspaceRoot,
      agencHome,
      "quarantine-v1.json",
    );
    expect((await stat(quarantinePath)).size).toBeLessThanOrEqual(512 * 1024);
    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    expect(restarted.stalePaths()).toEqual([]);
    expect(restarted.authorityForPath(join(workspaceRoot, "safe.ts"))).toBe(
      "disk_authoritative",
    );
  });

  it("returns a non-mutating proposal for a dirty target", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const content = "dirty base\n";
    const path = join(workspaceRoot, "proposal.ts");
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-a",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-a",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 3,
          changedtick: 9,
          contentSha256: sha256(content),
          dirty: true,
          content,
        },
      ],
    });

    const admission = await coordinator.prepareMutation({
      path,
      source: "file_write",
      beforeText: content,
      afterText: "candidate\n",
      sessionId: "session-1",
      toolCallId: "call-1",
    });
    expect(admission).toMatchObject({
      decision: "proposal",
      proposal: {
        path,
        beforeText: content,
        afterText: "candidate\n",
        baseChangedtick: 9,
      },
    });
    const ledgerKey = createHash("sha256")
      .update(workspaceRoot)
      .digest("hex")
      .slice(0, 32);
    const durableLedger = await readFile(
      join(agencHome, "workspace-mutations", ledgerKey, "ledger-v1.jsonl"),
      "utf8",
    );
    expect(durableLedger).not.toContain(content);
    expect(durableLedger).not.toContain("candidate\n");
    expect(durableLedger).toContain(sha256(content));
    expect(durableLedger).toContain(sha256("candidate\n"));
  });

  it("reports lease-authorized proposal recovery states across restarts", async () => {
    const workspaceRoot = await tempDirectory(
      "agenc-proposal-status-workspace-",
    );
    const agencHome = await tempDirectory("agenc-proposal-status-home-");
    const path = join(workspaceRoot, "status.ts");
    const base = "private dirty base\n";
    const candidate = "private reviewed candidate\n";
    const discardedCandidate = "private discarded candidate\n";
    const first = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const firstLease = first.acquire({
      workspaceRoot,
      editorInstanceId: "editor-proposal-status",
    });
    first.sync({
      workspaceRoot,
      editorInstanceId: "editor-proposal-status",
      leaseToken: firstLease.leaseToken,
      epoch: firstLease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 27,
          changedtick: 4,
          contentSha256: sha256(base),
          dirty: true,
          content: base,
        },
      ],
    });
    const admission = await first.prepareMutation({
      path,
      source: "file_edit",
      beforeText: base,
      afterText: candidate,
    });
    if (admission.decision !== "proposal") {
      throw new Error("expected an editor proposal");
    }

    await expect(
      first.proposalStatus({
        workspaceRoot,
        editorInstanceId: "editor-proposal-status",
        leaseToken: firstLease.leaseToken,
        epoch: firstLease.epoch,
        proposalId: admission.proposal.proposalId,
      }),
    ).resolves.toEqual({
      status: "reviewable",
      proposal: admission.proposal,
    });
    await expect(
      first.proposalStatus({
        workspaceRoot,
        editorInstanceId: "editor-proposal-status",
        leaseToken: "wrong-lease-token",
        epoch: firstLease.epoch,
        proposalId: admission.proposal.proposalId,
      }),
    ).rejects.toThrow(/lease token, instance, or epoch does not match/u);

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const restartedLease = restarted.acquire({
      workspaceRoot,
      editorInstanceId: "editor-proposal-status",
    });
    const statusInput = {
      workspaceRoot,
      editorInstanceId: "editor-proposal-status",
      leaseToken: restartedLease.leaseToken,
      epoch: restartedLease.epoch,
      proposalId: admission.proposal.proposalId,
    };
    await expect(restarted.proposalStatus(statusInput)).resolves.toEqual({
      status: "committed",
      proposalId: admission.proposal.proposalId,
      path,
      source: "file_edit",
      baseContentSha256: sha256(base),
      afterContentSha256: sha256(candidate),
      baseChangedtick: 4,
      bufferHandle: 27,
    });

    await restarted.applyProposal({
      ...statusInput,
      changedtick: 5,
      contentSha256: sha256(candidate),
      content: candidate,
    });
    await expect(restarted.proposalStatus(statusInput)).resolves.toEqual({
      status: "applied",
      proposalId: admission.proposal.proposalId,
      path,
      changedtick: 5,
      contentSha256: sha256(candidate),
    });

    const discardAdmission = await restarted.prepareMutation({
      path,
      source: "file_write",
      beforeText: candidate,
      afterText: discardedCandidate,
    });
    if (discardAdmission.decision !== "proposal") {
      throw new Error("expected a discardable editor proposal");
    }
    const discardStatusInput = {
      ...statusInput,
      proposalId: discardAdmission.proposal.proposalId,
    };
    await restarted.discardProposalForEditor(discardStatusInput);
    await expect(restarted.proposalStatus(discardStatusInput)).resolves.toEqual(
      {
        status: "discarded",
        proposalId: discardAdmission.proposal.proposalId,
        path,
      },
    );

    const afterRestart = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const afterRestartLease = afterRestart.acquire({
      workspaceRoot,
      editorInstanceId: "editor-proposal-status-after-restart",
    });
    const afterRestartInput = {
      workspaceRoot,
      editorInstanceId: "editor-proposal-status-after-restart",
      leaseToken: afterRestartLease.leaseToken,
      epoch: afterRestartLease.epoch,
    };
    await expect(
      afterRestart.proposalStatus({
        ...afterRestartInput,
        proposalId: admission.proposal.proposalId,
      }),
    ).resolves.toMatchObject({
      status: "applied",
      proposalId: admission.proposal.proposalId,
    });
    await expect(
      afterRestart.proposalStatus({
        ...afterRestartInput,
        proposalId: discardAdmission.proposal.proposalId,
      }),
    ).resolves.toEqual({
      status: "discarded",
      proposalId: discardAdmission.proposal.proposalId,
      path,
    });
    await expect(
      afterRestart.proposalStatus({
        ...afterRestartInput,
        proposalId: "missing-proposal",
      }),
    ).resolves.toEqual({
      status: "missing",
      proposalId: "missing-proposal",
    });
  });

  it("waits behind an in-flight acknowledgement before resolving an old proposed event", async () => {
    const workspaceRoot = await tempDirectory("agenc-proposal-status-race-");
    const agencHome = await tempDirectory("agenc-proposal-status-race-home-");
    const path = join(workspaceRoot, "response-loss.ts");
    const base = "dirty base\n";
    const candidate = "accepted candidate\n";
    let releaseApplied!: () => void;
    let reportAppliedStarted!: () => void;
    const appliedStarted = new Promise<void>((resolve) => {
      reportAppliedStarted = resolve;
    });
    const appliedGate = new Promise<void>((resolve) => {
      releaseApplied = resolve;
    });
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
      appendLedger: async (entry) => {
        if (entry.status !== "applied") return;
        reportAppliedStarted();
        await appliedGate;
      },
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-proposal-status-race",
    });
    const leaseInput = {
      workspaceRoot,
      editorInstanceId: "editor-proposal-status-race",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
    };
    coordinator.sync({
      ...leaseInput,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 28,
          changedtick: 8,
          contentSha256: sha256(base),
          dirty: true,
          content: base,
        },
      ],
    });
    const admission = await coordinator.prepareMutation({
      path,
      source: "file_edit",
      beforeText: base,
      afterText: candidate,
    });
    if (admission.decision !== "proposal") {
      throw new Error("expected an editor proposal");
    }
    const oldProposedEvent = coordinator
      .listChanges({
        ...leaseInput,
        afterSequence: 0,
      })
      .changes.find(
        (change) => change.proposalId === admission.proposal.proposalId,
      );
    expect(oldProposedEvent).toMatchObject({ status: "proposed" });

    const apply = coordinator.applyProposal({
      ...leaseInput,
      proposalId: admission.proposal.proposalId,
      changedtick: 9,
      contentSha256: sha256(candidate),
      content: candidate,
    });
    await appliedStarted;
    let statusSettled = false;
    const status = coordinator
      .proposalStatus({
        ...leaseInput,
        proposalId: admission.proposal.proposalId,
      })
      .finally(() => {
        statusSettled = true;
      });
    await Promise.resolve();
    expect(statusSettled).toBe(false);

    releaseApplied();
    await expect(apply).resolves.toMatchObject({ applied: true });
    await expect(status).resolves.toEqual({
      status: "applied",
      proposalId: admission.proposal.proposalId,
      path,
      changedtick: 9,
      contentSha256: sha256(candidate),
    });
    expect(oldProposedEvent?.status).toBe("proposed");
  });

  it("lets a restarted TUI exactly acknowledge a content-free proposal commitment under its new instance", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "restart-proposal.ts");
    const base = "private dirty base\n";
    const candidate = "private reviewed candidate\n";
    const first = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const firstLease = first.acquire({
      workspaceRoot,
      editorInstanceId: "editor-before-restart",
    });
    first.sync({
      workspaceRoot,
      editorInstanceId: "editor-before-restart",
      leaseToken: firstLease.leaseToken,
      epoch: firstLease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 31,
          changedtick: 9,
          contentSha256: sha256(base),
          dirty: true,
          content: base,
        },
      ],
    });
    const admission = await first.prepareMutation({
      path,
      source: "file_edit",
      beforeText: base,
      afterText: candidate,
    });
    if (admission.decision !== "proposal") {
      throw new Error("expected an editor proposal");
    }

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const restartedLease = restarted.acquire({
      workspaceRoot,
      editorInstanceId: "editor-after-restart",
    });
    const applied = await restarted.applyProposal({
      workspaceRoot,
      editorInstanceId: "editor-after-restart",
      leaseToken: restartedLease.leaseToken,
      epoch: restartedLease.epoch,
      proposalId: admission.proposal.proposalId,
      changedtick: 10,
      contentSha256: sha256(candidate),
      content: candidate,
    });
    expect(applied).toEqual({
      applied: true,
      proposalId: admission.proposal.proposalId,
      path,
      changedtick: 10,
      contentSha256: sha256(candidate),
    });

    const afterResponseLoss = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const retryLease = afterResponseLoss.acquire({
      workspaceRoot,
      editorInstanceId: "editor-after-response-loss",
    });
    await expect(
      afterResponseLoss.applyProposal({
        workspaceRoot,
        editorInstanceId: "editor-after-response-loss",
        leaseToken: retryLease.leaseToken,
        epoch: retryLease.epoch,
        proposalId: admission.proposal.proposalId,
        changedtick: 10,
        contentSha256: sha256(candidate),
        content: candidate,
      }),
    ).resolves.toEqual(applied);
    await expect(
      afterResponseLoss.discardProposalForEditor({
        workspaceRoot,
        editorInstanceId: "editor-after-response-loss",
        leaseToken: retryLease.leaseToken,
        epoch: retryLease.epoch,
        proposalId: admission.proposal.proposalId,
      }),
    ).rejects.toThrow(/already applied/u);

    const ledgerKey = createHash("sha256")
      .update(workspaceRoot)
      .digest("hex")
      .slice(0, 32);
    const quarantine = await readFile(
      join(agencHome, "workspace-mutations", ledgerKey, "quarantine-v1.json"),
      "utf8",
    );
    expect(quarantine).not.toContain(base);
    expect(quarantine).not.toContain(candidate);
    expect(quarantine).toContain(sha256(candidate));
    expect(quarantine).toContain(admission.proposal.proposalId);
  });

  it("reconciles exact accepted proposal bytes under a fresh Editor process tick", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "accepted-before-ack.ts");
    const base = "dirty base\n";
    const candidate = "accepted in editor\n";
    const first = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const firstLease = first.acquire({
      workspaceRoot,
      editorInstanceId: "editor-before-crash",
    });
    first.sync({
      workspaceRoot,
      editorInstanceId: "editor-before-crash",
      leaseToken: firstLease.leaseToken,
      epoch: firstLease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 41,
          changedtick: 5,
          contentSha256: sha256(base),
          dirty: true,
          content: base,
        },
      ],
    });
    const admission = await first.prepareMutation({
      path,
      source: "file_write",
      beforeText: base,
      afterText: candidate,
    });
    if (admission.decision !== "proposal") {
      throw new Error("expected an editor proposal");
    }

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = restarted.acquire({
      workspaceRoot,
      editorInstanceId: "editor-after-full-process-restart",
    });
    expect(
      restarted.sync({
        workspaceRoot,
        editorInstanceId: lease.editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 0,
        buffers: [
          {
            path,
            bufferHandle: 52,
            changedtick: 2,
            contentSha256: sha256(candidate),
            dirty: true,
            content: candidate,
          },
        ],
      }),
    ).toMatchObject({ accepted: true, dirtyPaths: [path] });
    await expect(
      restarted.proposalStatus({
        workspaceRoot,
        editorInstanceId: lease.editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        proposalId: admission.proposal.proposalId,
      }),
    ).resolves.toMatchObject({
      status: "committed",
      bufferHandle: 52,
      acceptedChangedtick: 2,
    });
    await expect(
      restarted.applyProposal({
        workspaceRoot,
        editorInstanceId: lease.editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        proposalId: admission.proposal.proposalId,
        changedtick: 2,
        contentSha256: sha256(candidate),
        content: candidate,
      }),
    ).resolves.toMatchObject({
      applied: true,
      proposalId: admission.proposal.proposalId,
    });
  });

  it("persists discarded proposal receipts across restarts", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "discarded-proposal.ts");
    const base = "dirty base\n";
    const first = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const firstLease = first.acquire({
      workspaceRoot,
      editorInstanceId: "editor-before-restart",
    });
    first.sync({
      workspaceRoot,
      editorInstanceId: "editor-before-restart",
      leaseToken: firstLease.leaseToken,
      epoch: firstLease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 51,
          changedtick: 2,
          contentSha256: sha256(base),
          dirty: true,
          content: base,
        },
      ],
    });
    const admission = await first.prepareMutation({
      path,
      source: "file_edit",
      beforeText: base,
      afterText: "discard me\n",
    });
    if (admission.decision !== "proposal") {
      throw new Error("expected an editor proposal");
    }
    const firstRestart = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const discardLease = firstRestart.acquire({
      workspaceRoot,
      editorInstanceId: "discarding-editor",
    });
    const discarded = await firstRestart.discardProposalForEditor({
      workspaceRoot,
      editorInstanceId: "discarding-editor",
      leaseToken: discardLease.leaseToken,
      epoch: discardLease.epoch,
      proposalId: admission.proposal.proposalId,
    });

    const secondRestart = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const retryLease = secondRestart.acquire({
      workspaceRoot,
      editorInstanceId: "retrying-editor",
    });
    await expect(
      secondRestart.discardProposalForEditor({
        workspaceRoot,
        editorInstanceId: "retrying-editor",
        leaseToken: retryLease.leaseToken,
        epoch: retryLease.epoch,
        proposalId: admission.proposal.proposalId,
      }),
    ).resolves.toEqual(discarded);
  });

  it("discards a proposal after the editor has advanced beyond its base revision", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "stale-discard.ts");
    const base = "dirty base\n";
    const newer = "user kept typing\n";
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-stale-discard",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-stale-discard",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 55,
          changedtick: 2,
          contentSha256: sha256(base),
          dirty: true,
          content: base,
        },
      ],
    });
    const admission = await coordinator.prepareMutation({
      path,
      source: "file_edit",
      beforeText: base,
      afterText: "candidate\n",
    });
    if (admission.decision !== "proposal") {
      throw new Error("expected an editor proposal");
    }
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-stale-discard",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 1,
      buffers: [
        {
          path,
          bufferHandle: 55,
          changedtick: 3,
          contentSha256: sha256(newer),
          dirty: true,
          content: newer,
        },
      ],
    });
    await expect(
      coordinator.proposalStatus({
        workspaceRoot,
        editorInstanceId: "editor-stale-discard",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        proposalId: admission.proposal.proposalId,
      }),
    ).resolves.toMatchObject({
      status: "committed",
      proposalId: admission.proposal.proposalId,
      baseContentSha256: sha256(base),
      afterContentSha256: sha256("candidate\n"),
    });
    const discarded = await coordinator.discardProposalForEditor({
      workspaceRoot,
      editorInstanceId: "editor-stale-discard",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      proposalId: admission.proposal.proposalId,
    });
    expect(discarded).toMatchObject({
      discarded: true,
      proposalId: admission.proposal.proposalId,
    });
    expect(coordinator.authoritativeRead(path)).toMatchObject({
      content: newer,
      changedtick: 3,
    });

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const retryLease = restarted.acquire({
      workspaceRoot,
      editorInstanceId: "editor-stale-discard-retry",
    });
    await expect(
      restarted.discardProposalForEditor({
        workspaceRoot,
        editorInstanceId: "editor-stale-discard-retry",
        leaseToken: retryLease.leaseToken,
        epoch: retryLease.epoch,
        proposalId: admission.proposal.proposalId,
      }),
    ).resolves.toEqual(discarded);
  });

  it("serializes every queued resolver after a failed proposal acknowledgement", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "proposal-resolution-chain.ts");
    const base = "dirty base\n";
    const candidate = "reviewed candidate\n";
    let appliedAttempts = 0;
    let releaseSecondApplied!: () => void;
    let reportSecondApplied!: () => void;
    const secondAppliedStarted = new Promise<void>((resolve) => {
      reportSecondApplied = resolve;
    });
    const secondAppliedGate = new Promise<void>((resolve) => {
      releaseSecondApplied = resolve;
    });
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
      appendLedger: async (entry) => {
        if (entry.status !== "applied" || entry.proposalId === undefined)
          return;
        appliedAttempts += 1;
        if (appliedAttempts === 1) throw new Error("injected ledger failure");
        if (appliedAttempts === 2) {
          reportSecondApplied();
          await secondAppliedGate;
        }
      },
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-resolution-chain",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-resolution-chain",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 56,
          changedtick: 7,
          contentSha256: sha256(base),
          dirty: true,
          content: base,
        },
      ],
    });
    const admission = await coordinator.prepareMutation({
      path,
      source: "file_edit",
      beforeText: base,
      afterText: candidate,
    });
    if (admission.decision !== "proposal") {
      throw new Error("expected an editor proposal");
    }
    const applyInput = {
      workspaceRoot,
      editorInstanceId: "editor-resolution-chain",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      proposalId: admission.proposal.proposalId,
      changedtick: 8,
      contentSha256: sha256(candidate),
      content: candidate,
    };
    const firstApply = coordinator.applyProposal(applyInput);
    const secondApply = coordinator.applyProposal(applyInput);
    const queuedDiscard = coordinator.discardProposalForEditor({
      workspaceRoot,
      editorInstanceId: "editor-resolution-chain",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      proposalId: admission.proposal.proposalId,
    });

    await expect(firstApply).rejects.toThrow("injected ledger failure");
    await secondAppliedStarted;
    releaseSecondApplied();
    await expect(secondApply).resolves.toMatchObject({ applied: true });
    await expect(queuedDiscard).rejects.toThrow(/already applied/u);
  });

  it("serializes new proposal admission with both apply and discard resolution", async () => {
    for (const action of ["apply", "discard"] as const) {
      const workspaceRoot = await tempDirectory(
        `agenc-proposal-global-${action}-`,
      );
      const agencHome = await tempDirectory(
        `agenc-proposal-global-home-${action}-`,
      );
      const firstPath = join(workspaceRoot, "first.ts");
      const secondPath = join(workspaceRoot, "second.ts");
      const firstBase = "first dirty base\n";
      const firstCandidate = "first reviewed candidate\n";
      const secondBase = "second dirty base\n";
      const secondCandidate = "second reviewed candidate\n";
      let proposedAppends = 0;
      let releaseSecondProposal!: () => void;
      let reportSecondProposalStarted!: () => void;
      let resolutionAppendStarted = false;
      const secondProposalStarted = new Promise<void>((resolve) => {
        reportSecondProposalStarted = resolve;
      });
      const secondProposalGate = new Promise<void>((resolve) => {
        releaseSecondProposal = resolve;
      });
      const coordinator = new WorkspaceMutationCoordinator({
        workspaceRoot,
        agencHome,
        appendLedger: async (entry) => {
          if (entry.status === "proposed") {
            proposedAppends += 1;
            if (proposedAppends === 2) {
              reportSecondProposalStarted();
              await secondProposalGate;
            }
          }
          if (entry.status === "applied" || entry.status === "discarded") {
            resolutionAppendStarted = true;
          }
        },
      });
      const editorInstanceId = `editor-global-${action}`;
      const lease = coordinator.acquire({
        workspaceRoot,
        editorInstanceId,
      });
      coordinator.sync({
        workspaceRoot,
        editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 0,
        buffers: [
          {
            path: firstPath,
            bufferHandle: 101,
            changedtick: 3,
            contentSha256: sha256(firstBase),
            dirty: true,
            content: firstBase,
          },
          {
            path: secondPath,
            bufferHandle: 102,
            changedtick: 4,
            contentSha256: sha256(secondBase),
            dirty: true,
            content: secondBase,
          },
        ],
      });
      const firstAdmission = await coordinator.prepareMutation({
        path: firstPath,
        source: "file_edit",
        beforeText: firstBase,
        afterText: firstCandidate,
      });
      if (firstAdmission.decision !== "proposal") {
        throw new Error("expected the first editor proposal");
      }
      const secondAdmission = coordinator.prepareMutation({
        path: secondPath,
        source: "file_write",
        beforeText: secondBase,
        afterText: secondCandidate,
      });
      await secondProposalStarted;

      const resolution =
        action === "apply"
          ? coordinator.applyProposal({
              workspaceRoot,
              editorInstanceId,
              leaseToken: lease.leaseToken,
              epoch: lease.epoch,
              proposalId: firstAdmission.proposal.proposalId,
              changedtick: 5,
              contentSha256: sha256(firstCandidate),
              content: firstCandidate,
            })
          : coordinator.discardProposalForEditor({
              workspaceRoot,
              editorInstanceId,
              leaseToken: lease.leaseToken,
              epoch: lease.epoch,
              proposalId: firstAdmission.proposal.proposalId,
            });

      // The second admission has already projected its state and is paused
      // in durable I/O. A resolver entering now would later be erased when
      // that stale admission snapshot commits.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(resolutionAppendStarted).toBe(false);

      releaseSecondProposal();
      const admitted = await secondAdmission;
      expect(admitted.decision).toBe("proposal");
      await expect(resolution).resolves.toMatchObject(
        action === "apply" ? { applied: true } : { discarded: true },
      );

      const firstStatuses = coordinator
        .listChanges({
          workspaceRoot,
          editorInstanceId,
          leaseToken: lease.leaseToken,
          epoch: lease.epoch,
        })
        .changes.filter(
          (change) => change.proposalId === firstAdmission.proposal.proposalId,
        )
        .map((change) => change.status);
      expect(firstStatuses).toContain(
        action === "apply" ? "applied" : "discarded",
      );
    }
  });

  it("admits concurrent proposals atomically without evicting the first commitment", async () => {
    const workspaceRoot = await tempDirectory(
      "agenc-proposal-capacity-concurrent-",
    );
    const agencHome = await tempDirectory(
      "agenc-proposal-capacity-concurrent-home-",
    );
    const firstPath = join(workspaceRoot, "first.ts");
    const secondPath = join(workspaceRoot, "second.ts");
    const firstBase = "first base\n";
    const secondBase = "second base\n";
    let releaseFirstAppend!: () => void;
    let reportFirstAppendStarted!: () => void;
    const firstAppendStarted = new Promise<void>((resolve) => {
      reportFirstAppendStarted = resolve;
    });
    const firstAppendGate = new Promise<void>((resolve) => {
      releaseFirstAppend = resolve;
    });
    let proposedAppends = 0;
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
      maxPendingProposals: 1,
      appendLedger: async (entry) => {
        if (entry.status !== "proposed") return;
        proposedAppends += 1;
        if (proposedAppends === 1) {
          reportFirstAppendStarted();
          await firstAppendGate;
        }
      },
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-proposal-capacity",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-proposal-capacity",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path: firstPath,
          bufferHandle: 111,
          changedtick: 1,
          contentSha256: sha256(firstBase),
          dirty: true,
          content: firstBase,
        },
        {
          path: secondPath,
          bufferHandle: 112,
          changedtick: 1,
          contentSha256: sha256(secondBase),
          dirty: true,
          content: secondBase,
        },
      ],
    });

    const first = coordinator.prepareMutation({
      path: firstPath,
      source: "file_edit",
      beforeText: firstBase,
      afterText: "first candidate\n",
    });
    await firstAppendStarted;
    const second = coordinator.prepareMutation({
      path: secondPath,
      source: "file_write",
      beforeText: secondBase,
      afterText: "second candidate\n",
    });
    releaseFirstAppend();

    const [firstAdmission, secondAdmission] = await Promise.all([
      first,
      second,
    ]);
    expect(firstAdmission.decision).toBe("proposal");
    expect(secondAdmission).toMatchObject({
      decision: "blocked",
      code: "EDITOR_PROPOSAL_LIMIT",
    });
    if (firstAdmission.decision !== "proposal") {
      throw new Error("expected the first editor proposal");
    }
    expect(coordinator.getProposal(firstAdmission.proposal.proposalId)).toEqual(
      firstAdmission.proposal,
    );
    expect(proposedAppends).toBe(1);
  });

  it("keeps every admitted unresolved proposal discoverable and discardable after restart", async () => {
    const workspaceRoot = await tempDirectory(
      "agenc-proposal-discovery-capacity-",
    );
    const agencHome = await tempDirectory(
      "agenc-proposal-discovery-capacity-home-",
    );
    const buffers = Array.from({ length: 33 }, (_, index) => {
      const content = `dirty base ${index}\n`;
      return {
        path: join(workspaceRoot, `file-${index}.ts`),
        bufferHandle: 200 + index,
        changedtick: 1,
        contentSha256: sha256(content),
        dirty: true as const,
        content,
      };
    });
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
      appendLedger: async () => {},
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-proposal-discovery",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-proposal-discovery",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers,
    });

    const admittedProposalIds: string[] = [];
    let rejected:
      Awaited<ReturnType<typeof coordinator.prepareMutation>> | undefined;
    for (const [index, buffer] of buffers.entries()) {
      const admission = await coordinator.prepareMutation({
        path: buffer.path,
        source: "file_edit",
        beforeText: buffer.content,
        afterText: `candidate ${index}\n`,
      });
      if (admission.decision === "proposal") {
        admittedProposalIds.push(admission.proposal.proposalId);
      } else {
        rejected = admission;
      }
    }
    expect(admittedProposalIds).toHaveLength(32);
    expect(rejected).toMatchObject({
      decision: "blocked",
      code: "EDITOR_PROPOSAL_LIMIT",
    });
    const delivered = coordinator.listChanges({
      workspaceRoot,
      editorInstanceId: "editor-proposal-discovery",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
    });
    expect(
      delivered.changes.filter((change) => change.status === "proposed"),
    ).toHaveLength(32);
    expect(
      coordinator.listChanges({
        workspaceRoot,
        editorInstanceId: "editor-proposal-discovery",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        afterSequence: delivered.sequence,
      }).changes,
    ).toEqual([]);
    await coordinator.flushQuarantinePersistence();

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
      appendLedger: async () => {},
    });
    const restartedLease = restarted.acquire({
      workspaceRoot,
      editorInstanceId: "editor-proposal-discovery",
    });
    const recoveredProposalIds = restarted
      .listChanges({
        workspaceRoot,
        editorInstanceId: "editor-proposal-discovery",
        leaseToken: restartedLease.leaseToken,
        epoch: restartedLease.epoch,
      })
      .changes.filter((change) => change.status === "proposed")
      .map((change) => change.proposalId)
      .filter((proposalId): proposalId is string => proposalId !== undefined);
    expect(new Set(recoveredProposalIds)).toEqual(new Set(admittedProposalIds));

    for (const proposalId of recoveredProposalIds) {
      await expect(
        restarted.discardProposalForEditor({
          workspaceRoot,
          editorInstanceId: "editor-proposal-discovery",
          leaseToken: restartedLease.leaseToken,
          epoch: restartedLease.epoch,
          proposalId,
        }),
      ).resolves.toMatchObject({ discarded: true, proposalId });
    }
    restarted.sync({
      workspaceRoot,
      editorInstanceId: "editor-proposal-discovery",
      leaseToken: restartedLease.leaseToken,
      epoch: restartedLease.epoch,
      sequence: 0,
      buffers,
    });
    await expect(
      restarted.prepareMutation({
        path: buffers[32]!.path,
        source: "file_edit",
        beforeText: buffers[32]!.content,
        afterText: "candidate after recovery\n",
      }),
    ).resolves.toMatchObject({ decision: "proposal" });
  });

  it("does not overwrite a newer editor revision while a proposal acknowledgement is fsyncing", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "proposal-race.ts");
    const base = "dirty base\n";
    const candidate = "reviewed candidate\n";
    const newer = "typed while audit was pending\n";
    let releaseAppliedAppend!: () => void;
    let reportAppliedAppend!: () => void;
    const appliedAppendStarted = new Promise<void>((resolve) => {
      reportAppliedAppend = resolve;
    });
    const appliedAppendGate = new Promise<void>((resolve) => {
      releaseAppliedAppend = resolve;
    });
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
      appendLedger: async (entry) => {
        if (entry.status === "applied" && entry.proposalId !== undefined) {
          reportAppliedAppend();
          await appliedAppendGate;
        }
      },
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-proposal-race",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-proposal-race",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 81,
          changedtick: 9,
          contentSha256: sha256(base),
          dirty: true,
          content: base,
        },
      ],
    });
    const admission = await coordinator.prepareMutation({
      path,
      source: "file_edit",
      beforeText: base,
      afterText: candidate,
    });
    if (admission.decision !== "proposal") {
      throw new Error("expected an editor proposal");
    }
    const applying = coordinator.applyProposal({
      workspaceRoot,
      editorInstanceId: "editor-proposal-race",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      proposalId: admission.proposal.proposalId,
      changedtick: 10,
      contentSha256: sha256(candidate),
      content: candidate,
    });
    await appliedAppendStarted;
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-proposal-race",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 1,
      buffers: [
        {
          path,
          bufferHandle: 81,
          changedtick: 11,
          contentSha256: sha256(newer),
          dirty: true,
          content: newer,
        },
      ],
    });
    releaseAppliedAppend();

    await expect(applying).resolves.toMatchObject({
      applied: true,
      changedtick: 10,
    });
    expect(coordinator.authoritativeRead(path)).toMatchObject({
      content: newer,
      changedtick: 11,
      contentSha256: sha256(newer),
    });
  });

  it("does not resurrect editor authority after release during proposal fsync", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "proposal-release-race.ts");
    const base = "dirty base\n";
    const candidate = "reviewed candidate\n";
    let releaseAppliedAppend!: () => void;
    let reportAppliedAppend!: () => void;
    const appliedAppendStarted = new Promise<void>((resolve) => {
      reportAppliedAppend = resolve;
    });
    const appliedAppendGate = new Promise<void>((resolve) => {
      releaseAppliedAppend = resolve;
    });
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
      appendLedger: async (entry) => {
        if (entry.status === "applied" && entry.proposalId !== undefined) {
          reportAppliedAppend();
          await appliedAppendGate;
        }
      },
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-release-race",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-release-race",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 91,
          changedtick: 4,
          contentSha256: sha256(base),
          dirty: true,
          content: base,
        },
      ],
    });
    const admission = await coordinator.prepareMutation({
      path,
      source: "file_write",
      beforeText: base,
      afterText: candidate,
    });
    if (admission.decision !== "proposal") {
      throw new Error("expected an editor proposal");
    }
    const applying = coordinator.applyProposal({
      workspaceRoot,
      editorInstanceId: "editor-release-race",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      proposalId: admission.proposal.proposalId,
      changedtick: 5,
      contentSha256: sha256(candidate),
      content: candidate,
    });
    await appliedAppendStarted;
    coordinator.release({
      workspaceRoot,
      editorInstanceId: "editor-release-race",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
    });
    releaseAppliedAppend();

    await expect(applying).rejects.toMatchObject({
      code: "EDITOR_LEASE_EXPIRED",
    });
    expect(coordinator.authorityForPath(path)).toBe("stale_dirty");
    expect(() => coordinator.authoritativeRead(path)).toThrow(
      /must reconnect/u,
    );
  });

  it("marks a completed disk write unknown when its durable audit fails and consumes the token", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "audit-failure.ts");
    const before = "before\n";
    const after = "after\n";
    await writeFile(path, before);
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-audit-failure",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-audit-failure",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [],
    });
    await coordinator.flushQuarantinePersistence();
    const admission = await coordinator.prepareMutation({
      path,
      source: "file_write",
      beforeText: before,
      afterText: after,
    });
    if (admission.decision !== "allow") throw new Error("expected admission");
    coordinator.beginMutation(admission.token);
    await writeFile(path, after);
    await mkdir(
      workspaceMutationStatePath(workspaceRoot, agencHome, "ledger-v1.jsonl"),
    );

    await expect(
      coordinator.commitMutation(admission.token, after),
    ).rejects.toMatchObject({
      code: "MUTATION_AUDIT_FAILED",
    });
    expect(await readFile(path, "utf8")).toBe(after);
    expect(
      coordinator.listChanges({
        workspaceRoot,
        editorInstanceId: "editor-audit-failure",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      }).changes,
    ).toContainEqual(
      expect.objectContaining({
        path,
        status: "unknown_outcome",
        beforeSha256: sha256(before),
        afterSha256: sha256(after),
      }),
    );
    await expect(
      coordinator.commitMutation(admission.token, after),
    ).rejects.toMatchObject({
      code: "INVALID_EDITOR_SYNC",
    });
    expect(() =>
      coordinator.sync({
        workspaceRoot,
        editorInstanceId: "editor-audit-failure",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 1,
        buffers: [
          {
            path,
            bufferHandle: 61,
            changedtick: 2,
            contentSha256: sha256(after),
            dirty: false,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("canonicalizes symlink aliases and rejects paths escaping the workspace", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const outsideRoot = await tempDirectory("agenc-coherence-outside-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    await symlink(outsideRoot, join(workspaceRoot, "outside-link"));
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-a",
    });
    const content = "outside\n";

    expect(() =>
      coordinator.sync({
        workspaceRoot,
        editorInstanceId: "editor-a",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 0,
        buffers: [
          {
            path: join(workspaceRoot, "outside-link", "secret.ts"),
            bufferHandle: 1,
            changedtick: 1,
            contentSha256: sha256(content),
            dirty: true,
            content,
          },
        ],
      }),
    ).toThrow(/outside workspace/u);
  });

  it("rejects a FileWrite when its admitted parent is replaced by an escaping symlink", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const outsideRoot = await tempDirectory("agenc-coherence-outside-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    process.env.AGENC_HOME = agencHome;
    const admittedParent = join(workspaceRoot, "admitted-parent");
    const displacedParent = join(workspaceRoot, "displaced-parent");
    const target = join(admittedParent, "escape.txt");
    const escapedTarget = join(outsideRoot, "escape.txt");
    await mkdir(admittedParent);
    await writeFile(escapedTarget, "OUTSIDE\n");

    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-path-identity",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-path-identity",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [],
    });

    const result = await createFileWriteTool({
      allowedPaths: [workspaceRoot],
      __testWrite: async ({ write }) => {
        await rename(admittedParent, displacedParent);
        await symlink(outsideRoot, admittedParent);
        await write();
      },
    }).execute({
      file_path: target,
      content: "ESCAPED\n",
      [SESSION_ID_ARG]: "path-identity-session",
    });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/path|identity|changed|failed/iu);
    await expect(readFile(escapedTarget, "utf8")).resolves.toBe("OUTSIDE\n");
    await expect(
      stat(join(displacedParent, "escape.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      coordinator.listChanges({
        workspaceRoot,
        editorInstanceId: "editor-path-identity",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      }).changes,
    ).toEqual([]);

    const retry = await coordinator.prepareMutation({
      path: join(displacedParent, "escape.txt"),
      source: "file_write",
      beforeText: "",
      afterText: "retry\n",
    });
    expect(retry).toMatchObject({ decision: "allow" });
    if (retry.decision === "allow") coordinator.cancelMutation(retry.token);
  });

  it("never restores FileWrite backup bytes through a parent exchanged after a generic write failure", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const outsideRoot = await tempDirectory("agenc-coherence-outside-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    process.env.AGENC_HOME = agencHome;
    const admittedParent = join(workspaceRoot, "rollback-parent");
    const displacedParent = join(workspaceRoot, "rollback-parent-displaced");
    const target = join(admittedParent, "value.txt");
    const displacedTarget = join(displacedParent, "value.txt");
    const escapedTarget = join(outsideRoot, "value.txt");
    const before = "ORIGINAL\n";
    const after = "AGENC\n";
    const outside = "OUTSIDE CONCURRENT\n";
    const sessionId = "rollback-path-identity-session";
    await mkdir(admittedParent);
    await writeFile(target, before);
    await writeFile(escapedTarget, outside);

    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-rollback-path-identity",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-rollback-path-identity",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [],
    });
    const read = await createFileReadTool({
      allowedPaths: [workspaceRoot],
    }).execute({
      file_path: target,
      [SESSION_ID_ARG]: sessionId,
    });
    expect(read.isError).not.toBe(true);

    const result = await createFileWriteTool({
      allowedPaths: [workspaceRoot],
      __testWrite: async ({ write }) => {
        await write();
        await rename(admittedParent, displacedParent);
        await symlink(outsideRoot, admittedParent);
        throw Object.assign(new Error("injected generic write failure"), {
          code: "EIO",
        });
      },
    }).execute({
      file_path: target,
      content: after,
      [SESSION_ID_ARG]: sessionId,
    });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/outcome is unknown/iu);
    await expect(readFile(escapedTarget, "utf8")).resolves.toBe(outside);
    await expect(readFile(displacedTarget, "utf8")).resolves.toBe(after);
    expect(
      coordinator.listChanges({
        workspaceRoot,
        editorInstanceId: "editor-rollback-path-identity",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      }).changes,
    ).toContainEqual(
      expect.objectContaining({
        path: target,
        status: "unknown_outcome",
      }),
    );

    const retry = await coordinator.prepareMutation({
      path: displacedTarget,
      source: "file_write",
      beforeText: after,
      afterText: "retry\n",
    });
    expect(retry).toMatchObject({ decision: "allow" });
    if (retry.decision === "allow") coordinator.cancelMutation(retry.token);
  });

  it("does not overwrite a missing target published by another writer after admission", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    process.env.AGENC_HOME = agencHome;
    const parent = join(workspaceRoot, "published-after-admission");
    const target = join(parent, "value.ts");
    const concurrentContent = "export const owner = 'concurrent';\n";
    await mkdir(parent);

    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-target-publication",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-target-publication",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [],
    });

    const result = await createFileWriteTool({
      allowedPaths: [workspaceRoot],
      __testWrite: async ({ write }) => {
        await writeFile(target, concurrentContent);
        await write();
      },
    }).execute({
      file_path: target,
      content: "export const owner = 'agenc';\n",
      [SESSION_ID_ARG]: "target-publication-session",
    });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/path identity changed/iu);
    await expect(readFile(target, "utf8")).resolves.toBe(concurrentContent);
    expect(
      coordinator.listChanges({
        workspaceRoot,
        editorInstanceId: "editor-target-publication",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      }).changes,
    ).toEqual([]);

    const retry = await coordinator.prepareMutation({
      path: target,
      source: "file_write",
      beforeText: concurrentContent,
      afterText: "export const owner = 'retry';\n",
    });
    expect(retry).toMatchObject({ decision: "allow" });
    if (retry.decision === "allow") coordinator.cancelMutation(retry.token);
  });

  it("uses exclusive creation when a missing target is published after the final pre-write check", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    process.env.AGENC_HOME = agencHome;
    const target = join(workspaceRoot, "exclusive-create.ts");
    const concurrentContent = "export const owner = 'concurrent';\n";

    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-exclusive-create",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-exclusive-create",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [],
    });

    const result = await createFileWriteTool({
      allowedPaths: [workspaceRoot],
      __testAfterPreWriteCheck: async ({ path, targetExisted }) => {
        expect(targetExisted).toBe(false);
        await writeFile(path, concurrentContent);
      },
    }).execute({
      file_path: target,
      content: "export const owner = 'agenc';\n",
      [SESSION_ID_ARG]: "exclusive-create-session",
    });

    expect(result.isError).toBe(true);
    await expect(readFile(target, "utf8")).resolves.toBe(concurrentContent);
    expect(
      coordinator.listChanges({
        workspaceRoot,
        editorInstanceId: "editor-exclusive-create",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      }).changes,
    ).toEqual([]);

    const retry = await coordinator.prepareMutation({
      path: target,
      source: "file_write",
      beforeText: concurrentContent,
      afterText: "export const owner = 'retry';\n",
    });
    expect(retry).toMatchObject({ decision: "allow" });
    if (retry.decision === "allow") coordinator.cancelMutation(retry.token);
  });

  it("does not overwrite an existing target whose bytes change after admission", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    process.env.AGENC_HOME = agencHome;
    const target = join(workspaceRoot, "existing-content-race.ts");
    const originalContent = "export const owner = 'original';\n";
    const concurrentContent = "export const owner = 'concurrent';\n";
    const sessionId = "existing-content-race-session";
    await writeFile(target, originalContent);

    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-existing-content-race",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-existing-content-race",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [],
    });
    const readResult = await createFileReadTool({
      allowedPaths: [workspaceRoot],
    }).execute({
      file_path: target,
      [SESSION_ID_ARG]: sessionId,
    });
    expect(readResult.isError).not.toBe(true);

    const result = await createFileWriteTool({
      allowedPaths: [workspaceRoot],
      __testWrite: async ({ write }) => {
        await writeFile(target, concurrentContent);
        await write();
      },
    }).execute({
      file_path: target,
      content: "export const owner = 'agenc';\n",
      [SESSION_ID_ARG]: sessionId,
    });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/path identity|content.*changed/iu);
    await expect(readFile(target, "utf8")).resolves.toBe(concurrentContent);
    expect(
      coordinator.listChanges({
        workspaceRoot,
        editorInstanceId: "editor-existing-content-race",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      }).changes,
    ).toEqual([]);

    const retry = await coordinator.prepareMutation({
      path: target,
      source: "file_write",
      beforeText: concurrentContent,
      afterText: "export const owner = 'retry';\n",
    });
    expect(retry).toMatchObject({ decision: "allow" });
    if (retry.decision === "allow") coordinator.cancelMutation(retry.token);
  });
});

describe("filesystem-tool editor coherence", () => {
  it("blocks a file mutation after daemon restart before editor reconnect", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    process.env.AGENC_HOME = agencHome;
    const path = join(workspaceRoot, "restart-before-editor.ts");
    const diskContent = "disk state\n";
    const editorContent = "unsaved editor state\n";
    await writeFile(path, diskContent);

    const beforeRestart =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const lease = beforeRestart.acquire({
      workspaceRoot,
      editorInstanceId: "editor-before-restart",
    });
    beforeRestart.sync({
      workspaceRoot,
      editorInstanceId: lease.editorInstanceId,
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 5,
          changedtick: 22,
          contentSha256: sha256(editorContent),
          dirty: true,
          content: editorContent,
        },
      ],
    });

    const ledgerKey = createHash("sha256")
      .update(workspaceRoot)
      .digest("hex")
      .slice(0, 32);
    const quarantinePath = join(
      agencHome,
      "workspace-mutations",
      ledgerKey,
      "quarantine-v1.json",
    );
    await expect
      .poll(async () => {
        try {
          const parsed = JSON.parse(await readFile(quarantinePath, "utf8")) as {
            entries?: unknown[];
          };
          return parsed.entries?.length ?? 0;
        } catch {
          return 0;
        }
      })
      .toBe(1);

    // Simulate a fresh daemon process: no coordinator or editor lease has
    // been recreated in memory when the first model-requested write arrives.
    workspaceMutationCoordinators.clearForTests();
    const writeTool = createFileWriteTool({ allowedPaths: [workspaceRoot] });
    await expect(
      writeTool.execute({
        file_path: "restart-before-editor.ts",
        content: "replacement\n",
        [SESSION_ID_ARG]: "restart-session",
      }),
    ).rejects.toThrow("may contain unsaved changes");
    expect(await readFile(path, "utf8")).toBe(diskContent);
  });

  it("reads dirty editor bytes and makes Edit/Write/apply_patch non-mutating", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    process.env.AGENC_HOME = agencHome;
    const path = join(workspaceRoot, "main.ts");
    const diskContent = "export const answer = 40;\n";
    const editorContent = "export const answer = 41;\n";
    await writeFile(path, diskContent);

    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-a",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-a",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 8,
          changedtick: 12,
          contentSha256: sha256(editorContent),
          dirty: true,
          content: editorContent,
        },
      ],
    });

    const sessionId = "coherence-session";
    const injected = { [SESSION_ID_ARG]: sessionId };
    const readTool = createFileReadTool({ allowedPaths: [workspaceRoot] });
    const read = await readTool.execute({
      file_path: "main.ts",
      ...injected,
    });
    expect(read.isError).not.toBe(true);
    expect(read.content).toContain("export const answer = 41;");

    const editTool = createFileEditTool({ allowedPaths: [workspaceRoot] });
    const edit = await editTool.execute({
      file_path: "main.ts",
      old_string: "answer = 41",
      new_string: "answer = 42",
      ...injected,
    });
    expect(edit.isError).toBe(true);
    expect(edit.metadata).toMatchObject({
      workspaceMutation: { kind: "editor_proposal" },
    });
    expect(await readFile(path, "utf8")).toBe(diskContent);

    const writeTool = createFileWriteTool({ allowedPaths: [workspaceRoot] });
    const write = await writeTool.execute({
      file_path: "main.ts",
      content: "export const answer = 43;\n",
      ...injected,
    });
    expect(write.isError).toBe(true);
    expect(write.metadata).toMatchObject({
      workspaceMutation: { kind: "editor_proposal" },
    });
    expect(await readFile(path, "utf8")).toBe(diskContent);

    const patchTool = createApplyPatchTool({
      cwd: workspaceRoot,
      allowedPaths: [workspaceRoot],
    });
    const patch = await patchTool.execute({
      input: [
        "*** Begin Patch",
        "*** Update File: main.ts",
        "@@",
        "-export const answer = 41;",
        "+export const answer = 44;",
        "*** End Patch",
      ].join("\n"),
      ...injected,
    });
    expect(patch.isError).toBe(true);
    expect(patch.metadata).toMatchObject({
      workspaceMutation: { kind: "editor_proposal" },
    });
    expect(await readFile(path, "utf8")).toBe(diskContent);
  });

  it("reconciles every file after a multi-file patch reaches disk but ledger fsync fails", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    process.env.AGENC_HOME = agencHome;
    const firstPath = join(workspaceRoot, "first.ts");
    const secondPath = join(workspaceRoot, "second.ts");
    const firstBefore = "export const first = 1;\n";
    const secondBefore = "export const second = 1;\n";
    const firstAfter = "export const first = 2;\n";
    const secondAfter = "export const second = 2;\n";
    await writeFile(firstPath, firstBefore);
    await writeFile(secondPath, secondBefore);
    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-apply-patch-audit",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-apply-patch-audit",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [],
    });
    await coordinator.flushQuarantinePersistence();
    const sessionId = "apply-patch-audit-session";
    const readTool = createFileReadTool({ allowedPaths: [workspaceRoot] });
    await readTool.execute({
      file_path: firstPath,
      [SESSION_ID_ARG]: sessionId,
    });
    await readTool.execute({
      file_path: secondPath,
      [SESSION_ID_ARG]: sessionId,
    });
    await mkdir(
      workspaceMutationStatePath(workspaceRoot, agencHome, "ledger-v1.jsonl"),
    );

    const result = await createApplyPatchTool({
      cwd: workspaceRoot,
      allowedPaths: [workspaceRoot],
    }).execute({
      input: [
        "*** Begin Patch",
        "*** Update File: first.ts",
        "@@",
        "-export const first = 1;",
        "+export const first = 2;",
        "*** Update File: second.ts",
        "@@",
        "-export const second = 1;",
        "+export const second = 2;",
        "*** End Patch",
      ].join("\n"),
      [SESSION_ID_ARG]: sessionId,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("changed files on disk");
    expect(result.content).toContain(
      "2 workspace audit outcome(s) are unknown",
    );
    expect(await readFile(firstPath, "utf8")).toBe(firstAfter);
    expect(await readFile(secondPath, "utf8")).toBe(secondAfter);
    const unknownChanges = coordinator
      .listChanges({
        workspaceRoot,
        editorInstanceId: "editor-apply-patch-audit",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      })
      .changes.filter((change) => change.status === "unknown_outcome");
    expect(unknownChanges).toHaveLength(2);
    expect(unknownChanges.map((change) => change.path).sort()).toEqual(
      [firstPath, secondPath].sort(),
    );
    expect(() =>
      coordinator.sync({
        workspaceRoot,
        editorInstanceId: "editor-apply-patch-audit",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 1,
        buffers: [
          {
            path: firstPath,
            bufferHandle: 71,
            changedtick: 2,
            contentSha256: sha256(firstAfter),
            dirty: false,
          },
          {
            path: secondPath,
            bufferHandle: 72,
            changedtick: 2,
            contentSha256: sha256(secondAfter),
            dirty: false,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("returns honest Write and NotebookEdit errors when bytes changed but auditing failed", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    process.env.AGENC_HOME = agencHome;
    const textPath = join(workspaceRoot, "write-audit.ts");
    const notebookPath = join(workspaceRoot, "notebook-audit.ipynb");
    const textBefore = "export const value = 1;\n";
    const textAfter = "export const value = 2;\n";
    const notebookBefore = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          id: "cell-a",
          cell_type: "code",
          metadata: {},
          source: "value = 1",
          execution_count: null,
          outputs: [],
        },
      ],
    });
    await writeFile(textPath, textBefore);
    await writeFile(notebookPath, notebookBefore);
    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-tool-audit",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-tool-audit",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [],
    });
    await coordinator.flushQuarantinePersistence();
    const sessionId = "tool-audit-session";
    const readTool = createFileReadTool({ allowedPaths: [workspaceRoot] });
    await readTool.execute({
      file_path: textPath,
      [SESSION_ID_ARG]: sessionId,
    });
    await readTool.execute({
      file_path: notebookPath,
      [SESSION_ID_ARG]: sessionId,
    });
    await mkdir(
      workspaceMutationStatePath(workspaceRoot, agencHome, "ledger-v1.jsonl"),
    );

    const writeResult = await createFileWriteTool({
      allowedPaths: [workspaceRoot],
    }).execute({
      file_path: textPath,
      content: textAfter,
      [SESSION_ID_ARG]: sessionId,
    });
    expect(writeResult.isError).toBe(true);
    expect(writeResult.content).toContain("Disk mutation completed");
    expect(writeResult.content).not.toContain("failed to write");
    expect(await readFile(textPath, "utf8")).toBe(textAfter);

    const notebookResult = await createNotebookEditTool({
      workspaceRoot,
    }).execute({
      notebook_path: notebookPath,
      cell_id: "cell-a",
      edit_mode: "replace",
      new_source: "value = 2",
      [SESSION_ID_ARG]: sessionId,
    });
    expect(notebookResult.isError).toBe(true);
    expect(notebookResult.content).toContain("Disk mutation completed");
    expect(await readFile(notebookPath, "utf8")).toContain("value = 2");
  });

  it("marks rejected partial Edit, Write, and NotebookEdit syscalls unknown when rollback cannot be verified", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    process.env.AGENC_HOME = agencHome;
    const editPath = join(workspaceRoot, "partial-edit.ts");
    const writePath = join(workspaceRoot, "partial-write.ts");
    const notebookPath = join(workspaceRoot, "partial-notebook.ipynb");
    const editBefore = "export const editValue = 1;\n";
    const writeBefore = "export const writeValue = 1;\n";
    const notebookBefore = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          id: "cell-a",
          cell_type: "code",
          metadata: {},
          source: "value = 1",
          execution_count: null,
          outputs: [],
        },
      ],
    });
    await writeFile(editPath, editBefore);
    await writeFile(writePath, writeBefore);
    await writeFile(notebookPath, notebookBefore);
    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-partial-write",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-partial-write",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [],
    });
    const sessionId = "partial-write-session";
    const readTool = createFileReadTool({ allowedPaths: [workspaceRoot] });
    for (const path of [editPath, writePath, notebookPath]) {
      const read = await readTool.execute({
        file_path: path,
        [SESSION_ID_ARG]: sessionId,
      });
      expect(read.isError).not.toBe(true);
    }
    const partialByPath = new Map([
      [editPath, "partial edit bytes"],
      [writePath, "partial write bytes"],
      [notebookPath, "partial notebook bytes"],
    ]);
    const testHooks = {
      __testWrite: async ({ path }: { readonly path: string }) => {
        await writeFile(path, partialByPath.get(path) ?? "partial");
        throw new Error("injected partial syscall failure");
      },
      __testRestoreBackup: async () => {
        throw new Error("injected rollback failure");
      },
    };

    const editResult = await createFileEditTool({
      allowedPaths: [workspaceRoot],
      ...testHooks,
    }).execute({
      file_path: editPath,
      old_string: "editValue = 1",
      new_string: "editValue = 2",
      [SESSION_ID_ARG]: sessionId,
    });
    expect(editResult.isError).toBe(true);
    expect(editResult.content).toContain("outcome is unknown");

    const writeResult = await createFileWriteTool({
      allowedPaths: [workspaceRoot],
      ...testHooks,
    }).execute({
      file_path: writePath,
      content: "export const writeValue = 2;\n",
      [SESSION_ID_ARG]: sessionId,
    });
    expect(writeResult.isError).toBe(true);
    expect(writeResult.content).toContain("outcome is unknown");

    const notebookResult = await createNotebookEditTool({
      workspaceRoot,
      ...testHooks,
    }).execute({
      notebook_path: notebookPath,
      cell_id: "cell-a",
      edit_mode: "replace",
      new_source: "value = 2",
      [SESSION_ID_ARG]: sessionId,
    });
    expect(notebookResult.isError).toBe(true);
    expect(notebookResult.content).toContain("outcome is unknown");

    const unknownChanges = coordinator
      .listChanges({
        workspaceRoot,
        editorInstanceId: "editor-partial-write",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      })
      .changes.filter((change) => change.status === "unknown_outcome");
    expect(unknownChanges).toHaveLength(3);
    for (const [path, partial] of partialByPath) {
      expect(await readFile(path, "utf8")).toBe(partial);
      expect(unknownChanges).toContainEqual(
        expect.objectContaining({
          path,
          status: "unknown_outcome",
          afterSha256: sha256(partial),
        }),
      );
    }
    expect(() =>
      coordinator.sync({
        workspaceRoot,
        editorInstanceId: "editor-partial-write",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 1,
        buffers: [...partialByPath].map(([path, partial], index) => ({
          path,
          bufferHandle: index + 1,
          changedtick: 1,
          contentSha256: sha256(partial),
          contentBytes: Buffer.byteLength(partial),
          dirty: false,
        })),
      }),
    ).not.toThrow();
  });

  it("cancels a rejected write intent only after exact rollback verification", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    process.env.AGENC_HOME = agencHome;
    const path = join(workspaceRoot, "verified-rollback.ts");
    const before = "export const value = 1;\n";
    await writeFile(path, before);
    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-verified-rollback",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-verified-rollback",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [],
    });
    const sessionId = "verified-rollback-session";
    await createFileReadTool({ allowedPaths: [workspaceRoot] }).execute({
      file_path: path,
      [SESSION_ID_ARG]: sessionId,
    });
    const result = await createFileWriteTool({
      allowedPaths: [workspaceRoot],
      __testWrite: async ({ path: target }) => {
        await writeFile(target, "truncated");
        throw new Error("injected rejected write");
      },
    }).execute({
      file_path: path,
      content: "export const value = 2;\n",
      [SESSION_ID_ARG]: sessionId,
    });

    expect(result.isError).toBe(true);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(
      coordinator.listChanges({
        workspaceRoot,
        editorInstanceId: "editor-verified-rollback",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      }).changes,
    ).toEqual([]);
    const retry = await coordinator.prepareMutation({
      path,
      source: "file_write",
      beforeText: before,
      afterText: "retry\n",
    });
    expect(retry).toMatchObject({ decision: "allow" });
    if (retry.decision === "allow") coordinator.cancelMutation(retry.token);
    await coordinator.flushQuarantinePersistence();
  });

  it("does not create parent directories when Write becomes an editor proposal", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    process.env.AGENC_HOME = agencHome;
    const parent = join(workspaceRoot, "missing", "nested");
    const path = join(parent, "draft.ts");
    const editorContent = "export const draft = 1;\n";
    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-a",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-a",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 9,
          changedtick: 3,
          contentSha256: sha256(editorContent),
          dirty: true,
          content: editorContent,
        },
      ],
    });
    const sessionId = "new-buffer-session";
    const readTool = createFileReadTool({ allowedPaths: [workspaceRoot] });
    const read = await readTool.execute({
      file_path: "missing/nested/draft.ts",
      [SESSION_ID_ARG]: sessionId,
    });
    expect(read.isError).not.toBe(true);

    const write = await createFileWriteTool({
      allowedPaths: [workspaceRoot],
    }).execute({
      file_path: "missing/nested/draft.ts",
      content: "export const draft = 2;\n",
      [SESSION_ID_ARG]: sessionId,
    });

    expect(write).toMatchObject({
      isError: true,
      metadata: {
        workspaceMutation: { kind: "editor_proposal" },
      },
    });
    await expect(stat(parent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("plans NotebookEdit from dirty editor JSON without touching disk", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    process.env.AGENC_HOME = agencHome;
    const path = join(workspaceRoot, "analysis.ipynb");
    const notebookWith = (source: string) =>
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            id: "cell-a",
            cell_type: "code",
            metadata: {},
            source,
            execution_count: null,
            outputs: [],
          },
        ],
      });
    const diskContent = notebookWith("disk = 1");
    const editorContent = notebookWith("editor = 2");
    await writeFile(path, diskContent);
    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-a",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-a",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 11,
          changedtick: 6,
          contentSha256: sha256(editorContent),
          dirty: true,
          content: editorContent,
        },
      ],
    });

    const result = await createNotebookEditTool({
      workspaceRoot,
    }).execute({
      notebook_path: "analysis.ipynb",
      cell_id: "cell-a",
      edit_mode: "replace",
      new_source: "editor = 3",
    });

    expect(result).toMatchObject({
      isError: true,
      metadata: {
        workspaceMutation: {
          kind: "editor_proposal",
          source: "notebook_edit",
        },
      },
    });
    expect(await readFile(path, "utf8")).toBe(diskContent);
    const proposalId = (
      result.metadata?.workspaceMutation as { proposalId?: string }
    )?.proposalId;
    expect(proposalId).toBeTypeOf("string");
    expect(coordinator.getProposal(proposalId!)?.beforeText).toBe(
      editorContent,
    );
    expect(coordinator.getProposal(proposalId!)?.afterText).toContain(
      "editor = 3",
    );
  });

  it("fails closed when delete or move would contain a dirty editor path", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    process.env.AGENC_HOME = agencHome;
    const sourceDirectory = join(workspaceRoot, "source");
    const dirtyPath = join(sourceDirectory, "nested", "dirty.ts");
    await mkdir(join(sourceDirectory, "nested"), { recursive: true });
    await writeFile(dirtyPath, "disk\n");
    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-a",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-a",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path: dirtyPath,
          bufferHandle: 12,
          changedtick: 9,
          contentSha256: sha256("unsaved\n"),
          dirty: true,
          content: "unsaved\n",
        },
      ],
    });
    const tools = createFilesystemTools({
      allowedPaths: [workspaceRoot],
      allowDelete: true,
    });
    const deleteTool = tools.find((tool) => tool.name === "system.delete")!;
    const moveTool = tools.find((tool) => tool.name === "system.move")!;

    const deletion = await deleteTool.execute({
      path: sourceDirectory,
      recursive: true,
    });
    expect(deletion.isError).toBe(true);
    expect(deletion.content).toContain("unsaved editor changes");
    expect(await readFile(dirtyPath, "utf8")).toBe("disk\n");

    const destination = join(workspaceRoot, "destination");
    const move = await moveTool.execute({
      source: sourceDirectory,
      destination,
    });
    expect(move.isError).toBe(true);
    expect(move.content).toContain("unsaved editor changes");
    expect(await readFile(dirtyPath, "utf8")).toBe("disk\n");
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks move and delete for clean loaded buffers but permits them after unload", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    process.env.AGENC_HOME = agencHome;
    const sourceDirectory = join(workspaceRoot, "source");
    const cleanPath = join(sourceDirectory, "nested", "clean.ts");
    const diskContent = "export const clean = true;\n";
    await mkdir(join(sourceDirectory, "nested"), { recursive: true });
    await writeFile(cleanPath, diskContent);
    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-a",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-a",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path: cleanPath,
          bufferHandle: 15,
          changedtick: 3,
          contentSha256: sha256(diskContent),
          dirty: false,
        },
      ],
    });
    const tools = createFilesystemTools({
      allowedPaths: [workspaceRoot],
      allowDelete: true,
    });
    const deleteTool = tools.find((tool) => tool.name === "system.delete")!;
    const moveTool = tools.find((tool) => tool.name === "system.move")!;

    const deletion = await deleteTool.execute({
      path: sourceDirectory,
      recursive: true,
    });
    expect(deletion.isError).toBe(true);
    expect(deletion.content).toContain("is loaded in Editor");
    expect(deletion.content).toContain("Editor project tree");

    const destination = join(workspaceRoot, "destination");
    const move = await moveTool.execute({
      source: sourceDirectory,
      destination,
    });
    expect(move.isError).toBe(true);
    expect(move.content).toContain("is loaded in Editor");
    expect(move.content).toContain("Editor project tree");
    expect(await readFile(cleanPath, "utf8")).toBe(diskContent);

    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-a",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 1,
      buffers: [],
    });
    const unloadedMove = await moveTool.execute({
      source: sourceDirectory,
      destination,
    });
    expect(unloadedMove.isError).not.toBe(true);
    expect(
      await readFile(join(destination, "nested", "clean.ts"), "utf8"),
    ).toBe(diskContent);
    const unloadedDelete = await deleteTool.execute({
      path: destination,
      recursive: true,
    });
    expect(unloadedDelete.isError).not.toBe(true);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("routes clean loaded-buffer writes through proposals to close dirty-publication races", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "loaded-clean.ts");
    const before = "export const value = 1;\n";
    const after = "export const value = 2;\n";
    await writeFile(path, before);
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-loaded-clean",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-loaded-clean",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 90,
          changedtick: 3,
          contentSha256: sha256(before),
          dirty: false,
        },
      ],
    });

    const admission = await coordinator.prepareMutation({
      path,
      source: "file_write",
      beforeText: before,
      afterText: after,
    });

    expect(admission).toMatchObject({
      decision: "proposal",
      proposal: {
        path,
        baseContentSha256: sha256(before),
        baseChangedtick: 3,
      },
    });
    if (admission.decision !== "proposal") {
      throw new Error("expected proposal");
    }
    expect(
      coordinator.inspectProposal({
        workspaceRoot,
        editorInstanceId: "editor-loaded-clean",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        proposalId: admission.proposal.proposalId,
      }),
    ).toEqual(admission.proposal);
    await expect(
      coordinator.applyProposal({
        workspaceRoot,
        editorInstanceId: "editor-loaded-clean",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        proposalId: admission.proposal.proposalId,
        changedtick: 4,
        contentSha256: sha256(after),
        content: after,
      }),
    ).resolves.toMatchObject({
      applied: true,
      path,
      changedtick: 4,
      contentSha256: sha256(after),
    });
    expect(coordinator.authoritativeRead(path)).toMatchObject({
      content: after,
      changedtick: 4,
    });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("persists applied change delivery across restart until the Editor acknowledges it", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "durable-change.ts");
    const before = "before\n";
    const after = "after\n";
    await writeFile(path, before);
    const first = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const firstLease = first.acquire({
      workspaceRoot,
      editorInstanceId: "editor-before-change-restart",
    });
    first.sync({
      workspaceRoot,
      editorInstanceId: "editor-before-change-restart",
      leaseToken: firstLease.leaseToken,
      epoch: firstLease.epoch,
      sequence: 0,
      buffers: [],
    });
    const admission = await first.prepareMutation({
      path,
      source: "file_write",
      beforeText: before,
      afterText: after,
    });
    if (admission.decision !== "allow") throw new Error("expected admission");
    first.beginMutation(admission.token);
    await writeFile(path, after);
    await first.commitMutation(admission.token, after);

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const restartedLease = restarted.acquire({
      workspaceRoot,
      editorInstanceId: "editor-after-change-restart",
    });
    const delivery = restarted.listChanges({
      workspaceRoot,
      editorInstanceId: "editor-after-change-restart",
      leaseToken: restartedLease.leaseToken,
      epoch: restartedLease.epoch,
      afterSequence: 0,
    });
    expect(delivery.changes).toContainEqual(
      expect.objectContaining({
        path,
        status: "applied",
        beforeSha256: sha256(before),
        afterSha256: sha256(after),
      }),
    );

    restarted.listChanges({
      workspaceRoot,
      editorInstanceId: "editor-after-change-restart",
      leaseToken: restartedLease.leaseToken,
      epoch: restartedLease.epoch,
      afterSequence: delivery.sequence,
    });
    await restarted.flushQuarantinePersistence();
    const afterAckRestart = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const afterAckLease = afterAckRestart.acquire({
      workspaceRoot,
      editorInstanceId: "editor-after-change-ack",
    });
    expect(
      afterAckRestart.listChanges({
        workspaceRoot,
        editorInstanceId: "editor-after-change-ack",
        leaseToken: afterAckLease.leaseToken,
        epoch: afterAckLease.epoch,
        afterSequence: 0,
      }).changes,
    ).toEqual([]);
  });

  it("persists unknown outcomes across restart even when the ledger append fails", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "durable-unknown.ts");
    const before = "before\n";
    const after = "uncertain bytes\n";
    await writeFile(path, before);
    const first = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
      appendLedger: async () => {
        throw new Error("injected ledger failure");
      },
    });
    const firstLease = first.acquire({
      workspaceRoot,
      editorInstanceId: "editor-before-unknown-restart",
    });
    first.sync({
      workspaceRoot,
      editorInstanceId: "editor-before-unknown-restart",
      leaseToken: firstLease.leaseToken,
      epoch: firstLease.epoch,
      sequence: 0,
      buffers: [],
    });
    const admission = await first.prepareMutation({
      path,
      source: "file_write",
      beforeText: before,
      afterText: after,
    });
    if (admission.decision !== "allow") throw new Error("expected admission");
    first.beginMutation(admission.token);
    await writeFile(path, after);
    await expect(
      first.commitMutation(admission.token, after),
    ).rejects.toMatchObject({
      code: "MUTATION_AUDIT_FAILED",
    });

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const restartedLease = restarted.acquire({
      workspaceRoot,
      editorInstanceId: "editor-after-unknown-restart",
    });
    expect(
      restarted.listChanges({
        workspaceRoot,
        editorInstanceId: "editor-after-unknown-restart",
        leaseToken: restartedLease.leaseToken,
        epoch: restartedLease.epoch,
        afterSequence: 0,
      }).changes,
    ).toContainEqual(
      expect.objectContaining({
        path,
        status: "unknown_outcome",
        afterSha256: sha256(after),
      }),
    );
  });

  it("enforces proposal per-buffer and aggregate dirty-content limits", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-proposal-limits",
    });
    const fourMiB = "x".repeat(4 * 1024 * 1024);
    const target = join(workspaceRoot, "target.ts");
    const targetBefore = "target\n";
    await writeFile(target, targetBefore);
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-proposal-limits",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        ...[0, 1, 2].map((index) => ({
          path: join(workspaceRoot, `dirty-${index}.ts`),
          bufferHandle: index + 1,
          changedtick: 1,
          contentSha256: sha256(fourMiB),
          dirty: true as const,
          content: fourMiB,
        })),
        {
          path: target,
          bufferHandle: 4,
          changedtick: 1,
          contentSha256: sha256(targetBefore),
          dirty: false,
        },
      ],
    });

    await expect(
      coordinator.prepareMutation({
        path: target,
        source: "file_write",
        beforeText: targetBefore,
        afterText: "y".repeat(5 * 1024 * 1024 + 1),
      }),
    ).rejects.toThrow(/exceeds 5242880 bytes/u);
    await expect(
      coordinator.prepareMutation({
        path: target,
        source: "file_write",
        beforeText: targetBefore,
        afterText: "y".repeat(5 * 1024 * 1024),
      }),
    ).rejects.toThrow(/exceed 16777216 live dirty bytes/u);
  });

  it("rejects escape-heavy proposals before they can exceed the daemon peer frame", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "escape-heavy.ts");
    const before = "\0".repeat(1_500_000);
    const after = "\u0001".repeat(1_500_000);
    await writeFile(path, before);

    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-proposal-frame-limit",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-proposal-frame-limit",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 1,
          changedtick: 1,
          contentSha256: sha256(before),
          contentBytes: Buffer.byteLength(before, "utf8"),
          dirty: false,
        },
      ],
    });

    let rejection: unknown;
    try {
      await coordinator.prepareMutation({
        path,
        source: "file_edit",
        beforeText: before,
        afterText: after,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toMatchObject({
      code: "INVALID_EDITOR_SYNC",
      message: expect.stringMatching(/daemon peer frame limit/u),
    });
    expect(
      coordinator.listChanges({
        workspaceRoot,
        editorInstanceId: "editor-proposal-frame-limit",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      }).changes,
    ).toEqual([]);
    await coordinator.flushQuarantinePersistence();
    const quarantine = JSON.parse(
      await readFile(
        workspaceMutationStatePath(
          workspaceRoot,
          agencHome,
          "quarantine-v1.json",
        ),
        "utf8",
      ),
    ) as { readonly proposalCommitments?: readonly unknown[] };
    expect(quarantine.proposalCommitments).toEqual([]);
  });

  it("holds a topology reservation against newly loaded descendant buffers", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const directory = join(workspaceRoot, "moving");
    const path = join(directory, "late-load.ts");
    const content = "late load\n";
    await mkdir(directory);
    await writeFile(path, content);
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-topology-fence",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "editor-topology-fence",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [],
    });
    const reservation = await coordinator.reserveTopologyMutation([
      { path: directory, includeDescendants: true },
    ]);

    expect(() =>
      coordinator.sync({
        workspaceRoot,
        editorInstanceId: "editor-topology-fence",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 1,
        buffers: [
          {
            path,
            bufferHandle: 1,
            changedtick: 1,
            contentSha256: sha256(content),
            dirty: false,
          },
        ],
      }),
    ).toThrow(/path operation is committing/u);
    await coordinator.flushQuarantinePersistence();
    await writeFile(path, "moved replacement\n");
    await coordinator.completeTopologyMutation(reservation, "applied");
    expect(() =>
      coordinator.sync({
        workspaceRoot,
        editorInstanceId: "editor-topology-fence",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 1,
        buffers: [
          {
            path,
            bufferHandle: 1,
            changedtick: 1,
            contentSha256: sha256(content),
            dirty: false,
          },
        ],
      }),
    ).not.toThrow();
    expect(
      coordinator.listChanges({
        workspaceRoot,
        editorInstanceId: "editor-topology-fence",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      }).changes,
    ).toContainEqual(
      expect.objectContaining({
        path,
        status: "applied",
        beforeSha256: sha256(content),
        afterSha256: sha256("moved replacement\n"),
      }),
    );
    await coordinator.flushQuarantinePersistence();
  });

  it("lets the owning editor fence clean loaded paths and publishes its renamed manifest before consuming the fence", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const source = join(workspaceRoot, "src", "loaded.ts");
    const destination = join(workspaceRoot, "lib", "loaded.ts");
    const content = "export const loaded = true;\n";
    await mkdir(join(workspaceRoot, "src"));
    await mkdir(join(workspaceRoot, "lib"));
    await writeFile(source, content);
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-project-rename",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: lease.editorInstanceId,
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path: source,
          bufferHandle: 7,
          changedtick: 3,
          contentSha256: sha256(content),
          contentBytes: Buffer.byteLength(content),
          dirty: false,
        },
      ],
    });

    const token = await coordinator.reserveEditorTopologyMutation({
      workspaceRoot,
      editorInstanceId: lease.editorInstanceId,
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      targets: [
        {
          path: join(workspaceRoot, "src"),
          includeDescendants: true,
          allowOwnedClean: true,
        },
        {
          path: join(workspaceRoot, "lib"),
          includeDescendants: true,
        },
      ],
    });
    await expect(
      coordinator.prepareMutation({
        path: destination,
        source: "file_write",
        beforeText: "",
        afterText: "racing write\n",
      }),
    ).rejects.toThrow(/path operation is committing/u);

    await rename(source, destination);
    const completed = await coordinator.completeEditorTopologyMutation({
      workspaceRoot,
      editorInstanceId: lease.editorInstanceId,
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      tokenId: token.tokenId,
      sequence: 1,
      buffers: [
        {
          path: destination,
          bufferHandle: 7,
          changedtick: 4,
          contentSha256: sha256(content),
          contentBytes: Buffer.byteLength(content),
          dirty: false,
        },
      ],
      status: "applied",
    });

    expect(completed.sync.sequence).toBe(1);
    expect(coordinator.authorityForPath(destination)).toBe(
      "disk_authoritative",
    );
    expect(
      coordinator.listChanges({
        workspaceRoot,
        editorInstanceId: lease.editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      }).changes,
    ).toContainEqual(
      expect.objectContaining({
        path: source,
        source: "editor",
        status: "applied",
        beforeSha256: sha256(content),
      }),
    );
  });

  it("lets a reconnected editor explicitly reconcile a recovered topology token under its new lease", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const directory = join(workspaceRoot, "recovered-editor-topology");
    await mkdir(directory);
    const first = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const firstLease = first.acquire({
      workspaceRoot,
      editorInstanceId: "editor-before-topology-restart",
    });
    first.sync({
      workspaceRoot,
      editorInstanceId: firstLease.editorInstanceId,
      leaseToken: firstLease.leaseToken,
      epoch: firstLease.epoch,
      sequence: 0,
      buffers: [],
    });
    const token = await first.reserveEditorTopologyMutation({
      workspaceRoot,
      editorInstanceId: firstLease.editorInstanceId,
      leaseToken: firstLease.leaseToken,
      epoch: firstLease.epoch,
      targets: [{ path: directory, includeDescendants: true }],
    });
    await first.flushQuarantinePersistence();

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const restartedLease = restarted.acquire({
      workspaceRoot,
      editorInstanceId: "editor-after-topology-restart",
    });
    await expect(
      restarted.completeEditorTopologyMutation({
        workspaceRoot,
        editorInstanceId: restartedLease.editorInstanceId,
        leaseToken: restartedLease.leaseToken,
        epoch: restartedLease.epoch,
        tokenId: token.tokenId,
        sequence: 0,
        buffers: [],
        status: "unknown_outcome",
      }),
    ).resolves.toMatchObject({
      completed: true,
      tokenId: token.tokenId,
      status: "unknown_outcome",
      sync: { accepted: true, sequence: 0 },
    });
    await expect(
      restarted.reserveTopologyMutation([
        { path: directory, includeDescendants: true },
      ]),
    ).resolves.toBeDefined();
  });

  it("discovers only orphaned durable topology fences and explicitly audits unknown recovery", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const directory = join(workspaceRoot, "recovered-topology-list");
    const path = join(directory, "tracked.ts");
    const before = "before interrupted rename\n";
    const after = "after interrupted rename\n";
    await mkdir(directory);
    await writeFile(path, before);
    const first = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const firstLease = first.acquire({
      workspaceRoot,
      editorInstanceId: "editor-owning-live-topology",
    });
    first.sync({
      workspaceRoot,
      editorInstanceId: firstLease.editorInstanceId,
      leaseToken: firstLease.leaseToken,
      epoch: firstLease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 77,
          changedtick: 3,
          contentSha256: sha256(before),
          contentBytes: Buffer.byteLength(before),
          dirty: false,
        },
      ],
    });
    const token = await first.reserveEditorTopologyMutation({
      workspaceRoot,
      editorInstanceId: firstLease.editorInstanceId,
      leaseToken: firstLease.leaseToken,
      epoch: firstLease.epoch,
      targets: [
        {
          path: directory,
          includeDescendants: true,
          allowOwnedClean: true,
        },
      ],
    });
    expect(
      first.listRecoveredEditorTopologyMutations({
        workspaceRoot,
        editorInstanceId: firstLease.editorInstanceId,
        leaseToken: firstLease.leaseToken,
        epoch: firstLease.epoch,
      }),
    ).toEqual([]);
    await writeFile(path, after);
    await first.flushQuarantinePersistence();

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const recoveredLease = restarted.acquire({
      workspaceRoot,
      editorInstanceId: "editor-recovering-orphaned-topology",
    });
    const leaseInput = {
      workspaceRoot,
      editorInstanceId: recoveredLease.editorInstanceId,
      leaseToken: recoveredLease.leaseToken,
      epoch: recoveredLease.epoch,
    };
    expect(restarted.listRecoveredEditorTopologyMutations(leaseInput)).toEqual([
      expect.objectContaining({
        tokenId: token.tokenId,
        workspaceRoot,
        source: "editor",
        targets: [
          {
            path: directory,
            includeDescendants: true,
          },
        ],
      }),
    ]);
    await expect(
      restarted.resolveRecoveredEditorTopologyMutation({
        ...leaseInput,
        tokenId: "not-the-durable-token",
      }),
    ).rejects.toThrow(/not a durable orphan/u);

    await expect(
      restarted.resolveRecoveredEditorTopologyMutation({
        ...leaseInput,
        tokenId: token.tokenId,
      }),
    ).resolves.toEqual({
      resolved: true,
      tokenId: token.tokenId,
      status: "unknown_outcome",
    });
    expect(restarted.listRecoveredEditorTopologyMutations(leaseInput)).toEqual(
      [],
    );
    expect(
      restarted.listChanges({
        ...leaseInput,
        afterSequence: 0,
      }).changes,
    ).toContainEqual(
      expect.objectContaining({
        path,
        source: "editor",
        status: "unknown_outcome",
        beforeSha256: sha256(before),
        afterSha256: sha256(after),
      }),
    );
    await restarted.flushQuarantinePersistence();

    const afterResolutionRestart = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const afterResolutionLease = afterResolutionRestart.acquire({
      workspaceRoot,
      editorInstanceId: "editor-after-topology-resolution",
    });
    expect(
      afterResolutionRestart.listRecoveredEditorTopologyMutations({
        workspaceRoot,
        editorInstanceId: afterResolutionLease.editorInstanceId,
        leaseToken: afterResolutionLease.leaseToken,
        epoch: afterResolutionLease.epoch,
      }),
    ).toEqual([]);
  });

  it("keeps a topology fence active when durable pre-effect release fails", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "held.ts");
    const content = "held\n";
    await writeFile(path, content);
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-release-failure",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: lease.editorInstanceId,
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [],
    });
    await coordinator.flushQuarantinePersistence();
    const token = await coordinator.reserveTopologyMutation([{ path }]);
    const quarantineDirectory = dirname(
      workspaceMutationStatePath(
        workspaceRoot,
        agencHome,
        "quarantine-v1.json",
      ),
    );
    await rm(quarantineDirectory, { recursive: true, force: true });
    await writeFile(quarantineDirectory, "persistence blocked");

    await expect(
      coordinator.releaseTopologyMutation(token),
    ).rejects.toBeDefined();
    expect(() =>
      coordinator.sync({
        workspaceRoot,
        editorInstanceId: lease.editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 1,
        buffers: [
          {
            path,
            bufferHandle: 2,
            changedtick: 1,
            contentSha256: sha256(content),
            contentBytes: Buffer.byteLength(content),
            dirty: false,
          },
        ],
      }),
    ).toThrow(/path operation is committing/u);
  });

  it("never lets an editor topology reservation authorize dirty or stale loaded targets", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "dirty.ts");
    const content = "unsaved\n";
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "editor-dirty-rename",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: lease.editorInstanceId,
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 9,
          changedtick: 2,
          contentSha256: sha256(content),
          contentBytes: Buffer.byteLength(content),
          dirty: true,
          content,
        },
      ],
    });

    await expect(
      coordinator.reserveEditorTopologyMutation({
        workspaceRoot,
        editorInstanceId: lease.editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        targets: [
          {
            path,
            allowOwnedClean: true,
          },
        ],
      }),
    ).rejects.toThrow(/loaded or quarantined in Editor/u);
  });

  it("recovers an unresolved pre-effect mutation intent as an unknown reload after restart", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "crash-window.ts");
    const before = "before crash\n";
    const after = "written before daemon crash\n";
    await writeFile(path, before);
    const first = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const admission = await first.prepareMutation({
      path,
      source: "file_write",
      beforeText: before,
      afterText: after,
    });
    if (admission.decision !== "allow") throw new Error("expected admission");
    first.beginMutation(admission.token);
    await writeFile(path, after);

    const quarantinePath = workspaceMutationStatePath(
      workspaceRoot,
      agencHome,
      "quarantine-v1.json",
    );
    const persistedIntent = await readFile(quarantinePath, "utf8");
    expect(persistedIntent).toContain(admission.token.tokenId);
    expect(persistedIntent).toContain(sha256(before));
    expect(persistedIntent).toContain(sha256(after));
    expect(persistedIntent).not.toContain(before.trim());
    expect(persistedIntent).not.toContain(after.trim());

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = restarted.acquire({
      workspaceRoot,
      editorInstanceId: "editor-after-intent-crash",
    });
    expect(
      restarted.listChanges({
        workspaceRoot,
        editorInstanceId: "editor-after-intent-crash",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      }).changes,
    ).toContainEqual(
      expect.objectContaining({
        path,
        source: "file_write",
        status: "unknown_outcome",
        beforeSha256: sha256(before),
        afterSha256: sha256(after),
      }),
    );
    await restarted.flushQuarantinePersistence();
    const recoveredSnapshot = JSON.parse(
      await readFile(quarantinePath, "utf8"),
    ) as { mutationIntents?: unknown[] };
    expect(recoveredSnapshot.mutationIntents).toEqual([]);
  });

  it("durably clears a cancelled mutation intent without creating a restart reload", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "cancelled.ts");
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const admission = await coordinator.prepareMutation({
      path,
      source: "file_write",
      beforeText: "before\n",
      afterText: "after\n",
    });
    if (admission.decision !== "allow") throw new Error("expected admission");
    coordinator.cancelMutation(admission.token);
    await coordinator.flushQuarantinePersistence();

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = restarted.acquire({
      workspaceRoot,
      editorInstanceId: "editor-after-cancel",
    });
    expect(
      restarted.listChanges({
        workspaceRoot,
        editorInstanceId: "editor-after-cancel",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      }).changes,
    ).toEqual([]);
  });

  it("accepts surviving-editor crash-window revisions and reports externally changed clean buffers", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const savedPath = join(workspaceRoot, "saved-during-crash.ts");
    const externalPath = join(workspaceRoot, "external-during-crash.ts");
    const oldSaved = "old saved\n";
    const newSaved = "new saved\n";
    const oldExternal = "old external\n";
    const newExternal = "new external\n";
    await writeFile(savedPath, oldSaved);
    await writeFile(externalPath, oldExternal);
    const first = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const firstLease = first.acquire({
      workspaceRoot,
      editorInstanceId: "surviving-clean-editor",
    });
    first.sync({
      workspaceRoot,
      editorInstanceId: "surviving-clean-editor",
      leaseToken: firstLease.leaseToken,
      epoch: firstLease.epoch,
      sequence: 0,
      buffers: [
        {
          path: savedPath,
          bufferHandle: 1,
          changedtick: 4,
          contentSha256: sha256(oldSaved),
          contentBytes: Buffer.byteLength(oldSaved),
          dirty: false,
        },
        {
          path: externalPath,
          bufferHandle: 2,
          changedtick: 7,
          contentSha256: sha256(oldExternal),
          contentBytes: Buffer.byteLength(oldExternal),
          dirty: false,
        },
      ],
    });
    await first.flushQuarantinePersistence();
    await writeFile(savedPath, newSaved);
    await writeFile(externalPath, newExternal);

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = restarted.acquire({
      workspaceRoot,
      editorInstanceId: "surviving-clean-editor",
    });
    expect(
      restarted.sync({
        workspaceRoot,
        editorInstanceId: "surviving-clean-editor",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 0,
        buffers: [
          {
            path: savedPath,
            bufferHandle: 1,
            changedtick: 5,
            contentSha256: sha256(newSaved),
            contentBytes: Buffer.byteLength(newSaved),
            dirty: false,
          },
          {
            path: externalPath,
            bufferHandle: 2,
            changedtick: 7,
            contentSha256: sha256(oldExternal),
            contentBytes: Buffer.byteLength(oldExternal),
            dirty: false,
          },
        ],
      }),
    ).toMatchObject({ accepted: true, stalePaths: [] });
    expect(
      restarted.listChanges({
        workspaceRoot,
        editorInstanceId: "surviving-clean-editor",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      }).changes,
    ).toContainEqual(
      expect.objectContaining({
        path: externalPath,
        status: "unknown_outcome",
        beforeSha256: sha256(oldExternal),
        afterSha256: sha256(newExternal),
      }),
    );
  });

  it("allows only the originating editor to replace a quarantined dirty revision", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const path = join(workspaceRoot, "owned-dirty.ts");
    const dirty = "dirty before crash\n";
    const newer = "newer unsynced dirty\n";
    const first = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const firstLease = first.acquire({
      workspaceRoot,
      editorInstanceId: "dirty-owner",
    });
    first.sync({
      workspaceRoot,
      editorInstanceId: "dirty-owner",
      leaseToken: firstLease.leaseToken,
      epoch: firstLease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 1,
          changedtick: 10,
          contentSha256: sha256(dirty),
          dirty: true,
          content: dirty,
        },
      ],
    });
    await first.flushQuarantinePersistence();

    const foreign = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const foreignLease = foreign.acquire({
      workspaceRoot,
      editorInstanceId: "different-editor",
    });
    expect(() =>
      foreign.sync({
        workspaceRoot,
        editorInstanceId: "different-editor",
        leaseToken: foreignLease.leaseToken,
        epoch: foreignLease.epoch,
        sequence: 0,
        buffers: [
          {
            path,
            bufferHandle: 2,
            changedtick: 11,
            contentSha256: sha256(newer),
            dirty: true,
            content: newer,
          },
        ],
      }),
    ).toThrow(/different editor instance/u);

    const owner = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const ownerLease = owner.acquire({
      workspaceRoot,
      editorInstanceId: "dirty-owner",
    });
    expect(
      owner.sync({
        workspaceRoot,
        editorInstanceId: "dirty-owner",
        leaseToken: ownerLease.leaseToken,
        epoch: ownerLease.epoch,
        sequence: 0,
        buffers: [
          {
            path,
            bufferHandle: 1,
            changedtick: 11,
            contentSha256: sha256(newer),
            dirty: true,
            content: newer,
          },
        ],
      }),
    ).toMatchObject({ accepted: true, dirtyPaths: [path] });
  });

  it("rejects same-path concurrent writes and a sixty-fifth pending reload admission", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const tokens = [];
    for (let index = 0; index < 64; index += 1) {
      const path = join(workspaceRoot, `pending-${index}.ts`);
      const admission = await coordinator.prepareMutation({
        path,
        source: "file_write",
        beforeText: `before-${index}\n`,
        afterText: `after-${index}\n`,
      });
      if (admission.decision !== "allow") {
        throw new Error("expected admission");
      }
      tokens.push(admission.token);
      if (index === 0) {
        await expect(
          coordinator.prepareMutation({
            path,
            source: "file_edit",
            beforeText: "before-0\n",
            afterText: "competing\n",
          }),
        ).rejects.toThrow(/already owns this path/u);
      }
    }
    await expect(
      coordinator.prepareMutation({
        path: join(workspaceRoot, "pending-64.ts"),
        source: "file_write",
        beforeText: "before-64\n",
        afterText: "after-64\n",
      }),
    ).rejects.toThrow(/acknowledges pending disk changes/u);
    for (const token of tokens) coordinator.cancelMutation(token);
    await coordinator.flushQuarantinePersistence();
  });

  it("restores unresolved topology reservations as active fences until explicit reconciliation", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const directory = join(workspaceRoot, "topology-crash");
    const path = join(directory, "loaded.ts");
    const before = "before topology crash\n";
    const after = "after topology crash\n";
    await mkdir(directory);
    await writeFile(path, before);
    const first = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = first.acquire({
      workspaceRoot,
      editorInstanceId: "topology-crash-editor",
    });
    first.sync({
      workspaceRoot,
      editorInstanceId: "topology-crash-editor",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [],
    });
    const reservation = await first.reserveTopologyMutation(
      [{ path: directory, includeDescendants: true }],
      "rewind",
    );
    expect(() =>
      first.sync({
        workspaceRoot,
        editorInstanceId: "topology-crash-editor",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 1,
        buffers: [
          {
            path,
            bufferHandle: 1,
            changedtick: 1,
            contentSha256: sha256(before),
            contentBytes: Buffer.byteLength(before),
            dirty: false,
          },
        ],
      }),
    ).toThrow(/path operation is committing/u);
    await first.flushQuarantinePersistence();
    await writeFile(path, after);

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const restartedLease = restarted.acquire({
      workspaceRoot,
      editorInstanceId: "topology-crash-editor",
    });
    await expect(
      restarted.prepareMutation({
        path,
        source: "file_write",
        beforeText: after,
        afterText: "overlapping write\n",
      }),
    ).rejects.toThrow(/path operation is committing/u);
    await expect(
      restarted.reserveTopologyMutation([
        { path: directory, includeDescendants: true },
      ]),
    ).rejects.toThrow(/overlapping workspace path operation/u);
    expect(
      restarted.listChanges({
        workspaceRoot,
        editorInstanceId: restartedLease.editorInstanceId,
        leaseToken: restartedLease.leaseToken,
        epoch: restartedLease.epoch,
      }).changes,
    ).not.toContainEqual(
      expect.objectContaining({
        path,
        status: "unknown_outcome",
      }),
    );

    await restarted.completeTopologyMutation(reservation, "unknown_outcome");
    expect(
      restarted.listChanges({
        workspaceRoot,
        editorInstanceId: restartedLease.editorInstanceId,
        leaseToken: restartedLease.leaseToken,
        epoch: restartedLease.epoch,
      }).changes,
    ).toContainEqual(
      expect.objectContaining({
        path,
        source: "rewind",
        status: "unknown_outcome",
        beforeSha256: sha256(before),
        afterSha256: sha256(after),
      }),
    );
    await restarted.flushQuarantinePersistence();
    const afterReconciliation = await restarted.prepareMutation({
      path,
      source: "file_write",
      beforeText: after,
      afterText: "after reconciliation\n",
    });
    expect(afterReconciliation.decision).toBe("allow");
    if (afterReconciliation.decision === "allow") {
      restarted.cancelMutation(afterReconciliation.token);
    }
  });

  it("durably abandons recovered topology fences through an explicit dirty-authority release", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const directory = join(workspaceRoot, "abandoned-topology");
    const path = join(directory, "target.ts");
    await mkdir(directory);
    await writeFile(path, "target\n");
    const first = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    await first.reserveTopologyMutation([
      { path: directory, includeDescendants: true },
    ]);
    await first.flushQuarantinePersistence();

    const restarted = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    const lease = restarted.acquire({
      workspaceRoot,
      editorInstanceId: "editor-abandoning-recovered-topology",
    });
    await expect(
      restarted.prepareMutation({
        path,
        source: "file_write",
        beforeText: "target\n",
        afterText: "blocked\n",
      }),
    ).rejects.toThrow(/path operation is committing/u);

    await restarted.release({
      workspaceRoot,
      editorInstanceId: lease.editorInstanceId,
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      abandonDirty: true,
    });
    await restarted.flushQuarantinePersistence();

    const afterAbandonment = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    await expect(
      afterAbandonment.reserveTopologyMutation([
        { path: directory, includeDescendants: true },
      ]),
    ).resolves.toMatchObject({
      workspaceRoot,
      targets: [{ path: directory, includeDescendants: true }],
    });
  });

  it("keeps a topology fence and its durable intent when reload delivery is full", async () => {
    const workspaceRoot = await tempDirectory("agenc-coherence-workspace-");
    const agencHome = await tempDirectory("agenc-coherence-home-");
    const coordinator = new WorkspaceMutationCoordinator({
      workspaceRoot,
      agencHome,
    });
    for (let index = 0; index < 63; index += 1) {
      const path = join(workspaceRoot, `applied-${index}.ts`);
      const admission = await coordinator.prepareMutation({
        path,
        source: "file_write",
        beforeText: `before-${index}\n`,
        afterText: `after-${index}\n`,
      });
      if (admission.decision !== "allow") {
        throw new Error("expected admission");
      }
      coordinator.beginMutation(admission.token);
      await coordinator.commitMutation(admission.token, `after-${index}\n`);
    }
    const directory = join(workspaceRoot, "full-delivery");
    const firstPath = join(directory, "first.ts");
    const secondPath = join(directory, "second.ts");
    const firstContent = "first stale\n";
    const secondContent = "second stale\n";
    await mkdir(directory);
    await writeFile(firstPath, firstContent);
    await writeFile(secondPath, secondContent);
    const lease = coordinator.acquire({
      workspaceRoot,
      editorInstanceId: "full-delivery-editor",
    });
    coordinator.sync({
      workspaceRoot,
      editorInstanceId: "full-delivery-editor",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [],
    });
    const reservation = await coordinator.reserveTopologyMutation([
      { path: directory, includeDescendants: true },
    ]);
    const syncPath = (path: string, content: string) =>
      coordinator.sync({
        workspaceRoot,
        editorInstanceId: "full-delivery-editor",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 1,
        buffers: [
          {
            path,
            bufferHandle: 1,
            changedtick: 1,
            contentSha256: sha256(content),
            contentBytes: Buffer.byteLength(content),
            dirty: false,
          },
        ],
      });
    expect(() => syncPath(firstPath, firstContent)).toThrow(
      /path operation is committing/u,
    );
    await coordinator.flushQuarantinePersistence();
    expect(() => syncPath(secondPath, secondContent)).toThrow(
      /pending workspace change queue/u,
    );
    await coordinator.flushQuarantinePersistence();
    const quarantine = JSON.parse(
      await readFile(
        workspaceMutationStatePath(
          workspaceRoot,
          agencHome,
          "quarantine-v1.json",
        ),
        "utf8",
      ),
    ) as {
      topologyIntents?: {
        contentions?: { path?: string }[];
      }[];
    };
    expect(
      quarantine.topologyIntents?.[0]?.contentions?.map(
        (contention) => contention.path,
      ),
    ).toEqual([firstPath, secondPath]);
    await expect(
      coordinator.completeTopologyMutation(reservation, "applied"),
    ).rejects.toThrow(/pending workspace change queue/u);
    expect(() => syncPath(firstPath, firstContent)).toThrow(
      /path operation is committing/u,
    );
  });

  it("declares every editor-coherence RPC as an internal capability", () => {
    expect(AGENC_DAEMON_INTERNAL_METHODS).toEqual(
      expect.arrayContaining([
        "workspace.editor.acquire",
        "workspace.editor.sync",
        "workspace.editor.heartbeat",
        "workspace.editor.release",
        "workspace.editor.proposal.status",
      ]),
    );
  });
});
