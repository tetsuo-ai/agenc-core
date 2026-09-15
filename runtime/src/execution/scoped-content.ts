import { posix } from "node:path";
import { ContentFilesystem, contentPathMissing, type ContentExecutionEnvironment } from "./content-filesystem.js";
import { ExecutionEnvironmentError, type ExecutionPathDescription } from "./types.js";

function within(root: string, path: string): boolean {
  const relative = posix.relative(root, path);
  return relative === "" || (!posix.isAbsolute(relative) && relative !== ".." && !relative.startsWith("../"));
}

function same(before: ExecutionPathDescription, after: ExecutionPathDescription): boolean {
  return before.canonicalPath === after.canonicalPath &&
    (Object.keys(before.identity) as (keyof typeof before.identity)[]).every(key => before.identity[key] === after.identity[key]);
}

/** Read a private regular file beneath a trusted directory, with no task code or mutations. */
export async function readScopedExecutionText(
  environment: ContentExecutionEnvironment,
  anchor: string,
  path: string,
): Promise<string | null> {
  if (!posix.isAbsolute(anchor) || !posix.isAbsolute(path) || !within(anchor, path) || posix.normalize(anchor) === posix.normalize(path)) {
    throw new ExecutionEnvironmentError("invalid_request", "Scoped content must be a file below an absolute trust anchor", false);
  }
  const content = new ContentFilesystem(environment), filesystem = content.environment!.filesystem;
  const directories: { path: string; description: ExecutionPathDescription; followSymlinks: boolean }[] = [];
  const root = await filesystem.describePath(anchor);
  if ((BigInt(root.identity.mode) & 0o170000n) !== 0o040000n) {
    throw new ExecutionEnvironmentError("unsupported_resource", "Content trust anchor must be a directory", false);
  }
  directories.push({ path: anchor, description: root, followSymlinks: true });
  const parts = posix.relative(anchor, path).split("/");
  let current = anchor;
  let leaf: ExecutionPathDescription | undefined;
  for (let index = 0; index < parts.length; index++) {
    current = posix.join(current, parts[index]);
    let description: ExecutionPathDescription;
    try { description = await filesystem.describePath(current, { followSymlinks: false }); }
    catch (error) { if (contentPathMissing(error)) return null; throw error; }
    const last = index === parts.length - 1;
    const symbolicLink = (BigInt(description.identity.mode) & 0o170000n) === 0o120000n;
    // Existing memory policy permits contained intermediate aliases, while the
    // memory directory itself and its file must remain ordinary entries.
    if (symbolicLink && index < parts.length - 2) {
      directories.push({ path: current, description, followSymlinks: false });
      description = await filesystem.describePath(current);
    }
    if (!within(root.canonicalPath, description.canonicalPath) ||
        (BigInt(description.identity.mode) & 0o170000n) !== (last ? 0o100000n : 0o040000n) ||
        (last && description.identity.nlink !== "1")) {
      throw new ExecutionEnvironmentError("unsupported_resource", "Scoped content contains an unsafe directory or file", true, false);
    }
    if (last) leaf = description;
    else directories.push({ path: current, description, followSymlinks: symbolicLink });
  }
  const text = await content.readText(path);
  if (!leaf || !same(leaf, await filesystem.describePath(path, { followSymlinks: false }))) {
    throw new ExecutionEnvironmentError("path_conflict", "Scoped content changed during read", true, false);
  }
  for (const directory of directories) {
    if (!same(directory.description, await filesystem.describePath(directory.path, { followSymlinks: directory.followSymlinks }))) {
      throw new ExecutionEnvironmentError("path_conflict", "Scoped content parent changed during read", true, false);
    }
  }
  return text;
}
