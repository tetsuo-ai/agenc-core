import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  findProjectRootSync,
  resolveCanonicalSessionCwd,
} from "../session/session-store.js";
import { parseRuleString } from "../permissions/rules.js";
import {
  bindingCommandError,
  isKeybindingContextName,
  keybindingChordError,
} from "../tui/keybindings/grammar.js";
import {
  getSecureStorageForMigration,
  type SecureStorage,
  type SecureStorageData,
  type SecureStorageMigrationIdentity,
} from "../utils/secureStorage/index.js";
import {
  readNativeSecureStorage,
  readNativeSecureStorageFresh,
  replaceUnreadableNativeSecureStorageForMigration,
  rollbackNativeSecureStorage,
  updateNativeSecureStorage,
  type NativeSecureStorageTransaction,
} from "../utils/secureStorage/native.js";
import {
  getCanonicalSecureStorageIdentity,
  getRetiredSecureStorageIdentity,
  secureStorageIdentitiesDiffer,
  windowsSecureStorageTargetIdentity,
} from "../utils/secureStorage/migrationIdentity.js";
import { migrateRetiredProviderSelector } from "../provider-identity.js";
import { classifyRetiredField } from "./retired-field-manifest.js";
import {
  resolveMigrationHomeContext,
  type HomeContext,
  type HomeEnvironment,
} from "./home.js";
import {
  runWithConfigAuthorityLocks,
} from "./authority-lock.js";
import { firstPlaintextCredentialPath } from "./credential-classification.js";
import {
  cloneJsonValue,
  cloneRecord,
  duplicateJsonObjectPaths,
  isPlainRecord,
  stableJson,
  type JsonRecord,
} from "./json.js";
import {
  migrateRetiredOpenAiCredential,
  OpenAiCredentialMigrationError,
  type RetiredOpenAiCredential,
} from "./openai-credential-migration.js";
import { parseToml } from "./loader.js";
import { retiredProjectMcpJsonCandidates } from "./retired-input-preflight.js";
import { logForDebugging } from "../utils/debug.js";
import { resolveManagedConfigPath } from "../utils/settings/managedPath.js";
import { serializeConfigToml } from "./serialize.js";
import { findConfigSourceCollisions } from "./source-identity.js";
import {
  ensurePrivateDescendantDirectory,
  readStableDirectory,
  readStableFile,
  sameStableFileIdentity,
  sameStableFileSnapshot,
  type StableFileSnapshot,
} from "./stable-file.js";
import {
  CANONICAL_CONFIG_VERSION,
  CANONICAL_CONFIG_VERSION_KEY,
  validateStrictConfigDocument,
} from "./repository.js";
import {
  CANONICAL_STATE_FILE_MODE,
  createCanonicalStateDocument,
  parseCanonicalStateJsonStructure,
  RETIRED_PROJECT_STATE_FIELDS,
  serializeCanonicalState,
  validateCanonicalStateDocument,
  type CanonicalStateDocument,
} from "./state.js";
import {
  applyRetiredAuthSecureStorageMutation,
  assertRetiredAuthSecureStorageMutationCommitted,
  discoverRetiredAuthMigration,
  rollbackRetiredAuthSecureStorageMutation,
  type RetiredAuthFileAction,
  type RetiredAuthMigrationDescriptor,
  type RetiredAuthMigrationEnvironment,
  type RetiredAuthSecureStorageMutation,
} from "./retired-auth-migration.js";

export type ConfigMigrationScope = "user" | "project" | "local" | "managed" | "state";
export type MigrationWriteKind = "config" | "state";

export interface ConfigMigrationConflict {
  readonly scope: ConfigMigrationScope;
  readonly sourcePath: string;
  readonly field?: string;
  readonly reason: string;
}

export interface ConfigMigrationNotice {
  readonly scope: ConfigMigrationScope;
  readonly sourcePath: string;
  readonly field: string;
  readonly action: "migrate" | "retain" | "drop";
  readonly target?: string;
}

export interface ConfigMigrationInput {
  readonly path: string;
  readonly sha256: string;
}

export interface ConfigMigrationWrite {
  readonly scope: ConfigMigrationScope;
  readonly kind: MigrationWriteKind;
  readonly targetPath: string;
  readonly content: string;
  readonly beforeSha256?: string;
  readonly afterSha256: string;
  readonly mode: number;
}

export interface ConfigV2MigrationPlan {
  readonly id: string;
  readonly home: HomeContext;
  readonly projectRoot: string;
  readonly inputs: readonly ConfigMigrationInput[];
  readonly writes: readonly ConfigMigrationWrite[];
  readonly archivePaths: readonly string[];
  readonly credentialMigration?: LegacyCredentialMigration;
  readonly secureStorageNamespaceMigration?: SecureStorageNamespaceMigration;
  readonly retiredAuthMigration?: RetiredAuthMigrationPlan;
  readonly requiresRetiredWriterQuiescence: boolean;
  readonly retiredWriterQuiescenceConfirmed: boolean;
  readonly conflicts: readonly ConfigMigrationConflict[];
  readonly notices: readonly ConfigMigrationNotice[];
}

export interface RetiredAuthMigrationPlan {
  readonly platformHome: string;
  readonly environment: RetiredAuthMigrationEnvironment;
  readonly descriptor: RetiredAuthMigrationDescriptor;
}

export interface LegacyCredentialMigration {
  readonly sourcePath: string;
  readonly sha256: string;
}

export interface SecureStorageNamespaceMigration {
  readonly source: SecureStorageMigrationIdentity;
  readonly target: SecureStorageMigrationIdentity;
  readonly sourceLockPath: string;
  readonly sourceDisposition:
    | "retain-shared"
    | "rewrite-in-place"
    | "delete-retired"
    | "delete-shared-confirmed";
  readonly sha256: string;
  readonly fields: readonly string[];
}

export interface ConfigV2MigrationOptions {
  readonly env?: HomeEnvironment;
  readonly home?: string;
  readonly platformHome?: string;
  readonly cwd?: string;
  readonly projectRoot?: string;
  readonly managedConfigPath?: string;
  readonly managedSettingsPath?: string;
  readonly managedSettingsDropInDir?: string;
  readonly globalStatePath?: string;
  readonly id?: string;
  /** Explicit assertion that no default/other home still owns the old shared secure-storage record. */
  readonly retireSharedSecureStorage?: boolean;
  /** Explicit assertion required before any one-way retired credential cleanup. */
  readonly confirmRetiredWritersStopped?: boolean;
  /** Migration-only override for a historical USER-derived secure-storage account. */
  readonly retiredSecureStorageAccount?: string;
  /** Scope inspected only by the explicit config migration CLI. */
  readonly scope?: "user" | "all";
}

export interface AppliedConfigV2Migration {
  readonly id: string;
  readonly journalPath: string;
  readonly writes: number;
  readonly archives: number;
  readonly credentialSourcesSanitized: number;
  readonly postPublicationErrors: readonly Error[];
}

export interface RolledBackConfigV2Migration {
  readonly id: string;
  readonly journalPath: string;
  readonly restored: number;
  readonly credentialsPreserved: boolean;
  readonly postPublicationErrors: readonly Error[];
}

interface ScopeAccumulator {
  readonly scope: Exclude<ConfigMigrationScope, "state">;
  readonly targetPath: string;
  readonly raw: JsonRecord;
  readonly sourcePaths: string[];
  readonly originalText?: string;
  readonly mode: number;
}

interface JournalWrite {
  readonly scope: ConfigMigrationScope;
  readonly kind: MigrationWriteKind;
  readonly targetPath: string;
  readonly beforeSha256?: string;
  readonly afterSha256: string;
  readonly backupPath?: string;
  readonly mode: number;
}

interface JournalArchive {
  readonly sourcePath: string;
  readonly archivePath: string;
  readonly sha256: string;
}

interface MigrationJournal {
  readonly journal_version: 1;
  readonly id: string;
  readonly created_at: string;
  readonly quarantineToken?: string;
  readonly status: "prepared" | "complete" | "rolling-back" | "rolled-back";
  readonly writes: readonly JournalWrite[];
  readonly archives: readonly JournalArchive[];
  readonly credential?: JournalCredentialMigration;
  readonly committed: {
    readonly credential: boolean;
    readonly credentialFileIndexes: readonly number[];
    readonly writeIndexes: readonly number[];
    readonly archiveIndexes: readonly number[];
  };
}

interface JournalCredentialMigration {
  readonly fileActions: readonly JournalCredentialFileAction[];
  readonly vaultFields: readonly string[];
  /** Hash-only proof used to finish an interrupted one-way file cleanup. */
  readonly canonicalSha256?: string;
  readonly nativeNamespace?: {
    readonly source: SecureStorageMigrationIdentity;
    readonly sourceDisposition: SecureStorageNamespaceMigration["sourceDisposition"];
    readonly sha256: string;
  };
}

interface JournalCredentialFileAction {
  readonly kind: "delete" | "rewrite";
  readonly path: string;
  readonly beforeSha256: string;
  readonly afterSha256?: string;
}

interface PreparationArtifact {
  readonly kind: "backup" | "credential-stage" | "write-stage";
  readonly path: string;
  readonly quarantinePath: string;
  readonly ownerPath: string;
  readonly sha256: string;
  readonly writeIndex?: number;
}

interface MigrationPreparationManifest {
  readonly preparation_version: 1;
  readonly id: string;
  readonly created_at: string;
  readonly quarantineToken: string;
  readonly artifacts: readonly PreparationArtifact[];
}

const DEFAULT_MODE = 0o600;
const PREPARATION_MANIFEST_NAME = "preparation.json";
const MIGRATION_QUARANTINE_MARKER = ".agenc-migration-quarantine-";
const MIGRATION_QUARANTINE_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function migrationQuarantinePath(
  path: string,
  token: string,
  role: string,
): string {
  if (!MIGRATION_QUARANTINE_TOKEN_PATTERN.test(token)) {
    throw new ConfigMigrationError("invalid migration quarantine token");
  }
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(role)) {
    throw new ConfigMigrationError("invalid migration quarantine role");
  }
  return `${path}${MIGRATION_QUARANTINE_MARKER}${token}-${role}`;
}

function publicationTempQuarantinePath(path: string): string {
  return `${path}.agenc-migration-publication-quarantine`;
}

function historicalJournalQuarantineToken(path: string, id: string): string {
  const hex = sha256(`config-v2-journal-quarantine\0${resolve(path)}\0${id}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class ConfigMigrationError extends Error {
  readonly name = "ConfigMigrationError";
  readonly conflicts?: readonly ConfigMigrationConflict[];

  constructor(message: string, conflicts?: readonly ConfigMigrationConflict[]) {
    super(message);
    this.conflicts = conflicts;
  }
}

function reportMigrationAuthorityReleaseErrors(
  operation: string,
  errors: readonly Error[],
): void {
  if (errors.length === 0) return;
  try {
    const details = errors
      .map((error) => {
        const code = (error as NodeJS.ErrnoException).code;
        return code === undefined ? error.message : `${code}: ${error.message}`;
      })
      .join("; ");
    logForDebugging(
      `${operation} completed, but configuration authority lock release failed (${details})`,
      { level: "warn" },
    );
  } catch {
    // A diagnostic sink cannot change a completed migration operation.
  }
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type LegacyCredentialBlob = SecureStorageData & {
  readonly agenc?: RetiredOpenAiCredential;
};

const LEGACY_CREDENTIAL_FIELDS = new Set<string>([
  "primaryApiKey",
  "agenc",
  "openAiOauth",
  "agencAiOauth",
  "mcpOAuth",
  "mcpOAuthClientConfig",
  "mcpXaaIdp",
  "mcpXaaIdpConfig",
  "trustedDeviceToken",
  "pluginSecrets",
  "xaiOauth",
  "oauthAccountMetadata",
  "chromePairingIdentity",
  "apiKeyApprovals",
  "githubModels",
]);

function parseLegacyCredentialBlob(text: string, path: string): LegacyCredentialBlob {
  if (duplicateJsonObjectPaths(text).length > 0) {
    throw new ConfigMigrationError(
      `retired credential JSON contains duplicate object keys: ${path}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConfigMigrationError(
      `invalid retired credential JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isPlainRecord(parsed)) {
    throw new ConfigMigrationError(`retired credential blob is not an object: ${path}`);
  }
  const unknown = Object.keys(parsed).filter(
    field => !LEGACY_CREDENTIAL_FIELDS.has(field),
  );
  if (unknown.length > 0) {
    throw new ConfigMigrationError(
      `retired credential blob contains unsupported fields at ${path}: ${unknown.join(", ")}`,
    );
  }
  for (const field of ["primaryApiKey", "trustedDeviceToken"] as const) {
    if (parsed[field] !== undefined && typeof parsed[field] !== "string") {
      throw new ConfigMigrationError(
        `retired credential field ${field} must be a string: ${path}`,
      );
    }
  }
  for (const [field, value] of Object.entries(parsed)) {
    if (
      field !== "primaryApiKey" && field !== "trustedDeviceToken" &&
      !isPlainRecord(value)
    ) {
      throw new ConfigMigrationError(
        `retired credential field ${field} must be an object: ${path}`,
      );
    }
  }
  if (parsed.githubModels !== undefined) {
    const githubModels = parsed.githubModels;
    if (
      !isPlainRecord(githubModels) ||
      Object.keys(githubModels).some((field) =>
        field !== "accessToken" && field !== "oauthAccessToken"
      ) ||
      typeof githubModels.accessToken !== "string" ||
      githubModels.accessToken.length === 0 ||
      (
        githubModels.oauthAccessToken !== undefined &&
        (
          typeof githubModels.oauthAccessToken !== "string" ||
          githubModels.oauthAccessToken.length === 0
        )
      )
    ) {
      throw new ConfigMigrationError(
        `retired credential field githubModels must contain a non-empty accessToken and optional non-empty oauthAccessToken: ${path}`,
      );
    }
  }
  return cloneRecord(parsed) as LegacyCredentialBlob;
}

function mergeLegacyCredentialBlob(
  current: Readonly<SecureStorageData>,
  legacy: Readonly<LegacyCredentialBlob>,
  sourcePath: string,
): {
  readonly next: SecureStorageData;
  readonly canonical: SecureStorageData;
  readonly addedFields: readonly string[];
} {
  const next = structuredClone(current) as SecureStorageData;
  const addedFields: string[] = [];
  const {
    agenc: retiredOpenAi,
    ...canonicalLegacy
  } = structuredClone(legacy);
  if (retiredOpenAi !== undefined) {
    try {
      canonicalLegacy.openAiOauth = migrateRetiredOpenAiCredential(
        retiredOpenAi,
        canonicalLegacy.openAiOauth,
      );
    } catch (error) {
      const field = error instanceof OpenAiCredentialMigrationError
        ? error.field
        : "agenc";
      throw new ConfigMigrationError(
        `retired credential field ${field} could not be migrated safely; no credentials or files were changed: ${sourcePath}`,
      );
    }
  }
  for (const [field, value] of Object.entries(canonicalLegacy)) {
    const key = field as keyof SecureStorageData;
    const existing = current[key];
    if (existing === undefined) {
      (next as Record<string, unknown>)[field] = structuredClone(value);
      addedFields.push(field);
      continue;
    }
    if (stableJson(existing) !== stableJson(value)) {
      throw new ConfigMigrationError(
        `native secure storage conflicts with retired credential field ${field}; no credentials or files were changed: ${sourcePath}`,
      );
    }
  }
  return {
    next,
    canonical: canonicalLegacy,
    addedFields: Object.freeze(addedFields),
  };
}

async function readMigrationFile(path: string): Promise<StableFileSnapshot | null> {
  try {
    return await readStableFile(path);
  } catch (error) {
    throw new ConfigMigrationError(
      error instanceof Error
        ? error.message
        : `migration could not read a stable regular file: ${path}`,
    );
  }
}

async function requireUnchangedMigrationFile(
  path: string,
  expected: StableFileSnapshot,
  operation: string,
): Promise<StableFileSnapshot> {
  const current = await readMigrationFile(path);
  if (current === null || !sameStableFileSnapshot(current, expected)) {
    throw new ConfigMigrationError(
      `${operation} refuses a file that changed identity or content: ${path}`,
    );
  }
  return current;
}

async function removeUnchangedMigrationFile(
  path: string,
  expected: StableFileSnapshot,
  operation: string,
  quarantinePath: string,
): Promise<void> {
  const quarantined = await quarantineExpectedMigrationFile(
    path,
    expected,
    operation,
    quarantinePath,
  );
  if (await readMigrationFile(path) !== null) {
    throw new ConfigMigrationError(
      `${operation} source reappeared during quarantine; the validated file was preserved for recovery at ${quarantined.path}`,
    );
  }
  await discardQuarantinedMigrationFile(quarantined, operation);
}

interface QuarantinedMigrationFile {
  readonly path: string;
  readonly snapshot: StableFileSnapshot;
  readonly originalPath: string;
}

async function quarantineExpectedMigrationFile(
  path: string,
  expected: StableFileSnapshot,
  operation: string,
  quarantinePath: string,
): Promise<QuarantinedMigrationFile> {
  await requireUnchangedMigrationFile(path, expected, operation);
  if (dirname(quarantinePath) !== dirname(path) || quarantinePath === path) {
    throw new ConfigMigrationError(
      `${operation} has an invalid sibling quarantine path: ${quarantinePath}`,
    );
  }
  if (await readMigrationFile(quarantinePath) !== null) {
    throw new ConfigMigrationError(
      `${operation} quarantine path unexpectedly exists: ${quarantinePath}`,
    );
  }
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    throw new ConfigMigrationError(
      `${operation} could not atomically quarantine ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const quarantined = await readMigrationFile(quarantinePath);
  if (
    quarantined === null ||
    !sameStableFileIdentity(quarantined, expected)
  ) {
    throw new ConfigMigrationError(
      `${operation} quarantined a file that changed after validation; it was preserved for recovery at ${quarantinePath}`,
    );
  }
  await fsyncPath(dirname(path)).catch(() => undefined);
  return Object.freeze({
    path: quarantinePath,
    snapshot: quarantined,
    originalPath: path,
  });
}

async function discardQuarantinedMigrationFile(
  quarantined: QuarantinedMigrationFile,
  operation: string,
): Promise<void> {
  const current = await readMigrationFile(quarantined.path);
  if (
    current === null ||
    !sameStableFileSnapshot(current, quarantined.snapshot)
  ) {
    throw new ConfigMigrationError(
      `${operation} quarantine changed and was preserved for recovery at ${quarantined.path}`,
    );
  }
  await rm(quarantined.path);
  await fsyncPath(dirname(quarantined.path)).catch(() => undefined);
}

async function restoreQuarantinedMigrationFile(
  quarantined: QuarantinedMigrationFile,
  operation: string,
): Promise<void> {
  if (await readMigrationFile(quarantined.originalPath) !== null) {
    throw new ConfigMigrationError(
      `${operation} could not restore the validated file because its path reappeared; recover it from ${quarantined.path}`,
    );
  }
  try {
    await link(quarantined.path, quarantined.originalPath);
  } catch (error) {
    throw new ConfigMigrationError(
      `${operation} could not restore the validated file; recover it from ${quarantined.path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const restored = await readMigrationFile(quarantined.originalPath);
  if (
    restored === null ||
    !sameStableFileIdentity(restored, quarantined.snapshot)
  ) {
    throw new ConfigMigrationError(
      `${operation} restored an unexpected file; the validated copy remains at ${quarantined.path}`,
    );
  }
  await discardQuarantinedMigrationFile(quarantined, operation);
}

async function removePreparedArtifactIfUnchanged(
  path: string,
  expected: StableFileSnapshot,
  quarantinePath: string,
): Promise<void> {
  const current = await readMigrationFile(path);
  if (current === null) {
    const quarantined = await readMigrationFile(quarantinePath);
    if (quarantined === null) return;
    if (!sameStableFileIdentity(quarantined, expected)) {
      throw new ConfigMigrationError(
        `migration cleanup refuses a quarantined artifact that changed identity or content: ${quarantinePath}`,
      );
    }
    await discardQuarantinedMigrationFile(
      Object.freeze({
        path: quarantinePath,
        snapshot: quarantined,
        originalPath: path,
      }),
      "migration artifact cleanup",
    );
    return;
  }
  if (!sameStableFileSnapshot(current, expected)) {
    throw new ConfigMigrationError(
      `migration cleanup refuses an artifact that changed identity or content: ${path}`,
    );
  }
  await removeUnchangedMigrationFile(
    path,
    expected,
    "migration artifact cleanup",
    quarantinePath,
  );
}

async function moveMigrationFileNoClobber(
  sourcePath: string,
  expectedSource: StableFileSnapshot,
  destinationPath: string,
  operation: string,
  sourceQuarantinePath: string,
): Promise<StableFileSnapshot> {
  const quarantined = await quarantineExpectedMigrationFile(
    sourcePath,
    expectedSource,
    operation,
    sourceQuarantinePath,
  );
  try {
    await link(quarantined.path, destinationPath);
  } catch (error) {
    const restoreErrors: unknown[] = [];
    try {
      await restoreQuarantinedMigrationFile(quarantined, operation);
    } catch (restoreError) {
      restoreErrors.push(restoreError);
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const publicationError = new ConfigMigrationError(
        `${operation} refuses to overwrite a path that appeared: ${destinationPath}`,
      );
      if (restoreErrors.length > 0) {
        throw new AggregateError(
          [publicationError, ...restoreErrors],
          `${operation} publication and source restoration both failed`,
        );
      }
      throw publicationError;
    }
    if (restoreErrors.length > 0) {
      throw new AggregateError(
        [error, ...restoreErrors],
        `${operation} publication and source restoration both failed`,
      );
    }
    throw error;
  }
  const published = await readMigrationFile(destinationPath);
  if (
    published === null ||
    !sameStableFileIdentity(published, expectedSource)
  ) {
    throw new ConfigMigrationError(
      `${operation} destination does not match the validated source: ${destinationPath}`,
    );
  }
  await fsyncPath(dirname(destinationPath)).catch(() => undefined);
  if (await readMigrationFile(sourcePath) !== null) {
    throw new ConfigMigrationError(
      `${operation} source reappeared after publication; the validated copy remains at ${quarantined.path}: ${sourcePath}`,
    );
  }
  await discardQuarantinedMigrationFile(quarantined, operation);
  return published;
}

async function replaceMigrationFileFromStage(
  stagePath: string,
  expectedStage: StableFileSnapshot,
  targetPath: string,
  expectedTarget: StableFileSnapshot | null,
  operation: string,
  stageQuarantinePath: string,
  targetQuarantinePath: string,
): Promise<StableFileSnapshot> {
  if (expectedTarget === null) {
    return moveMigrationFileNoClobber(
      stagePath,
      expectedStage,
      targetPath,
      operation,
      stageQuarantinePath,
    );
  }
  await requireUnchangedMigrationFile(stagePath, expectedStage, operation);
  const quarantinedTarget = await quarantineExpectedMigrationFile(
    targetPath,
    expectedTarget,
    operation,
    targetQuarantinePath,
  );
  let published: StableFileSnapshot;
  try {
    published = await moveMigrationFileNoClobber(
      stagePath,
      expectedStage,
      targetPath,
      operation,
      stageQuarantinePath,
    );
  } catch (error) {
    const restoreErrors: unknown[] = [];
    try {
      await restoreQuarantinedMigrationFile(quarantinedTarget, operation);
    } catch (restoreError) {
      restoreErrors.push(restoreError);
    }
    if (restoreErrors.length > 0) {
      throw new AggregateError(
        [error, ...restoreErrors],
        `${operation} replacement and target restoration both failed`,
      );
    }
    throw error;
  }
  await discardQuarantinedMigrationFile(quarantinedTarget, operation);
  return published;
}

function legacyGlobalStateCandidates(
  home: HomeContext,
  explicitPath?: string,
): readonly string[] {
  const candidates = explicitPath
    ? [explicitPath]
    : [
        join(home.path, ".config.json"),
        join(home.path, ".agenc.json"),
        join(dirname(home.path), ".agenc.json"),
      ];
  return Object.freeze([...new Set(candidates.map((path) => resolve(path)))]);
}

const RETIRED_TOP_LEVEL_CONFIG_FIELDS = Object.freeze([
  "experiments",
  "tuiLayout",
  "toolBudget",
  "extraKnownMarketplaces",
  "review_model",
  "compact_prompt",
  "workspace",
  "advisorModel",
] as const);

function dropRetiredTopLevelConfigFields(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  notices: ConfigMigrationNotice[],
): void {
  for (const field of RETIRED_TOP_LEVEL_CONFIG_FIELDS) {
    if (!Object.hasOwn(config, field)) continue;
    delete config[field];
    notices.push(Object.freeze({
      scope,
      sourcePath,
      field,
      action: "drop",
    }));
  }
}

async function readInput(path: string): Promise<{
  readonly text: string;
  readonly mode: number;
  readonly input: ConfigMigrationInput;
} | null> {
  const snapshot = await readMigrationFile(path);
  if (snapshot === null) return null;
  const text = snapshot.bytes.toString("utf8");
  return {
    text,
    mode: snapshot.mode || DEFAULT_MODE,
    input: Object.freeze({ path, sha256: sha256(snapshot.bytes) }),
  };
}

function pushConflict(
  conflicts: ConfigMigrationConflict[],
  scope: ConfigMigrationScope,
  sourcePath: string,
  reason: string,
  field?: string,
): void {
  conflicts.push(Object.freeze({
    scope,
    sourcePath,
    reason,
    ...(field !== undefined ? { field } : {}),
  }));
}

function parseTomlStrict(
  text: string,
  path: string,
  scope: ConfigMigrationScope,
  conflicts: ConfigMigrationConflict[],
): JsonRecord | null {
  let duplicate = false;
  try {
    const raw = cloneRecord(parseToml(text, {
      onDuplicateKey: () => {
        duplicate = true;
      },
    }));
    if (duplicate) {
      pushConflict(conflicts, scope, path, "duplicate TOML keys must be resolved manually");
      return null;
    }
    return raw;
  } catch (error) {
    pushConflict(
      conflicts,
      scope,
      path,
      `invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function parseJsonObject(
  text: string,
  path: string,
  scope: ConfigMigrationScope,
  conflicts: ConfigMigrationConflict[],
): JsonRecord | null {
  const duplicateCount = duplicateJsonObjectPaths(text).length;
  if (duplicateCount > 0) {
    pushConflict(
      conflicts,
      scope,
      path,
      `retired JSON contains ${duplicateCount} duplicate object key${duplicateCount === 1 ? "" : "s"}; resolve duplicates explicitly before migration`,
      "<duplicate-json-key>",
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    pushConflict(
      conflicts,
      scope,
      path,
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  if (!isPlainRecord(parsed)) {
    pushConflict(conflicts, scope, path, "legacy JSON root must be an object");
    return null;
  }
  const unsafePath = firstUnsafeJsonKeyPath(parsed);
  if (unsafePath !== undefined) {
    pushConflict(
      conflicts,
      scope,
      path,
      "retired JSON contains a key segment that could mutate an object prototype",
      unsafePath,
    );
    return null;
  }
  const secretPath = firstPlaintextCredentialPath(parsed);
  if (secretPath !== undefined) {
    pushConflict(
      conflicts,
      scope,
      path,
      "retired JSON appears to contain a plaintext credential; move it to the documented environment variable or native secure storage and remove the literal value before migration",
      secretPath,
    );
  }
  return cloneRecord(parsed);
}

const UNSAFE_JSON_KEY_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function firstUnsafeJsonKeyPath(
  value: unknown,
  prefix = "",
): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = firstUnsafeJsonKeyPath(
        value[index],
        `${prefix}[${index}]`,
      );
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  if (!isPlainRecord(value)) return undefined;
  for (const [key, nestedValue] of Object.entries(value)) {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (UNSAFE_JSON_KEY_SEGMENTS.has(key)) return path;
    const nested = firstUnsafeJsonKeyPath(nestedValue, path);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function dropRetiredHeartbeatSelectors(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  notices: ConfigMigrationNotice[],
): void {
  if (!isPlainRecord(config.heartbeat)) return;
  for (const field of ["model", "agent"] as const) {
    if (!Object.hasOwn(config.heartbeat, field)) continue;
    delete config.heartbeat[field];
    notices.push(Object.freeze({
      scope,
      sourcePath,
      field: `heartbeat.${field}`,
      action: "drop",
    }));
  }
}

function dropRetiredDaemonTransport(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  notices: ConfigMigrationNotice[],
): void {
  if (!isPlainRecord(config.daemon) || !Object.hasOwn(config.daemon, "transport")) {
    return;
  }
  delete config.daemon.transport;
  notices.push(Object.freeze({
    scope,
    sourcePath,
    field: "daemon.transport",
    action: "drop",
  }));
}

function migrateRetiredSandboxWritableRoots(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
): void {
  if (
    !isPlainRecord(config.sandbox) ||
    !Object.hasOwn(config.sandbox, "writable_roots")
  ) return;
  const value = config.sandbox.writable_roots;
  delete config.sandbox.writable_roots;
  if (
    !Array.isArray(value) ||
    !value.every((root) => typeof root === "string")
  ) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "legacy sandbox.writable_roots must be string[]",
      "sandbox.writable_roots",
    );
    return;
  }
  mergeConfigPath(config, "sandbox.filesystem.allowWrite", value, {
    scope,
    sourcePath,
    conflicts,
  });
  notices.push(Object.freeze({
    scope,
    sourcePath,
    field: "sandbox.writable_roots",
    action: "migrate",
    target: "sandbox.filesystem.allowWrite",
  }));
}

function migrateRetiredProtocolNoOps(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  notices: ConfigMigrationNotice[],
): void {
  if (!isPlainRecord(config.protocol)) return;
  const protocol = config.protocol;
  const active = protocol.enabled === true &&
    protocol.adapter === "marketplace-cli";
  if (active) return;

  if (Object.hasOwn(protocol, "adapter")) {
    const adapter = protocol.adapter;
    delete protocol.adapter;
    notices.push(Object.freeze({
      scope,
      sourcePath,
      field: "protocol.adapter",
      action: "drop",
      ...(adapter === "marketplace-cli"
        ? { target: "protocol.enabled=false" }
        : {}),
    }));
  }
  if (Object.hasOwn(protocol, "cli_path")) {
    delete protocol.cli_path;
    notices.push(Object.freeze({
      scope,
      sourcePath,
      field: "protocol.cli_path",
      action: "drop",
    }));
  }
  if (protocol.enabled !== false) {
    protocol.enabled = false;
    notices.push(Object.freeze({
      scope,
      sourcePath,
      field: "protocol.enabled",
      action: "migrate",
      target: "protocol.enabled=false",
    }));
  }
}

function migrateRetiredApprovalsReviewerAlias(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  notices: ConfigMigrationNotice[],
): void {
  const migrate = (record: JsonRecord, field: string): void => {
    if (record.approvals_reviewer !== "guardian_subagent") return;
    record.approvals_reviewer = "auto_review";
    notices.push(Object.freeze({
      scope,
      sourcePath,
      field,
      action: "migrate",
      target: field,
    }));
  };
  migrate(config, "approvals_reviewer");
  if (!isPlainRecord(config.profiles)) return;
  for (const [profileName, profile] of Object.entries(config.profiles)) {
    if (!isPlainRecord(profile)) continue;
    migrate(profile, `profiles.${profileName}.approvals_reviewer`);
  }
}

function migrateRetiredServiceTierAlias(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  notices: ConfigMigrationNotice[],
): void {
  const migrate = (record: JsonRecord, field: string): void => {
    if (record.service_tier !== "fast") return;
    record.service_tier = "priority";
    notices.push(Object.freeze({
      scope,
      sourcePath,
      field,
      action: "migrate",
      target: `${field}=priority`,
    }));
  };
  migrate(config, "service_tier");
  if (!isPlainRecord(config.profiles)) return;
  for (const [profileName, profile] of Object.entries(config.profiles)) {
    if (!isPlainRecord(profile)) continue;
    migrate(profile, `profiles.${profileName}.service_tier`);
  }
}

function migrateRetiredReasoningEffortAlias(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  notices: ConfigMigrationNotice[],
): void {
  const migrate = (record: JsonRecord, field: string): void => {
    if (record.reasoning_effort !== "minimal") return;
    record.reasoning_effort = "low";
    notices.push(Object.freeze({
      scope,
      sourcePath,
      field,
      action: "migrate",
      target: `${field}=low`,
    }));
  };
  migrate(config, "reasoning_effort");
  if (!isPlainRecord(config.profiles)) return;
  for (const [profileName, profile] of Object.entries(config.profiles)) {
    if (!isPlainRecord(profile)) continue;
    migrate(profile, `profiles.${profileName}.reasoning_effort`);
  }
}

function migrateRetiredProviderFallbackModels(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
): void {
  if (!isPlainRecord(config.providers)) return;
  for (const [providerName, rawProvider] of Object.entries(config.providers)) {
    if (!isPlainRecord(rawProvider)) continue;
    const directField = `providers.${providerName}.fallback_models`;
    const modelsField = `providers.${providerName}.fallback.models`;
    const targetsField = `providers.${providerName}.fallback.targets`;
    if (Object.hasOwn(rawProvider, "fallback_models")) {
      const directValue = rawProvider.fallback_models;
      if (rawProvider.fallback === undefined) rawProvider.fallback = {};
      if (!isPlainRecord(rawProvider.fallback)) {
        pushConflict(
          conflicts,
          scope,
          sourcePath,
          "legacy fallback_models collides with a non-object canonical fallback",
          directField,
        );
      } else if (
        Object.hasOwn(rawProvider.fallback, "models") &&
        stableJson(rawProvider.fallback.models) !== stableJson(directValue)
      ) {
        pushConflict(
          conflicts,
          scope,
          sourcePath,
          `legacy alias ${directField} conflicts with ${modelsField}`,
          directField,
        );
      } else if (!Object.hasOwn(rawProvider.fallback, "models")) {
        rawProvider.fallback.models = cloneJsonValue(directValue);
      }
      delete rawProvider.fallback_models;
      notices.push(Object.freeze({
        scope,
        sourcePath,
        field: directField,
        action: "migrate",
        target: targetsField,
      }));
    }

    if (
      !isPlainRecord(rawProvider.fallback) ||
      !Object.hasOwn(rawProvider.fallback, "models")
    ) continue;
    const legacyModels = rawProvider.fallback.models;
    delete rawProvider.fallback.models;
    if (
      !Array.isArray(legacyModels) ||
      !legacyModels.every((model) => typeof model === "string")
    ) {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        "legacy provider fallback models must be string[]",
        modelsField,
      );
      continue;
    }
    if (rawProvider.fallback.targets === undefined) {
      rawProvider.fallback.targets = [];
    }
    if (!Array.isArray(rawProvider.fallback.targets)) {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        "legacy provider fallback models collide with non-array structured targets",
        targetsField,
      );
      continue;
    }
    const targets = rawProvider.fallback.targets as unknown[];
    const currentProvider = normalizeProviderValue(providerName);
    for (const rawModel of legacyModels) {
      const model = rawModel.trim();
      if (model.length === 0) continue;
      const duplicate = targets.some((target) => {
        if (!isPlainRecord(target) || typeof target.model !== "string") {
          return false;
        }
        const targetProvider = target.provider === undefined
          ? currentProvider
          : normalizeProviderValue(target.provider);
        return targetProvider === currentProvider && target.model.trim() === model;
      });
      if (!duplicate) targets.push({ model });
    }
    notices.push(Object.freeze({
      scope,
      sourcePath,
      field: modelsField,
      action: "migrate",
      target: targetsField,
    }));
  }
}

function dropRetiredInactiveConfigFields(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  notices: ConfigMigrationNotice[],
): void {
  if (isPlainRecord(config.sandbox) && Object.hasOwn(config.sandbox, "failIfUnavailable")) {
    delete config.sandbox.failIfUnavailable;
    notices.push(Object.freeze({
      scope,
      sourcePath,
      field: "sandbox.failIfUnavailable",
      action: "drop",
    }));
  }
  if (!isPlainRecord(config.shell_environment_policy)) return;
  for (const field of [
    "inherit",
    "ignore_default_excludes",
    "exclude",
    "include_only",
  ] as const) {
    if (!Object.hasOwn(config.shell_environment_policy, field)) continue;
    delete config.shell_environment_policy[field];
    notices.push(Object.freeze({
      scope,
      sourcePath,
      field: `shell_environment_policy.${field}`,
      action: "drop",
    }));
  }
}

function dropRetiredDurableResumePolicy(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  notices: ConfigMigrationNotice[],
): void {
  if (
    !isPlainRecord(config.durableTurns) ||
    !isPlainRecord(config.durableTurns.resume) ||
    !Object.hasOwn(config.durableTurns.resume, "policy")
  ) return;
  delete config.durableTurns.resume.policy;
  notices.push(Object.freeze({
    scope,
    sourcePath,
    field: "durableTurns.resume.policy",
    action: "drop",
  }));
}

function migrateRetiredCleanupPeriodDays(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
): void {
  if (!Object.hasOwn(config, "cleanupPeriodDays")) return;
  const value = config.cleanupPeriodDays;
  delete config.cleanupPeriodDays;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "cleanupPeriodDays must be a non-negative integer before it can be retired",
      "cleanupPeriodDays",
    );
    return;
  }
  if (value === 0) {
    mergeValue(config, "transcriptPersistenceEnabled", false, {
      scope,
      sourcePath,
      conflicts,
    });
    notices.push(Object.freeze({
      scope,
      sourcePath,
      field: "cleanupPeriodDays",
      action: "migrate",
      target: "transcriptPersistenceEnabled",
    }));
    return;
  }
  notices.push(Object.freeze({
    scope,
    sourcePath,
    field: "cleanupPeriodDays",
    action: "drop",
    target: "agent.retention.rollout_days",
  }));
}

function migrateRetiredPluginEntryFields(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
): void {
  if (!isPlainRecord(config.plugins) || !isPlainRecord(config.plugins.plugins)) {
    return;
  }
  for (const [pluginId, rawPlugin] of Object.entries(config.plugins.plugins)) {
    const prefix = `plugins.plugins.${pluginId}`;
    if (typeof rawPlugin === "boolean") {
      config.plugins.plugins[pluginId] = { enabled: rawPlugin };
      notices.push(Object.freeze({
        scope,
        sourcePath,
        field: prefix,
        action: "migrate",
        target: `${prefix}.enabled`,
      }));
      continue;
    }
    if (!isPlainRecord(rawPlugin)) continue;
    if (Object.hasOwn(rawPlugin, "options")) {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        "retired plugin options cannot be classified as secret or non-secret without the installed manifest schema; reconfigure the plugin through /plugin, or manually copy only verified non-sensitive values into pluginConfigs after migration",
        `${prefix}.options`,
      );
    }
    for (const field of ["source", "version", "required"] as const) {
      if (!Object.hasOwn(rawPlugin, field)) continue;
      delete rawPlugin[field];
      notices.push(Object.freeze({
        scope,
        sourcePath,
        field: `${prefix}.${field}`,
        action: "drop",
      }));
    }
  }
}

function mergeRetiredGrokCapabilityLeaves(
  target: JsonRecord,
  source: Readonly<JsonRecord>,
  sourcePrefix: string,
  targetPrefix: string,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
): void {
  for (const [key, value] of Object.entries(source)) {
    const retiredField = `${sourcePrefix}.${key}`;
    const canonicalField = `${targetPrefix}.${key}`;
    if (isPlainRecord(value)) {
      if (!Object.hasOwn(target, key)) target[key] = {};
      if (!isPlainRecord(target[key])) {
        pushConflict(
          conflicts,
          scope,
          sourcePath,
          `retired ${retiredField} conflicts with non-object canonical ${canonicalField}; migration refuses to choose`,
          retiredField,
        );
        continue;
      }
      mergeRetiredGrokCapabilityLeaves(
        target[key],
        value,
        retiredField,
        canonicalField,
        scope,
        sourcePath,
        conflicts,
        notices,
      );
      continue;
    }
    if (
      Object.hasOwn(target, key) &&
      stableJson(target[key]) !== stableJson(value)
    ) {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        `retired ${retiredField} conflicts with canonical ${canonicalField}; migration refuses to choose`,
        retiredField,
      );
      continue;
    }
    if (!Object.hasOwn(target, key)) target[key] = cloneJsonValue(value);
    notices.push(Object.freeze({
      scope,
      sourcePath,
      field: retiredField,
      action: "migrate",
      target: canonicalField,
    }));
  }
}

const RETIRED_LLM_XAI_CAPABILITY_KEYS: ReadonlySet<string> = new Set([
  "web_search",
  "x_search",
  "code_execution",
  "enable_image_search",
  "enable_image_understanding",
  "enable_video_understanding",
  "collections",
  "remote_mcp",
]);

function migrateRetiredLlmXaiProviderConfig(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
): void {
  if (!Object.hasOwn(config, "llm")) return;
  if (!isPlainRecord(config.llm)) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "retired llm must be a table containing only llm.xai",
      "llm",
    );
    return;
  }
  const llm = config.llm;
  for (const key of Object.keys(llm)) {
    if (key === "xai") continue;
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      `retired llm.${key} has no canonical provider authority`,
      `llm.${key}`,
    );
  }
  if (!Object.hasOwn(llm, "xai")) return;
  if (!isPlainRecord(llm.xai)) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "retired llm.xai must be a table",
      "llm.xai",
    );
    return;
  }
  const retiredXai = llm.xai;
  const unknownCapabilityKeys = Object.keys(retiredXai).filter(
    (key) => !RETIRED_LLM_XAI_CAPABILITY_KEYS.has(key),
  );
  for (const key of unknownCapabilityKeys) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      `retired llm.xai.${key} has no canonical providers.grok capability`,
      `llm.xai.${key}`,
    );
  }
  const classifiedCapabilities = Object.fromEntries(
    Object.entries(retiredXai).filter(([key]) =>
      RETIRED_LLM_XAI_CAPABILITY_KEYS.has(key)
    ),
  );
  if (config.providers === undefined) config.providers = {};
  if (!isPlainRecord(config.providers)) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "retired llm.xai cannot be merged because canonical providers is not a table",
      "providers",
    );
    return;
  }
  if (config.providers.grok === undefined) config.providers.grok = {};
  if (!isPlainRecord(config.providers.grok)) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "retired llm.xai cannot be merged because canonical providers.grok is not a table",
      "providers.grok",
    );
    return;
  }
  mergeRetiredGrokCapabilityLeaves(
    config.providers.grok,
    classifiedCapabilities,
    "llm.xai",
    "providers.grok",
    scope,
    sourcePath,
    conflicts,
    notices,
  );
  delete llm.xai;
  if (Object.keys(llm).length === 0) delete config.llm;
}

