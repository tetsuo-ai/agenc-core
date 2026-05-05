import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { validateMarketplaceManifest } from "../validation.js";
import {
  readJsonFile,
  resolvePath,
  resolvePluginAgencHome,
  resolvePluginWorkspaceRoot,
  sanitizeInstallName,
  writeJsonAtomic,
  type PluginOperationOptions,
} from "./pluginOperations.js";

export type MarketplaceSourceType = "local" | "git";

export interface MarketplaceRecord {
  readonly name: string;
  readonly source: string;
  readonly sourceType: MarketplaceSourceType;
  readonly installedPath: string;
  readonly manifestPath: string;
  readonly ref?: string;
  readonly sparse?: string;
  readonly revision?: string;
  readonly updatedAt: string;
}

export interface MarketplaceIndex {
  readonly version: 1;
  readonly marketplaces: Readonly<Record<string, MarketplaceRecord>>;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string },
) => Promise<ProcessResult>;

export interface MarketplaceOperationOptions extends PluginOperationOptions {
  readonly runProcess?: ProcessRunner;
}

export interface AddMarketplaceInput extends MarketplaceOperationOptions {
  readonly source: string;
  readonly name?: string;
  readonly ref?: string;
  readonly sparse?: string;
  readonly force?: boolean;
}

export interface AddMarketplaceResult {
  readonly marketplace: MarketplaceRecord;
  readonly replaced: boolean;
}

const MARKETPLACE_INDEX_FILE = "marketplaces.json";
const MARKETPLACE_MANIFEST_FILE = "marketplace.json";
const RESERVED_MARKETPLACE_NAMES = new Set(["agenc", "builtin", "curated"]);

export async function addMarketplaceOp(
  input: AddMarketplaceInput,
): Promise<AddMarketplaceResult> {
  if (input.sparse && (await detectSourceType(input.source, input)) !== "git") {
    throw new Error("--sparse is only valid for git marketplaces");
  }
  const storeRoot = marketplaceStoreRoot(input);
  await mkdir(storeRoot, { recursive: true, mode: 0o700 });
  const staged = await stageMarketplaceSource(input);
  try {
    const manifestPath = await resolveMarketplaceManifestPath(staged.root, input.sparse);
    const validation = await validateMarketplaceManifest(manifestPath);
    if (!validation.success) {
      throw new Error(
        `marketplace manifest failed validation: ${validation.errors.map((error) => error.message).join("; ")}`,
      );
    }
    const manifest = await readMarketplaceManifest(manifestPath);
    const name = normalizeMarketplaceName(
      input.name ?? inferMarketplaceName(manifest, input.source),
    );
    const index = await readMarketplaceIndex(input);
    const duplicate = findMarketplaceName(index, name);
    if (duplicate !== undefined && duplicate !== name) {
      throw new Error(`marketplace name differs only by case from existing marketplace: ${duplicate}`);
    }
    if (duplicate !== undefined && input.force !== true) {
      throw new Error(`marketplace already exists: ${name}`);
    }
    const safeName = sanitizeInstallName(name);
    const installedPath = join(storeRoot, safeName);
    const replaced = duplicate !== undefined || await pathExists(installedPath);
    await rm(installedPath, { recursive: true, force: true });
    await rename(staged.root, installedPath);
    const finalManifestPath = join(installedPath, manifestPath.slice(staged.root.length + 1));
    const marketplace: MarketplaceRecord = {
      name,
      source: staged.source,
      sourceType: staged.sourceType,
      installedPath,
      manifestPath: finalManifestPath,
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
      ...(input.sparse !== undefined ? { sparse: input.sparse } : {}),
      ...(staged.revision !== undefined ? { revision: staged.revision } : {}),
      updatedAt: (input.now ?? (() => new Date()))().toISOString(),
    };
    await writeMarketplaceIndex({
      version: 1,
      marketplaces: {
        ...index.marketplaces,
        [name]: marketplace,
      },
    }, input);
    return { marketplace, replaced };
  } finally {
    await rm(staged.tempDir, { recursive: true, force: true });
  }
}

export function marketplaceStoreRoot(options: PluginOperationOptions = {}): string {
  return join(resolvePluginAgencHome(options), "plugins", "marketplaces");
}

export function marketplaceIndexPath(options: PluginOperationOptions = {}): string {
  return join(marketplaceStoreRoot(options), MARKETPLACE_INDEX_FILE);
}

