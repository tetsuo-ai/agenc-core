/**
 * Built-in language server profiles.
 *
 * Nothing in `lsp_servers` means no diagnostics at all, and almost nobody
 * writes that config. These profiles give TypeScript, JavaScript, Python, Go
 * and Rust projects a language server with zero configuration when the
 * server binary is installed on the user's PATH. Only PATH is searched: a
 * server found inside the workspace (node_modules/.bin, a virtualenv) is code
 * the repository under edit chose, and the agent must not execute it on the
 * user's behalf just because it opened the folder. A user-configured server
 * that claims any of the same extensions replaces the profile. Set
 * AGENC_DISABLE_BUILTIN_LSP=1 to turn every profile off; AGENC_DISABLE_LSP
 * still turns the whole service off.
 */
import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { ScopedLspServerConfig } from "./types.js";

interface BuiltinProfile {
  readonly name: string;
  readonly displayName: string;
  readonly commands: readonly string[];
  readonly args: readonly string[];
  readonly extensionToLanguage: Readonly<Record<string, string>>;
}

const TYPESCRIPT_EXTENSIONS = Object.freeze({
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
});

export const BUILTIN_LSP_PROFILES: readonly BuiltinProfile[] = Object.freeze([
  {
    name: "builtin-typescript",
    displayName: "TypeScript (typescript-language-server)",
    commands: ["typescript-language-server"],
    args: ["--stdio"],
    extensionToLanguage: TYPESCRIPT_EXTENSIONS,
  },
  {
    name: "builtin-python",
    displayName: "Python (pyright)",
    commands: ["basedpyright-langserver", "pyright-langserver"],
    args: ["--stdio"],
    extensionToLanguage: Object.freeze({ ".py": "python", ".pyi": "python" }),
  },
  {
    name: "builtin-go",
    displayName: "Go (gopls)",
    commands: ["gopls"],
    args: [],
    extensionToLanguage: Object.freeze({ ".go": "go" }),
  },
  {
    name: "builtin-rust",
    displayName: "Rust (rust-analyzer)",
    commands: ["rust-analyzer"],
    args: [],
    extensionToLanguage: Object.freeze({ ".rs": "rust" }),
  },
]);

function isEnvTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/iu.test(value?.trim() ?? "");
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a bare command name against PATH only. Relative or absolute names
 * are refused: the profiles never point into the workspace.
 */
export function resolveCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (command.length === 0 || isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return undefined;
  }
  const searchPath = env.PATH ?? env.Path ?? "";
  if (searchPath.length === 0) return undefined;
  const suffixes = platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of searchPath.split(delimiter)) {
    if (directory.length === 0) continue;
    for (const suffix of suffixes) {
      const candidate = join(directory, `${command}${suffix}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface BuiltinLspServerOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Servers the user configured; a profile yields to any overlap in extensions. */
  readonly configured?: Readonly<Record<string, ScopedLspServerConfig>>;
  readonly resolveCommand?: (command: string) => string | undefined;
  /** The workspace the servers will analyse; decides the TypeScript fallback. */
  readonly workspaceRoot?: string;
}

const WORKSPACE_TSSERVER = join("node_modules", "typescript", "lib", "tsserver.js");

/**
 * typescript-language-server 5+ ships no TypeScript of its own: it uses the
 * workspace's `node_modules/typescript` or an explicit `tsserver.path`, and
 * exits during initialize otherwise. When the workspace has no TypeScript,
 * point the server at the TypeScript installed next to it, which the user
 * installed together with the server. Nothing from the workspace is executed
 * that the server would not have executed on its own. Only TypeScript 5.x
 * qualifies: the Go-based TypeScript 7 has no `lib/tsserver.js`, so the
 * fallback stays undefined and the server reports the missing installation.
 */
export function typescriptServerFallback(
  serverCommand: string,
  workspaceRoot: string | undefined,
): { readonly tsserver: { readonly path: string } } | undefined {
  if (workspaceRoot !== undefined && isRegularFile(join(workspaceRoot, WORKSPACE_TSSERVER))) {
    return undefined;
  }
  let real: string;
  try {
    real = realpathSync(serverCommand);
  } catch {
    return undefined;
  }
  // <prefix>/node_modules/typescript-language-server/lib/cli.mjs (npm) or
  // <prefix>/lib/node_modules/... (global): walk up to the first node_modules.
  let dir = dirname(real);
  for (let depth = 0; depth < 6; depth += 1) {
    if (dir.endsWith(`${delimiter === ";" ? "\\" : "/"}node_modules`) || dir.endsWith("node_modules")) {
      const candidate = join(dir, "typescript", "lib", "tsserver.js");
      if (isRegularFile(candidate)) return { tsserver: { path: candidate } };
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The built-in servers that apply on this machine: each profile whose binary
 * is on PATH and whose extensions no configured server already claims.
 */
export function builtinLspServerConfigs(
  options: BuiltinLspServerOptions = {},
): Record<string, ScopedLspServerConfig> {
  const env = options.env ?? process.env;
  if (isEnvTruthy(env.AGENC_DISABLE_BUILTIN_LSP)) return {};
  const resolveCommand = options.resolveCommand ?? ((command: string) => resolveCommandOnPath(command, env));
  const claimed = new Set<string>();
  for (const server of Object.values(options.configured ?? {})) {
    for (const extension of Object.keys(server.extensionToLanguage)) {
      claimed.add(extension.toLowerCase());
    }
  }
  const out: Record<string, ScopedLspServerConfig> = {};
  for (const profile of BUILTIN_LSP_PROFILES) {
    const extensions = Object.keys(profile.extensionToLanguage);
    if (extensions.some((extension) => claimed.has(extension))) continue;
    const command = profile.commands.map(resolveCommand).find((path) => path !== undefined);
    if (command === undefined) continue;
    const initializationOptions = profile.name === "builtin-typescript"
      ? typescriptServerFallback(command, options.workspaceRoot)
      : undefined;
    out[profile.name] = {
      command,
      args: [...profile.args],
      extensionToLanguage: { ...profile.extensionToLanguage },
      displayName: profile.displayName,
      ...(initializationOptions !== undefined ? { initializationOptions } : {}),
    };
  }
  return out;
}
