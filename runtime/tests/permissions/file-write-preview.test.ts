import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Event } from "../session/event-log.js";
import {
  daemonEventFromUnboundSessionEvent,
  notificationFromDaemonEvent,
} from "../app-server/background-agent-runner/daemon-events.js";
import { isCanonicalEventPayload } from "../state/recovery-journal-schema.js";
import type { ToolInvocation } from "../tools/context.js";
import { createFileReadTool } from "../tools/system/file-read.js";
import {
  clearSessionReadState,
  recordSessionRead,
} from "../tools/system/filesystem.js";
import { buildFileWriteApprovalPreview } from "./file-write-preview.js";
import { requestApproval, type ApprovalCtx } from "./guardian/arbiter.js";
import { createEmptyToolPermissionContext } from "./types.js";

describe("file write approval preview", () => {
  let root: string;
  let sessionId: string;
  let invocation: ToolInvocation;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-write-preview-"));
    sessionId = randomUUID();
    invocation = {
      session: {
        conversationId: sessionId,
        services: {
          permissionModeRegistry: {
            current: () => createEmptyToolPermissionContext(),
          },
        },
      },
      turn: { cwd: root, subId: "turn-preview" },
      callId: "call-preview",
      toolName: { name: "Write" },
      payload: { kind: "function", arguments: "{}" },
      source: "direct",
    } as ToolInvocation;
  });

  afterEach(async () => {
    clearSessionReadState(sessionId, tmpdir());
    await rm(root, { recursive: true, force: true });
  });

  async function seedRead(filePath: string, content: string): Promise<void> {
    await writeFile(filePath, content);
    const metadata = await stat(filePath);
    recordSessionRead(sessionId, filePath, {
      viewKind: "full",
      content: "formatted display content",
      rawContent: content,
      timestamp: metadata.mtimeMs,
    });
  }

  test.each(["original\nremoved\n", ""])(
    "uses previously authorized raw contents, including an empty file",
    async (content) => {
      const target = join(root, "existing.txt");
      await seedRead(target, content);
      await expect(
        buildFileWriteApprovalPreview(invocation, { file_path: "existing.txt" }),
      ).resolves.toEqual({ kind: "existing", content });
    },
  );

  test("marks only a verified missing path as a creation", async () => {
    await expect(
      buildFileWriteApprovalPreview(invocation, { file_path: "new.txt" }),
    ).resolves.toEqual({ kind: "missing" });
  });

  test("uses the snapshot produced by an actual full FileRead", async () => {
    const target = join(root, "read-through-tool.txt");
    const content = "original\nremoved\n";
    await writeFile(target, content);
    const tool = createFileReadTool({ allowedPaths: [root] });
    const result = await tool.execute({ file_path: target, __agencSessionId: sessionId });
    expect(result.isError).not.toBe(true);
    await expect(
      buildFileWriteApprovalPreview(invocation, { file_path: target }),
    ).resolves.toEqual({ kind: "existing", content });
  });

  test("does not read an existing file without a full session snapshot", async () => {
    const target = join(root, "unread.txt");
    await writeFile(target, "unapproved contents");
    await expect(
      buildFileWriteApprovalPreview(invocation, { file_path: target }),
    ).resolves.toMatchObject({ kind: "unavailable" });
    recordSessionRead(sessionId, target, {
      viewKind: "partial",
      content: "unapproved contents",
    });
    await expect(
      buildFileWriteApprovalPreview(invocation, { file_path: target }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  test("does not present stale, binary, oversized, or non-file content", async () => {
    const target = join(root, "existing.txt");
    await seedRead(target, "original");
    recordSessionRead(sessionId, target, { timestamp: 0 });
    await expect(
      buildFileWriteApprovalPreview(invocation, { file_path: target }),
    ).resolves.toMatchObject({ kind: "unavailable" });
    for (const content of ["binary\0content", "x".repeat(256 * 1024 + 1)]) {
      await seedRead(target, content);
      await expect(
        buildFileWriteApprovalPreview(invocation, { file_path: target }),
      ).resolves.toMatchObject({ kind: "unavailable" });
    }
    await expect(
      buildFileWriteApprovalPreview(invocation, { file_path: root }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  test("does not treat a full image snapshot's base64 as file text", async () => {
    const target = join(root, "image.png");
    await seedRead(target, "image bytes");
    recordSessionRead(sessionId, target, {
      viewKind: "full",
      content: null,
      rawContent: Buffer.from("image bytes").toString("base64"),
    });
    await expect(
      buildFileWriteApprovalPreview(invocation, { file_path: target }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  test("rejects outside paths and symlinks even when their contents were cached", async () => {
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    await mkdir(workspace);
    await seedRead(outside, "outside contents");
    await symlink(outside, join(workspace, "link.txt"));
    invocation = { ...invocation, turn: { ...invocation.turn, cwd: workspace } };
    for (const filePath of [outside, "link.txt", "../outside.txt"]) {
      await expect(
        buildFileWriteApprovalPreview(invocation, { file_path: filePath }),
      ).resolves.toMatchObject({ kind: "unavailable" });
    }
  });

  test("respects current read denials even for previously read files", async () => {
    const target = join(root, "denied.txt");
    await seedRead(target, "previously authorized");
    invocation = {
      ...invocation,
      session: {
        ...invocation.session,
        services: {
          ...invocation.session.services,
          permissionModeRegistry: {
            current: () => ({
              ...createEmptyToolPermissionContext(),
              alwaysDenyRules: { localSettings: ["FileRead(**)"] },
            }),
          },
        },
      },
    } as ToolInvocation;
    await expect(
      buildFileWriteApprovalPreview(invocation, { file_path: target }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  test("supplies the same authoritative preview to the resolver and durable request", async () => {
    const target = join(root, "existing.txt");
    await seedRead(target, "old\nremoved\n");
    const events: Event[] = [];
    const session = {
      ...invocation.session,
      rolloutStore: {},
      emit: (event: Event): Event => {
        const stamped = { ...event, seq: events.length + 1, eventId: randomUUID() };
        events.push(stamped);
        return stamped;
      },
    } as ToolInvocation["session"];
    const resolver = vi.fn(async (_context: ApprovalCtx) => ({ kind: "denied" as const }));
    const preview = { kind: "existing", content: "old\nremoved\n" };
    await requestApproval({
      ctx: {
        invocation: { ...invocation, session },
        callId: invocation.callId,
        toolName: "Write",
        turnId: "turn-preview",
        fileWritePreview: { kind: "missing" },
      },
      args: { file_path: target, content: "new\n" },
      resolver: { request: resolver },
    });
    expect(resolver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fileWritePreview: preview }),
    );
    expect(events[0]?.msg).toMatchObject({
      type: "request_permissions",
      payload: { fileWritePreview: preview },
    });
    expect(isCanonicalEventPayload("request_permissions", events[0]?.msg.payload)).toBe(true);
    const projected = daemonEventFromUnboundSessionEvent(events[0]!);
    expect(projected).not.toBeNull();
    expect(notificationFromDaemonEvent("session-preview", sessionId, projected!)).toMatchObject({
      method: "event.permission_request",
      params: { fileWritePreview: preview },
    });
  });

  test("validates optional durable preview variants without accepting malformed content", () => {
    const payload = { callId: "call-preview", toolName: "Write", permissions: ["tool.use"] };
    for (const fileWritePreview of [
      undefined,
      { kind: "missing" },
      { kind: "existing", content: "old\n" },
      { kind: "unavailable", reason: "Read required" },
    ]) {
      expect(isCanonicalEventPayload("request_permissions", {
        ...payload,
        ...(fileWritePreview === undefined ? {} : { fileWritePreview }),
      })).toBe(true);
    }
    for (const fileWritePreview of [
      { kind: "existing", content: 123 },
      { kind: "unavailable" },
      { kind: "unknown" },
    ]) {
      expect(isCanonicalEventPayload("request_permissions", {
        ...payload,
        fileWritePreview,
      })).toBe(false);
    }
  });
});
