/**
 * Source-aligned with `src/memdir/paths.ts` at donor commit
 * 0ca43335375beec6e58711b797d5b0c4bb5019b8.
 *
 * Why this lives here / shape difference from upstream:
 *   - `runtime/src/memdir/**` is excluded from the strict build, so the
 *     extraction service carries the small path subset it needs locally. The
 *     final `<base>/projects/<sanitized-root>/memory/` layout itself comes
 *     from `runtime/src/memory` so the child writes where the prompt and
 *     recall look.
 *   - Explicit env/settings overrides fail closed when unsafe instead of
 *     silently falling back to another directory, because the child tool
 *     policy uses this path as its only read/write root.
 *
 * Scope boundaries:
 *   - remote/team memory routing and feature gates beyond the single
 *     auto-memory directory used by S-03.
 */

import { homedir } from "node:os";
import { projectStorageKey } from "../../utils/project-storage-key.js";
import {
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from "node:path";
import { findGitRoot as findCanonicalGitRoot } from "../../agents/worktree.js";
import { buildProjectMemoryDirectory } from "../../memory/paths.js";
import type { AgenCConfig } from "../../config/schema.js";
import type { ConfigStore } from "../../config/store.js";
import {
  getAgenCHomeDir,
  isBareMode,
} from "../../utils/envUtils.js";
import { findProjectRootSync } from "../../session/session-store.js";
import type { PermissionRuleSource } from "../../permissions/types.js";
import { getSettingsForSource } from "../../utils/settings/settings.js";
import {
  getActiveAgentRuntimeOptions,
  type AgentRuntimeOptions,
} from "../../session/runtime-options.js";

export const AUTO_MEMORY_INDEX_FILE = "MEMORY.md";

export interface AutoMemoryPathResult {
  readonly enabled: boolean;
  readonly path?: string;
  readonly reason?: string;
}

/**
 * Where an enabled project memory path came from: the cowork override, the
 * trusted `autoMemoryDirectory` setting, or the default
 * `<base>/projects/<key>/memory/`.
 */
type AutoMemoryPathSource = "cowork_override" | "setting" | "default";

export type MemoryPathEnv = Readonly<Record<string, string | undefined>>;

export type TrustedAutoMemoryDirectorySource = Extract<
  PermissionRuleSource,
  "policySettings" | "flagSettings" | "userSettings"
>;
type CanonicalSettingSource = Extract<
  PermissionRuleSource,
  "policySettings" | "flagSettings" | "userSettings" | "projectSettings" | "localSettings"
>;

export interface ResolveAutoMemoryDirectoryOptions {
  readonly env?: MemoryPathEnv;
  readonly cwd?: string;
  readonly homeDir?: string;
  readonly configHomeDir?: string;
  readonly configStore?: ConfigStore;
  readonly runtimeOptions?: Pick<
    AgentRuntimeOptions,
    "coworkMemoryPathOverride" | "remoteMode" | "remoteMemoryRoot"
  > & Partial<Pick<AgentRuntimeOptions, "simpleMode" | "coworkMemoryExtraGuidelines" | "lightMode" | "nonInteractive" | "routineRun">>;
  readonly settings?: {
    readonly [K in PermissionRuleSource]?: AgenCConfig | null;
  };
}

const AUTO_MEMORY_DIRECTORY_SOURCES: readonly TrustedAutoMemoryDirectorySource[] =
  ["policySettings", "flagSettings", "userSettings"];

const AUTO_MEMORY_ENABLED_AUTHORITY_SOURCES: readonly CanonicalSettingSource[] = [
  "policySettings",
  "flagSettings",
  "userSettings",
];
const AUTO_MEMORY_REPOSITORY_SOURCES: readonly CanonicalSettingSource[] = [
  "localSettings",
  "projectSettings",
];

function effectiveEnv(
  env: MemoryPathEnv | undefined,
): MemoryPathEnv {
  return env ?? process.env;
}

function effectiveCwd(opts: ResolveAutoMemoryDirectoryOptions): string {
  return opts.cwd ?? process.cwd();
}

function effectiveHome(opts: ResolveAutoMemoryDirectoryOptions): string {
  return opts.homeDir ?? (opts.env === undefined ? homedir() : opts.env.HOME ?? opts.env.USERPROFILE ?? "");
}

function resolveConfigHome(opts: ResolveAutoMemoryDirectoryOptions): string {
  return opts.configHomeDir ??
    opts.configStore?.homeContext.path ??
    getAgenCHomeDir();
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

export function sanitizePathForProjectKey(path: string): string {
  return projectStorageKey(path);
}

function readSettings(
  source: CanonicalSettingSource,
  opts: ResolveAutoMemoryDirectoryOptions,
): AgenCConfig | null {
  if (opts.settings) {
    return opts.settings[source] ?? null;
  }
  return opts.configStore
    ? getSettingsForSource(source, opts.configStore)
    : getSettingsForSource(source);
}

function readAutoMemoryEnabledSetting(
  opts: ResolveAutoMemoryDirectoryOptions,
): boolean | undefined {
  let authoritative: boolean | undefined;
  for (const source of AUTO_MEMORY_ENABLED_AUTHORITY_SOURCES) {
    const settings = readSettings(source, opts);
    if (typeof settings?.autoMemoryEnabled === "boolean") {
      authoritative = settings.autoMemoryEnabled;
      break;
    }
  }
  // Repository content may reduce background activity but cannot enable a
  // model call or override an operator disable.
  for (const source of AUTO_MEMORY_REPOSITORY_SOURCES) {
    const settings = readSettings(source, opts);
    if (settings?.autoMemoryEnabled === false) {
      return false;
    }
  }
  return authoritative;
}

function readAutoMemoryDirectorySetting(
  opts: ResolveAutoMemoryDirectoryOptions,
): { readonly raw?: string; readonly invalid: boolean } {
  for (const source of AUTO_MEMORY_DIRECTORY_SOURCES) {
    const settings = readSettings(source, opts);
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
  return resolveAutoMemoryDirectorySync(opts);
}

/**
 * `resolveAutoMemoryDirectory` for callers that cannot wait, such as the
 * runtime sandbox check. Settings are read synchronously either way, so both
 * entry points resolve the same directory from the same inputs.
 */
export function resolveAutoMemoryDirectorySync(
  opts: ResolveAutoMemoryDirectoryOptions = {},
): AutoMemoryPathResult {
  return resolveAutoMemoryDirectoryWithSource(opts).result;
}

function resolveAutoMemoryDirectoryWithSource(
  opts: ResolveAutoMemoryDirectoryOptions,
): { readonly result: AutoMemoryPathResult; readonly source?: AutoMemoryPathSource } {
  const result = (value: AutoMemoryPathResult, source?: AutoMemoryPathSource) =>
    source === undefined ? { result: value } : { result: value, source };
  const env = effectiveEnv(opts.env);
  const runtimeOptions = opts.runtimeOptions ?? getActiveAgentRuntimeOptions();
  if (opts.runtimeOptions === undefined ? isBareMode() : opts.runtimeOptions.simpleMode === true) {
    return result({ enabled: false, reason: "simple_mode" });
  }
  if (runtimeOptions?.remoteMode && !runtimeOptions.remoteMemoryRoot) {
    return result({ enabled: false, reason: "remote_without_memory_dir" });
  }
  const enabledSetting = readAutoMemoryEnabledSetting(opts);
  if (enabledSetting === false) {
    return result({ enabled: false, reason: "disabled_by_settings" });
  }

  const homeDir = effectiveHome(opts);
  const overrideRaw = runtimeOptions === undefined
    ? envValue(env, "AGENC_COWORK_MEMORY_PATH_OVERRIDE")
    : runtimeOptions.coworkMemoryPathOverride;
  if (overrideRaw !== undefined && overrideRaw.trim().length > 0) {
    const override = validateAutoMemoryDirectoryPath(overrideRaw, {
      expandTilde: false,
      homeDir,
    });
    if (!override) {
      return result({ enabled: false, reason: "invalid_memory_path_override" });
    }
    return result({ enabled: true, path: override }, "cowork_override");
  }

  const setting = readAutoMemoryDirectorySetting(opts);
  if (setting.invalid) {
    return result({ enabled: false, reason: "invalid_memory_path_setting" });
  }
  if (setting.raw !== undefined) {
    const settingPath = validateAutoMemoryDirectoryPath(setting.raw, {
      expandTilde: true,
      homeDir,
    });
    if (!settingPath) {
      return result({ enabled: false, reason: "invalid_memory_path_setting" });
    }
    return result({ enabled: true, path: settingPath }, "setting");
  }

  const remoteMemoryDir = runtimeOptions?.remoteMemoryRoot;
  const baseRoot =
    remoteMemoryDir !== undefined && remoteMemoryDir.trim().length > 0
      ? validateAutoMemoryDirectoryPath(remoteMemoryDir, {
          expandTilde: false,
          homeDir,
        })
      : normalizeWithTrailingSep(resolveConfigHome(opts));
  if (!baseRoot) {
    return result({ enabled: false, reason: "invalid_remote_memory_dir" });
  }

  const projectRoot = resolveProjectRoot(effectiveCwd(opts));
  return result({
    enabled: true,
    path: buildProjectMemoryDirectory(baseRoot, projectRoot),
  }, "default");
}

/**
 * The global memory root for these options, or undefined when it cannot be
 * resolved. Same formula as `src/memory/paths.ts` (`<base>/memory`), computed
 * here from explicit options rather than ambient session state, which is why
 * this module keeps its own copy. Deliberately NOT moved by the
 * project-directory overrides above: a project override redirects that
 * project's memory, not the machine-wide root the main agent uses.
 */
export async function resolveGlobalMemoryDirectory(
  opts: ResolveAutoMemoryDirectoryOptions = {},
): Promise<string | undefined> {
  return resolveGlobalMemoryDirectorySync(opts);
}

/** `resolveGlobalMemoryDirectory` for callers that cannot wait. */
export function resolveGlobalMemoryDirectorySync(
  opts: ResolveAutoMemoryDirectoryOptions = {},
): string | undefined {
  const runtimeOptions = opts.runtimeOptions ?? getActiveAgentRuntimeOptions();
  const homeDir = effectiveHome(opts);
  const remoteMemoryDir = runtimeOptions?.remoteMemoryRoot;
  const baseRoot =
    remoteMemoryDir !== undefined && remoteMemoryDir.trim().length > 0
      ? validateAutoMemoryDirectoryPath(remoteMemoryDir, {
          expandTilde: false,
          homeDir,
        })
      : normalizeWithTrailingSep(resolveConfigHome(opts));
  if (!baseRoot) return undefined;
  return normalizeWithTrailingSep(join(baseRoot, "memory"));
}

/** The services of a live session that its memory directories are resolved from. */
export interface LiveSessionMemoryServices {
  readonly configStore?: ConfigStore;
  readonly userShell?: { readonly childEnvironment?: MemoryPathEnv };
  readonly providerEnvironment?: MemoryPathEnv;
  readonly runtimeOptions?: Partial<AgentRuntimeOptions>;
}

/**
 * The memory owner of a live session in `cwd`: the inputs its memory prompt
 * resolves the memory directories from. A daemon serves sessions of many
 * projects, so process-wide state (its own working directory, its own home)
 * can name other directories; everything that must agree with the prompt
 * (the prompt itself, the runtime sandbox) resolves from this owner instead.
 * Undefined without a ConfigStore, which is the prompt's authority.
 */
export function liveSessionMemoryOwner(
  services: LiveSessionMemoryServices | undefined,
  cwd: string,
): ResolveAutoMemoryDirectoryOptions | undefined {
  const configStore = services?.configStore;
  if (configStore === undefined) return undefined;
  return {
    cwd,
    configStore,
    env: services?.userShell?.childEnvironment ?? services?.providerEnvironment ?? {},
    runtimeOptions: { remoteMode: false, ...services?.runtimeOptions },
  };
}

/**
 * The durable memory directories the file tools of a live session may write
 * under the workspace sandbox: the global root and the project directory its
 * memory prompt names. Undefined when the session has no owner to resolve
 * them from. Empty when auto memory is off, cannot be resolved, or a cowork
 * override moved the project directory: an override gets no write carve-out,
 * as in `isDurableMemoryWritePath`.
 */
export function sessionDurableMemoryWriteRoots(
  services: LiveSessionMemoryServices | undefined,
  cwd: string,
): readonly string[] | undefined {
  const owner = liveSessionMemoryOwner(services, cwd);
  if (owner === undefined) return undefined;
  try {
    const { result: project, source } = resolveAutoMemoryDirectoryWithSource(owner);
    if (!project.enabled || project.path === undefined || source === "cowork_override") {
      return [];
    }
    const global = resolveGlobalMemoryDirectorySync(owner);
    return global === undefined ? [project.path] : [global, project.path];
  } catch {
    return [];
  }
}

export function isPathInsideMemoryDir(candidate: string, memoryDir: string): boolean {
  const root = normalize(memoryDir);
  const normalizedRoot = root.endsWith(sep) ? root.slice(0, -1) : root;
  const normalizedCandidate = normalize(candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}