function blockRetiredProviderApiKeyEnv(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
): void {
  if (!isPlainRecord(config.providers)) return;
  for (const [provider, value] of Object.entries(config.providers)) {
    if (!isPlainRecord(value) || !Object.hasOwn(value, "api_key_env")) continue;
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      `providers.${provider}.api_key_env is retired; use the provider's canonical credential environment variable or the native secure storage`,
      `providers.${provider}.api_key_env`,
    );
    delete value.api_key_env;
  }
}

function blockRetiredPlaintextRemoteMcpAuthorization(
  config: Readonly<JsonRecord>,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
): void {
  const providers = isPlainRecord(config.providers) ? config.providers : undefined;
  const grok = providers && isPlainRecord(providers.grok)
    ? providers.grok
    : undefined;
  const remoteMcp = grok && isPlainRecord(grok.remote_mcp)
    ? grok.remote_mcp
    : undefined;
  if (!remoteMcp || !Array.isArray(remoteMcp.servers)) return;
  remoteMcp.servers.forEach((server, index) => {
    if (!isPlainRecord(server) || !Object.hasOwn(server, "authorization")) return;
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "plaintext remote-MCP authorization cannot be migrated safely; move the token to an operator-selected environment variable, replace authorization with authorization_env, remove the plaintext value, and rerun migration check",
      `providers.grok.remote_mcp.servers.${index}.authorization`,
    );
  });
}

function convertV1Config(
  raw: Readonly<JsonRecord>,
  sourcePath: string,
  scope: ConfigMigrationScope,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
): JsonRecord {
  const converted = cloneRecord(raw);
  if (Object.hasOwn(converted, "pluginConfigs")) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "pre-v2 pluginConfigs cannot be classified as secret or non-secret without the installed manifest schema; reconfigure through /plugin or manually copy only verified non-sensitive values after migration",
      "pluginConfigs",
    );
  }
  for (const key of Object.keys(converted)) {
    // The retired provider capability table is handled losslessly below after
    // provider aliases have been normalized.
    if (key === "llm") continue;
    const classification = classifyRetiredField("config-toml-v1", key);
    if (classification.action === "block") {
      pushConflict(conflicts, scope, sourcePath, classification.note, key);
      continue;
    }
    if (classification.action === "drop") {
      delete converted[key];
      notices.push(Object.freeze({ scope, sourcePath, field: key, action: "drop" }));
    }
  }
  if (Object.hasOwn(converted, "editorMode")) {
    const editorMode = converted.editorMode;
    delete converted.editorMode;
    if (mergeLegacyEditorMode(
      converted,
      editorMode,
      scope,
      sourcePath,
      conflicts,
    )) {
      notices.push(Object.freeze({
        scope,
        sourcePath,
        field: "editorMode",
        action: "migrate",
        target: "tui.vimMode",
      }));
    }
  }
  if (Object.hasOwn(converted, "enabledPlugins")) {
    const enabledPlugins = converted.enabledPlugins;
    delete converted.enabledPlugins;
    if (mergeLegacyEnabledPlugins(
      converted,
      enabledPlugins,
      scope,
      sourcePath,
      conflicts,
    )) {
      notices.push(Object.freeze({
        scope,
        sourcePath,
        field: "enabledPlugins",
        action: "migrate",
        target: "plugins.plugins",
      }));
    }
  }
  if (Object.hasOwn(converted, "effortLevel")) {
    const effortLevel = converted.effortLevel;
    delete converted.effortLevel;
    if (mergeLegacyEffortLevel(
      converted,
      effortLevel,
      scope,
      sourcePath,
      conflicts,
    )) {
      notices.push(Object.freeze({
        scope,
        sourcePath,
        field: "effortLevel",
        action: "migrate",
        target: "reasoning_effort",
      }));
    }
  }
  if (Object.hasOwn(converted, "sandbox_policy")) {
    const sandboxPolicy = converted.sandbox_policy;
    delete converted.sandbox_policy;
    const targets = mergeLegacySandboxPolicy(
      converted,
      sandboxPolicy,
      scope,
      sourcePath,
      conflicts,
    );
    if (targets.length > 0) {
      notices.push(Object.freeze({
        scope,
        sourcePath,
        field: "sandbox_policy",
        action: "migrate",
        target: targets.join(","),
      }));
    }
  }
  if (isPlainRecord(converted.permissions)) {
    const legacyPermissionTargets: Readonly<Record<string, string>> = {
      default_mode: "approval_policy",
      disableBypassPermissionsMode: "permissions.bypassPermissionsMode",
      allowBypassPermissionsMode: "permissions.bypassPermissionsMode",
      disableAutoMode: "disableAutoMode",
      allowManagedPermissionRulesOnly: "allowManagedPermissionRulesOnly",
    };
    const legacyPermissionFields = Object.keys(legacyPermissionTargets)
      .filter((field) => Object.hasOwn(converted.permissions as JsonRecord, field));
    if (legacyPermissionFields.length > 0) {
      const mapped = mapSettingsConfigValue("permissions", converted.permissions);
      if (mapped === null) {
        pushConflict(
          conflicts,
          scope,
          sourcePath,
          "legacy permission controls conflict or cannot be mapped losslessly",
          "permissions",
        );
      } else {
        delete converted.permissions;
        for (const item of mapped) {
          mergeConfigPath(converted, item.target, item.value, {
            scope,
            sourcePath,
            conflicts,
          });
        }
        for (const field of legacyPermissionFields) {
          notices.push(Object.freeze({
            scope,
            sourcePath,
            field: `permissions.${field}`,
            action: "migrate",
            target: legacyPermissionTargets[field],
          }));
        }
      }
    }
  }
  migrateLegacyAutoModeAlias(
    converted,
    scope,
    sourcePath,
    conflicts,
    notices,
  );
  migrateLegacyMcpTransportAliases(
    converted,
    scope,
    sourcePath,
    notices,
  );
  migrateLegacyProfileToolKeys(
    converted,
    scope,
    sourcePath,
    conflicts,
    notices,
  );
  detectProviderSelectorMigrationConflicts(
    converted,
    scope,
    sourcePath,
    conflicts,
  );
  const migrated = normalizeExplicitMigrationAliases(
    converted,
    scope,
    sourcePath,
    conflicts,
  );
  migrateRetiredLlmXaiProviderConfig(
    migrated,
    scope,
    sourcePath,
    conflicts,
    notices,
  );
  blockRetiredProviderApiKeyEnv(migrated, scope, sourcePath, conflicts);
  blockRetiredPlaintextRemoteMcpAuthorization(
    migrated,
    scope,
    sourcePath,
    conflicts,
  );
  delete migrated.configVersion;
  delete migrated.agenc_home;
  migrated[CANONICAL_CONFIG_VERSION_KEY] = CANONICAL_CONFIG_VERSION;
  dropRetiredHeartbeatSelectors(migrated, scope, sourcePath, notices);
  dropRetiredDaemonTransport(migrated, scope, sourcePath, notices);
  dropRetiredTopLevelConfigFields(migrated, scope, sourcePath, notices);
  migrateRetiredSandboxWritableRoots(
    migrated,
    scope,
    sourcePath,
    conflicts,
    notices,
  );
  migrateRetiredProtocolNoOps(migrated, scope, sourcePath, notices);
  migrateRetiredApprovalsReviewerAlias(
    migrated,
    scope,
    sourcePath,
    notices,
  );
  migrateRetiredServiceTierAlias(migrated, scope, sourcePath, notices);
  migrateRetiredReasoningEffortAlias(migrated, scope, sourcePath, notices);
  dropRetiredInactiveConfigFields(migrated, scope, sourcePath, notices);
  return migrated;
}

function migratedProviderValue(value: unknown): unknown {
  return typeof value === "string"
    ? migrateRetiredProviderSelector(value)
    : value;
}

function detectModelProviderAliasConflict(
  record: JsonRecord,
  prefix: string,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
): void {
  if (!Object.hasOwn(record, "model_provider")) return;
  const canonical = migratedProviderValue(record.model_provider);
  for (const alias of ["provider", "modelProvider"] as const) {
    if (!Object.hasOwn(record, alias)) continue;
    if (stableJson(migratedProviderValue(record[alias])) === stableJson(canonical)) {
      continue;
    }
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "legacy provider selector conflicts with canonical model_provider; migration refuses to choose",
      prefix.length > 0 ? `${prefix}.${alias}` : alias,
    );
  }
}

function detectProviderSelectorMigrationConflicts(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
): void {
  detectModelProviderAliasConflict(config, "", scope, sourcePath, conflicts);
  if (isPlainRecord(config.profiles)) {
    for (const [name, rawProfile] of Object.entries(config.profiles)) {
      if (!isPlainRecord(rawProfile)) continue;
      detectModelProviderAliasConflict(
        rawProfile,
        `profiles.${name}`,
        scope,
        sourcePath,
        conflicts,
      );
    }
  }
  if (!isPlainRecord(config.providers)) return;
  const targets = new Map<string, { readonly key: string; readonly value: unknown }>();
  for (const [key, value] of Object.entries(config.providers)) {
    const target = migrateRetiredProviderSelector(key) ?? key;
    const prior = targets.get(target);
    if (prior === undefined) {
      targets.set(target, { key, value });
      continue;
    }
    if (stableJson(prior.value) === stableJson(value)) continue;
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      `provider entries "${prior.key}" and "${key}" both migrate to "${target}" with different values`,
      `providers.${target}`,
    );
  }
}

function mergeValue(
  target: JsonRecord,
  key: string,
  value: unknown,
  context: {
    readonly scope: ConfigMigrationScope;
    readonly sourcePath: string;
    readonly conflicts: ConfigMigrationConflict[];
    readonly prefix?: string;
  },
): void {
  const field = context.prefix ? `${context.prefix}.${key}` : key;
  if (UNSAFE_JSON_KEY_SEGMENTS.has(key)) {
    pushConflict(
      context.conflicts,
      context.scope,
      context.sourcePath,
      "migration refuses an object-prototype key segment",
      field,
    );
    return;
  }
  if (!Object.hasOwn(target, key)) {
    defineJsonProperty(target, key, cloneJsonValue(value));
    return;
  }
  const existing = target[key];
  if (isPlainRecord(existing) && isPlainRecord(value)) {
    for (const [childKey, child] of Object.entries(value)) {
      mergeValue(existing, childKey, child, { ...context, prefix: field });
    }
    return;
  }
  if (stableJson(existing) === stableJson(value)) return;
  pushConflict(
    context.conflicts,
    context.scope,
    context.sourcePath,
    "two legacy authorities contain different values; migration refuses to choose",
    field,
  );
}

function defineJsonProperty(
  target: JsonRecord,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function mergeConfigPath(
  target: JsonRecord,
  path: string,
  value: unknown,
  context: {
    readonly scope: ConfigMigrationScope;
    readonly sourcePath: string;
    readonly conflicts: ConfigMigrationConflict[];
  },
): void {
  const segments = path.split(".");
  const leaf = segments.pop();
  if (!leaf || segments.some(segment => segment.length === 0)) {
    pushConflict(
      context.conflicts,
      context.scope,
      context.sourcePath,
      "migration target is not a valid canonical path",
      path,
    );
    return;
  }
  let cursor = target;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (UNSAFE_JSON_KEY_SEGMENTS.has(segment)) {
      pushConflict(
        context.conflicts,
        context.scope,
        context.sourcePath,
        "migration refuses an object-prototype key segment",
        segments.slice(0, index + 1).join("."),
      );
      return;
    }
    if (!Object.hasOwn(cursor, segment)) {
      const next: JsonRecord = {};
      defineJsonProperty(cursor, segment, next);
      cursor = next;
      continue;
    }
    const existing = cursor[segment];
    if (!isPlainRecord(existing)) {
      pushConflict(
        context.conflicts,
        context.scope,
        context.sourcePath,
        "canonical target path collides with a non-object value",
        segments.slice(0, index + 1).join("."),
      );
      return;
    }
    cursor = existing;
  }
  mergeValue(cursor, leaf, value, {
    ...context,
    ...(segments.length > 0 ? { prefix: segments.join(".") } : {}),
  });
}

function normalizeProviderValue(value: unknown): unknown {
  return typeof value === "string"
    ? migrateRetiredProviderSelector(value) ?? value
    : value;
}

function migrateAlias(
  record: JsonRecord,
  alias: string,
  canonical: string,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
  normalize: (value: unknown) => unknown = value => value,
  prefix = "",
): void {
  if (!Object.hasOwn(record, alias)) return;
  const field = prefix ? `${prefix}.${alias}` : alias;
  const target = prefix ? `${prefix}.${canonical}` : canonical;
  const aliasValue = normalize(record[alias]);
  if (Object.hasOwn(record, canonical)) {
    const canonicalValue = normalize(record[canonical]);
    if (stableJson(aliasValue) !== stableJson(canonicalValue)) {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        `legacy alias ${field} conflicts with canonical ${target}`,
        field,
      );
    }
    record[canonical] = cloneJsonValue(canonicalValue);
  } else {
    record[canonical] = cloneJsonValue(aliasValue);
  }
  delete record[alias];
}

function normalizeProviderConfigForMigration(value: unknown): unknown {
  if (!isPlainRecord(value)) return cloneJsonValue(value);
  const config = cloneRecord(value);
  if (!isPlainRecord(config.fallback)) return config;
  const fallback = cloneRecord(config.fallback);
  if (Array.isArray(fallback.targets)) {
    fallback.targets = fallback.targets.map(target => {
      if (!isPlainRecord(target)) return cloneJsonValue(target);
      const normalized = cloneRecord(target);
      if (Object.hasOwn(normalized, "provider")) {
        normalized.provider = normalizeProviderValue(normalized.provider);
      }
      return normalized;
    });
  }
  config.fallback = fallback;
  return config;
}

