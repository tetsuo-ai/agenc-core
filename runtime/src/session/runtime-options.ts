import { AsyncLocalStorage } from "node:async_hooks";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import {
  parse as parseShellWords,
  quote as quoteShellWords,
  type ParseEntry,
} from "shell-quote";
import { resolveHomeContext } from "../config/home.js";
import { isSupportedPosixShellPath } from "../utils/shell/posixShellPath.js";
import {
  getCurrentRuntimeSession,
  peekScopedRuntimeSession,
} from "./current-session.js";
import { withChildTempAuthority } from "../utils/subprocessEnv.js";
import { normalizeExactAbsolutePath } from "../utils/path-authority.js";

/**
 * Session-scoped operator inputs that must never be inherited from the
 * daemon's process-global environment after a session has been created.
 */
export interface AgentRuntimeOptions {
  readonly [key: string]: boolean | string | readonly string[] | undefined;
  readonly simpleMode: boolean;
  /**
   * Immutable startup authority selected only by
   * `--dangerously-bypass-approvals-and-sandbox`.
   *
   * Ordinary `bypassPermissions` changes approval behavior without widening
   * the configured OS sandbox.
   */
  readonly dangerouslyBypassApprovalsAndSandbox: boolean;
  readonly stdinDataMode: boolean;
  readonly remoteMode: boolean;
  readonly remoteMemoryRoot?: string;
  readonly coworkMemoryPathOverride?: string;
  readonly coworkMemoryExtraGuidelines?: string;
  readonly posixShellPath?: string;
  readonly commandWrapperArgv?: readonly string[];
  readonly sessionTempRoot: string;
  readonly pluginStorageRoot: string;
  readonly allowUntrustedHooks: boolean;
}

/** Immutable command policy captured from one client environment at ingress. */
export interface CommandExecutionAuthority {
  readonly path: string;
  readonly commandWrapperArgv: readonly string[];
  readonly childEnvironment: Readonly<NodeJS.ProcessEnv>;
}

/** Resolve the shell and wrapper once; command runners must not reread env. */
export function resolveCommandExecutionAuthority(
  options: AgentRuntimeOptions,
  resolvedShellPath: string,
  scrubbedChildEnvironment: NodeJS.ProcessEnv,
): CommandExecutionAuthority {
  return Object.freeze({
    path: resolvedShellPath,
    commandWrapperArgv: Object.freeze([
      ...(options.commandWrapperArgv ?? []),
    ]),
    childEnvironment: Object.freeze(
      withChildTempAuthority(
        scrubbedChildEnvironment,
        options.sessionTempRoot,
      ),
    ),
  });
}

export class AgentRuntimeOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRuntimeOptionsError";
  }
}

const scopedRuntimeOptions = new AsyncLocalStorage<AgentRuntimeOptions>();

/** Bind startup work and all async descendants to one immutable option set. */
export function runWithAgentRuntimeOptions<T>(
  options: AgentRuntimeOptions,
  operation: () => T,
): T {
  return scopedRuntimeOptions.run(options, operation);
}

/** Read the session/startup binding without consulting process-global env. */
export function peekAgentRuntimeOptions(): AgentRuntimeOptions | undefined {
  return scopedRuntimeOptions.getStore();
}

/** Resolve the immutable runtime options owned by the active session/startup. */
export function getActiveAgentRuntimeOptions(): AgentRuntimeOptions | undefined {
  const scopedSession = peekScopedRuntimeSession();
  if (scopedSession !== null) {
    const options = scopedSession.services?.runtimeOptions;
    if (options === undefined) {
      throw new Error(
        "Active runtime session has no captured runtime-options authority",
      );
    }
    return options;
  }
  const scopedOptions = peekAgentRuntimeOptions();
  if (scopedOptions !== undefined) return scopedOptions;

  const fallbackSession = getCurrentRuntimeSession();
  if (fallbackSession === null) return undefined;
  const options = fallbackSession.services?.runtimeOptions;
  if (options === undefined) {
    throw new Error(
      "Active runtime session has no captured runtime-options authority",
    );
  }
  return options;
}

