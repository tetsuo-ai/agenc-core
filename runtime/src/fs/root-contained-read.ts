import { type BigIntStats, type Dirent } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  identityFromStats,
  isContained,
  sameStats,
  verifiedFileOpenFlags,
  type FileIdentity,
} from "./verified-read.js";

export type ContainedKind = "file" | "directory";

export type ContainedRejectCode =
  | "not-found"
  | "symlink"
  | "outside-root"
  | "not-file"
  | "not-directory"
  | "changed";

export interface ContainedRoot {
  readonly declaredPath: string;
  readonly canonicalPath: string;
}

export interface ContainedReject {
  readonly ok: false;
  readonly code: ContainedRejectCode;
  readonly declaredPath: string;
}

export interface ContainedInspectOk {
  readonly ok: true;
  readonly kind: ContainedKind;
  readonly declaredPath: string;
  readonly canonicalPath: string;
  readonly identity: FileIdentity;
}

export type ContainedInspect = ContainedInspectOk | ContainedReject;

export interface ContainedReadOk {
  readonly ok: true;
  readonly declaredPath: string;
  readonly text: string;
}

export type ContainedRead = ContainedReadOk | ContainedReject;

export interface ContainedWalkOptions {
  readonly maxDepth: number;
  readonly maxFiles: number;
  readonly collectFile: (name: string) => boolean;
  readonly skipDir?: (name: string) => boolean;
  readonly includeStartFiles?: boolean;
}

export interface ContainedWalkResult {
  readonly files: readonly string[];
  readonly droppedCount: number;
  readonly rejections: readonly ContainedReject[];
}

export interface ContainedRootIo {
  readonly lstat: (path: string) => Promise<BigIntStats>;
  readonly realpath: (path: string) => Promise<string>;
  readonly open: (path: string, flags: number) => Promise<FileHandle>;
  readonly readdir: (path: string) => Promise<Dirent[]>;
}

export const defaultContainedRootIo: ContainedRootIo = {
  lstat: (path) => lstat(path, { bigint: true }),
  realpath,
  open,
  readdir: (path) => readdir(path, { withFileTypes: true }),
};

export const PLUGIN_MARKDOWN_WALK: ContainedWalkOptions = {
  maxDepth: 8,
  maxFiles: 512,
  collectFile: (name) => name.toLowerCase().endsWith(".md"),
};

export function containedRejectReason(code: ContainedRejectCode): string {
  switch (code) {
    case "not-found":
      return "path not found";
    case "symlink":
      return "symbolic link rejected before read";
    case "outside-root":
      return "path resolves outside the verified root";
    case "not-file":
      return "path is not a regular file";
    case "not-directory":
      return "path is not a directory";
    case "changed":
      return "path changed during read";
  }
}

export async function bindContainedRoot(
  path: string,
  io: ContainedRootIo = defaultContainedRootIo,
): Promise<ContainedRoot | null> {
  const declaredPath = resolve(path);
  try {
    await io.lstat(declaredPath);
  } catch {
    return null;
  }
  try {
    const canonicalPath = await io.realpath(declaredPath);
    const canonicalStats = await io.lstat(canonicalPath);
    if (canonicalStats.isSymbolicLink() || !canonicalStats.isDirectory()) {
      return null;
    }
    return { declaredPath, canonicalPath };
  } catch {
    return null;
  }
}

export async function inspectContainedPath(
  root: ContainedRoot,
  candidatePath: string,
  io: ContainedRootIo = defaultContainedRootIo,
): Promise<ContainedInspect> {
  const declaredPath = resolve(candidatePath);
  if (
    declaredPath !== root.declaredPath &&
    !isContained(root.declaredPath, declaredPath)
  ) {
    return { ok: false, code: "outside-root", declaredPath };
  }
  let stats: BigIntStats;
  try {
    stats = await io.lstat(declaredPath);
  } catch {
    return { ok: false, code: "not-found", declaredPath };
  }
  if (stats.isSymbolicLink()) {
    return { ok: false, code: "symlink", declaredPath };
  }
  let canonicalPath: string;
  try {
    canonicalPath = await io.realpath(declaredPath);
  } catch {
    return { ok: false, code: "not-found", declaredPath };
  }
  if (!isInsideContainedRoot(root, canonicalPath)) {
    return { ok: false, code: "outside-root", declaredPath };
  }
  if (stats.isDirectory()) {
    return {
      ok: true,
      kind: "directory",
      declaredPath,
      canonicalPath,
      identity: identityFromStats(stats),
    };
  }
  if (stats.isFile()) {
    return {
      ok: true,
      kind: "file",
      declaredPath,
      canonicalPath,
      identity: identityFromStats(stats),
    };
  }
  return { ok: false, code: "not-file", declaredPath };
}

