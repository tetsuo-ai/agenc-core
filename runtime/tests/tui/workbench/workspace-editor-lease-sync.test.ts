import { createHash } from "node:crypto";

import { afterEach, describe, expect, test, vi } from "vitest";

import type {
  WorkspaceEditorLeaseResult,
  WorkspaceEditorChangeResult,
  WorkspaceEditorProposalApplyParams,
  WorkspaceEditorProposalParams,
  WorkspaceEditorRecoveredTopologyMutation,
  WorkspaceEditorRecoveredTopologyResolveParams,
  WorkspaceEditorSyncParams,
  WorkspaceEditorTopologyCompleteParams,
  WorkspaceEditorTopologyFinalizeParams,
  WorkspaceEditorTopologyReserveParams,
} from "../../../src/app-server/protocol/index.js";
import {
  createOrderedWorkspaceEditorTeardown,
  settleWorkspaceEditorTeardown,
  WorkspaceEditorLeaseSynchronizer,
  workspaceBufferManifestSignature,
  workspaceBufferSync,
  type WorkspaceEditorBufferSource,
  type WorkspaceEditorLeaseClient,
} from "../../../src/tui/workbench/workspaceEditorLeaseSync.js";
import {
  emptyProviderSnapshot,
  NEOVIM_BUFFER_CAPABILITIES,
  type BufferProviderSnapshot,
  type BufferWorkspaceBufferCapture,
  type BufferWorkspaceWriteAuthorityHandler,
  type BufferWorkspaceWriteDecision,
} from "../../../src/tui/workbench/buffer/providers/types.js";
import { TuiTeardownBarrier } from "../../../src/tui/teardownBarrier.js";

const WORKSPACE = "/workspace";
const EDITOR_ID = "tui-editor-test";

afterEach(() => {
  vi.useRealTimers();
});