export async function readMarketplaceIndex(
  options: PluginOperationOptions = {},
): Promise<MarketplaceIndex> {
  const parsed = await readJsonFile<MarketplaceIndex>(
    marketplaceIndexPath(options),
    { version: 1, marketplaces: {} },
  );
  return {
    version: 1,
    marketplaces: Object.fromEntries(
      Object.entries(parsed.marketplaces ?? {}).filter(([, value]) => isMarketplaceRecord(value)),
    ),
  };
}

export async function writeMarketplaceIndex(
  index: MarketplaceIndex,
  options: PluginOperationOptions = {},
): Promise<void> {
  await writeJsonAtomic(marketplaceIndexPath(options), index);
}

export async function defaultRunProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string } = {},
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit ${code}: ${stderr.trim()}`));
    });
  });
}

export function normalizeMarketplaceName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("marketplace name cannot be empty");
  }
  if (RESERVED_MARKETPLACE_NAMES.has(trimmed.toLowerCase())) {
    throw new Error(`marketplace name is reserved: ${trimmed}`);
  }
  return trimmed;
}

export function findMarketplaceName(
  index: MarketplaceIndex,
  name: string,
): string | undefined {
  const lowered = name.toLowerCase();
  return Object.keys(index.marketplaces).find((candidate) => candidate.toLowerCase() === lowered);
}

async function detectSourceType(
  source: string,
  options: PluginOperationOptions,
): Promise<MarketplaceSourceType> {
  const localPath = resolvePath(source, resolvePluginWorkspaceRoot(options));
  try {
    await stat(localPath);
    return "local";
  } catch {
    return "git";
  }
}

async function stageMarketplaceSource(
  input: AddMarketplaceInput,
): Promise<{
  readonly tempDir: string;
  readonly root: string;
  readonly source: string;
  readonly sourceType: MarketplaceSourceType;
  readonly revision?: string;
}> {
  const storeRoot = marketplaceStoreRoot(input);
  const tempDir = await mkdtemp(join(storeRoot, ".stage-"));
  const root = join(tempDir, "root");
  const sourceType = await detectSourceType(input.source, input);
  if (sourceType === "local") {
    const source = resolvePath(input.source, resolvePluginWorkspaceRoot(input));
    const stats = await stat(source);
    if (stats.isDirectory()) {
      await cp(source, root, { recursive: true, dereference: false });
    } else {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await cp(source, join(root, MARKETPLACE_MANIFEST_FILE), { dereference: false });
    }
    return { tempDir, root, source, sourceType };
  }

  const run = input.runProcess ?? defaultRunProcess;
  if (input.sparse !== undefined) {
    await run("git", [
      "clone",
      "--depth",
      "1",
      "--filter=blob:none",
      "--no-checkout",
      input.source,
      root,
    ], {});
    await run("git", ["sparse-checkout", "init", "--cone"], { cwd: root });
    await run("git", ["sparse-checkout", "set", input.sparse], { cwd: root });
    await run("git", ["checkout", input.ref ?? "HEAD"], { cwd: root });
  } else {
    const args = ["clone", "--depth", "1"];
    if (input.ref !== undefined) args.push("--branch", input.ref);
    args.push(input.source, root);
    await run("git", args, {});
  }
  const revision = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  return {
    tempDir,
    root,
    source: input.source,
    sourceType,
    ...(revision.length > 0 ? { revision } : {}),
  };
}

async function resolveMarketplaceManifestPath(
  root: string,
  sparse: string | undefined,
): Promise<string> {
  const candidates = [
    join(root, MARKETPLACE_MANIFEST_FILE),
    ...(sparse ? [join(root, sparse, MARKETPLACE_MANIFEST_FILE)] : []),
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`marketplace source must contain ${MARKETPLACE_MANIFEST_FILE}`);
}

async function readMarketplaceManifest(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function inferMarketplaceName(manifest: unknown, source: string): string {
  if (isRecord(manifest)) {
    const metadata = manifest.metadata;
    if (isRecord(metadata) && typeof metadata.name === "string") {
      return metadata.name;
    }
    if (typeof manifest.name === "string") {
      return manifest.name;
    }
  }
  const base = basename(source, extname(source));
  return base.endsWith(".git") ? base.slice(0, -4) : base;
}

function isMarketplaceRecord(value: unknown): value is MarketplaceRecord {
  return isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.source === "string" &&
    (value.sourceType === "local" || value.sourceType === "git") &&
    typeof value.installedPath === "string" &&
    typeof value.manifestPath === "string" &&
    typeof value.updatedAt === "string";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
