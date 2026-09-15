import { posix } from "node:path";
import { ContentFilesystem, rethrowContentAuthorityError, type ContentExecutionEnvironment } from "../execution/content-filesystem.js";
import { ExecutionEnvironmentError } from "../execution/types.js";

interface ExecutionSkillWatcherOptions {
  readonly environment: ContentExecutionEnvironment;
  readonly getRoots: () => readonly string[];
  readonly changed: (paths: readonly string[]) => void;
  readonly failed: (error: unknown) => void;
  readonly intervalMs?: number;
}

/** Poll protected metadata; task paths never enter the controller's OS watcher. */
export async function watchExecutionSkillRoots(options: ExecutionSkillWatcherOptions): Promise<{ close(): Promise<void> }> {
  const filesystem = new ContentFilesystem(options.environment);
  const environment = filesystem.environment!;
  const interval = options.intervalMs ?? 1_000;
  if (!Number.isInteger(interval) || interval < 10 || interval > 60_000) {
    throw new ExecutionEnvironmentError("invalid_request", "Skill polling interval must be 10–60000 ms", false);
  }
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let reportingFailure: unknown;

  async function snapshot(): Promise<Map<string, string>> {
    const metadata = new Map<string, string>();
    const visited = new Set<string>();
    const queue = [...new Set(options.getRoots())];
    for (let index = 0; index < queue.length; index++) {
      if (closed) return metadata;
      if (index >= 1_000_000) throw new ExecutionEnvironmentError("directory_limit", "Skill watch tree exceeds its entry bound", false);
      const path = queue[index]!;
      if (!posix.isAbsolute(path)) throw new ExecutionEnvironmentError("invalid_request", "Task watch paths must be absolute", false);
      try {
        const entry = await environment.filesystem.describePath(path, { followSymlinks: false });
        const followed = (BigInt(entry.identity.mode) & 0o170000n) === 0o120000n
          ? await environment.filesystem.describePath(path) : entry;
        metadata.set(path, JSON.stringify([entry, followed]));
        if ((BigInt(followed.identity.mode) & 0o170000n) !== 0o040000n || visited.has(followed.canonicalPath)) continue;
        visited.add(followed.canonicalPath);
        for (const child of await filesystem.readDirectory(path)) {
          if (child.name === ".git") continue;
          if (queue.length >= 1_000_000) throw new ExecutionEnvironmentError("directory_limit", "Skill watch tree exceeds its entry bound", true, false);
          queue.push(posix.join(path, child.name));
        }
      } catch (error) {
        rethrowContentAuthorityError(error);
        // An unstable enumeration is not a valid new snapshot. Retry it later.
        if (error instanceof ExecutionEnvironmentError && error.code === "path_conflict") throw error;
        metadata.set(path, JSON.stringify({ unavailable: error instanceof ExecutionEnvironmentError ? error.code : "read_error" }));
      }
    }
    return metadata;
  }

  let previous = await snapshot();
  async function poll(): Promise<void> {
    try {
      const next = await snapshot();
      if (closed) return;
      const changed = [...new Set([...previous.keys(), ...next.keys()])]
        .filter((path) => previous.get(path) !== next.get(path)).sort();
      previous = next;
      if (changed.length > 0) options.changed(changed);
    } catch (error) {
      if (closed) return;
      if (!(error instanceof ExecutionEnvironmentError && error.code === "path_conflict")) {
        closed = true;
        try { options.failed(error); }
        catch (reportError) {
          reportingFailure = new AggregateError([error, reportError], "Skill watch and error reporting failed", { cause: error });
        }
      }
    } finally {
      if (!closed) schedule();
    }
  }
  function schedule(): void {
    timer = setTimeout(() => { pending = poll(); }, interval);
    timer.unref();
  }
  schedule();
  return { close: async () => {
    closed = true;
    clearTimeout(timer);
    await pending;
    if (reportingFailure !== undefined) throw reportingFailure;
  } };
}
