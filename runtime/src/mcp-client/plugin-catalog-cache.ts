/** Persistent, content-addressed MCP discovery for installed plugins. */
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

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

/** Hash every installed byte, including the manifest and server entrypoint. */
export function hashInstalledPlugin(root: string): string {
  const hash = createHash("sha256");
  hash.update("agenc-plugin-tree-v2\0");
  const field = (value: string | Buffer): void => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length).update(bytes);
  };
  const visit = (path: string, relative: string): void => {
    const stat = lstatSync(path);
    field(relative);
    field(String(stat.mode & 0o777));
    if (stat.isSymbolicLink()) {
      field("link"); field(readlinkSync(path));
    } else if (stat.isDirectory()) {
      field("dir");
      for (const child of readdirSync(path).sort()) visit(join(path, child), `${relative}/${child}`);
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
      for (const child of readdirSync(path)) checkLinks(join(path, child));
    }
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
    cpSync(root, temporary, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true });
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
