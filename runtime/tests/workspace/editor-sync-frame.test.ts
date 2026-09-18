import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AGENC_JSON_LINE_MAX_FRAME_BYTES } from "../../src/utils/json-line-frame.js";
import { encodeBoundedJsonLine } from "../../src/app-server/transport/stdio.js";
import {
  WORKSPACE_EDITOR_MAX_FRAME_BYTES,
  WORKSPACE_EDITOR_MAX_SYNC_CONTENT_BYTES,
  WorkspaceEditorSnapshotBudgetError,
  assertWorkspaceEditorRpcFitsFrame,
  workspaceEditorEscapedContentBytes,
  workspaceEditorRpcFrameBytes,
} from "../../src/workspace/editor-sync-frame.js";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function dirtyBuffer(
  index: number,
  content: string,
): {
  readonly path: string;
  readonly bufferHandle: number;
  readonly changedtick: number;
  readonly contentSha256: string;
  readonly contentBytes: number;
  readonly dirty: true;
  readonly content: string;
} {
  return {
    path: `/workspace/dirty-${index}.ts`,
    bufferHandle: index + 1,
    changedtick: 1,
    contentSha256: sha256(content),
    contentBytes: Buffer.byteLength(content, "utf8"),
    dirty: true,
    content,
  };
}

function syncParams(
  buffers: readonly ReturnType<typeof dirtyBuffer>[],
): {
  readonly workspaceRoot: string;
  readonly editorInstanceId: string;
  readonly leaseToken: string;
  readonly epoch: number;
  readonly sequence: number;
  readonly buffers: readonly ReturnType<typeof dirtyBuffer>[];
} {
  return {
    workspaceRoot: "/workspace",
    editorInstanceId: "editor-frame",
    leaseToken: "lease-frame",
    epoch: 1,
    sequence: 1,
    buffers,
  };
}

describe("workspace editor sync frame budget", () => {
  it("rejects four dirty 4 MiB buffers whose raw content fits but the JSON line does not", () => {
    const fourMiB = "x".repeat(4 * 1024 * 1024);
    const rawContentBytes = 4 * Buffer.byteLength(fourMiB, "utf8");
    const params = syncParams([0, 1, 2, 3].map((index) => dirtyBuffer(index, fourMiB)));

    expect(rawContentBytes).toBe(WORKSPACE_EDITOR_MAX_SYNC_CONTENT_BYTES);
    expect(rawContentBytes).toBe(AGENC_JSON_LINE_MAX_FRAME_BYTES);

    const frameBytes = workspaceEditorRpcFrameBytes(
      "workspace.editor.sync",
      params,
    );
    expect(frameBytes).toBeGreaterThan(WORKSPACE_EDITOR_MAX_FRAME_BYTES);
    // JSON-RPC envelope, hashes, paths, and the trailing newline add ~1 KiB
    // on top of the 16 MiB of raw dirty content.
    expect(frameBytes).toBe(16_778_217);

    expect(() =>
      assertWorkspaceEditorRpcFitsFrame("workspace.editor.sync", params),
    ).toThrow(WorkspaceEditorSnapshotBudgetError);
    expect(() =>
      assertWorkspaceEditorRpcFitsFrame("workspace.editor.sync", params),
    ).toThrow(/including the trailing newline/u);
    expect(() => encodeBoundedJsonLine({
      jsonrpc: "2.0",
      id: Number.MAX_SAFE_INTEGER,
      method: "workspace.editor.sync",
      params,
    })).toThrow(/exceeding the 16777216-byte limit/u);
  });

  it("accepts multiple dirty buffers whose serialized JSON-RPC line still fits", () => {
    const content = "y".repeat(1024);
    const params = syncParams([0, 1, 2, 3].map((index) => dirtyBuffer(index, content)));
    const request = {
      jsonrpc: "2.0",
      id: Number.MAX_SAFE_INTEGER,
      method: "workspace.editor.sync",
      params,
    };

    expect(workspaceEditorRpcFrameBytes("workspace.editor.sync", params)).toBe(
      Buffer.byteLength(`${JSON.stringify(request)}\n`, "utf8"),
    );
    expect(() =>
      assertWorkspaceEditorRpcFitsFrame("workspace.editor.sync", params),
    ).not.toThrow();
    expect(() => encodeBoundedJsonLine(request)).not.toThrow();
  });

  it("counts JSON escaping when measuring dirty content", () => {
    const raw = "\0".repeat(8);
    expect(Buffer.byteLength(raw, "utf8")).toBe(8);
    expect(workspaceEditorEscapedContentBytes(raw)).toBe(
      Buffer.byteLength(JSON.stringify(raw), "utf8"),
    );
    expect(workspaceEditorEscapedContentBytes(raw)).toBe(2 + 8 * 6);
  });
});
