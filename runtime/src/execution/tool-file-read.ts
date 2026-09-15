import { captureExecutionPermissionAuthority, taskPathWithin } from "./permission-authority.js";
import { resolveExecutionPermissionPath } from "./permission-path.js";
import { ExecutionEnvironmentError, type ExecutionPathDescription } from "./types.js";
import type { ExecutionWorkspace } from "./workspace.js";
import { sameExecutionPathDescription } from "./path-description.js";

function assertSame(before: ExecutionPathDescription, after: ExecutionPathDescription): void {
  if (!sameExecutionPathDescription(before, after)) {
    throw new ExecutionEnvironmentError("path_conflict", "Task file changed during read", true, false);
  }
}

/** Observe a task path (including absence) and retain the authority that authorized it. */
export async function resolveExecutionToolReadPath(workspace: ExecutionWorkspace, input: string,
  options: { readonly cwd?: string; readonly allowedPaths: readonly string[] }) {
  const authority = captureExecutionPermissionAuthority(workspace);
  const resolution = { cwd: options.cwd ?? authority.roleCwd, homePath: workspace.homePath };
  const resolve = (path: string) => resolveExecutionPermissionPath(workspace.environment, path, resolution);
  const evidence = await resolve(input);
  const roots = await Promise.all(options.allowedPaths.map(resolve));
  const validateAuthority = (current: typeof evidence): void => {
    authority.assertCurrent();
    const memory = authority.memoryAccess(current);
    if (memory === "deny" || (memory !== "allow" && !current.paths.every(path =>
      roots.some(root => root.description &&
        (BigInt(root.description.identity.mode) & 0o170000n) === 0o040000n &&
        root.paths.some(allowed => taskPathWithin(path, allowed)))))) {
      throw new ExecutionEnvironmentError("permission_denied", "Task file is outside allowed read authority", true, false);
    }
  };
  validateAuthority(evidence);
  const expected = evidence.description;
  const validate = async (): Promise<void> => {
    const current = await resolve(input);
    validateAuthority(current);
    if (expected && current.description) assertSame(expected, current.description);
    else if (expected !== current.description || evidence.canonicalPath !== current.canonicalPath) {
      throw new ExecutionEnvironmentError("path_conflict", "Task path changed during read", true, false);
    }
    for (let index = 0; index < roots.length; index++) {
      const root = roots[index]!;
      const fresh = await resolve(options.allowedPaths[index]!);
      if (root.description && fresh.description) assertSame(root.description, fresh.description);
      else if (root.description !== fresh.description) throw new ExecutionEnvironmentError("path_conflict", "Task read root changed", true, false);
    }
    authority.assertCurrent();
  };
  return { absolute: evidence.path, canonical: evidence.canonicalPath, validate, assertCurrent: authority.assertCurrent,
    executionBinding: workspace.environment.binding, description: expected,
    isMemoryPath: authority.memoryAccess(evidence) === "allow" };
}

/** Bind a file using task-only path evidence and retain the authority that authorized it. */
export async function bindExecutionToolFileRead(workspace: ExecutionWorkspace, input: string,
  options: { readonly cwd?: string; readonly allowedPaths: readonly string[] }) {
  const source = await resolveExecutionToolReadPath(workspace, input, options);
  const expected = source.description;
  if (!expected) throw new ExecutionEnvironmentError("not_found", "Task file does not exist", true, false);
  if ((BigInt(expected.identity.mode) & 0o170000n) !== 0o100000n) {
    throw new ExecutionEnvironmentError("unsupported_resource", "Task read requires a regular file", true, false);
  }
  const capability = await workspace.environment.filesystem.bindFileRead(source.canonical);
  const validate = async (): Promise<void> => {
    assertSame(expected, await capability.describe());
    await source.validate();
  };
  try { await validate(); }
  catch (error) {
    try { await capability.dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Task read acquisition and release failed", { cause: error }); }
    throw error;
  }
  return { ...source, description: expected, capability, validate };
}
