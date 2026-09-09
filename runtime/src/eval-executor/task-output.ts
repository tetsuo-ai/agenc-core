import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { assertPortableRelativePath } from "../eval-contract/index.js";
import { openStableDirectory, readBoundedRegularFile } from "../eval-pilot/safe-io.js";
import { assertPilotInstanceId, EvalExecutorError } from "./source-lock.js";

type DirectoryIdentity = Awaited<ReturnType<typeof openStableDirectory>>;
export interface TaskOutputDirectory {
  readonly path: string;
  readonly root: DirectoryIdentity;
  readonly directory: DirectoryIdentity;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function inspect(filePath: string): Promise<BigIntStats | null> {
  try {
    return await lstat(filePath, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function openDirectory(directory: string, create: boolean): Promise<DirectoryIdentity | null> {
  const existing = await inspect(directory);
  if (existing === null) {
    if (!create) return null;
    await mkdir(directory, { recursive: true });
  }
  return openStableDirectory(directory, "evaluation output directory");
}

async function assertPinnedDirectory(identity: DirectoryIdentity): Promise<void> {
  const current = await lstat(identity.path, { bigint: true });
  if (
    current.isSymbolicLink() || !current.isDirectory() ||
    current.dev !== identity.stat.dev || current.ino !== identity.stat.ino ||
    await realpath(identity.path) !== identity.canonicalPath
  ) throw new EvalExecutorError(["evaluation output directory changed identity"]);
}

export async function assertTaskOutputDirectory(output: TaskOutputDirectory): Promise<void> {
  await assertPinnedDirectory(output.root);
  await assertPinnedDirectory(output.directory);
}

export async function prepareOutputDirectory(outputDir: string): Promise<TaskOutputDirectory> {
  const root = await openDirectory(path.resolve(outputDir), true);
  if (root === null) throw new EvalExecutorError(["evaluation output directory is missing"]);
  return { path: root.canonicalPath, root, directory: root };
}

async function taskDirectory(outputDir: string, instanceId: string, create: boolean): Promise<TaskOutputDirectory | null> {
  assertPilotInstanceId(instanceId);
  const root = await openDirectory(path.resolve(outputDir), create);
  if (root === null) return null;
  const candidate = path.resolve(root.canonicalPath, instanceId);
  if (path.dirname(candidate) !== root.canonicalPath) {
    throw new EvalExecutorError(["instanceId escapes the evaluation output directory"]);
  }
  await assertPinnedDirectory(root);
  const directory = await openDirectory(candidate, create);
  if (directory === null) return null;
  if (path.dirname(directory.canonicalPath) !== root.canonicalPath) {
    throw new EvalExecutorError(["task directory escapes the evaluation output directory"]);
  }
  const result = { path: directory.canonicalPath, root, directory };
  await assertTaskOutputDirectory(result);
  return result;
}

export async function prepareTaskOutputDirectory(outputDir: string, instanceId: string): Promise<TaskOutputDirectory> {
  const directory = await taskDirectory(outputDir, instanceId, true);
  if (directory === null) throw new EvalExecutorError(["task output directory is missing"]);
  return directory;
}

export function findTaskOutputDirectory(outputDir: string, instanceId: string): Promise<TaskOutputDirectory | null> {
  return taskDirectory(outputDir, instanceId, false);
}

function outputFile(output: TaskOutputDirectory, name: string): string {
  assertPortableRelativePath(name, "output filename");
  const candidate = path.resolve(output.path, name);
  if (path.dirname(candidate) !== output.path) throw new EvalExecutorError(["output filename must be a single segment"]);
  return candidate;
}

export async function readTaskOutputFile(output: TaskOutputDirectory, name: string, maximumBytes: number): Promise<Uint8Array | null> {
  const filePath = outputFile(output, name);
  await assertTaskOutputDirectory(output);
  const existing = await inspect(filePath);
  if (existing === null) return null;
  if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1n) {
    throw new EvalExecutorError(["evaluation output must be a single-link regular file"]);
  }
  const bytes = await readBoundedRegularFile(filePath, maximumBytes, output.path);
  await assertTaskOutputDirectory(output);
  return bytes;
}

export async function writeTaskOutputFile(
  output: TaskOutputDirectory, name: string, bytes: string | Uint8Array,
  mode: "create" | "replace" | "append" = "create",
): Promise<string> {
  const filePath = outputFile(output, name);
  await assertTaskOutputDirectory(output);
  const existing = await inspect(filePath);
  if (existing !== null && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1n)) {
    throw new EvalExecutorError(["evaluation output must be a single-link regular file"]);
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const creation = existing === null || mode === "create" ? constants.O_CREAT | constants.O_EXCL : 0;
  const handle = await open(filePath, constants.O_WRONLY | noFollow | creation | (mode === "append" ? constants.O_APPEND : 0), 0o600);
  try {
    const current = await handle.stat({ bigint: true });
    const named = await lstat(filePath, { bigint: true });
    if (
      !current.isFile() || current.nlink !== 1n || named.isSymbolicLink() ||
      current.dev !== named.dev || current.ino !== named.ino ||
      (existing !== null && (current.dev !== existing.dev || current.ino !== existing.ino))
    ) throw new EvalExecutorError(["evaluation output file changed identity"]);
    await assertTaskOutputDirectory(output);
    if (mode === "replace") await handle.truncate(0);
    await handle.writeFile(bytes);
    await assertTaskOutputDirectory(output);
  } finally {
    await handle.close();
  }
  return filePath;
}
