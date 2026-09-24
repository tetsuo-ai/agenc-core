/** Persistent, content-addressed MCP discovery for installed plugins. */
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, mkdirSync, renameSync, rmSync, writeFileSync, watch, watchFile, unwatchFile, type FSWatcher } from "node:fs";
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
  const seal = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) for (const child of readdirSync(path)) seal(join(path, child));
    if (stat.isFile()) chmodSync(path, stat.mode & 0o555);
  };
  checkLinks(root);
  const directory = join(storageRoot, "cache", "mcp-install-snapshots");
  const destination = join(directory, digest);
  if (existsSync(destination)) {
    if (hashInstalledPlugin(destination) !== digest) throw new Error("Installed plugin snapshot changed");
    return destination;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    cpSync(root, temporary, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true,
      filter: (source) => source === root || isPluginPayloadEntry(source) });
    seal(temporary);
    if (hashInstalledPlugin(temporary) !== digest || hashInstalledPlugin(root) !== digest) {
      throw new Error("Installed plugin changed while creating its snapshot");
    }
    try { renameSync(temporary, destination); }
    catch (error) {
      if (!existsSync(destination) || hashInstalledPlugin(destination) !== digest) throw error;
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
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
  checkLinks(root);
  const directory = join(storageRoot, "cache", "mcp-install-snapshots");
  const destination = join(directory, digest);
  if (existsSync(destination)) {
    if (hashInstalledPlugin(destination) !== digest) throw new Error("Installed plugin snapshot changed");
    return destination;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = destination + "." + process.pid + "." + Math.random().toString(16).slice(2) + ".tmp";
  try {
    cpSync(root, temporary, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true,
      filter: (source) => source === root || isPluginPayloadEntry(source) });
    seal(temporary);
    if (hashInstalledPlugin(temporary) !== digest || hashInstalledPlugin(root) !== digest) throw new Error("Installed plugin changed while creating its snapshot");
    try { renameSync(temporary, destination); }
    catch (error) { if (!existsSync(destination) || hashInstalledPlugin(destination) !== digest) throw error; }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return destination;
};
const directoryEntries = (path) => readdirSync(path).filter(isPluginPayloadEntry).sort().map(name => {
  const stat = lstatSync(join(path, name));
  return [name, stat.ino, stat.mode];
});
const payloadPaths = (root) => {
  const paths = [];
  const visit = (path) => {
    const stat = lstatSync(path);
    const isDirectory = stat.isDirectory();
    paths.push({ path, isDirectory, children: isDirectory ? directoryEntries(path) : undefined });
    if (isDirectory) for (const child of readdirSync(path).filter(isPluginPayloadEntry)) visit(join(path, child));
  };
  visit(root);
  return paths;
};
try {
  if (workerData.kind === "snapshot") {
    const digest = hashInstalledPlugin(workerData.root);
    const snapshotRoot = snapshotInstalledPlugin(workerData.root, workerData.storageRoot, digest);
    parentPort.postMessage({ digest, snapshotRoot });
  } else if (workerData.kind === "directory") {
    parentPort.postMessage({ children: directoryEntries(workerData.path) });
  } else {
    const actualRoot = hashInstalledPlugin(workerData.root);
    const actualSnapshot = workerData.snapshotRoot ? hashInstalledPlugin(workerData.snapshotRoot) : undefined;
    parentPort.postMessage({ valid: actualRoot === workerData.digest && (!actualSnapshot || actualSnapshot === workerData.digest), paths: [
      ...payloadPaths(workerData.root), ...(workerData.snapshotRoot ? payloadPaths(workerData.snapshotRoot) : [])
    ] });
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
}

interface GenerationState extends VerifiedPluginGeneration {
  version: number;
  invalidated: boolean;
  listeners: Set<() => void>;
  watchers: FSWatcher[];
  verified?: Promise<void>;
  verifying: boolean;
  dirty: boolean;
  fallbackRequested: boolean;
  fallbackClosers: Array<() => void>;
}

const generations = new Map<string, GenerationState>();

/** Atomic installation replacement changes the inode before watch delivers. */
function installationRootToken(path: string): string {
  const stat = lstatSync(path);
  return `${stat.dev}:${stat.ino}`;
}

/** Share one verified installation generation across concurrent managers. */
export async function acquireVerifiedPluginGeneration(root: string, snapshotRoot: string | undefined, digest: string): Promise<VerifiedPluginGeneration> {
  const key = JSON.stringify([root, snapshotRoot, digest]);
  let state = generations.get(key);
  if (!state) {
    const roots = [root, ...(snapshotRoot ? [snapshotRoot] : [])];
    const rootTokens = roots.map(installationRootToken);
    const created: GenerationState = {
      version: 0, invalidated: false, verifying: true, dirty: false, fallbackRequested: false,
      fallbackClosers: [], listeners: new Set(), watchers: [],
      isCurrent(version) {
        if (this.invalidated || this.version !== version) return false;
        try { return roots.every((path, index) => installationRootToken(path) === rootTokens[index]); }
        catch { return false; }
      },
      subscribe(listener) {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
          if (this.listeners.size === 0 && generations.get(key) === this) {
            for (const watcher of this.watchers) watcher.close();
            for (const close of this.fallbackClosers) close();
            generations.delete(key);
          }
        };
      },
    };
    state = created;
    generations.set(key, created);
    const invalidate = (): void => {
      if (created.invalidated) return;
      created.invalidated = true;
      created.version++;
      for (const listener of [...created.listeners]) listener();
    };
    let checkingUnknownEvent = false;
    let pendingUnknownEvent = false;
    const checkUnknownEvent = (): void => {
      if (created.invalidated) return;
      if (checkingUnknownEvent) { pendingUnknownEvent = true; return; }
      checkingUnknownEvent = true;
      void installationWorker<{ valid: boolean }>({ kind: "verify", root, snapshotRoot, digest })
        .then(({ valid }) => { if (!valid) invalidate(); }, invalidate)
        .finally(() => {
          checkingUnknownEvent = false;
          if (pendingUnknownEvent) { pendingUnknownEvent = false; checkUnknownEvent(); }
        });
    };
    const installFallback = (paths: Array<{ path: string; isDirectory: boolean; children?: unknown[] }>): void => {
      if (created.fallbackClosers.length > 0) return;
      for (const entry of paths) {
        if (entry.isDirectory) {
          let checking = false;
          let pending = false;
          const listener = (): void => {
            if (created.invalidated) return;
            if (checking) { pending = true; return; }
            checking = true;
            void installationWorker<{ children: unknown[] }>({ kind: "directory", path: entry.path })
              .then(({ children }) => { if (JSON.stringify(children) !== JSON.stringify(entry.children)) invalidate(); }, invalidate)
              .finally(() => {
                checking = false;
                if (pending) { pending = false; listener(); }
              });
          };
          watchFile(entry.path, { interval: 50, persistent: false }, listener);
          created.fallbackClosers.push(() => unwatchFile(entry.path, listener));
        } else {
          const listener = (current: { mtimeMs: number; ctimeMs: number; size: number; ino: number; mode: number }, previous: { mtimeMs: number; ctimeMs: number; size: number; ino: number; mode: number }): void => {
            if (current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs ||
              current.size !== previous.size || current.ino !== previous.ino || current.mode !== previous.mode) invalidate();
          };
          watchFile(entry.path, { interval: 50, persistent: false }, listener);
          created.fallbackClosers.push(() => unwatchFile(entry.path, listener));
        }
      }
    };
    try {
      for (const path of [root, ...(snapshotRoot ? [snapshotRoot] : [])]) {
        let watcher: FSWatcher;
        try {
          watcher = watch(path, { recursive: true }, (_event, filename) => {
            if (filename !== null && !isPluginPayloadEntry(String(filename))) return;
            if (created.verifying) { created.dirty = true; return; }
            if (filename === null) { checkUnknownEvent(); return; }
            invalidate();
          });
        } catch { created.fallbackRequested = true; continue; }
        watcher.on("error", () => {
          created.fallbackRequested = true;
          watcher.close();
          if (!created.verifying && created.fallbackClosers.length === 0) invalidate();
        });
        watcher.unref();
        created.watchers.push(watcher);
      }
      created.verified = (async () => {
        for (;;) {
          created.dirty = false;
          const { valid, paths } = await installationWorker<{ valid: boolean; paths: Array<{ path: string; isDirectory: boolean; children?: unknown[] }> }>({ kind: "verify", root, snapshotRoot, digest });
          if (!valid || !created.isCurrent(created.version)) throw new Error("Installed plugin changed during verification");
          if (created.fallbackRequested && created.fallbackClosers.length === 0) {
            installFallback(paths);
            created.dirty = true;
          }
          if (!created.dirty) break;
        }
        created.verifying = false;
      })();
    } catch (error) {
      for (const watcher of created.watchers) watcher.close();
      generations.delete(key);
      throw error;
    }
  }
  try { await state.verified; }
  catch (error) {
    for (const watcher of state.watchers) watcher.close();
    for (const close of state.fallbackClosers) close();
    if (generations.get(key) === state) generations.delete(key);
    throw error;
  }
  if (!state.isCurrent(state.version)) throw new Error("Installed plugin generation changed");
  return state;
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
