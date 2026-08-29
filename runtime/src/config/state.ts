import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  type BigIntStats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

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
export const CANONICAL_STATE_FILE_MODE = 0o600 as const;

export type CanonicalStateDirectoryDurability =
  | "confirmed"
  | "unsupported"
  | "indeterminate";

export interface CanonicalStateWriteOutcome {
  readonly committed: true;
  readonly directoryDurability: CanonicalStateDirectoryDurability;
  readonly postCommitErrors: readonly Error[];
}

export interface CanonicalStateFileSnapshot {
  readonly document: CanonicalStateDocument;
  /** Exact validated file bytes; callers must copy before retaining them. */
  readonly bytes: Buffer;
  readonly version: CanonicalStateFileVersion;
}

export interface CanonicalStateFileVersion {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly nlink: bigint;
}

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

const STATE_NO_FOLLOW_FLAG = typeof fsConstants.O_NOFOLLOW === "number"
  ? fsConstants.O_NOFOLLOW
  : 0;

function stateFileError(path: string, detail: string): StateRepositoryError {
  return new StateRepositoryError(`${detail}: ${path}`, path);
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileContentMetadata(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertRegularStatePath(path: string, info: BigIntStats): void {
  if (info.isSymbolicLink()) {
    throw stateFileError(path, "state path must not be a symbolic link");
  }
  if (!info.isFile()) {
    throw stateFileError(path, "state path must be a regular file");
  }
  if (info.nlink !== 1n) {
    throw stateFileError(path, "state path must have exactly one hard link");
  }
  if (process.platform !== "win32") {
    if (
      typeof process.getuid === "function" &&
      info.uid !== BigInt(process.getuid())
    ) {
      throw stateFileError(path, "state path must be owned by the current user");
    }
    if ((info.mode & 0o777n) !== BigInt(CANONICAL_STATE_FILE_MODE)) {
      throw stateFileError(path, "state path must have exact mode 0600");
    }
  }
}

function assertOpenedStateIdentity(
  path: string,
  before: BigIntStats,
  opened: BigIntStats,
  afterOpen: BigIntStats,
): void {
  assertRegularStatePath(path, afterOpen);
  if (
    !opened.isFile() ||
    !sameFileIdentity(before, opened) ||
    !sameFileIdentity(opened, afterOpen)
  ) {
    throw stateFileError(path, "state file changed identity while it was opened");
  }
}

function assertReadStateIdentity(
  path: string,
  opened: BigIntStats,
  afterRead: BigIntStats,
  afterReadPath: BigIntStats,
): void {
  assertRegularStatePath(path, afterReadPath);
  if (
    !sameFileContentMetadata(opened, afterRead) ||
    !sameFileIdentity(afterRead, afterReadPath)
  ) {
    throw stateFileError(path, "state file changed while it was read");
  }
}

function isNoFollowUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" ||
    code === "ENOSYS" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP";
}

function throwStateOpenError(path: string, error: unknown): never {
  if ((error as NodeJS.ErrnoException).code === "ELOOP") {
    throw stateFileError(path, "state path must not be a symbolic link");
  }
  throw error;
}

async function openStateForRead(path: string) {
  const flags = fsConstants.O_RDONLY | STATE_NO_FOLLOW_FLAG;
  try {
    return await open(path, flags);
  } catch (error) {
    if (STATE_NO_FOLLOW_FLAG !== 0 && isNoFollowUnsupported(error)) {
      try {
        return await open(path, fsConstants.O_RDONLY);
      } catch (fallbackError) {
        throwStateOpenError(path, fallbackError);
      }
    }
    throwStateOpenError(path, error);
  }
}

function openStateForReadSync(path: string): number {
  const flags = fsConstants.O_RDONLY | STATE_NO_FOLLOW_FLAG;
  try {
    return openSync(path, flags);
  } catch (error) {
    if (STATE_NO_FOLLOW_FLAG !== 0 && isNoFollowUnsupported(error)) {
      try {
        return openSync(path, fsConstants.O_RDONLY);
      } catch (fallbackError) {
        throwStateOpenError(path, fallbackError);
      }
    }
    throwStateOpenError(path, error);
  }
}

async function lstatStateOrMissing(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function lstatStateOrMissingSync(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function lstatExistingState(path: string): Promise<BigIntStats> {
  const info = await lstatStateOrMissing(path);
  if (info === null) {
    throw stateFileError(path, "state file disappeared while it was read");
  }
  return info;
}

function lstatExistingStateSync(path: string): BigIntStats {
  const info = lstatStateOrMissingSync(path);
  if (info === null) {
    throw stateFileError(path, "state file disappeared while it was read");
  }
  return info;
}

/** Read canonical state bytes from one proven, non-symlink regular file. */
async function readStateText(path: string): Promise<string | null> {
  const before = await lstatStateOrMissing(path);
  if (before === null) return null;
  assertRegularStatePath(path, before);

  const handle = await openStateForRead(path);
  let readFailed = false;
  let readFailure: unknown;
  try {
    const opened = await handle.stat({ bigint: true });
    const afterOpen = await lstatExistingState(path);
    assertOpenedStateIdentity(path, before, opened, afterOpen);
    const text = await handle.readFile({ encoding: "utf8" });
    const afterRead = await handle.stat({ bigint: true });
    const afterReadPath = await lstatExistingState(path);
    assertReadStateIdentity(path, opened, afterRead, afterReadPath);
    return text;
  } catch (error) {
    readFailed = true;
    readFailure = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (closeError) {
      if (readFailed) {
        attachStateCleanupErrors(readFailure, [asStateCleanupError(closeError)]);
      } else {
        throw closeError;
      }
    }
  }
}

/** Synchronous form of the canonical no-follow regular-file read contract. */
function readStateBytesSync(path: string): {
  readonly bytes: Buffer;
  readonly version: CanonicalStateFileVersion;
} | null {
  const before = lstatStateOrMissingSync(path);
  if (before === null) return null;
  assertRegularStatePath(path, before);

  const descriptor = openStateForReadSync(path);
  let readFailed = false;
  let readFailure: unknown;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const afterOpen = lstatExistingStateSync(path);
    assertOpenedStateIdentity(path, before, opened, afterOpen);
    const bytes = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor, { bigint: true });
    const afterReadPath = lstatExistingStateSync(path);
    assertReadStateIdentity(path, opened, afterRead, afterReadPath);
    return Object.freeze({
      bytes,
      version: Object.freeze({
        dev: afterRead.dev,
        ino: afterRead.ino,
        size: afterRead.size,
        mtimeNs: afterRead.mtimeNs,
        ctimeNs: afterRead.ctimeNs,
        mode: afterRead.mode,
        uid: afterRead.uid,
        nlink: afterRead.nlink,
      }),
    });
  } catch (error) {
    readFailed = true;
    readFailure = error;
    throw error;
  } finally {
    try {
      closeSync(descriptor);
    } catch (closeError) {
      if (readFailed) {
        attachStateCleanupErrors(readFailure, [asStateCleanupError(closeError)]);
      } else {
        throw closeError;
      }
    }
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
  // Explicit bypass consent, keyed by the exact canonical working directory.
  "permissions",
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

function assertPermissionsNamespaceContainsOnlyRuntimeState(
  global: Readonly<JsonRecord>,
  path: string,
): void {
  const permissions = global.permissions;
  if (permissions === undefined) return;
  if (!isPlainRecord(permissions)) {
    throw new StateRepositoryError(
      `${path}.state.global.permissions must be an object`,
      path,
    );
  }
  const unknown = Object.keys(permissions).filter(
    (field) => field !== "bypassPermissionsAcceptedByCwd",
  );
  if (unknown.length > 0) {
    throw new StateRepositoryError(
      `${path}.state.global.permissions contains unsupported fields: ${unknown.join(", ")}`,
      path,
    );
  }
  const accepted = permissions.bypassPermissionsAcceptedByCwd;
  if (accepted === undefined) return;
  if (!isPlainRecord(accepted)) {
    throw new StateRepositoryError(
      `${path}.state.global.permissions.bypassPermissionsAcceptedByCwd must be an object`,
      path,
    );
  }
  for (const [cwd, value] of Object.entries(accepted)) {
    if (
      !isAbsolute(cwd) ||
      resolve(cwd) !== cwd ||
      !isPlainRecord(value) ||
      Object.keys(value).some(
        (field) =>
          field !== "version" &&
          field !== "canonicalCwd" &&
          field !== "dev" &&
          field !== "ino",
      ) ||
      value.version !== 1 ||
      value.canonicalCwd !== cwd ||
      typeof value.dev !== "string" ||
      !/^[1-9]\d*$/u.test(value.dev) ||
      typeof value.ino !== "string" ||
      !/^[1-9]\d*$/u.test(value.ino)
    ) {
      throw new StateRepositoryError(
        `${path}.state.global.permissions.bypassPermissionsAcceptedByCwd must map absolute normalized cwd keys to versioned canonical cwd and decimal dev/ino identity records`,
        path,
      );
    }
  }
}

function assertStrictStateJsonValue(
  value: unknown,
  path: string,
  ancestors = new WeakSet<object>(),
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new StateRepositoryError(
        `${path} contains a non-lossless JSON number`,
        path,
      );
    }
    return;
  }
  if (typeof value !== "object") {
    throw new StateRepositoryError(
      `${path} contains a non-JSON value of type ${typeof value}`,
      path,
    );
  }
  if (ancestors.has(value)) {
    throw new StateRepositoryError(`${path} contains a cyclic JSON value`, path);
  }
  if (!Array.isArray(value) && !isPlainRecord(value)) {
    throw new StateRepositoryError(
      `${path} contains a non-plain JSON object`,
      path,
    );
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new StateRepositoryError(
            `${path}[${index}] is a sparse JSON array entry`,
            path,
          );
        }
        assertStrictStateJsonValue(value[index], `${path}[${index}]`, ancestors);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      assertStrictStateJsonValue(child, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
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
  const migrationHint = unknown.includes("settings")
    ? '; run "agenc config migrate" to repair the retired settings namespace'
    : "";
  throw new StateRepositoryError(
    `${path} contains unsupported or retired state in state.global: ${unknown.join(", ")}; ` +
      `only observed runtime facts, acknowledgements, and bounded caches may be persisted${migrationHint}`,
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
  assertPermissionsNamespaceContainsOnlyRuntimeState(global, path);
  assertGlobalStateContainsOnlyRuntimeState(global, path);
}

export function validateCanonicalStateDocument(
  value: unknown,
  path = "<state>",
): CanonicalStateDocument {
  assertStrictStateJsonValue(value, path);
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

/**
 * Parse canonical state JSON without assigning authority to its contents.
 * Strict runtime loading and explicit migration share this one lossless
 * structural parser, then apply their separate validation policies.
 */
export function parseCanonicalStateJsonStructure(
  text: string,
  path = "<state>",
): unknown {
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
  return parsed;
}

/** Parse the single canonical runtime-state envelope without lossy JSON rules. */
export function parseCanonicalStateDocument(
  text: string,
  path = "<state>",
): CanonicalStateDocument {
  return validateCanonicalStateDocument(
    parseCanonicalStateJsonStructure(text, path),
    path,
  );
}

export async function readCanonicalState(
  path: string,
): Promise<CanonicalStateDocument | null> {
  const text = await readStateText(path);
  return text === null ? null : parseCanonicalStateDocument(text, path);
}

export function readCanonicalStateSync(
  path: string,
): CanonicalStateDocument | null {
  return readCanonicalStateSnapshotSync(path)?.document ?? null;
}

/**
 * Return one validated document together with the exact bytes read from its
 * proven regular-file descriptor. Persistence code can back up these bytes
 * without reopening a path that may have changed after validation.
 */
export function readCanonicalStateSnapshotSync(
  path: string,
): CanonicalStateFileSnapshot | null {
  const snapshot = readStateBytesSync(path);
  if (snapshot === null) return null;
  const bytes = Buffer.from(snapshot.bytes);
  const document = parseCanonicalStateDocument(bytes.toString("utf8"), path);
  return Object.freeze({ document, bytes, version: snapshot.version });
}

export function serializeCanonicalState(
  state: Readonly<CanonicalStateDocument>,
): string {
  const validated = validateCanonicalStateDocument(state);
  return `${JSON.stringify(validated, null, 2)}\n`;
}

function isUnsupportedDirectoryDurabilityError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" ||
    code === "ENOSYS" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    (process.platform === "win32" && (code === "EACCES" || code === "EPERM"));
}

function asPostCommitError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function committedStateWriteOutcome(
  directoryDurability: CanonicalStateDirectoryDurability,
  postCommitErrors: readonly Error[] = [],
): CanonicalStateWriteOutcome {
  return Object.freeze({
    committed: true,
    directoryDurability,
    postCommitErrors: Object.freeze([...postCommitErrors]),
  });
}

export interface CanonicalStateWriteOptions {
  /** Exact state revision used to derive the replacement; null means absent. */
  readonly expected?: CanonicalStateFileSnapshot | null;
}

function sameCanonicalStateVersion(
  left: CanonicalStateFileVersion,
  right: CanonicalStateFileVersion,
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink;
}

function sameCanonicalStateSnapshot(
  left: CanonicalStateFileSnapshot,
  right: CanonicalStateFileSnapshot,
): boolean {
  return sameCanonicalStateVersion(left.version, right.version) &&
    left.bytes.equals(right.bytes);
}

function sameRenamedCanonicalStateSnapshot(
  renamed: CanonicalStateFileSnapshot,
  original: CanonicalStateFileSnapshot,
): boolean {
  return renamed.version.dev === original.version.dev &&
    renamed.version.ino === original.version.ino &&
    renamed.version.size === original.version.size &&
    renamed.version.mtimeNs === original.version.mtimeNs &&
    renamed.version.mode === original.version.mode &&
    renamed.version.uid === original.version.uid &&
    renamed.version.nlink === original.version.nlink &&
    renamed.bytes.equals(original.bytes);
}

function attachStateCleanupErrors(
  primary: unknown,
  errors: readonly Error[],
): void {
  if (errors.length === 0) return;
  try {
    if (
      primary !== null &&
      (typeof primary === "object" || typeof primary === "function") &&
      Object.isExtensible(primary)
    ) {
      Object.defineProperty(primary, "cleanupErrors", {
        configurable: true,
        value: Object.freeze([...errors]),
      });
    }
  } catch {
    // The exact primary publication failure remains authoritative.
  }
}

function asStateCleanupError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function removeExactStateArtifactSync(
  path: string,
  expected: CanonicalStateFileSnapshot,
): void {
  const current = readCanonicalStateSnapshotSync(path);
  if (current === null || !sameCanonicalStateSnapshot(current, expected)) {
    throw stateFileError(
      path,
      "state cleanup preserved an artifact that changed identity or content",
    );
  }
  unlinkSync(path);
}

function removeLinkedStateStageSync(
  path: string,
  expected: CanonicalStateFileSnapshot,
): void {
  const current = lstatExistingStateSync(path);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== expected.version.dev ||
    current.ino !== expected.version.ino ||
    current.size !== expected.version.size ||
    current.mtimeNs !== expected.version.mtimeNs ||
    current.mode !== expected.version.mode ||
    current.uid !== expected.version.uid ||
    current.nlink !== 2n
  ) {
    throw stateFileError(
      path,
      "state cleanup preserved a linked stage that changed identity or metadata",
    );
  }
  unlinkSync(path);
}

/** Strict CAS state write. There is intentionally no overwrite fallback. */
export function writeCanonicalStateAtomicSync(
  path: string,
  state: Readonly<CanonicalStateDocument>,
  options: CanonicalStateWriteOptions = {},
): CanonicalStateWriteOutcome {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const expected = Object.hasOwn(options, "expected")
    ? options.expected ?? null
    : readCanonicalStateSnapshotSync(path);
  const content = serializeCanonicalState(state);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const quarantine = `${path}.quarantine-${process.pid}-${randomUUID()}`;
  let temporarySnapshot: CanonicalStateFileSnapshot | null = null;
  let quarantinedSnapshot: CanonicalStateFileSnapshot | null = null;
  let committed = false;
  const postCommitErrors: Error[] = [];
  try {
    writeFileSync(temporary, content, {
      encoding: "utf8",
      flag: "wx",
      flush: true,
      mode: CANONICAL_STATE_FILE_MODE,
    });
    temporarySnapshot = readCanonicalStateSnapshotSync(temporary);
    if (
      temporarySnapshot === null ||
      !temporarySnapshot.bytes.equals(Buffer.from(content, "utf8"))
    ) {
      throw stateFileError(
        temporary,
        "state publication stage changed while it was prepared",
      );
    }

    if (expected !== null) {
      const current = readCanonicalStateSnapshotSync(path);
      if (current === null || !sameCanonicalStateSnapshot(current, expected)) {
        throw stateFileError(
          path,
          "state publication refuses a destination that changed after read",
        );
      }
      try {
        renameSync(path, quarantine);
      } catch (error) {
        throw error;
      }
      const quarantineCandidate = readCanonicalStateSnapshotSync(quarantine);
      if (
        quarantineCandidate === null ||
        !sameRenamedCanonicalStateSnapshot(quarantineCandidate, expected)
      ) {
        throw stateFileError(
          quarantine,
          "state publication quarantined a concurrent revision; it was preserved for recovery",
        );
      }
      quarantinedSnapshot = quarantineCandidate;
    } else {
      const appeared = lstatStateOrMissingSync(path);
      if (appeared !== null) {
        assertRegularStatePath(path, appeared);
        throw stateFileError(
          path,
          "state publication refuses a destination that appeared after read",
        );
      }
    }

    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw stateFileError(
          path,
          "state publication refuses to overwrite a destination that appeared",
        );
      }
      throw error;
    }
    committed = true;
  } catch (error) {
    const cleanupErrors: Error[] = [];
    if (quarantinedSnapshot !== null) {
      try {
        if (lstatStateOrMissingSync(path) !== null) {
          throw stateFileError(
            path,
            `state publication could not restore the validated state because its path reappeared; recover it from ${quarantine}`,
          );
        }
        try {
          linkSync(quarantine, path);
        } catch (restoreError) {
          if ((restoreError as NodeJS.ErrnoException).code === "EEXIST") {
            throw stateFileError(
              path,
              `state publication could not restore the validated state because its path reappeared; recover it from ${quarantine}`,
            );
          }
          throw restoreError;
        }
        removeLinkedStateStageSync(quarantine, quarantinedSnapshot);
        const restored = readCanonicalStateSnapshotSync(path);
        if (
          restored === null ||
          !sameRenamedCanonicalStateSnapshot(restored, quarantinedSnapshot)
        ) {
          throw stateFileError(
            path,
            `state publication restored an unexpected file; recover the validated state from ${quarantine}`,
          );
        }
        quarantinedSnapshot = null;
      } catch (restoreError) {
        cleanupErrors.push(asStateCleanupError(restoreError));
      }
    }
    if (temporarySnapshot !== null) {
      try {
        removeExactStateArtifactSync(temporary, temporarySnapshot);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          cleanupErrors.push(asStateCleanupError(cleanupError));
        }
      }
    }
    attachStateCleanupErrors(error, cleanupErrors);
    throw error;
  }

  // linkSync above is the commit point. Nothing below may report a
  // pre-commit failure while the new state remains visible at `path`.
  if (committed && temporarySnapshot !== null) {
    try {
      removeLinkedStateStageSync(temporary, temporarySnapshot);
    } catch (error) {
      postCommitErrors.push(asStateCleanupError(error));
    }
  }
  if (quarantinedSnapshot !== null) {
    try {
      removeExactStateArtifactSync(quarantine, quarantinedSnapshot);
    } catch (error) {
      postCommitErrors.push(asStateCleanupError(error));
    }
  }
  try {
    const published = readCanonicalStateSnapshotSync(path);
    if (
      published === null ||
      temporarySnapshot === null ||
      !published.bytes.equals(temporarySnapshot.bytes)
    ) {
      postCommitErrors.push(stateFileError(
        path,
        "committed state could not be verified against its publication stage",
      ));
    }
  } catch (error) {
    postCommitErrors.push(asStateCleanupError(error));
  }

  let directoryFd: number;
  try {
    directoryFd = openSync(parent, "r");
  } catch (error) {
    const postCommitError = asPostCommitError(error);
    const code = (error as NodeJS.ErrnoException).code;
    const unsupported = code === "EISDIR" ||
      isUnsupportedDirectoryDurabilityError(error);
    return committedStateWriteOutcome(
      unsupported ? "unsupported" : "indeterminate",
      [...postCommitErrors, postCommitError],
    );
  }

  let directoryDurability: CanonicalStateDirectoryDurability = "confirmed";
  try {
    fsyncSync(directoryFd);
  } catch (error) {
    directoryDurability = isUnsupportedDirectoryDurabilityError(error)
      ? "unsupported"
      : "indeterminate";
    postCommitErrors.push(asPostCommitError(error));
  }
  try {
    closeSync(directoryFd);
  } catch (error) {
    postCommitErrors.push(asPostCommitError(error));
  }

  return committedStateWriteOutcome(directoryDurability, postCommitErrors);
}
