import {
  WORKSPACE_CAPTURE_READ_CONCURRENCY,
  WORKSPACE_EDITOR_MAX_BUFFER_BYTES,
  WORKSPACE_EDITOR_MAX_FRAME_BYTES,
  WORKSPACE_EDITOR_MAX_SYNCED_BUFFERS,
  WorkspaceEditorSnapshotBudgetError,
  workspaceEditorEscapedContentBytes,
  workspaceEditorSnapshotFrameMessage,
} from "../../../workspace/editor-sync-frame.js";

export type WorkspaceCaptureReadCandidate = {
  readonly handle: number;
  readonly dirty: boolean;
  readonly path?: string;
};

export type WorkspaceCaptureReadBudget = {
  readonly concurrency?: number;
  readonly maxFrameBytes?: number;
  readonly maxBufferBytes?: number;
  readonly maxSyncedBuffers?: number;
};

/**
 * Read workspace-capture contents with a bounded worker pool. Dirty buffers
 * are read first so an impossible snapshot can fail before clean hashes are
 * materialized. Remaining queued reads stop once a budget is known to fail.
 */
export async function readWorkspaceCaptureContents(
  candidates: readonly WorkspaceCaptureReadCandidate[],
  read: (handle: number) => Promise<string>,
  options: WorkspaceCaptureReadBudget = {},
): Promise<readonly string[]> {
  const maxSyncedBuffers =
    options.maxSyncedBuffers ?? WORKSPACE_EDITOR_MAX_SYNCED_BUFFERS;
  const maxBufferBytes =
    options.maxBufferBytes ?? WORKSPACE_EDITOR_MAX_BUFFER_BYTES;
  const maxFrameBytes =
    options.maxFrameBytes ?? WORKSPACE_EDITOR_MAX_FRAME_BYTES;
  const concurrency = Math.max(
    1,
    options.concurrency ?? WORKSPACE_CAPTURE_READ_CONCURRENCY,
  );

  if (candidates.length > maxSyncedBuffers) {
    throw new WorkspaceEditorSnapshotBudgetError(
      `Workspace editor snapshot has ${candidates.length} buffers, exceeding the ${maxSyncedBuffers} buffer capture limit. Close some buffers so the atomic snapshot can fit, then retry.`,
      { maxFrameBytes },
    );
  }
  if (candidates.length === 0) return [];

  const contents = new Array<string>(candidates.length);
  const readOrder = [
    ...candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.dirty),
    ...candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => !candidate.dirty),
  ];

  let next = 0;
  let rawDirtyBytes = 0;
  let escapedDirtyBytes = 0;
  let failure: WorkspaceEditorSnapshotBudgetError | undefined;

  const recordContent = (
    candidate: WorkspaceCaptureReadCandidate,
    content: string,
  ): void => {
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > maxBufferBytes) {
      const label = candidate.path ?? `buffer ${candidate.handle}`;
      failure = new WorkspaceEditorSnapshotBudgetError(
        `Workspace editor buffer ${label} is ${contentBytes} bytes, exceeding the ${maxBufferBytes} byte per-buffer limit.`,
        { maxFrameBytes },
      );
      return;
    }
    if (!candidate.dirty) return;
    rawDirtyBytes += contentBytes;
    escapedDirtyBytes += workspaceEditorEscapedContentBytes(content);
    if (rawDirtyBytes > maxFrameBytes || escapedDirtyBytes > maxFrameBytes) {
      failure = new WorkspaceEditorSnapshotBudgetError(
        workspaceEditorSnapshotFrameMessage(
          Math.max(rawDirtyBytes, escapedDirtyBytes) + 1,
          maxFrameBytes,
        ),
        {
          frameBytes: Math.max(rawDirtyBytes, escapedDirtyBytes) + 1,
          maxFrameBytes,
        },
      );
    }
  };

  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const orderIndex = next;
      next += 1;
      if (orderIndex >= readOrder.length) return;
      const entry = readOrder[orderIndex]!;
      const content = await read(entry.candidate.handle);
      if (failure !== undefined) return;
      contents[entry.index] = content;
      recordContent(entry.candidate, content);
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, readOrder.length) },
      () => worker(),
    ),
  );
  if (failure !== undefined) throw failure;
  return contents;
}
