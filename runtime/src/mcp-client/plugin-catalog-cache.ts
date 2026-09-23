/** Persistent, content-addressed MCP discovery for installed plugins. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PluginCatalogIdentity {
  readonly pluginName: string;
  readonly serverName: string;
  readonly version?: string;
  readonly digest: string;
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
  const visit = (path: string, relative: string): void => {
    const stat = lstatSync(path);
    hash.update(relative).update("\0");
    if (stat.isSymbolicLink()) {
      hash.update("link\0").update(readlinkSync(path));
    } else if (stat.isDirectory()) {
      hash.update("dir\0");
      for (const child of readdirSync(path).sort()) visit(join(path, child), `${relative}/${child}`);
    } else if (stat.isFile()) {
      hash.update("file\0").update(readFileSync(path));
    }
  };
  visit(root, ".");
  return hash.digest("hex");
}

function cachePath(identity: PluginCatalogIdentity): string {
  const key = createHash("sha256").update(JSON.stringify([
    identity.pluginName, identity.serverName, identity.version ?? "", identity.digest,
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