function normalizeExplicitMigrationAliases(
  raw: Readonly<JsonRecord>,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
): JsonRecord {
  const out = cloneRecord(raw);
  for (const [alias, canonical] of [
    ["tools", "tools_config"],
    ["model_reasoning_effort", "reasoning_effort"],
    ["model_reasoning_summary", "reasoning_summary"],
  ] as const) {
    migrateAlias(out, alias, canonical, scope, sourcePath, conflicts);
  }
  for (const alias of ["modelProvider", "provider"] as const) {
    migrateAlias(
      out,
      alias,
      "model_provider",
      scope,
      sourcePath,
      conflicts,
      normalizeProviderValue,
    );
  }
  if (Object.hasOwn(out, "model_provider")) {
    out.model_provider = normalizeProviderValue(out.model_provider);
  }

  if (isPlainRecord(out.agents)) {
    const agents = cloneRecord(out.agents);
    for (const [alias, canonical] of [
      ["max_threads", "agent_max_threads"],
      ["max_depth", "agent_max_depth"],
    ] as const) {
      if (!Object.hasOwn(agents, alias)) continue;
      const value = agents[alias];
      if (
        Object.hasOwn(out, canonical) &&
        stableJson(out[canonical]) !== stableJson(value)
      ) {
        pushConflict(
          conflicts,
          scope,
          sourcePath,
          `legacy alias agents.${alias} conflicts with canonical ${canonical}`,
          `agents.${alias}`,
        );
      } else if (!Object.hasOwn(out, canonical)) {
        out[canonical] = cloneJsonValue(value);
      }
      delete agents[alias];
    }
    if (Object.keys(agents).length === 0) delete out.agents;
    else out.agents = agents;
  }

  if (isPlainRecord(out.profiles)) {
    const profiles = cloneRecord(out.profiles);
    for (const [name, value] of Object.entries(profiles)) {
      if (!isPlainRecord(value)) continue;
      const profile = cloneRecord(value);
      for (const alias of ["modelProvider", "provider"] as const) {
        migrateAlias(
          profile,
          alias,
          "model_provider",
          scope,
          sourcePath,
          conflicts,
          normalizeProviderValue,
          `profiles.${name}`,
        );
      }
      if (Object.hasOwn(profile, "model_provider")) {
        profile.model_provider = normalizeProviderValue(profile.model_provider);
      }
      profiles[name] = profile;
    }
    out.profiles = profiles;
  }

  if (isPlainRecord(out.providers)) {
    const providers: JsonRecord = {};
    for (const [name, value] of Object.entries(out.providers)) {
      const canonical = migrateRetiredProviderSelector(name) ?? name;
      if (canonical !== name) continue;
      providers[name] = normalizeProviderConfigForMigration(value);
    }
    for (const [name, value] of Object.entries(out.providers)) {
      const canonical = migrateRetiredProviderSelector(name) ?? name;
      if (canonical === name || Object.hasOwn(providers, canonical)) continue;
      providers[canonical] = normalizeProviderConfigForMigration(value);
    }
    out.providers = providers;
  }
  return out;
}

function mergeRecord(
  target: JsonRecord,
  incoming: Readonly<JsonRecord>,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
): void {
  for (const [key, value] of Object.entries(incoming)) {
    mergeValue(target, key, value, { scope, sourcePath, conflicts });
  }
}

function legacyEditorModeValue(value: unknown): boolean | null {
  if (value === "vim") return true;
  if (value === "default" || value === "normal" || value === "emacs") {
    return false;
  }
  return null;
}

function mergeLegacyEditorMode(
  config: JsonRecord,
  value: unknown,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
): boolean {
  const vimMode = legacyEditorModeValue(value);
  if (vimMode === null) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      'legacy editorMode must be "vim", "default", "normal", or "emacs"',
      "editorMode",
    );
    return false;
  }
  if (config.tui !== undefined && !isPlainRecord(config.tui)) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "editorMode cannot merge with a non-object tui value",
      "tui",
    );
    return false;
  }
  const tui = isPlainRecord(config.tui)
    ? config.tui
    : (config.tui = {} as JsonRecord);
  mergeValue(tui, "vimMode", vimMode, {
    scope,
    sourcePath,
    conflicts,
    prefix: "tui",
  });
  return true;
}

function mergeLegacyEnabledPlugins(
  config: JsonRecord,
  value: unknown,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
): boolean {
  if (!isPlainRecord(value)) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "legacy enabledPlugins must be an object",
      "enabledPlugins",
    );
    return false;
  }
  if (config.plugins !== undefined && !isPlainRecord(config.plugins)) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "enabledPlugins cannot merge with a non-object plugins value",
      "plugins",
    );
    return false;
  }
  const plugins = isPlainRecord(config.plugins)
    ? config.plugins
    : (config.plugins = {} as JsonRecord);
  mergeValue(plugins, "plugins", value, {
    scope,
    sourcePath,
    conflicts,
    prefix: "plugins",
  });
  return true;
}

function mergeLegacyEffortLevel(
  config: JsonRecord,
  value: unknown,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
): boolean {
  const effort = value === "max"
    ? "xhigh"
    : value === "minimal"
      ? "low"
      : value;
  if (
    effort !== "low" && effort !== "medium" &&
    effort !== "high" && effort !== "xhigh"
  ) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "legacy effortLevel must be minimal, low, medium, high, max, or xhigh",
      "effortLevel",
    );
    return false;
  }
  mergeValue(config, "reasoning_effort", effort, {
    scope,
    sourcePath,
    conflicts,
  });
  return true;
}

function mergeLegacySandboxPolicy(
  config: JsonRecord,
  value: unknown,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
): readonly string[] {
  if (!isPlainRecord(value)) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "legacy sandbox_policy must be an object",
      "sandbox_policy",
    );
    return [];
  }
  const unknown = Object.keys(value).filter(
    (key) => !["mode", "network_access", "writable_roots"].includes(key),
  );
  if (unknown.length > 0) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      `legacy sandbox_policy has unsupported fields: ${unknown.join(", ")}`,
      "sandbox_policy",
    );
    return [];
  }

  const targets: string[] = [];
  if (value.mode !== undefined) {
    if (
      value.mode !== "read-only" && value.mode !== "workspace-write" &&
      value.mode !== "danger-full-access"
    ) {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        "legacy sandbox_policy.mode is invalid",
        "sandbox_policy.mode",
      );
      return [];
    }
    mergeValue(config, "sandbox_mode", value.mode, {
      scope,
      sourcePath,
      conflicts,
    });
    targets.push("sandbox_mode");
  }

  const sandboxPatch: JsonRecord = {};
  if (value.network_access !== undefined) {
    if (typeof value.network_access !== "boolean") {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        "legacy sandbox_policy.network_access must be boolean",
        "sandbox_policy.network_access",
      );
      return [];
    }
    sandboxPatch.network_access = value.network_access;
    targets.push("sandbox.network_access");
  }
  if (value.writable_roots !== undefined) {
    if (
      !Array.isArray(value.writable_roots) ||
      !value.writable_roots.every((root) => typeof root === "string")
    ) {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        "legacy sandbox_policy.writable_roots must be string[]",
        "sandbox_policy.writable_roots",
      );
      return [];
    }
    sandboxPatch.filesystem = { allowWrite: value.writable_roots };
    targets.push("sandbox.filesystem.allowWrite");
  }
  if (Object.keys(sandboxPatch).length > 0) {
    mergeValue(config, "sandbox", sandboxPatch, {
      scope,
      sourcePath,
      conflicts,
    });
  }
  return targets;
}

function normalizeLegacyAutoModeValue(value: unknown): JsonRecord | null {
  if (!isPlainRecord(value)) return null;
  const autoMode = cloneRecord(value);
  if (!Object.hasOwn(autoMode, "deny")) return autoMode;
  const deny = autoMode.deny;
  delete autoMode.deny;
  if (
    autoMode.soft_deny !== undefined &&
    stableJson(autoMode.soft_deny) !== stableJson(deny)
  ) {
    return null;
  }
  if (autoMode.soft_deny === undefined) autoMode.soft_deny = deny;
  return autoMode;
}

function migrateLegacyAutoModeAlias(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
): void {
  if (!isPlainRecord(config.autoMode) || !Object.hasOwn(config.autoMode, "deny")) {
    return;
  }
  const normalized = normalizeLegacyAutoModeValue(config.autoMode);
  if (normalized === null) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "autoMode.deny conflicts with canonical autoMode.soft_deny",
      "autoMode.deny",
    );
    return;
  }
  config.autoMode = normalized;
  notices.push(Object.freeze({
    scope,
    sourcePath,
    field: "autoMode.deny",
    action: "migrate",
    target: "autoMode.soft_deny",
  }));
}

function migrateLegacyMcpTransportAliases(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  notices: ConfigMigrationNotice[],
): void {
  if (!isPlainRecord(config.mcp_servers)) return;
  for (const [serverName, rawServer] of Object.entries(config.mcp_servers)) {
    if (!isPlainRecord(rawServer) || rawServer.transport !== "ws") continue;
    rawServer.transport = "websocket";
    notices.push(Object.freeze({
      scope,
      sourcePath,
      field: `mcp_servers.${serverName}.transport`,
      action: "migrate",
      target: `mcp_servers.${serverName}.transport=websocket`,
    }));
  }
}

function migrateLegacyProfileToolKeys(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
): void {
  if (config.profiles === undefined) return;
  if (!isPlainRecord(config.profiles)) {
    pushConflict(conflicts, scope, sourcePath, "profiles must be an object", "profiles");
    return;
  }
  for (const [profileName, rawProfile] of Object.entries(config.profiles)) {
    if (!isPlainRecord(rawProfile)) {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        "profile must be an object",
        `profiles.${profileName}`,
      );
      continue;
    }
    const profile = rawProfile;
    if (profile.tools_config !== undefined && !isPlainRecord(profile.tools_config)) {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        "profile tools_config must be an object",
        `profiles.${profileName}.tools_config`,
      );
      continue;
    }
    const tools = isPlainRecord(profile.tools_config)
      ? profile.tools_config
      : (profile.tools_config = {} as JsonRecord);
    let migrated = false;
    if (Object.hasOwn(profile, "tools")) {
      if (!isPlainRecord(profile.tools)) {
        pushConflict(
          conflicts,
          scope,
          sourcePath,
          "legacy profile tools must be an object",
          `profiles.${profileName}.tools`,
        );
      } else {
        for (const [key, value] of Object.entries(profile.tools)) {
          mergeValue(tools, key, value, {
            scope,
            sourcePath,
            conflicts,
            prefix: `profiles.${profileName}.tools_config`,
          });
        }
        migrated = true;
      }
      delete profile.tools;
    }
    if (Object.hasOwn(profile, "web_search")) {
      const raw = profile.web_search;
      const webSearch = typeof raw === "boolean"
        ? raw
        : raw === "always" || raw === "auto"
          ? true
          : raw === "never"
            ? false
            : undefined;
      if (webSearch === undefined) {
        pushConflict(
          conflicts,
          scope,
          sourcePath,
          "legacy profile web_search must be boolean, auto, always, or never",
          `profiles.${profileName}.web_search`,
        );
      } else {
        mergeValue(tools, "web_search", webSearch, {
          scope,
          sourcePath,
          conflicts,
          prefix: `profiles.${profileName}.tools_config`,
        });
        migrated = true;
      }
      delete profile.web_search;
    }
    if (Object.keys(tools).length === 0) delete profile.tools_config;
    if (migrated) {
      notices.push(Object.freeze({
        scope,
        sourcePath,
        field: `profiles.${profileName}`,
        action: "migrate",
        target: `profiles.${profileName}.tools_config`,
      }));
    }
  }
}

const LEGACY_PER_TOOL_PERMISSION_VALUES = new Set([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);

const LEGACY_HOOK_EVENT_ALIASES = Object.freeze({
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUseFailure",
  permissionRequest: "PermissionRequest",
  userPromptSubmit: "UserPromptSubmit",
  sessionStart: "SessionStart",
  subagentStop: "SubagentStop",
  sessionEnd: "SessionEnd",
  notification: "Notification",
  stop: "Stop",
  stopFailure: "StopFailure",
  preCompact: "PreCompact",
  postCompact: "PostCompact",
} as const);

const RETIRED_PERMISSION_RULE_TOOL_NAMES: Readonly<Record<string, string>> =
  Object.freeze({
    WebFetch: "web_fetch",
    Brief: "SendUserMessage",
    Read: "FileRead",
    FileReadTool: "FileRead",
    FileEdit: "Edit",
    FileEditTool: "Edit",
    FileWrite: "Write",
    FileWriteTool: "Write",
    "system.grep": "Grep",
    "system.glob": "Glob",
    Bash: "system.bash",
    bash: "system.bash",
    "desktop.bash": "system.bash",
    shell: "system.bash",
    Task: "spawn_agent",
    KillShell: "TaskStop",
    AgentOutputTool: "TaskOutput",
    BashOutputTool: "TaskOutput",
  });

function migratePermissionRuleToolName(raw: string): string {
  const parsed = parseRuleString(raw);
  if (parsed === null) return raw;
  const canonical = RETIRED_PERMISSION_RULE_TOOL_NAMES[parsed.toolName];
  if (canonical === undefined) return raw;
  return `${canonical}${raw.slice(parsed.toolName.length)}`;
}

function migrateLegacyPermissionRuleToolNames(
  value: unknown,
  scope: ConfigMigrationScope,
  sourcePath: string,
  notices: ConfigMigrationNotice[],
  field = "",
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      migrateLegacyPermissionRuleToolNames(
        entry,
        scope,
        sourcePath,
        notices,
        field ? `${field}.${index}` : String(index),
      )
    );
    return;
  }
  if (!isPlainRecord(value)) return;

  const record = value as JsonRecord;
  if (isPlainRecord(record.permissions)) {
    const permissions = record.permissions as JsonRecord;
    for (const behavior of ["allow", "deny", "ask"] as const) {
      const rules = permissions[behavior];
      if (!Array.isArray(rules)) continue;
      const migrated: unknown[] = [];
      const seen = new Set<string>();
      rules.forEach((rule, index) => {
        if (typeof rule !== "string") {
          migrated.push(rule);
          return;
        }
        const next = migratePermissionRuleToolName(rule);
        if (next !== rule) {
          notices.push(Object.freeze({
            scope,
            sourcePath,
            field: `${field ? `${field}.` : ""}permissions.${behavior}.${index}`,
            action: "migrate",
            target: next,
          }));
        }
        if (seen.has(next)) return;
        seen.add(next);
        migrated.push(next);
      });
      permissions[behavior] = migrated;
    }
  }

  for (const [key, child] of Object.entries(record)) {
    migrateLegacyPermissionRuleToolNames(
      child,
      scope,
      sourcePath,
      notices,
      field ? `${field}.${key}` : key,
    );
  }
}

function migrateLegacyHookEventAliases(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
): void {
  if (config.hooks === undefined) return;
  if (!isPlainRecord(config.hooks)) {
    pushConflict(conflicts, scope, sourcePath, "hooks must be an object", "hooks");
    return;
  }
  const hooks = config.hooks as JsonRecord;
  for (const [alias, canonical] of Object.entries(LEGACY_HOOK_EVENT_ALIASES)) {
    if (!Object.hasOwn(hooks, alias)) continue;
    const value = hooks[alias];
    const existing = hooks[canonical];
    if (existing !== undefined && stableJson(existing) !== stableJson(value)) {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        `${alias} conflicts with ${canonical}`,
        `hooks.${alias}`,
      );
    } else if (existing === undefined) {
      hooks[canonical] = cloneJsonValue(value);
    }
    delete hooks[alias];
    notices.push(Object.freeze({
      scope,
      sourcePath,
      field: `hooks.${alias}`,
      action: "migrate",
      target: `hooks.${canonical}`,
    }));
  }
}

/**
 * Collapse removed per-tool permission aliases anywhere in a legacy JSON/v1
 * tree. Schema v2 accepts only `default_permission_mode`; migration is the
 * sole place that understands the old camel-case and approval-mode spellings.
 */
function migrateLegacyPerToolPermissionAliases(
  value: unknown,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
  field = "",
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      migrateLegacyPerToolPermissionAliases(
        entry,
        scope,
        sourcePath,
        conflicts,
        notices,
        field ? `${field}.${index}` : String(index),
      )
    );
    return;
  }
  if (!isPlainRecord(value)) return;

  const record = value as JsonRecord;
  const mergeAlias = (alias: string, mapped: unknown): void => {
    const aliasField = field ? `${field}.${alias}` : alias;
    if (!LEGACY_PER_TOOL_PERMISSION_VALUES.has(String(mapped))) {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        `${alias} has no lossless canonical permission-mode mapping`,
        aliasField,
      );
      delete record[alias];
      return;
    }
    const existing = record.default_permission_mode;
    if (existing !== undefined && existing !== mapped) {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        `${alias} conflicts with default_permission_mode`,
        aliasField,
      );
    } else {
      record.default_permission_mode = mapped as JsonRecord[string];
      notices.push(Object.freeze({
        scope,
        sourcePath,
        field: aliasField,
        action: "migrate",
        target: field
          ? `${field}.default_permission_mode`
          : "default_permission_mode",
      }));
    }
    delete record[alias];
  };

  if (Object.hasOwn(record, "defaultPermissionMode")) {
    mergeAlias("defaultPermissionMode", record.defaultPermissionMode);
  }
  if (Object.hasOwn(record, "approval_mode")) {
    const raw = record.approval_mode;
    delete record.approval_mode;
    if (raw === "auto") {
      notices.push(Object.freeze({
        scope,
        sourcePath,
        field: field ? `${field}.approval_mode` : "approval_mode",
        action: "drop",
      }));
    } else {
      mergeAlias(
        "approval_mode",
        raw === "approve" ? "never" : raw === "prompt" ? "untrusted" : raw,
      );
    }
  }

  for (const [key, child] of Object.entries(record)) {
    migrateLegacyPerToolPermissionAliases(
      child,
      scope,
      sourcePath,
      conflicts,
      notices,
      field ? `${field}.${key}` : key,
    );
  }
}

const TOOL_CONFIG_NON_TOOL_KEYS = new Set([
  "enabled_tools",
  "disabled_tools",
  "web_search_endpoint",
  "web_search_endpoint_kind",
]);

function appendMigratedDisabledTool(
  container: JsonRecord,
  toolName: string,
  field: string,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
): boolean {
  const current = container.disabled_tools;
  if (current === undefined) {
    container.disabled_tools = [toolName];
    return true;
  }
  if (
    !Array.isArray(current) ||
    current.some((entry) => typeof entry !== "string")
  ) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "cannot migrate disabled per-tool setting because disabled_tools is not a string array",
      `${field}.disabled_tools`,
    );
    return false;
  }
  container.disabled_tools = [...new Set([...current, toolName])];
  return true;
}

function canonicalizeLegacyCoreToolNames(
  tools: JsonRecord,
  field: string,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
): void {
  for (const inert of ["view_image", "ViewImage"] as const) {
    if (!Object.hasOwn(tools, inert)) continue;
    delete tools[inert];
    notices.push(Object.freeze({
      scope,
      sourcePath,
      field: `${field}.${inert}`,
      action: "drop",
    }));
  }

  if (!Object.hasOwn(tools, "web_search")) return;
  const legacy = tools.web_search;
  if (
    Object.hasOwn(tools, "WebSearch") &&
    stableJson(tools.WebSearch) !== stableJson(legacy)
  ) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "legacy web_search tool setting conflicts with canonical WebSearch",
      `${field}.web_search`,
    );
  } else if (!Object.hasOwn(tools, "WebSearch")) {
    tools.WebSearch = cloneJsonValue(legacy);
  }
  delete tools.web_search;
  notices.push(Object.freeze({
    scope,
    sourcePath,
    field: `${field}.web_search`,
    action: "migrate",
    target: `${field}.WebSearch`,
  }));
}

function migratePerToolEnablementMap(
  tools: JsonRecord,
  listContainer: JsonRecord,
  field: string,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
  canonicalizeCoreNames = false,
  listField = field,
): void {
  if (canonicalizeCoreNames) {
    canonicalizeLegacyCoreToolNames(
      tools,
      field,
      scope,
      sourcePath,
      conflicts,
      notices,
    );
  }

  for (const [toolName, raw] of Object.entries(tools)) {
    if (canonicalizeCoreNames && TOOL_CONFIG_NON_TOOL_KEYS.has(toolName)) {
      continue;
    }
    const toolField = `${field}.${toolName}`;
    if (typeof raw === "boolean") {
      delete tools[toolName];
      if (raw === false) {
        appendMigratedDisabledTool(
          listContainer,
          toolName,
          listField,
          scope,
          sourcePath,
          conflicts,
        );
      }
      notices.push(Object.freeze({
        scope,
        sourcePath,
        field: toolField,
        action: raw === false ? "migrate" : "drop",
        ...(raw === false ? { target: `${listField}.disabled_tools` } : {}),
      }));
      continue;
    }
    if (!isPlainRecord(raw) || !Object.hasOwn(raw, "enabled")) continue;
    if (typeof raw.enabled !== "boolean") continue;
    const enabled = raw.enabled;
    delete raw.enabled;
    if (enabled === false) {
      appendMigratedDisabledTool(
        listContainer,
        toolName,
        listField,
        scope,
        sourcePath,
        conflicts,
      );
    }
    notices.push(Object.freeze({
      scope,
      sourcePath,
      field: `${toolField}.enabled`,
      action: enabled === false ? "migrate" : "drop",
      ...(enabled === false
        ? { target: `${listField}.disabled_tools` }
        : {}),
    }));
    if (Object.keys(raw).length === 0) delete tools[toolName];
  }
}

function migrateLegacyPerToolEnablement(
  config: JsonRecord,
  scope: ConfigMigrationScope,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
): void {
  const migrateCore = (value: unknown, field: string): void => {
    if (!isPlainRecord(value)) return;
    migratePerToolEnablementMap(
      value,
      value,
      field,
      scope,
      sourcePath,
      conflicts,
      notices,
      true,
    );
  };
  migrateCore(config.tools_config, "tools_config");
  if (isPlainRecord(config.profiles)) {
    for (const [profileName, profile] of Object.entries(config.profiles)) {
      if (!isPlainRecord(profile)) continue;
      migrateCore(
        profile.tools_config,
        `profiles.${profileName}.tools_config`,
      );
    }
  }

  const migrateMcpServers = (value: unknown, field: string): void => {
    if (!isPlainRecord(value)) return;
    for (const [serverName, server] of Object.entries(value)) {
      if (!isPlainRecord(server) || !isPlainRecord(server.tools)) continue;
      migratePerToolEnablementMap(
        server.tools,
        server,
        `${field}.${serverName}.tools`,
        scope,
        sourcePath,
        conflicts,
        notices,
        false,
        `${field}.${serverName}`,
      );
    }
  };
  migrateMcpServers(config.mcp_servers, "mcp_servers");

  if (!isPlainRecord(config.plugins) || !isPlainRecord(config.plugins.plugins)) {
    return;
  }
  for (const [pluginName, plugin] of Object.entries(config.plugins.plugins)) {
    if (!isPlainRecord(plugin)) continue;
    migrateMcpServers(
      plugin.mcp_servers,
      `plugins.plugins.${pluginName}.mcp_servers`,
    );
  }
}

type MappedSettingsConfigValue = {
  readonly target: string;
  readonly value: unknown;
};

function mapSettingsConfigValue(
  field: string,
  value: unknown,
): readonly MappedSettingsConfigValue[] | null {
  if (field === "permissions" && isPlainRecord(value)) {
    const permissions = cloneRecord(value);
    const mapped: MappedSettingsConfigValue[] = [];
    if (permissions.default_mode !== undefined) {
      if (
        typeof permissions.default_mode !== "string" ||
        !["untrusted", "on-failure", "on-request", "never"].includes(
          permissions.default_mode,
        )
      ) return null;
      mapped.push({ target: "approval_policy", value: permissions.default_mode });
      delete permissions.default_mode;
    }
    let bypassPolicy = permissions.bypassPermissionsMode;
    if (
      bypassPolicy !== undefined &&
      bypassPolicy !== "allow" &&
      bypassPolicy !== "disable"
    ) return null;
    if (permissions.disableBypassPermissionsMode !== undefined) {
      if (permissions.disableBypassPermissionsMode !== "disable") return null;
      if (bypassPolicy !== undefined && bypassPolicy !== "disable") return null;
      bypassPolicy = "disable";
      delete permissions.disableBypassPermissionsMode;
    }
    if (permissions.allowBypassPermissionsMode !== undefined) {
      if (typeof permissions.allowBypassPermissionsMode !== "boolean") return null;
      if (permissions.allowBypassPermissionsMode) {
        if (bypassPolicy !== undefined && bypassPolicy !== "allow") return null;
        bypassPolicy = "allow";
      }
      delete permissions.allowBypassPermissionsMode;
    }
    if (bypassPolicy !== undefined) {
      permissions.bypassPermissionsMode = bypassPolicy;
    }
    if (permissions.disableAutoMode !== undefined) {
      if (permissions.disableAutoMode !== "disable") return null;
      mapped.push({ target: "disableAutoMode", value: "disable" });
      delete permissions.disableAutoMode;
    }
    if (permissions.allowManagedPermissionRulesOnly !== undefined) {
      if (typeof permissions.allowManagedPermissionRulesOnly !== "boolean") return null;
      mapped.push({
        target: "allowManagedPermissionRulesOnly",
        value: permissions.allowManagedPermissionRulesOnly,
      });
      delete permissions.allowManagedPermissionRulesOnly;
    }
    if (Object.keys(permissions).length > 0) {
      mapped.push({ target: "permissions", value: permissions });
    }
    return mapped;
  }
  if (field === "sandbox" && isPlainRecord(value)) {
    const sandbox = cloneRecord(value);
    let mode: unknown;
    if (sandbox.enabled !== undefined) {
      if (typeof sandbox.enabled !== "boolean") return null;
      mode = sandbox.enabled ? "workspace-write" : "danger-full-access";
      delete sandbox.enabled;
    }
    if (sandbox.mode !== undefined) {
      const nestedMode = sandbox.mode === "off"
        ? "danger-full-access"
        : sandbox.mode;
      if (
        nestedMode !== "read-only" &&
        nestedMode !== "workspace-write" &&
        nestedMode !== "danger-full-access"
      ) return null;
      if (mode !== undefined && mode !== nestedMode) return null;
      mode = nestedMode;
      delete sandbox.mode;
    }
    return [
      ...(mode !== undefined ? [{ target: "sandbox_mode", value: mode }] : []),
      ...(Object.keys(sandbox).length > 0
        ? [{ target: "sandbox", value: sandbox }]
        : []),
    ];
  }
  if (field === "env") {
    return isPlainRecord(value)
      ? [{ target: "shell_environment_policy", value: { set: value } }]
      : null;
  }
  if (field === "xaaIdp") {
    if (!isPlainRecord(value)) return null;
    const unknown = Object.keys(value).filter(
      (key) => !["issuer", "clientId", "callbackPort"].includes(key),
    );
    if (
      unknown.length > 0 ||
      typeof value.issuer !== "string" ||
      typeof value.clientId !== "string" ||
      (value.callbackPort !== undefined &&
        (!Number.isInteger(value.callbackPort) ||
          (value.callbackPort as number) <= 0 ||
          (value.callbackPort as number) > 65_535))
    ) return null;
    return [{
      target: "xaa_idp",
      value: {
        issuer: value.issuer,
        client_id: value.clientId,
        ...(value.callbackPort !== undefined
          ? { callback_port: value.callbackPort }
          : {}),
      },
    }];
  }
  if (field === "enabledPlugins" && isPlainRecord(value)) {
    return [{ target: "plugins", value: { plugins: value } }];
  }
  if (field === "effortLevel") {
    const effort = value === "max"
      ? "xhigh"
      : value === "minimal"
        ? "low"
        : value;
    return effort === "low" || effort === "medium" ||
        effort === "high" || effort === "xhigh"
      ? [{ target: "reasoning_effort", value: effort }]
      : null;
  }
  if (field === "autoMode") {
    const autoMode = normalizeLegacyAutoModeValue(value);
    return autoMode === null ? null : [{ target: "autoMode", value: autoMode }];
  }
  return [{ target: field, value }];
}

function stateBucket(
  state: JsonRecord,
): JsonRecord {
  const global = isPlainRecord(state.global)
    ? state.global
    : (state.global = {} as JsonRecord);
  return global as JsonRecord;
}

const RETIRED_BYPASS_CONSENT_FIELD = "bypassPermissionsModeAcceptedIn";
const RETIRED_FAST_MODE_OPT_IN_FIELD = "fastModePerSessionOptIn";
const BYPASS_CONSENT_STATE_TARGET =
  "state.global.permissions.bypassPermissionsAcceptedByCwd";

