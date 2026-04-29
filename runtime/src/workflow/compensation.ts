import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

import type { ToolHandler } from "../llm/types.js";
import {
  type EffectCompensationAction,
  type EffectCompensationState,
  type EffectFilesystemSnapshot,
  type EffectKind,
  type EffectRecord,
  hashSnapshotContent,
} from "./effects.js";

const MAX_SNAPSHOT_BYTES = 256 * 1024;

function isUtf8Content(buffer: Buffer): boolean {
  try {
    return Buffer.from(buffer.toString("utf8"), "utf8").equals(buffer);
  } catch {
    return false;
  }
}

export async function captureFilesystemSnapshot(
  path: string,
): Promise<EffectFilesystemSnapshot> {
  try {
    const stats = await lstat(path);
    if (stats.isDirectory()) {
      return {
        path,
        exists: true,
        entryType: "directory",
        sizeBytes: stats.size,
      };
    }
    if (!stats.isFile()) {
      return {
        path,
        exists: true,
        entryType: "other",
        sizeBytes: stats.size,
      };
    }
    const fileBuffer =
      stats.size <= MAX_SNAPSHOT_BYTES ? await readFile(path) : undefined;
    return {
      path,
      exists: true,
      entryType: "file",
      sizeBytes: stats.size,
      ...(fileBuffer ? { sha256: hashSnapshotContent(fileBuffer) } : {}),
      ...(fileBuffer && isUtf8Content(fileBuffer)
        ? { utf8Text: fileBuffer.toString("utf8") }
        : {}),
      ...(fileBuffer && !isUtf8Content(fileBuffer)
        ? { base64: fileBuffer.toString("base64") }
        : {}),
    };
  } catch {
    return {
      path,
      exists: false,
      entryType: "missing",
    };
  }
}

export async function capturePreExecutionSnapshots(params: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}): Promise<readonly EffectFilesystemSnapshot[]> {
  const candidates = extractSnapshotCandidatePaths(params.toolName, params.args);
  if (candidates.length === 0) {
    return [];
  }
  return Promise.all(candidates.map((candidate) => captureFilesystemSnapshot(candidate)));
}

export async function capturePostExecutionSnapshots(params: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}): Promise<readonly EffectFilesystemSnapshot[]> {
  const candidates = extractSnapshotCandidatePaths(params.toolName, params.args);
  if (candidates.length === 0) {
    return [];
  }
  return Promise.all(candidates.map((candidate) => captureFilesystemSnapshot(candidate)));
}

export function buildCompensationState(params: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly effectKind: EffectKind;
  readonly preExecutionSnapshots: readonly EffectFilesystemSnapshot[];
  readonly resultObject?: Record<string, unknown>;
  readonly effectId: string;
}): EffectCompensationState {
  const actions: EffectCompensationAction[] = [];
  const byPath = new Map(
    params.preExecutionSnapshots.map((snapshot) => [snapshot.path, snapshot]),
  );
  const effectActionId = (suffix: string): string =>
    `${params.effectId}:compensation:${suffix}`;

  switch (params.effectKind) {
    case "filesystem_write":
    case "filesystem_append":
    case "desktop_editor": {
      const path = asString(params.args.path);
      if (!path) break;
      const snapshot = byPath.get(path);
      if (!snapshot || snapshot.entryType === "missing") {
        actions.push({
          id: effectActionId("delete-created"),
          kind: "delete_created_path",
          supported: true,
          path,
        });
      } else if (snapshot.entryType === "file") {
        actions.push({
          id: effectActionId("restore"),
          kind: "restore_snapshot",
          supported:
            snapshot.utf8Text !== undefined || snapshot.base64 !== undefined,
          ...(snapshot.utf8Text === undefined && snapshot.base64 === undefined
            ? { reason: "Snapshot content was too large to capture." }
            : {}),
          path,
          snapshot,
        });
      } else {
        actions.push({
          id: effectActionId("unsupported"),
          kind: "restore_snapshot",
          supported: false,
          reason: "Only file-backed writes support automatic compensation.",
          path,
          snapshot,
        });
      }
      break;
    }
    case "filesystem_delete": {
      const path = asString(params.args.path);
      if (!path) break;
      const snapshot = byPath.get(path);
      if (snapshot?.entryType === "file") {
        actions.push({
          id: effectActionId("restore"),
          kind: "restore_snapshot",
          supported:
            snapshot.utf8Text !== undefined || snapshot.base64 !== undefined,
          ...(snapshot.utf8Text === undefined && snapshot.base64 === undefined
            ? { reason: "Snapshot content was too large to capture." }
            : {}),
          path,
          snapshot,
        });
      } else {
        actions.push({
          id: effectActionId("unsupported"),
          kind: "restore_snapshot",
          supported: false,
          reason: "Only managed file deletes support automatic restore.",
          path,
          snapshot,
        });
      }
      break;
    }
    case "filesystem_move": {
      const sourcePath = asString(params.args.source);
      const destinationPath = asString(params.args.destination);
      if (!sourcePath || !destinationPath) break;
      const destinationBefore = byPath.get(destinationPath);
      if (!destinationBefore || destinationBefore.entryType === "missing") {
        actions.push({
          id: effectActionId("reverse-move"),
          kind: "reverse_move",
          supported: true,
          sourcePath: destinationPath,
          destinationPath: sourcePath,
        });
      } else {
        actions.push({
          id: effectActionId("unsupported"),
          kind: "reverse_move",
          supported: false,
          reason:
            "Automatic reversal is unsafe when the destination existed before the move.",
          sourcePath: destinationPath,
          destinationPath: sourcePath,
        });
      }
      break;
    }
    case "filesystem_mkdir": {
      const path = asString(params.args.path);
      if (!path) break;
      const snapshot = byPath.get(path);
      if (!snapshot || snapshot.entryType === "missing") {
        actions.push({
          id: effectActionId("delete-created"),
          kind: "delete_created_path",
          supported: true,
          path,
        });
      }
      break;
    }
    case "process_start": {
      const processId = asString(params.resultObject?.processId);
      if (processId) {
        actions.push({
          id: effectActionId("process-stop"),
          kind: "process_stop",
          supported: true,
          processId,
          label: asString(params.resultObject?.label),
          idempotencyKey: asString(params.resultObject?.idempotencyKey),
        });
      }
      break;
    }
    case "server_start": {
      const serverId = asString(params.resultObject?.serverId);
      if (serverId) {
        actions.push({
          id: effectActionId("server-stop"),
          kind: "server_stop",
          supported: true,
          serverId,
          label: asString(params.resultObject?.label),
          idempotencyKey: asString(params.resultObject?.idempotencyKey),
        });
      }
      break;
    }
    default:
      break;
  }

  if (actions.length === 0) {
    return {
      status: "not_available",
      actions: [],
    };
  }

  return {
    status: actions.some((action) => action.supported)
      ? "available"
      : "not_available",
    actions,
  };
}