export function getSessionRemoteMemoryRoot(): string | undefined {
  return getActiveAgentRuntimeOptions()?.remoteMemoryRoot;
}

export function getSessionCoworkMemoryPathOverride(): string | undefined {
  return getActiveAgentRuntimeOptions()?.coworkMemoryPathOverride;
}

export function getSessionCoworkMemoryExtraGuidelines(): string | undefined {
  return getActiveAgentRuntimeOptions()?.coworkMemoryExtraGuidelines;
}

export function isSessionRemoteMode(): boolean {
  return getActiveAgentRuntimeOptions()?.remoteMode === true;
}

/**
 * Resolve the temporary-root authority for the active runtime session.
 *
 * A daemon may host clients with different `AGENC_TMPDIR` selections, so
 * sandbox and permission code must never consult the daemon's mutable process
 * environment directly. The OS temporary directory is only the common
 * platform fallback when the captured session/startup options did not select
 * an explicit root. Ambiguous multi-session access fails through
 * `getCurrentRuntimeSession()` instead of guessing.
 */
export function resolveSessionTempRoot(): string {
  return getActiveAgentRuntimeOptions()?.sessionTempRoot ?? DEFAULT_SESSION_TEMP_ROOT;
}

/** Stable per-user namespace below a captured temporary-root authority. */
export function getSessionTempNamespaceName(): string {
  if (process.platform === "win32") return "agenc";
  return `agenc-${process.getuid?.() ?? 0}`;
}

const DEFAULT_SESSION_TEMP_ROOT = normalize(tmpdir());

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function parseBoolean(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean,
): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw new AgentRuntimeOptionsError(
    `${key} must be one of 1, true, yes, on, 0, false, no, or off`,
  );
}

function optionalAbsolutePath(
  value: string | undefined,
  key: string,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!isAbsolute(trimmed)) {
    throw new AgentRuntimeOptionsError(`${key} must be an absolute path`);
  }
  return normalize(trimmed);
}