function migrateRetiredBypassConsent(
  value: unknown,
  state: JsonRecord,
  context: {
    readonly scope: ConfigMigrationScope;
    readonly sourcePath: string;
    readonly field: string;
    readonly conflicts: ConfigMigrationConflict[];
    readonly notices: ConfigMigrationNotice[];
  },
): void {
  if (!Array.isArray(value)) {
    pushConflict(
      context.conflicts,
      context.scope,
      context.sourcePath,
      "retired bypass consent must be a string array",
      context.field,
    );
    return;
  }

  const acceptedByCwd: JsonRecord = {};
  let valid = true;
  for (const [index, rawCwd] of value.entries()) {
    const indexedField = `${context.field}[${index}]`;
    if (typeof rawCwd !== "string") {
      pushConflict(
        context.conflicts,
        context.scope,
        context.sourcePath,
        "retired bypass consent cwd must be a string",
        indexedField,
      );
      valid = false;
      continue;
    }
    if (!isAbsolute(rawCwd) || resolve(rawCwd) !== rawCwd) {
      pushConflict(
        context.conflicts,
        context.scope,
        context.sourcePath,
        "retired bypass consent cwd must be absolute and normalized",
        indexedField,
      );
      valid = false;
      continue;
    }
    const resolved = resolveCanonicalSessionCwd(rawCwd);
    if (resolved.kind !== "ok") {
      pushConflict(
        context.conflicts,
        context.scope,
        context.sourcePath,
        resolved.kind === "identity_unsupported"
          ? "retired bypass consent cwd is on a filesystem without stable directory identity"
          : "retired bypass consent cwd does not resolve to a stable existing directory",
        indexedField,
      );
      valid = false;
      continue;
    }
    acceptedByCwd[resolved.cwd] = {
      version: 1,
      canonicalCwd: resolved.cwd,
      dev: resolved.dev.toString(10),
      ino: resolved.ino.toString(10),
    };
  }

  // One malformed entry invalidates the entire retired grant. Migration plans
  // with conflicts never write, but keeping the in-memory transform atomic as
  // well prevents a later caller from accidentally consuming a partial grant.
  if (!valid) return;

  if (Object.keys(acceptedByCwd).length > 0) {
    mergeValue(
      stateBucket(state),
      "permissions",
      { bypassPermissionsAcceptedByCwd: acceptedByCwd },
      {
        scope: context.scope,
        sourcePath: context.sourcePath,
        conflicts: context.conflicts,
      },
    );
  }
  context.notices.push(Object.freeze({
    scope: context.scope,
    sourcePath: context.sourcePath,
    field: context.field,
    action: "migrate",
    target: BYPASS_CONSENT_STATE_TARGET,
  }));
}

/**
 * Explicit migration is the only reader allowed to repair the short-lived
 * canonical state.settings namespace. Ordinary state loading stays strict.
 */
function parseCanonicalStateForMigration(
  text: string,
  path: string,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
): CanonicalStateDocument {
  const parsed = parseCanonicalStateJsonStructure(text, path);
  if (!isPlainRecord(parsed)) {
    return validateCanonicalStateDocument(parsed, path);
  }

  const document = cloneRecord(parsed);
  const rawState = document.state;
  if (!isPlainRecord(rawState)) {
    return validateCanonicalStateDocument(document, path);
  }
  const global = rawState.global;
  if (!isPlainRecord(global) || !Object.hasOwn(global, "settings")) {
    return validateCanonicalStateDocument(document, path);
  }
  const retiredSettings = global.settings;
  if (!isPlainRecord(retiredSettings)) {
    throw new ConfigMigrationError(
      `${path}.state.global.settings must be an object before it can be migrated`,
    );
  }

  const supportedFields = new Set([
    RETIRED_FAST_MODE_OPT_IN_FIELD,
    RETIRED_BYPASS_CONSENT_FIELD,
  ]);
  for (const field of Object.keys(retiredSettings)) {
    if (supportedFields.has(field)) continue;
    pushConflict(
      conflicts,
      "state",
      path,
      "retired canonical settings namespace contains an unsupported field",
      `state.global.settings.${field}`,
    );
  }

  if (Object.hasOwn(retiredSettings, RETIRED_FAST_MODE_OPT_IN_FIELD)) {
    if (typeof retiredSettings[RETIRED_FAST_MODE_OPT_IN_FIELD] !== "boolean") {
      pushConflict(
        conflicts,
        "state",
        path,
        "retired fast-mode per-session opt-in must be a boolean",
        `state.global.settings.${RETIRED_FAST_MODE_OPT_IN_FIELD}`,
      );
    } else {
      notices.push(Object.freeze({
        scope: "state",
        sourcePath: path,
        field: `state.global.settings.${RETIRED_FAST_MODE_OPT_IN_FIELD}`,
        action: "drop",
      }));
    }
  }

  if (Object.hasOwn(retiredSettings, RETIRED_BYPASS_CONSENT_FIELD)) {
    migrateRetiredBypassConsent(
      retiredSettings[RETIRED_BYPASS_CONSENT_FIELD],
      rawState,
      {
        scope: "state",
        sourcePath: path,
        field: `state.global.settings.${RETIRED_BYPASS_CONSENT_FIELD}`,
        conflicts,
        notices,
      },
    );
  }

  delete global.settings;
  return validateCanonicalStateDocument(document, path);
}

function consumeSettings(
  raw: Readonly<JsonRecord>,
  sourcePath: string,
  scope: Exclude<ConfigMigrationScope, "state">,
  config: JsonRecord,
  state: JsonRecord,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
): void {
  for (const [field, value] of Object.entries(raw)) {
    if (field === "pluginConfigs") {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        "retired JSON pluginConfigs cannot be classified as secret or non-secret without the installed manifest schema; reconfigure through /plugin or manually copy only verified non-sensitive values after migration",
        field,
      );
      continue;
    }
    const classification = classifyRetiredField("settings-json", field);
    if (
      field === RETIRED_BYPASS_CONSENT_FIELD &&
      classification.authority === "state"
    ) {
      if (scope !== "user") {
        pushConflict(
          conflicts,
          scope,
          sourcePath,
          "retired bypass consent is user-scoped runtime state and cannot be granted by a project, local, or managed settings file",
          field,
        );
        continue;
      }
      migrateRetiredBypassConsent(value, state, {
        scope: "state",
        sourcePath,
        field,
        conflicts,
        notices,
      });
      continue;
    }
    if (classification.action === "drop") {
      notices.push(Object.freeze({ scope, sourcePath, field, action: "drop" }));
      continue;
    }
    if (classification.authority === "config") {
      const mapped = mapSettingsConfigValue(field, value);
      if (!mapped) {
        pushConflict(
          conflicts,
          scope,
          sourcePath,
          "field has no lossless canonical TOML transform",
          field,
        );
        continue;
      }
      for (const item of mapped) {
        mergeConfigPath(config, item.target, item.value, {
          scope,
          sourcePath,
          conflicts,
        });
      }
      notices.push(Object.freeze({
        scope,
        sourcePath,
        field,
        action: "migrate",
        target: mapped.map((item) => item.target).join(","),
      }));
      continue;
    }
    if (classification.authority === "policy" && scope === "managed") {
      mergeValue(config, field, value, {
        scope,
        sourcePath,
        conflicts,
      });
      notices.push(Object.freeze({
        scope,
        sourcePath,
        field,
        action: "migrate",
        target: field,
      }));
      continue;
    }
    pushConflict(conflicts, scope, sourcePath, classification.note, field);
  }
}

function sanitizeLegacyProjectRuntimeState(
  value: unknown,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
): JsonRecord | null {
  if (!isPlainRecord(value)) {
    pushConflict(
      conflicts,
      "state",
      sourcePath,
      "legacy projects state must be an object",
      "projects",
    );
    return null;
  }
  const projects: JsonRecord = {};
  for (const [projectPath, rawProject] of Object.entries(value)) {
    if (!isPlainRecord(rawProject)) {
      pushConflict(
        conflicts,
        "state",
        sourcePath,
        "legacy project state entry must be an object",
        `projects.${projectPath}`,
      );
      continue;
    }
    const project = cloneRecord(rawProject);
    for (const field of RETIRED_PROJECT_STATE_FIELDS) {
      if (project[field] === undefined) continue;
      delete project[field];
      notices.push(Object.freeze({
        scope: "state",
        sourcePath,
        field: `projects.${projectPath}.${field}`,
        action: "drop",
      }));
    }
    projects[projectPath] = project;
  }
  return projects;
}

function consumeGlobalState(
  raw: Readonly<JsonRecord>,
  sourcePath: string,
  userConfig: JsonRecord,
  state: JsonRecord,
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
): void {
  for (const [field, value] of Object.entries(raw)) {
    const classification = classifyRetiredField("global-state", field);
    if (classification.authority === "config" && classification.target) {
      if (field === "editorMode") {
        if (!mergeLegacyEditorMode(
          userConfig,
          value,
          "user",
          sourcePath,
          conflicts,
        )) continue;
      } else if (field === "env") {
        const mapped = mapSettingsConfigValue(field, value);
        if (!mapped) {
          pushConflict(
            conflicts,
            "user",
            sourcePath,
            "environment injection must be an object",
            field,
          );
          continue;
        }
        for (const item of mapped) {
          mergeConfigPath(userConfig, item.target, item.value, {
            scope: "user",
            sourcePath,
            conflicts,
          });
        }
      } else if (field === "teammateDefaultModel" && value === null) {
        mergeConfigPath(userConfig, classification.target, "inherit", {
          scope: "user",
          sourcePath,
          conflicts,
        });
      } else {
        mergeConfigPath(userConfig, classification.target, value, {
          scope: "user",
          sourcePath,
          conflicts,
        });
      }
      notices.push(Object.freeze({
        scope: "user",
        sourcePath,
        field,
        action: "migrate",
        target: classification.target,
      }));
      continue;
    }
    if (classification.authority === "state") {
      const stateValue = field === "projects"
        ? sanitizeLegacyProjectRuntimeState(
            value,
            sourcePath,
            conflicts,
            notices,
          )
        : value;
      mergeValue(stateBucket(state), field, stateValue, {
        scope: "state",
        sourcePath,
        conflicts,
      });
      notices.push(Object.freeze({
        scope: "state",
        sourcePath,
        field,
        action: "retain",
        target: `state.json:global.${field}`,
      }));
      continue;
    }
    if (classification.action === "drop") {
      notices.push(Object.freeze({ scope: "state", sourcePath, field, action: "drop" }));
      continue;
    }
    pushConflict(conflicts, "state", sourcePath, classification.note, field);
  }
}

async function loadTarget(
  scope: Exclude<ConfigMigrationScope, "state">,
  targetPath: string,
  inputs: ConfigMigrationInput[],
  conflicts: ConfigMigrationConflict[],
  notices: ConfigMigrationNotice[],
): Promise<ScopeAccumulator> {
  const input = await readInput(targetPath);
  if (!input) {
    return { scope, targetPath, raw: { config_version: 2 }, sourcePaths: [], mode: DEFAULT_MODE };
  }
  inputs.push(input.input);
  const parsed = parseTomlStrict(input.text, targetPath, scope, conflicts);
  if (!parsed) {
    return {
      scope,
      targetPath,
      raw: { config_version: 2 },
      sourcePaths: [targetPath],
      originalText: input.text,
      mode: input.mode,
    };
  }
  let raw: JsonRecord;
  if (parsed[CANONICAL_CONFIG_VERSION_KEY] === CANONICAL_CONFIG_VERSION) {
    detectProviderSelectorMigrationConflicts(
      parsed,
      scope,
      targetPath,
      conflicts,
    );
    raw = normalizeExplicitMigrationAliases(
      parsed,
      scope,
      targetPath,
      conflicts,
    );
  } else if (parsed[CANONICAL_CONFIG_VERSION_KEY] !== undefined) {
    pushConflict(
      conflicts,
      scope,
      targetPath,
      `unsupported config_version ${String(parsed[CANONICAL_CONFIG_VERSION_KEY])}`,
      CANONICAL_CONFIG_VERSION_KEY,
    );
    raw = parsed;
  } else {
    raw = convertV1Config(parsed, targetPath, scope, conflicts, notices);
  }
  migrateRetiredLlmXaiProviderConfig(
    raw,
    scope,
    targetPath,
    conflicts,
    notices,
  );
  blockRetiredProviderApiKeyEnv(raw, scope, targetPath, conflicts);
  blockRetiredPlaintextRemoteMcpAuthorization(
    raw,
    scope,
    targetPath,
    conflicts,
  );
  dropRetiredHeartbeatSelectors(raw, scope, targetPath, notices);
  dropRetiredDaemonTransport(raw, scope, targetPath, notices);
  dropRetiredTopLevelConfigFields(raw, scope, targetPath, notices);
  migrateRetiredSandboxWritableRoots(
    raw,
    scope,
    targetPath,
    conflicts,
    notices,
  );
  migrateRetiredProtocolNoOps(raw, scope, targetPath, notices);
  migrateRetiredApprovalsReviewerAlias(raw, scope, targetPath, notices);
  migrateRetiredServiceTierAlias(raw, scope, targetPath, notices);
  migrateRetiredReasoningEffortAlias(raw, scope, targetPath, notices);
  dropRetiredInactiveConfigFields(raw, scope, targetPath, notices);
  return {
    scope,
    targetPath,
    raw,
    sourcePaths: [targetPath],
    originalText: input.text,
    mode: input.mode,
  };
}

async function consumeJsonFile(params: {
  readonly path: string;
  readonly surface: "config-toml-v1" | "settings-json";
  readonly accumulator: ScopeAccumulator;
  readonly state: JsonRecord;
  readonly inputs: ConfigMigrationInput[];
  readonly archivePaths: string[];
  readonly conflicts: ConfigMigrationConflict[];
  readonly notices: ConfigMigrationNotice[];
}): Promise<void> {
  const input = await readInput(params.path);
  if (!input) return;
  params.inputs.push(input.input);
  params.archivePaths.push(params.path);
  const parsed = parseJsonObject(
    input.text,
    params.path,
    params.accumulator.scope,
    params.conflicts,
  );
  if (!parsed) return;
  if (params.surface === "config-toml-v1") {
    const converted = convertV1Config(
      parsed,
      params.path,
      params.accumulator.scope,
      params.conflicts,
      params.notices,
    );
    delete converted[CANONICAL_CONFIG_VERSION_KEY];
    mergeRecord(
      params.accumulator.raw,
      converted,
      params.accumulator.scope,
      params.path,
      params.conflicts,
    );
    return;
  }
  consumeSettings(
    parsed,
    params.path,
    params.accumulator.scope,
    params.accumulator.raw,
    params.state,
    params.conflicts,
    params.notices,
  );
}

/**
 * Convert the retired user keybinding document into the lossless canonical
 * TOML representation. This consumer is reachable only from the explicit
 * migration command; ordinary config loading merely fails closed on presence.
 */
async function consumeRetiredKeybindingsJson(params: {
  readonly path: string;
  readonly accumulator: ScopeAccumulator;
  readonly inputs: ConfigMigrationInput[];
  readonly archivePaths: string[];
  readonly conflicts: ConfigMigrationConflict[];
  readonly notices: ConfigMigrationNotice[];
}): Promise<void> {
  const input = await readInput(params.path);
  if (!input) return;
  params.inputs.push(input.input);
  params.archivePaths.push(params.path);

  const duplicatePaths = duplicateJsonObjectPaths(input.text);
  if (duplicatePaths.length > 0) {
    pushConflict(
      params.conflicts,
      params.accumulator.scope,
      params.path,
      `retired keybinding JSON contains duplicate keys: ${duplicatePaths.join(", ")}`,
      "bindings",
    );
    return;
  }
  const parsed = parseJsonObject(
    input.text,
    params.path,
    params.accumulator.scope,
    params.conflicts,
  );
  if (!parsed) return;

  const supportedRootFields = new Set(["$schema", "$docs", "bindings"]);
  const unknownRootFields = Object.keys(parsed)
    .filter((field) => !supportedRootFields.has(field));
  if (unknownRootFields.length > 0) {
    pushConflict(
      params.conflicts,
      params.accumulator.scope,
      params.path,
      `retired keybinding JSON contains unsupported top-level fields: ${unknownRootFields.join(", ")}`,
    );
    return;
  }
  for (const metadataField of ["$schema", "$docs"] as const) {
    if (!Object.hasOwn(parsed, metadataField)) continue;
    params.notices.push(Object.freeze({
      scope: params.accumulator.scope,
      sourcePath: params.path,
      field: metadataField,
      action: "drop",
      target: "schema-v2 config validation",
    }));
  }
  if (!Array.isArray(parsed.bindings)) {
    pushConflict(
      params.conflicts,
      params.accumulator.scope,
      params.path,
      "retired keybinding JSON must contain a bindings array",
      "bindings",
    );
    return;
  }

  const canonicalBlocks: JsonRecord[] = [];
  for (let index = 0; index < parsed.bindings.length; index += 1) {
    const rawBlock = parsed.bindings[index];
    const blockField = `bindings.${index}`;
    if (!isPlainRecord(rawBlock)) {
      pushConflict(
        params.conflicts,
        params.accumulator.scope,
        params.path,
        "retired keybinding block must be an object",
        blockField,
      );
      return;
    }
    const unknownBlockFields = Object.keys(rawBlock)
      .filter((field) => field !== "context" && field !== "bindings");
    if (unknownBlockFields.length > 0) {
      pushConflict(
        params.conflicts,
        params.accumulator.scope,
        params.path,
        `retired keybinding block contains unsupported fields: ${unknownBlockFields.join(", ")}`,
        blockField,
      );
      return;
    }
    if (!isKeybindingContextName(rawBlock.context)) {
      pushConflict(
        params.conflicts,
        params.accumulator.scope,
        params.path,
        "retired keybinding block has an unsupported context",
        `${blockField}.context`,
      );
      return;
    }
    if (!isPlainRecord(rawBlock.bindings)) {
      pushConflict(
        params.conflicts,
        params.accumulator.scope,
        params.path,
        "retired keybinding block must contain a bindings object",
        `${blockField}.bindings`,
      );
      return;
    }

    const bindings: JsonRecord = {};
    const unbind: string[] = [];
    for (const [chord, action] of Object.entries(rawBlock.bindings)) {
      const field = `${blockField}.bindings.${JSON.stringify(chord)}`;
      const chordError = keybindingChordError(chord);
      if (chordError !== null) {
        pushConflict(
          params.conflicts,
          params.accumulator.scope,
          params.path,
          chordError,
          field,
        );
        return;
      }
      if (action === null) {
        unbind.push(chord);
        continue;
      }
      const actionError = bindingCommandError(action, rawBlock.context);
      if (actionError !== null) {
        pushConflict(
          params.conflicts,
          params.accumulator.scope,
          params.path,
          actionError,
          field,
        );
        return;
      }
      bindings[chord] = action;
    }
    canonicalBlocks.push({
      context: rawBlock.context,
      bindings,
      ...(unbind.length > 0 ? { unbind } : {}),
    });
  }

  try {
    validateStrictConfigDocument({
      [CANONICAL_CONFIG_VERSION_KEY]: CANONICAL_CONFIG_VERSION,
      tui: { keybindings: canonicalBlocks },
    }, params.path);
  } catch (error) {
    pushConflict(
      params.conflicts,
      params.accumulator.scope,
      params.path,
      `retired keybinding JSON has no lossless canonical transform: ${error instanceof Error ? error.message : String(error)}`,
      "tui.keybindings",
    );
    return;
  }
  mergeConfigPath(
    params.accumulator.raw,
    "tui.keybindings",
    canonicalBlocks,
    {
      scope: params.accumulator.scope,
      sourcePath: params.path,
      conflicts: params.conflicts,
    },
  );
  params.notices.push(Object.freeze({
    scope: params.accumulator.scope,
    sourcePath: params.path,
    field: "bindings",
    action: "migrate",
    target: "tui.keybindings",
  }));
}

async function consumeRetiredGatewayJson(params: {
  readonly path: string;
  readonly accumulator: ScopeAccumulator;
  readonly inputs: ConfigMigrationInput[];
  readonly archivePaths: string[];
  readonly conflicts: ConfigMigrationConflict[];
  readonly notices: ConfigMigrationNotice[];
}): Promise<void> {
  const input = await readInput(params.path);
  if (!input) return;
  params.inputs.push(input.input);
  params.archivePaths.push(params.path);
  const parsed = parseJsonObject(
    input.text,
    params.path,
    params.accumulator.scope,
    params.conflicts,
  );
  if (!parsed) return;
  try {
    validateStrictConfigDocument(
      {
        [CANONICAL_CONFIG_VERSION_KEY]: CANONICAL_CONFIG_VERSION,
        gateway: parsed,
      },
      params.path,
    );
  } catch (error) {
    pushConflict(
      params.conflicts,
      params.accumulator.scope,
      params.path,
      `gateway JSON has no lossless canonical TOML transform: ${error instanceof Error ? error.message : String(error)}`,
      "gateway",
    );
    return;
  }
  mergeValue(params.accumulator.raw, "gateway", parsed, {
    scope: params.accumulator.scope,
    sourcePath: params.path,
    conflicts: params.conflicts,
  });
  params.notices.push(Object.freeze({
    scope: params.accumulator.scope,
    sourcePath: params.path,
    field: "gateway",
    action: "migrate",
    target: "gateway",
  }));
}

function convertRetiredMcpServer(
  value: unknown,
  serverName: string,
  scope: Exclude<ConfigMigrationScope, "state">,
  sourcePath: string,
  conflicts: ConfigMigrationConflict[],
): JsonRecord | null {
  if (!isPlainRecord(value)) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "retired MCP server definition must be an object",
      `mcpServers.${serverName}`,
    );
    return null;
  }
  const server = cloneRecord(value);
  const type = server.type;
  delete server.type;
  if (type === undefined || type === "stdio") {
    if (server.url !== undefined) {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        "stdio MCP server cannot carry a URL",
        `mcpServers.${serverName}.url`,
      );
      return null;
    }
    if (server.transport !== undefined && server.transport !== "stdio") {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        "stdio MCP server conflicts with its persisted transport",
        `mcpServers.${serverName}.transport`,
      );
      return null;
    }
    if (typeof server.command !== "string" || server.command.trim().length === 0) {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        "stdio MCP server requires a non-empty command",
        `mcpServers.${serverName}.command`,
      );
      return null;
    }
    server.transport = "stdio";
  } else if (type === "sse" || type === "http" || type === "ws") {
    if (typeof server.url !== "string" || server.url.trim().length === 0) {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        "remote MCP server requires a non-empty URL",
        `mcpServers.${serverName}.url`,
      );
      return null;
    }
    const transport = type === "ws" ? "websocket" : type;
    if (server.transport !== undefined && server.transport !== transport) {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        "remote MCP server type conflicts with its persisted transport",
        `mcpServers.${serverName}.transport`,
      );
      return null;
    }
    if (server.endpoint !== undefined && server.endpoint !== server.url) {
      pushConflict(
        conflicts,
        scope,
        sourcePath,
        "remote MCP server URL conflicts with its persisted endpoint",
        `mcpServers.${serverName}.endpoint`,
      );
      return null;
    }
    server.transport = transport;
    server.endpoint = server.url;
    delete server.url;
  } else {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      "unsupported MCP transport has no canonical persisted representation",
      `mcpServers.${serverName}.type`,
    );
    return null;
  }
  try {
    validateStrictConfigDocument(
      {
        [CANONICAL_CONFIG_VERSION_KEY]: CANONICAL_CONFIG_VERSION,
        mcp_servers: { [serverName]: server },
      },
      sourcePath,
    );
  } catch (error) {
    pushConflict(
      conflicts,
      scope,
      sourcePath,
      `MCP server has no lossless canonical TOML transform: ${error instanceof Error ? error.message : String(error)}`,
      `mcpServers.${serverName}`,
    );
    return null;
  }
  return server;
}

async function consumeRetiredMcpJson(params: {
  readonly path: string;
  readonly accumulator: ScopeAccumulator;
  readonly insideCanonicalScope: boolean;
  readonly inputs: ConfigMigrationInput[];
  readonly archivePaths: string[];
  readonly conflicts: ConfigMigrationConflict[];
  readonly notices: ConfigMigrationNotice[];
}): Promise<void> {
  const input = await readInput(params.path);
  if (!input) return;
  params.inputs.push(input.input);
  if (!params.insideCanonicalScope) {
    pushConflict(
      params.conflicts,
      params.accumulator.scope,
      params.path,
      "retired ancestor .mcp.json is outside the canonical project root; move or remove it explicitly before migration",
      "mcpServers",
    );
    return;
  }
  params.archivePaths.push(params.path);
  const parsed = parseJsonObject(
    input.text,
    params.path,
    params.accumulator.scope,
    params.conflicts,
  );
  if (!parsed) return;
  const unknown = Object.keys(parsed).filter((key) => key !== "mcpServers");
  if (unknown.length > 0) {
    pushConflict(
      params.conflicts,
      params.accumulator.scope,
      params.path,
      `retired MCP JSON contains unsupported top-level fields: ${unknown.sort().join(", ")}`,
    );
  }
  if (!isPlainRecord(parsed.mcpServers)) {
    pushConflict(
      params.conflicts,
      params.accumulator.scope,
      params.path,
      "retired MCP JSON must contain an mcpServers object",
      "mcpServers",
    );
    return;
  }
  const servers: JsonRecord = {};
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    if (name.trim().length === 0) {
      pushConflict(
        params.conflicts,
        params.accumulator.scope,
        params.path,
        "MCP server name must not be empty",
        "mcpServers",
      );
      continue;
    }
    const converted = convertRetiredMcpServer(
      value,
      name,
      params.accumulator.scope,
      params.path,
      params.conflicts,
    );
    if (converted !== null) servers[name] = converted;
  }
  mergeValue(params.accumulator.raw, "mcp_servers", servers, {
    scope: params.accumulator.scope,
    sourcePath: params.path,
    conflicts: params.conflicts,
  });
  params.notices.push(Object.freeze({
    scope: params.accumulator.scope,
    sourcePath: params.path,
    field: "mcpServers",
    action: "migrate",
    target: "mcp_servers",
  }));
}

function migrationEnv(options: ConfigV2MigrationOptions): HomeEnvironment {
  const base = options.env ?? process.env;
  if (options.home === undefined) return base;
  return { ...base, AGENC_HOME: options.home };
}

const RETIRED_AUTH_MIGRATION_ENV_KEYS = Object.freeze([
  "AGENC_REMOTE_TOKEN_DIR",
  "AGENC_SESSION_INGRESS_TOKEN_FILE",
  "PROVIDER_CODE_AUTH_JSON_PATH",
  "PROVIDER_CODE_HOME",
  "PROVIDER_CODE_ACCOUNT_ID",
  "CHATGPT_ACCOUNT_ID",
  "AGENC_ACCOUNT_ID",
  "AGENC_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT",
] as const);

function captureRetiredAuthMigrationEnvironment(
  env: HomeEnvironment,
): RetiredAuthMigrationEnvironment {
  const captured: Record<string, string> = {};
  for (const key of RETIRED_AUTH_MIGRATION_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) captured[key] = value;
  }
  return Object.freeze(captured) as RetiredAuthMigrationEnvironment;
}

function hasRetiredAuthMigration(
  descriptor: RetiredAuthMigrationDescriptor,
): boolean {
  return descriptor.inputs.length > 0 ||
    descriptor.fileActions.length > 0 ||
    descriptor.vaultFields.length > 0 ||
    descriptor.conflicts.length > 0;
}

function secureStorageSourceLockPath(
  identity: SecureStorageMigrationIdentity,
  platformHome: string,
): string {
  // These lock filenames are an on-disk synchronization ABI. Existing and
  // updated binaries must contend on the same path during a migration.
  const serviceHash = sha256(
    process.platform === "win32"
      ? identity.serviceName
      : `${identity.serviceName}\0${identity.accountName}`,
  ).slice(0, 16);
  if (process.platform === "win32") {
    return join(
      dirname(windowsSecureStorageTargetIdentity(identity)),
      `.native-vault-migration-${serviceHash}`,
    );
  }
  // macOS Keychain and Linux Secret Service identities are per-user
  // service/account records, not files under AGENC_HOME. Every relocated home
  // therefore locks the same per-user source identity here.
  return join(
    platformHome,
    ".agenc",
    "migrations",
    "native-vault-locks",
    serviceHash,
  );
}

function readSecureStorageFresh(
  storage: SecureStorage,
): SecureStorageData | null {
  return storage.readFresh === undefined
    ? storage.read()
    : storage.readFresh();
}

