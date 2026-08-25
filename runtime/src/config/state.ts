import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  cloneRecord,
  duplicateJsonObjectPaths,
  isPlainRecord,
  type JsonRecord,
} from "./json.js";

export const CANONICAL_STATE_VERSION = 1 as const;
export const CANONICAL_STATE_VERSION_KEY = "state_version" as const;
export const CANONICAL_STATE_NAMESPACE_KEY = "state" as const;
export const GLOBAL_RUNTIME_STATE_KEY = "global" as const;

export interface CanonicalStateDocument extends JsonRecord {
  readonly state_version: typeof CANONICAL_STATE_VERSION;
  readonly state: JsonRecord;
}

export class StateRepositoryError extends Error {
  readonly name = "StateRepositoryError";
  readonly path?: string;

  constructor(message: string, path?: string) {
    super(message);
    this.path = path;
  }
}

function credentialStateError(path: string, field: string): StateRepositoryError {
  return new StateRepositoryError(
    `${path} contains credential authority at ${field}; credentials must be ` +
      `migrated to native secure storage and removed from state.json`,
    path,
  );
}

const CONFIG_OWNED_GLOBAL_FIELDS = Object.freeze([
  "autoUpdates",
  "remoteControlAtStartup",
  "autoUpdatesProtectedForNative",
  "editorMode",
  "tui",
  "respectGitignore",
  "bypassPermissionsModeAcceptedIn",
  "env",
  "providerProfiles",
  "activeProviderProfileId",
  "openaiAdditionalModelOptionsCacheByProfile",
  "mcpServers",
  "theme",
  "showTurnDuration",
  "autoInstallIdeExtension",
  "fileCheckpointingEnabled",
  "terminalProgressBarEnabled",
  "copyOnSelect",
  "flickerFreeMode",
  "preferTmuxOverIterm2",
  "teammateMode",
  "teammateDefaultModel",
  "prStatusFooterEnabled",
  "speculationEnabled",
] as const);

const CREDENTIAL_OWNED_GLOBAL_FIELDS = Object.freeze([
  "primaryApiKey",
  "apiKeyHelper",
  "oauthAccount",
  "chromeExtension",
  "customApiKeyResponses",
] as const);

/**
 * The complete global runtime-state surface. Adding a field here is a security
 * and ownership decision: operator preferences belong in config.toml and
 * credentials or approval identities belong in native secure storage.
 */
export const GLOBAL_RUNTIME_STATE_FIELDS = Object.freeze([
  "projects",
  "installMethod",
  "userID",
  "hasAcknowledgedCostThreshold",
  "hasUsedBackslashReturn",
  "hasSeenTasksHint",
  "hasUsedStash",
  "appleTerminalBackupPath",
  "appleTerminalSetupInProgress",
  "shiftEnterKeyBindingInstalled",
  "optionAsMetaKeyInstalled",
  "hasIdeOnboardingBeenShown",
  "iterm2It2SetupComplete",
  "skillUsage",
  "penguinModeOrgEnabled",
  "cachedExtraUsageDisabledReason",
  // Internal acknowledgement state used by the canonical settings resolver.
  "settings",
] as const);

const PROJECT_TRUST_FIELDS = Object.freeze([
  "hasTrustDialogAccepted",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "enableAllProjectMcpServers",
  "approvedMcpjsonServerDigests",
] as const);

const PROJECT_EXECUTION_POLICY_FIELDS = Object.freeze([
  "allowedTools",
  "mcpContextUris",
  "mcpServers",
  "disabledMcpServers",
  "enabledMcpServers",
] as const);

export const RETIRED_PROJECT_STATE_FIELDS = Object.freeze([
  "hasCompletedProjectOnboarding",
  "projectOnboardingSeenCount",
  "hasAgenCMdExternalIncludesWarningShown",
  "remoteControlSpawnMode",
] as const);

/**
 * The complete persisted project-state surface. Keep this list aligned with
 * ProjectRuntimeState: an unknown field must fail closed instead of becoming a
 * new trust or execution-policy authority by accident.
 */
