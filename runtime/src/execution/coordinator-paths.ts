import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { posix, join } from "node:path";
import { assertSameExecutionEnvironment, readExecutionEnvironmentBinding } from "./binding.js";
import { resolveExecutionPermissionPath } from "./permission-path.js";
import { ExecutionEnvironmentError, executionEnvironmentCacheKey } from "./types.js";
import type { ExecutionWorkspace } from "./workspace.js";
import { sameExecutionPathDescription } from "./path-description.js";

/** A synchronous coordinator may use only paths prepared by its protected ingress. */
export class ExecutionCoordinatorPaths {
  readonly binding;
  readonly workspace: ExecutionWorkspace;
  readonly #scope = new AsyncLocalStorage<{ readonly paths: ReadonlyMap<string, string>; readonly cwd: string; readonly home?: string; active: boolean }>();
  constructor(workspace: ExecutionWorkspace) {
    this.binding = readExecutionEnvironmentBinding(workspace.environment.binding);
    this.workspace = Object.freeze({ ...workspace,
      environment: Object.freeze({ binding: this.binding, filesystem: workspace.environment.filesystem }) });
  }

  storageHome(controllerHome: string): string {
    const key = createHash("sha256").update(executionEnvironmentCacheKey(this.binding, "")).digest("hex");
    return join(controllerHome, "execution-workspaces", key);
  }

  /** Persisted/token paths are already admitted identities, never fresh path lookups. */
  identity(path: string): string {
    if (!posix.isAbsolute(path) || path !== posix.normalize(path) || path.includes("\0") ||
        Buffer.byteLength(path) >= 16384 || Buffer.from(path).toString() !== path) {
      throw new ExecutionEnvironmentError("invalid_request", "Invalid canonical task workspace identity", false);
    }
    return path;
  }

  canonicalize(path: string, cwd?: string): string {
    const scope = this.#scope.getStore();
    const expanded = (path === "~" || path.startsWith("~/")) && scope?.home !== undefined ? scope.home + path.slice(1) : path;
    const absolute = posix.isAbsolute(expanded) ? expanded : (cwd ?? scope?.cwd ?? this.workspace.projectRoot) + "/" + expanded;
    const canonical = scope?.active ? scope.paths.get(absolute) : undefined;
    if (canonical === undefined) {
      throw new ExecutionEnvironmentError("environment_not_ready", "Task coordinator paths require protected preparation before use", false);
    }
    return canonical;
  }

  async prepare<T>(paths: readonly string[], operation: () => T | Promise<T>, workspace: ExecutionWorkspace = this.workspace): Promise<T> {
    assertSameExecutionEnvironment(this.binding, workspace.environment.binding);
    if (paths.length > 4096) throw new ExecutionEnvironmentError("invalid_request", "Too many coordinator paths", false);
    const entries = new Map<string, string>();
    const observations = new Map<string, Awaited<ReturnType<typeof resolveExecutionPermissionPath>>>();
    // The registry identity is shared, but each ingress supplies its own owner-
    // scoped filesystem client. Never borrow an earlier session's authority.
    const environment = Object.freeze({ binding: this.binding, filesystem: workspace.environment.filesystem });
    const cwd = workspace.projectRoot, homePath = workspace.homePath;
    const resolve = (input: string) => resolveExecutionPermissionPath(environment, input, { cwd, homePath });
    for (const input of new Set([cwd, ...paths])) {
      const evidence = await resolve(input);
      observations.set(input, evidence);
      for (const spelling of [evidence.path, evidence.canonicalPath]) {
        const prior = entries.get(spelling);
        if (prior !== undefined && prior !== evidence.canonicalPath) {
          throw new ExecutionEnvironmentError("path_conflict", "Task coordinator path identity changed during preparation", true, false);
        }
        entries.set(spelling, evidence.canonicalPath);
      }
    }
    for (const [input, expected] of observations) {
      const current = await resolve(input);
      if (current.canonicalPath !== expected.canonicalPath || JSON.stringify(current.paths) !== JSON.stringify(expected.paths) ||
          (expected.description && current.description ? !sameExecutionPathDescription(expected.description, current.description) :
            expected.description !== current.description)) {
        throw new ExecutionEnvironmentError("path_conflict", "Task coordinator paths changed before admission", true, false);
      }
    }
    const scope = { paths: entries, cwd, home: homePath, active: true };
    try { return await this.#scope.run(scope, operation); }
    finally { scope.active = false; }
  }
}