export async function checkConfigV2Migration(
  options: ConfigV2MigrationOptions = {},
): Promise<ConfigV2MigrationPlan> {
  const environment = migrationEnv(options);
  const home = resolveMigrationHomeContext(environment, {
    ...(options.platformHome !== undefined ? { platformHome: options.platformHome } : {}),
  });
  const secureStoragePlatformHome = resolve(
    options.platformHome ?? homedir(),
  );
  const cwd = resolve(options.cwd ?? process.cwd());
  const projectRoot = resolve(
    options.projectRoot ?? findProjectRootSync(cwd)?.rootDir ?? cwd,
  );
  const managedConfigPath = resolve(
    options.managedConfigPath ?? resolveManagedConfigPath(environment),
  );
  const managedSettingsPath = resolve(
    options.managedSettingsPath ??
      join(dirname(managedConfigPath), "managed-settings.json"),
  );
  const managedSettingsDropInDir = resolve(
    options.managedSettingsDropInDir ??
      join(dirname(managedSettingsPath), "managed-settings.d"),
  );
  const inputs: ConfigMigrationInput[] = [];
  const conflicts: ConfigMigrationConflict[] = [];
  const notices: ConfigMigrationNotice[] = [];
  const archivePaths: string[] = [];
  const state: JsonRecord = {};
  let credentialMigration: LegacyCredentialMigration | undefined;
  let secureStorageNamespaceMigration: SecureStorageNamespaceMigration | undefined;
  let retiredAuthMigration: RetiredAuthMigrationPlan | undefined;
  const canonicalSecureStorageIdentity = getCanonicalSecureStorageIdentity(home);
  const retiredSecureStorageAccount =
    options.retiredSecureStorageAccount?.trim();
  if (
    options.retiredSecureStorageAccount !== undefined &&
    (
      retiredSecureStorageAccount === undefined ||
      retiredSecureStorageAccount.length === 0 ||
      retiredSecureStorageAccount.length > 1024 ||
      retiredSecureStorageAccount.includes("\0")
    )
  ) {
    throw new ConfigMigrationError(
      "retired native secure storage account override must be a non-empty value of at most 1024 characters without NUL bytes",
    );
  }
  const retiredSecureStorageIdentity = getRetiredSecureStorageIdentity(
    environment,
    secureStoragePlatformHome,
    retiredSecureStorageAccount,
  );
  const rewritesWindowsSecureStorageInPlace =
    process.platform === "win32" &&
    secureStorageIdentitiesDiffer(
      canonicalSecureStorageIdentity,
      retiredSecureStorageIdentity,
    ) &&
    windowsSecureStorageTargetIdentity(canonicalSecureStorageIdentity) ===
      windowsSecureStorageTargetIdentity(retiredSecureStorageIdentity);
  let previewSecureStorage = rewritesWindowsSecureStorageInPlace
    ? {}
    : readNativeSecureStorage(home);
  if (
    secureStorageIdentitiesDiffer(
      canonicalSecureStorageIdentity,
      retiredSecureStorageIdentity,
    )
  ) {
    const sourceLabel =
      `native secure storage ${retiredSecureStorageIdentity.serviceName} at ${retiredSecureStorageIdentity.homePath}`;
    let retiredVault: SecureStorageData | null;
    let retiredSecureStorage: SecureStorage | undefined;
    try {
      retiredSecureStorage = getSecureStorageForMigration(
        home,
        retiredSecureStorageIdentity,
      );
      retiredVault = readSecureStorageFresh(retiredSecureStorage);
    } catch (error) {
      if (rewritesWindowsSecureStorageInPlace) {
        try {
          previewSecureStorage = readNativeSecureStorage(home);
          retiredVault = null;
        } catch (canonicalError) {
          throw new ConfigMigrationError(
            `native secure storage record could not be read with either retired or canonical Windows account identity: ${error instanceof Error ? error.message : String(error)}; ${canonicalError instanceof Error ? canonicalError.message : String(canonicalError)}`,
          );
        }
      } else {
        throw new ConfigMigrationError(
          `retired native secure storage namespace could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (retiredVault !== null && retiredSecureStorage !== undefined) {
      // Historical Keychain/Secret Service names were either unscoped or
      // scoped by only 32 hash bits. Neither proves exclusive ownership: an
      // old default/relocated home or a colliding config directory may still
      // own the same physical record. Windows DPAPI files are home-relative.
      const ambiguousSharedService = process.platform !== "win32";
      const sourceDisposition: SecureStorageNamespaceMigration["sourceDisposition"] =
        rewritesWindowsSecureStorageInPlace
          ? "rewrite-in-place"
          : ambiguousSharedService
          ? options.retireSharedSecureStorage === true
            ? "delete-shared-confirmed"
            : "retain-shared"
          : "delete-retired";
      secureStorageNamespaceMigration = Object.freeze({
        source: retiredSecureStorageIdentity,
        target: canonicalSecureStorageIdentity,
        sourceLockPath: secureStorageSourceLockPath(
          retiredSecureStorageIdentity,
          secureStoragePlatformHome,
        ),
        sourceDisposition,
        sha256: sha256(stableJson(retiredVault)),
        fields: Object.freeze(Object.keys(retiredVault).sort()),
      });
      try {
        previewSecureStorage = mergeLegacyCredentialBlob(
          previewSecureStorage,
          retiredVault,
          sourceLabel,
        ).next;
        notices.push(Object.freeze({
          scope: "state",
          sourcePath: sourceLabel,
          field: "credentials",
          action: "migrate",
          target: sourceDisposition === "retain-shared"
            ? `canonical native secure storage ${canonicalSecureStorageIdentity.serviceName}; retain the shared unscoped source because the default or another relocated home may still own it`
            : sourceDisposition === "rewrite-in-place"
              ? `canonical native secure storage ${canonicalSecureStorageIdentity.serviceName}; atomically re-encrypt the same Windows DPAPI file from the retired account entropy to the OS account identity`
            : `canonical native secure storage ${canonicalSecureStorageIdentity.serviceName}; delete the reviewed retired source after commit`,
        }));
      } catch (error) {
        pushConflict(
          conflicts,
          "state",
          sourceLabel,
          error instanceof Error ? error.message : String(error),
          "credentials",
        );
      }
    }
  }

  const legacyCredentialPath = join(home.path, ".credentials.json");
  const legacyCredentialInput = await readInput(legacyCredentialPath);
  if (legacyCredentialInput) {
    inputs.push(legacyCredentialInput.input);
    try {
      const legacyCredentials = parseLegacyCredentialBlob(
        legacyCredentialInput.text,
        legacyCredentialPath,
      );
      const merged = mergeLegacyCredentialBlob(
        previewSecureStorage,
        legacyCredentials,
        legacyCredentialPath,
      );
      previewSecureStorage = merged.next;
      credentialMigration = Object.freeze({
        sourcePath: legacyCredentialPath,
        sha256: legacyCredentialInput.input.sha256,
      });
      notices.push(Object.freeze({
        scope: "state",
        sourcePath: legacyCredentialPath,
        field: "credentials",
        action: "migrate",
        target: "native secure storage",
      }));
    } catch (error) {
      pushConflict(
        conflicts,
        "state",
        legacyCredentialPath,
        error instanceof Error ? error.message : String(error),
        "credentials",
      );
    }
  }

  const retiredAuthEnvironment = captureRetiredAuthMigrationEnvironment(
    environment,
  );
  const retiredAuthPlatformHome = resolve(
    options.platformHome ??
      environment.HOME ??
      (options.home !== undefined ? dirname(home.path) : homedir()),
  );
  const retiredAuthDiscovery = await discoverRetiredAuthMigration({
    home,
    platformHome: retiredAuthPlatformHome,
    env: retiredAuthEnvironment,
    currentSecureStorage: previewSecureStorage,
  });
  if (hasRetiredAuthMigration(retiredAuthDiscovery.descriptor)) {
    retiredAuthMigration = Object.freeze({
      platformHome: retiredAuthPlatformHome,
      environment: retiredAuthEnvironment,
      descriptor: retiredAuthDiscovery.descriptor,
    });
    for (const input of retiredAuthDiscovery.descriptor.inputs) {
      if (!inputs.some((existing) => existing.path === input.path)) {
        inputs.push(Object.freeze({ path: input.path, sha256: input.sha256 }));
      }
    }
    for (const conflict of retiredAuthDiscovery.descriptor.conflicts) {
      pushConflict(
        conflicts,
        "state",
        conflict.path ?? home.path,
        conflict.reason,
        conflict.field,
      );
    }
    for (const action of retiredAuthDiscovery.descriptor.fileActions) {
      notices.push(Object.freeze({
        scope: "state",
        sourcePath: action.path,
        field: "credentials",
        action: "migrate",
        target: action.kind === "rewrite"
          ? "native secure storage plus metadata-only auth.json"
          : "native secure storage",
      }));
    }
  }

  const existingStateInput = await readInput(home.statePath);
  let existingState: CanonicalStateDocument | null = null;
  if (existingStateInput) {
    inputs.push(existingStateInput.input);
    try {
      existingState = parseCanonicalStateForMigration(
        existingStateInput.text,
        home.statePath,
        conflicts,
        notices,
      );
    } catch (error) {
      pushConflict(
        conflicts,
        "state",
        home.statePath,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (existingState) {
      mergeRecord(state, existingState.state, "state", home.statePath, conflicts);
    }
  }

  const userAccumulator = await loadTarget(
    "user",
    home.configTomlPath,
    inputs,
    conflicts,
    notices,
  );
  const repositoryAccumulators = options.scope === "user" ? null : {
    project: await loadTarget(
      "project",
      join(projectRoot, ".agenc", "config.toml"),
      inputs,
      conflicts,
      notices,
    ),
    local: await loadTarget(
      "local",
      join(projectRoot, ".agenc", "config.local.toml"),
      inputs,
      conflicts,
      notices,
    ),
    managed: await loadTarget(
      "managed",
      managedConfigPath,
      inputs,
      conflicts,
      notices,
    ),
  } as const;
  const accumulators: readonly ScopeAccumulator[] = Object.freeze([
    userAccumulator,
    ...(repositoryAccumulators === null
      ? []
      : [
          repositoryAccumulators.project,
          repositoryAccumulators.local,
          repositoryAccumulators.managed,
        ]),
  ]);
  await consumeJsonFile({
    path: join(home.path, "config.json"),
    surface: "config-toml-v1",
    accumulator: userAccumulator,
    state,
    inputs,
    archivePaths,
    conflicts,
    notices,
  });
  await consumeJsonFile({
    path: join(home.path, "settings.json"),
    surface: "settings-json",
    accumulator: userAccumulator,
    state,
    inputs,
    archivePaths,
    conflicts,
    notices,
  });
  await consumeRetiredKeybindingsJson({
    path: join(home.path, "keybindings.json"),
    accumulator: userAccumulator,
    inputs,
    archivePaths,
    conflicts,
    notices,
  });
  await consumeRetiredGatewayJson({
    path: join(home.path, "gateway", "config.json"),
    accumulator: userAccumulator,
    inputs,
    archivePaths,
    conflicts,
    notices,
  });
  if (repositoryAccumulators !== null) {
    for (const candidate of retiredProjectMcpJsonCandidates(projectRoot, cwd)) {
      await consumeRetiredMcpJson({
        path: candidate.path,
        accumulator: repositoryAccumulators.project,
        insideCanonicalScope: candidate.insideProject,
        inputs,
        archivePaths,
        conflicts,
        notices,
      });
    }
    await consumeJsonFile({
      path: join(projectRoot, ".agenc", "settings.json"),
      surface: "settings-json",
      accumulator: repositoryAccumulators.project,
      state,
      inputs,
      archivePaths,
      conflicts,
      notices,
    });
    await consumeJsonFile({
      path: join(projectRoot, ".agenc", "settings.local.json"),
      surface: "settings-json",
      accumulator: repositoryAccumulators.local,
      state,
      inputs,
      archivePaths,
      conflicts,
      notices,
    });
    await consumeJsonFile({
      path: managedSettingsPath,
      surface: "settings-json",
      accumulator: repositoryAccumulators.managed,
      state,
      inputs,
      archivePaths,
      conflicts,
      notices,
    });
    await consumeRetiredMcpJson({
      path: join(dirname(managedConfigPath), "managed-mcp.json"),
      accumulator: repositoryAccumulators.managed,
      insideCanonicalScope: true,
      inputs,
      archivePaths,
      conflicts,
      notices,
    });
    let managedDropIns: string[] = [];
    try {
      managedDropIns = (await readdir(managedSettingsDropInDir, {
        withFileTypes: true,
      }))
        .filter((entry) =>
          (entry.isFile() || entry.isSymbolicLink()) &&
          entry.name.endsWith(".json") &&
          !entry.name.startsWith("."),
        )
        .map((entry) => join(managedSettingsDropInDir, entry.name))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const path of managedDropIns) {
      await consumeJsonFile({
        path,
        surface: "settings-json",
        accumulator: repositoryAccumulators.managed,
        state,
        inputs,
        archivePaths,
        conflicts,
        notices,
      });
    }
  }

  const uniqueGlobalCandidates = legacyGlobalStateCandidates(
    home,
    options.globalStatePath,
  );
  const existingGlobals: Array<{ readonly path: string; readonly text: string }> = [];
  for (const path of uniqueGlobalCandidates) {
    const input = await readInput(path);
    if (!input) continue;
    inputs.push(input.input);
    existingGlobals.push({ path, text: input.text });
  }
  if (existingGlobals.length > 1) {
    for (const global of existingGlobals) {
      pushConflict(
        conflicts,
        "state",
        global.path,
        "multiple legacy global-state files exist; choose one with --global-state-path",
      );
    }
  } else if (existingGlobals[0]) {
    const global = existingGlobals[0];
    archivePaths.push(global.path);
    const parsed = parseJsonObject(global.text, global.path, "state", conflicts);
    if (parsed) {
      consumeGlobalState(
        parsed,
        global.path,
        userAccumulator.raw,
        state,
        conflicts,
        notices,
      );
    }
  }

  const writes: ConfigMigrationWrite[] = [];
  for (const accumulator of accumulators) {
    dropRetiredDurableResumePolicy(
      accumulator.raw,
      accumulator.scope,
      accumulator.targetPath,
      notices,
    );
    dropRetiredTopLevelConfigFields(
      accumulator.raw,
      accumulator.scope,
      accumulator.targetPath,
      notices,
    );
    migrateRetiredSandboxWritableRoots(
      accumulator.raw,
      accumulator.scope,
      accumulator.targetPath,
      conflicts,
      notices,
    );
    migrateRetiredProtocolNoOps(
      accumulator.raw,
      accumulator.scope,
      accumulator.targetPath,
      notices,
    );
    migrateRetiredApprovalsReviewerAlias(
      accumulator.raw,
      accumulator.scope,
      accumulator.targetPath,
      notices,
    );
    migrateRetiredServiceTierAlias(
      accumulator.raw,
      accumulator.scope,
      accumulator.targetPath,
      notices,
    );
    migrateRetiredReasoningEffortAlias(
      accumulator.raw,
      accumulator.scope,
      accumulator.targetPath,
      notices,
    );
    migrateRetiredPluginEntryFields(
      accumulator.raw,
      accumulator.scope,
      accumulator.targetPath,
      conflicts,
      notices,
    );
    migrateRetiredCleanupPeriodDays(
      accumulator.raw,
      accumulator.scope,
      accumulator.targetPath,
      conflicts,
      notices,
    );
    dropRetiredInactiveConfigFields(
      accumulator.raw,
      accumulator.scope,
      accumulator.targetPath,
      notices,
    );
    migrateRetiredProviderFallbackModels(
      accumulator.raw,
      accumulator.scope,
      accumulator.targetPath,
      conflicts,
      notices,
    );
    migrateLegacyHookEventAliases(
      accumulator.raw,
      accumulator.scope,
      accumulator.targetPath,
      conflicts,
      notices,
    );
    migrateLegacyPerToolPermissionAliases(
      accumulator.raw,
      accumulator.scope,
      accumulator.targetPath,
      conflicts,
      notices,
    );
    migrateLegacyPermissionRuleToolNames(
      accumulator.raw,
      accumulator.scope,
      accumulator.targetPath,
      notices,
    );
    migrateLegacyPerToolEnablement(
      accumulator.raw,
      accumulator.scope,
      accumulator.targetPath,
      conflicts,
      notices,
    );
    accumulator.raw[CANONICAL_CONFIG_VERSION_KEY] = CANONICAL_CONFIG_VERSION;
    try {
      validateStrictConfigDocument(accumulator.raw, accumulator.targetPath);
      const content = serializeConfigToml(accumulator.raw);
      if (
        content !== accumulator.originalText &&
        (accumulator.sourcePaths.length > 0 || Object.keys(accumulator.raw).length > 1)
      ) {
        writes.push(Object.freeze({
          scope: accumulator.scope,
          kind: "config",
          targetPath: accumulator.targetPath,
          content,
          ...(accumulator.originalText !== undefined
            ? { beforeSha256: sha256(accumulator.originalText) }
            : {}),
          afterSha256: sha256(content),
          mode: accumulator.mode,
        }));
      }
    } catch (error) {
      pushConflict(
        conflicts,
        accumulator.scope,
        accumulator.targetPath,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  try {
    const canonicalState = createCanonicalStateDocument(state);
    const stateContent = serializeCanonicalState(canonicalState);
    const originalStateText = existingStateInput?.text;
    if (Object.keys(state).length > 0 && stateContent !== originalStateText) {
      writes.push(Object.freeze({
        scope: "state",
        kind: "state",
        targetPath: home.statePath,
        content: stateContent,
        ...(originalStateText !== undefined
          ? { beforeSha256: sha256(originalStateText) }
          : {}),
        afterSha256: sha256(stateContent),
        mode: CANONICAL_STATE_FILE_MODE,
      }));
    }
  } catch (error) {
    pushConflict(
      conflicts,
      "state",
      home.statePath,
      error instanceof Error ? error.message : String(error),
    );
  }

  const physicalAuthorities = [
    ...accumulators.map((accumulator) => ({
      label: `${accumulator.scope} target`,
      path: accumulator.targetPath,
    })),
    { label: "state target", path: home.statePath },
    ...[...new Set(archivePaths)].map((path) => ({
      label: "retired input",
      path,
    })),
    ...(credentialMigration === undefined
      ? []
      : [{
          label: "retired credential input",
          path: credentialMigration.sourcePath,
        }]),
    ...(retiredAuthMigration?.descriptor.fileActions.map((action) => ({
      label: "retired authentication input",
      path: action.path,
    })) ?? []),
  ];
  const authorityCollisions = await findConfigSourceCollisions(
    physicalAuthorities,
  );
  for (const collision of authorityCollisions) {
    pushConflict(
      conflicts,
      "state",
      collision.second.path,
      `migration authorities ${collision.first.label} (${collision.first.path}) and ${collision.second.label} (${collision.second.path}) resolve to the same physical file (${collision.reason}); migration refuses to assign one file two roles`,
    );
  }

  const requiresRetiredWriterQuiescence =
    credentialMigration !== undefined ||
    (retiredAuthMigration?.descriptor.fileActions.length ?? 0) > 0 ||
    secureStorageNamespaceMigration !== undefined;
  return Object.freeze({
    id: options.id ?? randomUUID(),
    home,
    projectRoot,
    inputs: Object.freeze(inputs),
    writes: Object.freeze(conflicts.length > 0 ? [] : writes),
    archivePaths: Object.freeze([...new Set(archivePaths)]),
    ...(credentialMigration !== undefined ? { credentialMigration } : {}),
    ...(secureStorageNamespaceMigration !== undefined
      ? { secureStorageNamespaceMigration }
      : {}),
    ...(retiredAuthMigration !== undefined ? { retiredAuthMigration } : {}),
    requiresRetiredWriterQuiescence,
    retiredWriterQuiescenceConfirmed:
      options.confirmRetiredWritersStopped === true,
    conflicts: Object.freeze(conflicts),
    notices: Object.freeze(notices),
  });
}

function journalDirectory(home: HomeContext, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
    throw new ConfigMigrationError(`invalid migration id: ${id}`);
  }
  const root = resolve(home.path, "migrations", "config-v2");
  const directory = resolve(root, id);
  if (dirname(directory) !== root) {
    throw new ConfigMigrationError(`invalid migration id: ${id}`);
  }
  return directory;
}

async function secureJournalDirectory(
  home: HomeContext,
  id?: string,
): Promise<string> {
  if (id !== undefined) journalDirectory(home, id);
  try {
    const directory = await ensurePrivateDescendantDirectory(
      home.path,
      id === undefined
        ? ["migrations", "config-v2"]
        : ["migrations", "config-v2", id],
    );
    return directory.canonicalPath;
  } catch (error) {
    throw new ConfigMigrationError(
      error instanceof Error
        ? error.message
        : "migration journal directory could not be secured",
    );
  }
}

function exactObjectKeys(
  value: Readonly<JsonRecord>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function parsePreparationManifest(
  text: string,
  path: string,
  home: HomeContext,
): MigrationPreparationManifest {
  if (duplicateJsonObjectPaths(text).length > 0) {
    throw new ConfigMigrationError(
      `migration preparation manifest contains duplicate object keys: ${path}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ConfigMigrationError(`invalid migration preparation manifest JSON: ${path}`);
  }
  if (
    !isPlainRecord(parsed) ||
    !exactObjectKeys(
      parsed,
      new Set([
        "preparation_version",
        "id",
        "created_at",
        "quarantineToken",
        "artifacts",
      ]),
    ) ||
    parsed.preparation_version !== 1 ||
    typeof parsed.id !== "string" ||
    typeof parsed.created_at !== "string" ||
    (
      parsed.quarantineToken !== undefined &&
      (
        typeof parsed.quarantineToken !== "string" ||
        !MIGRATION_QUARANTINE_TOKEN_PATTERN.test(parsed.quarantineToken)
      )
    ) ||
    !Array.isArray(parsed.artifacts)
  ) {
    throw new ConfigMigrationError(`invalid migration preparation manifest: ${path}`);
  }
  journalDirectory(home, parsed.id);
  if (parsed.id !== dirname(path).split(/[\\/]/u).at(-1)) {
    throw new ConfigMigrationError(`migration preparation manifest id mismatch: ${path}`);
  }
  const hashPattern = /^[a-f0-9]{64}$/u;
  const manifestDirectory = dirname(path);
  const quarantineToken = typeof parsed.quarantineToken === "string"
    ? parsed.quarantineToken
    : historicalJournalQuarantineToken(path, parsed.id);
  const artifacts: PreparationArtifact[] = [];
  for (const raw of parsed.artifacts) {
    if (
      !isPlainRecord(raw) ||
      !exactObjectKeys(
        raw,
        new Set([
          "kind",
          "path",
          "quarantinePath",
          "ownerPath",
          "sha256",
          "writeIndex",
        ]),
      ) ||
      (raw.kind !== "backup" &&
        raw.kind !== "credential-stage" &&
        raw.kind !== "write-stage") ||
      typeof raw.path !== "string" ||
      !isAbsolute(raw.path) ||
      (
        raw.quarantinePath !== undefined &&
        (
          typeof raw.quarantinePath !== "string" ||
          raw.quarantinePath !==
            migrationQuarantinePath(raw.path, quarantineToken, "artifact")
        )
      ) ||
      typeof raw.ownerPath !== "string" ||
      !isAbsolute(raw.ownerPath) ||
      typeof raw.sha256 !== "string" ||
      !hashPattern.test(raw.sha256)
    ) {
      throw new ConfigMigrationError(`invalid migration preparation artifact: ${path}`);
    }
    if (raw.kind === "backup") {
      if (
        !Number.isInteger(raw.writeIndex) ||
        (raw.writeIndex as number) < 0 ||
        raw.path !== join(manifestDirectory, `target-${String(raw.writeIndex)}.bak`)
      ) {
        throw new ConfigMigrationError(`invalid migration preparation backup: ${path}`);
      }
    } else if (
      raw.writeIndex !== undefined ||
      raw.path !== `${raw.ownerPath}.migrate-v2-${parsed.id}${
        raw.kind === "credential-stage" ? ".credential" : ""
      }.tmp`
    ) {
      throw new ConfigMigrationError(`invalid migration preparation stage: ${path}`);
    }
    artifacts.push(Object.freeze({
      kind: raw.kind,
      path: raw.path,
      quarantinePath: typeof raw.quarantinePath === "string"
        ? raw.quarantinePath
        : migrationQuarantinePath(raw.path, quarantineToken, "artifact"),
      ownerPath: raw.ownerPath,
      sha256: raw.sha256,
      ...(raw.kind === "backup"
        ? { writeIndex: raw.writeIndex as number }
        : {}),
    }));
  }
  if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) {
    throw new ConfigMigrationError(`duplicate migration preparation artifact: ${path}`);
  }
  return Object.freeze({
    preparation_version: 1,
    id: parsed.id,
    created_at: parsed.created_at,
    quarantineToken,
    artifacts: Object.freeze(artifacts),
  });
}

interface ExclusiveMigrationPublicationOutcome
  extends MigrationPublicationOutcome {
  /** Verified target snapshot, or null when post-link verification failed. */
  readonly published: StableFileSnapshot | null;
}

function requireCleanExclusiveMigrationPublication(
  outcome: ExclusiveMigrationPublicationOutcome,
  path: string,
): StableFileSnapshot {
  const [primary, ...secondary] = outcome.postPublicationErrors;
  if (primary !== undefined) {
    attachMigrationCleanupErrors(primary, secondary);
    throw primary;
  }
  if (outcome.published === null) {
    throw new ConfigMigrationError(
      `exclusive publication committed without a verified target snapshot: ${path}`,
    );
  }
  return outcome.published;
}

async function writeExclusiveAtomic(
  path: string,
  content: string,
  mode: number,
): Promise<ExclusiveMigrationPublicationOutcome> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let temporarySnapshot: StableFileSnapshot | null = null;
  let committed = false;
  let published: StableFileSnapshot | null = null;
  let primaryFailure: unknown;
  const cleanupErrors: Error[] = [];
  const postPublicationErrors: Error[] = [];
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode, flag: "wx" });
    await fsyncPath(temporaryPath);
    temporarySnapshot = await readMigrationFile(temporaryPath);
    if (
      temporarySnapshot === null ||
      sha256(temporarySnapshot.bytes) !== sha256(content)
    ) {
      throw new ConfigMigrationError(
        `exclusive publication stage changed while it was written: ${temporaryPath}`,
      );
    }
    await link(temporaryPath, path);
    committed = true;
    try {
      const candidate = await readMigrationFile(path);
      if (
        candidate === null ||
        !sameStableFileIdentity(candidate, temporarySnapshot)
      ) {
        throw new ConfigMigrationError(
          `exclusive publication target does not match its stage: ${path}`,
        );
      }
      published = candidate;
    } catch (error) {
      postPublicationErrors.push(asMigrationPublicationError(error));
    }
    await fsyncPath(dirname(path)).catch(() => undefined);
  } catch (error) {
    primaryFailure = error;
  }

  if (temporarySnapshot !== null && (!committed || published !== null)) {
    try {
      await removePreparedArtifactIfUnchanged(
        temporaryPath,
        temporarySnapshot,
        publicationTempQuarantinePath(temporaryPath),
      );
    } catch (error) {
      if (committed) {
        postPublicationErrors.push(asMigrationPublicationError(error));
      } else {
        cleanupErrors.push(asMigrationPublicationError(error));
      }
    }
  }
  if (primaryFailure !== undefined) {
    attachMigrationCleanupErrors(primaryFailure, cleanupErrors);
    throw primaryFailure;
  }
  if (!committed) {
    const failure = new ConfigMigrationError(
      `exclusive publication did not reach its commit point: ${path}`,
    );
    attachMigrationCleanupErrors(failure, cleanupErrors);
    throw failure;
  }
  postPublicationErrors.push(...cleanupErrors);
  return Object.freeze({
    committed: true,
    published,
    postPublicationErrors: Object.freeze(postPublicationErrors),
  });
}

async function writePreparationManifest(
  path: string,
  manifest: MigrationPreparationManifest,
): Promise<ExclusiveMigrationPublicationOutcome> {
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  return writeExclusiveAtomic(path, content, DEFAULT_MODE);
}

async function recoverPublicationTemps(directory: string): Promise<void> {
  const listing = await readStableDirectory(directory);
  if (listing === null) return;
  const publicationTempPattern = /^(?:journal|preparation)\.json\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.agenc-migration-publication-quarantine)?$/iu;
  for (const entry of listing.entries) {
    if (!publicationTempPattern.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ConfigMigrationError(
        `migration journal contains a symbolic-link publication stage: ${path}`,
      );
    }
    const snapshot = await readMigrationFile(path);
    if (snapshot === null) continue;
    if (path.endsWith(".agenc-migration-publication-quarantine")) {
      await discardQuarantinedMigrationFile(
        Object.freeze({
          path,
          snapshot,
          originalPath: path.slice(
            0,
            -".agenc-migration-publication-quarantine".length,
          ),
        }),
        "interrupted migration journal publication recovery",
      );
    } else {
      await removeUnchangedMigrationFile(
        path,
        snapshot,
        "interrupted migration journal publication recovery",
        publicationTempQuarantinePath(path),
      );
    }
  }
}

