import { AsyncLocalStorage } from "node:async_hooks";
import { tmpdir } from "node:os";
import { isAbsolute, normalize } from "node:path";
import { parse as parseShellWords, type ParseEntry } from "shell-quote";
import { getCurrentRuntimeSession } from "./current-session.js";

/**
 * Session-scoped operator inputs that must never be inherited from the
 * daemon's process-global environment after a session has been created.
 */
export interface AgentRuntimeOptions {
  readonly [key: string]: boolean | string | readonly string[] | undefined;
  readonly simpleMode: boolean;
  readonly stdinDataMode: boolean;
  readonly remoteMode: boolean;
  readonly remoteMemoryRoot?: string;
  readonly coworkMemoryPathOverride?: string;
  readonly coworkMemoryExtraGuidelines?: string;
  readonly posixShellPath?: string;
  readonly commandWrapperArgv?: readonly string[];
  readonly sessionTempRoot?: string;
  readonly pluginStorageRoot?: string;
  readonly allowUntrustedHooks: boolean;
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
  const session = getCurrentRuntimeSession();
  if (session !== null) {
    const options = session.services?.runtimeOptions;
    if (options === undefined) {
      throw new Error(
        "Active runtime session has no captured runtime-options authority",
      );
    }
    return options;
  }
  return peekAgentRuntimeOptions();
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
  return getActiveAgentRuntimeOptions()?.sessionTempRoot ?? normalize(tmpdir());
}

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

const REMOVED_SIMPLE_MODE_ENV_KEYS = Object.freeze([
  "AGENC_SIMPLE",
  "AGENC_BARE",
] as const);

/** Reject removed environment aliases; CLI simple mode is selected only by --bare. */
export function assertNoRemovedSimpleModeEnvironment(
  env: NodeJS.ProcessEnv,
): void {
  for (const key of REMOVED_SIMPLE_MODE_ENV_KEYS) {
    if (env[key] !== undefined) {
      throw new AgentRuntimeOptionsError(`${key} was removed; use --bare`);
    }
  }
}

/** Parse the supported operator environment exactly once at a client boundary. */
export function resolveAgentRuntimeOptions(
  env: NodeJS.ProcessEnv,
  overrides: Partial<AgentRuntimeOptions> = {},
): AgentRuntimeOptions {
  assertNoRemovedSimpleModeEnvironment(env);
  if (env.AGENC_PLUGIN_SEED_DIR !== undefined) {
    throw new AgentRuntimeOptionsError(
      "AGENC_PLUGIN_SEED_DIR was removed because plugin packages have one storage authority. Copy required versioned packages into $AGENC_HOME/plugins/cache (or AGENC_PLUGIN_CACHE_DIR/cache) and remove AGENC_PLUGIN_SEED_DIR.",
    );
  }
  if (env.AGENC_PLUGIN_USE_ZIP_CACHE !== undefined) {
    throw new AgentRuntimeOptionsError(
      "AGENC_PLUGIN_USE_ZIP_CACHE was removed with the unused ZIP loader. Remove the variable; plugin packages use the sole versioned directory cache under $AGENC_HOME/plugins/cache (or AGENC_PLUGIN_CACHE_DIR/cache).",
    );
  }
  const parsedWrapper =
    overrides.commandWrapperArgv === undefined
      ? parseWrapper(env.AGENC_SHELL_PREFIX)
      : undefined;
  const resolved: AgentRuntimeOptions = {
    simpleMode: overrides.simpleMode ?? false,
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
          posixShellPath: optionalAbsolutePath(
            overrides.posixShellPath,
            "runtimeOptions.posixShellPath",
          ),
        }
      : env.AGENC_SHELL !== undefined
        ? {
            posixShellPath: optionalAbsolutePath(
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
    ...(overrides.sessionTempRoot !== undefined
      ? {
          sessionTempRoot: optionalAbsolutePath(
            overrides.sessionTempRoot,
            "runtimeOptions.sessionTempRoot",
          ),
        }
      : env.AGENC_TMPDIR !== undefined
        ? {
            sessionTempRoot: optionalAbsolutePath(
              env.AGENC_TMPDIR,
              "AGENC_TMPDIR",
            ),
          }
        : {}),
    ...(overrides.pluginStorageRoot !== undefined
      ? {
          pluginStorageRoot: optionalAbsolutePath(
            overrides.pluginStorageRoot,
            "runtimeOptions.pluginStorageRoot",
          ),
        }
      : env.AGENC_PLUGIN_CACHE_DIR !== undefined
        ? {
            pluginStorageRoot: optionalAbsolutePath(
              env.AGENC_PLUGIN_CACHE_DIR,
              "AGENC_PLUGIN_CACHE_DIR",
            ),
          }
        : {}),
    allowUntrustedHooks:
      overrides.allowUntrustedHooks ??
      parseBoolean(env, "AGENC_ALLOW_UNTRUSTED_HOOKS", false),
  };
  return Object.freeze(resolved);
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
  for (const [key, entry] of [
    ["posixShellPath", input.posixShellPath],
    ["sessionTempRoot", input.sessionTempRoot],
    ["pluginStorageRoot", input.pluginStorageRoot],
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