export const PROJECT_RUNTIME_STATE_FIELDS = Object.freeze([
  "lastAPIDuration",
  "lastAPIDurationWithoutRetries",
  "lastToolDuration",
  "lastCost",
  "lastDuration",
  "lastLinesAdded",
  "lastLinesRemoved",
  "lastTotalInputTokens",
  "lastTotalOutputTokens",
  "lastTotalCacheCreationInputTokens",
  "lastTotalCacheReadInputTokens",
  "lastTotalWebSearchRequests",
  "lastFpsAverage",
  "lastFpsLow1Pct",
  "lastSessionId",
  "lastModelUsage",
  "lastSessionMetrics",
  "exampleFiles",
  "exampleFilesGeneratedAt",
  "activeWorktreeSession",
] as const);

function assertProjectsContainOnlyRuntimeState(
  global: Readonly<JsonRecord>,
  path: string,
): void {
  const projects = global.projects;
  if (projects === undefined) return;
  if (!isPlainRecord(projects)) {
    throw new StateRepositoryError(
      `${path}.state.global.projects must be an object`,
      path,
    );
  }
  for (const [projectPath, project] of Object.entries(projects)) {
    if (!isPlainRecord(project)) {
      throw new StateRepositoryError(
        `${path}.state.global.projects.${projectPath} must be an object`,
        path,
      );
    }
    const trustFields = PROJECT_TRUST_FIELDS.filter(
      (field) => project[field] !== undefined,
    );
    if (trustFields.length > 0) {
      throw new StateRepositoryError(
        `${path} contains project trust decisions in state.global.projects.${projectPath}: ` +
          `${trustFields.join(", ")}; migrate them to trusted-projects.json`,
        path,
      );
    }
    const policyFields = PROJECT_EXECUTION_POLICY_FIELDS.filter(
      (field) => project[field] !== undefined,
    );
    if (policyFields.length > 0) {
      throw new StateRepositoryError(
        `${path} contains executable policy in state.global.projects.${projectPath}: ` +
          `${policyFields.join(", ")}; migrate operator policy to config.toml`,
        path,
      );
    }
    const retiredFields = RETIRED_PROJECT_STATE_FIELDS.filter(
      (field) => project[field] !== undefined,
    );
    if (retiredFields.length > 0) {
      throw new StateRepositoryError(
        `${path} contains retired project compatibility state in state.global.projects.${projectPath}: ` +
          `${retiredFields.join(", ")}; project onboarding is owned by onboarding.json and unused markers must be removed`,
        path,
      );
    }
    const unknownFields = Object.keys(project).filter(
      (field) =>
        !(PROJECT_RUNTIME_STATE_FIELDS as readonly string[]).includes(field),
    );
    if (unknownFields.length > 0) {
      throw new StateRepositoryError(
        `${path} contains unsupported project runtime state in state.global.projects.${projectPath}: ` +
          `${unknownFields.join(", ")}; only metrics, caches, and active worktree facts may be persisted`,
        path,
      );
    }
  }
}

function assertGlobalStateContainsNoConfigAuthority(
  global: Readonly<JsonRecord>,
  path: string,
): void {
  const fields = CONFIG_OWNED_GLOBAL_FIELDS.filter(
    (field) => global[field] !== undefined,
  );
  if (fields.length === 0) return;
  throw new StateRepositoryError(
    `${path} contains operator configuration in state.global: ${fields.join(", ")}; ` +
      `run "agenc config migrate" to move it to config.toml`,
    path,
  );
}

function assertSettingsNamespaceContainsOnlyRuntimeState(
  global: Readonly<JsonRecord>,
  path: string,
): void {
  const settings = global.settings;
  if (settings === undefined) return;
  if (!isPlainRecord(settings)) {
    throw new StateRepositoryError(
      `${path}.state.global.settings must be an object`,
      path,
    );
  }
  const allowed = new Set([
    "fastModePerSessionOptIn",
    "bypassPermissionsModeAcceptedIn",
  ]);
  const unknown = Object.keys(settings).filter(field => !allowed.has(field));
  if (unknown.length > 0) {
    throw new StateRepositoryError(
      `${path} contains operator configuration in state.global.settings: ${unknown.join(", ")}; ` +
        `run "agenc config migrate" to move it to config.toml`,
      path,
    );
  }
  if (
    settings.fastModePerSessionOptIn !== undefined &&
    typeof settings.fastModePerSessionOptIn !== "boolean"
  ) {
    throw new StateRepositoryError(
      `${path}.state.global.settings.fastModePerSessionOptIn must be a boolean`,
      path,
    );
  }
  if (
    settings.bypassPermissionsModeAcceptedIn !== undefined &&
    (!Array.isArray(settings.bypassPermissionsModeAcceptedIn) ||
      settings.bypassPermissionsModeAcceptedIn.some(value => typeof value !== "string"))
  ) {
    throw new StateRepositoryError(
      `${path}.state.global.settings.bypassPermissionsModeAcceptedIn must be a string array`,
      path,
    );
  }
}

