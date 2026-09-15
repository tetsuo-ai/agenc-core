import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { FileWriteApprovalPreview } from "../session/event-log.js";
import type { ToolInvocation } from "../tools/context.js";
import { getSessionReadSnapshot, safePath } from "../tools/system/filesystem.js";
import { workspaceAuthoritativeRead } from "../workspace/mutation-coordinator.js";
import { checkToolPathPermissionAsync } from "./path-validation.js";
import { getCanonicalSettingsAuthority } from "../utils/settings/canonicalAuthority.js";
import { bindExecutionToolFileRead, resolveExecutionToolReadPath } from "../execution/tool-file-read.js";
import { sameExecutionPathDescription } from "../execution/path-description.js";
import { rethrowContentAuthorityError } from "../execution/content-filesystem.js";

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
  const workspace = getCanonicalSettingsAuthority()?.executionWorkspace;
  try {
    const allowedRoots = [cwd, ...context.additionalWorkingDirectories.keys()];
    if (workspace) {
      const observed = await resolveExecutionToolReadPath(workspace, filePath, { cwd, allowedPaths: allowedRoots });
      const permission = await checkToolPathPermissionAsync({ toolName: "FileRead", input: { file_path: filePath },
        path: filePath, cwd, context, operationType: "read", extraWorkingDirectories: allowedRoots });
      if (permission.behavior !== "allow") return unavailable("Reading the target requires permission.");
      await observed.validate();
      if (!observed.description) return { kind: "missing" };
      if ((BigInt(observed.description.identity.mode) & 0o170000n) !== 0o100000n) {
        return unavailable("The target is not a regular file.");
      }
      const snapshot = getSessionReadSnapshot(sessionId, observed.canonical);
      const content = snapshot?.rawContent;
      if (snapshot?.viewKind !== "full" || snapshot.isPartialView === true ||
          typeof snapshot.content !== "string" || typeof content !== "string" || !snapshot.executionFile) {
        return unavailable("Read the full existing file before reviewing its replacement.");
      }
      if (!sameExecutionPathDescription(snapshot.executionFile, observed.description)) {
        return unavailable("The file changed since its last full read.");
      }
      if (content.includes("\0") || Buffer.byteLength(content, "utf8") > 256 * 1024) {
        return unavailable("The existing content exceeds the text preview limit.");
      }
      const source = await bindExecutionToolFileRead(workspace, filePath, { cwd, allowedPaths: allowedRoots });
      let matches: boolean;
      try {
        const file = await source.capability.readFile(256 * 1024);
        await source.validate();
        matches = sameExecutionPathDescription(snapshot.executionFile, source.description) &&
          file.content.equals(Buffer.from(content, "utf8"));
      } catch (error) {
        try { await source.capability.dispose(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Preview read and release failed", { cause: error }); }
        throw error;
      }
      await source.capability.dispose();
      source.assertCurrent();
      return matches ? { kind: "existing", content } : unavailable("The file changed since its last full read.");
    }
    const safe = await safePath(resolve(cwd, filePath), allowedRoots);
    if (!safe.safe) {
      return unavailable("The target is outside the authorized workspace.");
    }
    const permission = await checkToolPathPermissionAsync({
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
  } catch (error) {
    if (workspace) rethrowContentAuthorityError(error);
    return unavailable("The target's current state could not be verified.");
  }
}
