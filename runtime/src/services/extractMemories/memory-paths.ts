/**
 * Source-aligned with `src/memdir/paths.ts` at donor commit
 * 0ca43335375beec6e58711b797d5b0c4bb5019b8.
 *
 * Why this lives here / shape difference from upstream:
 *   - `runtime/src/memdir/**` is excluded from the strict build, so the
 *     extraction service carries the small path subset it needs locally.
 *   - Explicit env/settings overrides fail closed when unsafe instead of
 *     silently falling back to another directory, because the child tool
 *     policy uses this path as its only read/write root.
 *
 * Scope boundaries:
 *   - remote/team memory routing and feature gates beyond the single
 *     auto-memory directory used by S-03.
 */

import { homedir } from "node:os";
import {
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from "node:path";
import { findGitRoot as findCanonicalGitRoot } from "../../agents/worktree.js";
import { getAgenCConfigHomeDir, isEnvDefinedFalsy, isEnvTruthy } from "../../utils/envUtils.js";
import { findProjectRootSync } from "../../session/session-store.js";
import {
  getSettingsFilePathForSource,
  readSettingsFileLenient,
  type SettingsJson,
} from "../../permissions/settings.js";
import type { PermissionRuleSource } from "../../permissions/types.js";

export const AUTO_MEMORY_INDEX_FILE = "MEMORY.md";
const AUTO_MEMORY_DIRNAME = "memory";

export interface AutoMemoryPathResult {
  readonly enabled: boolean;
  readonly path?: string;
  readonly reason?: string;
}

export type MemoryPathEnv = Readonly<Record<string, string | undefined>>;

export type TrustedAutoMemoryDirectorySource = Extract<
  PermissionRuleSource,
  "policySettings" | "flagSettings" | "userSettings"
>;

export interface ResolveAutoMemoryDirectoryOptions {
  readonly env?: MemoryPathEnv;
  readonly cwd?: string;
  readonly homeDir?: string;
  readonly configHomeDir?: string;
  readonly flagSettingsPath?: string;
  readonly managedSettingsPath?: string;
  readonly settings?: {
    readonly [K in PermissionRuleSource]?: SettingsJson | null;
  };
  readonly readSettingsFile?: (path: string) => Promise<SettingsJson | null>;
}

const AUTO_MEMORY_DIRECTORY_SOURCES: readonly TrustedAutoMemoryDirectorySource[] =
  ["policySettings", "flagSettings", "userSettings"];

const AUTO_MEMORY_ENABLED_AUTHORITY_SOURCES: readonly PermissionRuleSource[] = [
  "policySettings",
  "flagSettings",
  "userSettings",
];
const AUTO_MEMORY_REPOSITORY_SOURCES: readonly PermissionRuleSource[] = [
  "localSettings",
  "projectSettings",
];
const MAX_SANITIZED_PROJECT_KEY_LENGTH = 200;

function effectiveEnv(
  env: MemoryPathEnv | undefined,
): MemoryPathEnv {
  return env ?? process.env;
}

function effectiveCwd(opts: ResolveAutoMemoryDirectoryOptions): string {
  return opts.cwd ?? process.cwd();
}

function effectiveHome(opts: ResolveAutoMemoryDirectoryOptions): string {
  return opts.homeDir ?? homedir();
}

function resolveConfigHome(opts: ResolveAutoMemoryDirectoryOptions): string {
  return opts.configHomeDir ?? getAgenCConfigHomeDir();
}

function envValue(
  env: MemoryPathEnv,
  key: string,
): string | undefined {
  const value = env[key];
  return typeof value === "string" ? value : undefined;
}

function normalizeWithTrailingSep(path: string): string {
  return `${normalize(path).replace(/[/\\]+$/u, "")}${sep}`.normalize("NFC");
}

function expandTildePath(
  raw: string,
  homeDir: string,
): string | undefined {
  if (!raw.startsWith("~/") && !raw.startsWith("~\\")) {
    return raw;
  }
  const rest = raw.slice(2);
  const restNorm = normalize(rest || ".");
  if (restNorm === "." || restNorm === "..") {
    return undefined;
  }
  return join(homeDir, rest);
}

export function validateAutoMemoryDirectoryPath(
  raw: string | undefined,
  opts: {
    readonly expandTilde: boolean;
    readonly homeDir?: string;
  } = { expandTilde: false },
): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const expanded = opts.expandTilde
    ? expandTildePath(trimmed, opts.homeDir ?? homedir())
    : trimmed;
  if (expanded === undefined) return undefined;
  const normalized = normalize(expanded).replace(/[/\\]+$/u, "");
  if (
    !isAbsolute(normalized) ||
    normalized.length < 3 ||
    /^[A-Za-z]:$/u.test(normalized) ||
    normalized.startsWith("\\\\") ||
    normalized.startsWith("//") ||
    normalized.includes("\0")
  ) {
    return undefined;
  }
  return `${normalized}${sep}`.normalize("NFC");
}

function djb2Hash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

export function sanitizePathForProjectKey(path: string): string {
  const sanitized = path.replace(/[^a-zA-Z0-9]/gu, "-");
  if (sanitized.length <= MAX_SANITIZED_PROJECT_KEY_LENGTH) {
    return sanitized;
  }
  const hash = Math.abs(djb2Hash(path)).toString(36);
  return `${sanitized.slice(0, MAX_SANITIZED_PROJECT_KEY_LENGTH)}-${hash}`;
}

