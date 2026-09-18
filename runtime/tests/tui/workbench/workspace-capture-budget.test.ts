import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { readWorkspaceCaptureContents } from "../../../src/tui/workbench/buffer/workspace-capture-budget.js";
import {
  WORKSPACE_CAPTURE_READ_CONCURRENCY,
  WorkspaceEditorSnapshotBudgetError,
} from "../../../src/workspace/editor-sync-frame.js";

describe("workspace capture budget", () => {
  it("bounds read concurrency", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      handle: index + 1,
      dirty: true,
      path: `/workspace/file-${index}.ts`,
    }));

    const contents = await readWorkspaceCaptureContents(
      candidates,
      async (handle) => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await delay(5);
        inflight -= 1;
        return `content-${handle}`;
      },
    );

    expect(maxInflight).toBe(WORKSPACE_CAPTURE_READ_CONCURRENCY);
    expect(maxInflight).toBeLessThanOrEqual(4);
    expect(contents).toEqual(
      candidates.map((candidate) => `content-${candidate.handle}`),
    );
  });

  it("rejects a buffer count over the snapshot limit before any read", async () => {
    let reads = 0;
    await expect(
      readWorkspaceCaptureContents(
        Array.from({ length: 3 }, (_, index) => ({
          handle: index + 1,
          dirty: true,
        })),
        async () => {
          reads += 1;
          return "x";
        },
        { maxSyncedBuffers: 2 },
      ),
    ).rejects.toBeInstanceOf(WorkspaceEditorSnapshotBudgetError);
    expect(reads).toBe(0);
  });

  it("stops after dirty contents make a serialized snapshot impossible", async () => {
    const maxFrameBytes = 64;
    const dirtyContent = "x".repeat(40);
    let reads = 0;
    const started: number[] = [];

    await expect(
      readWorkspaceCaptureContents(
        [
          { handle: 1, dirty: true, path: "/workspace/a.ts" },
          { handle: 2, dirty: true, path: "/workspace/b.ts" },
          { handle: 3, dirty: true, path: "/workspace/c.ts" },
          { handle: 4, dirty: false, path: "/workspace/clean.ts" },
        ],
        async (handle) => {
          started.push(handle);
          reads += 1;
          return handle === 4 ? "clean" : dirtyContent;
        },
        { concurrency: 1, maxFrameBytes },
      ),
    ).rejects.toMatchObject({
      name: "WorkspaceEditorSnapshotBudgetError",
      message: expect.stringMatching(/including the trailing newline/u),
    });

    expect(reads).toBe(2);
    expect(started).toEqual([1, 2]);
  });

  it("reads dirty buffers before clean ones so the budget can fail first", async () => {
    const order: number[] = [];
    await expect(
      readWorkspaceCaptureContents(
        [
          { handle: 1, dirty: false, path: "/workspace/clean.ts" },
          { handle: 2, dirty: true, path: "/workspace/dirty.ts" },
        ],
        async (handle) => {
          order.push(handle);
          return handle === 2 ? "\0".repeat(32) : "clean";
        },
        { concurrency: 1, maxFrameBytes: 16 },
      ),
    ).rejects.toBeInstanceOf(WorkspaceEditorSnapshotBudgetError);
    expect(order).toEqual([2]);
  });

  it("rejects a single oversized buffer without reading the rest", async () => {
    let reads = 0;
    await expect(
      readWorkspaceCaptureContents(
        [
          { handle: 1, dirty: true, path: "/workspace/huge.ts" },
          { handle: 2, dirty: true, path: "/workspace/later.ts" },
        ],
        async (handle) => {
          reads += 1;
          return handle === 1 ? "h".repeat(32) : "later";
        },
        { concurrency: 1, maxBufferBytes: 16 },
      ),
    ).rejects.toThrow(/huge\.ts is 32 bytes/u);
    expect(reads).toBe(1);
  });
});
