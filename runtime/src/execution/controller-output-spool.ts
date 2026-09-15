import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ExecutionEnvironmentError } from "./types.js";

/**
 * Private controller output, like the supervisor's retained output journal.
 * The path comes from the caller's private temporary directory, never a task
 * workspace path. Task filesystem access belongs to ExecutionFilesystem.
 */
export async function openControllerOutputSpool(path: string): Promise<FileHandle> {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new ExecutionEnvironmentError("invalid_request", "Invalid private output spool path", false);
  }
  return open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
}
