// Cleanup is deliberately macOS-only. Keep Linux/Windows install semantics.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { acquireLocalSqliteLock } from "./sqlite-lock.mjs";

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
function privateDirectory(path, repairWritable = false) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path ||
      stat.uid !== process.getuid()) {
    throw new Error(`runtime maintenance directory is unsafe: ${path}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    if (!repairWritable) throw new Error(`runtime maintenance directory is writable: ${path}`);
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("maintenance directory identity changed");
      fchmodSync(fd, 0o700);
    } finally { closeSync(fd); }
  }
}
function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}-${randomUUID()}`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
    const parent = openSync(dirname(path), "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { rmSync(temporary, { force: true }); }
}
function live(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

// The same lock serializes lease creation and cleanup. A lease spans network
// download, verification, extraction and activation, including their lock gaps.
export async function beginRuntimeUpdate(home, pid = process.pid) {
  const root = join(realpathSync(home), "runtime");
  privateDirectory(root, true);
  const release = await acquireLocalSqliteLock(join(root, ".maintenance-lock.sqlite"), {
    label: "runtime maintenance", timeoutMs: 60_000,
  });
  try {
    const directory = join(root, ".update-leases");
    privateDirectory(directory);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid update pid");
    const path = join(directory, `${pid}-${randomUUID()}.json`);
    atomicJson(path, { pid });
    return path;
  } finally { release(); }
}
export function endRuntimeUpdate(lease) { rmSync(lease, { force: true }); }

export function recordRuntimeActivation(home, current, previous) {
  if (!versionPattern.test(current) || (previous !== undefined && !versionPattern.test(previous))) {
    throw new Error("invalid runtime activation history");
  }
  const path = join(home, "runtime", ".activation-history.json");
  let old;
  try { old = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // Reinstalling the current release must not forget the rollback version.
  if (previous === current || previous === undefined) {
    previous = old?.current === current ? old.previous : old?.current;
  }
  if (old?.current === current && old?.previous === previous) return false;
  atomicJson(path, { current, ...(previous === undefined ? {} : { previous }) });
  return true;
}

function inventoryHelper(root) {
  const { current } = JSON.parse(readFileSync(join(root, ".activation-history.json"), "utf8"));
  if (!versionPattern.test(current)) throw new Error("invalid runtime activation history");
  const version = join(root, current);
  if (lstatSync(version).isSymbolicLink()) throw new Error("unsafe inventory helper parent");
  for (const key of readdirSync(version)) {
    if (!new RegExp(`^darwin-${process.arch}-native-node-abi-\\d+-sha256-[a-f0-9]{64}$`).test(key)) continue;
    const tree = join(version, key);
    if (lstatSync(tree).isSymbolicLink()) continue;
    const marker = join(tree, ".agenc-runtime-ok");
    if (!existsSync(marker) || lstatSync(marker).isSymbolicLink() ||
        readFileSync(marker, "utf8").trim() !== key.slice(-64)) continue;
    let helper = tree;
    for (const part of ["node_modules", "@tetsuo-ai", "runtime", "dist", "agenc-runtime-inventory"]) {
      helper = join(helper, part);
      const stat = lstatSync(helper);
      if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) {
        throw new Error("unsafe runtime inventory helper");
      }
    }
    if (!lstatSync(helper).isFile()) throw new Error("invalid runtime inventory helper");
    return helper;
  }
  throw new Error("runtime inventory helper unavailable");
}

// execFile's timeout still waits for exit/pipe closure. A process stuck in kernel
// I/O may never deliver either, even after SIGKILL. Own the deadline and detach
// every event-loop reference before returning an inconclusive inventory.
function inventoryCommand(file, args, deadline, runCommand) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const expire = () => {
      if (settled) return;
      settled = true;
      reject(new Error("runtime usage inventory deadline exceeded"));
      for (const cleanup of [
        () => child?.kill("SIGKILL"),
        () => child?.stdin?.destroy(),
        () => child?.stdout?.destroy(),
        () => child?.stderr?.destroy(),
        () => child?.unref(),
      ]) { try { cleanup(); } catch { /* detaching must not wait for the child */ } }
    };
    const remaining = deadline - performance.now();
    if (remaining <= 0) { expire(); return; }
    const timer = setTimeout(expire, Math.ceil(remaining));
    try {
      child = runCommand(file, args, {
        encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (settled) return;
        if (performance.now() >= deadline) { expire(); return; }
        settled = true;
        clearTimeout(timer);
        if (error || stderr !== "" || typeof stdout !== "string") {
          reject(new Error("cannot establish running runtime usage", { cause: error }));
        } else resolve(stdout);
      });
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

// Include command lines (JS entrypoints) plus per-PID open files, executable
// mappings, native addons and cwd. The helper walks only this runtime root to
// match inode aliases; it never enumerates mounts or stats unrelated paths.
// A failed, incomplete or truncated inventory disables all cleanup.
export async function runtimeProcessInventory(root, {
  runCommand = execFile, timeoutMs = 30_000, helperPath,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("invalid runtime inventory deadline");
  }
  const deadline = performance.now() + timeoutMs;
  const ps = await inventoryCommand("/bin/ps", ["-axww", "-o", "pid=,command="], deadline, runCommand);
  const files = await inventoryCommand(helperPath ?? inventoryHelper(root), [root], deadline, runCommand);
  const complete = "AGENC_RUNTIME_INVENTORY_OK\n";
  if (!files.endsWith(complete)) throw new Error("incomplete runtime usage inventory");
  return ps + "\n" + files.slice(0, -complete.length);
}
function treeBytes(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return stat.size;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, name) => sum + treeBytes(join(path, name)), 0);
}

export async function pruneRuntimes(home, { inventory = runtimeProcessInventory, checkpoint = () => {} } = {}) {
  const root = join(realpathSync(home), "runtime");
  privateDirectory(root);
  const release = await acquireLocalSqliteLock(join(root, ".maintenance-lock.sqlite"), {
    label: "runtime maintenance", timeoutMs: 60_000,
  });
  let releaseActivation;
  const result = { removed: [], freedBytes: 0, skipped: undefined };
  try {
    releaseActivation = await acquireLocalSqliteLock(join(root, ".activation-lock.sqlite"), {
      label: "runtime prune activation", timeoutMs: 60_000,
    });
    if (existsSync(join(root, ".activation-transaction.json"))) {
      return { ...result, skipped: "activation recovery pending" };
    }
    const leases = join(root, ".update-leases");
    if (existsSync(leases)) {
      privateDirectory(leases);
      for (const name of readdirSync(leases)) {
        const path = join(leases, name);
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
          return { ...result, skipped: "unrecognized update lease" };
        }
        const lease = JSON.parse(readFileSync(path, "utf8"));
        if (!Number.isSafeInteger(lease.pid) || lease.pid <= 0 || live(lease.pid)) {
          return { ...result, skipped: "update in progress" };
        }
        rmSync(path);
      }
    }
    const history = JSON.parse(readFileSync(join(root, ".activation-history.json"), "utf8"));
    if (!versionPattern.test(history.current) || !versionPattern.test(history.previous)) {
      return { ...result, skipped: "two successful activations not recorded" };
    }
    const usage = await inventory(root);
    // Older updater binaries predate leases. Their full command line still
    // identifies an update of this home. Exclude this completed updater itself.
    if (usage.split("\n").some((line) => {
      const command = /^\s*(\d+)\s+(.+)$/.exec(line);
      return command !== null && Number(command[1]) !== process.pid &&
        command[2].includes(root + "/") && /\/agenc(?:\.js)?\s+update(?:\s|$)/.test(command[2]);
    })) return { ...result, skipped: "older updater in progress" };
    for (const version of readdirSync(root)) {
      if (!versionPattern.test(version)) continue;
      const path = join(root, version);
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink() &&
          readdirSync(path).some((name) => name.startsWith("."))) {
        return { ...result, skipped: "runtime extraction or recovery pending" };
      }
    }
    const pruneJournal = join(root, ".prune-transaction.json");
    const removeTree = async (version, treeName, quarantineName, recovering = false) => {
      if (!versionPattern.test(version) ||
          !/^(?:darwin|linux|win)-(?:arm64|x64)-(?:native|glibc)-node-abi-\d+-sha256-[a-f0-9]{64}$/.test(treeName) ||
          !/^\.prune-[a-f0-9-]{36}$/.test(quarantineName)) {
        throw new Error("invalid prune journal");
      }
      const versionDir = join(root, version), tree = join(versionDir, treeName);
      const quarantine = join(root, quarantineName);
      const syncParents = () => {
        for (const path of [versionDir, root]) {
          const fd = openSync(path, "r");
          try { fsyncSync(fd); } finally { closeSync(fd); }
        }
      };
      const restore = () => {
        if (existsSync(quarantine)) {
          if (existsSync(tree)) throw new Error("retained runtime has a pending quarantine copy");
          renameSync(quarantine, tree);
          syncParents();
        }
        rmSync(pruneJournal, { force: true });
      };
      if (version === history.current || version === history.previous) {
        if (recovering) restore();
        return;
      }
      const busy = (snapshot) => [versionDir, quarantine].some((path) =>
        snapshot.includes(path + "/") || snapshot.includes(path + "\n"));
      if (busy(await inventory(root))) {
        if (recovering) restore();
        throw new Error("runtime became busy before pruning");
      }
      if (lstatSync(versionDir).isSymbolicLink()) throw new Error("prune parent changed identity");
      for (const path of [tree, quarantine]) {
        if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) {
          throw new Error("prune tree changed identity");
        }
      }
      if (!recovering) atomicJson(pruneJournal, { version, treeName, quarantineName });
      checkpoint("prune-recorded");
      if (existsSync(tree)) {
        if (existsSync(quarantine)) throw new Error("ambiguous prune recovery state");
        renameSync(tree, quarantine);
        syncParents();
      }
      checkpoint("prune-quarantined");
      // Close the launch-versus-scan race: original launch paths are now absent.
      // A process that entered before rename is visible by its old argv, open
      // descriptors, executable mapping or cwd. Restore its tree instead.
      let afterRename;
      try { afterRename = await inventory(root); }
      catch (error) { restore(); throw error; }
      if (busy(afterRename)) {
        restore();
        throw new Error("runtime became busy during pruning");
      }
      const bytes = existsSync(quarantine) ? treeBytes(quarantine) : 0;
      rmSync(quarantine, { recursive: true, force: true });
      checkpoint("prune-removed");
      rmSync(pruneJournal);
      syncParents();
      result.removed.push(tree);
      result.freedBytes += bytes;
    };
    if (existsSync(pruneJournal)) {
      if (!lstatSync(pruneJournal).isFile() || lstatSync(pruneJournal).isSymbolicLink()) throw new Error("unsafe prune journal");
      const pending = JSON.parse(readFileSync(pruneJournal, "utf8"));
      await removeTree(pending.version, pending.treeName, pending.quarantineName, true);
    }
    for (const name of readdirSync(root)) {
      if (!versionPattern.test(name) || name === history.current || name === history.previous) continue;
      const path = join(root, name);
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) continue;
      // Preserve interrupted extraction/backup trees and their persistent lock
      // identities. Never remove the version directory or SQLite lock files.
      const children = readdirSync(path);
      if (children.some((child) => child.startsWith("."))) continue;
      if (usage.includes(path + "/") || usage.includes(path + "\n")) continue;
      for (const child of children) {
        if (!/^(?:darwin|linux|win)-(?:arm64|x64)-(?:native|glibc)-node-abi-\d+-sha256-[a-f0-9]{64}$/.test(child)) continue;
        const tree = join(path, child);
        const treeStat = lstatSync(tree);
        if (!treeStat.isDirectory() || treeStat.isSymbolicLink()) continue;
        const marker = join(tree, ".agenc-runtime-ok");
        if (!existsSync(marker) || lstatSync(marker).isSymbolicLink() ||
            readFileSync(marker, "utf8").trim() !== child.slice(-64)) continue;
        // A durable per-tree journal makes interrupted recursive removal
        // retryable even if the marker was removed before the crash.
        await removeTree(name, child, `.prune-${randomUUID()}`);
      }
    }
    return result;
  } catch (error) {
    return { ...result, skipped: error.message };
  } finally { releaseActivation?.(); release(); }
}
