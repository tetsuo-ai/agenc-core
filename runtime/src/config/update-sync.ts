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
import { dirname } from "node:path";

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

function readRaw(path: string): JsonRecord {
  return parseCanonicalConfigText(readFileSync(path, "utf8"), path);
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
  const target = writableTarget(path);
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
  withConfigAuthorityLockSync(path, () => {
    const target = writableTarget(path);
    const raw = target.exists
      ? readRaw(target.path)
      : { [CANONICAL_CONFIG_VERSION_KEY]: CANONICAL_CONFIG_VERSION };
    mergePatch(raw, patch);
    prepareAndWrite(target, raw);
  });
}

/**
 * Sole read-modify-write path for user config editors that need transformations
 * more expressive than a structural patch.
 */
export function mutateCanonicalUserConfigSync(
  path: string,
  mutator: (raw: JsonRecord) => void,
): void {
  withConfigAuthorityLockSync(path, () => {
    const target = writableTarget(path);
    const raw = target.exists
      ? readRaw(target.path)
      : { [CANONICAL_CONFIG_VERSION_KEY]: CANONICAL_CONFIG_VERSION };
    const before = stableJson(raw);
    mutator(raw);
    assertUserConfigDocumentAuthority(raw, target.path);
    if (stableJson(raw) === before) return;
    prepareAndWrite(target, raw);
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
  return withConfigAuthorityLockSync(snapshot.path, () => {
    const target = writableTarget(snapshot.path);
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
    writeAtomic(target.path, replacement, target.mode);
    return true;
  });
}

function prepareAndWrite(
  target: WritableTarget,
  raw: JsonRecord,
): void {
  raw[CANONICAL_CONFIG_VERSION_KEY] = CANONICAL_CONFIG_VERSION;
  validateStrictConfigDocument(raw, target.path);
  const serialized = serializeConfigToml(raw);
  const roundTrip = cloneRecord(parseToml(serialized));
  if (stableJson(roundTrip) !== stableJson(raw)) {
    throw new Error(`canonical config update did not round-trip: ${target.path}`);
  }
  writeAtomic(target.path, serialized, target.mode);
}