export async function readContainedUtf8(
  root: ContainedRoot,
  candidatePath: string,
  io: ContainedRootIo = defaultContainedRootIo,
): Promise<ContainedRead> {
  const inspected = await inspectContainedPath(root, candidatePath, io);
  if (!inspected.ok) return inspected;
  if (inspected.kind !== "file") {
    return { ok: false, code: "not-file", declaredPath: inspected.declaredPath };
  }
  let handle: FileHandle;
  try {
    handle = await io.open(inspected.declaredPath, verifiedFileOpenFlags());
  } catch {
    return { ok: false, code: "not-found", declaredPath: inspected.declaredPath };
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameStats(inspected.identity, opened)) {
      return { ok: false, code: "changed", declaredPath: inspected.declaredPath };
    }
    const canonicalPath = await io.realpath(inspected.declaredPath);
    if (!isInsideContainedRoot(root, canonicalPath)) {
      return {
        ok: false,
        code: "outside-root",
        declaredPath: inspected.declaredPath,
      };
    }
    return {
      ok: true,
      declaredPath: inspected.declaredPath,
      text: await handle.readFile("utf8"),
    };
  } finally {
    await handle.close();
  }
}

type ContainedWalkFrame = {
  readonly path: string;
  readonly depth: number;
};

type ContainedWalkState = {
  readonly files: string[];
  readonly rejections: ContainedReject[];
  droppedCount: number;
  readonly visited: Set<string>;
  readonly queue: ContainedWalkFrame[];
};

export async function walkContainedFiles(
  root: ContainedRoot,
  startPath: string,
  options: ContainedWalkOptions,
  io: ContainedRootIo = defaultContainedRootIo,
): Promise<ContainedWalkResult> {
  const start = await inspectContainedPath(root, startPath, io);
  if (!start.ok) {
    return { files: [], droppedCount: 0, rejections: [start] };
  }
  if (start.kind !== "directory") {
    return {
      files: [],
      droppedCount: 0,
      rejections: [{
        ok: false,
        code: "not-directory",
        declaredPath: start.declaredPath,
      }],
    };
  }
  const state: ContainedWalkState = {
    files: [],
    rejections: [],
    droppedCount: 0,
    visited: new Set([start.canonicalPath]),
    queue: [{ path: start.declaredPath, depth: 0 }],
  };
  while (state.queue.length > 0) {
    const current = state.queue.shift()!;
    if (current.depth > options.maxDepth) continue;
    await visitContainedDirectory(root, current, options, io, state);
  }
  state.files.sort((left, right) => left.localeCompare(right));
  return {
    files: state.files,
    droppedCount: state.droppedCount,
    rejections: state.rejections,
  };
}

async function visitContainedDirectory(
  root: ContainedRoot,
  current: ContainedWalkFrame,
  options: ContainedWalkOptions,
  io: ContainedRootIo,
  state: ContainedWalkState,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await io.readdir(current.path);
  } catch {
    return;
  }
  for (const entry of entries) {
    await visitContainedChild(root, current, entry, options, io, state);
  }
}

async function visitContainedChild(
  root: ContainedRoot,
  current: ContainedWalkFrame,
  entry: Dirent,
  options: ContainedWalkOptions,
  io: ContainedRootIo,
  state: ContainedWalkState,
): Promise<void> {
  if (options.skipDir?.(entry.name) === true) return;
  const inspected = await inspectContainedPath(
    root,
    join(current.path, entry.name),
    io,
  );
  if (!inspected.ok) {
    state.rejections.push(inspected);
    return;
  }
  if (inspected.kind === "directory") {
    enqueueContainedDirectory(inspected, current.depth, options.maxDepth, state);
    return;
  }
  if (current.depth === 0 && options.includeStartFiles === false) return;
  if (!options.collectFile(entry.name)) return;
  if (state.files.length >= options.maxFiles) state.droppedCount += 1;
  else state.files.push(inspected.declaredPath);
}

function enqueueContainedDirectory(
  inspected: ContainedInspectOk,
  depth: number,
  maxDepth: number,
  state: ContainedWalkState,
): void {
  if (depth >= maxDepth || state.visited.has(inspected.canonicalPath)) return;
  state.visited.add(inspected.canonicalPath);
  state.queue.push({ path: inspected.declaredPath, depth: depth + 1 });
}

function isInsideContainedRoot(root: ContainedRoot, canonicalPath: string): boolean {
  return (
    canonicalPath === root.canonicalPath ||
    isContained(root.canonicalPath, canonicalPath)
  );
}