async function readSettings(
  source: PermissionRuleSource,
  opts: ResolveAutoMemoryDirectoryOptions,
): Promise<SettingsJson | null> {
  if (opts.settings && Object.prototype.hasOwnProperty.call(opts.settings, source)) {
    return opts.settings[source] ?? null;
  }
  const path = getSettingsFilePathForSource(source, {
    cwd: effectiveCwd(opts),
    home: effectiveHome(opts),
    flagSettingsPath: opts.flagSettingsPath,
    managedSettingsPath: opts.managedSettingsPath,
  });
  if (path === null) return null;
  return (opts.readSettingsFile ?? readSettingsFileLenient)(path);
}

async function readAutoMemoryEnabledSetting(
  opts: ResolveAutoMemoryDirectoryOptions,
): Promise<boolean | undefined> {
  let authoritative: boolean | undefined;
  for (const source of AUTO_MEMORY_ENABLED_AUTHORITY_SOURCES) {
    const settings = await readSettings(source, opts);
    if (typeof settings?.autoMemoryEnabled === "boolean") {
      authoritative = settings.autoMemoryEnabled;
      break;
    }
  }
  // Repository content may reduce background activity but cannot enable a
  // model call or override an operator disable.
  for (const source of AUTO_MEMORY_REPOSITORY_SOURCES) {
    const settings = await readSettings(source, opts);
    if (settings?.autoMemoryEnabled === false) {
      return false;
    }
  }
  return authoritative;
}

async function readAutoMemoryDirectorySetting(
  opts: ResolveAutoMemoryDirectoryOptions,
): Promise<{ readonly raw?: string; readonly invalid: boolean }> {
  for (const source of AUTO_MEMORY_DIRECTORY_SOURCES) {
    const settings = await readSettings(source, opts);
    if (!settings || !Object.prototype.hasOwnProperty.call(settings, "autoMemoryDirectory")) {
      continue;
    }
    const raw = settings.autoMemoryDirectory;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return { invalid: true };
    }
    return { raw, invalid: false };
  }
  return { invalid: false };
}

function resolveProjectRoot(cwd: string): string {
  const stableRoot = findProjectRootSync(cwd)?.rootDir ?? cwd;
  return findCanonicalGitRoot(stableRoot) ?? stableRoot;
}

export async function resolveAutoMemoryDirectory(
  opts: ResolveAutoMemoryDirectoryOptions = {},
): Promise<AutoMemoryPathResult> {
  const env = effectiveEnv(opts.env);
  const disabled = envValue(env, "AGENC_DISABLE_AUTO_MEMORY");
  if (isEnvTruthy(disabled)) {
    return { enabled: false, reason: "disabled_by_env" };
  }
  if (!isEnvDefinedFalsy(disabled)) {
    if (isEnvTruthy(envValue(env, "AGENC_SIMPLE"))) {
      return { enabled: false, reason: "simple_mode" };
    }
    if (
      isEnvTruthy(envValue(env, "AGENC_REMOTE")) &&
      !envValue(env, "AGENC_REMOTE_MEMORY_DIR")
    ) {
      return { enabled: false, reason: "remote_without_memory_dir" };
    }
    const enabledSetting = await readAutoMemoryEnabledSetting(opts);
    if (enabledSetting === false) {
      return { enabled: false, reason: "disabled_by_settings" };
    }
  }

  const homeDir = effectiveHome(opts);
  const overrideRaw = envValue(env, "AGENC_COWORK_MEMORY_PATH_OVERRIDE");
  if (overrideRaw !== undefined && overrideRaw.trim().length > 0) {
    const override = validateAutoMemoryDirectoryPath(overrideRaw, {
      expandTilde: false,
      homeDir,
    });
    if (!override) {
      return { enabled: false, reason: "invalid_memory_path_override" };
    }
    return { enabled: true, path: override };
  }

  const setting = await readAutoMemoryDirectorySetting(opts);
  if (setting.invalid) {
    return { enabled: false, reason: "invalid_memory_path_setting" };
  }
  if (setting.raw !== undefined) {
    const settingPath = validateAutoMemoryDirectoryPath(setting.raw, {
      expandTilde: true,
      homeDir,
    });
    if (!settingPath) {
      return { enabled: false, reason: "invalid_memory_path_setting" };
    }
    return { enabled: true, path: settingPath };
  }

  const remoteMemoryDir = envValue(env, "AGENC_REMOTE_MEMORY_DIR");
  const baseRoot =
    remoteMemoryDir !== undefined && remoteMemoryDir.trim().length > 0
      ? validateAutoMemoryDirectoryPath(remoteMemoryDir, {
          expandTilde: false,
          homeDir,
        })
      : normalizeWithTrailingSep(resolveConfigHome(opts));
  if (!baseRoot) {
    return { enabled: false, reason: "invalid_remote_memory_dir" };
  }

  const projectRoot = resolveProjectRoot(effectiveCwd(opts));
  return {
    enabled: true,
    path: normalizeWithTrailingSep(
      join(baseRoot, "projects", sanitizePathForProjectKey(projectRoot), AUTO_MEMORY_DIRNAME),
    ),
  };
}

export function isPathInsideMemoryDir(candidate: string, memoryDir: string): boolean {
  const root = normalize(memoryDir);
  const normalizedRoot = root.endsWith(sep) ? root.slice(0, -1) : root;
  const normalizedCandidate = normalize(candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}