describe("workspace editor lease synchronization", () => {
  test("blocks authority immediately until the first exact sync is acknowledged", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    client.syncWorkspaceEditor.mockImplementationOnce(async (params) => {
      client.syncs.push(params);
      await syncGate;
      client.leaseSequence = params.sequence;
      return {
        accepted: true,
        sequence: params.sequence,
        expiresAt: 10_000,
        dirtyPaths: params.buffers
          .filter((buffer) => buffer.dirty)
          .map((buffer) => buffer.path),
        stalePaths: [],
      };
    });
    const authority = vi.fn();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      onAuthorityChange: authority,
      syncDebounceMs: 80,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.acquireWorkspaceEditor).toHaveBeenCalledTimes(1);
    expect(client.syncWorkspaceEditor).toHaveBeenCalledTimes(1);
    expect(authority).toHaveBeenCalledWith({ status: "securing" });
    expect(authority).not.toHaveBeenCalledWith({ status: "ready" });

    releaseSync();
    await vi.waitFor(() => {
      expect(authority).toHaveBeenCalledWith({ status: "ready" });
    });
    await synchronizer.stop();
  });

  test("restores authority after a provider reload preserves the exact manifest", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const authority = vi.fn();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      onAuthorityChange: authority,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(authority).toHaveBeenLastCalledWith({ status: "ready" });
    const syncCount = client.syncWorkspaceEditor.mock.calls.length;

    source.setProviderStatus("loading");
    expect(authority).toHaveBeenLastCalledWith({ status: "securing" });

    source.setProviderStatus("ready");
    await vi.advanceTimersByTimeAsync(0);

    expect(authority).toHaveBeenLastCalledWith({ status: "ready" });
    expect(client.syncWorkspaceEditor).toHaveBeenCalledTimes(syncCount);
    await synchronizer.stop();
  });

  test("hashes every exact capture and sends source only for dirty buffers", () => {
    const clean = workspaceBufferSync({
      path: "/workspace/clean.ts",
      bufferHandle: 1,
      changedtick: 4,
      dirty: false,
      content: "clean\n",
    });
    const dirty = workspaceBufferSync({
      path: "/workspace/dirty.ts",
      bufferHandle: 2,
      changedtick: 9,
      dirty: true,
      content: "unsaved\n",
    });

    expect(clean).toEqual({
      path: "/workspace/clean.ts",
      bufferHandle: 1,
      changedtick: 4,
      contentSha256: sha256("clean\n"),
      contentBytes: 6,
      dirty: false,
    });
    expect(dirty).toEqual({
      path: "/workspace/dirty.ts",
      bufferHandle: 2,
      changedtick: 9,
      contentSha256: sha256("unsaved\n"),
      contentBytes: 8,
      dirty: true,
      content: "unsaved\n",
    });
  });

  test("acquires once, syncs monotonic revisions, heartbeats, and releases conservatively", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 10,
      heartbeatMs: 100,
      retryMs: 20,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(10);

    expect(client.acquireWorkspaceEditor).toHaveBeenCalledTimes(1);
    expect(client.syncWorkspaceEditor).toHaveBeenCalledTimes(1);
    expect(client.syncs[0]).toMatchObject({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      leaseToken: "lease-1",
      epoch: 1,
      sequence: 0,
    });
    expect(client.syncs[0]?.buffers[0]).toMatchObject({
      path: "/workspace/file.ts",
      changedtick: 1,
      dirty: true,
      content: "const value = 1;\n",
    });

    // Cursor/grid redraws with the same buffer manifest do not recapture or
    // burn daemon sync sequence numbers.
    source.emit();
    await vi.advanceTimersByTimeAsync(10);
    expect(client.syncWorkspaceEditor).toHaveBeenCalledTimes(1);

    source.update({
      changedtick: 2,
      content: "const value = 2;\n",
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(client.syncWorkspaceEditor).toHaveBeenCalledTimes(2);
    expect(client.syncs[1]?.sequence).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(client.heartbeatWorkspaceEditor).toHaveBeenCalled();

    await synchronizer.stop();
    expect(client.releaseWorkspaceEditor).toHaveBeenCalledTimes(1);
    expect(client.releaseWorkspaceEditor).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseToken: "lease-1",
        epoch: 1,
        abandonDirty: false,
      }),
    );
  });

  test("does not silently take over a conflicting editor and retries safely", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    client.acquireWorkspaceEditor
      .mockRejectedValueOnce(
        new Error("workspace already has an authoritative editor"),
      )
      .mockResolvedValue(client.lease);
    const onError = vi.fn();
    const onAuthorityChange = vi.fn();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      onError,
      onAuthorityChange,
      syncDebounceMs: 0,
      retryMs: 20,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "workspace already has an authoritative editor",
      }),
    );
    expect(client.acquireWorkspaceEditor.mock.calls[0]?.[0]).not.toHaveProperty(
      "takeover",
    );
    expect(onAuthorityChange).toHaveBeenCalledWith({
      status: "blocked",
      reason: "workspace already has an authoritative editor",
    });

    await vi.advanceTimersByTimeAsync(40);
    expect(client.acquireWorkspaceEditor).toHaveBeenCalledTimes(2);
    expect(client.syncWorkspaceEditor).toHaveBeenCalledTimes(1);
    expect(onAuthorityChange).toHaveBeenLastCalledWith({ status: "ready" });

    await synchronizer.stop();
  });

  test("resumes after the daemon applies a sync whose response is lost", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    client.syncWorkspaceEditor.mockImplementationOnce(async (params) => {
      client.syncs.push(params);
      // Model a transport failure after the daemon committed sequence 0.
      client.leaseSequence = params.sequence;
      throw new Error("sync response lost");
    });
    const onError = vi.fn();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      onError,
      syncDebounceMs: 0,
      retryMs: 20,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.syncs.map((sync) => sync.sequence)).toEqual([0]);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "sync response lost" }),
    );

    await vi.advanceTimersByTimeAsync(40);
    expect(client.acquireWorkspaceEditor).toHaveBeenCalledTimes(2);
    expect(client.syncs.map((sync) => sync.sequence)).toEqual([0, 1]);

    await synchronizer.stop();
  });

  test("fails closed when reacquiring the current lease at a backward sequence", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const onError = vi.fn();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      onError,
      syncDebounceMs: 0,
      retryMs: 20,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.syncs.map((sync) => sync.sequence)).toEqual([0]);

    client.syncWorkspaceEditor.mockRejectedValueOnce(
      new Error("temporary sync transport failure"),
    );
    source.update({ changedtick: 2 });
    await vi.advanceTimersByTimeAsync(0);
    client.leaseSequence = -1;

    await vi.advanceTimersByTimeAsync(40);
    expect(client.acquireWorkspaceEditor).toHaveBeenCalledTimes(2);
    expect(client.syncWorkspaceEditor).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "The daemon editor lease sequence moved backward from 0 to -1 for the current lease.",
      }),
    );

    await expect(synchronizer.stop()).rejects.toThrow(
      "The daemon editor lease sequence moved backward from 0 to -1 for the current lease.",
    );
  });

  test("fails closed when acquire returns a malformed sequence", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    client.acquireWorkspaceEditor.mockResolvedValue({
      ...client.lease,
      sequence: -2,
    });
    const onError = vi.fn();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      onError,
      syncDebounceMs: 0,
      retryMs: 20,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.syncWorkspaceEditor).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "The daemon returned malformed editor lease sequence -2.",
      }),
    );
    await expect(synchronizer.stop()).rejects.toThrow(
      "The daemon returned malformed editor lease sequence -2.",
    );
  });

  test("releases and quarantines authority when Neovim closes", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    source.close();
    await vi.waitFor(() => {
      expect(client.releaseWorkspaceEditor).toHaveBeenCalledTimes(1);
    });
    expect(client.releaseWorkspaceEditor).toHaveBeenCalledWith(
      expect.objectContaining({ abandonDirty: false }),
    );

    await synchronizer.stop();
  });

  test("retains and renews authority while a live Neovim reports a preservation error", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    const heartbeatsBeforeFailure =
      client.heartbeatWorkspaceEditor.mock.calls.length;
    source.fail();
    await vi.advanceTimersByTimeAsync(100);

    expect(client.releaseWorkspaceEditor).not.toHaveBeenCalled();
    expect(client.heartbeatWorkspaceEditor.mock.calls.length).toBeGreaterThan(
      heartbeatsBeforeFailure,
    );
    await synchronizer.stop();
  });

  test("releases authority after a cleanup-confirmed Neovim startup error", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const authority = vi.fn();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      onAuthorityChange: authority,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    source.failSafely();
    await vi.waitFor(() => {
      expect(client.releaseWorkspaceEditor).toHaveBeenCalledTimes(1);
    });

    expect(authority).toHaveBeenCalledWith({ status: "not_required" });
    await synchronizer.stop();
  });

  test("synchronously refuses native :write while an Agent mutation is committing", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 80,
      retryMs: 20,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    source.update({
      changedtick: 2,
      content: "const value = 'native write';\n",
    });
    const committing = new Error(
      "Cannot synchronize /workspace/file.ts while an admitted workspace write is committing",
    );
    client.syncWorkspaceEditor.mockImplementationOnce(async (params) => {
      client.syncs.push(params);
      throw committing;
    });

    await expect(source.requestWorkspaceWrite()).resolves.toEqual({
      allowed: false,
      reason: committing.message,
    });
    expect(client.syncs.at(-1)).toMatchObject({
      sequence: 1,
      buffers: [
        expect.objectContaining({
          path: "/workspace/file.ts",
          changedtick: 2,
          dirty: true,
          content: "const value = 'native write';\n",
        }),
      ],
    });

    // Once the executing Agent write has settled, the exact same native
    // revision can acquire the lease again and receive synchronous authority.
    await expect(source.requestWorkspaceWrite()).resolves.toEqual({
      allowed: true,
    });
    await synchronizer.stop();
  });

  test("awaits the final exact dirty capture before provider cleanup", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 80,
      heartbeatMs: 100,
    });
    synchronizer.start();
    await vi.advanceTimersByTimeAsync(80);
    source.update({
      changedtick: 2,
      content: "const value = 2;\n",
    });

    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const originalCapture = source.captureWorkspaceBuffers.bind(source);
    vi.spyOn(source, "captureWorkspaceBuffers").mockImplementationOnce(
      async () => {
        await captureGate;
        return originalCapture();
      },
    );
    const cleanupProvider = vi.fn(async () => {});
    const teardown = createOrderedWorkspaceEditorTeardown(
      synchronizer,
      cleanupProvider,
    );

    const first = teardown();
    const second = teardown();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(cleanupProvider).not.toHaveBeenCalled();

    releaseCapture();
    await first;

    expect(client.syncs.at(-1)).toMatchObject({
      sequence: 1,
      buffers: [
        expect.objectContaining({
          changedtick: 2,
          content: "const value = 2;\n",
        }),
      ],
    });
    expect(client.releaseWorkspaceEditor).toHaveBeenCalledTimes(1);
    expect(cleanupProvider).toHaveBeenCalledTimes(1);
  });

  test("leaves the provider alive when final lease synchronization fails", async () => {
    const leaseFailure = new Error("final editor sync failed");
    const synchronizer = {
      prepareStop: vi.fn(async () => {
        throw leaseFailure;
      }),
      stop: vi.fn(async () => {
        throw leaseFailure;
      }),
    };
    const cleanupProvider = vi.fn(async () => {});
    const teardown = createOrderedWorkspaceEditorTeardown(
      synchronizer,
      cleanupProvider,
    );

    await expect(teardown()).rejects.toBe(leaseFailure);
    expect(synchronizer.prepareStop).toHaveBeenCalledTimes(1);
    expect(synchronizer.stop).not.toHaveBeenCalled();
    expect(cleanupProvider).not.toHaveBeenCalled();
  });

  test("leaves the provider alive when the final exact dirty capture fails", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 80,
      heartbeatMs: 100,
    });
    synchronizer.start();
    await vi.advanceTimersByTimeAsync(80);
    source.update({
      changedtick: 2,
      content: "const latest = 'not yet synchronized';\n",
    });
    const captureFailure = new Error("final editor capture failed");
    vi.spyOn(source, "captureWorkspaceBuffers").mockRejectedValueOnce(
      captureFailure,
    );
    const cleanupProvider = vi.fn(async () => {});
    const teardown = createOrderedWorkspaceEditorTeardown(
      synchronizer,
      cleanupProvider,
    );

    await expect(teardown()).rejects.toBe(captureFailure);
    expect(client.releaseWorkspaceEditor).not.toHaveBeenCalled();
    expect(cleanupProvider).not.toHaveBeenCalled();
  });

  test("leaves the provider alive when final dirty synchronization fails", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 80,
      heartbeatMs: 100,
    });
    synchronizer.start();
    await vi.advanceTimersByTimeAsync(80);
    source.update({
      changedtick: 2,
      content: "const latest = 'daemon unavailable';\n",
    });
    const syncFailure = new Error("final editor sync failed");
    client.syncWorkspaceEditor.mockRejectedValueOnce(syncFailure);
    const cleanupProvider = vi.fn(async () => {});
    const teardown = createOrderedWorkspaceEditorTeardown(
      synchronizer,
      cleanupProvider,
    );

    await expect(teardown()).rejects.toBe(syncFailure);
    expect(client.releaseWorkspaceEditor).not.toHaveBeenCalled();
    expect(cleanupProvider).not.toHaveBeenCalled();
  });

  test("retains the synchronized lease when provider recovery cleanup fails", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });
    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    source.update({
      changedtick: 2,
      content: "const latest = 'recovery must remain owned';\n",
    });
    await vi.advanceTimersByTimeAsync(0);
    const cleanupFailure = new Error("recovery preservation unproven");
    const cleanupProvider = vi.fn(async () => {
      throw cleanupFailure;
    });
    const teardown = createOrderedWorkspaceEditorTeardown(
      synchronizer,
      cleanupProvider,
    );

    const heartbeatsBeforeFailure =
      client.heartbeatWorkspaceEditor.mock.calls.length;
    await expect(teardown()).rejects.toBe(cleanupFailure);
    expect(client.syncs.at(-1)?.buffers).toEqual([
      expect.objectContaining({
        changedtick: 2,
        content: "const latest = 'recovery must remain owned';\n",
      }),
    ]);
    expect(client.releaseWorkspaceEditor).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(client.heartbeatWorkspaceEditor.mock.calls.length).toBeGreaterThan(
      heartbeatsBeforeFailure,
    );
  });

  test("retries ordered provider cleanup after recovery preservation becomes available", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });
    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    const preservationFailure = new Error(
      "recovery preservation could not be proven",
    );
    const cleanupProvider = vi
      .fn()
      .mockRejectedValueOnce(preservationFailure)
      .mockResolvedValueOnce(undefined);
    const teardown = createOrderedWorkspaceEditorTeardown(
      synchronizer,
      cleanupProvider,
    );

    await expect(teardown()).rejects.toBe(preservationFailure);
    expect(client.releaseWorkspaceEditor).not.toHaveBeenCalled();

    await expect(teardown()).resolves.toBeUndefined();
    expect(cleanupProvider).toHaveBeenCalledTimes(2);
    expect(client.releaseWorkspaceEditor).toHaveBeenCalledTimes(1);

    // Completion remains idempotent after the successful retry.
    await expect(teardown()).resolves.toBeUndefined();
    expect(cleanupProvider).toHaveBeenCalledTimes(2);
  });

  test("reports lease release failure only after provider cleanup succeeds", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 80,
      heartbeatMs: 100,
    });
    synchronizer.start();
    await vi.advanceTimersByTimeAsync(80);
    source.update({
      changedtick: 2,
      content: "const latest = 'release unconfirmed';\n",
    });
    const releaseFailure = new Error("final editor release failed");
    client.releaseWorkspaceEditor.mockRejectedValueOnce(releaseFailure);
    const cleanupProvider = vi.fn(async () => {});
    const teardown = createOrderedWorkspaceEditorTeardown(
      synchronizer,
      cleanupProvider,
    );

    await expect(teardown()).rejects.toBe(releaseFailure);
    expect(client.syncs.at(-1)?.buffers).toEqual([
      expect.objectContaining({
        changedtick: 2,
        content: "const latest = 'release unconfirmed';\n",
      }),
    ]);
    expect(cleanupProvider).toHaveBeenCalledTimes(1);
    expect(cleanupProvider.mock.invocationCallOrder[0]).toBeLessThan(
      client.releaseWorkspaceEditor.mock.invocationCallOrder[0]!,
    );

    await expect(teardown()).resolves.toBeUndefined();
    expect(client.acquireWorkspaceEditor).toHaveBeenCalledTimes(2);
    expect(client.releaseWorkspaceEditor).toHaveBeenCalledTimes(2);
    expect(cleanupProvider).toHaveBeenCalledTimes(1);

    await expect(teardown()).resolves.toBeUndefined();
    expect(client.releaseWorkspaceEditor).toHaveBeenCalledTimes(2);
  });

  test("reacquires and synchronizes the latest dirty revision during stop", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 0,
      retryMs: 1_000,
      heartbeatMs: 10_000,
    });
    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    const transientFailure = new Error("ordinary sync failed");
    client.syncWorkspaceEditor.mockRejectedValueOnce(transientFailure);
    source.update({
      changedtick: 2,
      content: "const latest = 'reacquired';\n",
    });
    await vi.advanceTimersByTimeAsync(0);
    const cleanupProvider = vi.fn(async () => {});
    const teardown = createOrderedWorkspaceEditorTeardown(
      synchronizer,
      cleanupProvider,
    );

    await expect(teardown()).resolves.toBeUndefined();
    expect(client.acquireWorkspaceEditor).toHaveBeenCalledTimes(2);
    expect(client.syncs.at(-1)?.buffers).toEqual([
      expect.objectContaining({
        changedtick: 2,
        content: "const latest = 'reacquired';\n",
      }),
    ]);
    expect(cleanupProvider).toHaveBeenCalledTimes(1);
  });

  test("keeps rejected teardown registered for the awaitable shutdown barrier", async () => {
    const failure = new Error("provider cleanup failed");
    const barrier = new TuiTeardownBarrier();
    let rejection: Promise<void> | null = null;
    const teardown = vi.fn(() => (rejection ??= Promise.reject(failure)));
    const unregister = barrier.register(teardown);

    await expect(
      settleWorkspaceEditorTeardown(teardown, unregister),
    ).resolves.toBeUndefined();
    await expect(barrier.drain()).rejects.toBe(failure);
    expect(teardown).toHaveBeenCalledTimes(2);
  });

  test("unregisters a successfully settled teardown during React disposal", async () => {
    const unregister = vi.fn(() => {
      throw new Error("registration already removed");
    });

    await expect(
      settleWorkspaceEditorTeardown(() => Promise.resolve(), unregister),
    ).resolves.toBeUndefined();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  test("manifest signatures ignore cursor-only redraws but include exact-byte identity", () => {
    const source = new FakeBufferSource();
    const first = workspaceBufferManifestSignature(source.getSnapshot());
    source.moveCursor();
    expect(workspaceBufferManifestSignature(source.getSnapshot())).toBe(first);
    source.update({ changedtick: 2 });
    expect(workspaceBufferManifestSignature(source.getSnapshot())).not.toBe(
      first,
    );
    const changedtickSignature = workspaceBufferManifestSignature(
      source.getSnapshot(),
    );
    source.update({ endOfLine: false });
    expect(workspaceBufferManifestSignature(source.getSnapshot())).not.toBe(
      changedtickSignature,
    );
  });

  test("reviews a dirty-buffer Agent mutation in the editor and acknowledges the exact applied revision", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    const proposal =
      await synchronizer.inspectWorkspaceMutationProposal("proposal-1");
    expect(client.getWorkspaceEditorProposal).toHaveBeenCalledWith({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      leaseToken: "lease-1",
      epoch: 1,
      proposalId: "proposal-1",
    });

    const editorProposalId = "workspace-mutation:proposal-1:1";
    await expect(
      synchronizer.acceptWorkspaceMutationProposal({
        proposal,
        editorProposalId,
        acceptEditor: async () => {
          const changedtick = source.apply("const value = 2;\n");
          return {
            ok: true,
            action: "accepted",
            proposalId: editorProposalId,
            changedtick,
          };
        },
      }),
    ).resolves.toEqual({
      ok: true,
      action: "accepted",
      proposalId: editorProposalId,
      changedtick: 2,
    });
    expect(client.applyWorkspaceEditorProposal).toHaveBeenCalledWith({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      leaseToken: "lease-1",
      epoch: 1,
      proposalId: "proposal-1",
      changedtick: 2,
      contentSha256: sha256("const value = 2;\n"),
      content: "const value = 2;\n",
    });

    await synchronizer.stop();
  });

  test("acknowledges the exact accepted pair when the live buffer advances before the daemon reply", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    const proposal =
      await synchronizer.inspectWorkspaceMutationProposal("proposal-1");
    const editorProposalId = "workspace-mutation:proposal-1:1";

    await expect(
      synchronizer.acceptWorkspaceMutationProposal({
        proposal,
        editorProposalId,
        acceptEditor: async () => {
          const acceptedChangedtick = source.apply(proposal.afterText);
          source.apply("const value = 3;\n");
          return {
            ok: true,
            action: "accepted",
            proposalId: editorProposalId,
            changedtick: acceptedChangedtick,
          };
        },
      }),
    ).resolves.toEqual({
      ok: true,
      action: "accepted",
      proposalId: editorProposalId,
      changedtick: 2,
    });
    expect(client.applyWorkspaceEditorProposal).toHaveBeenCalledWith({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      leaseToken: "lease-1",
      epoch: 1,
      proposalId: "proposal-1",
      changedtick: 2,
      contentSha256: sha256(proposal.afterText),
      content: proposal.afterText,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.syncWorkspaceEditor).toHaveBeenLastCalledWith(
      expect.objectContaining({
        buffers: [
          expect.objectContaining({
            changedtick: 3,
            content: "const value = 3;\n",
          }),
        ],
      }),
    );
    await synchronizer.stop();
  });

  test.each([
    {
      name: "a different proposal id",
      proposalId: "workspace-mutation:other-proposal:1",
      changedtick: 2,
    },
    {
      name: "a non-advancing changedtick",
      proposalId: "workspace-mutation:proposal-1:1",
      changedtick: 1,
    },
  ])(
    "rejects an accepted provider result with $name before daemon acknowledgement",
    async ({ proposalId, changedtick }) => {
      vi.useFakeTimers();
      const source = new FakeBufferSource();
      const client = new FakeLeaseClient();
      const synchronizer = new WorkspaceEditorLeaseSynchronizer({
        workspaceRoot: WORKSPACE,
        editorInstanceId: EDITOR_ID,
        client,
        buffers: source,
        syncDebounceMs: 0,
        heartbeatMs: 100,
      });

      synchronizer.start();
      await vi.advanceTimersByTimeAsync(0);
      const proposal =
        await synchronizer.inspectWorkspaceMutationProposal("proposal-1");
      const editorProposalId = "workspace-mutation:proposal-1:1";
      const invalid = await synchronizer.acceptWorkspaceMutationProposal({
        proposal,
        editorProposalId,
        acceptEditor: async () => ({
          ok: true,
          action: "accepted",
          proposalId,
          changedtick,
        }),
      });
      expect(invalid).toMatchObject({
        ok: false,
        reason: expect.stringContaining("invalid accepted proposal revision"),
      });
      expect(invalid).not.toMatchObject({ stale: true });
      expect(client.applyWorkspaceEditorProposal).not.toHaveBeenCalled();

      await expect(
        synchronizer.rejectWorkspaceMutationProposal({
          proposal,
          editorProposalId,
          rejectEditor: async () => ({
            ok: true,
            action: "rejected",
            proposalId: editorProposalId,
          }),
        }),
      ).resolves.toMatchObject({ ok: true, action: "rejected" });
      expect(client.discardWorkspaceEditorProposal).toHaveBeenCalledTimes(1);
      await synchronizer.stop();
    },
  );

  test("rejects a rejected provider result for a different proposal before daemon acknowledgement", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    const proposal =
      await synchronizer.inspectWorkspaceMutationProposal("proposal-1");
    const editorProposalId = "workspace-mutation:proposal-1:1";
    const invalid = await synchronizer.rejectWorkspaceMutationProposal({
      proposal,
      editorProposalId,
      rejectEditor: async () => ({
        ok: true,
        action: "rejected",
        proposalId: "workspace-mutation:other-proposal:1",
      }),
    });
    expect(invalid).toMatchObject({
      ok: false,
      reason: expect.stringContaining("invalid rejected proposal result"),
    });
    expect(invalid).not.toMatchObject({ stale: true });
    expect(client.discardWorkspaceEditorProposal).not.toHaveBeenCalled();

    await expect(
      synchronizer.acceptWorkspaceMutationProposal({
        proposal,
        editorProposalId,
        acceptEditor: async () => ({
          ok: true,
          action: "accepted",
          proposalId: editorProposalId,
          changedtick: 2,
        }),
      }),
    ).resolves.toMatchObject({ ok: true, action: "accepted" });
    expect(client.applyWorkspaceEditorProposal).toHaveBeenCalledTimes(1);
    await synchronizer.stop();
  });

  test("retains an accepted outcome until a discriminator-valid daemon acknowledgement", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    client.applyWorkspaceEditorProposal.mockResolvedValueOnce({
      applied: false,
      proposalId: "proposal-1",
      path: "/workspace/file.ts",
      changedtick: 2,
      contentSha256: sha256("const value = 2;\n"),
    } as never);
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    const proposal =
      await synchronizer.inspectWorkspaceMutationProposal("proposal-1");
    const editorProposalId = "workspace-mutation:proposal-1:1";
    const acceptEditor = vi.fn(async () => ({
      ok: true as const,
      action: "accepted" as const,
      proposalId: editorProposalId,
      changedtick: source.apply(proposal.afterText),
    }));
    await expect(
      synchronizer.acceptWorkspaceMutationProposal({
        proposal,
        editorProposalId,
        acceptEditor,
      }),
    ).resolves.toMatchObject({
      ok: false,
      acknowledgementPending: true,
      acknowledgementAction: "accept",
      reason: expect.stringContaining("malformed"),
    });

    await expect(
      synchronizer.acceptWorkspaceMutationProposal({
        proposal,
        editorProposalId,
        acceptEditor,
      }),
    ).resolves.toMatchObject({ ok: true, action: "accepted" });
    expect(acceptEditor).toHaveBeenCalledTimes(1);
    expect(client.applyWorkspaceEditorProposal).toHaveBeenCalledTimes(2);
    await synchronizer.stop();
  });

  test("retains a rejected outcome until a discriminator-valid daemon acknowledgement", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    client.discardWorkspaceEditorProposal.mockResolvedValueOnce({
      discarded: false,
      proposalId: "proposal-1",
      path: "/workspace/file.ts",
    } as never);
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    const proposal =
      await synchronizer.inspectWorkspaceMutationProposal("proposal-1");
    const editorProposalId = "workspace-mutation:proposal-1:1";
    const rejectEditor = vi.fn(async () => ({
      ok: true as const,
      action: "rejected" as const,
      proposalId: editorProposalId,
    }));
    await expect(
      synchronizer.rejectWorkspaceMutationProposal({
        proposal,
        editorProposalId,
        rejectEditor,
      }),
    ).resolves.toMatchObject({
      ok: false,
      acknowledgementPending: true,
      acknowledgementAction: "reject",
      reason: expect.stringContaining("malformed"),
    });

    await expect(
      synchronizer.rejectWorkspaceMutationProposal({
        proposal,
        editorProposalId,
        rejectEditor,
      }),
    ).resolves.toMatchObject({ ok: true, action: "rejected" });
    expect(rejectEditor).toHaveBeenCalledTimes(1);
    expect(client.discardWorkspaceEditorProposal).toHaveBeenCalledTimes(2);
    await synchronizer.stop();
  });

  test("validates a direct recovery discard acknowledgement before dismissing it", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    client.discardWorkspaceEditorProposal
      .mockResolvedValueOnce({
        discarded: false,
        proposalId: "proposal-1",
        path: "/workspace/file.ts",
      } as never)
      .mockResolvedValueOnce({
        discarded: true,
        proposalId: "other-proposal",
        path: "/workspace/file.ts",
      })
      .mockResolvedValueOnce({
        discarded: true,
        proposalId: "proposal-1",
        path: "/workspace/other.ts",
      });
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    await expect(
      synchronizer.discardWorkspaceMutationProposal(
        "proposal-1",
        "/workspace/file.ts",
      ),
    ).rejects.toThrow("malformed");
    await expect(
      synchronizer.discardWorkspaceMutationProposal(
        "proposal-1",
        "/workspace/file.ts",
      ),
    ).rejects.toThrow("malformed");
    await expect(
      synchronizer.discardWorkspaceMutationProposal(
        "proposal-1",
        "/workspace/file.ts",
      ),
    ).rejects.toThrow("malformed");
    await expect(
      synchronizer.discardWorkspaceMutationProposal(
        "proposal-1",
        "/workspace/file.ts",
      ),
    ).resolves.toBeUndefined();
    expect(client.discardWorkspaceEditorProposal).toHaveBeenCalledTimes(4);
    await synchronizer.stop();
  });

  test("retries only daemon acknowledgement after an applied response is lost", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    client.applyWorkspaceEditorProposal.mockImplementationOnce(async () => {
      // The daemon committed, but the transport dropped its response.
      throw new Error("apply response lost");
    });
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    const proposal =
      await synchronizer.inspectWorkspaceMutationProposal("proposal-1");
    const editorProposalId = "workspace-mutation:proposal-1:1";
    const acceptEditor = vi.fn(async () => {
      const changedtick = source.apply("const value = 2;\n");
      return {
        ok: true as const,
        action: "accepted" as const,
        proposalId: editorProposalId,
        changedtick,
      };
    });

    await expect(
      synchronizer.acceptWorkspaceMutationProposal({
        proposal,
        editorProposalId,
        acceptEditor,
      }),
    ).resolves.toMatchObject({
      ok: false,
      acknowledgementPending: true,
      reason: expect.stringContaining("apply response lost"),
    });
    expect(acceptEditor).toHaveBeenCalledTimes(1);
    expect(client.syncWorkspaceEditor).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(client.syncWorkspaceEditor).toHaveBeenCalledTimes(1);

    const rejectEditor = vi.fn();
    await expect(
      synchronizer.rejectWorkspaceMutationProposal({
        proposal,
        editorProposalId,
        rejectEditor,
      }),
    ).resolves.toMatchObject({
      ok: false,
      acknowledgementPending: true,
      reason: expect.stringContaining("Reject is no longer safe"),
    });
    expect(rejectEditor).not.toHaveBeenCalled();
    expect(client.discardWorkspaceEditorProposal).not.toHaveBeenCalled();

    await expect(
      synchronizer.acceptWorkspaceMutationProposal({
        proposal,
        editorProposalId,
        acceptEditor,
      }),
    ).resolves.toMatchObject({
      ok: true,
      action: "accepted",
      changedtick: 2,
    });
    expect(acceptEditor).toHaveBeenCalledTimes(1);
    expect(client.applyWorkspaceEditorProposal).toHaveBeenCalledTimes(2);
    expect(client.applyWorkspaceEditorProposal.mock.calls[1]?.[0]).toEqual(
      client.applyWorkspaceEditorProposal.mock.calls[0]?.[0],
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(client.syncWorkspaceEditor).toHaveBeenCalledTimes(2);
    await synchronizer.stop();
  });

  test("adopts an exact accepted outcome in a replacement synchronizer after reconnect", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const firstClient = new FakeLeaseClient();
    firstClient.applyWorkspaceEditorProposal.mockRejectedValueOnce(
      new Error("apply response lost"),
    );
    const first = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client: firstClient,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    first.start();
    await vi.advanceTimersByTimeAsync(0);
    const proposal = await first.inspectWorkspaceMutationProposal("proposal-1");
    const editorProposalId = "workspace-mutation:proposal-1:1";
    const mutateEditor = vi.fn(async () => {
      const changedtick = source.apply("const value = 2;\n");
      return {
        ok: true as const,
        action: "accepted" as const,
        proposalId: editorProposalId,
        changedtick,
      };
    });
    const firstResult = await first.acceptWorkspaceMutationProposal({
      proposal,
      editorProposalId,
      acceptEditor: mutateEditor,
    });
    expect(firstResult).toMatchObject({
      ok: false,
      acknowledgementPending: true,
      acknowledgementAction: "accept",
    });
    expect(mutateEditor).toHaveBeenCalledTimes(1);

    const acceptedOutcome = {
      ok: true as const,
      action: "accepted" as const,
      proposalId: editorProposalId,
      changedtick: 2,
    };
    const adoptAcceptedOutcome = vi.fn(async () => acceptedOutcome);
    const replacementClient = new FakeLeaseClient();
    const replacement = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client: replacementClient,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });
    replacement.start();
    await vi.advanceTimersByTimeAsync(0);

    await expect(
      replacement.acceptWorkspaceMutationProposal({
        proposal,
        editorProposalId,
        acceptEditor: adoptAcceptedOutcome,
      }),
    ).resolves.toEqual(acceptedOutcome);
    expect(adoptAcceptedOutcome).toHaveBeenCalledTimes(1);
    expect(replacementClient.applyWorkspaceEditorProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: "proposal-1",
        changedtick: 2,
        contentSha256: sha256("const value = 2;\n"),
        content: "const value = 2;\n",
      }),
    );
    expect(mutateEditor).toHaveBeenCalledTimes(1);

    await replacement.stop();
    await first.stop();
  });

  test("clears the Neovim shadow before discarding the daemon proposal", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    const proposal =
      await synchronizer.inspectWorkspaceMutationProposal("proposal-1");
    const editorProposalId = "workspace-mutation:proposal-1:1";
    await expect(
      synchronizer.rejectWorkspaceMutationProposal({
        proposal,
        editorProposalId,
        rejectEditor: async () => ({
          ok: true,
          action: "rejected",
          proposalId: editorProposalId,
        }),
      }),
    ).resolves.toEqual({
      ok: true,
      action: "rejected",
      proposalId: editorProposalId,
    });
    expect(client.discardWorkspaceEditorProposal).toHaveBeenCalledWith({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      leaseToken: "lease-1",
      epoch: 1,
      proposalId: "proposal-1",
    });

    await synchronizer.stop();
  });

  test("retries only daemon discard acknowledgement after its response is lost", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    client.discardWorkspaceEditorProposal.mockImplementationOnce(async () => {
      // The daemon committed the discard, but the transport lost its reply.
      throw new Error("discard response lost");
    });
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    const proposal =
      await synchronizer.inspectWorkspaceMutationProposal("proposal-1");
    const editorProposalId = "workspace-mutation:proposal-1:1";
    const rejectEditor = vi.fn(async () => ({
      ok: true as const,
      action: "rejected" as const,
      proposalId: editorProposalId,
    }));

    await expect(
      synchronizer.rejectWorkspaceMutationProposal({
        proposal,
        editorProposalId,
        rejectEditor,
      }),
    ).resolves.toMatchObject({
      ok: false,
      acknowledgementPending: true,
      acknowledgementAction: "reject",
      reason: expect.stringContaining("discard response lost"),
    });
    expect(rejectEditor).toHaveBeenCalledTimes(1);
    expect(client.syncWorkspaceEditor).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(client.syncWorkspaceEditor).toHaveBeenCalledTimes(1);

    const acceptEditor = vi.fn();
    await expect(
      synchronizer.acceptWorkspaceMutationProposal({
        proposal,
        editorProposalId,
        acceptEditor,
      }),
    ).resolves.toMatchObject({
      ok: false,
      acknowledgementPending: true,
      acknowledgementAction: "reject",
      reason: expect.stringContaining("Accept is no longer safe"),
    });
    expect(acceptEditor).not.toHaveBeenCalled();
    expect(client.applyWorkspaceEditorProposal).not.toHaveBeenCalled();

    await expect(
      synchronizer.rejectWorkspaceMutationProposal({
        proposal,
        editorProposalId,
        rejectEditor,
      }),
    ).resolves.toEqual({
      ok: true,
      action: "rejected",
      proposalId: editorProposalId,
    });
    expect(rejectEditor).toHaveBeenCalledTimes(1);
    expect(client.discardWorkspaceEditorProposal).toHaveBeenCalledTimes(2);
    expect(client.discardWorkspaceEditorProposal.mock.calls[1]?.[0]).toEqual(
      client.discardWorkspaceEditorProposal.mock.calls[0]?.[0],
    );

    await synchronizer.stop();
  });

  test("adopts an exact rejected outcome in a replacement synchronizer after reconnect", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const firstClient = new FakeLeaseClient();
    firstClient.discardWorkspaceEditorProposal.mockRejectedValueOnce(
      new Error("discard response lost"),
    );
    const first = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client: firstClient,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    first.start();
    await vi.advanceTimersByTimeAsync(0);
    const proposal = await first.inspectWorkspaceMutationProposal("proposal-1");
    const editorProposalId = "workspace-mutation:proposal-1:1";
    const rejectEditor = vi.fn(async () => ({
      ok: true as const,
      action: "rejected" as const,
      proposalId: editorProposalId,
    }));
    const firstResult = await first.rejectWorkspaceMutationProposal({
      proposal,
      editorProposalId,
      rejectEditor,
    });
    expect(firstResult).toMatchObject({
      ok: false,
      acknowledgementPending: true,
      acknowledgementAction: "reject",
    });
    expect(rejectEditor).toHaveBeenCalledTimes(1);

    const rejectedOutcome = {
      ok: true as const,
      action: "rejected" as const,
      proposalId: editorProposalId,
    };
    const adoptRejectedOutcome = vi.fn(async () => rejectedOutcome);
    const replacementClient = new FakeLeaseClient();
    const replacement = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client: replacementClient,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });
    replacement.start();
    await vi.advanceTimersByTimeAsync(0);

    await expect(
      replacement.rejectWorkspaceMutationProposal({
        proposal,
        editorProposalId,
        rejectEditor: adoptRejectedOutcome,
      }),
    ).resolves.toEqual(rejectedOutcome);
    expect(adoptRejectedOutcome).toHaveBeenCalledTimes(1);
    expect(
      replacementClient.discardWorkspaceEditorProposal,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: "proposal-1" }),
    );
    expect(rejectEditor).toHaveBeenCalledTimes(1);

    await replacement.stop();
    await first.stop();
  });

  test("delivers applied and audit-unknown disk writes from the change cursor", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    client.changes = [
      {
        sequence: 1,
        timestamp: "2026-07-29T00:00:00.000Z",
        workspaceRoot: WORKSPACE,
        path: "/workspace/file.ts",
        source: "file_edit",
        status: "applied",
        beforeSha256: "a".repeat(64),
        afterSha256: "b".repeat(64),
      },
      {
        sequence: 2,
        timestamp: "2026-07-29T00:00:01.000Z",
        workspaceRoot: WORKSPACE,
        path: "/workspace/uncertain.ts",
        source: "apply_patch",
        status: "unknown_outcome",
        beforeSha256: "c".repeat(64),
        afterSha256: "d".repeat(64),
      },
    ];
    const onWorkspaceChange = vi.fn();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      onWorkspaceChange,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(onWorkspaceChange).toHaveBeenNthCalledWith(1, client.changes[0]);
    expect(onWorkspaceChange).toHaveBeenNthCalledWith(2, client.changes[1]);
    expect(client.listWorkspaceEditorChanges).toHaveBeenCalledWith({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      leaseToken: "lease-1",
      epoch: 1,
      afterSequence: 0,
    });
    await synchronizer.stop();
  });

  test("inspects a durable proposal during sync and advances only after UI representation", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    client.changes = [
      {
        sequence: 1,
        timestamp: "2026-07-29T00:00:00.000Z",
        workspaceRoot: WORKSPACE,
        path: "/workspace/file.ts",
        source: "file_edit",
        status: "proposed",
        beforeSha256: "a".repeat(64),
        afterSha256: "b".repeat(64),
        proposalId: "proposal-1",
      },
    ];
    let markRepresented: () => void = () => {};
    const represented = new Promise<void>((resolve) => {
      markRepresented = resolve;
    });
    let synchronizer!: WorkspaceEditorLeaseSynchronizer;
    const onWorkspaceChange = vi.fn(
      async (change: WorkspaceEditorChangeResult) => {
        await synchronizer.inspectWorkspaceMutationProposal(change.proposalId!);
        await represented;
      },
    );
    synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      onWorkspaceChange,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);

    // Inspection must not deadlock by waiting on the same synchronization
    // whose durable change callback is doing the inspection.
    expect(client.getWorkspaceEditorProposal).toHaveBeenCalledTimes(1);
    expect(client.listWorkspaceEditorChanges).toHaveBeenLastCalledWith(
      expect.objectContaining({ afterSequence: 0 }),
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(client.listWorkspaceEditorChanges).toHaveBeenCalledTimes(1);
    expect(
      client.heartbeatWorkspaceEditor.mock.calls.length,
    ).toBeGreaterThanOrEqual(4);
    expect(client.acquireWorkspaceEditor).toHaveBeenCalledTimes(1);

    markRepresented();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);

    expect(client.listWorkspaceEditorChanges).toHaveBeenLastCalledWith(
      expect.objectContaining({ afterSequence: 1 }),
    );
    await synchronizer.stop();
  });

  test("resets a stale high change cursor after daemon restart", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const beforeRestart: WorkspaceEditorChangeResult = {
      sequence: 5,
      timestamp: "2026-07-29T00:00:00.000Z",
      workspaceRoot: WORKSPACE,
      path: "/workspace/old.ts",
      source: "file_edit",
      status: "applied",
      beforeSha256: "a".repeat(64),
      afterSha256: "b".repeat(64),
    };
    const afterRestart: WorkspaceEditorChangeResult = {
      sequence: 1,
      timestamp: "2026-07-29T00:00:01.000Z",
      workspaceRoot: WORKSPACE,
      path: "/workspace/new.ts",
      source: "file_write",
      status: "applied",
      beforeSha256: "c".repeat(64),
      afterSha256: "d".repeat(64),
    };
    let restarted = false;
    client.listWorkspaceEditorChanges.mockImplementation(async (params) => {
      if (!restarted) {
        return { sequence: 5, changes: [beforeRestart] };
      }
      return params.afterSequence === 0
        ? { sequence: 1, changes: [afterRestart] }
        : { sequence: 1, changes: [] };
    });
    const onWorkspaceChange = vi.fn();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      onWorkspaceChange,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onWorkspaceChange).toHaveBeenCalledWith(beforeRestart);
    onWorkspaceChange.mockClear();
    client.listWorkspaceEditorChanges.mockClear();
    restarted = true;

    await vi.advanceTimersByTimeAsync(100);

    expect(client.listWorkspaceEditorChanges).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ afterSequence: 5 }),
    );
    expect(client.listWorkspaceEditorChanges).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ afterSequence: 0 }),
    );
    expect(onWorkspaceChange).toHaveBeenCalledWith(afterRestart);
    await synchronizer.stop();
  });

  test("does not advance the change cursor when reload handling fails", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const change: WorkspaceEditorChangeResult = {
      sequence: 1,
      timestamp: "2026-07-29T00:00:00.000Z",
      workspaceRoot: WORKSPACE,
      path: "/workspace/retry.ts",
      source: "file_write",
      status: "applied",
      beforeSha256: "a".repeat(64),
      afterSha256: "b".repeat(64),
    };
    client.changes = [change];
    const onWorkspaceChange = vi
      .fn()
      .mockRejectedValueOnce(new Error("reload failed"))
      .mockResolvedValue(undefined);
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      onWorkspaceChange,
      syncDebounceMs: 0,
      retryMs: 25,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onWorkspaceChange).toHaveBeenCalledTimes(1);
    expect(client.listWorkspaceEditorChanges).toHaveBeenLastCalledWith(
      expect.objectContaining({ afterSequence: 0 }),
    );

    source.update({ changedtick: 2 });
    await vi.advanceTimersByTimeAsync(0);

    expect(onWorkspaceChange).toHaveBeenCalledTimes(2);
    expect(client.listWorkspaceEditorChanges).toHaveBeenLastCalledWith(
      expect.objectContaining({ afterSequence: 0 }),
    );
    await synchronizer.stop();
  });

  test("holds ordinary syncs while a topology fence is active and finalizes with the exact post-Neovim manifest", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });
    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);

    const transaction = await synchronizer.beginTopologyMutation([
      {
        path: "/workspace/file.ts",
        allowOwnedClean: true,
      },
      {
        path: "/workspace/renamed.ts",
      },
    ]);
    const syncCountAtReservation = client.syncWorkspaceEditor.mock.calls.length;
    expect(client.reserveWorkspaceEditorTopology).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: WORKSPACE,
        targets: [
          {
            path: "/workspace/file.ts",
            allowOwnedClean: true,
          },
          {
            path: "/workspace/renamed.ts",
          },
        ],
      }),
    );

    source.update({ changedtick: 2, content: "const value = 2;\n" });
    await vi.advanceTimersByTimeAsync(500);
    expect(client.syncWorkspaceEditor).toHaveBeenCalledTimes(
      syncCountAtReservation,
    );

    await transaction.complete("applied");
    expect(client.completeWorkspaceEditorTopology).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: "topology-1",
        status: "applied",
        sequence: client.leaseSequence,
        buffers: [
          expect.objectContaining({
            path: "/workspace/file.ts",
            changedtick: 2,
            content: "const value = 2;\n",
          }),
        ],
      }),
    );
    await synchronizer.stop();
  });

  test("blocks on discovered crash fences until the user explicitly records an unknown outcome", async () => {
    vi.useFakeTimers();
    const source = new FakeBufferSource();
    const client = new FakeLeaseClient();
    client.recoveredTopologies = [
      {
        tokenId: "recovered-topology-1",
        workspaceRoot: WORKSPACE,
        targets: [
          {
            path: "/workspace/renamed",
            includeDescendants: true,
          },
        ],
        source: "editor",
        createdAt: 123,
      },
    ];
    const authority = vi.fn();
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      client,
      buffers: source,
      onAuthorityChange: authority,
      syncDebounceMs: 0,
      heartbeatMs: 100,
    });

    synchronizer.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.syncWorkspaceEditor).not.toHaveBeenCalled();
    expect(authority).toHaveBeenLastCalledWith({
      status: "blocked",
      reason: expect.stringMatching(/interrupted Editor rename or delete/u),
      recoveredTopologyMutations: client.recoveredTopologies,
    });
    await expect(source.requestWorkspaceWrite()).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/operation is still settling/u),
    });

    await synchronizer.resolveRecoveredTopologyMutation("recovered-topology-1");

    expect(client.resolveRecoveredWorkspaceEditorTopology).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: "recovered-topology-1",
        leaseToken: "lease-1",
        epoch: 1,
      }),
    );
    expect(client.syncWorkspaceEditor).toHaveBeenCalledTimes(1);
    expect(authority).toHaveBeenLastCalledWith({ status: "ready" });
    await synchronizer.stop();
  });
});