async function controlFileQuarantines(
  path: string,
  role: "journal" | "manifest",
): Promise<readonly StableFileSnapshot[]> {
  const listing = await readStableDirectory(dirname(path));
  if (listing === null) return Object.freeze([]);
  const prefix = `${basename(path)}${MIGRATION_QUARANTINE_MARKER}`;
  const suffix = `-${role}`;
  const snapshots: StableFileSnapshot[] = [];
  for (const entry of listing.entries) {
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) continue;
    const token = entry.name.slice(prefix.length, -suffix.length);
    if (!MIGRATION_QUARANTINE_TOKEN_PATTERN.test(token)) continue;
    const quarantinePath = join(dirname(path), entry.name);
    if (entry.isSymbolicLink()) {
      throw new ConfigMigrationError(
        `migration control-file quarantine is a symbolic link: ${quarantinePath}`,
      );
    }
    const snapshot = await readMigrationFile(quarantinePath);
    if (snapshot !== null) snapshots.push(snapshot);
  }
  return Object.freeze(snapshots);
}

function comparableJournalShape(journal: MigrationJournal): unknown {
  const credential = journal.credential === undefined
    ? undefined
    : {
        ...journal.credential,
        canonicalSha256: undefined,
      };
  return {
    journal_version: journal.journal_version,
    id: journal.id,
    created_at: journal.created_at,
    quarantineToken: journal.quarantineToken,
    writes: journal.writes,
    archives: journal.archives,
    credential,
  };
}

async function recoverControlFileQuarantine(
  path: string,
  role: "journal" | "manifest",
  home: HomeContext,
): Promise<void> {
  const quarantines = await controlFileQuarantines(path, role);
  if (quarantines.length === 0) return;
  if (quarantines.length !== 1) {
    throw new ConfigMigrationError(
      `migration ${role} has multiple quarantined revisions; manual recovery is required: ${path}`,
    );
  }
  const quarantined = quarantines[0]!;
  const current = await readMigrationFile(path);
  if (current === null) {
    await restoreQuarantinedMigrationFile(
      Object.freeze({
        path: quarantined.path,
        snapshot: quarantined,
        originalPath: path,
      }),
      `interrupted migration ${role} publication recovery`,
    );
    return;
  }
  if (role === "manifest") {
    const currentManifest = parsePreparationManifest(
      current.bytes.toString("utf8"),
      path,
      home,
    );
    const quarantinedManifest = parsePreparationManifest(
      quarantined.bytes.toString("utf8"),
      path,
      home,
    );
    if (
      stableJson(currentManifest) !== stableJson(quarantinedManifest) ||
      !await samePhysicalMigrationFile(path, quarantined.path)
    ) {
      throw new ConfigMigrationError(
        `migration preparation manifest reappeared with a different revision; recover the validated copy at ${quarantined.path}`,
      );
    }
  } else {
    const currentJournal = parseJournalText(current.bytes.toString("utf8"), path);
    const quarantinedJournal = parseJournalText(
      quarantined.bytes.toString("utf8"),
      path,
    );
    if (
      stableJson(comparableJournalShape(currentJournal)) !==
        stableJson(comparableJournalShape(quarantinedJournal))
    ) {
      throw new ConfigMigrationError(
        `migration journal replacement does not match its quarantined transaction; recover the validated copy at ${quarantined.path}`,
      );
    }
  }
  await discardQuarantinedMigrationFile(
    Object.freeze({
      path: quarantined.path,
      snapshot: quarantined,
      originalPath: path,
    }),
    `interrupted migration ${role} publication recovery`,
  );
}

async function recoverInterruptedPreparations(home: HomeContext): Promise<void> {
  const root = await secureJournalDirectory(home);
  const listing = await readStableDirectory(root);
  if (listing === null) return;
  const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
  for (const entry of listing.entries) {
    if (!idPattern.test(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      throw new ConfigMigrationError(
        `migration journal root contains a symbolic-link transaction directory: ${join(root, entry.name)}`,
      );
    }
    if (!entry.isDirectory()) continue;
    const directory = await secureJournalDirectory(home, entry.name);
    await recoverPublicationTemps(directory);
    const manifestPath = join(directory, PREPARATION_MANIFEST_NAME);
    const journalPath = join(directory, "journal.json");
    await recoverControlFileQuarantine(journalPath, "journal", home);
    await recoverControlFileQuarantine(manifestPath, "manifest", home);
    const manifestSnapshot = await readMigrationFile(manifestPath);
    if (manifestSnapshot === null) continue;
    const manifest = parsePreparationManifest(
      manifestSnapshot.bytes.toString("utf8"),
      manifestPath,
      home,
    );
    const journalSnapshot = await readMigrationFile(journalPath);
    let retainBackups = false;
    if (journalSnapshot !== null) {
      const journal = parseJournalText(
        journalSnapshot.bytes.toString("utf8"),
        journalPath,
      );
      if (journal.status !== "complete" && journal.status !== "rolled-back") {
        throw new ConfigMigrationError(
          `migration ${entry.name} was interrupted after its journal was published; run config migrate rollback ${entry.name} before another apply`,
        );
      }
      retainBackups = journal.status === "complete";
    }
    for (const artifact of manifest.artifacts) {
      if (retainBackups && artifact.kind === "backup") continue;
      const snapshot = await readMigrationFile(artifact.path);
      if (snapshot === null) {
        const quarantined = await readMigrationFile(artifact.quarantinePath);
        if (quarantined === null) continue;
        if (sha256(quarantined.bytes) !== artifact.sha256) {
          throw new ConfigMigrationError(
            `interrupted migration preparation quarantine changed outside migration: ${artifact.quarantinePath}`,
          );
        }
        await discardQuarantinedMigrationFile(
          Object.freeze({
            path: artifact.quarantinePath,
            snapshot: quarantined,
            originalPath: artifact.path,
          }),
          "interrupted migration preparation recovery",
        );
        continue;
      }
      if (sha256(snapshot.bytes) !== artifact.sha256) {
        throw new ConfigMigrationError(
          `interrupted migration preparation artifact changed outside migration: ${artifact.path}`,
        );
      }
      await removeUnchangedMigrationFile(
        artifact.path,
        snapshot,
        "interrupted migration preparation recovery",
        artifact.quarantinePath,
      );
    }
    const currentManifest = await readMigrationFile(manifestPath);
    if (
      currentManifest === null ||
      sha256(currentManifest.bytes) !== sha256(manifestSnapshot.bytes)
    ) {
      throw new ConfigMigrationError(
        `migration preparation manifest changed during recovery: ${manifestPath}`,
      );
    }
    await removeUnchangedMigrationFile(
      manifestPath,
      currentManifest,
      "migration preparation manifest recovery",
      migrationQuarantinePath(
        manifestPath,
        manifest.quarantineToken,
        "manifest",
      ),
    );
  }
}

async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  let syncFailed = false;
  let syncFailure: unknown;
  try {
    await handle.sync();
  } catch (error) {
    syncFailed = true;
    syncFailure = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (closeError) {
      if (syncFailed) {
        attachMigrationCleanupErrors(syncFailure, [
          asMigrationPublicationError(closeError),
        ]);
      } else {
        throw closeError;
      }
    }
  }
}

interface MigrationPublicationOutcome {
  readonly committed: true;
  readonly postPublicationErrors: readonly Error[];
}

function asMigrationPublicationError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function attachMigrationCleanupErrors(
  primary: unknown,
  cleanupErrors: readonly Error[],
): void {
  if (cleanupErrors.length === 0) return;
  try {
    if (
      primary !== null &&
      (typeof primary === "object" || typeof primary === "function") &&
      Object.isExtensible(primary)
    ) {
      Object.defineProperty(primary, "cleanupErrors", {
        configurable: true,
        value: Object.freeze([...cleanupErrors]),
      });
    }
  } catch {
    // Keep the exact primary publication failure authoritative.
  }
}

async function writeAtomic(
  path: string,
  content: string,
  mode: number,
  quarantineToken: string,
): Promise<MigrationPublicationOutcome> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const targetSnapshot = await readMigrationFile(path);
  if (targetSnapshot === null) {
    throw new ConfigMigrationError(
      `atomic journal publication refuses a missing destination: ${path}`,
    );
  }
  let temporarySnapshot: StableFileSnapshot | null = null;
  let stageQuarantined: QuarantinedMigrationFile | null = null;
  let targetQuarantined: QuarantinedMigrationFile | null = null;
  let committed = false;
  let primaryFailure: unknown;
  const cleanupErrors: Error[] = [];
  const postPublicationErrors: Error[] = [];
  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode, flag: "wx" });
    await fsyncPath(tempPath);
    temporarySnapshot = await readMigrationFile(tempPath);
    if (
      temporarySnapshot === null ||
      sha256(temporarySnapshot.bytes) !== sha256(content)
    ) {
      throw new ConfigMigrationError(
        `atomic publication stage changed while it was written: ${tempPath}`,
      );
    }
    stageQuarantined = await quarantineExpectedMigrationFile(
      tempPath,
      temporarySnapshot,
      "atomic journal publication",
      publicationTempQuarantinePath(tempPath),
    );
    try {
      targetQuarantined = await quarantineExpectedMigrationFile(
        path,
        targetSnapshot,
        "atomic journal publication",
        migrationQuarantinePath(path, quarantineToken, "journal"),
      );
    } catch (error) {
      try {
        await restoreQuarantinedMigrationFile(
          stageQuarantined,
          "atomic journal publication",
        );
        stageQuarantined = null;
      } catch (restoreError) {
        cleanupErrors.push(asMigrationPublicationError(restoreError));
      }
      throw error;
    }
    try {
      await link(stageQuarantined.path, path);
      committed = true;
    } catch (error) {
      const publicationError = (error as NodeJS.ErrnoException).code === "EEXIST"
        ? new ConfigMigrationError(
            `atomic journal publication refuses to overwrite a path that appeared: ${path}`,
          )
        : error;
      for (const quarantined of [targetQuarantined, stageQuarantined]) {
        if (quarantined === null) continue;
        try {
          await restoreQuarantinedMigrationFile(
            quarantined,
            "atomic journal publication",
          );
          if (quarantined === targetQuarantined) targetQuarantined = null;
          if (quarantined === stageQuarantined) stageQuarantined = null;
        } catch (restoreError) {
          cleanupErrors.push(asMigrationPublicationError(restoreError));
        }
      }
      throw publicationError;
    }

    // link() is the journal commit point. Every failure below is diagnostic;
    // callers must observe the completed journal outcome exactly once.
    try {
      const published = await readMigrationFile(path);
      if (
        published === null ||
        !sameStableFileIdentity(published, temporarySnapshot)
      ) {
        postPublicationErrors.push(new ConfigMigrationError(
          `committed migration journal no longer matches its publication stage: ${path}`,
        ));
      }
    } catch (error) {
      postPublicationErrors.push(asMigrationPublicationError(error));
    }
    try {
      await fsyncPath(dirname(path));
    } catch (error) {
      postPublicationErrors.push(asMigrationPublicationError(error));
    }
    try {
      if (await readMigrationFile(tempPath) !== null) {
        postPublicationErrors.push(new ConfigMigrationError(
          `migration journal stage reappeared after publication and was preserved: ${tempPath}`,
        ));
      }
    } catch (error) {
      postPublicationErrors.push(asMigrationPublicationError(error));
    }
    for (const quarantined of [stageQuarantined, targetQuarantined]) {
      if (quarantined === null) continue;
      try {
        await discardQuarantinedMigrationFile(
          quarantined,
          "atomic journal publication",
        );
        if (quarantined === stageQuarantined) stageQuarantined = null;
        if (quarantined === targetQuarantined) targetQuarantined = null;
      } catch (error) {
        postPublicationErrors.push(asMigrationPublicationError(error));
      }
    }
  } catch (error) {
    primaryFailure = error;
  }

  if (!committed && temporarySnapshot !== null) {
    try {
      await removePreparedArtifactIfUnchanged(
        tempPath,
        temporarySnapshot,
        publicationTempQuarantinePath(tempPath),
      );
    } catch (error) {
      cleanupErrors.push(asMigrationPublicationError(error));
    }
  }
  if (primaryFailure !== undefined) {
    attachMigrationCleanupErrors(primaryFailure, cleanupErrors);
    throw primaryFailure;
  }
  if (!committed) {
    const failure = new ConfigMigrationError(
      `migration journal publication did not reach its commit point: ${path}`,
    );
    attachMigrationCleanupErrors(failure, cleanupErrors);
    throw failure;
  }
  postPublicationErrors.push(...cleanupErrors);
  return Object.freeze({
    committed: true,
    postPublicationErrors: Object.freeze(postPublicationErrors),
  });
}

async function writeJournal(
  path: string,
  journal: MigrationJournal,
): Promise<MigrationPublicationOutcome> {
  if (journal.quarantineToken === undefined) {
    throw new ConfigMigrationError(
      `migration journal is missing its quarantine token: ${path}`,
    );
  }
  return writeAtomic(
    path,
    `${JSON.stringify(journal, null, 2)}\n`,
    DEFAULT_MODE,
    journal.quarantineToken,
  );
}

async function verifyInputs(inputs: readonly ConfigMigrationInput[]): Promise<void> {
  for (const input of inputs) {
    const current = await readMigrationFile(input.path);
    if (current === null || sha256(current.bytes) !== input.sha256) {
      throw new ConfigMigrationError(
        `migration input changed after check; run check again: ${input.path}`,
      );
    }
  }
}

async function readHashIfPresent(path: string): Promise<string | null> {
  const current = await readMigrationFile(path);
  return current === null ? null : sha256(current.bytes);
}

function migrationLockAnchor(home: HomeContext): string {
  return join(home.path, ".config-v2-migration-authority");
}

function secureStorageNamespaceLockAnchor(
  migration: SecureStorageNamespaceMigration,
): string {
  if (
    !isAbsolute(migration.source.homePath) ||
    migration.source.serviceName.length === 0 ||
    migration.source.accountName.length === 0 ||
    !isAbsolute(migration.target.homePath) ||
    migration.target.serviceName.length === 0 ||
    migration.target.accountName.length === 0 ||
    !isAbsolute(migration.sourceLockPath)
  ) {
    throw new ConfigMigrationError(
      "invalid retired native secure storage namespace identity",
    );
  }
  return migration.sourceLockPath;
}

function migrationPlanAuthorityPaths(
  plan: ConfigV2MigrationPlan,
  journalPath: string,
): readonly string[] {
  return Object.freeze([
    migrationLockAnchor(plan.home),
    journalPath,
    ...plan.inputs.map((input) => input.path),
    ...plan.writes.map((write) => write.targetPath),
    ...plan.archivePaths.flatMap((sourcePath) => [
      sourcePath,
      `${sourcePath}.migrated-v2-${plan.id}`,
    ]),
    ...(plan.credentialMigration !== undefined
      ? [plan.credentialMigration.sourcePath]
      : []),
    ...(plan.retiredAuthMigration?.descriptor.fileActions.map((action) => action.path) ?? []),
    ...(plan.secureStorageNamespaceMigration === undefined
      ? []
      : [
          secureStorageNamespaceLockAnchor(
            plan.secureStorageNamespaceMigration,
          ),
        ]),
  ]);
}

async function assertMigrationPlanPhysicalAuthority(
  plan: ConfigV2MigrationPlan,
): Promise<void> {
  const authorities = [
    ...plan.writes.map((write) => ({
      label: `${write.scope} ${write.kind} target`,
      path: write.targetPath,
    })),
    ...plan.archivePaths.flatMap((sourcePath) => [
      { label: "retired input", path: sourcePath },
      {
        label: "migration archive output",
        path: `${sourcePath}.migrated-v2-${plan.id}`,
      },
    ]),
    ...(plan.credentialMigration === undefined
      ? []
      : [{
          label: "retired credential input",
          path: plan.credentialMigration.sourcePath,
        }]),
    ...(plan.retiredAuthMigration?.descriptor.fileActions.map((action) => ({
      label: "retired authentication input",
      path: action.path,
    })) ?? []),
  ];
  const collisions = await findConfigSourceCollisions(authorities);
  if (collisions.length === 0) return;
  const collision = collisions[0]!;
  throw new ConfigMigrationError(
    `migration authorities ${collision.first.label} (${collision.first.path}) and ${collision.second.label} (${collision.second.path}) resolve to the same physical file (${collision.reason}); run check again after assigning distinct files`,
  );
}

export async function applyConfigV2Migration(
  plan: ConfigV2MigrationPlan,
): Promise<AppliedConfigV2Migration> {
  if (plan.conflicts.length > 0) {
    throw new ConfigMigrationError(
      `migration has ${plan.conflicts.length} conflict(s); no files were changed`,
      plan.conflicts,
    );
  }
  if (
    plan.requiresRetiredWriterQuiescence &&
    !plan.retiredWriterQuiescenceConfirmed
  ) {
    throw new ConfigMigrationError(
      "one-way credential migration requires an explicit assertion that every retired AgenC writer is stopped; rerun apply with --confirm-retired-writers-stopped",
    );
  }
  const dir = await secureJournalDirectory(plan.home, plan.id);
  const journalPath = join(dir, "journal.json");
  const outcome = await runWithConfigAuthorityLocks(
    migrationPlanAuthorityPaths(plan, journalPath),
    () => applyConfigV2MigrationLocked(plan, dir),
  );
  reportMigrationAuthorityReleaseErrors(
    "Configuration migration",
    outcome.postOperationReleaseErrors,
  );
  if (outcome.status === "failed") throw outcome.error;
  return outcome.value;
}