function assertGlobalStateContainsOnlyRuntimeState(
  global: Readonly<JsonRecord>,
  path: string,
): void {
  const unknown = Object.keys(global).filter(
    field => !(GLOBAL_RUNTIME_STATE_FIELDS as readonly string[]).includes(field),
  );
  if (unknown.length === 0) return;
  throw new StateRepositoryError(
    `${path} contains unsupported or retired state in state.global: ${unknown.join(", ")}; ` +
      `only observed runtime facts, acknowledgements, and bounded caches may be persisted`,
    path,
  );
}

/**
 * State is deliberately not a credential store. These checks are structural
 * so both migration output and hand-edited state fail closed before runtime
 * code can accidentally copy a secret forward.
 */
export function assertCanonicalStateContainsNoCredentials(
  document: Readonly<CanonicalStateDocument>,
  path = "<state>",
): void {
  const global = document.state[GLOBAL_RUNTIME_STATE_KEY];
  if (global === undefined) return;
  if (!isPlainRecord(global)) {
    throw new StateRepositoryError(
      `${path}.${CANONICAL_STATE_NAMESPACE_KEY}.${GLOBAL_RUNTIME_STATE_KEY} must be an object`,
      path,
    );
  }
  for (const field of CREDENTIAL_OWNED_GLOBAL_FIELDS) {
    if (global[field] !== undefined) {
      throw credentialStateError(
        path,
        `${CANONICAL_STATE_NAMESPACE_KEY}.${GLOBAL_RUNTIME_STATE_KEY}.${field}`,
      );
    }
  }

  const profiles = global.providerProfiles;
  if (profiles !== undefined) {
    if (!Array.isArray(profiles)) {
      throw new StateRepositoryError(
        `${path}.${CANONICAL_STATE_NAMESPACE_KEY}.${GLOBAL_RUNTIME_STATE_KEY}.providerProfiles must be an array`,
        path,
      );
    }
    profiles.forEach((profile, index) => {
      if (!isPlainRecord(profile)) {
        throw new StateRepositoryError(
          `${path}.${CANONICAL_STATE_NAMESPACE_KEY}.${GLOBAL_RUNTIME_STATE_KEY}.providerProfiles[${index}] must be an object`,
          path,
        );
      }
      for (const field of ["apiKey", "authHeaderValue"] as const) {
        if (profile[field] !== undefined) {
          throw credentialStateError(
            path,
            `${CANONICAL_STATE_NAMESPACE_KEY}.${GLOBAL_RUNTIME_STATE_KEY}.providerProfiles[${index}].${field}`,
          );
        }
      }
    });
  }

  assertProjectsContainOnlyRuntimeState(global, path);
  assertGlobalStateContainsNoConfigAuthority(global, path);
  assertSettingsNamespaceContainsOnlyRuntimeState(global, path);
  assertGlobalStateContainsOnlyRuntimeState(global, path);
}

