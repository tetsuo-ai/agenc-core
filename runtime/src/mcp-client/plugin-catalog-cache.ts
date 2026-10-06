/** Persistent, content-addressed MCP discovery for installed plugins. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { Worker } from "node:worker_threads";

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
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
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
const { createHash, randomUUID } = require("node:crypto");
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
  const temporary = destination + "." + process.pid + "." + randomUUID() + ".tmp";
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
  isCurrent(version: number): boolean;
  subscribe(listener: () => void): () => void;
  /** Release the manager's reference after shutdown or refresh. */
  release(): void;
  /** Revoke this exact verified generation, leaving later generations intact. */
  retire(): void;
}

interface GenerationState {
  version: number;
  invalidated: boolean;
  listeners: Set<() => void>;
}

function retireGeneration(state: GenerationState): void {
  if (state.invalidated) return;
  state.invalidated = true;
  state.version++;
  for (const listener of [...state.listeners]) {
    try { listener(); }
    catch { /* The invalidated state still blocks dispatch in every owner. */ }
  }
}

/** Each manager owns its verified generation; a refresh retires only that owner. */
export async function acquireVerifiedPluginGeneration(
  root: string, snapshotRoot: string | undefined, digest: string,
): Promise<VerifiedPluginGeneration> {
  const { valid } = await installationWorker<{ valid: boolean }>({ kind: "verify", root, snapshotRoot, digest });
  if (!valid) throw new Error("Installed plugin changed during verification");
  const state: GenerationState = {
    version: 0, invalidated: false, listeners: new Set(),
  };
  return {
    get version() { return state.version; },
    isCurrent: version => !state.invalidated && state.version === version,
    subscribe(listener) {
      state.listeners.add(listener);
      return () => { state.listeners.delete(listener); };
    },
    release: () => { state.listeners.clear(); },
    retire: () => retireGeneration(state),
  };
}

/** One-way identity: cache filenames never reveal resolved environment values. */
export function fingerprintPluginCatalogConfig(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function catalogRoot(cacheHome: string): string {
  return join(cacheHome, "cache", "plugin-mcp-catalogs");
}

/** Each plugin's catalogs share one directory, so they can be removed together. */
function pluginCatalogDirectory(cacheHome: string, pluginName: string): string {
  const key = createHash("sha256").update(JSON.stringify(["catalog-plugin-v1", pluginName])).digest("hex");
  return join(catalogRoot(cacheHome), key);
}

function cachePath(identity: PluginCatalogIdentity): string {
  const key = createHash("sha256").update(JSON.stringify([
    "catalog-v2", identity.pluginName, identity.serverName, identity.version ?? "", identity.digest,
    identity.configFingerprint ?? "",
  ])).digest("hex");
  return join(pluginCatalogDirectory(identity.cacheHome, identity.pluginName), `${key}.json`);
}

/** The earlier flat layout kept every catalog file directly in the root. */
function flatLayoutCatalogFiles(cacheHome: string): string[] {
  let entries;
  try { entries = readdirSync(catalogRoot(cacheHome), { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.filter(entry => entry.isFile()).map(entry => join(catalogRoot(cacheHome), entry.name));
}

/**
 * Remove every catalog discovered for a plugin, and catalogs from the earlier
 * flat layout, which cannot be attributed to a plugin.
 */
export function removePluginCatalogs(cacheHome: string, pluginName: string): void {
  rmSync(pluginCatalogDirectory(cacheHome, pluginName), { recursive: true, force: true });
  for (const file of flatLayoutCatalogFiles(cacheHome)) rmSync(file, { force: true });
}

const sweptCatalogHomes = new Set<string>();

/**
 * Flat-layout catalogs are never read and may hold saved secrets. The first
 * catalog load in a process removes them, best effort: a file that cannot be
 * removed now is retried when the next process starts.
 */
export function sweepFlatLayoutPluginCatalogs(cacheHome: string): void {
  if (sweptCatalogHomes.has(cacheHome)) return;
  sweptCatalogHomes.add(cacheHome);
  let files: string[];
  try { files = flatLayoutCatalogFiles(cacheHome); }
  catch { return; }
  for (const file of files) {
    try { rmSync(file, { force: true }); }
    catch { /* Retried when the next process starts. */ }
  }
}

const discoveries = new Map<string, Promise<PluginCatalog | undefined>>();

/**
 * Prevent concurrent sessions from priming the same installed bytes twice.
 * Every caller receives the discovered catalog in memory, including one that
 * is never written because it carries a saved secret.
 */
export async function primePluginCatalogSingleFlight(
  identity: PluginCatalogIdentity, discover: () => Promise<PluginCatalog | undefined>,
): Promise<PluginCatalog | undefined> {
  const key = cachePath(identity);
  let task = discoveries.get(key);
  if (!task) {
    task = discover();
    discoveries.set(key, task);
  }
  try { return await task; }
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
  const directory = pluginCatalogDirectory(identity.cacheHome, identity.pluginName);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(catalog), { mode: 0o600 });
  renameSync(temporary, path);
}

export function deletePluginCatalog(identity: PluginCatalogIdentity): void {
  rmSync(cachePath(identity), { force: true });
}
