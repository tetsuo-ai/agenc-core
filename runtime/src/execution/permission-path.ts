import { posix } from "node:path";
import { ContentFilesystem, contentPathMissing, type ContentExecutionEnvironment } from "./content-filesystem.js";
import { ExecutionEnvironmentError, type ExecutionPathDescription } from "./types.js";

export interface ExecutionPermissionPath {
  readonly path: string;
  /** Lexical input and every symlink expansion, including intermediate targets. */
  readonly paths: readonly string[];
  readonly canonicalPath: string;
  readonly description: ExecutionPathDescription | null;
  readonly symlinkPaths: readonly string[];
  readonly leafSymlink: boolean;
}

function validate(path: string): void {
  if (!path || path.includes("\0") || Buffer.byteLength(path) >= 16384 || Buffer.from(path).toString() !== path) {
    throw new ExecutionEnvironmentError("invalid_request", "Invalid task permission path", false);
  }
}

function same(left: ExecutionPathDescription, right: ExecutionPathDescription): boolean {
  return left.canonicalPath === right.canonicalPath &&
    (Object.keys(left.identity) as (keyof typeof left.identity)[]).every(key => left.identity[key] === right.identity[key]);
}

/**
 * Resolve permission evidence entirely in the selected task filesystem. This is
 * observation, not a mutation capability: the eventual operation must still
 * bind/revalidate its own descriptors. Never caches across calls or generations.
 */
export async function resolveExecutionPermissionPath(
  environment: ContentExecutionEnvironment,
  input: string,
  options: { readonly cwd: string; readonly homePath?: string },
): Promise<ExecutionPermissionPath> {
  validate(input); validate(options.cwd);
  if (!posix.isAbsolute(options.cwd)) throw new ExecutionEnvironmentError("invalid_request", "Task permission cwd must be absolute", false);
  let path = input;
  if (path === "~" || path.startsWith("~/")) {
    if (options.homePath === undefined) throw new ExecutionEnvironmentError("environment_not_ready", "Task home is required for tilde expansion", false);
    validate(options.homePath);
    if (!posix.isAbsolute(options.homePath)) throw new ExecutionEnvironmentError("invalid_request", "Task home must be absolute", false);
    path = options.homePath + path.slice(1);
  }
  if (!posix.isAbsolute(path)) path = options.cwd + "/" + path;
  validate(path);
  const filesystem = new ContentFilesystem(environment).environment!.filesystem;
  const paths = new Set([path]);
  const symlinkPaths = new Set<string>();
  let leafSymlink = false;
  const observations = new Map<string, ExecutionPathDescription>();
  const conflict = (): never => { throw new ExecutionEnvironmentError("path_conflict", "Task permission path changed during resolution", true, false); };
  const observe = async (name: string): Promise<ExecutionPathDescription> => {
    const description = await filesystem.describePath(name, { followSymlinks: false });
    const previous = observations.get(name);
    if (previous && !same(previous, description)) conflict();
    observations.set(name, description);
    return description;
  };
  const components = (value: string) => [...value.split("/").filter(Boolean), ...(value.endsWith("/") ? ["."] : [])];
  let remaining = components(path), current = "/", links = 0, missing: string | undefined;
  let description: ExecutionPathDescription | null = await observe("/");
  while (remaining.length > 0) {
    const component = remaining.shift()!;
    if (component === ".") continue;
    if (component === "..") { current = posix.dirname(current); description = await observe(current); continue; }
    const candidate = posix.join(current, component);
    try { description = await observe(candidate); }
    catch (error) {
      if (!contentPathMissing(error)) throw error;
      // A missing directory followed by '..' cannot be traversed by the kernel;
      // do not invent a canonical destination by normalizing that sequence.
      if (remaining.includes("..")) throw error;
      missing = candidate;
      current = posix.join(candidate, ...remaining);
      description = null;
      break;
    }
    const kind = BigInt(description.identity.mode) & 0o170000n;
    if (kind === 0o120000n) {
      symlinkPaths.add(candidate);
      // Retain the canonical spelling of the link itself as well as its raw
      // expansion. Otherwise '/app/../alias' followed by a second link could
      // hide an explicit '/alias' deny from literal canonical rule matchers.
      paths.add(candidate + (remaining.length ? "/" + remaining.join("/") : ""));
      if (remaining.length === 0) leafSymlink = true;
      if (++links > 40) throw new ExecutionEnvironmentError("unsupported_resource", "Task permission path exceeds the symlink limit", true, false);
      const target = await filesystem.readLink(description);
      validate(target);
      // Preserve '..' until after preceding symlinks have been traversed.
      const expanded = (posix.isAbsolute(target) ? target : (current === "/" ? "/" : current + "/") + target) +
        (remaining.length ? "/" + remaining.join("/") : "");
      validate(expanded); paths.add(expanded);
      remaining = components(expanded); current = "/";
      description = await observe("/");
      continue;
    }
    if ((remaining.length > 0 && kind !== 0o040000n) || (kind !== 0o040000n && kind !== 0o100000n)) {
      throw new ExecutionEnvironmentError("unsupported_resource", "Task permission path contains a non-directory parent or special resource", true, false);
    }
    current = description.canonicalPath;
  }
  for (const [name, expected] of observations) {
    if (!same(expected, await filesystem.describePath(name, { followSymlinks: false }))) conflict();
  }
  if (missing !== undefined) {
    try { await filesystem.describePath(missing, { followSymlinks: false }); }
    catch (error) { if (!contentPathMissing(error)) throw error; missing = undefined; }
    if (missing !== undefined) conflict();
  }
  paths.add(current);
  return Object.freeze({ path, paths: Object.freeze([...paths]), canonicalPath: current, description,
    symlinkPaths: Object.freeze([...symlinkPaths]), leafSymlink });
}
