/** Cross-process revocation tokens for installed plugin MCP generations. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { acquireConfigAuthorityLocks, runWithConfigAuthorityLocks } from "../config/authority-lock.js";
import { writeDurableAtomicFileSync } from "../utils/durable-atomic-file.js";

const observations = new Map<string, { identity: string; revision: string }>();

function revisionDirectory(home: string): string {
  return join(home, "cache", "plugin-lifecycle-revisions");
}

export function pluginLifecycleRevisionPath(home: string, pluginName: string): string {
  const key = createHash("sha256").update(pluginName).digest("hex");
  return join(revisionDirectory(home), `${key}.revision`);
}

/** A stat is the normal admission cost; atomic replacement changes its identity. */
export function readPluginLifecycleRevision(home: string, pluginName: string): string {
  const path = pluginLifecycleRevisionPath(home, pluginName);
  for (let attempt = 0; attempt < 3; attempt++) {
    const stat = statSync(path, { bigint: true });
    const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
    const cached = observations.get(path);
    if (cached?.identity === identity) return cached.revision;
    const revision = readFileSync(path, "utf8").trim();
    const after = statSync(path, { bigint: true });
    if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}` !== identity) continue;
    if (!revision) throw new Error(`Empty plugin lifecycle revision: ${path}`);
    observations.set(path, { identity, revision });
    return revision;
  }
  throw new Error(`Plugin lifecycle revision changed during admission: ${path}`);
}

function ensurePluginLifecycleRevisionUnlocked(home: string, pluginName: string): void {
  const path = pluginLifecycleRevisionPath(home, pluginName);
  if (existsSync(path)) return;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeDurableAtomicFileSync(path, temporary, "0\n");
}

/** Verification cannot observe pre-replacement bytes under a new revision. */
export async function withPluginLifecycleVerification<T>(home: string, pluginName: string, operation: (revision: string) => Promise<T>): Promise<T> {
  const path = pluginLifecycleRevisionPath(home, pluginName);
  const outcome = await runWithConfigAuthorityLocks([path], async () => {
    ensurePluginLifecycleRevisionUnlocked(home, pluginName);
    return operation(readPluginLifecycleRevision(home, pluginName));
  });
  if (outcome.status === "failed") throw outcome.error;
  return outcome.value;
}

function bumpPathUnlocked(path: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeDurableAtomicFileSync(path, temporary, `${randomUUID()}\n`);
  observations.delete(path);
}

function bumpUnlocked(home: string, pluginName: string): void {
  bumpPathUnlocked(pluginLifecycleRevisionPath(home, pluginName));
}

/** The callback owns the per-plugin lifecycle lock through replacement/removal. */
export async function withPluginLifecycleMutation<T>(home: string, pluginName: string, operation: () => Promise<T>): Promise<T> {
  const path = pluginLifecycleRevisionPath(home, pluginName);
  const outcome = await runWithConfigAuthorityLocks([path], async () => {
    bumpUnlocked(home, pluginName);
    return operation();
  });
  if (outcome.status === "failed") throw outcome.error;
  return outcome.value;
}

export interface PluginLifecyclePublication {
  publish<T>(operation: () => T): T;
  release(): Promise<void>;
}

/** Prepared ConfigStore reloads hold these locks through commit or rollback. */
export async function acquirePluginLifecyclePublication(home: string, pluginNames: readonly string[] | "all"): Promise<PluginLifecyclePublication> {
  const directory = revisionDirectory(home);
  let paths: string[];
  if (pluginNames === "all") {
    try { paths = readdirSync(directory).filter(name => name.endsWith(".revision")).map(name => join(directory, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      paths = [];
    }
  } else {
    paths = pluginNames.map(name => pluginLifecycleRevisionPath(home, name));
  }
  paths = [...new Set(paths)].sort();
  const unlock = await acquireConfigAuthorityLocks(paths);
  let released = false;
  return {
    publish<T>(operation: () => T): T {
      if (released) throw new Error("Plugin lifecycle publication already settled");
      for (const path of paths) bumpPathUnlocked(path);
      return operation();
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      const outcome = await unlock();
      if (outcome.postOperationReleaseErrors.length > 0) {
        throw new AggregateError(outcome.postOperationReleaseErrors, "Plugin lifecycle lock release failed");
      }
    },
  };
}
