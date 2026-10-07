import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { cloneJsonValue, cloneRecord, isPlainRecord, stableJson, type JsonRecord } from "./json.js";
import {
  assertConfigPatchAuthority,
  assertUserConfigDocumentAuthority,
  type WritableConfigScope,
} from "./layer-authority.js";
import { withConfigAuthorityLockSync } from "./authority-lock.js";
import { parseToml } from "./loader.js";
import { serializeConfigToml } from "./serialize.js";
import {
  CANONICAL_CONFIG_VERSION,
  CANONICAL_CONFIG_VERSION_KEY,
  validateStrictConfigDocument,
} from "./repository.js";

import {
  fencePluginTransactionEdits,
  pluginConfigTargetDigest,
  pluginIntentForPatch,
  readPluginTransactionHeader,
  withPluginTransactionHeader,
  type PluginConfigWriteIntent,
  type PluginTransactionLedger,
} from "./plugin-transaction-ledger.js";

const DEFAULT_FILE_MODE = 0o600;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

interface WritableTarget {
  readonly path: string;
  readonly mode: number;
  readonly exists: boolean;
}

function writableTarget(path: string): WritableTarget {
  let link: ReturnType<typeof lstatSync>;
  try {
    link = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { path, mode: DEFAULT_FILE_MODE, exists: false };
    }
    throw error;
  }
  let target = path;
  if (link.isSymbolicLink()) {
    try {
      target = realpathSync(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new Error(`config symlink target does not exist: ${path}`);
      }
      throw error;
    }
  }
  const info = statSync(target);
  if (!info.isFile()) throw new Error(`config path is not a file: ${path}`);
  return {
    path: target,
    mode: (info.mode & 0o777) || DEFAULT_FILE_MODE,
    exists: true,
  };
}

function normalizedConfigText(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.replace(/\r\n?/gu, "\n");
}

/** Parse and strictly validate one complete canonical TOML document. */
export function parseCanonicalConfigText(text: string, path: string): JsonRecord {
  let duplicate = false;
  const raw = cloneRecord(parseToml(normalizedConfigText(text), {
    onDuplicateKey: () => {
      duplicate = true;
    },
  }));
  if (duplicate) {
    throw new Error(`cannot update ${path}: duplicate TOML keys must be resolved first`);
  }
  validateStrictConfigDocument(raw, path);
  return raw;
}

/** Resolve aliases before locking, including symlinks in an existing parent. */
function canonicalTarget(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    // A dangling symlink is not an absent config file.
    try {
      if (lstatSync(absolute).isSymbolicLink()) throw new Error(`config symlink target does not exist: ${path}`);
    } catch (missing) {
      if (errorCode(missing) !== "ENOENT") throw missing;
    }
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(canonicalTarget(parent), basename(absolute));
  }
}

function withCanonicalTargetLock<T>(path: string, operation: (target: WritableTarget) => T): T {
  const canonical = canonicalTarget(path);
  return withConfigAuthorityLockSync(canonical, () => {
    if (canonicalTarget(path) !== canonical) throw new Error(`config target changed before update: ${path}`);
    const target = writableTarget(canonical);
    const result = operation(target);
    if (canonicalTarget(path) !== canonical) throw new Error(`config target changed during update: ${path}`);
    return result;
  });
}

export interface CanonicalUserConfigSnapshot {
  readonly path: string;
  readonly targetPath: string;
  readonly exists: boolean;
  readonly mode: number;
  readonly content: string;
  readonly raw: Readonly<JsonRecord>;
}

/**
 * Capture the exact user document before a long-running external editor opens.
 * The replacement API below compares this snapshot again under the writer lock.
 */
export function readCanonicalUserConfigSnapshotSync(
  path: string,
): CanonicalUserConfigSnapshot {
  const target = writableTarget(canonicalTarget(path));
  const content = target.exists
    ? readFileSync(target.path, "utf8")
    : `${CANONICAL_CONFIG_VERSION_KEY} = ${CANONICAL_CONFIG_VERSION}\n`;
  const raw = parseCanonicalConfigText(content, target.path);
  return Object.freeze({
    path,
    targetPath: target.path,
    exists: target.exists,
    mode: target.mode,
    content,
    raw: Object.freeze(raw),
  });
}

function mergePatch(target: JsonRecord, patch: Readonly<JsonRecord>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete target[key];
      continue;
    }
    if (isPlainRecord(value) && isPlainRecord(target[key])) {
      mergePatch(target[key] as JsonRecord, value);
      if (Object.keys(target[key] as JsonRecord).length === 0) delete target[key];
      continue;
    }
    target[key] = cloneJsonValue(value);
  }
}

