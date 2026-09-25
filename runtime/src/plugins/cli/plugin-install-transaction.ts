import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readFile, readdir, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  isUnsupportedDirectorySync,
  writeDurableAtomicFile,
} from "../../utils/durable-atomic-file.js";
import { nearestExistingRealpath } from "../nearest-existing-realpath.js";
import { isRecord } from "../../utils/record.js";

const PLUGIN_INSTALL_OPS_DIR = ".plugin-install-ops";
const PLUGIN_INSTALL_TRANSACTION_RECORD_VERSION = 1;

const STAGE_SUFFIX = ".stage-";
const BACKUP_SUFFIX = ".bak-";
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ARTIFACT_NAME_PATTERN = new RegExp(
  String.raw`\.(?:stage|bak)-${UUID_PATTERN}$`,
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
  | "rollback-restore-intended"
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
  /** Canonical user config file the snapshot was read from. */
  readonly configTargetPath?: string;
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
  /** Runs immediately before a stage or backup rename. A throw is an in-process failure. */
  readonly beforeRename?: (phase: PluginInstallTransactionPhase) => Promise<void>;
  /** Runs after a rename while the record is still the intended phase. */
  readonly afterDirectoryRename?: (
    phase: PluginInstallTransactionPhase,
  ) => Promise<void>;
  /** Runs after publishConfig and before the config-published record is written. */
  readonly afterPublishConfig?: () => Promise<void>;
  /** Runs at the start of in-process rollback, while the lease is still held. */
  readonly beforeRollback?: () => Promise<void>;
}

