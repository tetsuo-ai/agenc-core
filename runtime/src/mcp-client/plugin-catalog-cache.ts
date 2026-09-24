/** Persistent, content-addressed MCP discovery for installed plugins. */
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { readPluginLifecycleRevision, withPluginLifecycleVerification } from "./plugin-lifecycle-revision.js";

export interface PluginCatalogIdentity {
  readonly pluginName: string;
  readonly serverName: string;
  readonly version?: string;
  readonly digest: string;
  readonly configFingerprint?: string;
  readonly cacheHome: string;
  readonly eager?: boolean;
  readonly idleTimeoutMs?: number;
  readonly maxProcesses?: number;
}

export interface PluginCatalog {
  readonly format: 1;
  readonly tools: readonly Record<string, unknown>[];
  readonly prompts?: readonly unknown[];
  readonly resources?: readonly unknown[];
}

/** Only known operating-system and editor bookkeeping is outside the payload. */
export function isPluginPayloadEntry(name: string): boolean {
  const base = name.split(/[\\/]/).at(-1) ?? name;
  return base !== ".DS_Store" && base !== "Thumbs.db" && base !== "desktop.ini" &&
    !base.startsWith("._") && !base.startsWith(".#") &&
    !base.endsWith("~") && !/^\..+\.sw[pon]$/.test(base) && !/^.+\.sw[pon]$/.test(base);
}

/** Hash executable payload, manifest, schemas, and launch files. */
export function hashInstalledPlugin(root: string): string {
  const hash = createHash("sha256");
  hash.update("agenc-plugin-tree-v3\0");
  const field = (value: string | Buffer): void => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length).update(bytes);
  };
  const visit = (path: string, relative: string): void => {
    const stat = lstatSync(path);
    field(relative);
    field(String(stat.mode & 0o555));
    if (stat.isSymbolicLink()) {
      field("link"); field(readlinkSync(path));
    } else if (stat.isDirectory()) {
      field("dir");
      for (const child of readdirSync(path).filter(isPluginPayloadEntry).sort()) visit(join(path, child), `${relative}/${child}`);
    } else if (stat.isFile()) {
      field("file"); field(createHash("sha256").update(readFileSync(path)).digest());
    } else {
      throw new Error(`Unsupported plugin entry: ${relative}`);
    }
  };
  visit(root, ".");
  return hash.digest("hex");
}

/** Materialize a private, content-addressed tree before registration publishes paths. */
export function snapshotInstalledPlugin(root: string, storageRoot: string, digest: string): string {
  if (!lstatSync(root).isDirectory()) throw new Error("Plugin snapshot root must be a directory");
  const realRoot = realpathSync(root);
  const checkLinks = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      if (isAbsolute(readlinkSync(path))) throw new Error("Plugin snapshot has an absolute symbolic link");
      const target = relative(realRoot, realpathSync(path));
      if (target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target)) {
        throw new Error("Plugin snapshot has a symbolic link outside its root");
      }
    } else if (stat.isDirectory()) {
      for (const child of readdirSync(path).filter(isPluginPayloadEntry)) checkLinks(join(path, child));
    }
  };
  // Files are sealed read-only; directories stay writable so Core's pruning,
  // plugin removal and a user deleting the cache can always remove them.
  const seal = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) for (const child of readdirSync(path)) seal(join(path, child));
    if (stat.isFile()) chmodSync(path, stat.mode & 0o555);
  };
  const removeTemporary = (path: string): void => {
    if (!existsSync(path)) return;
    const reopen = (entry: string): void => {
      const stat = lstatSync(entry);
      if (!stat.isDirectory()) return;
      chmodSync(entry, stat.mode | 0o700);
      for (const child of readdirSync(entry)) reopen(join(entry, child));
    };
    reopen(path);
    rmSync(path, { recursive: true, force: true });
  };
  checkLinks(root);
  const directory = join(storageRoot, "cache", "mcp-install-snapshots");
  const destination = join(directory, digest);
  if (existsSync(destination)) {
    if (hashInstalledPlugin(destination) !== digest) throw new Error("Installed plugin snapshot changed");
    seal(destination);
    return destination;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    cpSync(root, temporary, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true,
      filter: (source) => source === root || isPluginPayloadEntry(source) });
    if (hashInstalledPlugin(temporary) !== digest || hashInstalledPlugin(root) !== digest) {
      throw new Error("Installed plugin changed while creating its snapshot");
    }
    seal(temporary);
    try { renameSync(temporary, destination); }
    catch (error) {
      if (!existsSync(destination) || hashInstalledPlugin(destination) !== digest) throw error;
    }
  } finally { removeTemporary(temporary); }
  return destination;
}