export function validateCanonicalStateDocument(
  value: unknown,
  path = "<state>",
): CanonicalStateDocument {
  if (!isPlainRecord(value)) {
    throw new StateRepositoryError(`state document is not an object: ${path}`, path);
  }

  const unknownKeys = Object.keys(value).filter(
    (key) =>
      key !== CANONICAL_STATE_VERSION_KEY &&
      key !== CANONICAL_STATE_NAMESPACE_KEY,
  );
  if (unknownKeys.length > 0) {
    throw new StateRepositoryError(
      `${path} contains unknown top-level state key${unknownKeys.length === 1 ? "" : "s"}: ` +
        unknownKeys.join(", "),
      path,
    );
  }

  if (value[CANONICAL_STATE_VERSION_KEY] !== CANONICAL_STATE_VERSION) {
    throw new StateRepositoryError(
      `${path} must declare ${CANONICAL_STATE_VERSION_KEY} = ${CANONICAL_STATE_VERSION}`,
      path,
    );
  }
  if (!isPlainRecord(value[CANONICAL_STATE_NAMESPACE_KEY])) {
    throw new StateRepositoryError(
      `${path} must contain an object at ${CANONICAL_STATE_NAMESPACE_KEY}`,
      path,
    );
  }

  const document = Object.freeze(cloneRecord(value)) as CanonicalStateDocument;
  assertCanonicalStateContainsNoCredentials(document, path);
  return document;
}

export function createCanonicalStateDocument(
  state: Readonly<JsonRecord> = {},
): CanonicalStateDocument {
  return validateCanonicalStateDocument({
    [CANONICAL_STATE_VERSION_KEY]: CANONICAL_STATE_VERSION,
    [CANONICAL_STATE_NAMESPACE_KEY]: cloneRecord(state),
  });
}

export function getGlobalRuntimeState(
  document: Readonly<CanonicalStateDocument>,
  path = "<state>",
): JsonRecord {
  const global = document.state[GLOBAL_RUNTIME_STATE_KEY];
  if (global === undefined) return {};
  if (!isPlainRecord(global)) {
    throw new StateRepositoryError(
      `${path}.${CANONICAL_STATE_NAMESPACE_KEY}.${GLOBAL_RUNTIME_STATE_KEY} must be an object`,
      path,
    );
  }
  return cloneRecord(global);
}

export function withGlobalRuntimeState(
  document: Readonly<CanonicalStateDocument> | null,
  global: Readonly<JsonRecord>,
): CanonicalStateDocument {
  return validateCanonicalStateDocument({
    [CANONICAL_STATE_VERSION_KEY]: CANONICAL_STATE_VERSION,
    [CANONICAL_STATE_NAMESPACE_KEY]: {
      ...(document?.state ?? {}),
      [GLOBAL_RUNTIME_STATE_KEY]: cloneRecord(global),
    },
  });
}

/** Parse the single canonical runtime-state envelope without lossy JSON rules. */
export function parseCanonicalStateDocument(
  text: string,
  path = "<state>",
): CanonicalStateDocument {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const duplicateCount = duplicateJsonObjectPaths(normalized).length;
  if (duplicateCount > 0) {
    throw new StateRepositoryError(
      `state JSON contains ${duplicateCount} duplicate object ` +
        `key${duplicateCount === 1 ? "" : "s"} at ${path}`,
      path,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized) as unknown;
  } catch (error) {
    throw new StateRepositoryError(
      `invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }
  return validateCanonicalStateDocument(parsed, path);
}

export async function readCanonicalState(
  path: string,
): Promise<CanonicalStateDocument | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseCanonicalStateDocument(text, path);
}

export function serializeCanonicalState(
  state: Readonly<CanonicalStateDocument>,
): string {
  const validated = validateCanonicalStateDocument(state);
  return `${JSON.stringify(validated, null, 2)}\n`;
}

/** Strict atomic state write. There is intentionally no in-place fallback. */
export function writeCanonicalStateAtomicSync(
  path: string,
  state: Readonly<CanonicalStateDocument>,
): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new StateRepositoryError(
        `state path must not be a symbolic link: ${path}`,
        path,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, serializeCanonicalState(state), {
      encoding: "utf8",
      flag: "wx",
      flush: true,
      mode: 0o600,
    });
    renameSync(temporary, path);

    // Persist the directory entry where the platform supports directory fsync.
    let directoryFd: number | undefined;
    try {
      directoryFd = openSync(parent, "r");
      fsyncSync(directoryFd);
    } catch {
      // Windows and some virtual filesystems do not permit opening directories.
    } finally {
      if (directoryFd !== undefined) closeSync(directoryFd);
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