export interface PluginInstallRecoveryHooks {
  /** Test seam: crash after the new destination is removed and before the backup is renamed back. */
  readonly afterRollbackDestinationRemoved?: () => Promise<void>;
  /** Test seam: runs after the dead-lease read and before the claim. */
  readonly beforeLeaseRename?: () => Promise<void>;
  /** Test seam: runs after a dead-lease takeover wins its marker and before the lease path is replaced. */
  readonly beforeLeaseReplace?: () => Promise<void>;
  /** Test seam: runs after this process has claimed a dead lease. */
  readonly afterLeaseClaimed?: () => Promise<void>;
  /** Test seam: runs after an empty ops listing and before rmdir. */
  readonly beforeRemoveEmptyOpsDirectory?: (opsDir: string) => Promise<void>;
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
    readonly restorePluginConfig?: (pluginId: string, previous: unknown) => Promise<void>;
    /** Caller-supplied user config path. Recovery writes only when it matches the record. */
    readonly userConfigPath?: string;
    /** Repo-controlled roots must not apply previousPluginConfig. Report that instead. */
    readonly reportUnrestoredConfig?: boolean;
    readonly hooks?: PluginInstallRecoveryHooks;
  },
): Promise<PluginInstallRecoveryResult> {
  const issues: PluginInstallRecoveryIssue[] = [];
  let recovered = 0;
  const roots = [...new Set(options.installRoots.map((root) => resolve(root)))]
    .toSorted((a, b) => a.localeCompare(b));
  for (const installRoot of roots) {
    const result = await recoverInstallRoot(installRoot, options);
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
  readonly restorePluginConfig?: (pluginId: string, previous: unknown) => Promise<void>;
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
  const state = { record };
  const nonce = await writeInstallLease(leasePath);
  try {
    await writeOperationRecord(recordPath, state.record);
    await activateStagedPlugin(input, state, recordPath, stagePath);
    await moveUpdateBackup(input, state, recordPath, destination, backupPath, parent);
    await replaceDestinationWithStage(input, state, recordPath, stagePath, destination, parent);
    await publishTransactionConfig(input, state, recordPath);
    // The committed record is the commit point. The backup stays until that
    // write succeeds so a failure here can still restore version 1.
    state.record = await persistPhase(recordPath, state.record, { phase: "committed" });
    await invokeAfterPhase(input.hooks, state.record, recordPath);
    await cleanupCommittedInstall(state.record, recordPath, backupPath);
  } catch (error) {
    await rethrowAfterRollback(error, state, recordPath, input);
  } finally {
    await removeInstallLeaseIfNonce(leasePath, nonce);
  }
}

interface TransactionState {
  record: PluginInstallOperationRecord;
}

async function activateStagedPlugin(
  input: Parameters<typeof runPluginInstallTransaction>[0],
  state: TransactionState,
  recordPath: string,
  stagePath: string,
): Promise<void> {
  await invokeAfterPhase(input.hooks, state.record, recordPath);
  await input.copyDirectory(input.source, stagePath);
  const context = transactionContext(state.record, recordPath);
  await input.hooks?.beforeWriteMetadata?.(context);
  await input.writeStageMetadata(stagePath);
  await input.hooks?.beforeValidate?.(context);
  await input.validateStage(stagePath);
  state.record = await persistPhase(recordPath, state.record, {
    phase: "stage-ready",
    stageIdentity: await captureDirectoryIdentity(stagePath),
  });
  await invokeAfterPhase(input.hooks, state.record, recordPath);
}

async function moveUpdateBackup(
  input: Parameters<typeof runPluginInstallTransaction>[0],
  state: TransactionState,
  recordPath: string,
  destination: string,
  backupPath: string | undefined,
  parent: string,
): Promise<void> {
  if (state.record.kind !== "update") return;
  if (backupPath === undefined) {
    throw new Error("plugin update transaction is missing a backup path");
  }
  state.record = await persistPhase(recordPath, state.record, {
    phase: "destination-backup-intended",
    backupIdentity: await captureDirectoryIdentity(destination),
  });
  await invokeAfterPhase(input.hooks, state.record, recordPath);
  await input.hooks?.beforeRename?.("destination-backup-intended");
  await rename(destination, backupPath);
  await syncDirectory(parent);
  await input.hooks?.afterDirectoryRename?.("destination-backup-intended");
  state.record = await persistPhase(recordPath, state.record, {
    phase: "destination-backed-up",
    backupIdentity: await captureDirectoryIdentity(backupPath),
  });
  await invokeAfterPhase(input.hooks, state.record, recordPath);
}

async function replaceDestinationWithStage(
  input: Parameters<typeof runPluginInstallTransaction>[0],
  state: TransactionState,
  recordPath: string,
  stagePath: string,
  destination: string,
  parent: string,
): Promise<void> {
  state.record = await persistPhase(recordPath, state.record, {
    phase: "destination-replace-intended",
  });
  await invokeAfterPhase(input.hooks, state.record, recordPath);
  await input.hooks?.beforeRename?.("destination-replace-intended");
  await rename(stagePath, destination);
  await syncDirectory(parent);
  await input.hooks?.afterDirectoryRename?.("destination-replace-intended");
  state.record = await persistPhase(recordPath, state.record, {
    phase: "destination-replaced",
  });
  await invokeAfterPhase(input.hooks, state.record, recordPath);
}

async function publishTransactionConfig(
  input: Parameters<typeof runPluginInstallTransaction>[0],
  state: TransactionState,
  recordPath: string,
): Promise<void> {
  const captured = splitPluginConfigSnapshot(await input.readPluginConfig?.());
  state.record = await persistPhase(recordPath, state.record, {
    phase: "destination-replaced",
    ...(captured.previousPluginConfig === undefined
      ? {}
      : { previousPluginConfig: captured.previousPluginConfig }),
    ...(captured.configTargetPath === undefined
      ? {}
      : { configTargetPath: captured.configTargetPath }),
  });
  await input.hooks?.beforePublishConfig?.(transactionContext(state.record, recordPath));
  await input.publishConfig();
  await input.hooks?.afterPublishConfig?.();
  state.record = await persistPhase(recordPath, state.record, {
    phase: "config-published",
  });
  await invokeAfterPhase(input.hooks, state.record, recordPath);
}

async function recoverInstallRoot(
  installRoot: string,
  options: Parameters<typeof recoverPluginInstallTransactions>[0],
): Promise<PluginInstallRecoveryResult> {
  const opsDir = pluginInstallOpsDir(installRoot);
  const rejected = await validateTrustedRecoveryRoot(installRoot, opsDir);
  if (rejected !== undefined) return { recovered: 0, issues: [rejected] };
  await sweepStaleLeaseArtifacts(opsDir);
  const listed = await listOperationRecords(opsDir);
  if (listed.issue !== undefined) return { recovered: 0, issues: [listed.issue] };
  const issues: PluginInstallRecoveryIssue[] = [];
  let recovered = 0;
  for (const name of listed.names) {
    const outcome = await recoverNamedRecord(installRoot, opsDir, name, options);
    if (outcome.issue !== undefined) issues.push(outcome.issue);
    if (outcome.recovered) recovered += 1;
  }
  return { recovered, issues };
}

async function listOperationRecords(
  opsDir: string,
): Promise<{ readonly names: readonly string[]; readonly issue?: PluginInstallRecoveryIssue }> {
  try {
    const info = await lstat(opsDir);
    if (!info.isDirectory()) {
      return {
        names: [],
        issue: opsDirectoryIssue(opsDir, "plugin install operation directory is not a real directory"),
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { names: [] };
    return { names: [], issue: opsDirectoryIssue(opsDir, errorMessage(error)) };
  }
  try {
    const names = await readdir(opsDir);
    return { names: names.toSorted((a, b) => a.localeCompare(b)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { names: [] };
    return { names: [], issue: opsDirectoryIssue(opsDir, errorMessage(error)) };
  }
}

function opsDirectoryIssue(opsDir: string, detail: string): PluginInstallRecoveryIssue {
  return {
    operationId: PLUGIN_INSTALL_OPS_DIR,
    message: `plugin install recovery could not read ${opsDir}: ${detail}`,
    preservedPaths: [opsDir],
  };
}

async function recoverNamedRecord(
  installRoot: string,
  opsDir: string,
  name: string,
  options: Parameters<typeof recoverPluginInstallTransactions>[0],
): Promise<{ readonly recovered: boolean; readonly issue?: PluginInstallRecoveryIssue }> {
  if (!name.endsWith(".json")) return { recovered: false };
  const recordPath = join(opsDir, name);
  const leasePath = pluginInstallLeasePath(recordPath);
  const seen = await readLeaseText(leasePath);
  if (leaseTextIsLive(seen)) return { recovered: false };
  await options.hooks?.beforeLeaseRename?.();
  let nonce: string | undefined;
  try {
    const claimed = await claimDeadInstallLease(leasePath, seen, options.hooks);
    if (claimed === undefined) return { recovered: false };
    if ("issue" in claimed) return { recovered: false, issue: claimed.issue };
    nonce = claimed.nonce;
    await options.hooks?.afterLeaseClaimed?.();
    const parsed = await readOperationRecord(recordPath);
    if (parsed === undefined) {
      if (!(await pathExists(recordPath))) return { recovered: false };
      return {
        recovered: false,
        issue: {
          operationId: name.replace(/\.json$/u, ""),
          message: `plugin install operation record is unreadable: ${recordPath}`,
          preservedPaths: [recordPath],
        },
      };
    }
    try {
      return await recoverParsedRecord(installRoot, parsed, recordPath, options);
    } catch (error) {
      if (error instanceof PluginInstallTransactionSimulatedCrash) throw error;
      return {
        recovered: false,
        issue: {
          operationId: parsed.operationId,
          pluginId: parsed.pluginId,
          destination: parsed.destination,
          message: errorMessage(error),
          preservedPaths: [recordPath, parsed.destination],
        },
      };
    }
  } catch (error) {
    if (error instanceof PluginInstallTransactionSimulatedCrash) throw error;
    return {
      recovered: false,
      issue: {
        operationId: name.replace(/\.json$/u, ""),
        message: errorMessage(error),
        preservedPaths: [recordPath],
      },
    };
  } finally {
    if (nonce !== undefined) {
      await removeInstallLeaseIfNonce(leasePath, nonce);
      await sweepStaleLeaseArtifacts(dirname(recordPath));
      await removeEmptyOpsDirectory(
        dirname(recordPath),
        options.hooks?.beforeRemoveEmptyOpsDirectory,
      );
    }
  }
}

async function recoverParsedRecord(
  installRoot: string,
  parsed: PluginInstallOperationRecord,
  recordPath: string,
  options: Parameters<typeof recoverPluginInstallTransactions>[0],
): Promise<{ readonly recovered: boolean; readonly issue?: PluginInstallRecoveryIssue }> {
  const confined = await confineRecordPaths(installRoot, parsed);
  if (confined !== undefined) return { recovered: false, issue: confined };
  const decision = await configRestoreDecision(parsed, options);
  if (decision === "defer") {
    return { recovered: false, issue: unrestoredConfigIssue(parsed, true) };
  }
  const reportUnrestored = decision === "skip";
  const unrestored = unrestoredConfigIssue(parsed, reportUnrestored);
  const result = await recoverRecord(
    parsed,
    recordPath,
    reportUnrestored ? undefined : options.restorePluginConfig,
    options.hooks,
  );
  if (result.issue !== undefined) return { recovered: false, issue: result.issue };
  return unrestored === undefined
    ? { recovered: true }
    : { recovered: true, issue: unrestored };
}

function unrestoredConfigIssue(
  record: PluginInstallOperationRecord,
  reportUnrestoredConfig: boolean,
): PluginInstallRecoveryIssue | undefined {
  if (!reportUnrestoredConfig || record.previousPluginConfig === undefined) return undefined;
  return {
    operationId: record.operationId,
    pluginId: record.pluginId,
    destination: record.destination,
    message: "plugin config not restored",
    preservedPaths: [record.destination],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function recoverRecord(
  record: PluginInstallOperationRecord,
  recordPath: string,
  restorePluginConfig: ((pluginId: string, previous: unknown) => Promise<void>) | undefined,
  hooks: PluginInstallRecoveryHooks | undefined,
): Promise<{ readonly issue?: PluginInstallRecoveryIssue }> {
  switch (record.phase) {
    case "record-created":
      return recoverBeforeStageReady(record, recordPath);
    case "stage-ready":
      return recoverStageReady(record, recordPath);
    case "destination-backup-intended":
      return recoverBackupIntended(record, recordPath, restorePluginConfig, hooks);
    case "destination-backed-up":
      return recoverDestinationBackedUp(record, recordPath, restorePluginConfig, hooks);
    case "destination-replace-intended":
      return recoverReplaceIntended(record, recordPath, restorePluginConfig, hooks);
    case "destination-replaced":
      return recoverDestinationReplaced(record, recordPath, restorePluginConfig, hooks);
    case "rollback-restore-intended":
      return finishBackupRestore(record, recordPath, restorePluginConfig, hooks);
    case "config-published":
      return recoverDestinationReplaced(record, recordPath, restorePluginConfig, hooks);
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
  restorePluginConfig: ((pluginId: string, previous: unknown) => Promise<void>) | undefined,
  hooks: PluginInstallRecoveryHooks | undefined,
): Promise<{ readonly issue?: PluginInstallRecoveryIssue }> {
  if (record.backupPath !== undefined && await pathExists(record.backupPath)) {
    return recoverDestinationBackedUp(record, recordPath, restorePluginConfig, hooks);
  }
  return recoverStageReady(record, recordPath);
}

async function recoverDestinationBackedUp(
  record: PluginInstallOperationRecord,
  recordPath: string,
  restorePluginConfig: ((pluginId: string, previous: unknown) => Promise<void>) | undefined,
  hooks: PluginInstallRecoveryHooks | undefined,
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
  return finishBackupRestore(
    await persistPhase(recordPath, record, { phase: "rollback-restore-intended" }),
    recordPath,
    restorePluginConfig,
    hooks,
  );
}

async function cleanupRestoredPlugin(
  record: PluginInstallOperationRecord,
  recordPath: string,
  restorePluginConfig: ((pluginId: string, previous: unknown) => Promise<void>) | undefined,
): Promise<{ readonly issue?: PluginInstallRecoveryIssue }> {
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
  restorePluginConfig: ((pluginId: string, previous: unknown) => Promise<void>) | undefined,
  hooks: PluginInstallRecoveryHooks | undefined,
): Promise<{ readonly issue?: PluginInstallRecoveryIssue }> {
  if (await pathExists(record.stagePath)) {
    if (record.kind === "update") {
      return recoverDestinationBackedUp(record, recordPath, restorePluginConfig, hooks);
    }
    return recoverStageReady(record, recordPath);
  }
  return recoverDestinationReplaced(record, recordPath, restorePluginConfig, hooks);
}

async function recoverDestinationReplaced(
  record: PluginInstallOperationRecord,
  recordPath: string,
  restorePluginConfig: ((pluginId: string, previous: unknown) => Promise<void>) | undefined,
  hooks: PluginInstallRecoveryHooks | undefined,
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
  return finishBackupRestore(
    await persistPhase(recordPath, record, { phase: "rollback-restore-intended" }),
    recordPath,
    restorePluginConfig,
    hooks,
  );
}

async function finishBackupRestore(
  record: PluginInstallOperationRecord,
  recordPath: string,
  restorePluginConfig: ((pluginId: string, previous: unknown) => Promise<void>) | undefined,
  hooks: PluginInstallRecoveryHooks | undefined,
): Promise<{ readonly issue?: PluginInstallRecoveryIssue }> {
  if (record.backupPath === undefined || record.backupIdentity === undefined) {
    return ambiguousIssue(record, recordPath, "plugin update backup identity is missing");
  }
  const destinationMatchesBackup = await directoryMatchesIdentity(
    record.destination,
    record.backupIdentity,
  );
  if (destinationMatchesBackup.ok && !(await pathExists(record.backupPath))) {
    return cleanupRestoredPlugin(record, recordPath, restorePluginConfig);
  }
  const destinationMatchesStage = await directoryMatchesIdentity(
    record.destination,
    record.stageIdentity,
  );
  if (destinationMatchesStage.ok) {
    const removed = await removeMatchingDirectory(record.destination, record.stageIdentity);
    if (!removed.ok) return identityIssue(record, recordPath, removed);
    await hooks?.afterRollbackDestinationRemoved?.();
  }
  if (!(await pathExists(record.destination)) && await pathExists(record.backupPath)) {
    const backupMatches = await directoryMatchesIdentity(record.backupPath, record.backupIdentity);
    if (!backupMatches.ok) return identityIssue(record, recordPath, backupMatches);
    const restored = await restoreMatchingDirectory(
      record.backupPath,
      record.destination,
      record.backupIdentity,
    );
    if (!restored.ok) return identityIssue(record, recordPath, restored);
    return cleanupRestoredPlugin(record, recordPath, restorePluginConfig);
  }
  if (destinationMatchesBackup.ok) {
    return cleanupRestoredPlugin(record, recordPath, restorePluginConfig);
  }
  return ambiguousIssue(
    record,
    recordPath,
    `plugin backup restore is ambiguous: ${record.destination}`,
  );
}

async function cleanupCommittedInstall(
  record: PluginInstallOperationRecord,
  recordPath: string,
  backupPath: string | undefined,
): Promise<void> {
  try {
    if (backupPath !== undefined) {
      const removed = await removeMatchingDirectory(backupPath, record.backupIdentity);
      if (!removed.ok) return;
    }
    await removeOperationRecord(recordPath);
  } catch {
    // The committed record is already durable. Leaving it in place lets the
    // next recovery pass retry backup cleanup or report an identity mismatch.
  }
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

async function rethrowAfterRollback(
  error: unknown,
  state: TransactionState,
  recordPath: string,
  input: Parameters<typeof runPluginInstallTransaction>[0],
): Promise<never> {
  if (!(error instanceof PluginInstallTransactionSimulatedCrash)) {
    const rollbackError = await rollbackInProcess(
      state.record,
      recordPath,
      input.restorePluginConfig,
      input.hooks,
    ).catch((cause: unknown) => cause);
    if (rollbackError !== undefined) {
      throw new AggregateError(
        [error, rollbackError],
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }
  throw error;
}

async function rollbackInProcess(
  record: PluginInstallOperationRecord,
  recordPath: string,
  restorePluginConfig: ((pluginId: string, previous: unknown) => Promise<void>) | undefined,
  hooks: PluginInstallTransactionHooks | undefined,
): Promise<void> {
  await hooks?.beforeRollback?.();
  if (record.phase === "record-created") {
    if (await pathExists(record.stagePath)) {
      await rm(record.stagePath, { recursive: true, force: true });
      await syncDirectory(dirname(record.stagePath));
    }
    await removeOperationRecord(recordPath);
    return;
  }
  const result = await recoverRecord(record, recordPath, restorePluginConfig, undefined);
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
  const raw = await readJsonRecord(recordPath);
  if (raw === undefined || !operationRecordShapeIsValid(raw)) return undefined;
  const identities = parsedRecordIdentities(raw);
  if (identities === undefined) return undefined;
  return assembleOperationRecord(raw, identities);
}

async function readJsonRecord(recordPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readBoundedRegularFile(recordPath, MAX_RECORD_BYTES);
    if (text === undefined) return undefined;
    const raw: unknown = JSON.parse(text);
    return isRecord(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

function operationRecordShapeIsValid(raw: Record<string, unknown>): boolean {
  return raw.version === PLUGIN_INSTALL_TRANSACTION_RECORD_VERSION &&
    typeof raw.operationId === "string" &&
    typeof raw.pluginId === "string" &&
    (raw.kind === "install" || raw.kind === "update") &&
    isPluginInstallTransactionPhase(raw.phase) &&
    typeof raw.destination === "string" &&
    typeof raw.stagePath === "string" &&
    typeof raw.createdAt === "string" &&
    (raw.backupPath === undefined || typeof raw.backupPath === "string");
}

function parsedRecordIdentities(
  raw: Record<string, unknown>,
): {
  readonly stageIdentity?: PluginInstallDirectoryIdentity;
  readonly backupIdentity?: PluginInstallDirectoryIdentity;
} | undefined {
  const stageIdentity = raw.stageIdentity === undefined
    ? undefined
    : parseDirectoryIdentity(raw.stageIdentity);
  const backupIdentity = raw.backupIdentity === undefined
    ? undefined
    : parseDirectoryIdentity(raw.backupIdentity);
  if (raw.stageIdentity !== undefined && stageIdentity === undefined) return undefined;
  if (raw.backupIdentity !== undefined && backupIdentity === undefined) return undefined;
  return {
    ...(stageIdentity === undefined ? {} : { stageIdentity }),
    ...(backupIdentity === undefined ? {} : { backupIdentity }),
  };
}

function assembleOperationRecord(
  raw: Record<string, unknown>,
  identities: {
    readonly stageIdentity?: PluginInstallDirectoryIdentity;
    readonly backupIdentity?: PluginInstallDirectoryIdentity;
  },
): PluginInstallOperationRecord {
  const phase = raw.phase;
  const kind = raw.kind;
  if (!isPluginInstallTransactionPhase(phase) || (kind !== "install" && kind !== "update")) {
    throw new Error("plugin install operation record failed validation");
  }
  return {
    version: PLUGIN_INSTALL_TRANSACTION_RECORD_VERSION,
    operationId: String(raw.operationId),
    kind,
    pluginId: String(raw.pluginId),
    destination: String(raw.destination),
    stagePath: String(raw.stagePath),
    ...(typeof raw.backupPath === "string" ? { backupPath: raw.backupPath } : {}),
    phase,
    ...identities,
    createdAt: String(raw.createdAt),
    ...(Object.hasOwn(raw, "previousPluginConfig")
      ? { previousPluginConfig: raw.previousPluginConfig }
      : {}),
    ...(typeof raw.configTargetPath === "string" ? { configTargetPath: raw.configTargetPath } : {}),
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
    value === "rollback-restore-intended" ||
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
  await removeEmptyOpsDirectory(dirname(recordPath));
}

async function removeEmptyOpsDirectory(
  opsDir: string,
  beforeRemove?: (opsDir: string) => Promise<void>,
): Promise<void> {
  if (basename(opsDir) !== PLUGIN_INSTALL_OPS_DIR) return;
  let remaining: string[];
  try {
    remaining = await readdir(opsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (remaining.length !== 0) return;
  await beforeRemove?.(opsDir);
  try {
    await rmdir(opsDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return;
    throw error;
  }
}

const LEASE_ARTIFACT_NAME =
  /^.+\.json\.lease\.(claim|tmp)-(\d+)-([0-9a-f-]{36})(?:\.partial-([0-9a-f-]{36}))?$/u;
const LEASE_ARTIFACT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RECLAIM_MARKER_NAME =
  /^(.+\.json\.lease)\.reclaim-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;
const MAX_LEASE_BYTES = 4096;
const MAX_RECORD_BYTES = 1024 * 1024;

async function claimDeadInstallLease(
  leasePath: string,
  seen: string | undefined,
  hooks: PluginInstallRecoveryHooks | undefined,
): Promise<{ readonly nonce: string } | { readonly issue: PluginInstallRecoveryIssue } | undefined> {
  const deadNonce = parseLease(seen)?.nonce;
  if (deadNonce === undefined) {
    if (seen === undefined && !(await leasePathExists(leasePath))) {
      const published = await publishExclusiveLease(leasePath);
      return published === undefined ? undefined : { nonce: published };
    }
    return { issue: manualLeaseIssue(leasePath) };
  }
  const nonce = randomUUID();
  const newTemp = `${leasePath}.tmp-${process.pid}-${nonce}`;
  const marker = `${leasePath}.reclaim-${deadNonce}`;
  await writeDurableAtomicFile(
    newTemp,
    `${newTemp}.partial-${randomUUID()}`,
    `${JSON.stringify({ pid: process.pid, nonce })}\n`,
    0o600,
  );
  try {
    await link(newTemp, marker);
  } catch (error) {
    await rm(newTemp, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  try {
    await hooks?.beforeLeaseReplace?.();
    const current = await readLeaseText(leasePath);
    if (leaseNonce(current) !== deadNonce || current !== seen) return undefined;
    await rename(newTemp, leasePath);
    const confirmed = parseLease(await readLeaseText(leasePath));
    if (confirmed?.nonce !== nonce || !pidIsLive(confirmed.pid) || confirmed.pid !== process.pid) {
      return undefined;
    }
    return { nonce };
  } finally {
    await rm(marker, { force: true });
    await rm(newTemp, { force: true });
  }
}

async function publishExclusiveLease(leasePath: string): Promise<string | undefined> {
  const nonce = randomUUID();
  const temp = `${leasePath}.tmp-${process.pid}-${nonce}`;
  await writeDurableAtomicFile(
    temp,
    `${temp}.partial-${randomUUID()}`,
    `${JSON.stringify({ pid: process.pid, nonce })}\n`,
    0o600,
  );
  try {
    await link(temp, leasePath);
    return nonce;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

async function validateTrustedRecoveryRoot(
  installRoot: string,
  opsDir: string,
): Promise<PluginInstallRecoveryIssue | undefined> {
  let opsInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    opsInfo = await lstat(opsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return opsDirectoryIssue(opsDir, errorMessage(error));
  }
  let rootInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    rootInfo = await lstat(installRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return opsDirectoryIssue(installRoot, errorMessage(error));
  }
  // A symlinked storage root is the user's install root. Reject only a
  // non-directory. A symlinked ops directory is still rejected below.
  if (!rootInfo.isSymbolicLink() && !rootInfo.isDirectory()) {
    return opsDirectoryIssue(installRoot, "plugin install root is not a real directory");
  }
  if (opsInfo.isSymbolicLink() || !opsInfo.isDirectory()) {
    return opsDirectoryIssue(opsDir, "plugin install operation directory is not a real directory");
  }
  const rootReal = await realpath(installRoot);
  const opsReal = await realpath(opsDir);
  if (opsReal !== join(rootReal, PLUGIN_INSTALL_OPS_DIR)) {
    return opsDirectoryIssue(opsDir, "plugin install operation directory is not inside the install root");
  }
  return undefined;
}

async function sweepStaleLeaseArtifacts(opsDir: string): Promise<void> {
  let opsInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    opsInfo = await lstat(opsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (opsInfo.isSymbolicLink() || !opsInfo.isDirectory()) return;
  let names: string[];
  try {
    names = await readdir(opsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const pid = leaseArtifactPid(name);
    if (pid === undefined || pidIsLive(pid)) continue;
    const path = join(opsDir, name);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) continue;
    await rm(path);
  }
  for (const name of names) {
    const marker = RECLAIM_MARKER_NAME.exec(name);
    const leaseName = marker?.[1];
    const markerNonce = marker?.[2];
    if (leaseName === undefined || markerNonce === undefined) continue;
    if (!LEASE_ARTIFACT_UUID.test(markerNonce)) continue;
    const path = join(opsDir, name);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) continue;
    const holder = parseLease(await readLeaseText(path));
    if (holder !== undefined && pidIsLive(holder.pid)) continue;
    const currentNonce = leaseNonce(await readLeaseText(join(opsDir, leaseName)));
    if (currentNonce === undefined) continue;
    await rm(path);
  }
}

function leaseNonce(text: string | undefined): string | undefined {
  return parseLease(text)?.nonce;
}

function manualLeaseIssue(leasePath: string): PluginInstallRecoveryIssue {
  return {
    operationId: basename(leasePath).replace(/\.json\.lease$/u, ""),
    message: `plugin install lease could not be read; inspect and remove it manually: ${leasePath}`,
    preservedPaths: [leasePath],
  };
}

async function leasePathExists(leasePath: string): Promise<boolean> {
  try {
    await lstat(leasePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function leaseArtifactPid(name: string): number | undefined {
  const match = LEASE_ARTIFACT_NAME.exec(name);
  const kind = match?.[1];
  const pidText = match?.[2];
  const id = match?.[3];
  const partial = match?.[4];
  if (kind === undefined || pidText === undefined || id === undefined) return undefined;
  if (!LEASE_ARTIFACT_UUID.test(id)) return undefined;
  if (partial !== undefined && (kind !== "tmp" || !LEASE_ARTIFACT_UUID.test(partial))) return undefined;
  const pid = Number(pidText);
  return Number.isInteger(pid) ? pid : undefined;
}

function splitPluginConfigSnapshot(
  value: unknown,
): { readonly previousPluginConfig?: unknown; readonly configTargetPath?: string } {
  if (!isRecord(value) || !isRecord(value.snapshot) || typeof value.configTargetPath !== "string") {
    return value === undefined ? {} : { previousPluginConfig: value };
  }
  return {
    previousPluginConfig: value.snapshot,
    configTargetPath: value.configTargetPath,
  };
}

async function configRestoreDecision(
  record: PluginInstallOperationRecord,
  options: Parameters<typeof recoverPluginInstallTransactions>[0],
): Promise<"apply" | "skip" | "defer"> {
  if (record.previousPluginConfig === undefined) return "apply";
  if (options.reportUnrestoredConfig === true) return "skip";
  if (record.configTargetPath === undefined) return "defer";
  if (options.userConfigPath === undefined) return "skip";
  const supplied = await canonicalConfigPath(options.userConfigPath);
  const recorded = await canonicalConfigPath(record.configTargetPath);
  if (supplied === undefined || recorded === undefined) return "defer";
  return supplied === recorded ? "apply" : "defer";
}

async function canonicalConfigPath(path: string): Promise<string | undefined> {
  return nearestExistingRealpath(path);
}

function pluginInstallLeasePath(recordPath: string): string {
  return `${recordPath}.lease`;
}

async function writeInstallLease(leasePath: string): Promise<string> {
  const nonce = await publishExclusiveLease(leasePath);
  if (nonce === undefined) throw new Error(`plugin install lease already exists: ${leasePath}`);
  return nonce;
}

async function removeInstallLeaseIfNonce(leasePath: string, nonce: string): Promise<void> {
  const text = await readLeaseText(leasePath);
  const parsed = parseLease(text);
  if (parsed?.nonce !== nonce) return;
  await rm(leasePath, { force: true }).catch(() => {});
}

async function readLeaseText(leasePath: string): Promise<string | undefined> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(leasePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return undefined;
    throw error;
  }
  // Opening a FIFO blocks until a writer appears. Reject any non-regular
  // lease (FIFO, socket, device, directory, symlink) before open.
  if (info.isSymbolicLink() || !info.isFile()) return undefined;
  return readBoundedRegularFile(leasePath, MAX_LEASE_BYTES);
}

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // win32 has no O_NOFOLLOW. O_NONBLOCK is absent there too; where it exists
    // it keeps a FIFO swapped in after lstat from blocking in open.
    const follow = constants.O_NOFOLLOW ?? 0;
    const nonblock = constants.O_NONBLOCK ?? 0;
    handle = await open(path, constants.O_RDONLY | follow | nonblock);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(info.size);
    await handle.read(buffer, 0, info.size, 0);
    return buffer.toString("utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseLease(text: string | undefined): { readonly pid: number; readonly nonce?: string } | undefined {
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || !Number.isInteger(raw.pid) || (raw.pid as number) < 1) return undefined;
  return {
    pid: raw.pid as number,
    ...(typeof raw.nonce === "string" && raw.nonce !== "" ? { nonce: raw.nonce } : {}),
  };
}

function leaseTextIsLive(text: string | undefined): boolean {
  const parsed = parseLease(text);
  return parsed !== undefined && pidIsLive(parsed.pid);
}

function pidIsLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Liveness is pid-only. A lease is live while its recorded pid answers signal 0
// or the check is denied (EPERM). heartbeatAtMs is not stored: a long copy or
// validate must not look expired, and recovery does not guess a TTL.
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
    if (!rootInfo.isSymbolicLink() && !rootInfo.isDirectory()) return false;
    rootReal = await realpath(installRoot);
  } catch {
    return false;
  }
  return existingAncestorIsInside(rootReal, resolve(candidate));
}

async function existingAncestorIsInside(rootReal: string, candidate: string): Promise<boolean> {
  const walked = await walkToExistingPath(candidate);
  if (walked === undefined) return false;
  if (walked.info.isSymbolicLink()) return false;
  let realCursor: string;
  try {
    realCursor = await realpath(walked.path);
  } catch {
    return false;
  }
  const cursorRel = relative(rootReal, realCursor);
  if (cursorRel.startsWith("..") || isAbsolute(cursorRel)) return false;
  if (walked.pending.length === 0) return cursorRel !== "";
  const full = walked.pending.reduceRight((parent, name) => join(parent, name), realCursor);
  return isPathInsideRoot(rootReal, resolve(full));
}

async function walkToExistingPath(
  candidate: string,
): Promise<{ readonly path: string; readonly info: Awaited<ReturnType<typeof lstat>>; readonly pending: string[] } | undefined> {
  let cursor = candidate;
  const pending: string[] = [];
  for (;;) {
    try {
      return { path: cursor, info: await lstat(cursor), pending };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      const parent = dirname(cursor);
      if (parent === cursor) return undefined;
      pending.push(basename(cursor));
      cursor = parent;
    }
  }
}

function isPathInsideRoot(rootReal: string, candidate: string): boolean {
  const rel = relative(rootReal, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function restoreRecordedPluginConfig(
  record: PluginInstallOperationRecord,
  restorePluginConfig: ((pluginId: string, previous: unknown) => Promise<void>) | undefined,
): Promise<void> {
  if (restorePluginConfig === undefined || record.previousPluginConfig === undefined) return;
  await restorePluginConfig(record.pluginId, record.previousPluginConfig);
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
