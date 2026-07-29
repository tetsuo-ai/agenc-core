import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { EmbeddedNeovimStartupContext } from "./NeovimLifecycle.js";

export type NeovimRecoveryPaths = {
  readonly root: string;
  readonly swap: string;
  readonly undo: string;
  readonly copies: string;
  readonly shada: string;
  readonly manifest: string;
  readonly workspaceRoot: string;
  readonly workspaceHash: string;
};

export async function preparePrivateNeovimRecovery(options: {
  readonly agencHome: string;
  readonly workspaceRoot: string;
}): Promise<NeovimRecoveryPaths> {
  const workspaceRoot = await canonicalWorkspaceRoot(options.workspaceRoot);
  const workspaceHash = createHash("sha256")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 24);
  const root = join(
    resolve(options.agencHome),
    "recovery",
    "neovim",
    workspaceHash,
  );
  const swap = join(root, "swap");
  const undo = join(root, "undo");
  const copies = join(root, "copies");
  const shada = join(root, "main.shada");
  const manifest = join(root, "recovery.json");
  await ensurePrivateDirectory(root);
  await Promise.all([
    ensurePrivateDirectory(swap),
    ensurePrivateDirectory(undo),
    ensurePrivateDirectory(copies),
  ]);
  await writeFile(manifest, `${JSON.stringify({
    version: 1,
    workspaceRoot,
    workspaceHash,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await ensurePrivateFileMode(manifest);
  return {
    root,
    swap,
    undo,
    copies,
    shada,
    manifest,
    workspaceRoot,
    workspaceHash,
  };
}

export async function installPrivateNeovimRecovery(
  context: EmbeddedNeovimStartupContext,
): Promise<{
  readonly paths: NeovimRecoveryPaths;
  readonly swapFiles: readonly string[];
} | null> {
  if (!context.agencHome) return null;
  const paths = await preparePrivateNeovimRecovery({
    agencHome: context.agencHome,
    workspaceRoot: context.workspaceRoot,
  });
  await context.execLua(privateRecoveryLua(), [recoveryLuaArgument(paths)]);
  const swapFiles = await listRecoverySwapFiles(paths);
  // Install the exact-choice hook even when the directory is currently empty:
  // another supervised session can create a swap between this scan and the
  // first :edit, and that race must still use AgenC's non-interactive UI.
  await context.execLua(privateRecoveryChoiceLua(), [swapFiles]);
  return { paths, swapFiles };
}

/**
 * Lua applied after user init but before the first file opens. AgenC owns
 * crash recovery for embedded sessions, so a user's global `noswapfile` or
 * `noundofile` cannot accidentally disable the safety contract.
 */
export function privateRecoveryLua(): string {
  return [
    "local recovery = ...",
    "local function enforce_recovery(buffer)",
    "  vim.opt.directory = recovery.swap .. '//'",
    "  vim.opt.undodir = recovery.undo .. '//'",
    "  vim.opt.shadafile = recovery.shada",
    "  vim.opt.updatecount = math.max(vim.opt.updatecount:get(), 50)",
    "  local pending_ok, recovery_pending = pcall(",
    "    vim.api.nvim_buf_get_var,",
    "    buffer,",
    "    'agenc_recovery_pending'",
    "  )",
    "  if pending_ok and recovery_pending == true then return end",
    "  if vim.api.nvim_buf_is_valid(buffer)",
    "      and vim.api.nvim_buf_is_loaded(buffer)",
    "      and vim.api.nvim_buf_get_name(buffer) ~= '' then",
    "    vim.api.nvim_set_option_value('swapfile', true, { buf = buffer })",
    "    vim.api.nvim_set_option_value('undofile', true, { buf = buffer })",
    "  end",
    "end",
    "enforce_recovery(vim.api.nvim_get_current_buf())",
    "local group = vim.api.nvim_create_augroup('AgenCPrivateRecovery', { clear = true })",
    "vim.api.nvim_create_autocmd({ 'BufReadPost', 'BufEnter', 'BufWritePost' }, {",
    "  group = group,",
    "  callback = function(args)",
    "    local buffer = args.buf",
    "    vim.defer_fn(function()",
    "      enforce_recovery(buffer)",
    "      local ok, name = pcall(vim.fn.swapname, buffer)",
    "      if ok and type(name) == 'string' and name ~= '' then",
    "        pcall(vim.fn.setfperm, name, 'rw-------')",
    "      end",
    "    end, 10)",
    "  end,",
    "})",
    "return true",
  ].join("\n");
}

export function privateRecoveryChoiceLua(): string {
  return [
    "local known_swaps = ... or {}",
    "local notified = {}",
    "local function publish_recovery(buffer, swap_file, file_path)",
    "  if type(swap_file) ~= 'string' or swap_file == '' or notified[swap_file] then return end",
    "  notified[swap_file] = true",
    "  if buffer and vim.api.nvim_buf_is_valid(buffer) then",
    "    pcall(vim.api.nvim_buf_set_var, buffer, 'agenc_recovery_pending', true)",
    "  end",
    "  vim.rpcnotify(0, 'agenc_buffer_recovery_detected', swap_file, vim.fn.fnamemodify(file_path, ':p'))",
    "end",
    "local group = vim.api.nvim_create_augroup('AgenCRecoveryChoice', { clear = true })",
    "vim.api.nvim_create_autocmd('SwapExists', {",
    "  group = group,",
    "  callback = function(args)",
    "    publish_recovery(args.buf, vim.v.swapname, args.file)",
    "    vim.v.swapchoice = 'o'",
    "  end,",
    "})",
    "vim.api.nvim_create_autocmd('BufReadPost', {",
    "  group = group,",
    "  callback = function(args)",
    "    local file_path = vim.fn.fnamemodify(args.file, ':p')",
    "    for _, swap_file in ipairs(known_swaps) do",
    "      local ok, info = pcall(vim.fn.swapinfo, swap_file)",
    "      if ok and type(info) == 'table'",
    "          and type(info.fname) == 'string'",
    "          and vim.fn.fnamemodify(info.fname, ':p') == file_path then",
    "        publish_recovery(args.buf, swap_file, file_path)",
    "      end",
    "    end",
    "  end,",
    "})",
    "return true",
  ].join("\n");
}

export function recoveryLuaArgument(paths: NeovimRecoveryPaths): {
  readonly swap: string;
  readonly undo: string;
  readonly shada: string;
} {
  return {
    swap: paths.swap,
    undo: paths.undo,
    shada: paths.shada,
  };
}

export async function listRecoverySwapFiles(
  paths: NeovimRecoveryPaths,
): Promise<readonly string[]> {
  const entries = await readdir(paths.swap, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(paths.swap, entry.name))
    .sort();
}

export function recoveryCopyPath(
  paths: NeovimRecoveryPaths,
  filePath: string,
  now = new Date(),
): string {
  const stamp = now.toISOString().replaceAll(/[:.]/gu, "-");
  const label = basename(filePath) || "recovered-buffer";
  return join(paths.copies, `${label}.${stamp}.recovered`);
}

export async function discardRecoverySwapFiles(
  paths: NeovimRecoveryPaths,
  swapFiles: readonly string[],
): Promise<void> {
  const root = `${resolve(paths.swap)}${sep}`;
  for (const swapFile of swapFiles) {
    const target = resolve(swapFile);
    if (!target.startsWith(root)) {
      throw new Error(`Refusing to discard a swap file outside AgenC recovery: ${target}`);
    }
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Recovery swap is not a regular file: ${target}`);
      }
      await unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function canonicalWorkspaceRoot(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Neovim recovery path is not a private directory: ${path}`);
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function ensurePrivateFileMode(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Neovim recovery manifest is not a regular file: ${path}`);
  }
  if (process.platform !== "win32") await chmod(path, 0o600);
}
