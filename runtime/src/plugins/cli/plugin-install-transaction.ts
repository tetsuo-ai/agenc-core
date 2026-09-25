import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  isUnsupportedDirectorySync,
  writeDurableAtomicFile,
} from "../../utils/durable-atomic-file.js";
import { isRecord } from "../../utils/record.js";

const PLUGIN_INSTALL_OPS_DIR = ".plugin-install-ops";
const PLUGIN_INSTALL_TRANSACTION_RECORD_VERSION = 1;

const STAGE_SUFFIX = ".stage-";
const BACKUP_SUFFIX = ".bak-";
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ARTIFACT_NAME_PATTERN = new RegExp(
  `\\.(?:stage|bak)-${UUID_PATTERN}$`,
  "iu",
);
const INSTALL_METADATA_RELATIVE_PATH = join(".agenc-plugin", "agenc-install.json");
const PLUGIN_MANIFEST_RELATIVE_PATH = join(".agenc-plugin", "plugin.json");

export type PluginInstallTransactionKind = "install" | "update";

export type PluginInstallTransactionPhase =
  | "record-created"
  | "stage-ready"
  | "destination-backup-intended"
  | "destination-backed-up"
  | "destination-replace-intended"
  | "destination-replaced"
  | "config-published"
  | "committed";

export interface PluginInstallDirectoryIdentity {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly mode: number;
  readonly manifestSha256: string;
  readonly metadataSha256: string;
}

export interface PluginInstallOperationRecord {
  readonly version: typeof PLUGIN_INSTALL_TRANSACTION_RECORD_VERSION;
  readonly operationId: string;
  readonly kind: PluginInstallTransactionKind;
  readonly pluginId: string;
  readonly destination: string;
  readonly stagePath: string;
  readonly backupPath?: string;
  readonly phase: PluginInstallTransactionPhase;
  readonly stageIdentity?: PluginInstallDirectoryIdentity;
  readonly backupIdentity?: PluginInstallDirectoryIdentity;
  readonly createdAt: string;
  readonly previousPluginConfig?: unknown;
}

export interface PluginInstallTransactionContext {
  readonly operationId: string;
  readonly kind: PluginInstallTransactionKind;
  readonly pluginId: string;
  readonly destination: string;
  readonly stagePath: string;
  readonly backupPath?: string;
  readonly recordPath: string;
  readonly phase: PluginInstallTransactionPhase;
}

export interface PluginInstallTransactionHooks {
  readonly beforeWriteMetadata?: (
    context: PluginInstallTransactionContext,
  ) => Promise<void>;
  readonly beforeValidate?: (
    context: PluginInstallTransactionContext,
  ) => Promise<void>;
  readonly beforePublishConfig?: (
    context: PluginInstallTransactionContext,
  ) => Promise<void>;
  readonly afterPhase?: (
    phase: PluginInstallTransactionPhase,
    context: PluginInstallTransactionContext,
  ) => Promise<void>;
}

export interface PluginInstallRecoveryIssue {
  readonly operationId: string;
  readonly pluginId?: string;
  readonly destination?: string;
  readonly message: string;
  readonly preservedPaths: readonly string[];
}

export interface PluginInstallRecoveryResult {
  readonly recovered: number;
  readonly issues: readonly PluginInstallRecoveryIssue[];
}

export class PluginInstallTransactionSimulatedCrash extends Error {
  readonly phase: PluginInstallTransactionPhase;

  constructor(phase: PluginInstallTransactionPhase) {
    super(`simulated plugin install crash after ${phase}`);
    this.name = "PluginInstallTransactionSimulatedCrash";
    this.phase = phase;
  }
}

export function isPluginInstallTransactionArtifactName(name: string): boolean {
  return name === PLUGIN_INSTALL_OPS_DIR || ARTIFACT_NAME_PATTERN.test(name);
}

function pluginInstallOpsDir(installRoot: string): string {
  return join(resolve(installRoot), PLUGIN_INSTALL_OPS_DIR);
}