async function applyConfigV2MigrationLocked(
  plan: ConfigV2MigrationPlan,
  dir: string,
): Promise<AppliedConfigV2Migration> {
  await assertMigrationPlanPhysicalAuthority(plan);
  await recoverInterruptedPreparations(plan.home);
  await verifyInputs(plan.inputs);
  const journalPath = join(dir, "journal.json");
  if (await readMigrationFile(journalPath)) {
    throw new ConfigMigrationError(`migration journal already exists: ${journalPath}`);
  }
  const preparationArtifactSnapshots = new Map<string, StableFileSnapshot>();
  const preparationManifestPath = join(dir, PREPARATION_MANIFEST_NAME);
  let preparationManifestPublished = false;
  let preparationManifestSnapshot: StableFileSnapshot | null = null;
  let journalPublished = false;
  let completedJournalPublished = false;
  const finalizationDiagnostics: Error[] = [];
  const quarantineToken = randomUUID();
  try {
    const journalWrites: JournalWrite[] = [];
    const staged = new Map<string, string>();
    const originalBytesByTarget = new Map<string, Buffer>();
    const originalSnapshotsByTarget = new Map<
      string,
      StableFileSnapshot | null
    >();
    const preparationArtifacts: PreparationArtifact[] = [];
    for (const [index, write] of plan.writes.entries()) {
    const target = await readMigrationFile(write.targetPath);
    originalSnapshotsByTarget.set(write.targetPath, target);
    const targetExists = target !== null;
    if (sha256(write.content) !== write.afterSha256) {
      throw new ConfigMigrationError(
        `migration plan content checksum mismatch: ${write.targetPath}`,
      );
    }
    let originalBytes: Buffer | undefined;
    if (write.beforeSha256 === undefined && targetExists) {
      throw new ConfigMigrationError(
        `migration target appeared after check; run check again: ${write.targetPath}`,
      );
    }
    if (write.beforeSha256 !== undefined) {
      if (!targetExists) {
        throw new ConfigMigrationError(
          `migration target disappeared after check; run check again: ${write.targetPath}`,
        );
      }
      originalBytes = target.bytes;
      const currentHash = sha256(originalBytes);
      if (currentHash !== write.beforeSha256) {
        throw new ConfigMigrationError(
          `migration target changed after check; run check again: ${write.targetPath}`,
        );
      }
      originalBytesByTarget.set(write.targetPath, originalBytes);
    }
    const backupPath = targetExists ? join(dir, `target-${index}.bak`) : undefined;
    if (backupPath) {
      if (originalBytes === undefined) {
        throw new ConfigMigrationError(
          `migration target backup bytes are missing: ${write.targetPath}`,
        );
      }
      preparationArtifacts.push(Object.freeze({
        kind: "backup",
        path: backupPath,
        quarantinePath: migrationQuarantinePath(
          backupPath,
          quarantineToken,
          "artifact",
        ),
        ownerPath: write.targetPath,
        sha256: sha256(originalBytes),
        writeIndex: index,
      }));
    }
    const stagePath = `${write.targetPath}.migrate-v2-${plan.id}.tmp`;
    staged.set(write.targetPath, stagePath);
    preparationArtifacts.push(Object.freeze({
      kind: "write-stage",
      path: stagePath,
      quarantinePath: migrationQuarantinePath(
        stagePath,
        quarantineToken,
        "artifact",
      ),
      ownerPath: write.targetPath,
      sha256: write.afterSha256,
    }));
    journalWrites.push(Object.freeze({
      scope: write.scope,
      kind: write.kind,
      targetPath: write.targetPath,
      ...(write.beforeSha256 !== undefined ? { beforeSha256: write.beforeSha256 } : {}),
      afterSha256: write.afterSha256,
      ...(backupPath !== undefined ? { backupPath } : {}),
      mode: write.mode,
    }));
  }

    const journalArchives: JournalArchive[] = [];
    const archiveSourceSnapshots = new Map<string, StableFileSnapshot>();
    for (const sourcePath of plan.archivePaths) {
    const source = await readMigrationFile(sourcePath);
    if (source === null) {
      throw new ConfigMigrationError(
        `migration archive source disappeared after check; run check again: ${sourcePath}`,
      );
    }
    const archivePath = `${sourcePath}.migrated-v2-${plan.id}`;
    if (await readMigrationFile(archivePath)) {
      throw new ConfigMigrationError(`migration archive already exists: ${archivePath}`);
    }
    archiveSourceSnapshots.set(sourcePath, source);
    journalArchives.push(Object.freeze({
      sourcePath,
      archivePath,
      sha256: sha256(source.bytes),
    }));
  }

    const rewritesWindowsSecureStorageInPlace =
      plan.secureStorageNamespaceMigration?.sourceDisposition ===
        "rewrite-in-place";
    const initialSecureStorage = rewritesWindowsSecureStorageInPlace
      ? {}
      : readNativeSecureStorage(plan.home);
    let nextSecureStorage = initialSecureStorage;
    let credentialLegacy: SecureStorageData | undefined;
    let nativeNamespaceLegacy: SecureStorageData | undefined;
    let credentialCanonical: SecureStorageData | undefined;
    let nativeNamespaceCanonical: SecureStorageData | undefined;
    let nativeNamespaceStorage: SecureStorage | undefined;
    let retiredAuthSecureStorageMutation:
      | RetiredAuthSecureStorageMutation
      | undefined;
    const credentialFileActions: RetiredAuthFileAction[] = [];
    const credentialVaultFields = new Set<string>();
    const migratedCredentialLeaves = new Map<
      string,
      { readonly path: readonly string[]; readonly value: unknown }
    >();
    const recordMigratedCredentialLeaf = (
      path: readonly string[],
      value: unknown,
    ): void => {
      if (isPlainRecord(value) && Object.keys(value).length > 0) {
        for (const [field, nestedValue] of Object.entries(value)) {
          recordMigratedCredentialLeaf([...path, field], nestedValue);
        }
        return;
      }
      const key = JSON.stringify(path);
      const existing = migratedCredentialLeaves.get(key);
      if (
        existing !== undefined &&
        stableJson(existing.value) !== stableJson(value)
      ) {
        throw new ConfigMigrationError(
          `migrated credential sources disagree at native secure storage path ${key}`,
        );
      }
      migratedCredentialLeaves.set(key, Object.freeze({
        path: Object.freeze([...path]),
        value: structuredClone(value),
      }));
    };
    if (plan.secureStorageNamespaceMigration) {
    const canonicalIdentity = getCanonicalSecureStorageIdentity(plan.home);
    if (
      stableJson(canonicalIdentity) !==
      stableJson(plan.secureStorageNamespaceMigration.target)
    ) {
      throw new ConfigMigrationError(
        "canonical native secure storage identity changed after check; run check again",
      );
    }
    if (
      !secureStorageIdentitiesDiffer(
        canonicalIdentity,
        plan.secureStorageNamespaceMigration.source,
      )
    ) {
      throw new ConfigMigrationError(
        "retired native secure storage namespace resolves to the canonical namespace",
      );
    }
    nativeNamespaceStorage = getSecureStorageForMigration(
      plan.home,
      plan.secureStorageNamespaceMigration.source,
    );
    const source = readSecureStorageFresh(nativeNamespaceStorage);
    if (
      source === null ||
      sha256(stableJson(source)) !== plan.secureStorageNamespaceMigration.sha256 ||
      stableJson(Object.keys(source).sort()) !==
        stableJson(plan.secureStorageNamespaceMigration.fields)
    ) {
      throw new ConfigMigrationError(
        "retired native secure storage namespace changed after check; run check again",
      );
    }
    nativeNamespaceLegacy = structuredClone(source);
    const preview = mergeLegacyCredentialBlob(
      nextSecureStorage,
      nativeNamespaceLegacy,
      `native secure storage ${plan.secureStorageNamespaceMigration.source.serviceName}`,
    );
    nativeNamespaceCanonical = preview.canonical;
    for (const [field, value] of Object.entries(preview.canonical)) {
      recordMigratedCredentialLeaf([field], value);
    }
    nextSecureStorage = preview.next;
    for (const field of preview.addedFields) credentialVaultFields.add(field);
  }
    if (plan.credentialMigration) {
    const source = await readMigrationFile(plan.credentialMigration.sourcePath);
    if (
      source === null ||
      sha256(source.bytes) !== plan.credentialMigration.sha256
    ) {
      throw new ConfigMigrationError(
        `retired credential input changed after check; run check again: ${plan.credentialMigration.sourcePath}`,
      );
    }
    credentialLegacy = parseLegacyCredentialBlob(
      source.bytes.toString("utf8"),
      plan.credentialMigration.sourcePath,
    );
    const preview = mergeLegacyCredentialBlob(
      nextSecureStorage,
      credentialLegacy,
      plan.credentialMigration.sourcePath,
    );
    credentialCanonical = preview.canonical;
    for (const [field, value] of Object.entries(preview.canonical)) {
      recordMigratedCredentialLeaf([field], value);
    }
    nextSecureStorage = preview.next;
    for (const field of preview.addedFields) credentialVaultFields.add(field);
    credentialFileActions.push(Object.freeze({
      kind: "delete",
      path: plan.credentialMigration.sourcePath,
      beforeSha256: plan.credentialMigration.sha256,
      mode: DEFAULT_MODE,
    }));
  }

    if (plan.retiredAuthMigration) {
    const discovery = await discoverRetiredAuthMigration({
      home: plan.home,
      platformHome: plan.retiredAuthMigration.platformHome,
      env: plan.retiredAuthMigration.environment,
      currentSecureStorage: nextSecureStorage,
    });
    if (
      stableJson(discovery.descriptor) !==
        stableJson(plan.retiredAuthMigration.descriptor)
    ) {
      throw new ConfigMigrationError(
        "retired credential sources or native secure storage changed after check; run check again",
      );
    }
    if (!discovery.mutation) {
      throw new ConfigMigrationError(
        "retired credential migration has conflicts; run check again",
      );
    }
    retiredAuthSecureStorageMutation = discovery.mutation;
    credentialFileActions.push(...discovery.mutation.fileActions);
    for (const field of discovery.descriptor.vaultFields) {
      credentialVaultFields.add(field);
    }
  }

    const credentialActionPaths = credentialFileActions.map((action) => action.path);
    if (new Set(credentialActionPaths).size !== credentialActionPaths.length) {
    throw new ConfigMigrationError(
      "retired credential migration selected one file for multiple actions",
    );
  }
    const credentialStages = new Map<string, string>();
    const credentialSourceSnapshots = new Map<string, StableFileSnapshot>();
    const journalCredentialActions: JournalCredentialFileAction[] = [];
    for (const action of credentialFileActions) {
    const current = await readMigrationFile(action.path);
    if (current === null || sha256(current.bytes) !== action.beforeSha256) {
      throw new ConfigMigrationError(
        `retired credential input changed after check; run check again: ${action.path}`,
      );
    }
    credentialSourceSnapshots.set(action.path, current);
    if (action.kind === "rewrite") {
      if (
        action.content === undefined ||
        action.afterSha256 === undefined ||
        sha256(action.content) !== action.afterSha256
      ) {
        throw new ConfigMigrationError(
          `metadata-only credential rewrite is invalid: ${action.path}`,
        );
      }
      const stagePath = `${action.path}.migrate-v2-${plan.id}.credential.tmp`;
      credentialStages.set(action.path, stagePath);
      preparationArtifacts.push(Object.freeze({
        kind: "credential-stage",
        path: stagePath,
        quarantinePath: migrationQuarantinePath(
          stagePath,
          quarantineToken,
          "artifact",
        ),
        ownerPath: action.path,
        sha256: action.afterSha256,
      }));
    }
    journalCredentialActions.push(Object.freeze({
      kind: action.kind,
      path: action.path,
      beforeSha256: action.beforeSha256,
      ...(action.afterSha256 !== undefined
        ? { afterSha256: action.afterSha256 }
        : {}),
    }));
  }
    const journalCredential: JournalCredentialMigration | undefined =
    journalCredentialActions.length > 0 ||
      credentialVaultFields.size > 0 ||
      plan.secureStorageNamespaceMigration !== undefined
      ? Object.freeze({
          fileActions: Object.freeze(journalCredentialActions),
          vaultFields: Object.freeze([...credentialVaultFields].sort()),
          ...(plan.secureStorageNamespaceMigration === undefined
            ? {}
            : {
                nativeNamespace: Object.freeze({
                  source: plan.secureStorageNamespaceMigration.source,
                  sourceDisposition:
                    plan.secureStorageNamespaceMigration.sourceDisposition,
                  sha256: plan.secureStorageNamespaceMigration.sha256,
                }),
              }),
        })
      : undefined;

    const createdAt = new Date().toISOString();
    const preparation: MigrationPreparationManifest = Object.freeze({
      preparation_version: 1,
      id: plan.id,
      created_at: createdAt,
      quarantineToken,
      artifacts: Object.freeze(preparationArtifacts),
    });
    const preparationPublication = await writePreparationManifest(
      preparationManifestPath,
      preparation,
    );
    preparationManifestPublished = true;
    preparationManifestSnapshot = preparationPublication.published;
    requireCleanExclusiveMigrationPublication(
      preparationPublication,
      preparationManifestPath,
    );

    for (const [index, write] of plan.writes.entries()) {
      const journalWrite = journalWrites[index];
      if (journalWrite === undefined) {
        throw new ConfigMigrationError(
          `migration journal write is missing: ${write.targetPath}`,
        );
      }
      if (journalWrite.backupPath !== undefined) {
        const originalBytes = originalBytesByTarget.get(write.targetPath);
        if (originalBytes === undefined) {
          throw new ConfigMigrationError(
            `migration target backup bytes are missing: ${write.targetPath}`,
          );
        }
        await writeFile(journalWrite.backupPath, originalBytes, {
          mode: DEFAULT_MODE,
          flag: "wx",
        });
        await fsyncPath(journalWrite.backupPath);
        const backupSnapshot = await readMigrationFile(journalWrite.backupPath);
        if (
          backupSnapshot === null ||
          sha256(backupSnapshot.bytes) !== journalWrite.beforeSha256
        ) {
          throw new ConfigMigrationError(
            `migration backup changed while it was prepared: ${journalWrite.backupPath}`,
          );
        }
        preparationArtifactSnapshots.set(
          journalWrite.backupPath,
          backupSnapshot,
        );
      }
      await mkdir(dirname(write.targetPath), { recursive: true, mode: 0o700 });
      const stagePath = staged.get(write.targetPath);
      if (stagePath === undefined) {
        throw new ConfigMigrationError(`missing staged file path: ${write.targetPath}`);
      }
      await writeFile(stagePath, write.content, {
        encoding: "utf8",
        mode: write.mode,
        flag: "wx",
      });
      await fsyncPath(stagePath);
      const stageSnapshot = await readMigrationFile(stagePath);
      if (
        stageSnapshot === null ||
        sha256(stageSnapshot.bytes) !== write.afterSha256
      ) {
        throw new ConfigMigrationError(
          `migration stage changed while it was prepared: ${stagePath}`,
        );
      }
      preparationArtifactSnapshots.set(stagePath, stageSnapshot);
    }
    for (const action of credentialFileActions) {
      if (action.kind !== "rewrite") continue;
      const stagePath = credentialStages.get(action.path);
      if (stagePath === undefined || action.content === undefined) {
        throw new ConfigMigrationError(
          `missing metadata-only credential rewrite stage: ${action.path}`,
        );
      }
      await writeFile(stagePath, action.content, {
        encoding: "utf8",
        mode: action.mode,
        flag: "wx",
      });
      await fsyncPath(stagePath);
      const stageSnapshot = await readMigrationFile(stagePath);
      if (
        stageSnapshot === null ||
        sha256(stageSnapshot.bytes) !== action.afterSha256
      ) {
        throw new ConfigMigrationError(
          `credential rewrite stage changed while it was prepared: ${stagePath}`,
        );
      }
      preparationArtifactSnapshots.set(stagePath, stageSnapshot);
    }

    const prepared: MigrationJournal = Object.freeze({
    journal_version: 1,
    id: plan.id,
    created_at: createdAt,
    quarantineToken,
    status: "prepared",
    writes: Object.freeze(journalWrites),
    archives: Object.freeze(journalArchives),
    ...(journalCredential !== undefined ? { credential: journalCredential } : {}),
    committed: Object.freeze({
      credential: false,
      credentialFileIndexes: Object.freeze([]),
      writeIndexes: Object.freeze([]),
      archiveIndexes: Object.freeze([]),
    }),
  });
    const initialJournalPublication = await writeExclusiveAtomic(
      journalPath,
      `${JSON.stringify(prepared, null, 2)}\n`,
      DEFAULT_MODE,
    );
    journalPublished = true;
    requireCleanExclusiveMigrationPublication(
      initialJournalPublication,
      journalPath,
    );
    if (preparationManifestSnapshot === null) {
      throw new ConfigMigrationError(
        `migration preparation manifest snapshot is missing: ${preparationManifestPath}`,
      );
    }
    await removeUnchangedMigrationFile(
      preparationManifestPath,
      preparationManifestSnapshot,
      "migration preparation manifest cleanup",
      migrationQuarantinePath(
        preparationManifestPath,
        quarantineToken,
        "manifest",
      ),
    );
    preparationManifestPublished = false;
    preparationManifestSnapshot = null;
    await fsyncPath(dir).catch(() => undefined);

    let checkpoint = prepared;
  let credentialTransaction: NativeSecureStorageTransaction | null = null;
  const committedWriteIndexes: number[] = [];
  const committedArchiveIndexes: number[] = [];
  const committedCredentialFileIndexes: number[] = [];
  let credentialCommitted = false;
  let canonicalCredentialSha256: string | undefined;
  let nativeNamespaceDeleteAttempted = false;
  let nativeNamespaceCutoverAmbiguous = false;
  let credentialSanitizationAttempted = false;
  const readCredentialLeaf = (
    current: Readonly<SecureStorageData>,
    path: readonly string[],
  ): { readonly present: boolean; readonly value?: unknown } => {
    let value: unknown = current;
    for (const segment of path) {
      if (!isPlainRecord(value) || !Object.hasOwn(value, segment)) {
        return { present: false };
      }
      value = value[segment];
    }
    return { present: true, value };
  };
  const verifyCanonicalCredentialCommit = (): void => {
    const current = readNativeSecureStorageFresh(plan.home);
    for (const expectation of migratedCredentialLeaves.values()) {
      const actual = readCredentialLeaf(current, expectation.path);
      if (
        !actual.present ||
        stableJson(actual.value) !== stableJson(expectation.value)
      ) {
        throw new ConfigMigrationError(
          `canonical native secure storage changed at migrated path ${JSON.stringify(expectation.path)}; destructive source cleanup was refused`,
        );
      }
    }
    if (retiredAuthSecureStorageMutation !== undefined) {
      try {
        assertRetiredAuthSecureStorageMutationCommitted(
          current,
          retiredAuthSecureStorageMutation,
        );
      } catch (error) {
        throw new ConfigMigrationError(
          `canonical native secure storage changed at a migrated credential leaf; destructive source cleanup was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };
  const checkpointProgress = async (): Promise<void> => {
    checkpoint = Object.freeze({
      ...prepared,
      ...(prepared.credential === undefined
        ? {}
        : {
            credential: Object.freeze({
              ...prepared.credential,
              ...(canonicalCredentialSha256 === undefined
                ? {}
                : { canonicalSha256: canonicalCredentialSha256 }),
            }),
          }),
      committed: Object.freeze({
        credential: credentialCommitted,
        credentialFileIndexes: Object.freeze([
          ...committedCredentialFileIndexes,
        ]),
        writeIndexes: Object.freeze([...committedWriteIndexes]),
        archiveIndexes: Object.freeze([...committedArchiveIndexes]),
      }),
    });
    await writeJournal(journalPath, checkpoint);
  };
  const buildMigratedCredentialVault = (
    current: Readonly<SecureStorageData>,
  ): SecureStorageData => {
    let next = structuredClone(current) as SecureStorageData;
    if (
      nativeNamespaceLegacy !== undefined &&
      plan.secureStorageNamespaceMigration
    ) {
      next = mergeLegacyCredentialBlob(
        next,
        nativeNamespaceLegacy,
        `native secure storage ${plan.secureStorageNamespaceMigration.source.serviceName}`,
      ).next;
    }
    if (credentialLegacy !== undefined && plan.credentialMigration) {
      next = mergeLegacyCredentialBlob(
        next,
        credentialLegacy,
        plan.credentialMigration.sourcePath,
      ).next;
    }
    if (retiredAuthSecureStorageMutation !== undefined) {
      next = applyRetiredAuthSecureStorageMutation(
        next,
        retiredAuthSecureStorageMutation,
      );
    }
    return next;
  };
    try {
    if (journalCredential) {
      const failureMessage =
        "Native secure storage is unavailable; retired credentials and files were not migrated.";
      credentialTransaction = rewritesWindowsSecureStorageInPlace
        ? replaceUnreadableNativeSecureStorageForMigration(
            plan.home,
            buildMigratedCredentialVault({}),
            failureMessage,
          )
        : updateNativeSecureStorage(
            plan.home,
            buildMigratedCredentialVault,
            failureMessage,
          );
      canonicalCredentialSha256 = sha256(stableJson(
        credentialTransaction?.written ??
          readNativeSecureStorageFresh(plan.home),
      ));
      credentialCommitted = true;
      await checkpointProgress();
    }
    for (const [index, write] of journalWrites.entries()) {
      const stagePath = staged.get(write.targetPath);
      if (!stagePath) throw new ConfigMigrationError(`missing staged file: ${write.targetPath}`);
      const stageSnapshot = preparationArtifactSnapshots.get(stagePath);
      const targetSnapshot = originalSnapshotsByTarget.get(write.targetPath);
      if (stageSnapshot === undefined || targetSnapshot === undefined) {
        throw new ConfigMigrationError(
          `missing validated migration file snapshot: ${write.targetPath}`,
        );
      }
      await replaceMigrationFileFromStage(
        stagePath,
        stageSnapshot,
        write.targetPath,
        targetSnapshot,
        "migration target publication",
        migrationQuarantinePath(stagePath, quarantineToken, "artifact"),
        migrationQuarantinePath(
          write.targetPath,
          quarantineToken,
          "target",
        ),
      );
      committedWriteIndexes.push(index);
      await checkpointProgress();
    }
    for (const [index, archive] of journalArchives.entries()) {
      const sourceSnapshot = archiveSourceSnapshots.get(archive.sourcePath);
      if (sourceSnapshot === undefined) {
        throw new ConfigMigrationError(
          `missing validated migration archive snapshot: ${archive.sourcePath}`,
        );
      }
      await moveMigrationFileNoClobber(
        archive.sourcePath,
        sourceSnapshot,
        archive.archivePath,
        "migration archive publication",
        migrationQuarantinePath(
          archive.sourcePath,
          quarantineToken,
          "archive-source",
        ),
      );
      committedArchiveIndexes.push(index);
      await checkpointProgress();
    }
    for (const [index, action] of journalCredentialActions.entries()) {
      verifyCanonicalCredentialCommit();
      const sourceSnapshot = credentialSourceSnapshots.get(action.path);
      if (sourceSnapshot === undefined) {
        throw new ConfigMigrationError(
          `missing validated plaintext credential source snapshot: ${action.path}`,
        );
      }
      credentialSanitizationAttempted = true;
      if (action.kind === "delete") {
        await removeUnchangedMigrationFile(
          action.path,
          sourceSnapshot,
          "retired plaintext credential sanitization",
          migrationQuarantinePath(
            action.path,
            quarantineToken,
            "credential-source",
          ),
        );
      } else {
        const stagePath = credentialStages.get(action.path);
        const stageSnapshot = stagePath === undefined
          ? undefined
          : preparationArtifactSnapshots.get(stagePath);
        if (!stagePath || stageSnapshot === undefined) {
          throw new ConfigMigrationError(
            `missing metadata-only credential rewrite stage: ${action.path}`,
          );
        }
        await replaceMigrationFileFromStage(
          stagePath,
          stageSnapshot,
          action.path,
          sourceSnapshot,
          "retired plaintext credential rewrite",
          migrationQuarantinePath(stagePath, quarantineToken, "artifact"),
          migrationQuarantinePath(
            action.path,
            quarantineToken,
            "credential-source",
          ),
        );
      }
      committedCredentialFileIndexes.push(index);
      await checkpointProgress();
    }
    if (
      nativeNamespaceStorage !== undefined &&
      nativeNamespaceLegacy !== undefined &&
      plan.secureStorageNamespaceMigration !== undefined &&
      plan.secureStorageNamespaceMigration.sourceDisposition.startsWith("delete-")
    ) {
      verifyCanonicalCredentialCommit();
      if (
        !secureStorageIdentitiesDiffer(
          getCanonicalSecureStorageIdentity(plan.home),
          plan.secureStorageNamespaceMigration.source,
        )
      ) {
        throw new ConfigMigrationError(
          "retired native secure storage namespace now resolves to the canonical storage target; migration refuses to delete it",
        );
      }
      const currentSource = readSecureStorageFresh(nativeNamespaceStorage);
      if (
        currentSource === null ||
        sha256(stableJson(currentSource)) !==
          plan.secureStorageNamespaceMigration.sha256
      ) {
        throw new ConfigMigrationError(
          "retired native secure storage namespace changed before cutover; migration refuses to delete it",
        );
      }
      nativeNamespaceDeleteAttempted = true;
      let deleteReportedSuccess = false;
      let deleteError: unknown;
      try {
        deleteReportedSuccess = nativeNamespaceStorage.delete();
      } catch (error) {
        deleteError = error;
      }
      let sourceAfterDelete: SecureStorageData | null;
      try {
        sourceAfterDelete = readSecureStorageFresh(nativeNamespaceStorage);
      } catch (error) {
        throw new ConfigMigrationError(
          `retired native secure storage deletion outcome is ambiguous; the canonical copy was preserved: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (sourceAfterDelete !== null &&
        sha256(stableJson(sourceAfterDelete)) ===
          plan.secureStorageNamespaceMigration.sha256
      ) {
        throw new ConfigMigrationError(
          deleteError instanceof Error
            ? `retired native secure storage namespace deletion failed: ${deleteError.message}`
            : deleteReportedSuccess
              ? "retired native secure storage backend reported success but the source still exists"
              : "retired native secure storage namespace could not be deleted after the canonical secure-storage commit",
        );
      } else if (sourceAfterDelete !== null) {
        throw new ConfigMigrationError(
          "retired native secure storage namespace changed during deletion; the canonical copy was preserved",
        );
      }
    }
    if (
      nativeNamespaceStorage !== undefined &&
      plan.secureStorageNamespaceMigration?.sourceDisposition.startsWith(
        "retain-",
      )
    ) {
      let retainedSource: SecureStorageData | null;
      try {
        retainedSource = readSecureStorageFresh(nativeNamespaceStorage);
      } catch (error) {
        nativeNamespaceCutoverAmbiguous = true;
        throw new ConfigMigrationError(
          `retained native secure storage namespace could not be rechecked after canonical commit; the canonical copy was preserved: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (
        retainedSource === null ||
        sha256(stableJson(retainedSource)) !==
          plan.secureStorageNamespaceMigration.sha256
      ) {
        nativeNamespaceCutoverAmbiguous = true;
        throw new ConfigMigrationError(
          "retained native secure storage namespace changed during credential cutover; the canonical copy was preserved",
        );
      }
    }
    // Detect a retired writer that raced any one-way credential cutover,
    // including plaintext-only and copy/retain namespace migrations. The
    // operator assertion makes such a writer a contract violation; the final
    // postcondition still fails closed and preserves the canonical copy.
    if (credentialCommitted) verifyCanonicalCredentialCommit();
    for (const action of journalCredentialActions) {
      const current = await readMigrationFile(action.path);
      if (
        (action.kind === "delete" && current !== null) ||
        (
          action.kind === "rewrite" &&
          (
            current === null ||
            sha256(current.bytes) !== action.afterSha256
          )
        )
      ) {
        throw new ConfigMigrationError(
          `retired credential source changed during credential cutover: ${action.path}`,
        );
      }
    }
    const completedPublication = await writeJournal(journalPath, {
      ...checkpoint,
      status: "complete",
    });
    completedJournalPublished = true;
    finalizationDiagnostics.push(
      ...completedPublication.postPublicationErrors,
    );
    } catch (error) {
    const rollbackErrors: unknown[] = [];
    const canCompensateCanonicalCredentials =
      credentialCommitted &&
      committedCredentialFileIndexes.length === 0 &&
      !credentialSanitizationAttempted &&
      !nativeNamespaceCutoverAmbiguous &&
      credentialTransaction !== null &&
      !nativeNamespaceDeleteAttempted;
    if (canCompensateCanonicalCredentials) {
      try {
        if (credentialTransaction === null) {
          throw new ConfigMigrationError(
            "native secure storage compensation transaction is missing",
          );
        }
        if (rewritesWindowsSecureStorageInPlace) {
          if (
            nativeNamespaceStorage === undefined ||
            nativeNamespaceLegacy === undefined ||
            plan.secureStorageNamespaceMigration === undefined
          ) {
            throw new ConfigMigrationError(
              "Windows native secure storage in-place compensation is missing its retired source",
            );
          }
          const currentCanonical = readNativeSecureStorageFresh(plan.home);
          if (
            stableJson(currentCanonical) !==
            stableJson(credentialTransaction.written)
          ) {
            throw new ConfigMigrationError(
              "canonical Windows native secure storage changed after in-place re-encryption; compensation refused to overwrite it",
            );
          }
          const restored = nativeNamespaceStorage.update(
            structuredClone(nativeNamespaceLegacy),
          );
          if (!restored.success) {
            throw new ConfigMigrationError(
              restored.warning ??
                "retired Windows native secure storage could not be restored after failed migration",
            );
          }
          const verifiedSource = readSecureStorageFresh(
            nativeNamespaceStorage,
          );
          if (
            verifiedSource === null ||
            sha256(stableJson(verifiedSource)) !==
              plan.secureStorageNamespaceMigration.sha256
          ) {
            throw new ConfigMigrationError(
              "retired Windows native secure storage restoration could not be verified",
            );
          }
        } else {
          rollbackNativeSecureStorage(
            plan.home,
            credentialTransaction,
            (current, transaction) => {
            let next = structuredClone(current) as SecureStorageData;
            if (retiredAuthSecureStorageMutation !== undefined) {
              next = rollbackRetiredAuthSecureStorageMutation(
                next,
                retiredAuthSecureStorageMutation,
              );
            }
            const migratedCredentialFields = new Map<string, unknown>();
            for (const migrated of [
              nativeNamespaceCanonical,
              credentialCanonical,
            ]) {
              if (migrated === undefined) continue;
              for (const [field, value] of Object.entries(migrated)) {
                const known = migratedCredentialFields.get(field);
                if (known !== undefined && stableJson(known) !== stableJson(value)) {
                  throw new ConfigMigrationError(
                    `migrated credential sources disagree at native secure storage field ${field}`,
                  );
                }
                migratedCredentialFields.set(field, value);
              }
            }
            for (const [field, value] of migratedCredentialFields) {
                const previous = transaction.previous[field as keyof SecureStorageData];
                if (previous !== undefined) continue;
                const existing = next[field as keyof SecureStorageData];
                if (stableJson(existing) !== stableJson(value)) {
                  throw new ConfigMigrationError(
                    `native secure storage changed at migrated credential field ${field}; compensation refuses to overwrite it`,
                  );
                }
                delete (next as Record<string, unknown>)[field];
            }
            return next;
            },
            "Native secure storage is unavailable; failed migration credentials could not be compensated.",
          );
        }
        credentialCommitted = false;
        checkpoint = Object.freeze({
          ...checkpoint,
          committed: Object.freeze({
            ...checkpoint.committed,
            credential: false,
          }),
        });
      } catch (compensationError) {
        rollbackErrors.push(compensationError);
      }
    }
    try {
      await rollbackJournal(checkpoint, journalPath, plan.home);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Configuration migration failed and rollback also failed; changed files were preserved for recovery",
      );
    }
    throw error;
    } finally {
    const cleanupErrors: unknown[] = [];
    for (const stagePath of [...staged.values(), ...credentialStages.values()]) {
      const snapshot = preparationArtifactSnapshots.get(stagePath);
      if (snapshot === undefined) continue;
      try {
        await removePreparedArtifactIfUnchanged(
          stagePath,
          snapshot,
          migrationQuarantinePath(stagePath, quarantineToken, "artifact"),
        );
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      if (completedJournalPublished) {
        finalizationDiagnostics.push(
          ...cleanupErrors.map(asMigrationPublicationError),
        );
      } else {
        throw new AggregateError(
          cleanupErrors,
          "Configuration migration stage cleanup refused changed artifacts",
        );
      }
    }
  }

    return Object.freeze({
      id: plan.id,
      journalPath,
      writes: journalWrites.length,
      archives: journalArchives.length,
      credentialSourcesSanitized: journalCredentialActions.length,
      postPublicationErrors: Object.freeze([...finalizationDiagnostics]),
    });
  } catch (error) {
    if (!journalPublished) {
      const cleanupErrors: unknown[] = [];
      for (const [artifactPath, snapshot] of preparationArtifactSnapshots) {
        try {
          await removePreparedArtifactIfUnchanged(
            artifactPath,
            snapshot,
            migrationQuarantinePath(
              artifactPath,
              quarantineToken,
              "artifact",
            ),
          );
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (
        cleanupErrors.length === 0 &&
        preparationManifestPublished &&
        preparationManifestSnapshot !== null
      ) {
        try {
          await removePreparedArtifactIfUnchanged(
            preparationManifestPath,
            preparationManifestSnapshot,
            migrationQuarantinePath(
              preparationManifestPath,
              quarantineToken,
              "manifest",
            ),
          );
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Configuration migration preparation failed and cleanup refused changed artifacts",
        );
      }
    }
    throw error;
  }
}

function parseJournal(value: unknown, path: string): MigrationJournal {
  if (
    !isPlainRecord(value) ||
    !exactObjectKeys(
      value,
      new Set([
        "journal_version",
        "id",
        "created_at",
        "quarantineToken",
        "status",
        "writes",
        "archives",
        "credential",
        "committed",
      ]),
    ) ||
    value.journal_version !== 1 ||
    typeof value.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.id) ||
    value.id !== basename(dirname(path)) ||
    typeof value.created_at !== "string" ||
    (
      value.quarantineToken !== undefined &&
      (
        typeof value.quarantineToken !== "string" ||
        !MIGRATION_QUARANTINE_TOKEN_PATTERN.test(value.quarantineToken)
      )
    )
  ) {
    throw new ConfigMigrationError(`invalid migration journal: ${path}`);
  }
  if (
    !["prepared", "complete", "rolling-back", "rolled-back"].includes(
      String(value.status),
    )
  ) {
    throw new ConfigMigrationError(`invalid migration journal status: ${path}`);
  }
  if (!Array.isArray(value.writes) || !Array.isArray(value.archives)) {
    throw new ConfigMigrationError(`invalid migration journal operations: ${path}`);
  }
  const hashPattern = /^[a-f0-9]{64}$/u;
  const journalDir = dirname(path);
  const validWrites = value.writes.every((entry, index) => {
    if (
      !isPlainRecord(entry) ||
      !exactObjectKeys(
        entry,
        new Set([
          "scope",
          "kind",
          "targetPath",
          "beforeSha256",
          "afterSha256",
          "backupPath",
          "mode",
        ]),
      )
    ) return false;
    const hasBefore = typeof entry.beforeSha256 === "string";
    const hasBackup = typeof entry.backupPath === "string";
    return (
      ["user", "project", "local", "managed", "state"].includes(String(entry.scope)) &&
      ["config", "state"].includes(String(entry.kind)) &&
      typeof entry.targetPath === "string" &&
      isAbsolute(entry.targetPath) &&
      (entry.beforeSha256 === undefined ||
        (typeof entry.beforeSha256 === "string" && hashPattern.test(entry.beforeSha256))) &&
      typeof entry.afterSha256 === "string" &&
      hashPattern.test(entry.afterSha256) &&
      hasBefore === hasBackup &&
      (entry.backupPath === undefined ||
        entry.backupPath === join(journalDir, `target-${index}.bak`)) &&
      Number.isInteger(entry.mode) &&
      (entry.mode as number) >= 0 &&
      (entry.mode as number) <= 0o777
    );
  });
  const validArchives = value.archives.every((entry) =>
    isPlainRecord(entry) &&
    exactObjectKeys(
      entry,
      new Set(["sourcePath", "archivePath", "sha256"]),
    ) &&
    typeof entry.sourcePath === "string" &&
    isAbsolute(entry.sourcePath) &&
    typeof entry.archivePath === "string" &&
    entry.archivePath === `${entry.sourcePath}.migrated-v2-${value.id}` &&
    typeof entry.sha256 === "string" &&
    hashPattern.test(entry.sha256)
  );
  const rawCredential = value.credential;
  const validCredential = rawCredential === undefined || (
    isPlainRecord(rawCredential) &&
    exactObjectKeys(
      rawCredential,
      new Set([
        "fileActions",
        "vaultFields",
        "canonicalSha256",
        "nativeNamespace",
      ]),
    ) &&
    Array.isArray(rawCredential.fileActions) &&
    rawCredential.fileActions.every((action) =>
      isPlainRecord(action) &&
      exactObjectKeys(
        action,
        new Set(["kind", "path", "beforeSha256", "afterSha256"]),
      ) &&
      (action.kind === "delete" || action.kind === "rewrite") &&
      typeof action.path === "string" &&
      isAbsolute(action.path) &&
      typeof action.beforeSha256 === "string" &&
      hashPattern.test(action.beforeSha256) &&
      (action.kind === "rewrite"
        ? typeof action.afterSha256 === "string" &&
          hashPattern.test(action.afterSha256)
        : action.afterSha256 === undefined)
    ) &&
    new Set(rawCredential.fileActions.map((action) =>
      (action as JsonRecord).path as string
    )).size === rawCredential.fileActions.length &&
    Array.isArray(rawCredential.vaultFields) &&
    rawCredential.vaultFields.every((field) =>
      typeof field === "string" && field.length > 0
    ) &&
    new Set(rawCredential.vaultFields).size === rawCredential.vaultFields.length &&
    (
      rawCredential.canonicalSha256 === undefined ||
      (
        typeof rawCredential.canonicalSha256 === "string" &&
        hashPattern.test(rawCredential.canonicalSha256)
      )
    ) &&
    (
      rawCredential.nativeNamespace === undefined ||
      (
        isPlainRecord(rawCredential.nativeNamespace) &&
        exactObjectKeys(
          rawCredential.nativeNamespace,
          new Set(["source", "sourceDisposition", "sha256"]),
        ) &&
        [
          "retain-shared",
          "rewrite-in-place",
          "delete-retired",
          "delete-shared-confirmed",
        ].includes(String(rawCredential.nativeNamespace.sourceDisposition)) &&
        typeof rawCredential.nativeNamespace.sha256 === "string" &&
        hashPattern.test(rawCredential.nativeNamespace.sha256) &&
        isPlainRecord(rawCredential.nativeNamespace.source) &&
        exactObjectKeys(
          rawCredential.nativeNamespace.source,
          new Set(["serviceName", "accountName", "homePath"]),
        ) &&
        typeof rawCredential.nativeNamespace.source.serviceName === "string" &&
        rawCredential.nativeNamespace.source.serviceName.length > 0 &&
        typeof rawCredential.nativeNamespace.source.accountName === "string" &&
        rawCredential.nativeNamespace.source.accountName.length > 0 &&
        typeof rawCredential.nativeNamespace.source.homePath === "string" &&
        isAbsolute(rawCredential.nativeNamespace.source.homePath)
      )
    )
  );
  if (!validWrites || !validArchives || !validCredential) {
    throw new ConfigMigrationError(`invalid migration journal operation entry: ${path}`);
  }
  const writeTargets = value.writes.map((entry) =>
    (entry as JsonRecord).targetPath as string
  );
  const archiveSources = value.archives.map((entry) =>
    (entry as JsonRecord).sourcePath as string
  );
  if (
    new Set(writeTargets).size !== writeTargets.length ||
    new Set(archiveSources).size !== archiveSources.length ||
    (isPlainRecord(rawCredential) &&
      (rawCredential.fileActions as JsonRecord[]).some((action) =>
        archiveSources.includes(action.path as string)
      ))
  ) {
    throw new ConfigMigrationError(`invalid migration journal operation entry: ${path}`);
  }
  const rawCommitted = isPlainRecord(value.committed)
    ? value.committed
    : undefined;
  const writeIndexes = rawCommitted?.writeIndexes;
  const archiveIndexes = rawCommitted?.archiveIndexes;
  const credentialFileIndexes = rawCommitted?.credentialFileIndexes;
  const writeCount = value.writes.length;
  const archiveCount = value.archives.length;
  const credentialFileCount = isPlainRecord(rawCredential) &&
      Array.isArray(rawCredential.fileActions)
    ? rawCredential.fileActions.length
    : 0;
  if (
    rawCommitted !== undefined &&
    (
      !exactObjectKeys(
        rawCommitted,
        new Set([
          "credential",
          "credentialFileIndexes",
          "writeIndexes",
          "archiveIndexes",
        ]),
      ) ||
      typeof rawCommitted.credential !== "boolean" ||
      (credentialFileIndexes !== undefined &&
        (!Array.isArray(credentialFileIndexes) ||
          !credentialFileIndexes.every((index) =>
            Number.isInteger(index) && (index as number) >= 0 &&
            (index as number) < credentialFileCount
          ))) ||
      !Array.isArray(writeIndexes) ||
      !writeIndexes.every((index) =>
        Number.isInteger(index) && (index as number) >= 0 &&
        (index as number) < writeCount
      ) ||
      !Array.isArray(archiveIndexes) ||
      !archiveIndexes.every((index) =>
        Number.isInteger(index) && (index as number) >= 0 &&
        (index as number) < archiveCount
      )
    )
  ) {
    throw new ConfigMigrationError(`invalid migration journal progress: ${path}`);
  }
  const historicalComplete = value.status === "complete";
  return Object.freeze({
    ...(value as unknown as Omit<MigrationJournal, "committed">),
    quarantineToken: typeof value.quarantineToken === "string"
      ? value.quarantineToken
      : historicalJournalQuarantineToken(path, value.id),
    committed: Object.freeze({
      credential: rawCommitted?.credential === true ||
        (historicalComplete && value.credential !== undefined),
      credentialFileIndexes: Object.freeze(
        Array.isArray(credentialFileIndexes)
          ? [...credentialFileIndexes] as number[]
          : historicalComplete && isPlainRecord(rawCredential) &&
              Array.isArray(rawCredential.fileActions)
            ? rawCredential.fileActions.map((_entry, index) => index)
            : [],
      ),
      writeIndexes: Object.freeze(
        Array.isArray(writeIndexes)
          ? [...writeIndexes] as number[]
          : historicalComplete
            ? value.writes.map((_entry, index) => index)
            : [],
      ),
      archiveIndexes: Object.freeze(
        Array.isArray(archiveIndexes)
          ? [...archiveIndexes] as number[]
          : historicalComplete
            ? value.archives.map((_entry, index) => index)
            : [],
      ),
    }),
  });
}

async function samePhysicalMigrationFile(
  left: string,
  right: string,
): Promise<boolean> {
  try {
    const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readExpectedQuarantine(
  path: string,
  expectedSha256: string,
  operation: string,
): Promise<StableFileSnapshot | null> {
  const snapshot = await readMigrationFile(path);
  if (snapshot !== null && sha256(snapshot.bytes) !== expectedSha256) {
    throw new ConfigMigrationError(
      `${operation} quarantine changed outside migration and was preserved: ${path}`,
    );
  }
  return snapshot;
}

async function discardExpectedQuarantine(
  snapshot: StableFileSnapshot,
  originalPath: string,
  operation: string,
): Promise<void> {
  await discardQuarantinedMigrationFile(
    Object.freeze({
      path: snapshot.path,
      snapshot,
      originalPath,
    }),
    operation,
  );
}

async function restoreExpectedQuarantine(
  snapshot: StableFileSnapshot,
  originalPath: string,
  operation: string,
): Promise<void> {
  await restoreQuarantinedMigrationFile(
    Object.freeze({
      path: snapshot.path,
      snapshot,
      originalPath,
    }),
    operation,
  );
}

async function cleanupJournalArtifact(
  path: string,
  expectedSha256: string,
  quarantinePath: string,
  operation: string,
): Promise<void> {
  const snapshot = await readMigrationFile(path);
  if (snapshot === null) {
    const quarantined = await readExpectedQuarantine(
      quarantinePath,
      expectedSha256,
      operation,
    );
    if (quarantined !== null) {
      await discardExpectedQuarantine(quarantined, path, operation);
    }
    return;
  }
  if (sha256(snapshot.bytes) !== expectedSha256) {
    throw new ConfigMigrationError(
      `${operation} artifact changed outside migration and was preserved: ${path}`,
    );
  }
  await removePreparedArtifactIfUnchanged(path, snapshot, quarantinePath);
}

async function reconcileJournalQuarantines(
  journal: MigrationJournal,
  journalPath: string,
  home: HomeContext,
): Promise<void> {
  const token = journal.quarantineToken;
  if (token === undefined) return;
  const operation = "interrupted migration quarantine recovery";

  for (const write of journal.writes) {
    const targetQuarantinePath = migrationQuarantinePath(
      write.targetPath,
      token,
      "target",
    );
    const targetQuarantine = write.beforeSha256 === undefined
      ? null
      : await readExpectedQuarantine(
          targetQuarantinePath,
          write.beforeSha256,
          operation,
        );
    if (targetQuarantine !== null) {
      const targetHash = await readHashIfPresent(write.targetPath);
      if (targetHash === null) {
        await restoreExpectedQuarantine(
          targetQuarantine,
          write.targetPath,
          operation,
        );
      } else if (targetHash === write.beforeSha256) {
        if (!await samePhysicalMigrationFile(write.targetPath, targetQuarantine.path)) {
          throw new ConfigMigrationError(
            `${operation} refuses a target that reappeared independently of its quarantine: ${write.targetPath}`,
          );
        }
        await discardExpectedQuarantine(
          targetQuarantine,
          write.targetPath,
          operation,
        );
      } else if (targetHash === write.afterSha256) {
        if (write.backupPath === undefined) {
          throw new ConfigMigrationError(
            `${operation} is missing the target backup recorded before quarantine: ${write.targetPath}`,
          );
        }
        const backup = await readMigrationFile(write.backupPath);
        if (
          backup === null ||
          sha256(backup.bytes) !== write.beforeSha256
        ) {
          throw new ConfigMigrationError(
            `${operation} refuses to discard the only validated prior target revision: ${targetQuarantine.path}`,
          );
        }
        // Keep the validated prior inode until rollback has durably restored
        // the target. The backup is independently checked, but discarding this
        // last exact revision before rollback would reopen a loss window.
      } else {
        throw new ConfigMigrationError(
          `${operation} refuses an ambiguous target revision: ${write.targetPath}`,
        );
      }
    }

    const stagePath = `${write.targetPath}.migrate-v2-${journal.id}.tmp`;
    const stageQuarantinePath = migrationQuarantinePath(
      stagePath,
      token,
      "artifact",
    );
    const stageQuarantine = await readExpectedQuarantine(
      stageQuarantinePath,
      write.afterSha256,
      operation,
    );
    if (stageQuarantine !== null) {
      const stage = await readMigrationFile(stagePath);
      const targetHash = await readHashIfPresent(write.targetPath);
      if (stage !== null) {
        if (!sameStableFileIdentity(stage, stageQuarantine)) {
          throw new ConfigMigrationError(
            `${operation} refuses an independently reappeared stage: ${stagePath}`,
          );
        }
      } else if (
        targetHash === write.afterSha256 &&
        !await samePhysicalMigrationFile(write.targetPath, stageQuarantine.path)
      ) {
        throw new ConfigMigrationError(
          `${operation} destination is not the exact quarantined stage: ${write.targetPath}`,
        );
      } else if (
        targetHash !== null &&
        targetHash !== write.beforeSha256 &&
        targetHash !== write.afterSha256
      ) {
        throw new ConfigMigrationError(
          `${operation} refuses an ambiguous stage destination: ${write.targetPath}`,
        );
      }
      await discardExpectedQuarantine(stageQuarantine, stagePath, operation);
    }
    await cleanupJournalArtifact(
      stagePath,
      write.afterSha256,
      stageQuarantinePath,
      operation,
    );
  }

  for (const archive of journal.archives) {
    const sourceQuarantinePath = migrationQuarantinePath(
      archive.sourcePath,
      token,
      "archive-source",
    );
    const sourceQuarantine = await readExpectedQuarantine(
      sourceQuarantinePath,
      archive.sha256,
      operation,
    );
    if (sourceQuarantine === null) continue;
    const source = await readMigrationFile(archive.sourcePath);
    const archived = await readMigrationFile(archive.archivePath);
    if (
      source !== null &&
      !sameStableFileIdentity(source, sourceQuarantine)
    ) {
      throw new ConfigMigrationError(
        `${operation} refuses an independently reappeared archive source: ${archive.sourcePath}`,
      );
    }
    if (
      archived !== null &&
      !sameStableFileIdentity(archived, sourceQuarantine)
    ) {
      throw new ConfigMigrationError(
        `${operation} archive destination is not the exact quarantined source: ${archive.archivePath}`,
      );
    }
    if (source === null && archived === null) {
      await restoreExpectedQuarantine(
        sourceQuarantine,
        archive.sourcePath,
        operation,
      );
    } else {
      await discardExpectedQuarantine(
        sourceQuarantine,
        archive.sourcePath,
        operation,
      );
    }
  }

  const credential = journal.credential;
  if (credential === undefined) return;
  const credentialQuarantines = await Promise.all(
    credential.fileActions.map((action) =>
      readExpectedQuarantine(
        migrationQuarantinePath(
          action.path,
          token,
          "credential-source",
        ),
        action.beforeSha256,
        operation,
      )
    ),
  );
  if (credentialQuarantines.every((snapshot) => snapshot === null)) return;
  if (
    !journal.committed.credential ||
    credential.canonicalSha256 === undefined ||
    sha256(stableJson(readNativeSecureStorageFresh(home))) !==
      credential.canonicalSha256
  ) {
    throw new ConfigMigrationError(
      `${operation} preserved credential quarantines because the checkpointed canonical secure-storage revision could not be proven: ${journalPath}`,
    );
  }
  for (const [index, action] of credential.fileActions.entries()) {
    const sourceQuarantine = credentialQuarantines[index];
    const stagePath = `${action.path}.migrate-v2-${journal.id}.credential.tmp`;
    const stageQuarantinePath = migrationQuarantinePath(
      stagePath,
      token,
      "artifact",
    );
    if (sourceQuarantine === null) {
      if (action.kind === "rewrite" && action.afterSha256 !== undefined) {
        await cleanupJournalArtifact(
          stagePath,
          action.afterSha256,
          stageQuarantinePath,
          operation,
        );
      }
      continue;
    }
    const source = await readMigrationFile(action.path);
    if (action.kind === "delete") {
      if (source !== null) {
        throw new ConfigMigrationError(
          `${operation} refuses a credential source that reappeared after deletion began: ${action.path}`,
        );
      }
      await discardExpectedQuarantine(
        sourceQuarantine,
        action.path,
        operation,
      );
      continue;
    }
    if (action.afterSha256 === undefined) {
      throw new ConfigMigrationError(
        `${operation} is missing the credential rewrite checksum: ${action.path}`,
      );
    }
    const sourceHash = source === null ? null : sha256(source.bytes);
    if (sourceHash === null) {
      const stage = await readMigrationFile(stagePath);
      const stageQuarantine = await readExpectedQuarantine(
        stageQuarantinePath,
        action.afterSha256,
        operation,
      );
      const publicationSource = stage ?? stageQuarantine;
      if (publicationSource === null) {
        throw new ConfigMigrationError(
          `${operation} cannot finish the credential rewrite because its sanitized stage is missing: ${action.path}`,
        );
      }
      try {
        await link(publicationSource.path, action.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ConfigMigrationError(
            `${operation} credential source reappeared during rewrite: ${action.path}`,
          );
        }
        throw error;
      }
      const published = await readMigrationFile(action.path);
      if (
        published === null ||
        !sameStableFileIdentity(published, publicationSource)
      ) {
        throw new ConfigMigrationError(
          `${operation} could not verify the recovered credential rewrite: ${action.path}`,
        );
      }
    } else if (sourceHash !== action.afterSha256) {
      throw new ConfigMigrationError(
        `${operation} refuses an ambiguous credential source revision: ${action.path}`,
      );
    }
    await discardExpectedQuarantine(
      sourceQuarantine,
      action.path,
      operation,
    );
    const stageQuarantine = await readExpectedQuarantine(
      stageQuarantinePath,
      action.afterSha256,
      operation,
    );
    if (stageQuarantine !== null) {
      const current = await readMigrationFile(action.path);
      if (
        current === null ||
        !await samePhysicalMigrationFile(current.path, stageQuarantine.path)
      ) {
        throw new ConfigMigrationError(
          `${operation} recovered credential target is not the exact sanitized stage: ${action.path}`,
        );
      }
      await discardExpectedQuarantine(stageQuarantine, stagePath, operation);
    }
    await cleanupJournalArtifact(
      stagePath,
      action.afterSha256,
      stageQuarantinePath,
      operation,
    );
  }
}

interface RollbackJournalOutcome {
  readonly restored: number;
  readonly postPublicationErrors: readonly Error[];
}

async function rollbackJournal(
  journal: MigrationJournal,
  journalPath: string,
  home: HomeContext,
): Promise<RollbackJournalOutcome> {
  if (journal.status === "rolled-back") {
    return Object.freeze({
      restored: 0,
      postPublicationErrors: Object.freeze([]),
    });
  }

  await reconcileJournalQuarantines(journal, journalPath, home);

  const rollbackScratchPath = (write: JournalWrite, index: number): string =>
    `${write.targetPath}.rollback-v2-${journal.id}-${index}.tmp`;
  const restoreStagePath = (write: JournalWrite, index: number): string =>
    `${rollbackScratchPath(write, index)}.restore`;
  const samePhysicalFile = samePhysicalMigrationFile;
  const beforeState = (write: JournalWrite, currentHash: string | null): boolean =>
    write.beforeSha256 === undefined
      ? currentHash === null
      : currentHash === write.beforeSha256;

  const pendingWriteIndexes = new Set<number>();
  for (const [index, write] of journal.writes.entries()) {
    const scratchPath = rollbackScratchPath(write, index);
    const [currentHash, scratchHash] = await Promise.all([
      readHashIfPresent(write.targetPath),
      readHashIfPresent(scratchPath),
    ]);
    if (journal.status !== "rolling-back" && scratchHash !== null) {
      throw new ConfigMigrationError(
        `rollback scratch path already exists: ${scratchPath}`,
      );
    }
    if (scratchHash !== null && scratchHash !== write.afterSha256) {
      throw new ConfigMigrationError(
        `rollback scratch checksum mismatch: ${scratchPath}`,
      );
    }
    if (scratchHash === write.afterSha256) {
      const validInProgressState = currentHash === null ||
        beforeState(write, currentHash) ||
        (currentHash === write.afterSha256 &&
          await samePhysicalFile(write.targetPath, scratchPath));
      if (!validInProgressState) {
        throw new ConfigMigrationError(
          `rollback refuses to overwrite a target changed outside migration: ${write.targetPath}`,
        );
      }
      pendingWriteIndexes.add(index);
      continue;
    }
    if (currentHash === write.afterSha256) {
      pendingWriteIndexes.add(index);
      continue;
    }
    if (beforeState(write, currentHash)) continue;
    throw new ConfigMigrationError(
      `rollback refuses to overwrite a target changed outside migration: ${write.targetPath}`,
    );
  }

  const pendingArchiveIndexes = new Set<number>();
  for (const [index, archive] of journal.archives.entries()) {
    const [sourceHash, archivedHash] = await Promise.all([
      readHashIfPresent(archive.sourcePath),
      readHashIfPresent(archive.archivePath),
    ]);
    if (sourceHash === null && archivedHash === archive.sha256) {
      pendingArchiveIndexes.add(index);
      continue;
    }
    if (sourceHash === archive.sha256 && archivedHash === null) continue;
    if (
      sourceHash === archive.sha256 &&
      archivedHash === archive.sha256 &&
      await samePhysicalFile(archive.sourcePath, archive.archivePath)
    ) {
      pendingArchiveIndexes.add(index);
      continue;
    }
    if (
      sourceHash === archive.sha256 &&
      !journal.committed.archiveIndexes.includes(index)
    ) {
      // Apply never checkpointed this archive item. Preserve an independently
      // created destination and continue rolling back operations that really
      // were committed; the original source is already intact.
      continue;
    }
    throw new ConfigMigrationError(
      `rollback refuses ambiguous or modified migration archive state: ${archive.sourcePath}`,
    );
  }

  let checkpoint: MigrationJournal = Object.freeze({
    ...journal,
    status: "rolling-back",
    committed: Object.freeze({
      ...journal.committed,
      writeIndexes: Object.freeze([...pendingWriteIndexes].sort((a, b) => a - b)),
      archiveIndexes: Object.freeze([...pendingArchiveIndexes].sort((a, b) => a - b)),
    }),
  });
  await writeJournal(journalPath, checkpoint);

  const checkpointRollbackProgress = async (): Promise<void> => {
    checkpoint = Object.freeze({
      ...checkpoint,
      status: "rolling-back",
      committed: Object.freeze({
        ...checkpoint.committed,
        writeIndexes: Object.freeze([...pendingWriteIndexes].sort((a, b) => a - b)),
        archiveIndexes: Object.freeze([...pendingArchiveIndexes].sort((a, b) => a - b)),
      }),
    });
    await writeJournal(journalPath, checkpoint);
  };

  let restored = 0;
  for (const index of [...pendingArchiveIndexes].sort((a, b) => b - a)) {
    const archive = journal.archives[index]!;
    const [sourceHash, archivedHash] = await Promise.all([
      readHashIfPresent(archive.sourcePath),
      readHashIfPresent(archive.archivePath),
    ]);
    if (sourceHash === archive.sha256 && archivedHash === null) {
      // A previous rollback attempt completed this item before its checkpoint.
    } else if (
      sourceHash === archive.sha256 &&
      archivedHash === archive.sha256 &&
      await samePhysicalFile(archive.sourcePath, archive.archivePath)
    ) {
      await rm(archive.archivePath);
      await fsyncPath(dirname(archive.sourcePath)).catch(() => undefined);
      restored += 1;
    } else if (sourceHash === null && archivedHash === archive.sha256) {
      try {
        await link(archive.archivePath, archive.sourcePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ConfigMigrationError(
            `rollback source path is occupied: ${archive.sourcePath}`,
          );
        }
        throw error;
      }
      if (
        await readHashIfPresent(archive.sourcePath) !== archive.sha256 ||
        !await samePhysicalFile(archive.sourcePath, archive.archivePath)
      ) {
        throw new ConfigMigrationError(
          `rollback archive changed during restore: ${archive.archivePath}`,
        );
      }
      await rm(archive.archivePath);
      await fsyncPath(dirname(archive.sourcePath)).catch(() => undefined);
      restored += 1;
    } else {
      throw new ConfigMigrationError(
        `rollback refuses ambiguous or modified migration archive state: ${archive.sourcePath}`,
      );
    }
    pendingArchiveIndexes.delete(index);
    await checkpointRollbackProgress();
  }

  for (const index of [...pendingWriteIndexes].sort((a, b) => b - a)) {
    const write = journal.writes[index]!;
    const scratchPath = rollbackScratchPath(write, index);
    const stagePath = restoreStagePath(write, index);
    let [currentHash, scratchHash] = await Promise.all([
      readHashIfPresent(write.targetPath),
      readHashIfPresent(scratchPath),
    ]);

    if (currentHash === write.afterSha256 && scratchHash === null) {
      try {
        await link(write.targetPath, scratchPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ConfigMigrationError(
            `rollback scratch path appeared during restore: ${scratchPath}`,
          );
        }
        throw error;
      }
      if (
        await readHashIfPresent(write.targetPath) !== write.afterSha256 ||
        !await samePhysicalFile(write.targetPath, scratchPath)
      ) {
        throw new ConfigMigrationError(
          `rollback target changed while it was being preserved: ${write.targetPath}`,
        );
      }
      await rm(write.targetPath);
      currentHash = null;
      scratchHash = write.afterSha256;
    } else if (
      currentHash === write.afterSha256 &&
      scratchHash === write.afterSha256 &&
      await samePhysicalFile(write.targetPath, scratchPath)
    ) {
      await rm(write.targetPath);
      currentHash = null;
    }

    if (scratchHash !== write.afterSha256) {
      if (beforeState(write, currentHash)) {
        pendingWriteIndexes.delete(index);
        await checkpointRollbackProgress();
        continue;
      }
      throw new ConfigMigrationError(
        `rollback target changed while it was being restored: ${write.targetPath}`,
      );
    }

    if (write.backupPath !== undefined) {
      if (write.beforeSha256 === undefined) {
        throw new ConfigMigrationError(
          `rollback journal has a backup without a prior checksum: ${write.targetPath}`,
        );
      }
      const backupSnapshot = await readMigrationFile(write.backupPath);
      if (
        backupSnapshot === null ||
        sha256(backupSnapshot.bytes) !== write.beforeSha256
      ) {
        throw new ConfigMigrationError(
          `rollback backup checksum mismatch: ${write.backupPath}`,
        );
      }
      const backup = backupSnapshot.bytes;
      currentHash = await readHashIfPresent(write.targetPath);
      if (currentHash === null) {
        const existingStageHash = await readHashIfPresent(stagePath);
        if (existingStageHash === null) {
          await writeFile(stagePath, backup, { mode: write.mode, flag: "wx" });
          await fsyncPath(stagePath);
        } else if (existingStageHash !== write.beforeSha256) {
          throw new ConfigMigrationError(
            `rollback restore stage checksum mismatch: ${stagePath}`,
          );
        }
        try {
          await link(stagePath, write.targetPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new ConfigMigrationError(
              `rollback target appeared during restore: ${write.targetPath}`,
            );
          }
          throw error;
        }
      } else if (currentHash !== write.beforeSha256) {
        throw new ConfigMigrationError(
          `rollback refuses to overwrite a target changed outside migration: ${write.targetPath}`,
        );
      }
      if (await readHashIfPresent(write.targetPath) !== write.beforeSha256) {
        throw new ConfigMigrationError(
          `rollback restored target checksum mismatch: ${write.targetPath}`,
        );
      }
      await rm(stagePath, { force: true });
    } else if (await readHashIfPresent(write.targetPath) !== null) {
      throw new ConfigMigrationError(
        `rollback target appeared during restore: ${write.targetPath}`,
      );
    }

    await rm(scratchPath);
    await fsyncPath(dirname(write.targetPath)).catch(() => undefined);
    restored += 1;
    pendingWriteIndexes.delete(index);
    await checkpointRollbackProgress();
  }

  if (journal.quarantineToken !== undefined) {
    for (const write of journal.writes) {
      if (write.beforeSha256 === undefined) continue;
      const quarantinePath = migrationQuarantinePath(
        write.targetPath,
        journal.quarantineToken,
        "target",
      );
      const quarantined = await readExpectedQuarantine(
        quarantinePath,
        write.beforeSha256,
        "completed migration rollback quarantine cleanup",
      );
      if (quarantined === null) continue;
      if (await readHashIfPresent(write.targetPath) !== write.beforeSha256) {
        throw new ConfigMigrationError(
          `rollback preserved the last validated target revision at ${quarantinePath}`,
        );
      }
      await discardExpectedQuarantine(
        quarantined,
        write.targetPath,
        "completed migration rollback quarantine cleanup",
      );
    }
  }

  const rolledBackPublication = await writeJournal(journalPath, {
    ...checkpoint,
    status: "rolled-back",
    committed: Object.freeze({
      ...checkpoint.committed,
      writeIndexes: Object.freeze([]),
      archiveIndexes: Object.freeze([]),
    }),
  });
  return Object.freeze({
    restored,
    postPublicationErrors: rolledBackPublication.postPublicationErrors,
  });
}

export async function rollbackConfigV2Migration(
  id: string,
  options: Pick<ConfigV2MigrationOptions, "env" | "home" | "platformHome"> = {},
): Promise<RolledBackConfigV2Migration> {
  const home = resolveMigrationHomeContext(migrationEnv(options), {
    ...(options.platformHome !== undefined ? { platformHome: options.platformHome } : {}),
  });
  const requestedDirectory = journalDirectory(home, id);
  const requestedJournalPath = join(requestedDirectory, "journal.json");
  const discoveryOutcome = await runWithConfigAuthorityLocks(
    [migrationLockAnchor(home), requestedJournalPath],
    async () => {
      const directory = await secureJournalDirectory(home, id);
      const journalPath = join(directory, "journal.json");
      await recoverPublicationTemps(directory);
      await recoverControlFileQuarantine(journalPath, "journal", home);
      const snapshot = await readMigrationFile(journalPath);
      if (snapshot === null) {
        throw new ConfigMigrationError(
          `migration journal does not exist: ${journalPath}`,
        );
      }
      const journal = parseJournalText(
        snapshot.bytes.toString("utf8"),
        journalPath,
      );
      if (journal.id !== id) {
        throw new ConfigMigrationError(
          `migration journal id mismatch at ${journalPath}`,
        );
      }
      return Object.freeze({ directory, journalPath, snapshot, journal });
    },
  );
  reportMigrationAuthorityReleaseErrors(
    "Configuration migration rollback discovery",
    discoveryOutcome.postOperationReleaseErrors,
  );
  if (discoveryOutcome.status === "failed") throw discoveryOutcome.error;
  const {
    directory,
    journalPath,
    snapshot: initialSnapshot,
    journal: initialJournal,
  } = discoveryOutcome.value;
  const outcome = await runWithConfigAuthorityLocks(
    [
      migrationLockAnchor(home),
      journalPath,
      ...initialJournal.writes.flatMap((write) => [
        write.targetPath,
        ...(write.backupPath !== undefined ? [write.backupPath] : []),
      ]),
      ...initialJournal.archives.flatMap((archive) => [
        archive.sourcePath,
        archive.archivePath,
      ]),
      ...(initialJournal.credential?.fileActions.map((action) => action.path) ?? []),
    ],
    async () => {
      const lockedSnapshot = await readMigrationFile(journalPath);
      if (
        lockedSnapshot === null ||
        !sameStableFileSnapshot(lockedSnapshot, initialSnapshot)
      ) {
        throw new ConfigMigrationError(
          `migration journal changed while rollback acquired authority locks: ${journalPath}`,
        );
      }
      await recoverPublicationTemps(directory);
      await recoverControlFileQuarantine(journalPath, "journal", home);
      const authoritativeSnapshot = await readMigrationFile(journalPath);
      if (
        authoritativeSnapshot === null ||
        !sameStableFileSnapshot(authoritativeSnapshot, initialSnapshot)
      ) {
        throw new ConfigMigrationError(
          `migration journal changed during locked rollback recovery: ${journalPath}`,
        );
      }
      const rollback = await rollbackJournal(
        initialJournal,
        journalPath,
        home,
      );
      return Object.freeze({
        id,
        journalPath,
        restored: rollback.restored,
        credentialsPreserved: initialJournal.credential !== undefined &&
          initialJournal.committed.credential,
        postPublicationErrors: rollback.postPublicationErrors,
      });
    },
  );
  reportMigrationAuthorityReleaseErrors(
    "Configuration migration rollback",
    outcome.postOperationReleaseErrors,
  );
  if (outcome.status === "failed") throw outcome.error;
  return outcome.value;
}

function parseJournalText(text: string, journalPath: string): MigrationJournal {
  if (duplicateJsonObjectPaths(text).length > 0) {
    throw new ConfigMigrationError(
      `migration journal contains duplicate object keys: ${journalPath}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConfigMigrationError(
      `invalid migration journal JSON at ${journalPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseJournal(parsed, journalPath);
}