class FakeBufferSource implements WorkspaceEditorBufferSource {
  readonly #listeners = new Set<() => void>();
  #changedtick = 1;
  #content = "const value = 1;\n";
  #endOfLine = true;
  #status: BufferProviderSnapshot["providerStatus"] = "ready";
  #workspaceAuthorityRequired = true;
  #workspaceWriteAuthorityHandler: BufferWorkspaceWriteAuthorityHandler | null =
    null;
  #column = 1;

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getSnapshot(): BufferProviderSnapshot {
    const base = emptyProviderSnapshot({
      kind: "neovim",
      label: "embedded Neovim",
      fallbackReason: null,
      capabilities: NEOVIM_BUFFER_CAPABILITIES,
    });
    return {
      ...base,
      providerStatus: this.#status,
      workspaceAuthorityRequired: this.#workspaceAuthorityRequired,
      position: { line: 1, column: this.#column },
      buffers: [
        {
          handle: 1,
          changedtick: this.#changedtick,
          endOfLine: this.#endOfLine,
          name: "/workspace/file.ts",
          filePath: "file.ts",
          absolutePath: "/workspace/file.ts",
          listed: true,
          loaded: true,
          modified: true,
          current: true,
          bufferType: "",
          modifiable: true,
          readOnly: false,
          saveable: true,
        },
      ],
      activeBufferHandle: 1,
      dirtyBufferCount: 1,
      dirty: true,
    };
  }

  captureWorkspaceBuffers(): Promise<readonly BufferWorkspaceBufferCapture[]> {
    return Promise.resolve([
      {
        path: "/workspace/file.ts",
        bufferHandle: 1,
        changedtick: this.#changedtick,
        endOfLine: this.#endOfLine,
        dirty: true,
        content: this.#content,
      },
    ]);
  }

  setWorkspaceWriteAuthorityHandler(
    handler: BufferWorkspaceWriteAuthorityHandler | null,
  ): void {
    this.#workspaceWriteAuthorityHandler = handler;
  }

  requestWorkspaceWrite(): Promise<BufferWorkspaceWriteDecision> {
    const handler = this.#workspaceWriteAuthorityHandler;
    if (handler === null) {
      return Promise.resolve({
        allowed: false,
        reason: "workspace write authority handler is unavailable",
      });
    }
    return handler({
      target: {
        path: "/workspace/file.ts",
        sourcePath: "/workspace/file.ts",
        kind: "buffer",
        bufferHandle: 1,
        changedtick: this.#changedtick,
        endOfLine: this.#endOfLine,
        lineStart: 1,
        lineEnd: 1,
      },
      buffers: [
        {
          path: "/workspace/file.ts",
          bufferHandle: 1,
          changedtick: this.#changedtick,
          endOfLine: this.#endOfLine,
          dirty: true,
          content: this.#content,
        },
      ],
    });
  }

  emit(): void {
    for (const listener of this.#listeners) listener();
  }

  update(next: {
    readonly changedtick?: number;
    readonly content?: string;
    readonly endOfLine?: boolean;
  }): void {
    this.#changedtick = next.changedtick ?? this.#changedtick;
    this.#content = next.content ?? this.#content;
    this.#endOfLine = next.endOfLine ?? this.#endOfLine;
    this.emit();
  }

  apply(content: string): number {
    this.#changedtick += 1;
    this.#content = content;
    this.emit();
    return this.#changedtick;
  }

  moveCursor(): void {
    this.#column += 1;
    this.emit();
  }

  setProviderStatus(status: BufferProviderSnapshot["providerStatus"]): void {
    this.#status = status;
    this.emit();
  }

  close(): void {
    this.#status = "closed";
    this.#workspaceAuthorityRequired = false;
    this.emit();
  }

  fail(): void {
    this.#status = "error";
    this.#workspaceAuthorityRequired = true;
    this.emit();
  }

  failSafely(): void {
    this.#status = "error";
    this.#workspaceAuthorityRequired = false;
    this.emit();
  }
}

class FakeLeaseClient implements WorkspaceEditorLeaseClient {
  leaseSequence = -1;
  get lease(): WorkspaceEditorLeaseResult {
    return {
      workspaceRoot: WORKSPACE,
      editorInstanceId: EDITOR_ID,
      leaseToken: "lease-1",
      epoch: 1,
      sequence: this.leaseSequence,
      expiresAt: 10_000,
    };
  }
  readonly syncs: WorkspaceEditorSyncParams[] = [];
  readonly acquireWorkspaceEditor = vi.fn(async () => this.lease);
  readonly syncWorkspaceEditor = vi.fn(
    async (params: WorkspaceEditorSyncParams) => {
      this.syncs.push(params);
      this.leaseSequence = params.sequence;
      return {
        accepted: true as const,
        sequence: params.sequence,
        expiresAt: 10_000,
        dirtyPaths: params.buffers
          .filter((buffer) => buffer.dirty)
          .map((buffer) => buffer.path),
        stalePaths: [],
      };
    },
  );
  readonly heartbeatWorkspaceEditor = vi.fn(async () => this.lease);
  readonly releaseWorkspaceEditor = vi.fn(async () => ({
    released: true as const,
    stalePaths: [],
  }));
  readonly reserveWorkspaceEditorTopology = vi.fn(
    async (params: WorkspaceEditorTopologyReserveParams) => ({
      tokenId: "topology-1",
      targets: params.targets,
    }),
  );
  readonly completeWorkspaceEditorTopology = vi.fn(
    async (params: WorkspaceEditorTopologyCompleteParams) => {
      this.leaseSequence = params.sequence;
      return {
        completed: true as const,
        tokenId: params.tokenId,
        status: params.status,
        sync: {
          accepted: true as const,
          sequence: params.sequence,
          expiresAt: 10_000,
          dirtyPaths: params.buffers
            .filter((buffer) => buffer.dirty)
            .map((buffer) => buffer.path),
          stalePaths: [],
        },
      };
    },
  );
  readonly releaseWorkspaceEditorTopology = vi.fn(
    async (params: WorkspaceEditorTopologyFinalizeParams) => {
      this.leaseSequence = params.sequence;
      return {
        released: true as const,
        tokenId: params.tokenId,
        sync: {
          accepted: true as const,
          sequence: params.sequence,
          expiresAt: 10_000,
          dirtyPaths: params.buffers
            .filter((buffer) => buffer.dirty)
            .map((buffer) => buffer.path),
          stalePaths: [],
        },
      };
    },
  );
  recoveredTopologies: WorkspaceEditorRecoveredTopologyMutation[] = [];
  readonly listRecoveredWorkspaceEditorTopologies = vi.fn(async () => ({
    mutations: [...this.recoveredTopologies],
  }));
  readonly resolveRecoveredWorkspaceEditorTopology = vi.fn(
    async (params: WorkspaceEditorRecoveredTopologyResolveParams) => {
      this.recoveredTopologies = this.recoveredTopologies.filter(
        (mutation) => mutation.tokenId !== params.tokenId,
      );
      return {
        resolved: true as const,
        tokenId: params.tokenId,
        status: "unknown_outcome" as const,
      };
    },
  );
  readonly getWorkspaceEditorProposal = vi.fn(async () => ({
    proposalId: "proposal-1",
    workspaceRoot: WORKSPACE,
    path: "/workspace/file.ts",
    beforeText: "const value = 1;\n",
    afterText: "const value = 2;\n",
    baseContentSha256: sha256("const value = 1;\n"),
    baseChangedtick: 1,
    bufferHandle: 1,
    source: "file_edit",
  }));
  readonly applyWorkspaceEditorProposal = vi.fn(
    async (params: WorkspaceEditorProposalApplyParams) => ({
      applied: true as const,
      proposalId: params.proposalId,
      path: "/workspace/file.ts",
      changedtick: params.changedtick,
      contentSha256: params.contentSha256,
    }),
  );
  readonly discardWorkspaceEditorProposal = vi.fn(
    async (params: WorkspaceEditorProposalParams) => ({
      discarded: true as const,
      proposalId: params.proposalId,
      path: "/workspace/file.ts",
    }),
  );
  changes: WorkspaceEditorChangeResult[] = [];
  readonly listWorkspaceEditorChanges = vi.fn(async () => ({
    sequence: this.changes.at(-1)?.sequence ?? 0,
    changes: [...this.changes],
  }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
