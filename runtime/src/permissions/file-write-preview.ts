import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { FileWriteApprovalPreview } from "../session/event-log.js";
import type { ToolInvocation } from "../tools/context.js";
import { getSessionReadSnapshot, safePath } from "../tools/system/filesystem.js";
import { workspaceAuthoritativeRead } from "../workspace/mutation-coordinator.js";
import { checkToolPathPermission } from "./path-validation.js";

export async function buildFileWriteApprovalPreview(
  invocation: ToolInvocation,
  input: Readonly<Record<string, unknown>>,
): Promise<FileWriteApprovalPreview> {
  const unavailable = (reason: string): FileWriteApprovalPreview => ({
    kind: "unavailable",
    reason,
  });
  const cwd = invocation.turn?.cwd;
  const sessionId = invocation.session?.conversationId;
  const context = invocation.session?.services.permissionModeRegistry?.current();
  const filePath = input.file_path;
  if (
    typeof cwd !== "string" ||
    !isAbsolute(cwd) ||
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    context === undefined ||
    typeof filePath !== "string" ||
    filePath.trim().length === 0 ||
    filePath.includes("\0")
  ) {
    return unavailable("File preview authority is unavailable.");
  }
  try {
    const allowedRoots = [cwd, ...context.additionalWorkingDirectories.keys()];
    const safe = await safePath(resolve(cwd, filePath), allowedRoots);
    if (!safe.safe) {
      return unavailable("The target is outside the authorized workspace.");
    }
    const permission = checkToolPathPermission({
      toolName: "FileRead",
      input: { file_path: safe.resolved },
      path: safe.resolved,
      cwd,
      context,
      operationType: "read",
      extraWorkingDirectories: allowedRoots,
    });
    if (permission.behavior !== "allow") {
      return unavailable("Reading the target requires permission.");
    }
    const editorRead = workspaceAuthoritativeRead(safe.resolved);
    let metadata;
    try {
      metadata = await stat(safe.resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && editorRead === null) {
        return { kind: "missing" };
      }
      return unavailable("The target's current state could not be verified.");
    }
    if (!metadata.isFile()) {
      return unavailable("The target is not a regular file.");
    }
    const snapshot = getSessionReadSnapshot(sessionId, safe.resolved);
    const content = snapshot?.rawContent;
    if (
      snapshot?.viewKind !== "full" ||
      snapshot.isPartialView === true ||
      typeof snapshot.content !== "string" ||
      typeof content !== "string"
    ) {
      return unavailable("Read the full existing file before reviewing its replacement.");
    }
    if (
      editorRead !== null
        ? editorRead.content !== content
        : snapshot.timestamp !== metadata.mtimeMs
    ) {
      return unavailable("The file changed since its last full read.");
    }
    if (content.includes("\0") || Buffer.byteLength(content, "utf8") > 256 * 1024) {
      return unavailable("The existing content exceeds the text preview limit.");
    }
    return { kind: "existing", content };
  } catch {
    return unavailable("The target's current state could not be verified.");
  }
}
