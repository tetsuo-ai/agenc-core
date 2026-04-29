import { open, readFile, stat } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

export const AGENC_ALIAS_REGEX = /^\s*alias\s+agenc\s*=/u;

export type EnvLike = Record<string, string | undefined>;

export interface ShellConfigOptions {
  readonly env?: EnvLike;
  readonly homedir?: string;
}

export interface FilterAgencAliasOptions {
  readonly installerPath: string;
}

export function getShellConfigPaths(
  options: ShellConfigOptions = {},
): Record<"zsh" | "bash" | "fish", string> {
  const home = options.homedir ?? osHomedir();
  const env = options.env ?? process.env;
  const zshConfigDir = env.ZDOTDIR || home;
  return {
    zsh: join(zshConfigDir, ".zshrc"),
    bash: join(home, ".bashrc"),
    fish: join(home, ".config", "fish", "config.fish"),
  };
}

function getErrnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isFsInaccessible(error: unknown): boolean {
  const code = getErrnoCode(error);
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

export async function readFileLines(filePath: string): Promise<string[] | null> {
  try {
    return (await readFile(filePath, "utf8")).split("\n");
  } catch (error) {
    if (isFsInaccessible(error)) return null;
    throw error;
  }
}

export async function writeFileLines(
  filePath: string,
  lines: readonly string[],
): Promise<void> {
  const fh = await open(filePath, "w");
  try {
    await fh.writeFile(lines.join("\n"), "utf8");
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

export function extractAgencAliasTarget(line: string): string | null {
  if (!AGENC_ALIAS_REGEX.test(line)) return null;
  const quoted = line.match(/alias\s+agenc\s*=\s*["']([^"']+)["']/u);
  if (quoted?.[1]) return quoted[1].trim();
  const bare = line.match(/alias\s+agenc\s*=\s*([^#\n]+)/u);
  return bare?.[1]?.trim() ?? null;
}

export function filterAgencAliases(
  lines: readonly string[],
  options: FilterAgencAliasOptions,
): { readonly filtered: readonly string[]; readonly hadAlias: boolean } {
  let hadAlias = false;
  const filtered = lines.filter((line) => {
    const target = extractAgencAliasTarget(line);
    if (target === null) return true;
    if (target !== options.installerPath) return true;
    hadAlias = true;
    return false;
  });
  return { filtered, hadAlias };
}

export async function findAgencAlias(
  options: ShellConfigOptions = {},
): Promise<string | null> {
  const configs = getShellConfigPaths(options);
  for (const configPath of Object.values(configs)) {
    const lines = await readFileLines(configPath);
    if (!lines) continue;
    for (const line of lines) {
      const target = extractAgencAliasTarget(line);
      if (target !== null) return target;
    }
  }
  return null;
}

export async function findValidAgencAlias(
  options: ShellConfigOptions = {},
): Promise<string | null> {
  const aliasTarget = await findAgencAlias(options);
  if (!aliasTarget) return null;

  const home = options.homedir ?? osHomedir();
  const expandedPath =
    aliasTarget === "~"
      ? home
      : aliasTarget.startsWith("~/")
        ? join(home, aliasTarget.slice(2))
        : aliasTarget;

  try {
    const stats = await stat(expandedPath);
    return stats.isFile() || stats.isSymbolicLink() ? aliasTarget : null;
  } catch {
    return null;
  }
}