// Full verification and snapshot copying run on a worker. Keep this walker in
// lockstep with the synchronous admin API; parity is covered by snapshot tests.
const installationWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { createHash } = require("node:crypto");
const { chmodSync, cpSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, mkdirSync, renameSync, rmSync } = require("node:fs");
const { isAbsolute, join, relative, sep } = require("node:path");
const isPluginPayloadEntry = (name) => {
  const base = name.split(/[\\\\/]/).at(-1) ?? name;
  return base !== ".DS_Store" && base !== "Thumbs.db" && base !== "desktop.ini" &&
    !base.startsWith("._") && !base.startsWith(".#") &&
    !base.endsWith("~") && !/^\\..+\\.sw[pon]$/.test(base) && !/^.+\\.sw[pon]$/.test(base);
};
const hashInstalledPlugin = (root) => {
  const hash = createHash("sha256");
  hash.update("agenc-plugin-tree-v3\\0");
  const field = (value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length).update(bytes);
  };
  const visit = (path, relativePath) => {
    const stat = lstatSync(path);
    field(relativePath);
    field(String(stat.mode & 0o555));
    if (stat.isSymbolicLink()) {
      field("link"); field(readlinkSync(path));
    } else if (stat.isDirectory()) {
      field("dir");
      for (const child of readdirSync(path).filter(isPluginPayloadEntry).sort()) visit(join(path, child), relativePath + "/" + child);
    } else if (stat.isFile()) {
      field("file"); field(createHash("sha256").update(readFileSync(path)).digest());
    } else throw new Error("Unsupported plugin entry: " + relativePath);
  };
  visit(root, ".");
  return hash.digest("hex");
};
const snapshotInstalledPlugin = (root, storageRoot, digest) => {
  if (!lstatSync(root).isDirectory()) throw new Error("Plugin snapshot root must be a directory");
  const realRoot = realpathSync(root);
  const checkLinks = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      if (isAbsolute(readlinkSync(path))) throw new Error("Plugin snapshot has an absolute symbolic link");
      const target = relative(realRoot, realpathSync(path));
      if (target === ".." || target.startsWith(".." + sep) || isAbsolute(target)) throw new Error("Plugin snapshot has a symbolic link outside its root");
    } else if (stat.isDirectory()) {
      for (const child of readdirSync(path).filter(isPluginPayloadEntry)) checkLinks(join(path, child));
    }
  };
  const seal = (path) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) for (const child of readdirSync(path)) seal(join(path, child));
    if (stat.isFile()) chmodSync(path, stat.mode & 0o555);
  };
  const removeTemporary = (path) => {
    if (!existsSync(path)) return;
    const reopen = (entry) => {
      const stat = lstatSync(entry);
      if (!stat.isDirectory()) return;
      chmodSync(entry, stat.mode | 0o700);
      for (const child of readdirSync(entry)) reopen(join(entry, child));
    };
    reopen(path);
    rmSync(path, { recursive: true, force: true });
  };
  checkLinks(root);
  const directory = join(storageRoot, "cache", "mcp-install-snapshots");
  const destination = join(directory, digest);
  if (existsSync(destination)) {
    if (hashInstalledPlugin(destination) !== digest) throw new Error("Installed plugin snapshot changed");
    seal(destination);
    return destination;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = destination + "." + process.pid + "." + Math.random().toString(16).slice(2) + ".tmp";
  try {
    cpSync(root, temporary, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true,
      filter: (source) => source === root || isPluginPayloadEntry(source) });
    if (hashInstalledPlugin(temporary) !== digest || hashInstalledPlugin(root) !== digest) throw new Error("Installed plugin changed while creating its snapshot");
    seal(temporary);
    try { renameSync(temporary, destination); }
    catch (error) { if (!existsSync(destination) || hashInstalledPlugin(destination) !== digest) throw error; }
  } finally { removeTemporary(temporary); }
  return destination;
};
try {
  if (workerData.kind === "snapshot") {
    const digest = hashInstalledPlugin(workerData.root);
    const snapshotRoot = snapshotInstalledPlugin(workerData.root, workerData.storageRoot, digest);
    parentPort.postMessage({ digest, snapshotRoot });
  } else {
    const actualRoot = hashInstalledPlugin(workerData.root);
    const actualSnapshot = workerData.snapshotRoot ? hashInstalledPlugin(workerData.snapshotRoot) : undefined;
    parentPort.postMessage({ valid: actualRoot === workerData.digest && (!actualSnapshot || actualSnapshot === workerData.digest) });
  }
} catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
`;

function installationWorker<T>(data: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(installationWorkerSource, { eval: true, execArgv: [], workerData: data });
    worker.once("message", (value: T & { error?: string }) => {
      if (value.error) reject(new Error(value.error));
      else resolve(value);
    });
    worker.once("error", reject);
    worker.once("exit", code => { if (code !== 0) reject(new Error(`Plugin installation worker exited with ${code}`)); });
  });
}

const snapshotTasks = new Map<string, Promise<{ digest: string; snapshotRoot: string }>>();

/** Verify and copy a candidate before its registration can be published. */
export function snapshotInstalledPluginOffThread(root: string, storageRoot: string): Promise<{ digest: string; snapshotRoot: string }> {
  const key = JSON.stringify([root, storageRoot]);
  let task = snapshotTasks.get(key);
  if (!task) {
    task = installationWorker({ kind: "snapshot", root, storageRoot });
    snapshotTasks.set(key, task);
    void task.finally(() => { if (snapshotTasks.get(key) === task) snapshotTasks.delete(key); }).catch(() => undefined);
  }
  return task;
}

export interface VerifiedPluginGeneration {
  readonly version: number;
  readonly lifecycleRevision: string | undefined;
  isCurrent(version: number): boolean;
  subscribe(listener: () => void): () => void;
  /** An acquisition owns this lease from before verification begins. */
  release(): void;
  /** Revoke this exact verified generation, leaving later generations intact. */
  retire(): void;
}

interface GenerationState {
  readonly root: string;
  readonly pluginName: string | undefined;
  readonly cacheHome: string | undefined;
  lifecycleRevision: string | undefined;
  version: number;
  invalidated: boolean;
  owners: number;
  listeners: Set<() => void>;
  verified: Promise<void>;
}

const generations = new Map<string, GenerationState>();

function retireGeneration(key: string, state: GenerationState): void {
  if (state.invalidated) return;
  state.invalidated = true;
  state.version++;
  if (generations.get(key) === state) generations.delete(key);
  for (const listener of [...state.listeners]) {
    try { listener(); }
    catch { /* The invalidated state still blocks dispatch in every owner. */ }
  }
}

/**
 * The plugin lifecycle is the revocation authority. A local process editing
 * Core's snapshot or an installation in place is outside this protection,
 * just as editing any installed executable is. Updates use plugin commands.
 * There is deliberately no filesystem watcher or polling on either tree.
 */
export function retireVerifiedPluginGenerations(pluginName: string | undefined, root?: string, cacheHome?: string): void {
  for (const [key, state] of generations) {
    if ((pluginName !== undefined && state.pluginName !== pluginName) || (root !== undefined && state.root !== root) ||
      (cacheHome !== undefined && state.cacheHome !== cacheHome)) continue;
    retireGeneration(key, state);
  }
}

/** Share one off-thread verification across managers, with a lease per caller. */
export async function acquireVerifiedPluginGeneration(
  root: string, snapshotRoot: string | undefined, digest: string, pluginName?: string, cacheHome?: string,
): Promise<VerifiedPluginGeneration> {
  const key = JSON.stringify([root, snapshotRoot, digest, pluginName, cacheHome]);
  let state = generations.get(key);
  if (state && state.lifecycleRevision !== undefined && cacheHome && pluginName) {
    const prior = state;
    try {
      if (readPluginLifecycleRevision(cacheHome, pluginName) !== prior.lifecycleRevision) {
        retireGeneration(key, prior);
        state = undefined;
      }
    } catch {
      retireGeneration(key, prior);
      state = undefined;
    }
  }
  if (!state) {
    state = {
      root, pluginName, cacheHome, lifecycleRevision: undefined, version: 0, invalidated: false, owners: 0,
      listeners: new Set(), verified: Promise.resolve(),
    };
    const created = state;
    const verify = async (): Promise<void> => {
      const { valid } = await installationWorker<{ valid: boolean }>({ kind: "verify", root, snapshotRoot, digest });
      if (!valid) throw new Error("Installed plugin changed during verification");
    };
    created.verified = cacheHome && pluginName
      ? withPluginLifecycleVerification(cacheHome, pluginName, async revision => {
          created.lifecycleRevision = revision;
          await verify();
        })
      : verify();
    generations.set(key, created);
  }
  // Increment before the first await: another manager cannot release the
  // shared verification while this acquisition is still pending.
  state.owners++;
  const owned = state;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    owned.owners--;
    if (owned.owners === 0 && generations.get(key) === owned) generations.delete(key);
  };
  try {
    await owned.verified;
    let revisionCurrent = true;
    if (cacheHome && pluginName) {
      try { revisionCurrent = readPluginLifecycleRevision(cacheHome, pluginName) === owned.lifecycleRevision; }
      catch { revisionCurrent = false; }
    }
    if (owned.invalidated || !revisionCurrent) {
      retireGeneration(key, owned);
      throw new Error("Installed plugin generation changed");
    }
  } catch (error) {
    release();
    throw error;
  }
  return {
    get version() { return owned.version; },
    get lifecycleRevision() { return owned.lifecycleRevision; },
    isCurrent: version => {
      if (!owned.invalidated && cacheHome && pluginName) {
        try {
          if (readPluginLifecycleRevision(cacheHome, pluginName) !== owned.lifecycleRevision) retireGeneration(key, owned);
        } catch {
          // A missing or unreadable revision cannot authorize dispatch.
          retireGeneration(key, owned);
        }
      }
      return !owned.invalidated && owned.version === version;
    },
    subscribe(listener) {
      owned.listeners.add(listener);
      return () => { owned.listeners.delete(listener); };
    },
    release,
    retire: () => retireGeneration(key, owned),
  };
}

/** One-way identity: cache filenames never reveal resolved environment values. */
export function fingerprintPluginCatalogConfig(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function cachePath(identity: PluginCatalogIdentity): string {
  const key = createHash("sha256").update(JSON.stringify([
    "catalog-v2", identity.pluginName, identity.serverName, identity.version ?? "", identity.digest,
    identity.configFingerprint ?? "",
  ])).digest("hex");
  return join(identity.cacheHome, "cache", "plugin-mcp-catalogs", `${key}.json`);
}

const discoveries = new Map<string, Promise<void>>();

/** Prevent concurrent sessions from priming the same installed bytes twice. */
export async function primePluginCatalogSingleFlight(identity: PluginCatalogIdentity, discover: () => Promise<void>): Promise<void> {
  const key = cachePath(identity);
  let task = discoveries.get(key);
  if (!task) {
    task = discover();
    discoveries.set(key, task);
  }
  try { await task; }
  finally { if (discoveries.get(key) === task) discoveries.delete(key); }
}

export function readPluginCatalog(identity: PluginCatalogIdentity): PluginCatalog | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath(identity), "utf8"));
    if (typeof parsed !== "object" || parsed === null || (parsed as PluginCatalog).format !== 1 ||
        !Array.isArray((parsed as PluginCatalog).tools)) return undefined;
    return parsed as PluginCatalog;
  } catch { return undefined; }
}

export function writePluginCatalog(identity: PluginCatalogIdentity, catalog: PluginCatalog): void {
  const path = cachePath(identity);
  const directory = join(identity.cacheHome, "cache", "plugin-mcp-catalogs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, JSON.stringify(catalog), { mode: 0o600 });
  renameSync(temporary, path);
}
