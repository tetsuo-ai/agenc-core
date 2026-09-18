import {
  AGENC_JSON_LINE_MAX_FRAME_BYTES,
  jsonLineFrameBytes,
  jsonUtf8Bytes,
} from "../utils/json-line-frame.js";

export const WORKSPACE_EDITOR_MAX_FRAME_BYTES = AGENC_JSON_LINE_MAX_FRAME_BYTES;
export const WORKSPACE_EDITOR_PROPOSAL_MAX_FRAME_BYTES =
  WORKSPACE_EDITOR_MAX_FRAME_BYTES;
export const WORKSPACE_EDITOR_MAX_BUFFER_BYTES = 5 * 1024 * 1024;
export const WORKSPACE_EDITOR_MAX_SYNC_CONTENT_BYTES =
  WORKSPACE_EDITOR_MAX_FRAME_BYTES;
export const WORKSPACE_EDITOR_MAX_SYNCED_BUFFERS = 512;
export const WORKSPACE_CAPTURE_READ_CONCURRENCY = 4;

const JSON_RPC_VERSION = "2.0";

export class WorkspaceEditorSnapshotBudgetError extends Error {
  readonly frameBytes?: number;
  readonly maxFrameBytes: number;

  constructor(
    message: string,
    options: {
      readonly frameBytes?: number;
      readonly maxFrameBytes?: number;
    } = {},
  ) {
    super(message);
    this.name = "WorkspaceEditorSnapshotBudgetError";
    this.frameBytes = options.frameBytes;
    this.maxFrameBytes =
      options.maxFrameBytes ?? WORKSPACE_EDITOR_MAX_FRAME_BYTES;
  }
}

export function workspaceEditorRpcFrameBytes(
  method: string,
  params: unknown,
  requestId: string | number = Number.MAX_SAFE_INTEGER,
): number {
  return jsonLineFrameBytes({
    jsonrpc: JSON_RPC_VERSION,
    id: requestId,
    method,
    params,
  });
}

export function assertWorkspaceEditorRpcFitsFrame(
  method: string,
  params: unknown,
  requestId: string | number = Number.MAX_SAFE_INTEGER,
): void {
  const frameBytes = workspaceEditorRpcFrameBytes(method, params, requestId);
  if (frameBytes > WORKSPACE_EDITOR_MAX_FRAME_BYTES) {
    throw new WorkspaceEditorSnapshotBudgetError(
      workspaceEditorSnapshotFrameMessage(frameBytes),
      { frameBytes },
    );
  }
}

export function workspaceEditorSnapshotFrameMessage(
  frameBytes: number,
  maxFrameBytes: number = WORKSPACE_EDITOR_MAX_FRAME_BYTES,
): string {
  return (
    `Workspace editor snapshot requires ${frameBytes} serialized bytes, ` +
    `exceeding the ${maxFrameBytes}-byte daemon transport frame ` +
    `(including the trailing newline). Close or save some dirty buffers ` +
    `so the atomic snapshot can fit, then retry.`
  );
}

export function workspaceEditorEscapedContentBytes(content: string): number {
  return jsonUtf8Bytes(content);
}
