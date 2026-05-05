import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
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
  options: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  },
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
const MARKETPLACE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const DEFAULT_GIT_MAX_OUTPUT_BYTES = 1_048_576;

export async function addMarketplaceOp(
  input: AddMarketplaceInput,
): Promise<AddMarketplaceResult> {
  const sparse = input.sparse !== undefined
    ? normalizeSparsePath(input.sparse)
    : undefined;
  if (sparse && (await detectSourceType(input.source, input)) !== "git") {
    throw new Error("--sparse is only valid for git marketplaces");
  }
  const storeRoot = marketplaceStoreRoot(input);
  await mkdir(storeRoot, { recursive: true, mode: 0o700 });
  const staged = await stageMarketplaceSource({
    ...input,
    ...(sparse !== undefined ? { sparse } : {}),
  });
  try {
    const manifestPath = await resolveMarketplaceManifestPath(staged.root, sparse);
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
    const safeName = sanitizeMarketplaceInstallName(name);
    const installNameConflict = findMarketplaceInstallName(index, safeName);
    if (
      installNameConflict !== undefined &&
      installNameConflict !== name
    ) {
      throw new Error(
        `marketplace install directory collides with existing marketplace: ${installNameConflict}`,
      );
    }
    const installedPath = marketplaceInstalledPath(name, input);
    const replaced = duplicate !== undefined || await pathExists(installedPath);
    const manifestRelativePath = relative(staged.root, manifestPath);
    const finalManifestPath = join(installedPath, manifestRelativePath);
    const marketplace: MarketplaceRecord = {
      name,
      source: staged.source,
      sourceType: staged.sourceType,
      installedPath,
      manifestPath: finalManifestPath,
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
      ...(sparse !== undefined ? { sparse } : {}),
      ...(staged.revision !== undefined ? { revision: staged.revision } : {}),
      updatedAt: (input.now ?? (() => new Date()))().toISOString(),
    };
    const nextIndex: MarketplaceIndex = {
      version: 1,
      marketplaces: {
        ...index.marketplaces,
        [name]: marketplace,
      },
    };
    await activateMarketplaceStaging(staged.root, installedPath, nextIndex, input);
    return { marketplace, replaced };
  } finally {
    await rm(staged.tempDir, { recursive: true, force: true });
  }
}

export function marketplaceStoreRoot(options: PluginOperationOptions = {}): string {
  return join(resolvePluginAgencHome(options), "plugins", "marketplaces");
}

export function marketplaceInstalledPath(
  name: string,
  options: PluginOperationOptions = {},
): string {
  return join(marketplaceStoreRoot(options), sanitizeMarketplaceInstallName(name));
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
  options: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    timeout.unref();
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const appended = appendBoundedOutput(stdout, stdoutBytes, chunk, maxOutputBytes);
      stdout = appended.text;
      stdoutBytes = appended.bytes;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const appended = appendBoundedOutput(stderr, stderrBytes, chunk, maxOutputBytes);
      stderr = appended.text;
      stderrBytes = appended.bytes;
      stderrTruncated ||= appended.truncated;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (stdoutTruncated) stdout += "\n[stdout truncated]\n";
      if (stderrTruncated) stderr += "\n[stderr truncated]\n";
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const displayArgs = redactProcessArgs(args).join(" ");
      const reason = timedOut ? `timed out after ${timeoutMs}ms` : `failed with exit ${code}`;
      const detail = redactSensitiveText(stderr.trim());
      reject(new Error(`${command} ${displayArgs} ${reason}${detail ? `: ${detail}` : ""}`));
    });
  });
}

export function normalizeMarketplaceName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("marketplace name cannot be empty");
  }
  if (!MARKETPLACE_NAME_RE.test(trimmed)) {
    throw new Error(
      "marketplace name must be an alphanumeric segment with only '.', '_', or '-' separators",
    );
  }
  if (RESERVED_MARKETPLACE_NAMES.has(trimmed.toLowerCase())) {
    throw new Error(`marketplace name is reserved: ${trimmed}`);
  }
  return trimmed;
}