function requiredAbsolutePath(value: string, key: string): string {
  try {
    return normalizeExactAbsolutePath(value, key);
  } catch (error) {
    throw new AgentRuntimeOptionsError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function establishWritableDirectoryAuthority(value: string, key: string): string {
  const requestedRoot = requiredAbsolutePath(value, key);
  try {
    const created = mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
    const canonicalRoot = normalize(realpathSync(requestedRoot));
    const stats = lstatSync(canonicalRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("path is not a directory");
    }
    if (created !== undefined) chmodSync(canonicalRoot, 0o700);
    accessSync(
      canonicalRoot,
      fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK,
    );
    return canonicalRoot;
  } catch (error) {
    throw new AgentRuntimeOptionsError(
      `${key} must resolve to a writable directory: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Resolve only the session temporary-directory authority at process ingress. */
export function resolveSessionTempRootAtIngress(
  env: NodeJS.ProcessEnv,
  explicit?: string,
): string {
  return explicit !== undefined
    ? establishWritableDirectoryAuthority(
        explicit,
        "runtimeOptions.sessionTempRoot",
      )
    : env.AGENC_TMPDIR !== undefined
      ? establishWritableDirectoryAuthority(env.AGENC_TMPDIR, "AGENC_TMPDIR")
      : establishWritableDirectoryAuthority(
          DEFAULT_SESSION_TEMP_ROOT,
          "platform temporary directory",
        );
}

/** Resolve only the plugin storage authority at process ingress. */
export function resolvePluginStorageRootAtIngress(
  env: NodeJS.ProcessEnv,
  explicit?: string,
): string {
  const selected = explicit ??
    env.AGENC_PLUGIN_CACHE_DIR ??
    join(
      resolveHomeContext(
        env,
        env.HOME === undefined ? {} : { platformHome: env.HOME },
      ).path,
      "plugins",
    );
  return establishWritableDirectoryAuthority(
    selected,
    explicit !== undefined
      ? "runtimeOptions.pluginStorageRoot"
      : env.AGENC_PLUGIN_CACHE_DIR !== undefined
        ? "AGENC_PLUGIN_CACHE_DIR"
        : "default plugin storage directory",
  );
}

function optionalPosixShellPath(
  value: string | undefined,
  key: string,
): string | undefined {
  if (value !== undefined && value.trim().length === 0) {
    throw new AgentRuntimeOptionsError(
      `${key} must name a bash or zsh executable`,
    );
  }
  const shellPath = optionalAbsolutePath(value, key);
  if (shellPath !== undefined && !isSupportedPosixShellPath(shellPath)) {
    throw new AgentRuntimeOptionsError(
      `${key} must name a bash or zsh executable`,
    );
  }
  return shellPath;
}

function optionalString(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

function parseWrapper(value: string | undefined): readonly string[] | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let parsed: ParseEntry[];
  try {
    parsed = parseShellWords(trimmed, {});
  } catch (error) {
    throw new AgentRuntimeOptionsError(
      `AGENC_SHELL_PREFIX is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed.length === 0 || parsed.some((entry) => typeof entry !== "string")) {
    throw new AgentRuntimeOptionsError(
      "AGENC_SHELL_PREFIX must be a command and fixed arguments without shell operators, comments, or glob expressions",
    );
  }
  return Object.freeze(parsed as string[]);
}

export const RETIRED_AGENT_RUNTIME_ENV_REPLACEMENTS = Object.freeze({
  AGENC_SIMPLE: "use --bare",
  AGENC_BARE: "use --bare",
} as const);

/** Reject removed runtime-option aliases at every client/startup boundary. */
export function assertNoRetiredAgentRuntimeEnvironment(
  env: NodeJS.ProcessEnv,
): void {
  const present = Object.entries(RETIRED_AGENT_RUNTIME_ENV_REPLACEMENTS)
    .filter(([key]) => env[key] !== undefined);
  if (present.length === 0) return;
  throw new AgentRuntimeOptionsError(
    present
      .map(([key, replacement]) => `${key} was removed; ${replacement}`)
      .join("; "),
  );
}

/** Parse and freeze the complete runtime authority at an ingress boundary. */
export function resolveAgentRuntimeOptions(
  env: NodeJS.ProcessEnv,
  overrides: Partial<AgentRuntimeOptions> = {},
): AgentRuntimeOptions {
  return resolveAgentRuntimeOptionsAtIngress(env, overrides);
}

function resolveAgentRuntimeOptionsAtIngress(
  env: NodeJS.ProcessEnv,
  overrides: Partial<AgentRuntimeOptions>,
): AgentRuntimeOptions {
  assertNoRetiredAgentRuntimeEnvironment(env);
  const parsedWrapper =
    overrides.commandWrapperArgv === undefined
      ? parseWrapper(env.AGENC_SHELL_PREFIX)
      : undefined;
  const resolved: AgentRuntimeOptions = {
    simpleMode: overrides.simpleMode ?? false,
    dangerouslyBypassApprovalsAndSandbox:
      overrides.dangerouslyBypassApprovalsAndSandbox ?? false,
    stdinDataMode:
      overrides.stdinDataMode ??
      parseBoolean(env, "AGENC_USE_DATA_STDIN", false),
    remoteMode:
      overrides.remoteMode ?? parseBoolean(env, "AGENC_REMOTE", false),
    ...(overrides.remoteMemoryRoot !== undefined
      ? {
          remoteMemoryRoot: optionalAbsolutePath(
            overrides.remoteMemoryRoot,
            "runtimeOptions.remoteMemoryRoot",
          ),
        }
      : env.AGENC_REMOTE_MEMORY_DIR !== undefined
        ? {
            remoteMemoryRoot: optionalAbsolutePath(
              env.AGENC_REMOTE_MEMORY_DIR,
              "AGENC_REMOTE_MEMORY_DIR",
            ),
          }
        : {}),
    ...(overrides.coworkMemoryPathOverride !== undefined
      ? {
          coworkMemoryPathOverride: optionalAbsolutePath(
            overrides.coworkMemoryPathOverride,
            "runtimeOptions.coworkMemoryPathOverride",
          ),
        }
      : env.AGENC_COWORK_MEMORY_PATH_OVERRIDE !== undefined
        ? {
            coworkMemoryPathOverride: optionalAbsolutePath(
              env.AGENC_COWORK_MEMORY_PATH_OVERRIDE,
              "AGENC_COWORK_MEMORY_PATH_OVERRIDE",
            ),
          }
        : {}),
    ...((overrides.coworkMemoryExtraGuidelines ??
      optionalString(env.AGENC_COWORK_MEMORY_EXTRA_GUIDELINES)) !== undefined
      ? {
          coworkMemoryExtraGuidelines:
            overrides.coworkMemoryExtraGuidelines ??
            optionalString(env.AGENC_COWORK_MEMORY_EXTRA_GUIDELINES),
        }
      : {}),
    ...(overrides.posixShellPath !== undefined
      ? {
          posixShellPath: optionalPosixShellPath(
            overrides.posixShellPath,
            "runtimeOptions.posixShellPath",
          ),
        }
      : env.AGENC_SHELL !== undefined
        ? {
            posixShellPath: optionalPosixShellPath(
              env.AGENC_SHELL,
              "AGENC_SHELL",
            ),
          }
        : {}),
    ...(overrides.commandWrapperArgv !== undefined
      ? { commandWrapperArgv: Object.freeze([...overrides.commandWrapperArgv]) }
      : parsedWrapper !== undefined
        ? { commandWrapperArgv: parsedWrapper }
        : {}),
    sessionTempRoot: resolveSessionTempRootAtIngress(
      env,
      overrides.sessionTempRoot,
    ),
    pluginStorageRoot: resolvePluginStorageRootAtIngress(
      env,
      overrides.pluginStorageRoot,
    ),
    allowUntrustedHooks:
      overrides.allowUntrustedHooks ??
      parseBoolean(env, "AGENC_ALLOW_UNTRUSTED_HOOKS", false),
  };
  return Object.freeze(resolved);
}

/**
 * Project a captured runtime authority into the public environment names that
 * a child AgenC process resolves at its own ingress. `simpleMode` remains the
 * `--bare` CLI flag; stdin data mode belongs to the parent transport and is not
 * inherited by interactive teammates.
 */
export function projectAgentRuntimeOptionsEnvironment(
  options: AgentRuntimeOptions,
  baseEnvironment: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string>> {
  const runtimeEnvironmentKeys = new Set([
    "AGENC_REMOTE",
    "AGENC_REMOTE_MEMORY_DIR",
    "AGENC_COWORK_MEMORY_PATH_OVERRIDE",
    "AGENC_COWORK_MEMORY_EXTRA_GUIDELINES",
    "AGENC_SHELL",
    "AGENC_SHELL_PREFIX",
    "AGENC_TMPDIR",
    "AGENC_PLUGIN_CACHE_DIR",
    "AGENC_ALLOW_UNTRUSTED_HOOKS",
    // Stdin framing belongs to the parent transport and is deliberately not
    // projected to an interactive child.
    "AGENC_USE_DATA_STDIN",
  ]);
  const environment: Record<string, string> = Object.fromEntries(
    Object.entries(baseEnvironment).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && !runtimeEnvironmentKeys.has(entry[0]),
    ),
  );
  Object.assign(environment, {
    AGENC_REMOTE: options.remoteMode ? "1" : "0",
    AGENC_TMPDIR: options.sessionTempRoot,
    AGENC_PLUGIN_CACHE_DIR: options.pluginStorageRoot,
    AGENC_ALLOW_UNTRUSTED_HOOKS: options.allowUntrustedHooks ? "1" : "0",
  });
  if (options.remoteMemoryRoot !== undefined) {
    environment.AGENC_REMOTE_MEMORY_DIR = options.remoteMemoryRoot;
  }
  if (options.coworkMemoryPathOverride !== undefined) {
    environment.AGENC_COWORK_MEMORY_PATH_OVERRIDE =
      options.coworkMemoryPathOverride;
  }
  if (options.coworkMemoryExtraGuidelines !== undefined) {
    environment.AGENC_COWORK_MEMORY_EXTRA_GUIDELINES =
      options.coworkMemoryExtraGuidelines;
  }
  if (options.posixShellPath !== undefined) {
    environment.AGENC_SHELL = options.posixShellPath;
  }
  if (options.commandWrapperArgv !== undefined) {
    environment.AGENC_SHELL_PREFIX = quoteShellWords([
      ...options.commandWrapperArgv,
    ]);
  }
  return Object.freeze(environment);
}

/** Validate and freeze an untrusted daemon wire value. */
export function validateAgentRuntimeOptions(
  value: unknown,
): AgentRuntimeOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentRuntimeOptionsError("runtimeOptions must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "simpleMode",
    "dangerouslyBypassApprovalsAndSandbox",
    "stdinDataMode",
    "remoteMode",
    "remoteMemoryRoot",
    "coworkMemoryPathOverride",
    "coworkMemoryExtraGuidelines",
    "posixShellPath",
    "commandWrapperArgv",
    "sessionTempRoot",
    "pluginStorageRoot",
    "allowUntrustedHooks",
  ]);
  if (Object.prototype.hasOwnProperty.call(input, "pluginZipCache")) {
    throw new AgentRuntimeOptionsError(
      "runtimeOptions.pluginZipCache was removed with the unused ZIP loader; remove the field",
    );
  }
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new AgentRuntimeOptionsError(
        `runtimeOptions does not accept '${key}'`,
      );
    }
  }
  if (typeof input.simpleMode !== "boolean") {
    throw new AgentRuntimeOptionsError(
      "runtimeOptions.simpleMode is required and must be boolean",
    );
  }
  if (
    input.dangerouslyBypassApprovalsAndSandbox !== undefined &&
    typeof input.dangerouslyBypassApprovalsAndSandbox !== "boolean"
  ) {
    throw new AgentRuntimeOptionsError(
      "runtimeOptions.dangerouslyBypassApprovalsAndSandbox must be boolean",
    );
  }
  if (typeof input.stdinDataMode !== "boolean") {
    throw new AgentRuntimeOptionsError(
      "runtimeOptions.stdinDataMode is required and must be boolean",
    );
  }
  if (typeof input.remoteMode !== "boolean") {
    throw new AgentRuntimeOptionsError(
      "runtimeOptions.remoteMode is required and must be boolean",
    );
  }
  if (typeof input.allowUntrustedHooks !== "boolean") {
    throw new AgentRuntimeOptionsError(
      "runtimeOptions.allowUntrustedHooks is required and must be boolean",
    );
  }
  if (typeof input.pluginStorageRoot !== "string") {
    throw new AgentRuntimeOptionsError(
      "runtimeOptions.pluginStorageRoot is required and must be a string",
    );
  }
  for (const [key, entry] of [
    ["posixShellPath", input.posixShellPath],
    ["sessionTempRoot", input.sessionTempRoot],
    ["remoteMemoryRoot", input.remoteMemoryRoot],
    ["coworkMemoryPathOverride", input.coworkMemoryPathOverride],
    ["coworkMemoryExtraGuidelines", input.coworkMemoryExtraGuidelines],
  ] as const) {
    if (entry !== undefined && typeof entry !== "string") {
      throw new AgentRuntimeOptionsError(
        `runtimeOptions.${key} must be a string`,
      );
    }
  }
  if (
    input.commandWrapperArgv !== undefined &&
    (!Array.isArray(input.commandWrapperArgv) ||
      !input.commandWrapperArgv.every(
        (entry) => typeof entry === "string" && entry.length > 0,
      ))
  ) {
    throw new AgentRuntimeOptionsError(
      "runtimeOptions.commandWrapperArgv must be a non-empty string array",
    );
  }
  return resolveAgentRuntimeOptions({}, input as Partial<AgentRuntimeOptions>);
}
