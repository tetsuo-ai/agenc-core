import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { readOnlyDelegationReadPathAllowed } from "../../permissions/readonly-read-guard.js";
import { MAX_GREP_DECODED_BYTES, MAX_GREP_RESULTS, MAX_GREP_WALL_MS } from "./ripgrep-protocol.js";

export async function collectGuardedSearchCandidates(params: {
  readonly root: string;
  readonly toolArgs: object;
  readonly signal?: AbortSignal;
  readonly acceptPath: (path: string, directory: boolean) => boolean | Promise<boolean>;
}): Promise<Array<{ readonly path: string; readonly modifiedMs: number }>> {
  const candidates: Array<{ readonly path: string; readonly modifiedMs: number }> = [];
  const pending = [{ path: params.root, depth: 0 }];
  const startedAt = Date.now();
  let visited = 0;
  let pathBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    if (directory.depth > 256) throw new Error("Search exceeds the directory depth limit");
    if (!readOnlyDelegationReadPathAllowed(params.toolArgs, directory.path)) continue;
    if (!(await params.acceptPath(directory.path, true))) continue;
    if (!readOnlyDelegationReadPathAllowed(params.toolArgs, directory.path)) continue;
    const handle = await opendir(directory.path);
    for await (const entry of handle) {
      if (params.signal?.aborted) throw new Error("Search aborted");
      if (Date.now() - startedAt > MAX_GREP_WALL_MS) throw new Error("Search timed out");
      if (++visited > MAX_GREP_RESULTS) throw new Error("Search exceeds the candidate safety limit");
      const path = join(directory.path, entry.name);
      pathBytes += Buffer.byteLength(path, "utf8");
      if (pathBytes > MAX_GREP_DECODED_BYTES) throw new Error("Search exceeds the candidate path byte limit");
      if (!readOnlyDelegationReadPathAllowed(params.toolArgs, path)) continue;
      if (entry.isSymbolicLink()) continue;
      const identity = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (identity === undefined || identity.isSymbolicLink()) continue;
      if (identity.isDirectory()) {
        pending.push({ path, depth: directory.depth + 1 });
      } else if (identity.isFile() && await params.acceptPath(path, false)) {
        if (!readOnlyDelegationReadPathAllowed(params.toolArgs, path)) continue;
        candidates.push({ path, modifiedMs: identity.mtimeMs });
      }
    }
  }
  return candidates;
}