function pluginInstallTransactionRecordPath(
  installRoot: string,
  operationId: string,
): string {
  return join(pluginInstallOpsDir(installRoot), `${operationId}.json`);
}

export async function recoverPluginInstallTransactions(
  options: {
    readonly installRoots: readonly string[];
    readonly restorePluginConfig?: (previous: unknown) => Promise<void>;
  },
): Promise<PluginInstallRecoveryResult> {
  const issues: PluginInstallRecoveryIssue[] = [];
  let recovered = 0;
  const roots = [...new Set(options.installRoots.map((root) => resolve(root)))]
    .sort((a, b) => a.localeCompare(b));
  for (const installRoot of roots) {
    const result = await recoverInstallRoot(installRoot, options.restorePluginConfig);
    recovered += result.recovered;
    issues.push(...result.issues);
  }
  return { recovered, issues };
}

export async function runPluginInstallTransaction(input: {
  readonly pluginId: string;
  readonly source: string;
  readonly destination: string;
  readonly force: boolean;
  readonly now?: () => Date;
  readonly copyDirectory: (source: string, destination: string) => Promise<void>;
  readonly writeStageMetadata: (stagePath: string) => Promise<void>;
  readonly validateStage: (stagePath: string) => Promise<void>;
  readonly publishConfig: () => Promise<void>;
  readonly readPluginConfig?: () => Promise<unknown>;
  readonly restorePluginConfig?: (previous: unknown) => Promise<void>;
  readonly hooks?: PluginInstallTransactionHooks;
}): Promise<void> {
  const destination = resolve(input.destination);
  const parent = dirname(destination);
  const existing = await pathExists(destination);
  if (existing && !input.force) {
    throw new Error(`plugin destination already exists: ${destination}`);
  }
  const kind = existing ? "update" : "install";

  const operationId = randomUUID();
  const stagePath = `${destination}${STAGE_SUFFIX}${operationId}`;
  const backupPath = kind === "update"
    ? `${destination}${BACKUP_SUFFIX}${operationId}`
    : undefined;
  const recordPath = pluginInstallTransactionRecordPath(parent, operationId);
  let record: PluginInstallOperationRecord = {
    version: PLUGIN_INSTALL_TRANSACTION_RECORD_VERSION,
    operationId,
    kind,
    pluginId: input.pluginId,
    destination,
    stagePath,
    ...(backupPath === undefined ? {} : { backupPath }),
    phase: "record-created",
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
  };

  const leasePath = pluginInstallLeasePath(recordPath);
  try {
    await writeOperationRecord(recordPath, record);
    await writeInstallLease(leasePath);
    await invokeAfterPhase(input.hooks, record, recordPath);
    await input.copyDirectory(input.source, stagePath);
    const context = transactionContext(record, recordPath);
    await input.hooks?.beforeWriteMetadata?.(context);
    await input.writeStageMetadata(stagePath);
    await input.hooks?.beforeValidate?.(context);
    await input.validateStage(stagePath);
    record = await persistPhase(recordPath, record, {
      phase: "stage-ready",
      stageIdentity: await captureDirectoryIdentity(stagePath),
    });
    await invokeAfterPhase(input.hooks, record, recordPath);

    if (kind === "update") {
      if (backupPath === undefined) {
        throw new Error("plugin update transaction is missing a backup path");
      }
      record = await persistPhase(recordPath, record, {
        phase: "destination-backup-intended",
      });
      await rename(destination, backupPath);
      await syncDirectory(parent);
      record = await persistPhase(recordPath, record, {
        phase: "destination-backed-up",
        backupIdentity: await captureDirectoryIdentity(backupPath),
      });
      await invokeAfterPhase(input.hooks, record, recordPath);
    }

    record = await persistPhase(recordPath, record, {
      phase: "destination-replace-intended",
    });
    await rename(stagePath, destination);
    await syncDirectory(parent);
    record = await persistPhase(recordPath, record, {
      phase: "destination-replaced",
    });
    await invokeAfterPhase(input.hooks, record, recordPath);

    const previousPluginConfig = await input.readPluginConfig?.();
    record = await persistPhase(recordPath, record, {
      phase: "destination-replaced",
      ...(previousPluginConfig === undefined ? {} : { previousPluginConfig }),
    });
    await input.hooks?.beforePublishConfig?.(transactionContext(record, recordPath));
    await input.publishConfig();
    record = await persistPhase(recordPath, record, {
      phase: "config-published",
    });
    await invokeAfterPhase(input.hooks, record, recordPath);

    if (backupPath !== undefined) {
      await removeMatchingDirectory(backupPath, record.backupIdentity);
    }
    record = await persistPhase(recordPath, record, { phase: "committed" });
    await invokeAfterPhase(input.hooks, record, recordPath);
    await removeInstallLease(leasePath);
    await removeOperationRecord(recordPath);
  } catch (error) {
    await removeInstallLease(leasePath);
    if (error instanceof PluginInstallTransactionSimulatedCrash) {
      throw error;
    }
    const rollbackError = await rollbackInProcess(
      record,
      recordPath,
      input.restorePluginConfig,
    ).catch((cause) => cause);
    if (rollbackError !== undefined) {
      throw new AggregateError(
        [error, rollbackError],
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    throw error;
  }
}

async function recoverInstallRoot(
  installRoot: string,
  restorePluginConfig: ((previous: unknown) => Promise<void>) | undefined,
): Promise<PluginInstallRecoveryResult> {
  const opsDir = pluginInstallOpsDir(installRoot);
  let names: string[];
  try {
    names = await readdir(opsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { recovered: 0, issues: [] };
    }
    return {
      recovered: 0,
      issues: [{
        operationId: PLUGIN_INSTALL_OPS_DIR,
        message: `plugin install recovery could not read ${opsDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        preservedPaths: [opsDir],
      }],
    };
  }
  const issues: PluginInstallRecoveryIssue[] = [];
  let recovered = 0;
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (!name.endsWith(".json")) continue;
    const recordPath = join(opsDir, name);
    const parsed = await readOperationRecord(recordPath);
    if (parsed === undefined) {
      issues.push({
        operationId: name.replace(/\.json$/u, ""),
        message: `plugin install operation record is unreadable: ${recordPath}`,
        preservedPaths: [recordPath],
      });
      continue;
    }
    if (await installLeaseIsLive(pluginInstallLeasePath(recordPath))) {
      continue;
    }
    const confined = await confineRecordPaths(installRoot, parsed);
    if (confined !== undefined) {
      issues.push(confined);
      continue;
    }
    const result = await recoverRecord(parsed, recordPath, restorePluginConfig);
    if (result.issue !== undefined) {
      issues.push(result.issue);
      continue;
    }
    recovered += 1;
  }
  return { recovered, issues };
}

async function recoverRecord(
  record: PluginInstallOperationRecord,
  recordPath: string,
  restorePluginConfig: ((previous: unknown) => Promise<void>) | undefined,
): Promise<{ readonly issue?: PluginInstallRecoveryIssue }> {
  switch (record.phase) {
    case "record-created":
      return recoverBeforeStageReady(record, recordPath);
    case "stage-ready":
      return recoverStageReady(record, recordPath);
    case "destination-backup-intended":
      return recoverBackupIntended(record, recordPath, restorePluginConfig);
    case "destination-backed-up":
      return recoverDestinationBackedUp(record, recordPath, restorePluginConfig);
    case "destination-replace-intended":
      return recoverReplaceIntended(record, recordPath, restorePluginConfig);
    case "destination-replaced":
      return recoverDestinationReplaced(record, recordPath, restorePluginConfig);
    case "config-published":
      return recoverConfigPublished(record, recordPath);
    case "committed":
      return recoverCommitted(record, recordPath);
    default: {
      const exhaustive: never = record.phase;
      return {
        issue: {
          operationId: record.operationId,
          pluginId: record.pluginId,
          destination: record.destination,
          message: `plugin install operation has an unknown phase: ${String(exhaustive)}`,
          preservedPaths: preservedRecordPaths(record, recordPath),
        },
      };
    }
  }
}

async function recoverBeforeStageReady(
  record: PluginInstallOperationRecord,
  recordPath: string,
): Promise<{ readonly issue?: PluginInstallRecoveryIssue }> {
  if (await pathExists(record.stagePath)) {
    return {
      issue: {
        operationId: record.operationId,
        pluginId: record.pluginId,
        destination: record.destination,
        message:
          `plugin install stage has no captured identity and will not be deleted: ${record.stagePath}`,
        preservedPaths: preservedRecordPaths(record, recordPath),
      },
    };
  }
  await removeOperationRecord(recordPath);
  return {};
}

async function recoverStageReady(
  record: PluginInstallOperationRecord,
  recordPath: string,
): Promise<{ readonly issue?: PluginInstallRecoveryIssue }> {
  const destinationState = await inspectExistingPath(record.destination);
  if (record.kind === "install" && destinationState.exists) {
    return ambiguousIssue(
      record,
      recordPath,
      `plugin install destination appeared before commit: ${record.destination}`,
    );
  }
  if (record.kind === "update" && !destinationState.exists) {
    return ambiguousIssue(
      record,
      recordPath,
      `plugin update destination disappeared before backup: ${record.destination}`,
    );
  }
  const removed = await removeMatchingDirectory(
    record.stagePath,
    record.stageIdentity,
  );
  if (!removed.ok) return identityIssue(record, recordPath, removed);
  await removeOperationRecord(recordPath);
  return {};
}

async function recoverBackupIntended(
  record: PluginInstallOperationRecord,
  recordPath: string,
  restorePluginConfig: ((previous: unknown) => Promise<void>) | undefined,
): Promise<{ readonly issue?: PluginInstallRecoveryIssue }> {
  if (record.backupPath !== undefined && await pathExists(record.backupPath)) {
    return recoverDestinationBackedUp(record, recordPath, restorePluginConfig);
  }
  return recoverStageReady(record, recordPath);
}

async function recoverDestinationBackedUp(
  record: PluginInstallOperationRecord,
  recordPath: string,
  restorePluginConfig: ((previous: unknown) => Promise<void>) | undefined,
): Promise<{ readonly issue?: PluginInstallRecoveryIssue }> {
  if (record.backupPath !== undefined && !(await pathExists(record.backupPath))) {
    return recoverStageReady(record, recordPath);
  }
  if (record.backupPath === undefined || record.backupIdentity === undefined) {
    return ambiguousIssue(
      record,
      recordPath,
      "plugin update backup identity is missing",
    );
  }
  if (await pathExists(record.destination)) {
    return ambiguousIssue(
      record,
      recordPath,
      `plugin destination reappeared while the backup was still pending: ${record.destination}`,
    );
  }
  const backupMatches = await directoryMatchesIdentity(
    record.backupPath,
    record.backupIdentity,
  );
  if (!backupMatches.ok) return identityIssue(record, recordPath, backupMatches);
  const restored = await restoreMatchingDirectory(
    record.backupPath,
    record.destination,
    record.backupIdentity,
  );
  if (!restored.ok) return identityIssue(record, recordPath, restored);
  if (await pathExists(record.stagePath)) {
    const stageRemoved = await removeMatchingDirectory(
      record.stagePath,
      record.stageIdentity,
    );
    if (!stageRemoved.ok) {
      await removeOperationRecord(recordPath);
      return identityIssue(record, recordPath, stageRemoved);
    }
  }
  await restoreRecordedPluginConfig(record, restorePluginConfig);
  await removeOperationRecord(recordPath);
  return {};
}

async function recoverReplaceIntended(
  record: PluginInstallOperationRecord,
  recordPath: string,
  restorePluginConfig: ((previous: unknown) => Promise<void>) | undefined,
): Promise<{ readonly issue?: PluginInstallRecoveryIssue }> {
  if (await pathExists(record.stagePath)) {
    return recoverStageReady(record, recordPath);
  }
  return recoverDestinationReplaced(record, recordPath, restorePluginConfig);
}

async function recoverDestinationReplaced(
  record: PluginInstallOperationRecord,
  recordPath: string,
  restorePluginConfig: ((previous: unknown) => Promise<void>) | undefined,
): Promise<{ readonly issue?: PluginInstallRecoveryIssue }> {
  const destinationMatches = await directoryMatchesIdentity(
    record.destination,
    record.stageIdentity,
  );
  if (!destinationMatches.ok) {
    return identityIssue(record, recordPath, destinationMatches);
  }
  if (record.kind === "install") {
    const removed = await removeMatchingDirectory(
      record.destination,
      record.stageIdentity,
    );
    if (!removed.ok) return identityIssue(record, recordPath, removed);
    const stageRemoved = await removeMatchingDirectory(
      record.stagePath,
      record.stageIdentity,
    );
    if (!stageRemoved.ok) return identityIssue(record, recordPath, stageRemoved);
    await restoreRecordedPluginConfig(record, restorePluginConfig);
    await removeOperationRecord(recordPath);
    return {};
  }
  if (record.backupPath === undefined || record.backupIdentity === undefined) {
    return ambiguousIssue(
      record,
      recordPath,
      "plugin update backup identity is missing",
    );
  }
  const backupMatches = await directoryMatchesIdentity(
    record.backupPath,
    record.backupIdentity,
  );
  if (!backupMatches.ok) return identityIssue(record, recordPath, backupMatches);
  const removed = await removeMatchingDirectory(
    record.destination,
    record.stageIdentity,
  );
  if (!removed.ok) return identityIssue(record, recordPath, removed);
  const restored = await restoreMatchingDirectory(
    record.backupPath,
    record.destination,
    record.backupIdentity,
  );
  if (!restored.ok) return identityIssue(record, recordPath, restored);
  await restoreRecordedPluginConfig(record, restorePluginConfig);
  await removeOperationRecord(recordPath);
  return {};
}

async function recoverConfigPublished(
  record: PluginInstallOperationRecord,
  recordPath: string,
): Promise<{ readonly issue?: PluginInstallRecoveryIssue }> {
  const destinationMatches = await directoryMatchesIdentity(
    record.destination,
    record.stageIdentity,
  );
  if (!destinationMatches.ok) {
    return identityIssue(record, recordPath, destinationMatches);
  }
  if (record.backupPath !== undefined) {
    const removed = await removeMatchingDirectory(
      record.backupPath,
      record.backupIdentity,
    );
    if (!removed.ok) return identityIssue(record, recordPath, removed);
  }
  await removeOperationRecord(recordPath);
  return {};
}

async function recoverCommitted(
  record: PluginInstallOperationRecord,
  recordPath: string,
): Promise<{ readonly issue?: PluginInstallRecoveryIssue }> {
  if (record.backupPath !== undefined && await pathExists(record.backupPath)) {
    const removed = await removeMatchingDirectory(
      record.backupPath,
      record.backupIdentity,
    );
    if (!removed.ok) return identityIssue(record, recordPath, removed);
  }
  if (await pathExists(record.stagePath)) {
    const removed = await removeMatchingDirectory(
      record.stagePath,
      record.stageIdentity,
    );
    if (!removed.ok) return identityIssue(record, recordPath, removed);
  }
  await removeOperationRecord(recordPath);
  return {};
}

async function rollbackInProcess(
  record: PluginInstallOperationRecord,
  recordPath: string,
  restorePluginConfig: ((previous: unknown) => Promise<void>) | undefined,
): Promise<void> {
  if (record.phase === "record-created") {
    if (await pathExists(record.stagePath)) {
      await rm(record.stagePath, { recursive: true, force: true });
      await syncDirectory(dirname(record.stagePath));
    }
    await removeOperationRecord(recordPath);
    return;
  }
  const result = await recoverRecord(record, recordPath, restorePluginConfig);
  if (result.issue !== undefined) {
    throw new Error(result.issue.message);
  }
}

async function persistPhase(
  recordPath: string,
  record: PluginInstallOperationRecord,
  patch: Partial<PluginInstallOperationRecord> & {
    readonly phase: PluginInstallTransactionPhase;
  },
): Promise<PluginInstallOperationRecord> {
  const next = { ...record, ...patch };
  await writeOperationRecord(recordPath, next);
  return next;
}

async function invokeAfterPhase(
  hooks: PluginInstallTransactionHooks | undefined,
  record: PluginInstallOperationRecord,
  recordPath: string,
): Promise<void> {
  await hooks?.afterPhase?.(record.phase, transactionContext(record, recordPath));
}

function transactionContext(
  record: PluginInstallOperationRecord,
  recordPath: string,
): PluginInstallTransactionContext {
  return {
    operationId: record.operationId,
    kind: record.kind,
    pluginId: record.pluginId,
    destination: record.destination,
    stagePath: record.stagePath,
    ...(record.backupPath === undefined ? {} : { backupPath: record.backupPath }),
    recordPath,
    phase: record.phase,
  };
}

async function writeOperationRecord(
  recordPath: string,
  record: PluginInstallOperationRecord,
): Promise<void> {
  await writeDurableAtomicFile(
    recordPath,
    `${recordPath}.tmp-${process.pid}-${randomUUID()}`,
    `${JSON.stringify(record, null, 2)}\n`,
    0o600,
  );
}

async function readOperationRecord(
  recordPath: string,
): Promise<PluginInstallOperationRecord | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(recordPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || raw.version !== PLUGIN_INSTALL_TRANSACTION_RECORD_VERSION) {
    return undefined;
  }
  if (typeof raw.operationId !== "string" || typeof raw.pluginId !== "string") {
    return undefined;
  }
  if (raw.kind !== "install" && raw.kind !== "update") return undefined;
  if (!isPluginInstallTransactionPhase(raw.phase)) return undefined;
  if (typeof raw.destination !== "string" || typeof raw.stagePath !== "string") {
    return undefined;
  }
  if (typeof raw.createdAt !== "string") return undefined;
  const stageIdentity = raw.stageIdentity === undefined
    ? undefined
    : parseDirectoryIdentity(raw.stageIdentity);
  const backupIdentity = raw.backupIdentity === undefined
    ? undefined
    : parseDirectoryIdentity(raw.backupIdentity);
  if (raw.stageIdentity !== undefined && stageIdentity === undefined) return undefined;
  if (raw.backupIdentity !== undefined && backupIdentity === undefined) return undefined;
  if (
    raw.backupPath !== undefined &&
    typeof raw.backupPath !== "string"
  ) {
    return undefined;
  }
  return {
    version: PLUGIN_INSTALL_TRANSACTION_RECORD_VERSION,
    operationId: raw.operationId,
    kind: raw.kind,
    pluginId: raw.pluginId,
    destination: raw.destination,
    stagePath: raw.stagePath,
    ...(typeof raw.backupPath === "string" ? { backupPath: raw.backupPath } : {}),
    phase: raw.phase,
    ...(stageIdentity === undefined ? {} : { stageIdentity }),
    ...(backupIdentity === undefined ? {} : { backupIdentity }),
    createdAt: raw.createdAt,
    ...(Object.hasOwn(raw, "previousPluginConfig")
      ? { previousPluginConfig: raw.previousPluginConfig }
      : {}),
  };
}

function isPluginInstallTransactionPhase(
  value: unknown,
): value is PluginInstallTransactionPhase {
  return value === "record-created" ||
    value === "stage-ready" ||
    value === "destination-backup-intended" ||
    value === "destination-backed-up" ||
    value === "destination-replace-intended" ||
    value === "destination-replaced" ||
    value === "config-published" ||
    value === "committed";
}

function parseDirectoryIdentity(
  value: unknown,
): PluginInstallDirectoryIdentity | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.path !== "string" ||
    typeof value.dev !== "string" ||
    typeof value.ino !== "string" ||
    typeof value.mode !== "number" ||
    typeof value.manifestSha256 !== "string" ||
    typeof value.metadataSha256 !== "string"
  ) {
    return undefined;
  }
  return {
    path: value.path,
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    manifestSha256: value.manifestSha256,
    metadataSha256: value.metadataSha256,
  };
}

async function captureDirectoryIdentity(
  path: string,
): Promise<PluginInstallDirectoryIdentity> {
  const info = await stat(path);
  if (!info.isDirectory()) {
    throw new Error(`plugin install path is not a directory: ${path}`);
  }
  return {
    path: resolve(path),
    dev: String(info.dev),
    ino: String(info.ino),
    mode: info.mode,
    manifestSha256: await hashOptionalFile(join(path, PLUGIN_MANIFEST_RELATIVE_PATH)),
    metadataSha256: await hashOptionalFile(join(path, INSTALL_METADATA_RELATIVE_PATH)),
  };
}

async function hashOptionalFile(path: string): Promise<string> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function directoryMatchesIdentity(
  path: string,
  expected: PluginInstallDirectoryIdentity | undefined,
): Promise<DirectoryMatchResult> {
  const existing = await inspectExistingPath(path);
  if (expected === undefined) {
    return existing.exists
      ? {
        ok: false,
        path,
        reason: `plugin install path has no captured identity: ${path}`,
      }
      : { ok: true, path };
  }
  if (!existing.exists) {
    return {
      ok: false,
      path,
      reason: `plugin install path is missing: ${path}`,
    };
  }
  let actual: PluginInstallDirectoryIdentity;
  try {
    actual = await captureDirectoryIdentity(path);
  } catch (error) {
    return {
      ok: false,
      path,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.manifestSha256 !== expected.manifestSha256 ||
    actual.metadataSha256 !== expected.metadataSha256
  ) {
    return {
      ok: false,
      path,
      reason: `plugin install path identity changed: ${path}`,
    };
  }
  return { ok: true, path };
}

async function removeMatchingDirectory(
  path: string,
  expected: PluginInstallDirectoryIdentity | undefined,
): Promise<DirectoryMatchResult> {
  if (!(await pathExists(path))) return { ok: true, path };
  const match = await directoryMatchesIdentity(path, expected);
  if (!match.ok) return match;
  await rm(path, { recursive: true, force: true });
  await syncDirectory(dirname(path));
  return { ok: true, path };
}

async function restoreMatchingDirectory(
  from: string,
  to: string,
  expected: PluginInstallDirectoryIdentity | undefined,
): Promise<DirectoryMatchResult> {
  const match = await directoryMatchesIdentity(from, expected);
  if (!match.ok) return match;
  if (await pathExists(to)) {
    return {
      ok: false,
      path: to,
      reason: `plugin restore destination already exists: ${to}`,
    };
  }
  await rename(from, to);
  await syncDirectory(dirname(to));
  return { ok: true, path: to };
}

interface DirectoryMatchResult {
  readonly ok: boolean;
  readonly path: string;
  readonly reason?: string;
}

function identityIssue(
  record: PluginInstallOperationRecord,
  recordPath: string,
  match: DirectoryMatchResult,
): { readonly issue: PluginInstallRecoveryIssue } {
  return ambiguousIssue(
    record,
    recordPath,
    match.reason ?? `plugin install path identity is ambiguous: ${match.path}`,
  );
}

function ambiguousIssue(
  record: PluginInstallOperationRecord,
  recordPath: string,
  message: string,
): { readonly issue: PluginInstallRecoveryIssue } {
  return {
    issue: {
      operationId: record.operationId,
      pluginId: record.pluginId,
      destination: record.destination,
      message,
      preservedPaths: preservedRecordPaths(record, recordPath),
    },
  };
}

function preservedRecordPaths(
  record: PluginInstallOperationRecord,
  recordPath: string,
): string[] {
  return [
    recordPath,
    record.destination,
    record.stagePath,
    ...(record.backupPath === undefined ? [] : [record.backupPath]),
  ];
}

async function removeOperationRecord(recordPath: string): Promise<void> {
  await rm(recordPath, { force: true });
  const parent = dirname(recordPath);
  try {
    const remaining = await readdir(parent);
    if (remaining.length === 0 && basename(parent) === PLUGIN_INSTALL_OPS_DIR) {
      await rm(parent, { recursive: true, force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function pluginInstallLeasePath(recordPath: string): string {
  return `${recordPath}.lease`;
}

async function writeInstallLease(leasePath: string): Promise<void> {
  await writeDurableAtomicFile(
    leasePath,
    `${leasePath}.tmp-${process.pid}-${randomUUID()}`,
    `${JSON.stringify({ pid: process.pid, heartbeatAtMs: Date.now() })}\n`,
    0o600,
  );
}

async function removeInstallLease(leasePath: string): Promise<void> {
  await rm(leasePath, { force: true }).catch(() => {});
}

async function installLeaseIsLive(leasePath: string): Promise<boolean> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(leasePath, "utf8"));
  } catch {
    return false;
  }
  if (!isRecord(raw) || !Number.isInteger(raw.pid) || (raw.pid as number) <= 1) return false;
  try {
    process.kill(raw.pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function confineRecordPaths(
  installRoot: string,
  record: PluginInstallOperationRecord,
): Promise<PluginInstallRecoveryIssue | undefined> {
  const paths = [record.destination, record.stagePath];
  if (record.backupPath !== undefined) paths.push(record.backupPath);
  for (const candidate of paths) {
    const confined = await pathIsUnderInstallRoot(installRoot, candidate);
    if (confined) continue;
    return {
      operationId: record.operationId,
      pluginId: record.pluginId,
      destination: record.destination,
      message: `plugin install recovery ignored a path outside the plugin storage root: ${candidate}`,
      preservedPaths: [candidate],
    };
  }
  return undefined;
}

async function pathIsUnderInstallRoot(installRoot: string, candidate: string): Promise<boolean> {
  if (candidate.includes("\0")) return false;
  const segments = candidate.split(/[/\\]/u);
  if (segments.includes("..")) return false;
  let rootReal: string;
  try {
    const rootInfo = await lstat(installRoot);
    if (!rootInfo.isDirectory()) return false;
    rootReal = await realpath(installRoot);
  } catch {
    return false;
  }
  const resolved = resolve(candidate);
  let cursor = resolved;
  const pending: string[] = [];
  for (;;) {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = dirname(cursor);
      if (parent === cursor) return false;
      pending.push(basename(cursor));
      cursor = parent;
      continue;
    }
    if (info.isSymbolicLink()) return false;
    let realCursor: string;
    try {
      realCursor = await realpath(cursor);
    } catch {
      return false;
    }
    const cursorRel = relative(rootReal, realCursor);
    if (cursorRel.startsWith("..") || isAbsolute(cursorRel)) return false;
    if (pending.length === 0) return cursorRel !== "";
    const full = pending.reduceRight((parent, name) => join(parent, name), realCursor);
    return isPathInsideRoot(rootReal, resolve(full));
  }
}

function isPathInsideRoot(rootReal: string, candidate: string): boolean {
  const rel = relative(rootReal, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function restoreRecordedPluginConfig(
  record: PluginInstallOperationRecord,
  restorePluginConfig: ((previous: unknown) => Promise<void>) | undefined,
): Promise<void> {
  if (restorePluginConfig === undefined || record.previousPluginConfig === undefined) return;
  await restorePluginConfig(record.previousPluginConfig);
}

async function inspectExistingPath(
  path: string,
): Promise<{ readonly exists: boolean }> {
  return { exists: await pathExists(path) };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close();
  }
}
