// macOS keeps command-line privacy grants by executable path and code identity.
// Copy the verified release bytes. Never symlink, patch, strip, or re-sign Node.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, fchmodSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export function stableNodePath(home) { return join(home, "bin", "agenc-node"); }

function regular(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`Node must be a regular unaliased file: ${path}`);
  }
  return stat;
}
function hash(path) {
  regular(path);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// A transaction stores only a source inside its verified content-addressed tree.
// Recovery rechecks identity.json and the pinned executable hash before copying.
export function describeStableNode(home, source) {
  home = realpathSync(home);
  const parts = relative(join(home, "runtime"), resolve(source)).split("/");
  if (parts.length !== 6 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(parts[0]) ||
      !/^darwin-(?:arm64|x64)-native-node-abi-\d+-sha256-[a-f0-9]{64}$/.test(parts[1]) ||
      parts.slice(2).join("/") !== "node_modules/.agenc-node/bin/node" ||
      realpathSync(source) !== resolve(source)) {
    throw new Error("stable Node source must be in a macOS content-addressed runtime");
  }
  const tree = join(home, "runtime", parts[0], parts[1]);
  const marker = readFileSync(join(tree, ".agenc-runtime-ok"), "utf8").trim();
  if (marker !== parts[1].slice(-64)) throw new Error("stable Node runtime marker mismatch");
  const identityPath = join(dirname(dirname(source)), "identity.json");
  regular(identityPath);
  const identity = JSON.parse(readFileSync(identityPath, "utf8"));
  if (identity.schemaVersion !== 1 || identity.executable !== "bin/node" ||
      !/^[a-f0-9]{64}$/.test(identity.executableSha256) ||
      regular(source).size !== identity.executableBytes ||
      hash(source) !== identity.executableSha256) {
    throw new Error("stable Node executable identity mismatch");
  }
  return { source: resolve(source), sha256: identity.executableSha256 };
}

function cleanupNodeStaging(directory) {
  for (const name of readdirSync(directory)) {
    const match = /^\.agenc-node-(\d+)-[a-f0-9-]{36}$/.exec(name);
    if (match === null) continue;
    try { process.kill(Number(match[1]), 0); continue; }
    catch (error) { if (error.code !== "ESRCH") continue; }
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid()) {
      rmSync(path);
    }
  }
}

function nodeAlias(target) {
  const alias = join(dirname(target), "node");
  try {
    const stat = lstatSync(alias);
    if (!stat.isSymbolicLink() || readlinkSync(alias) !== basename(target)) {
      throw new Error("stable Node PATH alias is occupied");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    symlinkSync(basename(target), alias);
    syncDirectory(dirname(target));
  }
  return target;
}

export function installStableNode(home, description, checkpoint = () => {}) {
  const checked = describeStableNode(home, description.source);
  if (checked.sha256 !== description.sha256) throw new Error("stable Node journal hash mismatch");
  const target = stableNodePath(home);
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory ||
      stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) {
    throw new Error("stable Node directory is not private and canonical");
  }
  cleanupNodeStaging(directory);
  try {
    if (hash(target) === checked.sha256) return nodeAlias(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = join(directory, `.${basename(target)}-${process.pid}-${randomUUID()}`);
  try {
    copyFileSync(checked.source, temporary, constants.COPYFILE_EXCL);
    if (hash(temporary) !== checked.sha256) throw new Error("stable Node copy checksum mismatch");
    const fd = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fchmodSync(fd, 0o755); fsyncSync(fd); } finally { closeSync(fd); }
    checkpoint("node-staged");
    // rename preserves a running process's old executable mapping. Writing into
    // the existing inode would invalidate signed executable pages on macOS.
    renameSync(temporary, target);
    syncDirectory(directory);
    checkpoint("node-replaced");
    return nodeAlias(target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