export async function executeCompensation(params: {
  readonly record: EffectRecord;
  readonly toolHandler?: ToolHandler;
}): Promise<{ status: "completed" | "failed"; error?: string }> {
  const actions = params.record.compensation.actions;
  if (actions.length === 0) {
    return { status: "failed", error: "No compensation actions are available." };
  }

  for (const action of actions) {
    if (!action.supported) {
      return {
        status: "failed",
        error: action.reason ?? "Compensation action is unsupported.",
      };
    }
    try {
      await executeCompensationAction(action, params.toolHandler);
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { status: "completed" };
}

async function executeCompensationAction(
  action: EffectCompensationAction,
  toolHandler?: ToolHandler,
): Promise<void> {
  switch (action.kind) {
    case "restore_snapshot": {
      if (!action.path || !action.snapshot) {
        throw new Error("Missing restore_snapshot payload.");
      }
      const payload = action.snapshot.utf8Text
        ? Buffer.from(action.snapshot.utf8Text, "utf8")
        : action.snapshot.base64
          ? Buffer.from(action.snapshot.base64, "base64")
          : undefined;
      if (!payload) {
        throw new Error("Snapshot content is unavailable for restore.");
      }
      await mkdirForFile(action.path);
      await writeFile(action.path, payload);
      return;
    }
    case "delete_created_path": {
      if (!action.path) {
        throw new Error("Missing delete_created_path target.");
      }
      await removePathIfSafe(action.path);
      return;
    }
    case "reverse_move": {
      if (!action.sourcePath || !action.destinationPath) {
        throw new Error("Missing reverse_move payload.");
      }
      await mkdirForFile(action.destinationPath);
      await rename(action.sourcePath, action.destinationPath);
      return;
    }
    case "process_stop": {
      if (!toolHandler || !action.processId) {
        throw new Error("A tool handler is required for process compensation.");
      }
      await toolHandler("system.processStop", {
        processId: action.processId,
        ...(action.label ? { label: action.label } : {}),
        ...(action.idempotencyKey ? { idempotencyKey: action.idempotencyKey } : {}),
      });
      return;
    }
    case "server_stop": {
      if (!toolHandler || !action.serverId) {
        throw new Error("A tool handler is required for server compensation.");
      }
      await toolHandler("system.serverStop", {
        serverId: action.serverId,
        ...(action.label ? { label: action.label } : {}),
        ...(action.idempotencyKey ? { idempotencyKey: action.idempotencyKey } : {}),
      });
      return;
    }
  }
}

function extractSnapshotCandidatePaths(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  const values = new Set<string>();
  if (
    toolName === "system.writeFile" ||
    toolName === "system.appendFile" ||
    toolName === "system.delete" ||
    toolName === "system.mkdir" ||
    toolName === "desktop.text_editor"
  ) {
    const path = asString(args.path);
    if (path) values.add(path);
  }
  if (toolName === "system.move") {
    const source = asString(args.source);
    const destination = asString(args.destination);
    if (source) values.add(source);
    if (destination) values.add(destination);
  }
  return [...values];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

async function mkdirForFile(path: string): Promise<void> {
  const segments = path.split("/");
  segments.pop();
  const directory = segments.join("/");
  if (directory.length > 0) {
    await mkdir(directory, { recursive: true });
  }
}

async function removePathIfSafe(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isDirectory()) {
      const children = await readdir(path);
      if (children.length > 0) {
        throw new Error(
          `Refusing to compensate by deleting non-empty directory "${path}".`,
        );
      }
    }
  } catch (error) {
    if (error instanceof Error && /ENOENT/.test(error.message)) {
      return;
    }
    if (error instanceof Error) {
      throw error;
    }
  }
  await rm(path, { recursive: true, force: true });
}