export function sanitizeMarketplaceInstallName(name: string): string {
  return sanitizeInstallName(normalizeMarketplaceName(name));
}

export function findMarketplaceName(
  index: MarketplaceIndex,
  name: string,
): string | undefined {
  const lowered = name.toLowerCase();
  return Object.keys(index.marketplaces).find((candidate) => candidate.toLowerCase() === lowered);
}

export function findMarketplaceInstallName(
  index: MarketplaceIndex,
  safeName: string,
): string | undefined {
  for (const candidate of Object.keys(index.marketplaces)) {
    try {
      if (sanitizeMarketplaceInstallName(candidate) === safeName) return candidate;
    } catch {
      // Ignore malformed historical index entries for collision detection.
    }
  }
  return undefined;
}

export function normalizeSparsePath(path: string): string {
  const trimmed = path.trim();
  if (
    trimmed.length === 0 ||
    isAbsolute(trimmed) ||
    trimmed.includes("\0") ||
    /^[a-zA-Z]:[\\/]/u.test(trimmed)
  ) {
    throw new Error("--sparse must be a relative marketplace path");
  }
  const parts = trimmed.split(/[\\/]+/u);
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("--sparse must not contain empty, '.', or '..' path segments");
  }
  return parts.join("/");
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
      const resolved = resolve(candidate);
      const resolvedRoot = resolve(root);
      if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}/`)) {
        continue;
      }
      if ((await stat(resolved)).isFile()) return resolved;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`marketplace source must contain ${MARKETPLACE_MANIFEST_FILE}`);
}

async function activateMarketplaceStaging(
  stagingRoot: string,
  installedPath: string,
  nextIndex: MarketplaceIndex,
  options: PluginOperationOptions,
): Promise<void> {
  const storeRoot = marketplaceStoreRoot(options);
  const installedRealParent = await realpath(dirname(installedPath));
  const storeReal = await realpath(storeRoot);
  if (installedRealParent !== storeReal) {
    throw new Error("marketplace install path must stay inside the marketplace store");
  }
  const backupPath = `${installedPath}.backup-${process.pid}-${Date.now()}`;
  let hadExisting = false;
  let activated = false;
  try {
    if (await pathExists(installedPath)) {
      await rename(installedPath, backupPath);
      hadExisting = true;
    }
    await rename(stagingRoot, installedPath);
    activated = true;
    await writeMarketplaceIndex(nextIndex, options);
    if (hadExisting) {
      await rm(backupPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (activated) {
      await rm(installedPath, { recursive: true, force: true });
    }
    if (hadExisting && await pathExists(backupPath)) {
      await rename(backupPath, installedPath);
    }
    throw error;
  }
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

function appendBoundedOutput(
  current: string,
  currentBytes: number,
  chunk: string,
  maxBytes: number,
): { readonly text: string; readonly bytes: number; readonly truncated: boolean } {
  const chunkBytes = Buffer.byteLength(chunk, "utf8");
  if (currentBytes >= maxBytes) {
    return {
      text: current,
      bytes: currentBytes + chunkBytes,
      truncated: chunkBytes > 0,
    };
  }
  const remaining = maxBytes - currentBytes;
  if (chunkBytes <= remaining) {
    return {
      text: current + chunk,
      bytes: currentBytes + chunkBytes,
      truncated: false,
    };
  }
  return {
    text: current + Buffer.from(chunk, "utf8").subarray(0, remaining).toString("utf8"),
    bytes: currentBytes + chunkBytes,
    truncated: true,
  };
}

function redactProcessArgs(args: readonly string[]): string[] {
  return args.map((arg) => redactSensitiveText(arg));
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/giu, "$1<redacted>@")
    .replace(/([?&](?:token|access_token|password|apikey|api_key)=)[^&\s]+/giu, "$1<redacted>")
    .replace(/((?:token|access_token|password|apikey|api_key)=)[^&\s]+/giu, "$1<redacted>");
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