function writeAtomic(path: string, content: string, mode: number): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, content, {
      encoding: "utf8",
      flag: "wx",
      mode,
      flush: true,
    });
    renameSync(temporary, path);
    let directoryFd: number | undefined;
    try {
      directoryFd = openSync(parent, "r");
      fsyncSync(directoryFd);
    } catch {
      // Some platforms and virtual filesystems do not permit directory fsync.
    } finally {
      if (directoryFd !== undefined) closeSync(directoryFd);
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

/**
 * Apply a patch to one canonical TOML layer. This function owns no source
 * precedence: callers pass the already-resolved writable layer path.
 */
export function applyCanonicalConfigPatchSync(
  path: string,
  patch: Readonly<JsonRecord>,
  scope: WritableConfigScope,
): void {
  assertConfigPatchAuthority(scope, patch);
  transformCanonicalConfigSync(path, state => {
    const before = cloneRecord(state.raw);
    mergePatch(state.raw, patch);
    fencePluginTransactionEdits(state.ledger, before, state.raw, pluginIntentForPatch(patch));
  }, false);
}

/**
 * Transform a canonical user document. Plugin writers must supply explicit
 * intent for global/entry edits, including idempotent writes.
 */
export function mutateCanonicalUserConfigSync(
  path: string,
  mutator: (raw: JsonRecord) => void,
  intent: PluginConfigWriteIntent = {},
): void {
  mutateCanonicalPluginTransactionSync(path, state => {
    const before = cloneRecord(state.raw);
    mutator(state.raw);
    fencePluginTransactionEdits(state.ledger, before, state.raw, intent);
  });
}

export interface CanonicalPluginTransactionState {
  readonly targetPath: string;
  readonly raw: JsonRecord;
  ledger: PluginTransactionLedger | undefined;
}

/** Internal atomic value+ownership publication; callback must not await. */
export function mutateCanonicalPluginTransactionSync<T>(
  path: string,
  mutator: (state: CanonicalPluginTransactionState) => T,
): T {
  return transformCanonicalConfigSync(path, mutator, true);
}

function transformCanonicalConfigSync<T>(
  path: string,
  mutator: (state: CanonicalPluginTransactionState) => T,
  assertUserAuthority: boolean,
): T {
  return withCanonicalTargetLock(path, target => {
    const content = target.exists ? readFileSync(target.path, "utf8")
      : `${CANONICAL_CONFIG_VERSION_KEY} = ${CANONICAL_CONFIG_VERSION}\n`;
    const raw = parseCanonicalConfigText(content, target.path);
    const { ledger } = readPluginTransactionHeader(content);
    if (ledger !== undefined && ledger.target !== pluginConfigTargetDigest(target.path)) {
      throw new Error("plugin transaction metadata belongs to a different config target");
    }
    const before = stableJson(raw);
    const beforeLedger = stableJson(ledger ?? null);
    const state: CanonicalPluginTransactionState = { targetPath: target.path, raw, ledger };
    const result = mutator(state);
    if (assertUserAuthority) assertUserConfigDocumentAuthority(raw, target.path);
    if (state.ledger !== undefined && state.ledger.target !== pluginConfigTargetDigest(target.path)) {
      throw new Error("plugin transaction metadata belongs to a different config target");
    }
    if (canonicalTarget(path) !== target.path) throw new Error(`config target changed during update: ${path}`);
    if (stableJson(raw) !== before || stableJson(state.ledger ?? null) !== beforeLedger) {
      prepareAndWrite(target, raw, state.ledger);
    }
    return result;
  });
}

/**
 * Commit text produced by an external editor without losing comments or
 * formatting. The exact pre-edit file and resolved symlink target are checked
 * again while holding the sole config-writer lock, so an editor can never
 * overwrite a concurrent canonical update.
 */
export function replaceCanonicalUserConfigTextSync(
  snapshot: CanonicalUserConfigSnapshot,
  replacement: string,
): boolean {
  return withCanonicalTargetLock(snapshot.path, target => {
    if (
      target.exists !== snapshot.exists ||
      target.path !== snapshot.targetPath
    ) {
      throw new Error(
        `config changed while the editor was open: ${snapshot.path}`,
      );
    }
    if (target.exists) {
      const current = readFileSync(target.path, "utf8");
      if (current !== snapshot.content) {
        throw new Error(
          `config changed while the editor was open: ${snapshot.path}`,
        );
      }
    }
    const raw = parseCanonicalConfigText(replacement, target.path);
    assertUserConfigDocumentAuthority(raw, target.path);
    if (replacement === snapshot.content) return false;
    const originalHeader = readPluginTransactionHeader(snapshot.content);
    if (originalHeader.ledger !== undefined
      && originalHeader.ledger.target !== pluginConfigTargetDigest(target.path)) {
      throw new Error("plugin transaction metadata belongs to a different config target");
    }
    // The editor cannot create, replace or remove ownership authority. Restore
    // the original metadata and fence observable field edits under the lock.
    const editedHeader = readPluginTransactionHeader(replacement);
    if (editedHeader.ledger !== undefined
      && stableJson(editedHeader.ledger) !== stableJson(originalHeader.ledger ?? null)) {
      throw new Error("editor changed plugin transaction ownership metadata");
    }
    fencePluginTransactionEdits(originalHeader.ledger, cloneRecord(snapshot.raw), raw);
    if (canonicalTarget(snapshot.path) !== target.path) throw new Error("config target changed during edit");
    writeAtomic(target.path, withPluginTransactionHeader(editedHeader.body, originalHeader.ledger), target.mode);
    return true;
  });
}

function prepareAndWrite(
  target: WritableTarget,
  raw: JsonRecord,
  ledger?: PluginTransactionLedger,
): void {
  raw[CANONICAL_CONFIG_VERSION_KEY] = CANONICAL_CONFIG_VERSION;
  validateStrictConfigDocument(raw, target.path);
  const serialized = serializeConfigToml(raw);
  const roundTrip = cloneRecord(parseToml(serialized));
  if (stableJson(roundTrip) !== stableJson(raw)) {
    throw new Error(`canonical config update did not round-trip: ${target.path}`);
  }
  writeAtomic(target.path, withPluginTransactionHeader(serialized, ledger), target.mode);
}
