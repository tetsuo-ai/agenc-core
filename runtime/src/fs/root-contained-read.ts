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
  const files: string[] = [];
  const rejections: ContainedReject[] = [];
  let droppedCount = 0;
  const visited = new Set<string>([start.canonicalPath]);
  const queue: Array<{ readonly path: string; readonly depth: number }> = [
    { path: start.declaredPath, depth: 0 },
  ];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > options.maxDepth) continue;
    let entries: Dirent[];
    try {
      entries = await io.readdir(current.path);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (options.skipDir?.(entry.name) === true) continue;
      const childPath = join(current.path, entry.name);
      const inspected = await inspectContainedPath(root, childPath, io);
      if (!inspected.ok) {
        rejections.push(inspected);
        continue;
      }
      if (inspected.kind === "directory") {
        if (
          current.depth < options.maxDepth &&
          !visited.has(inspected.canonicalPath)
        ) {
          visited.add(inspected.canonicalPath);
          queue.push({ path: inspected.declaredPath, depth: current.depth + 1 });
        }
        continue;
      }
      if (current.depth === 0 && options.includeStartFiles === false) continue;
      if (!options.collectFile(entry.name)) continue;
      if (files.length >= options.maxFiles) droppedCount += 1;
      else files.push(inspected.declaredPath);
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  return { files, droppedCount, rejections };
}

function isInsideContainedRoot(root: ContainedRoot, canonicalPath: string): boolean {
  return (
    canonicalPath === root.canonicalPath ||
    isContained(root.canonicalPath, canonicalPath)
  );
}
