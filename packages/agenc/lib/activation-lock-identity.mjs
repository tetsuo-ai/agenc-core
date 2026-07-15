// Stable account and wrapper identities shared by the launcher, runtime
// updater, and standalone installers. Wrapper files are atomically replaced,
// so their own inode is intentionally not part of the persistent lock key.

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

let cachedActivationLockRegistry;
const UNSUPPORTED_FILE_ID_64 = 0xffff_ffff_ffff_ffffn;

function hasUsableFileIdentity(stat) {
  return stat.dev !== 0n &&
    stat.ino !== 0n &&
    stat.ino !== -1n &&
    BigInt.asUintN(64, stat.ino) !== UNSUPPORTED_FILE_ID_64;
}

export function existingAgenCHomeIdentity(requested) {
  if (typeof requested !== "string" || !isAbsolute(requested)) return undefined;
  try {
    const canonical = realpathSync.native(resolve(requested));
    const stat = lstatSync(canonical, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      stat.uid !== BigInt(process.getuid())
    ) return undefined;
    if (!hasUsableFileIdentity(stat)) return undefined;
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return undefined;
  }
}

function ensureAccountRegistryPath(accountHome, segments, uid) {
  const canonicalHome = realpathSync(accountHome);
  const homeStat = lstatSync(canonicalHome);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
    throw new Error(`account home is not a real directory: ${canonicalHome}`);
  }
  if (uid !== undefined && homeStat.uid !== uid) {
    throw new Error(`account home has the wrong owner: ${canonicalHome}`);
  }
  if (uid !== undefined && (homeStat.mode & 0o022) !== 0) {
    throw new Error(`account home is group/world writable: ${canonicalHome}`);
  }
  let current = canonicalHome;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`activation lock registry path is not a real directory: ${current}`);
    }
    if (uid !== undefined) {
      if (stat.uid !== uid) {
        throw new Error(`activation lock registry path has the wrong owner: ${current}`);
      }
      if ((stat.mode & 0o022) !== 0) {
        throw new Error(`activation lock registry path is group/world writable: ${current}`);
      }
      // AgenC-owned components are private. Do not rewrite conventional
      // account directories such as .local/state or Library/Application Support.
      if (index >= segments.length - 2) chmodSync(current, 0o700);
    }
  }
  return current;
}

export function resolveActivationLockRegistry() {
  if (cachedActivationLockRegistry !== undefined) return cachedActivationLockRegistry;
  if (!["linux", "darwin", "win32"].includes(process.platform)) {
    throw new Error(`unsupported platform for wrapper locking: ${process.platform}`);
  }
  const account = userInfo();
  if (!isAbsolute(account.homedir)) {
    throw new Error("operating-system account home is unavailable");
  }

  let segments;
  let uid;
  if (process.platform === "win32") {
    // os.userInfo().homedir is supplied by the operating system rather than
    // USERPROFILE. Keep the registry under that stable profile root and let
    // the SQLite lock layer enforce local-volume and ACL policy.
    segments = [".agenc-state", "activation-locks"];
  } else {
    if (typeof process.getuid !== "function" || account.uid !== process.getuid()) {
      throw new Error("operating-system account identity is inconsistent");
    }
    uid = process.getuid();
    segments = process.platform === "darwin"
      ? ["Library", "Application Support", "AgenC", "activation-locks"]
      : [".local", "state", "AgenC", "activation-locks"];
  }
  cachedActivationLockRegistry = realpathSync(
    ensureAccountRegistryPath(account.homedir, segments, uid),
  );
  return cachedActivationLockRegistry;
}

export function wrapperActivationLockPath(wrapperPath, registry) {
  const absolute = resolve(wrapperPath);
  const parent = realpathSync.native(dirname(absolute));
  const candidate = join(parent, basename(absolute));
  let entryName = basename(absolute);
  if (existsSync(candidate)) {
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`wrapper is not a regular non-symlink file: ${candidate}`);
    }
    if (stat.nlink > 1) {
      throw new Error(`wrapper must not have hard-link aliases: ${candidate}`);
    }
    entryName = basename(realpathSync.native(candidate));
  }
  const parentStat = lstatSync(parent, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`wrapper parent is not a real directory: ${parent}`);
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    (parentStat.uid !== BigInt(process.getuid()) || (parentStat.mode & 0o022n) !== 0n)
  ) {
    throw new Error(`wrapper parent is not privately owned by the current user: ${parent}`);
  }
  if (!hasUsableFileIdentity(parentStat)) {
    throw new Error(`wrapper parent has no stable filesystem identity: ${parent}`);
  }
  // Do not case-fold Windows paths or entry names. NTFS supports per-directory
  // case sensitivity, so two differently-cased names can be different files.
  // The validated directory identity is stable across aliases and renames;
  // realpath-derived entry casing distinguishes existing wrapper entries.
  const identity = `parent:${parentStat.dev}:${parentStat.ino}:name:${entryName}`;
  const digest = createHash("sha256").update(identity).digest("hex");
  return join(registry, `${digest}.sqlite`);
}
