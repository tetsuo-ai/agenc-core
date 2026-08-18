import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgenCDaemonAgentManager } from "./agent-lifecycle.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import {
  AGENC_DAEMON_METHOD_CAPABILITIES_KEY,
  JSON_RPC_VERSION,
  type JsonObject,
} from "./protocol/index.js";
import {
  sha256,
  WORKSPACE_EDITOR_PROPOSAL_MAX_FRAME_BYTES,
  workspaceMutationCoordinators,
} from "../workspace/mutation-coordinator.js";

const temporaryPaths: string[] = [];
const originalAgencHome = process.env.AGENC_HOME;

afterEach(async () => {
  workspaceMutationCoordinators.clearForTests();
  if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = originalAgencHome;
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function tempDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function request(id: string, method: string, params: JsonObject): JsonObject {
  return { jsonrpc: JSON_RPC_VERSION, id, method, params };
}

describe("daemon editor coherence protocol", () => {
  it("advertises recovered topology resolution only to protocol 1.1 clients", async () => {
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    for (const [version, expected] of [
      ["1.0.0", false],
      ["1.1.0", true],
    ] as const) {
      const initialized = await dispatcher.createConnection().dispatch(
        request(`initialize-${version}`, "initialize", {
          protocol: { version },
        }),
      );
      expect(
        (
          (initialized.result as JsonObject).capabilities as Record<
            string,
            Record<string, boolean>
          >
        )[AGENC_DAEMON_METHOD_CAPABILITIES_KEY]?.[
          "workspace.editor.topology.recovered.resolve"
        ],
      ).toBe(expected);
    }
  });

  it("does not acknowledge a dirty sync whose quarantine cannot be persisted", async () => {
    const workspaceRoot = await tempDirectory("agenc-editor-rpc-workspace-");
    const agencHome = await tempDirectory("agenc-editor-rpc-home-");
    process.env.AGENC_HOME = agencHome;
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const connection = dispatcher.createConnection();
    await connection.dispatch(
      request("initialize", "initialize", {
        protocol: { version: "1.0.0" },
      }),
    );
    const acquired = await connection.dispatch(
      request("acquire", "workspace.editor.acquire", {
        workspaceRoot,
        editorInstanceId: "editor-persistence-failure",
      }),
    );
    const lease = acquired.result as {
      readonly leaseToken: string;
      readonly epoch: number;
    };
    // The coordinator has already resolved its paths, but persistence now
    // encounters a non-directory where its durable root must be.
    await writeFile(join(agencHome, "workspace-mutations"), "blocked");

    await expect(
      connection.dispatch(
        request("sync", "workspace.editor.sync", {
          workspaceRoot,
          editorInstanceId: "editor-persistence-failure",
          leaseToken: lease.leaseToken,
          epoch: lease.epoch,
          sequence: 0,
          buffers: [
            {
              path: join(workspaceRoot, "dirty.ts"),
              bufferHandle: 1,
              changedtick: 2,
              contentSha256: sha256("unsaved\n"),
              contentBytes: Buffer.byteLength("unsaved\n", "utf8"),
              dirty: true,
              content: "unsaved\n",
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({
      id: "sync",
      error: { code: -32602 },
    });
  });

  it("refreshes stale disk evidence without asking a new Editor to prove orphaned bytes", async () => {
    const workspaceRoot = await tempDirectory(
      "agenc-editor-refresh-workspace-",
    );
    const agencHome = await tempDirectory("agenc-editor-refresh-home-");
    process.env.AGENC_HOME = agencHome;
    const path = join(workspaceRoot, "refresh.ts");
    const initialDiskContent = "initial disk revision\n";
    const refreshedDiskContent = "refreshed disk revision\n";
    const orphanedContent = "orphaned Editor revision\n";
    await writeFile(path, initialDiskContent, "utf8");

    const firstDispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const firstConnection = firstDispatcher.createConnection();
    await firstConnection.dispatch(
      request("initialize-first", "initialize", {
        protocol: { version: "1.1.0" },
      }),
    );
    const firstAcquired = await firstConnection.dispatch(
      request("acquire-first", "workspace.editor.acquire", {
        workspaceRoot,
        editorInstanceId: "editor-before-refresh",
      }),
    );
    const firstLease = firstAcquired.result as {
      readonly leaseToken: string;
      readonly epoch: number;
    };
    await expect(
      firstConnection.dispatch(
        request("sync-first", "workspace.editor.sync", {
          workspaceRoot,
          editorInstanceId: "editor-before-refresh",
          leaseToken: firstLease.leaseToken,
          epoch: firstLease.epoch,
          sequence: 0,
          buffers: [
            {
              path,
              bufferHandle: 1,
              changedtick: 9,
              contentSha256: sha256(orphanedContent),
              contentBytes: Buffer.byteLength(orphanedContent),
              dirty: true,
              content: orphanedContent,
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ result: { accepted: true } });
    await workspaceMutationCoordinators
      .getOrCreate(workspaceRoot)
      .flushQuarantinePersistence();
    await firstConnection.close();
    workspaceMutationCoordinators.clearForTests();

    const restartedDispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const connection = restartedDispatcher.createConnection();
    await connection.dispatch(
      request("initialize-restarted", "initialize", {
        protocol: { version: "1.1.0" },
      }),
    );
    const acquired = await connection.dispatch(
      request("acquire-restarted", "workspace.editor.acquire", {
        workspaceRoot,
        editorInstanceId: "editor-reviewing-refresh",
      }),
    );
    const lease = acquired.result as {
      readonly leaseToken: string;
      readonly epoch: number;
    };
    expect(acquired).toMatchObject({
      result: {
        sequence: -1,
        staleAuthority: [
          {
            path,
            editorContentSha256: sha256(orphanedContent),
            diskContentSha256: sha256(initialDiskContent),
          },
        ],
      },
    });

    await writeFile(path, refreshedDiskContent, "utf8");
    const leaseParams = {
      workspaceRoot,
      editorInstanceId: "editor-reviewing-refresh",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
    };
    await expect(
      connection.dispatch(
        request(
          "refresh",
          "workspace.editor.staleAuthority.refresh",
          leaseParams,
        ),
      ),
    ).resolves.toMatchObject({
      result: {
        refreshed: true,
        staleAuthority: [
          {
            path,
            editorContentSha256: sha256(orphanedContent),
            editorInstanceId: "editor-before-refresh",
            diskState: "content",
            diskContentSha256: sha256(refreshedDiskContent),
            diskContentBytes: Buffer.byteLength(refreshedDiskContent),
          },
        ],
      },
    });
    await expect(
      connection.dispatch(
        request(
          "refresh-cannot-resolve",
          "workspace.editor.staleAuthority.refresh",
          {
            ...leaseParams,
            abandonStaleAuthority: [],
          },
        ),
      ),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining("abandonStaleAuthority"),
      },
    });

    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    expect(coordinator.authorityForPath(path)).toBe("stale_dirty");
    expect(coordinator.stalePaths()).toEqual([path]);

    await expect(
      connection.dispatch(
        request("ordinary-sync", "workspace.editor.sync", {
          ...leaseParams,
          sequence: 0,
          buffers: [
            {
              path,
              bufferHandle: 2,
              changedtick: 1,
              contentSha256: sha256(refreshedDiskContent),
              contentBytes: Buffer.byteLength(refreshedDiskContent),
              dirty: false,
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining("belongs to a different editor"),
      },
    });
    await expect(
      connection.dispatch(
        request(
          "heartbeat-after-refresh",
          "workspace.editor.heartbeat",
          leaseParams,
        ),
      ),
    ).resolves.toMatchObject({
      result: {
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: -1,
      },
    });
    expect(coordinator.authorityForPath(path)).toBe("stale_dirty");
  });

  it("retries a pending audit projection on same-daemon acquire exactly once", async () => {
    const workspaceRoot = await tempDirectory("agenc-editor-audit-workspace-");
    const agencHome = await tempDirectory("agenc-editor-audit-home-");
    process.env.AGENC_HOME = agencHome;
    const path = join(workspaceRoot, "pending-audit.ts");
    const before = "orphaned editor state\n";
    const after = "reviewed disk state\n";
    await writeFile(path, after, "utf8");
    const auditEntry = {
      version: 1,
      entryId: sha256("same-daemon-pending-audit"),
      timestamp: "2026-08-17T18:00:00.000Z",
      workspaceRoot,
      path,
      source: "editor",
      status: "discarded",
      beforeSha256: sha256(before),
      afterSha256: sha256(after),
    };
    const stateDirectory = join(
      agencHome,
      "workspace-mutations",
      sha256(workspaceRoot).slice(0, 32),
    );
    const quarantinePath = join(stateDirectory, "quarantine-v1.json");
    const ledgerPath = join(stateDirectory, "ledger-v1.jsonl");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
      quarantinePath,
      `${JSON.stringify({
        version: 2,
        workspaceRoot,
        entries: [],
        proposalCommitments: [],
        proposalReceipts: [],
        mutationIntents: [],
        topologyIntents: [],
        changeSequence: 0,
        changes: [],
        auditOutbox: [auditEntry],
      })}\n`,
      "utf8",
    );
    await mkdir(ledgerPath);

    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const connection = dispatcher.createConnection();
    await connection.dispatch(
      request("initialize", "initialize", {
        protocol: { version: "1.0.0" },
      }),
    );
    const acquireParams = {
      workspaceRoot,
      editorInstanceId: "editor-same-daemon-audit-retry",
    };

    await expect(
      connection.dispatch(
        request(
          "acquire-failed-audit",
          "workspace.editor.acquire",
          acquireParams,
        ),
      ),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining(
          "pending workspace audit could not be completed",
        ),
      },
    });

    await rm(ledgerPath, { recursive: true });
    await expect(
      connection.dispatch(
        request(
          "acquire-retry-audit",
          "workspace.editor.acquire",
          acquireParams,
        ),
      ),
    ).resolves.toMatchObject({
      result: {
        editorInstanceId: acquireParams.editorInstanceId,
        sequence: -1,
      },
    });
    await expect(
      connection.dispatch(
        request(
          "acquire-again-audit",
          "workspace.editor.acquire",
          acquireParams,
        ),
      ),
    ).resolves.toMatchObject({ result: { sequence: -1 } });

    const ledgerEntries = (await readFile(ledgerPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(ledgerEntries).toEqual([auditEntry]);
    const cleanedQuarantine = JSON.parse(
      await readFile(quarantinePath, "utf8"),
    ) as { readonly version?: number; readonly auditOutbox?: unknown };
    expect(cleanedQuarantine).toMatchObject({ version: 1 });
    expect(cleanedQuarantine.auditOutbox).toBeUndefined();
  });

  it("acquires, syncs, inspects, applies, and discards in-memory proposals", async () => {
    const workspaceRoot = await tempDirectory("agenc-editor-rpc-workspace-");
    const agencHome = await tempDirectory("agenc-editor-rpc-home-");
    process.env.AGENC_HOME = agencHome;
    await mkdir(workspaceRoot, { recursive: true });

    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const connection = dispatcher.createConnection();
    const initialized = await connection.dispatch(
      request("initialize", "initialize", {
        protocol: { version: "1.1.0" },
      }),
    );
    expect(
      (
        (initialized.result as JsonObject).capabilities as Record<
          string,
          Record<string, boolean>
        >
      )[AGENC_DAEMON_METHOD_CAPABILITIES_KEY],
    ).toMatchObject({
      "workspace.editor.acquire": true,
      "workspace.editor.sync": true,
      "workspace.editor.staleAuthority.refresh": true,
      "workspace.editor.heartbeat": true,
      "workspace.editor.release": true,
      "workspace.editor.topology.reserve": true,
      "workspace.editor.topology.complete": true,
      "workspace.editor.topology.release": true,
      "workspace.editor.topology.recovered.list": true,
      "workspace.editor.topology.recovered.resolve": true,
      "workspace.editor.proposal.get": true,
      "workspace.editor.proposal.status": true,
      "workspace.editor.proposal.apply": true,
      "workspace.editor.proposal.discard": true,
      "workspace.editor.changes.list": true,
    });

    const acquired = await connection.dispatch(
      request("acquire", "workspace.editor.acquire", {
        workspaceRoot,
        editorInstanceId: "editor-rpc",
      }),
    );
    expect(acquired).toMatchObject({
      result: { sequence: -1 },
    });
    const lease = acquired.result as {
      readonly leaseToken: string;
      readonly epoch: number;
    };
    const base = "export const n = 1;\n";
    const path = join(workspaceRoot, "main.ts");
    const leaseParams = {
      workspaceRoot,
      editorInstanceId: "editor-rpc",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
    };
    await expect(
      connection.dispatch(
        request("sync", "workspace.editor.sync", {
          ...leaseParams,
          sequence: 0,
          buffers: [
            {
              path,
              bufferHandle: 4,
              changedtick: 6,
              contentSha256: sha256(base),
              contentBytes: Buffer.byteLength(base, "utf8"),
              dirty: true,
              content: base,
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({
      result: { accepted: true, dirtyPaths: [path] },
    });
    await expect(
      connection.dispatch(
        request("reacquire", "workspace.editor.acquire", {
          workspaceRoot,
          editorInstanceId: "editor-rpc",
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 0,
      },
    });

    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const candidate = "export const n = 2;\n";
    const proposed = await coordinator.prepareMutation({
      path,
      source: "file_edit",
      beforeText: base,
      afterText: candidate,
    });
    expect(proposed.decision).toBe("proposal");
    if (proposed.decision !== "proposal") throw new Error("proposal expected");

    await expect(
      connection.dispatch(
        request("status-reviewable", "workspace.editor.proposal.status", {
          ...leaseParams,
          proposalId: proposed.proposal.proposalId,
        }),
      ),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "status-reviewable",
      result: {
        status: "reviewable",
        proposal: proposed.proposal,
      },
    });
    await expect(
      connection.dispatch(
        request("get", "workspace.editor.proposal.get", {
          ...leaseParams,
          proposalId: proposed.proposal.proposalId,
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        beforeText: base,
        afterText: candidate,
        baseChangedtick: 6,
      },
    });

    const applyParams = {
      ...leaseParams,
      proposalId: proposed.proposal.proposalId,
      changedtick: 7,
      contentSha256: sha256(candidate),
      content: candidate,
    };
    await expect(
      connection.dispatch(
        request("apply", "workspace.editor.proposal.apply", applyParams),
      ),
    ).resolves.toMatchObject({
      result: {
        applied: true,
        proposalId: proposed.proposal.proposalId,
        changedtick: 7,
      },
    });
    await expect(
      connection.dispatch(
        request("status-applied", "workspace.editor.proposal.status", {
          ...leaseParams,
          proposalId: proposed.proposal.proposalId,
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        status: "applied",
        proposalId: proposed.proposal.proposalId,
        path,
        changedtick: 7,
        contentSha256: sha256(candidate),
      },
    });
    await expect(
      connection.dispatch(
        request("status-wrong-lease", "workspace.editor.proposal.status", {
          ...leaseParams,
          leaseToken: "wrong-lease-token",
          proposalId: proposed.proposal.proposalId,
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining(
          "lease token, instance, or epoch does not match",
        ),
      },
    });
    await expect(
      connection.dispatch(
        request("apply-retry", "workspace.editor.proposal.apply", applyParams),
      ),
    ).resolves.toMatchObject({
      result: {
        applied: true,
        proposalId: proposed.proposal.proposalId,
        changedtick: 7,
      },
    });
    await expect(
      connection.dispatch(
        request("apply-conflict", "workspace.editor.proposal.apply", {
          ...applyParams,
          changedtick: 8,
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        message: expect.stringContaining("conflicts with its applied receipt"),
      },
    });
    expect(coordinator.authoritativeRead(path)?.content).toBe(candidate);

    const discardedCandidate = "export const n = 3;\n";
    const toDiscard = await coordinator.prepareMutation({
      path,
      source: "file_write",
      beforeText: candidate,
      afterText: discardedCandidate,
    });
    expect(toDiscard.decision).toBe("proposal");
    if (toDiscard.decision !== "proposal") {
      throw new Error("proposal expected");
    }
    const discardParams = {
      ...leaseParams,
      proposalId: toDiscard.proposal.proposalId,
    };
    await expect(
      connection.dispatch(
        request("discard", "workspace.editor.proposal.discard", discardParams),
      ),
    ).resolves.toMatchObject({
      result: {
        discarded: true,
        proposalId: toDiscard.proposal.proposalId,
      },
    });
    await expect(
      connection.dispatch(
        request("status-discarded", "workspace.editor.proposal.status", {
          ...leaseParams,
          proposalId: toDiscard.proposal.proposalId,
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        status: "discarded",
        proposalId: toDiscard.proposal.proposalId,
        path,
      },
    });
    await expect(
      connection.dispatch(
        request("status-missing", "workspace.editor.proposal.status", {
          ...leaseParams,
          proposalId: "missing-proposal",
        }),
      ),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "status-missing",
      result: {
        status: "missing",
        proposalId: "missing-proposal",
      },
    });
    await expect(
      connection.dispatch(
        request(
          "discard-retry",
          "workspace.editor.proposal.discard",
          discardParams,
        ),
      ),
    ).resolves.toMatchObject({
      result: {
        discarded: true,
        proposalId: toDiscard.proposal.proposalId,
      },
    });
    expect(coordinator.getProposal(toDiscard.proposal.proposalId)).toBeNull();
    expect(coordinator.authoritativeRead(path)?.content).toBe(candidate);
    await expect(
      connection.dispatch(
        request("changes", "workspace.editor.changes.list", {
          ...leaseParams,
          afterSequence: 0,
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        sequence: 4,
        changes: [
          { sequence: 2, status: "applied" },
          { sequence: 4, status: "discarded" },
        ],
      },
    });

    await connection.close();
  });

  it("recovers committed and applied proposal status through dispatcher restarts", async () => {
    const workspaceRoot = await tempDirectory(
      "agenc-editor-status-restart-workspace-",
    );
    const agencHome = await tempDirectory("agenc-editor-status-restart-home-");
    process.env.AGENC_HOME = agencHome;
    const path = join(workspaceRoot, "restart.ts");
    const base = "export const restart = 1;\n";
    const candidate = "export const restart = 2;\n";
    await writeFile(path, base);

    const createConnection = async () => {
      const dispatcher = new AgenCDaemonJsonRpcDispatcher({
        agentManager: new AgenCDaemonAgentManager(),
      });
      const connection = dispatcher.createConnection();
      await connection.dispatch(
        request("initialize", "initialize", {
          protocol: { version: "1.0.0" },
        }),
      );
      return connection;
    };
    const acquire = async (
      connection: Awaited<ReturnType<typeof createConnection>>,
      editorInstanceId: string,
    ) => {
      const response = await connection.dispatch(
        request(`acquire-${editorInstanceId}`, "workspace.editor.acquire", {
          workspaceRoot,
          editorInstanceId,
        }),
      );
      const lease = response.result as {
        readonly leaseToken: string;
        readonly epoch: number;
      };
      return {
        workspaceRoot,
        editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      };
    };

    const firstConnection = await createConnection();
    const firstLease = await acquire(firstConnection, "editor-status-restart");
    await firstConnection.dispatch(
      request("sync-before-restart", "workspace.editor.sync", {
        ...firstLease,
        sequence: 0,
        buffers: [
          {
            path,
            bufferHandle: 12,
            changedtick: 3,
            contentSha256: sha256(base),
            contentBytes: Buffer.byteLength(base, "utf8"),
            dirty: true,
            content: base,
          },
        ],
      }),
    );
    const admission = await workspaceMutationCoordinators
      .getOrCreate(workspaceRoot)
      .prepareMutation({
        path,
        source: "file_edit",
        beforeText: base,
        afterText: candidate,
      });
    if (admission.decision !== "proposal") {
      throw new Error("expected an editor proposal");
    }
    await firstConnection.close();

    workspaceMutationCoordinators.clearForTests();
    const restartedConnection = await createConnection();
    const restartedLease = await acquire(
      restartedConnection,
      "editor-status-restart",
    );
    await expect(
      restartedConnection.dispatch(
        request("status-committed", "workspace.editor.proposal.status", {
          ...restartedLease,
          proposalId: admission.proposal.proposalId,
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        status: "committed",
        proposalId: admission.proposal.proposalId,
        path,
        source: "file_edit",
        baseContentSha256: sha256(base),
        afterContentSha256: sha256(candidate),
        baseChangedtick: 3,
        bufferHandle: 12,
      },
    });
    await restartedConnection.dispatch(
      request("apply-after-restart", "workspace.editor.proposal.apply", {
        ...restartedLease,
        proposalId: admission.proposal.proposalId,
        changedtick: 4,
        contentSha256: sha256(candidate),
        content: candidate,
      }),
    );
    await restartedConnection.close();

    workspaceMutationCoordinators.clearForTests();
    const receiptConnection = await createConnection();
    const receiptLease = await acquire(
      receiptConnection,
      "editor-status-receipt",
    );
    await expect(
      receiptConnection.dispatch(
        request("status-applied-restart", "workspace.editor.proposal.status", {
          ...receiptLease,
          proposalId: admission.proposal.proposalId,
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        status: "applied",
        proposalId: admission.proposal.proposalId,
        path,
        changedtick: 4,
        contentSha256: sha256(candidate),
      },
    });
    await receiptConnection.close();
  });

  it("rejects a proposal.get envelope that the daemon peer cannot receive", async () => {
    const workspaceRoot = await tempDirectory("agenc-editor-rpc-workspace-");
    const agencHome = await tempDirectory("agenc-editor-rpc-home-");
    process.env.AGENC_HOME = agencHome;
    const path = join(workspaceRoot, "escape-heavy.ts");
    const before = "\0".repeat(1_300_000);
    const after = "\u0001".repeat(1_300_000);
    await writeFile(path, before);

    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const connection = dispatcher.createConnection();
    await connection.dispatch(
      request("initialize", "initialize", {
        protocol: { version: "1.0.0" },
      }),
    );
    const acquired = await connection.dispatch(
      request("acquire", "workspace.editor.acquire", {
        workspaceRoot,
        editorInstanceId: "editor-proposal-envelope",
      }),
    );
    const lease = acquired.result as {
      readonly leaseToken: string;
      readonly epoch: number;
    };
    const leaseParams = {
      workspaceRoot,
      editorInstanceId: "editor-proposal-envelope",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
    };
    await connection.dispatch(
      request("sync", "workspace.editor.sync", {
        ...leaseParams,
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
      }),
    );

    const coordinator =
      workspaceMutationCoordinators.getOrCreate(workspaceRoot);
    const admission = await coordinator.prepareMutation({
      path,
      source: "file_edit",
      beforeText: before,
      afterText: after,
    });
    expect(admission.decision).toBe("proposal");
    if (admission.decision !== "proposal") throw new Error("proposal expected");

    const largeRequestId = "i".repeat(1_200_000);
    const numericEnvelopeBytes = Buffer.byteLength(
      `${JSON.stringify({
        jsonrpc: JSON_RPC_VERSION,
        id: Number.MAX_SAFE_INTEGER,
        result: admission.proposal,
      })}\n`,
      "utf8",
    );
    const callerEnvelopeBytes = Buffer.byteLength(
      `${JSON.stringify({
        jsonrpc: JSON_RPC_VERSION,
        id: largeRequestId,
        result: admission.proposal,
      })}\n`,
      "utf8",
    );
    expect(numericEnvelopeBytes).toBeLessThanOrEqual(
      WORKSPACE_EDITOR_PROPOSAL_MAX_FRAME_BYTES,
    );
    expect(callerEnvelopeBytes).toBeGreaterThan(
      WORKSPACE_EDITOR_PROPOSAL_MAX_FRAME_BYTES,
    );

    const response = await connection.dispatch(
      request(largeRequestId, "workspace.editor.proposal.get", {
        ...leaseParams,
        proposalId: admission.proposal.proposalId,
      }),
    );
    expect("error" in response).toBe(true);
    if (!("error" in response)) {
      throw new Error("oversized proposal.get response was accepted");
    }
    expect(response.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining("daemon peer frame limit"),
    });
    const statusResponse = await connection.dispatch(
      request(largeRequestId, "workspace.editor.proposal.status", {
        ...leaseParams,
        proposalId: admission.proposal.proposalId,
      }),
    );
    expect("error" in statusResponse).toBe(true);
    if (!("error" in statusResponse)) {
      throw new Error("oversized proposal.status response was accepted");
    }
    expect(statusResponse.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining("daemon peer frame limit"),
    });
    await connection.close();
  });

  it("keeps the authenticated topology fence held through disk rename and the exact final Editor sync", async () => {
    const workspaceRoot = await tempDirectory(
      "agenc-editor-topology-workspace-",
    );
    const agencHome = await tempDirectory("agenc-editor-topology-home-");
    process.env.AGENC_HOME = agencHome;
    const sourceDirectory = join(workspaceRoot, "src");
    const destinationDirectory = join(workspaceRoot, "lib");
    const sourcePath = join(sourceDirectory, "main.ts");
    const destinationPath = join(destinationDirectory, "main.ts");
    const content = "export const topology = true;\n";
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(sourcePath, content);

    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const connection = dispatcher.createConnection();
    await connection.dispatch(
      request("initialize", "initialize", {
        protocol: { version: "1.0.0" },
      }),
    );
    const acquired = await connection.dispatch(
      request("acquire", "workspace.editor.acquire", {
        workspaceRoot,
        editorInstanceId: "editor-topology-rpc",
      }),
    );
    const lease = acquired.result as {
      readonly leaseToken: string;
      readonly epoch: number;
    };
    const leaseParams = {
      workspaceRoot,
      editorInstanceId: "editor-topology-rpc",
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
    };
    const cleanBuffer = {
      path: sourcePath,
      bufferHandle: 8,
      changedtick: 3,
      contentSha256: sha256(content),
      contentBytes: Buffer.byteLength(content, "utf8"),
      dirty: false,
    };
    await expect(
      connection.dispatch(
        request("sync", "workspace.editor.sync", {
          ...leaseParams,
          sequence: 0,
          buffers: [cleanBuffer],
        }),
      ),
    ).resolves.toMatchObject({
      result: { accepted: true, sequence: 0 },
    });

    const reserved = await connection.dispatch(
      request("reserve", "workspace.editor.topology.reserve", {
        ...leaseParams,
        targets: [
          {
            path: sourceDirectory,
            includeDescendants: true,
            allowOwnedClean: true,
          },
          {
            path: destinationDirectory,
            includeDescendants: true,
            allowOwnedClean: false,
          },
        ],
      }),
    );
    expect(reserved).toMatchObject({
      result: {
        tokenId: expect.any(String),
        targets: [
          {
            path: sourceDirectory,
            includeDescendants: true,
          },
          {
            path: destinationDirectory,
            includeDescendants: true,
          },
        ],
      },
    });
    const tokenId = (reserved.result as { readonly tokenId: string }).tokenId;

    await rename(sourceDirectory, destinationDirectory);
    await expect(
      connection.dispatch(
        request("complete", "workspace.editor.topology.complete", {
          ...leaseParams,
          tokenId,
          status: "applied",
          sequence: 1,
          buffers: [
            {
              ...cleanBuffer,
              path: destinationPath,
              changedtick: 4,
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        completed: true,
        tokenId,
        status: "applied",
        sync: {
          accepted: true,
          sequence: 1,
          dirtyPaths: [],
          stalePaths: [],
        },
      },
    });
  });
});
