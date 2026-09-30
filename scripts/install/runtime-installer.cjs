const { spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const {
  chmodSync: chmodLockSync, closeSync, constants: fsConstants, existsSync,
  fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  mkdtempSync, readFileSync,
  openSync, readdirSync, realpathSync, renameSync, rmSync, statSync,
  writeFileSync, writeSync,
} = require("node:fs");
const {
  basename, dirname, isAbsolute, join, posix, relative, resolve, win32,
  sep: pathSeparator,
} = require("node:path");
const { TextDecoder } = require("node:util");
const { gunzipSync } = require("node:zlib");

const [
  mode, archivePath, installDir, binRel, expectedSha, artifactPlatform,
  provenanceExpectationBase64 = "", provenanceReceiptBase64 = "", extractionTool = "",
  embeddedNodeRel = "", embeddedNodeLibraryRel = "",
] = process.argv.slice(2);
if (!["recover", "install", "activate", "render-wrapper", "prepare-wrapper-directories"].includes(mode)) {
  throw new Error(`invalid runtime installer mode: ${mode}`);
}
const BLOCK_SIZE = 512;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const MAX_SYMLINK_EXPANSIONS = 64;
const decoder = new TextDecoder("utf-8", { fatal: true });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const collisionPaths = new Map();

const WINDOWS_SYSTEM_ROOT_NAMESPACE = String.raw`\\?\GLOBALROOT\SystemRoot`;
const WINDOWS_INVALID_FILE_ID = 0xffff_ffff_ffff_ffffn;
const WINDOWS_EXECUTABLE_FILESYSTEM = {
  lstat: (path) => lstatSync(path, { bigint: true }),
  open: (path) => openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  ),
  fstat: (descriptor) => fstatSync(descriptor, { bigint: true }),
  close: closeSync,
};

function trustedWindowsTarExecutable(
  filesystem = WINDOWS_EXECUTABLE_FILESYSTEM,
  canonicalize = realpathSync.native,
) {
  const systemRoot = canonicalize(WINDOWS_SYSTEM_ROOT_NAMESPACE);
  if (!/^[a-z]:\\/iu.test(systemRoot) || win32.normalize(systemRoot) !== systemRoot) {
    throw new Error(
      "trusted Windows SystemRoot did not resolve to a canonical local DOS path",
    );
  }
  const namespaceExecutable = win32.join(
    WINDOWS_SYSTEM_ROOT_NAMESPACE,
    "System32",
    "tar.exe",
  );
  const executable = win32.join(systemRoot, "System32", "tar.exe");
  verifyWindowsExecutableAliases(namespaceExecutable, executable, filesystem);
  return executable;
}

function verifyWindowsExecutableAliases(namespaceExecutable, executable, filesystem) {
  let namespaceDescriptor;
  let candidateDescriptor;
  let operationError;
  try {
    const namespaceBefore = filesystem.lstat(namespaceExecutable);
    const candidateBefore = filesystem.lstat(executable);
    assertRegularWindowsExecutable(namespaceBefore, "GLOBALROOT path");
    assertRegularWindowsExecutable(candidateBefore, "DOS path");
    namespaceDescriptor = filesystem.open(namespaceExecutable);
    candidateDescriptor = filesystem.open(executable);
    const namespaceOpened = filesystem.fstat(namespaceDescriptor);
    const candidateOpened = filesystem.fstat(candidateDescriptor);
    const namespaceAfter = filesystem.lstat(namespaceExecutable);
    const candidateAfter = filesystem.lstat(executable);
    assertRegularWindowsExecutable(namespaceOpened, "GLOBALROOT descriptor");
    assertRegularWindowsExecutable(candidateOpened, "DOS descriptor");
    assertRegularWindowsExecutable(namespaceAfter, "GLOBALROOT path");
    assertRegularWindowsExecutable(candidateAfter, "DOS path");
    for (const identity of [
      namespaceBefore,
      candidateBefore,
      namespaceOpened,
      candidateOpened,
      namespaceAfter,
      candidateAfter,
    ]) {
      if (
        identity.dev <= 0n || identity.ino <= 0n ||
        identity.dev === WINDOWS_INVALID_FILE_ID ||
        identity.ino === WINDOWS_INVALID_FILE_ID
      ) {
        throw new Error("trusted Windows system executable identity is unavailable");
      }
    }
    if (
      !sameWindowsExecutableIdentity(namespaceBefore, namespaceOpened) ||
      !sameWindowsExecutableIdentity(namespaceOpened, namespaceAfter) ||
      !sameWindowsExecutableIdentity(candidateBefore, candidateOpened) ||
      !sameWindowsExecutableIdentity(candidateOpened, candidateAfter) ||
      !sameWindowsExecutableIdentity(namespaceOpened, candidateOpened)
    ) {
      throw new Error("trusted Windows system executable identity mismatch");
    }
  } catch (error) {
    operationError = error;
  }
  const closeErrors = [];
  for (const descriptor of [candidateDescriptor, namespaceDescriptor]) {
    if (descriptor === undefined) continue;
    try { filesystem.close(descriptor); } catch (error) { closeErrors.push(error); }
  }
  if (operationError !== undefined) {
    if (closeErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...closeErrors],
        "trusted Windows executable validation and cleanup both failed",
      );
    }
    throw operationError;
  }
  if (closeErrors.length === 1) throw closeErrors[0];
  if (closeErrors.length > 1) {
    throw new AggregateError(
      closeErrors,
      "trusted Windows executable descriptor cleanup failed",
    );
  }
}

function assertRegularWindowsExecutable(identity, spelling) {
  if (!identity.isFile() || identity.isSymbolicLink()) {
    throw new Error(
      `trusted Windows ${spelling} executable is not a regular non-link file`,
    );
  }
}

function sameWindowsExecutableIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function syncFile(path) {
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try {
    // fsyncSync maps to FlushFileBuffers on Windows, the same durability
    // boundary as FileStream.Flush(true).
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function syncDirectory(path) {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function secureOwnerDirectory(path, { repairWritable, ownerOnly }) {
  const before = lstatSync(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`wrapper directory is not a real directory: ${path}`);
  }
  if (process.platform === "win32") return false;
  const currentUid = process.getuid?.();
  if (currentUid === undefined || before.uid !== BigInt(currentUid)) {
    throw new Error(`wrapper directory is not owned by the current user: ${path}`);
  }
  const shouldRepair = ownerOnly ||
    (repairWritable && (before.mode & 0o022n) !== 0n);
  if (!shouldRepair) return false;
  if (
    !Number.isInteger(fsConstants.O_DIRECTORY) ||
    !Number.isInteger(fsConstants.O_NOFOLLOW)
  ) {
    throw new Error("secure wrapper directory repair is unsupported on this platform");
  }
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isDirectory() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.uid !== before.uid
    ) {
      throw new Error(`wrapper directory identity changed during repair: ${path}`);
    }
    const targetMode = ownerOnly
      ? 0o700
      : Number((opened.mode & 0o7777n) & ~0o022n);
    fchmodSync(descriptor, targetMode);
    const secured = fstatSync(descriptor, { bigint: true });
    if (
      !secured.isDirectory() ||
      secured.dev !== before.dev ||
      secured.ino !== before.ino ||
      secured.uid !== before.uid ||
      (secured.mode & 0o022n) !== 0n
    ) {
      throw new Error(`wrapper directory could not be secured: ${path}`);
    }
  } finally {
    closeSync(descriptor);
  }
  return true;
}
function writeFileDurably(path, content, { flag = "w", mode = 0o600 } = {}) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const descriptor = openSync(path, flag, mode);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (written === 0) throw new Error(`write made no progress: ${path}`);
      offset += written;
    }
    try { fchmodSync(descriptor, mode); } catch { /* Windows mode is advisory */ }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function syncTree(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    for (const name of readdirSync(path)) syncTree(join(path, name));
    syncDirectory(path);
  } else if (metadata.isFile()) {
    syncFile(path);
  }
}
function removeDurably(path, options = { force: true }) {
  rmSync(path, options);
  syncDirectory(dirname(path));
}

function field(block, start, length) {
  const bytes = block.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}
function octal(block, start, length, label) {
  const raw = field(block, start, length).trim();
  if (!/^[0-7]+$/.test(raw)) throw new Error(`invalid tar ${label}`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid tar ${label}`);
  return value;
}
function validateChecksum(block) {
  const expected = octal(block, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (actual !== expected) throw new Error("invalid tar header checksum");
}
function parsePax(data) {
  const values = {};
  const seenKeys = new Set();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error("invalid PAX record length");
    const lengthText = data.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error("invalid PAX record length");
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > data.length || data[end - 1] !== 0x0a) {
      throw new Error("invalid PAX record boundary");
    }
    const record = decoder.decode(data.subarray(space + 1, end - 1));
    const equals = record.indexOf("=");
    if (equals <= 0) throw new Error("invalid PAX record");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (seenKeys.has(key)) throw new Error(`duplicate PAX key: ${key}`);
    seenKeys.add(key);
    if (key === "path" || key === "linkpath") values[key] = value;
    else if (key === "size") {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid PAX size");
      const size = Number(value);
      if (!Number.isSafeInteger(size) || size > MAX_UNCOMPRESSED_BYTES) throw new Error("invalid PAX size");
      values.size = size;
    } else if (["mtime", "atime", "ctime"].includes(key)) {
      if (!/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) throw new Error(`invalid PAX ${key}`);
    } else throw new Error(`unsupported PAX key: ${key}`);
    offset = end;
  }
  return values;
}
function validateMemberPath(path) {
  if (!path || /[\\\x00-\x1f\x7f]/.test(path) || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`unsafe runtime archive path: ${path || "(empty)"}`);
  }
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`unsafe runtime archive path: ${path}`);
  }
  if (trimmed !== "node_modules" && !trimmed.startsWith("node_modules/")) {
    throw new Error(`runtime archive member is outside node_modules: ${path}`);
  }
  if (artifactPlatform === "win" || artifactPlatform === "darwin") {
    let prefix = "";
    for (const part of parts) {
      if (/[. ]$/.test(part) ||
          (artifactPlatform === "win" && (part.includes(":") || /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(part)))) {
        throw new Error(`unsafe runtime archive path for ${artifactPlatform}: ${path}`);
      }
      prefix = prefix ? `${prefix}/${part}` : part;
      const collisionKey = prefix.normalize("NFC").toLowerCase();
      const prior = collisionPaths.get(collisionKey);
      if (prior !== undefined && prior !== prefix) {
        throw new Error(`runtime archive has a case/Unicode path collision: ${prior} and ${prefix}`);
      }
      collisionPaths.set(collisionKey, prefix);
    }
  }
  return trimmed;
}
function validateLink(memberPath, linkPath) {
  if (!linkPath || /[\\\x00-\x1f\x7f]/.test(linkPath) || linkPath.startsWith("/") || /^[A-Za-z]:/.test(linkPath)) {
    throw new Error(`unsafe runtime archive link target: ${linkPath || "(empty)"}`);
  }
  if ((artifactPlatform === "win" || artifactPlatform === "darwin") &&
      linkPath.split("/").some((part) => part !== "." && part !== ".." &&
        (/[. ]$/.test(part) ||
          (artifactPlatform === "win" && (part.includes(":") || /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(part)))))) {
    throw new Error(`unsafe runtime archive link target for ${artifactPlatform}: ${linkPath}`);
  }
  const resolved = posix.normalize(posix.join(posix.dirname(memberPath), linkPath));
  if (resolved !== "node_modules" && !resolved.startsWith("node_modules/")) {
    throw new Error(`runtime archive link escapes node_modules: ${memberPath} -> ${linkPath}`);
  }
}
function resolveArchiveGraphPath(components, links) {
  const pending = [...components];
  const resolved = [];
  let expansions = 0;
  let steps = 0;
  while (pending.length > 0) {
    if (++steps > MAX_ENTRIES + MAX_SYMLINK_EXPANSIONS) throw new Error("runtime archive symlink resolution is too complex");
    const part = pending.shift() ?? "";
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (resolved.length === 0) throw new Error("runtime archive symlink graph escapes the extraction root");
      resolved.pop();
      continue;
    }
    resolved.push(part);
    const target = links.get(resolved.join("/"));
    if (target === undefined) continue;
    if (++expansions > MAX_SYMLINK_EXPANSIONS) throw new Error("runtime archive symlink graph contains a cycle or excessive depth");
    resolved.pop();
    pending.unshift(...target.split("/"));
  }
  return resolved.join("/");
}
function assertGraphResultWithinNodeModules(path) {
  if (path !== "node_modules" && !path.startsWith("node_modules/")) {
    throw new Error(`runtime archive symlink graph escapes node_modules: ${path || "(root)"}`);
  }
}
function validateSymlinkGraph(members, links) {
  for (const member of members) {
    if (member.type === "2") {
      const parent = posix.dirname(member.path);
      if (parent !== ".") assertGraphResultWithinNodeModules(resolveArchiveGraphPath(parent.split("/"), links));
      const target = links.get(member.path);
      if (target === undefined) throw new Error(`missing runtime archive link target: ${member.path}`);
      assertGraphResultWithinNodeModules(resolveArchiveGraphPath([
        ...(parent === "." ? [] : parent.split("/")),
        ...target.split("/"),
      ], links));
    } else {
      assertGraphResultWithinNodeModules(resolveArchiveGraphPath(member.path.split("/"), links));
    }
  }
}
function validateArchive(path) {
  const compressed = readFileSync(path);
  const archiveSha = createHash("sha256").update(compressed).digest("hex");
  if (archiveSha !== expectedSha) throw new Error("runtime archive changed after checksum verification");
  const archive = gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  let offset = 0;
  let entries = 0;
  let pendingPax;
  const seen = new Set();
  const members = [];
  const links = new Map();
  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    validateChecksum(header);
    const size = octal(header, 124, 12, "entry size");
    const dataStart = offset + BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new Error("truncated tar entry");
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = field(header, 345, 155);
    const headerPath = [prefix, field(header, 0, 100)].filter(Boolean).join("/");
    const headerLink = field(header, 157, 100);
    if (type === "x") {
      if (pendingPax !== undefined) throw new Error("stacked PAX headers are not allowed");
      pendingPax = parsePax(archive.subarray(dataStart, dataEnd));
    } else {
      if (pendingPax?.size !== undefined && pendingPax.size !== size) throw new Error("PAX size does not match tar header size");
      if (!["0", "5", "2"].includes(type)) throw new Error(`unsupported runtime archive member type: ${type}`);
      const memberPath = validateMemberPath(pendingPax?.path ?? headerPath);
      if (seen.has(memberPath)) throw new Error(`duplicate runtime archive member: ${memberPath}`);
      seen.add(memberPath);
      if (type === "2") {
        const linkPath = pendingPax?.linkpath ?? headerLink;
        validateLink(memberPath, linkPath);
        links.set(memberPath, linkPath);
      }
      members.push({ path: memberPath, type });
      pendingPax = undefined;
      entries += 1;
      if (entries > MAX_ENTRIES) throw new Error("runtime archive has too many entries");
    }
    offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  if (pendingPax !== undefined) throw new Error("orphaned PAX header");
  if (entries === 0 || !seen.has("node_modules")) throw new Error("runtime archive is empty or missing node_modules");
  validateSymlinkGraph(members, links);
}
// BEGIN GENERATED AGENC SQLITE LOCK MODULE
// Generated by scripts/sync-installer-sqlite-lock.mjs from the canonical
// launcher module. Do not edit this embedded payload by hand.
const AGENC_SQLITE_LOCK_SOURCE_BASE64 = "Ly8gQ3Jvc3MtcHJvY2VzcyBsb2NhbCBmaWxlc3lzdGVtIGxvY2tzIGJhY2tlZCBieSBTUUxpdGUncyBPUyBsb2NraW5nIGxheWVyLgovLwovLyBCRUdJTiBJTU1FRElBVEUgb3ducyB0aGUgd3JpdGVyIHJlc2VydmF0aW9uIGZvciB0aGUgY2FsbGVyJ3MgY3JpdGljYWwKLy8gc2VjdGlvbi4gU1FMaXRlIHJlbGVhc2VzIGl0IG9uIGNsb3NlIG9yIHByb2Nlc3MgZGVhdGgsIGluY2x1ZGluZyBTSUdLSUxMLgovLyBBIHByb2Nlc3Mtd2lkZSBGSUZPIHJlZ2lzdHJ5IHByZXZlbnRzIGR1cGxpY2F0ZSBtb2R1bGUgaW5zdGFuY2VzIGZyb20KLy8gYmxvY2tpbmcgb25lIGFub3RoZXIgaW5zaWRlIHN5bmNocm9ub3VzIFNRTGl0ZSBjYWxsczsgY3Jvc3MtcHJvY2VzcyBidXN5Ci8vIGNvbnRlbnRpb24gaXMgcmV0cmllZCBhc3luY2hyb25vdXNseSBhZ2FpbnN0IG9uZSBtb25vdG9uaWMgZGVhZGxpbmUuCgppbXBvcnQgeyBleGVjRmlsZSB9IGZyb20gIm5vZGU6Y2hpbGRfcHJvY2VzcyI7CmltcG9ydCB7CiAgY2xvc2VTeW5jLAogIGNvbnN0YW50cyBhcyBmc0NvbnN0YW50cywKICBmc3RhdFN5bmMsCiAgbHN0YXRTeW5jLAogIG9wZW5TeW5jLAogIHJlYWxwYXRoU3luYywKfSBmcm9tICJub2RlOmZzIjsKaW1wb3J0IHsKICBjaG1vZCwKICBsc3RhdCwKICBta2RpciwKICBvcGVuLAogIHJlYWRGaWxlLAogIHJlYWxwYXRoLAp9IGZyb20gIm5vZGU6ZnMvcHJvbWlzZXMiOwppbXBvcnQgewogIGJhc2VuYW1lLAogIGRpcm5hbWUsCiAgam9pbiwKICByZXNvbHZlLAogIHNlcCwKICB3aW4zMiwKfSBmcm9tICJub2RlOnBhdGgiOwppbXBvcnQgeyBzZXRUaW1lb3V0IGFzIGRlbGF5IH0gZnJvbSAibm9kZTp0aW1lcnMvcHJvbWlzZXMiOwoKY29uc3QgTE9DS19BUFBMSUNBVElPTl9JRCA9IDB4NDE0NzRlNDM7IC8vICJBR05DIgpjb25zdCBMT0NLX0ZPUk1BVF9WRVJTSU9OID0gMTsKY29uc3QgU1FMSVRFX0JVU1kgPSA1Owpjb25zdCBSRUdJU1RSWV9WRVJTSU9OID0gMTsKY29uc3QgUkVHSVNUUllfU1lNQk9MID0gU3ltYm9sLmZvcigiQHRldHN1by1haS9hZ2VuYy5zcWxpdGUtbG9jay1yZWdpc3RyeSIpOwpjb25zdCBNQVhfQlVTWV9SRVRSWV9NUyA9IDUwOwpjb25zdCBNQVhfVElNRVJfREVMQVlfTVMgPSAyXzE0N180ODNfNjQ3Owpjb25zdCBVTlNVUFBPUlRFRF9GSUxFX0lEXzY0ID0gMHhmZmZmX2ZmZmZfZmZmZl9mZmZmbjsKY29uc3QgV0lORE9XU19QQVRIX1RSQU5TUE9SVF9NQVhfQ0hBUlMgPSAxNl8zODQ7CmNvbnN0IFdJTkRPV1NfUEFUSF9UUkFOU1BPUlRfTUFYX0VOVFJJRVMgPSAxMjg7CmNvbnN0IFdJTkRPV1NfU1lTVEVNX1JPT1QgPSBTdHJpbmcucmF3YFxcP1xHTE9CQUxST09UXFN5c3RlbVJvb3RgOwpjb25zdCBXSU5ET1dTX0VYRUNVVEFCTEVfRklMRVNZU1RFTSA9IHsKICBsc3RhdDogKHBhdGgpID0+IGxzdGF0U3luYyhwYXRoLCB7IGJpZ2ludDogdHJ1ZSB9KSwKICBvcGVuOiAocGF0aCkgPT4gb3BlblN5bmMoCiAgICBwYXRoLAogICAgZnNDb25zdGFudHMuT19SRE9OTFkgfCAoZnNDb25zdGFudHMuT19OT0ZPTExPVyA/PyAwKSwKICApLAogIGZzdGF0OiAoZGVzY3JpcHRvcikgPT4gZnN0YXRTeW5jKGRlc2NyaXB0b3IsIHsgYmlnaW50OiB0cnVlIH0pLAogIGNsb3NlOiBjbG9zZVN5bmMsCn07CmNvbnN0IExPQ0FMX0ZJTEVTWVNURU1fVFlQRVMgPSBuZXcgU2V0KFsKICAiYXBmcyIsICJiY2FjaGVmcyIsICJidHJmcyIsICJleGZhdCIsICJleHQyIiwgImV4dDMiLCAiZXh0NCIsICJmMmZzIiwKICAiaGZzIiwgImhmc3BsdXMiLCAiamZzIiwgIm1zZG9zIiwgIm5pbGZzMiIsICJudGZzIiwgIm50ZnMzIiwgIm92ZXJsYXkiLAogICJyYW1mcyIsICJyZWlzZXJmcyIsICJ0bXBmcyIsICJ1YmlmcyIsICJ1ZnMiLCAidmZhdCIsICJ4ZnMiLCAiemZzIiwKXSk7CmNvbnN0IERBUldJTl9BQ0xfUkVBRF9SSUdIVFMgPSBuZXcgU2V0KFsKICAicmVhZCIsICJsaXN0IiwgInNlYXJjaCIsICJleGVjdXRlIiwgInJlYWRhdHRyIiwgInJlYWRleHRhdHRyIiwgInJlYWRzZWN1cml0eSIsCl0pOwpjb25zdCBEQVJXSU5fQUNMX0lOSEVSSVRBTkNFX0ZMQUdTID0gbmV3IFNldChbCiAgImZpbGVfaW5oZXJpdCIsICJkaXJlY3RvcnlfaW5oZXJpdCIsICJsaW1pdF9pbmhlcml0IiwgIm9ubHlfaW5oZXJpdCIsCl0pOwpjb25zdCBEQVJXSU5fQUNMX01VVEFUSU9OX1JJR0hUUyA9IG5ldyBTZXQoWwogICJ3cml0ZSIsICJhcHBlbmQiLCAiYWRkX2ZpbGUiLCAiYWRkX3N1YmRpcmVjdG9yeSIsICJkZWxldGUiLCAiZGVsZXRlX2NoaWxkIiwKICAid3JpdGVhdHRyIiwgIndyaXRlZXh0YXR0ciIsICJ3cml0ZXNlY3VyaXR5IiwgImNob3duIiwKXSk7CmNvbnN0IERBUldJTl9BQ0xfS05PV05fVE9LRU5TID0gbmV3IFNldChbCiAgLi4uREFSV0lOX0FDTF9SRUFEX1JJR0hUUywKICAuLi5EQVJXSU5fQUNMX0lOSEVSSVRBTkNFX0ZMQUdTLAogIC4uLkRBUldJTl9BQ0xfTVVUQVRJT05fUklHSFRTLApdKTsKY29uc3QgREFSV0lOX0FDTF9WRVJESUNUX0NBQ0hFX0xJTUlUID0gNTEyOwpjb25zdCBkYXJ3aW5BY2xWZXJkaWN0cyA9IG5ldyBNYXAoKTsKCmNvbnN0IFdJTkRPV1NfU0VDVVJJVFlfU0NSSVBUID0gU3RyaW5nLnJhd2AKJEVycm9yQWN0aW9uUHJlZmVyZW5jZSA9ICdTdG9wJwojIEtlZXAgdGhpcyBkaXJlY3QtLk5FVCBvbmx5OiBtb2R1bGUgYXV0b2xvYWQgY2FuIGV4aGF1c3QgdGhlIHNoYXJlZCBsb2NrIGRlYWRsaW5lLgokdHJhbnNwb3J0ID0gW3N0cmluZ10kZW52OkFHRU5DX0xPQ0tfUEFUSFMKaWYgKFtzdHJpbmddOjpJc051bGxPckVtcHR5KCR0cmFuc3BvcnQpIC1vciAkdHJhbnNwb3J0Lkxlbmd0aCAtZ3QgJHtXSU5ET1dTX1BBVEhfVFJBTlNQT1JUX01BWF9DSEFSU30pIHsKICB0aHJvdyAnaW52YWxpZCBwcm90ZWN0ZWQtcGF0aCB0cmFuc3BvcnQnCn0KJGVudHJpZXMgPSBbc3RyaW5nW11dJHRyYW5zcG9ydC5TcGxpdChbY2hhcl0xMCkKaWYgKCRlbnRyaWVzLkNvdW50IC1sdCAxIC1vciAkZW50cmllcy5Db3VudCAtZ3QgJHtXSU5ET1dTX1BBVEhfVFJBTlNQT1JUX01BWF9FTlRSSUVTfSkgewogIHRocm93ICdpbnZhbGlkIHByb3RlY3RlZC1wYXRoIHRyYW5zcG9ydCcKfQokY3VycmVudFNpZCA9IFtTeXN0ZW0uU2VjdXJpdHkuUHJpbmNpcGFsLldpbmRvd3NJZGVudGl0eV06OkdldEN1cnJlbnQoKS5Vc2VyLlZhbHVlCiR0cnVzdGVkID0gQCgKICAkY3VycmVudFNpZCwKICAnUy0xLTUtMTgnLAogICdTLTEtNS0zMi01NDQnLAogICdTLTEtNS04MC05NTYwMDg4ODUtMzQxODUyMjY0OS0xODMxMDM4MDQ0LTE4NTMyOTI2MzEtMjI3MTQ3ODQ2NCcKKQojIFNwZWNpZmljIG11dGF0aW9uIHJpZ2h0cyBwbHVzIEdFTkVSSUNfV1JJVEUgYW5kIEdFTkVSSUNfQUxMLgokbGVhZk11dGF0aW9uTWFzayA9IFtpbnQ2NF0xMzQzMDI5NTkwCiRhbmNlc3Rvck11dGF0aW9uTWFzayA9IFtpbnQ2NF0xMzQzMDI5NTg2CmZvcmVhY2ggKCRlbnRyeSBpbiAkZW50cmllcykgewogICRzZXBhcmF0b3IgPSAkZW50cnkuSW5kZXhPZihbY2hhcl01OCkKICBpZiAoJHNlcGFyYXRvciAtbHQgMSAtb3IgJHNlcGFyYXRvciAtZXEgKCRlbnRyeS5MZW5ndGggLSAxKSkgewogICAgdGhyb3cgJ2ludmFsaWQgcHJvdGVjdGVkLXBhdGggdHJhbnNwb3J0JwogIH0KICAkcm9sZSA9ICRlbnRyeS5TdWJzdHJpbmcoMCwgJHNlcGFyYXRvcikKICBpZiAoQCgnbGVhZkRpcmVjdG9yeScsICdhbmNlc3RvckRpcmVjdG9yeScsICdmaWxlJykgLW5vdGNvbnRhaW5zICRyb2xlKSB7CiAgICB0aHJvdyAiaW52YWxpZCBwcm90ZWN0ZWQtcGF0aCByb2xlOiAkcm9sZSIKICB9CiAgJGVuY29kZWRQYXRoID0gJGVudHJ5LlN1YnN0cmluZygkc2VwYXJhdG9yICsgMSkKICBpZiAoKCRlbmNvZGVkUGF0aC5MZW5ndGggJSA0KSAtbmUgMCkgeyB0aHJvdyAnaW52YWxpZCBwcm90ZWN0ZWQtcGF0aCB0cmFuc3BvcnQnIH0KICAkcGF0aEJ5dGVzID0gW1N5c3RlbS5Db252ZXJ0XTo6RnJvbUJhc2U2NFN0cmluZygkZW5jb2RlZFBhdGgpCiAgaWYgKCgkcGF0aEJ5dGVzLkxlbmd0aCAlIDIpIC1uZSAwKSB7IHRocm93ICdpbnZhbGlkIHByb3RlY3RlZC1wYXRoIHRyYW5zcG9ydCcgfQogIGlmIChbU3lzdGVtLkNvbnZlcnRdOjpUb0Jhc2U2NFN0cmluZygkcGF0aEJ5dGVzKSAtY25lICRlbmNvZGVkUGF0aCkgewogICAgdGhyb3cgJ25vbi1jYW5vbmljYWwgcHJvdGVjdGVkLXBhdGggdHJhbnNwb3J0JwogIH0KICAkcGF0aENoYXJhY3RlcnMgPSBbY2hhcltdXTo6bmV3KFtpbnRdKCRwYXRoQnl0ZXMuTGVuZ3RoIC8gMikpCiAgZm9yICgkaW5kZXggPSAwOyAkaW5kZXggLWx0ICRwYXRoQ2hhcmFjdGVycy5MZW5ndGg7ICRpbmRleCArPSAxKSB7CiAgICAkYnl0ZU9mZnNldCA9ICRpbmRleCAqIDIKICAgICRsb3dCeXRlID0gW2ludF0kcGF0aEJ5dGVzWyRieXRlT2Zmc2V0XQogICAgJGhpZ2hCeXRlID0gW2ludF0kcGF0aEJ5dGVzWyRieXRlT2Zmc2V0ICsgMV0KICAgICRwYXRoQ2hhcmFjdGVyc1skaW5kZXhdID0gW2NoYXJdKCRsb3dCeXRlIC1ib3IgKCRoaWdoQnl0ZSAtc2hsIDgpKQogIH0KICAkcmVxdWVzdGVkID0gW3N0cmluZ106Om5ldygkcGF0aENoYXJhY3RlcnMpCiAgJG11dGF0aW9uTWFzayA9IGlmICgkcm9sZSAtZXEgJ2FuY2VzdG9yRGlyZWN0b3J5JykgewogICAgJGFuY2VzdG9yTXV0YXRpb25NYXNrCiAgfSBlbHNlIHsKICAgICRsZWFmTXV0YXRpb25NYXNrCiAgfQogICRmdWxsID0gW1N5c3RlbS5JTy5QYXRoXTo6R2V0RnVsbFBhdGgoJHJlcXVlc3RlZCkKICBpZiAoJGZ1bGwuU3RhcnRzV2l0aCgnXFwnKSAtb3IgJGZ1bGwuU3RhcnRzV2l0aCgnXFw/XCcpIC1vciAkZnVsbC5TdGFydHNXaXRoKCdcXC5cJykpIHsKICAgIHRocm93ICJuZXR3b3JrIGFuZCBkZXZpY2UgcGF0aHMgYXJlIHVuc3VwcG9ydGVkOiAkZnVsbCIKICB9CiAgJGF0dHJpYnV0ZXMgPSBbU3lzdGVtLklPLkZpbGVdOjpHZXRBdHRyaWJ1dGVzKCRmdWxsKQogIGlmICgoJGF0dHJpYnV0ZXMgLWJhbmQgW1N5c3RlbS5JTy5GaWxlQXR0cmlidXRlc106OlJlcGFyc2VQb2ludCkgLW5lIDApIHsKICAgIHRocm93ICJyZXBhcnNlIHBvaW50cyBhcmUgdW5zdXBwb3J0ZWQ6ICRmdWxsIgogIH0KICAkaXNEaXJlY3RvcnkgPSAoJGF0dHJpYnV0ZXMgLWJhbmQgW1N5c3RlbS5JTy5GaWxlQXR0cmlidXRlc106OkRpcmVjdG9yeSkgLW5lIDAKICBpZiAoJGlzRGlyZWN0b3J5IC1uZSAoJHJvbGUgLW5lICdmaWxlJykpIHsKICAgIHRocm93ICJwcm90ZWN0ZWQtcGF0aCByb2xlIGRvZXMgbm90IG1hdGNoIGl0cyB0eXBlOiAkZnVsbCIKICB9CiAgJGRyaXZlID0gW1N5c3RlbS5JTy5Ecml2ZUluZm9dOjpuZXcoW1N5c3RlbS5JTy5QYXRoXTo6R2V0UGF0aFJvb3QoJGZ1bGwpKQogIGlmIChAKDIsIDMsIDYpIC1ub3Rjb250YWlucyBbaW50XSRkcml2ZS5Ecml2ZVR5cGUpIHsKICAgIHRocm93ICJub24tbG9jYWwgZHJpdmUgaXMgdW5zdXBwb3J0ZWQ6ICRmdWxsIgogIH0KICBpZiAoJGRyaXZlLkRyaXZlRm9ybWF0IC1uZSAnTlRGUycpIHsKICAgIHRocm93ICJmaWxlc3lzdGVtIGNhbm5vdCBlbmZvcmNlIHRoZSByZXF1aXJlZCBBQ0wgY29udHJhY3Q6ICRmdWxsIgogIH0KICAkYWNsU2VjdGlvbnMgPSBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuQWNjZXNzQ29udHJvbFNlY3Rpb25zXTo6T3duZXIgLWJvciBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuQWNjZXNzQ29udHJvbFNlY3Rpb25zXTo6QWNjZXNzCiAgaWYgKCRpc0RpcmVjdG9yeSkgewogICAgJGFjbCA9IFtTeXN0ZW0uSU8uRGlyZWN0b3J5XTo6R2V0QWNjZXNzQ29udHJvbCgkZnVsbCwgJGFjbFNlY3Rpb25zKQogIH0gZWxzZSB7CiAgICAkYWNsID0gW1N5c3RlbS5JTy5GaWxlXTo6R2V0QWNjZXNzQ29udHJvbCgkZnVsbCwgJGFjbFNlY3Rpb25zKQogIH0KICBpZiAoLW5vdCAkYWNsLkFyZUFjY2Vzc1J1bGVzQ2Fub25pY2FsKSB7CiAgICB0aHJvdyAibm9uLWNhbm9uaWNhbCBBQ0wgaXMgdW5zdXBwb3J0ZWQ6ICRmdWxsIgogIH0KICAkYnl0ZXMgPSAkYWNsLkdldFNlY3VyaXR5RGVzY3JpcHRvckJpbmFyeUZvcm0oKQogICRyYXcgPSBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuUmF3U2VjdXJpdHlEZXNjcmlwdG9yXTo6bmV3KCRieXRlcywgMCkKICBpZiAoJG51bGwgLWVxICRyYXcuRGlzY3JldGlvbmFyeUFjbCkgewogICAgdGhyb3cgIm51bGwgREFDTCBpcyB1bnN1cHBvcnRlZDogJGZ1bGwiCiAgfQogICRvd25lciA9ICRhY2wuR2V0T3duZXIoW1N5c3RlbS5TZWN1cml0eS5QcmluY2lwYWwuU2VjdXJpdHlJZGVudGlmaWVyXSkuVmFsdWUKICBpZiAoJHRydXN0ZWQgLW5vdGNvbnRhaW5zICRvd25lcikgewogICAgdGhyb3cgInVudHJ1c3RlZCBvd25lciBTSUQgb24gbG9jayBwYXRoOiAkZnVsbCIKICB9CiAgJHJ1bGVzID0gJGFjbC5HZXRBY2Nlc3NSdWxlcygKICAgICR0cnVlLAogICAgJHRydWUsCiAgICBbU3lzdGVtLlNlY3VyaXR5LlByaW5jaXBhbC5TZWN1cml0eUlkZW50aWZpZXJdCiAgKQogIGZvcmVhY2ggKCRydWxlIGluICRydWxlcykgewogICAgaWYgKCRydWxlLkFjY2Vzc0NvbnRyb2xUeXBlIC1uZSBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuQWNjZXNzQ29udHJvbFR5cGVdOjpBbGxvdykgewogICAgICBjb250aW51ZQogICAgfQogICAgJGluaGVyaXRPbmx5ID0gKCRydWxlLlByb3BhZ2F0aW9uRmxhZ3MgLWJhbmQgW1N5c3RlbS5TZWN1cml0eS5BY2Nlc3NDb250cm9sLlByb3BhZ2F0aW9uRmxhZ3NdOjpJbmhlcml0T25seSkgLW5lIDAKICAgIGlmICgkaW5oZXJpdE9ubHkpIHsKICAgICAgJGNoaWxkSW5oZXJpdGFuY2UgPSBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuSW5oZXJpdGFuY2VGbGFnc106Ok9iamVjdEluaGVyaXQgLWJvciBbU3lzdGVtLlNlY3VyaXR5LkFjY2Vzc0NvbnRyb2wuSW5oZXJpdGFuY2VGbGFnc106OkNvbnRhaW5lckluaGVyaXQKICAgICAgJHJlYWNoZXNOZXdDaGlsZCA9ICgkcnVsZS5Jbmhlcml0YW5jZUZsYWdzIC1iYW5kICRjaGlsZEluaGVyaXRhbmNlKSAtbmUgMAogICAgICBpZiAoJHJvbGUgLW5lICdsZWFmRGlyZWN0b3J5JyAtb3IgLW5vdCAkcmVhY2hlc05ld0NoaWxkKSB7CiAgICAgICAgY29udGludWUKICAgICAgfQogICAgfQogICAgJHNpZCA9ICRydWxlLklkZW50aXR5UmVmZXJlbmNlLlZhbHVlCiAgICAkcmlnaHRzID0gKFtpbnQ2NF0kcnVsZS5GaWxlU3lzdGVtUmlnaHRzKSAtYmFuZCBbaW50NjRdNDI5NDk2NzI5NQogICAgaWYgKCR0cnVzdGVkIC1ub3Rjb250YWlucyAkc2lkIC1hbmQgKCgkcmlnaHRzIC1iYW5kICRtdXRhdGlvbk1hc2spIC1uZSAwKSkgewogICAgICB0aHJvdyAidW50cnVzdGVkIG11dGF0aW9uIEFDRSBvbiBsb2NrIHBhdGg6ICRmdWxsIgogICAgfQogIH0KfQpbQ29uc29sZV06Ok91dC5Xcml0ZSgnT0snKQpgOwpjb25zdCBXSU5ET1dTX1NFQ1VSSVRZX1NDUklQVF9CQVNFNjQgPSBCdWZmZXIuZnJvbSgKICBXSU5ET1dTX1NFQ1VSSVRZX1NDUklQVCwKICAidXRmMTZsZSIsCikudG9TdHJpbmcoImJhc2U2NCIpOwoKZXhwb3J0IGNsYXNzIExvY2FsU3FsaXRlTG9ja1RpbWVvdXRFcnJvciBleHRlbmRzIEVycm9yIHsKICBjb25zdHJ1Y3Rvcih7IHBhdGgsIGxhYmVsLCB0aW1lb3V0TXMsIGNhdXNlIH0pIHsKICAgIHN1cGVyKAogICAgICBgYWdlbmM6ICR7bGFiZWx9IHRpbWVkIG91dCBhZnRlciAke3RpbWVvdXRNc31tcyB3YWl0aW5nIGZvciBsb2NhbCBwcm9jZXNzIGxvY2sgJHtwYXRofWAsCiAgICAgIGNhdXNlID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiB7IGNhdXNlIH0sCiAgICApOwogICAgdGhpcy5uYW1lID0gIkxvY2FsU3FsaXRlTG9ja1RpbWVvdXRFcnJvciI7CiAgICB0aGlzLmNvZGUgPSAiQUdFTkNfTE9DS19USU1FT1VUIjsKICAgIHRoaXMucGF0aCA9IHBhdGg7CiAgICB0aGlzLmxhYmVsID0gbGFiZWw7CiAgICB0aGlzLnRpbWVvdXRNcyA9IHRpbWVvdXRNczsKICB9Cn0KCmZ1bmN0aW9uIHRpbWVvdXRFcnJvcihjb250ZXh0LCBwYXRoLCBjYXVzZSkgewogIHJldHVybiBuZXcgTG9jYWxTcWxpdGVMb2NrVGltZW91dEVycm9yKHsKICAgIHBhdGgsCiAgICBsYWJlbDogY29udGV4dC5sYWJlbCwKICAgIHRpbWVvdXRNczogY29udGV4dC50aW1lb3V0TXMsCiAgICBjYXVzZSwKICB9KTsKfQoKZnVuY3Rpb24gcmVtYWluaW5nTWlsbGlzZWNvbmRzKGNvbnRleHQpIHsKICByZXR1cm4gTWF0aC5mbG9vcihjb250ZXh0LmRlYWRsaW5lIC0gcGVyZm9ybWFuY2Uubm93KCkpOwp9CgpmdW5jdGlvbiB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwYXRoLCBjYXVzZSkgewogIGlmIChyZW1haW5pbmdNaWxsaXNlY29uZHMoY29udGV4dCkgPD0gMCkgewogICAgdGhyb3cgdGltZW91dEVycm9yKGNvbnRleHQsIHBhdGgsIGNhdXNlKTsKICB9Cn0KCmZ1bmN0aW9uIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsIHBoYXNlKSB7CiAgdHJ5IHsKICAgIGNvbnN0IHJlc3VsdCA9IGNvbnRleHQub25Qcm9ncmVzcz8uKHBoYXNlKTsKICAgIGlmIChyZXN1bHQgIT09IHVuZGVmaW5lZCkgewogICAgICB2b2lkIFByb21pc2UucmVzb2x2ZShyZXN1bHQpLmNhdGNoKCgpID0+IHt9KTsKICAgIH0KICB9IGNhdGNoIHsKICAgIC8vIERpYWdub3N0aWNzIG11c3QgbmV2ZXIgY2hhbmdlIGxvY2sgYWNxdWlzaXRpb24gb3IgcmVsZWFzZSBzZW1hbnRpY3MuCiAgfQp9CgpmdW5jdGlvbiBwcm9jZXNzTG9ja1JlZ2lzdHJ5KCkgewogIGNvbnN0IGN1cnJlbnQgPSBwcm9jZXNzW1JFR0lTVFJZX1NZTUJPTF07CiAgaWYgKGN1cnJlbnQgIT09IHVuZGVmaW5lZCkgewogICAgaWYgKAogICAgICBjdXJyZW50ID09PSBudWxsIHx8CiAgICAgIHR5cGVvZiBjdXJyZW50ICE9PSAib2JqZWN0IiB8fAogICAgICBjdXJyZW50LnZlcnNpb24gIT09IFJFR0lTVFJZX1ZFUlNJT04gfHwKICAgICAgIShjdXJyZW50LmxvY2tzIGluc3RhbmNlb2YgTWFwKQogICAgKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigKICAgICAgICAiYWdlbmM6IGluY29tcGF0aWJsZSBwcm9jZXNzLXdpZGUgU1FMaXRlIGxvY2sgcmVnaXN0cnkgaXMgYWxyZWFkeSBpbnN0YWxsZWQiLAogICAgICApOwogICAgfQogICAgcmV0dXJuIGN1cnJlbnQ7CiAgfQogIGNvbnN0IGNyZWF0ZWQgPSB7IHZlcnNpb246IFJFR0lTVFJZX1ZFUlNJT04sIGxvY2tzOiBuZXcgTWFwKCkgfTsKICBPYmplY3QuZGVmaW5lUHJvcGVydHkocHJvY2VzcywgUkVHSVNUUllfU1lNQk9MLCB7CiAgICB2YWx1ZTogY3JlYXRlZCwKICAgIGNvbmZpZ3VyYWJsZTogZmFsc2UsCiAgICBlbnVtZXJhYmxlOiBmYWxzZSwKICAgIHdyaXRhYmxlOiBmYWxzZSwKICB9KTsKICByZXR1cm4gY3JlYXRlZDsKfQoKZnVuY3Rpb24gYWNxdWlyZUluUHJvY2Vzc0xvY2socHJlcGFyZWQsIGNvbnRleHQpIHsKICBjb25zdCByZWdpc3RyeSA9IHByb2Nlc3NMb2NrUmVnaXN0cnkoKTsKICBjb25zdCBrZXkgPSBwcmVwYXJlZC5pZGVudGl0eUtleTsKICBsZXQgc3RhdGUgPSByZWdpc3RyeS5sb2Nrcy5nZXQoa2V5KTsKICBpZiAoc3RhdGUgPT09IHVuZGVmaW5lZCkgewogICAgc3RhdGUgPSB7IGxvY2tlZDogZmFsc2UsIHdhaXRlcnM6IFtdIH07CiAgICByZWdpc3RyeS5sb2Nrcy5zZXQoa2V5LCBzdGF0ZSk7CiAgfQoKICBjb25zdCBtYWtlUmVsZWFzZSA9ICgpID0+IHsKICAgIGxldCByZWxlYXNlZCA9IGZhbHNlOwogICAgcmV0dXJuICgpID0+IHsKICAgICAgaWYgKHJlbGVhc2VkKSByZXR1cm47CiAgICAgIHJlbGVhc2VkID0gdHJ1ZTsKICAgICAgY29uc3QgbmV4dCA9IHN0YXRlLndhaXRlcnMuc2hpZnQoKTsKICAgICAgaWYgKG5leHQgPT09IHVuZGVmaW5lZCkgewogICAgICAgIHN0YXRlLmxvY2tlZCA9IGZhbHNlOwogICAgICAgIHJlZ2lzdHJ5LmxvY2tzLmRlbGV0ZShrZXkpOwogICAgICB9IGVsc2UgewogICAgICAgIGNsZWFyVGltZW91dChuZXh0LnRpbWVyKTsKICAgICAgICBuZXh0LnJlc29sdmUobWFrZVJlbGVhc2UoKSk7CiAgICAgIH0KICAgIH07CiAgfTsKCiAgaWYgKCFzdGF0ZS5sb2NrZWQpIHsKICAgIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHByZXBhcmVkLnBhdGgpOwogICAgc3RhdGUubG9ja2VkID0gdHJ1ZTsKICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUobWFrZVJlbGVhc2UoKSk7CiAgfQoKICBjb25zdCByZW1haW5pbmcgPSByZW1haW5pbmdNaWxsaXNlY29uZHMoY29udGV4dCk7CiAgaWYgKHJlbWFpbmluZyA8PSAwKSB7CiAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QodGltZW91dEVycm9yKGNvbnRleHQsIHByZXBhcmVkLnBhdGgpKTsKICB9CiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlV2FpdCwgcmVqZWN0V2FpdCkgPT4gewogICAgY29uc3Qgd2FpdGVyID0gewogICAgICByZXNvbHZlOiByZXNvbHZlV2FpdCwKICAgICAgdGltZXI6IHVuZGVmaW5lZCwKICAgIH07CiAgICBjb25zdCBhcm1UaW1lb3V0ID0gKCkgPT4gewogICAgICBjb25zdCBkZWxheU1zID0gcmVtYWluaW5nTWlsbGlzZWNvbmRzKGNvbnRleHQpOwogICAgICBpZiAoZGVsYXlNcyA8PSAwKSB7CiAgICAgICAgY29uc3QgaW5kZXggPSBzdGF0ZS53YWl0ZXJzLmluZGV4T2Yod2FpdGVyKTsKICAgICAgICBpZiAoaW5kZXggIT09IC0xKSBzdGF0ZS53YWl0ZXJzLnNwbGljZShpbmRleCwgMSk7CiAgICAgICAgcmVqZWN0V2FpdCh0aW1lb3V0RXJyb3IoY29udGV4dCwgcHJlcGFyZWQucGF0aCkpOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICB3YWl0ZXIudGltZXIgPSBzZXRUaW1lb3V0KGFybVRpbWVvdXQsIE1hdGgubWluKGRlbGF5TXMsIE1BWF9USU1FUl9ERUxBWV9NUykpOwogICAgfTsKICAgIHN0YXRlLndhaXRlcnMucHVzaCh3YWl0ZXIpOwogICAgYXJtVGltZW91dCgpOwogIH0pOwp9CgpmdW5jdGlvbiBkZWNvZGVNb3VudFBhdGgodmFsdWUpIHsKICByZXR1cm4gdmFsdWUucmVwbGFjZSgvXFwoWzAtN117M30pL2csIChfbWF0Y2gsIG9jdGFsKSA9PgogICAgU3RyaW5nLmZyb21DaGFyQ29kZShOdW1iZXIucGFyc2VJbnQob2N0YWwsIDgpKSk7Cn0KCmZ1bmN0aW9uIHBhdGhJc1dpdGhpbihwYXRoLCBtb3VudFBvaW50KSB7CiAgcmV0dXJuIHBhdGggPT09IG1vdW50UG9pbnQgfHwKICAgIHBhdGguc3RhcnRzV2l0aChtb3VudFBvaW50ID09PSBzZXAgPyBtb3VudFBvaW50IDogYCR7bW91bnRQb2ludH0ke3NlcH1gKTsKfQoKZnVuY3Rpb24gZXhlY0ZpbGVVdGY4KGZpbGUsIGFyZ3MsIG9wdGlvbnMsIGNvbnRleHQsIHBhdGgpIHsKICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmVSdW4sIHJlamVjdFJ1bikgPT4gewogICAgbGV0IGRlYWRsaW5lVGltZXI7CiAgICBsZXQgZXhwaXJlZCA9IGZhbHNlOwogICAgY29uc3QgY2hpbGQgPSBleGVjRmlsZSgKICAgICAgZmlsZSwKICAgICAgYXJncywKICAgICAgeyAuLi5vcHRpb25zLCBlbmNvZGluZzogInV0ZjgiIH0sCiAgICAgIChlcnJvciwgc3Rkb3V0LCBzdGRlcnIpID0+IHsKICAgICAgICBpZiAoZGVhZGxpbmVUaW1lciAhPT0gdW5kZWZpbmVkKSBjbGVhclRpbWVvdXQoZGVhZGxpbmVUaW1lcik7CiAgICAgICAgaWYgKGV4cGlyZWQpIHsKICAgICAgICAgIHJlamVjdFJ1bih0aW1lb3V0RXJyb3IoY29udGV4dCwgcGF0aCwgZXJyb3IgPz8gdW5kZWZpbmVkKSk7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIGlmIChlcnJvciAhPT0gbnVsbCkgewogICAgICAgICAgT2JqZWN0LmFzc2lnbihlcnJvciwgeyBzdGRvdXQsIHN0ZGVyciB9KTsKICAgICAgICAgIHJlamVjdFJ1bihlcnJvcik7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIHJlc29sdmVSdW4oeyBzdGRvdXQsIHN0ZGVyciB9KTsKICAgICAgfSwKICAgICk7CiAgICBjb25zdCBhcm1EZWFkbGluZSA9ICgpID0+IHsKICAgICAgY29uc3QgcmVtYWluaW5nID0gcmVtYWluaW5nTWlsbGlzZWNvbmRzKGNvbnRleHQpOwogICAgICBpZiAocmVtYWluaW5nIDw9IDApIHsKICAgICAgICBleHBpcmVkID0gdHJ1ZTsKICAgICAgICBjaGlsZC5raWxsKCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGRlYWRsaW5lVGltZXIgPSBzZXRUaW1lb3V0KAogICAgICAgIGFybURlYWRsaW5lLAogICAgICAgIE1hdGgubWluKHJlbWFpbmluZywgTUFYX1RJTUVSX0RFTEFZX01TKSwKICAgICAgKTsKICAgIH07CiAgICBhcm1EZWFkbGluZSgpOwogIH0pOwp9CgpmdW5jdGlvbiBub3JtYWxpemVUaW1lZENvbW1hbmRFcnJvcihlcnJvciwgY29udGV4dCwgcGF0aCkgewogIGlmICgKICAgIHJlbWFpbmluZ01pbGxpc2Vjb25kcyhjb250ZXh0KSA8PSAwIHx8CiAgICBlcnJvcj8uY29kZSA9PT0gIkVUSU1FRE9VVCIgfHwKICAgIGVycm9yPy5raWxsZWQgPT09IHRydWUKICApIHsKICAgIHJldHVybiB0aW1lb3V0RXJyb3IoY29udGV4dCwgcGF0aCwgZXJyb3IpOwogIH0KICByZXR1cm4gZXJyb3I7Cn0KCmZ1bmN0aW9uIHZhbGlkYXRlRGFyd2luQWNsTGlzdGluZyhzdGRvdXQsIHBhdGgsIHJvbGUpIHsKICBpZiAoc3Rkb3V0LmluY2x1ZGVzKCJcciIpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBEYXJ3aW4gQUNMIGhlbHBlciByZXR1cm5lZCBub24tY2Fub25pY2FsIG91dHB1dCBmb3IgJHtwYXRofWApOwogIH0KICBjb25zdCBsaW5lcyA9IHN0ZG91dC5zcGxpdCgiXG4iKTsKICBpZiAobGluZXMuYXQoLTEpID09PSAiIikgbGluZXMucG9wKCk7CiAgaWYgKGxpbmVzLmxlbmd0aCA9PT0gMCB8fCBsaW5lc1swXS5sZW5ndGggPT09IDApIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IERhcndpbiBBQ0wgaGVscGVyIHJldHVybmVkIG5vIG1ldGFkYXRhIGZvciAke3BhdGh9YCk7CiAgfQogIGxldCBwcmV2aW91c09yZGluYWwgPSAtMTsKICBsZXQgc2F3TGVnYWN5T3duZXIgPSBmYWxzZTsKICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMuc2xpY2UoMSkpIHsKICAgIGlmICgvXlxzKm93bmVyOlxzK1xTLiokL3UudGVzdChsaW5lKSAmJiAhc2F3TGVnYWN5T3duZXIgJiYgcHJldmlvdXNPcmRpbmFsID09PSAtMSkgewogICAgICBzYXdMZWdhY3lPd25lciA9IHRydWU7CiAgICAgIGNvbnRpbnVlOwogICAgfQogICAgY29uc3QgbWF0Y2ggPSBsaW5lLm1hdGNoKAogICAgICAvXlxzKihcZCspOlxzKyguKz8pXHMrKD86KGluaGVyaXRlZClccyspPyhhbGxvd3xkZW55KVxzKyhbYS16X10rKD86LFthLXpfXSspKilccyokL3UsCiAgICApOwogICAgaWYgKG1hdGNoID09PSBudWxsKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IERhcndpbiBBQ0wgaGVscGVyIHJldHVybmVkIHVucmVjb2duaXplZCBvdXRwdXQgZm9yICR7cGF0aH1gKTsKICAgIH0KICAgIGNvbnN0IG9yZGluYWwgPSBOdW1iZXIobWF0Y2hbMV0pOwogICAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcihvcmRpbmFsKSB8fCBvcmRpbmFsIDw9IHByZXZpb3VzT3JkaW5hbCkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBEYXJ3aW4gQUNMIGhlbHBlciByZXR1cm5lZCBpbnZhbGlkIEFDRSBvcmRlcmluZyBmb3IgJHtwYXRofWApOwogICAgfQogICAgcHJldmlvdXNPcmRpbmFsID0gb3JkaW5hbDsKICAgIGNvbnN0IGFzc29jaWF0aW9uID0gbWF0Y2hbNF07CiAgICBjb25zdCB0b2tlbnMgPSBtYXRjaFs1XS5zcGxpdCgiLCIpOwogICAgZm9yIChjb25zdCB0b2tlbiBvZiB0b2tlbnMpIHsKICAgICAgaWYgKCFEQVJXSU5fQUNMX0tOT1dOX1RPS0VOUy5oYXModG9rZW4pKSB7CiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogRGFyd2luIEFDTCBoZWxwZXIgcmV0dXJuZWQgdW5rbm93biByaWdodCAke3Rva2VufTogJHtwYXRofWApOwogICAgICB9CiAgICB9CiAgICBpZiAoCiAgICAgIGFzc29jaWF0aW9uID09PSAiYWxsb3ciICYmCiAgICAgIHRva2Vucy5zb21lKCh0b2tlbikgPT4gREFSV0lOX0FDTF9NVVRBVElPTl9SSUdIVFMuaGFzKHRva2VuKSkKICAgICkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoCiAgICAgICAgYGFnZW5jOiBwcm90ZWN0ZWQgJHtyb2xlfSBoYXMgYSBtdXRhdGlvbi1jYXBhYmxlIERhcndpbiBBQ0w6ICR7cGF0aH1gLAogICAgICApOwogICAgfQogIH0KfQoKYXN5bmMgZnVuY3Rpb24gYXNzZXJ0RGFyd2luUGF0aFNlY3VyaXR5KHBhdGgsIHJvbGUsIGNvbnRleHQpIHsKICByZXR1cm4gYXNzZXJ0RGFyd2luUGF0aFNlY3VyaXR5V2l0aElPKAogICAgcGF0aCwKICAgIHJvbGUsCiAgICBjb250ZXh0LAogICAgZXhlY0ZpbGVVdGY4LAogICAgKGNhbmRpZGF0ZSkgPT4gbHN0YXQoY2FuZGlkYXRlLCB7IGJpZ2ludDogdHJ1ZSB9KSwKICApOwp9CgpmdW5jdGlvbiBkYXJ3aW5BY2xJZGVudGl0eShzdGF0cykgewogIHJldHVybiBbCiAgICBzdGF0cy5kZXYsIHN0YXRzLmlubywgc3RhdHMuY3RpbWVOcyA/PyBzdGF0cy5jdGltZU1zLAogICAgc3RhdHMubW9kZSwgc3RhdHMudWlkLCBzdGF0cy5naWQsCiAgICBwcm9jZXNzLmdldHVpZD8uKCksIHByb2Nlc3MuZ2V0ZXVpZD8uKCksCiAgXS5qb2luKCI6Iik7Cn0KCmFzeW5jIGZ1bmN0aW9uIGFzc2VydERhcndpblBhdGhTZWN1cml0eVdpdGhJTyhwYXRoLCByb2xlLCBjb250ZXh0LCBsaXN0ZXIsIHN0YXRQYXRoKSB7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcGF0aCk7CiAgLy8gQSBEYXJ3aW4gQUNMIGVkaXQgYWR2YW5jZXMgY3RpbWUuIFJlLXN0YXQgb24gZXZlcnkgbG9va3VwIHNvIGFuIG9sZAogIC8vIHN1Y2Nlc3NmdWwgdmVyZGljdCBjYW5ub3QgYXV0aG9yaXplIGEgY2hhbmdlZCBpbm9kZSwgb3duZXIsIG9yIEFDTC4KICBjb25zdCBiZWZvcmUgPSBkYXJ3aW5BY2xJZGVudGl0eShhd2FpdCBzdGF0UGF0aChwYXRoKSk7CiAgY29uc3QgY2FjaGVLZXkgPSBgJHtyb2xlfVwwJHtwYXRofWA7CiAgaWYgKGRhcndpbkFjbFZlcmRpY3RzLmdldChjYWNoZUtleSkgPT09IGJlZm9yZSkgewogICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcGF0aCk7CiAgICByZXR1cm47CiAgfQogIGRhcndpbkFjbFZlcmRpY3RzLmRlbGV0ZShjYWNoZUtleSk7CiAgbGV0IHJlc3VsdDsKICB0cnkgewogICAgcmVzdWx0ID0gYXdhaXQgbGlzdGVyKAogICAgICAiL2Jpbi9scyIsCiAgICAgIFsiLWxkZXEiLCBwYXRoXSwKICAgICAgewogICAgICAgIGVudjogeyBMQ19BTEw6ICJDIiB9LAogICAgICAgIG1heEJ1ZmZlcjogMjU2ICogMTAyNCwKICAgICAgfSwKICAgICAgY29udGV4dCwKICAgICAgcGF0aCwKICAgICk7CiAgfSBjYXRjaCAoZXJyb3IpIHsKICAgIHRocm93IG5vcm1hbGl6ZVRpbWVkQ29tbWFuZEVycm9yKGVycm9yLCBjb250ZXh0LCBwYXRoKTsKICB9CiAgaWYgKHJlc3VsdC5zdGRlcnIgIT09ICIiKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBEYXJ3aW4gQUNMIGhlbHBlciByZXR1cm5lZCB1bmV4cGVjdGVkIGRpYWdub3N0aWNzIGZvciAke3BhdGh9YCk7CiAgfQogIHZhbGlkYXRlRGFyd2luQWNsTGlzdGluZyhyZXN1bHQuc3Rkb3V0LCBwYXRoLCByb2xlKTsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwYXRoKTsKICAvLyBBIHBhdGggY2hhbmdlZCB3aGlsZSBscyByYW4gbXVzdCBuZXZlciBzZWVkIGEgdmVyZGljdCBmb3IgaXRzIG5ldyBzdGF0ZS4KICBjb25zdCBhZnRlciA9IGRhcndpbkFjbElkZW50aXR5KGF3YWl0IHN0YXRQYXRoKHBhdGgpKTsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwYXRoKTsKICBpZiAoYWZ0ZXIgPT09IGJlZm9yZSkgewogICAgaWYgKGRhcndpbkFjbFZlcmRpY3RzLnNpemUgPj0gREFSV0lOX0FDTF9WRVJESUNUX0NBQ0hFX0xJTUlUKSB7CiAgICAgIGRhcndpbkFjbFZlcmRpY3RzLmRlbGV0ZShkYXJ3aW5BY2xWZXJkaWN0cy5rZXlzKCkubmV4dCgpLnZhbHVlKTsKICAgIH0KICAgIGRhcndpbkFjbFZlcmRpY3RzLnNldChjYWNoZUtleSwgYmVmb3JlKTsKICB9Cn0KCmZ1bmN0aW9uIHRydXN0ZWRXaW5kb3dzUG93ZXJTaGVsbFBhdGgoCiAgY2Fub25pY2FsaXplID0gcmVhbHBhdGhTeW5jLm5hdGl2ZSwKICBmaWxlc3lzdGVtID0gV0lORE9XU19FWEVDVVRBQkxFX0ZJTEVTWVNURU0sCikgewogIC8vIERlcml2ZSBhIENyZWF0ZVByb2Nlc3MtY29tcGF0aWJsZSBET1Mgc3BlbGxpbmcgZnJvbSBHTE9CQUxST09ULCB0aGVuIHByb3ZlCiAgLy8gYm90aCBzcGVsbGluZ3Mgc3RpbGwgbmFtZSB0aGUgc2FtZSByZWd1bGFyIHN5c3RlbSBmaWxlIGJlZm9yZSBsYXVuY2guCiAgY29uc3Qgc3lzdGVtUm9vdCA9IGNhbm9uaWNhbGl6ZShXSU5ET1dTX1NZU1RFTV9ST09UKTsKICBpZiAoIS9eW2Etel06XFwvaXUudGVzdChzeXN0ZW1Sb290KSB8fCB3aW4zMi5ub3JtYWxpemUoc3lzdGVtUm9vdCkgIT09IHN5c3RlbVJvb3QpIHsKICAgIHRocm93IG5ldyBFcnJvcigidHJ1c3RlZCBXaW5kb3dzIFN5c3RlbVJvb3QgZGlkIG5vdCByZXNvbHZlIHRvIGEgY2Fub25pY2FsIGxvY2FsIERPUyBwYXRoIik7CiAgfQogIGNvbnN0IHdvcmtpbmdEaXJlY3RvcnkgPSB3aW4zMi5qb2luKHN5c3RlbVJvb3QsICJTeXN0ZW0zMiIpOwogIGNvbnN0IGV4ZWN1dGFibGUgPSB3aW4zMi5qb2luKAogICAgd29ya2luZ0RpcmVjdG9yeSwKICAgICJXaW5kb3dzUG93ZXJTaGVsbCIsCiAgICAidjEuMCIsCiAgICAicG93ZXJzaGVsbC5leGUiLAogICk7CiAgY29uc3QgbmFtZXNwYWNlRXhlY3V0YWJsZSA9IHdpbjMyLmpvaW4oCiAgICBXSU5ET1dTX1NZU1RFTV9ST09ULAogICAgIlN5c3RlbTMyIiwKICAgICJXaW5kb3dzUG93ZXJTaGVsbCIsCiAgICAidjEuMCIsCiAgICAicG93ZXJzaGVsbC5leGUiLAogICk7CiAgdmVyaWZ5V2luZG93c0V4ZWN1dGFibGVBbGlhc2VzKG5hbWVzcGFjZUV4ZWN1dGFibGUsIGV4ZWN1dGFibGUsIGZpbGVzeXN0ZW0pOwogIHJldHVybiB7CiAgICBzeXN0ZW1Sb290LAogICAgd29ya2luZ0RpcmVjdG9yeSwKICAgIGV4ZWN1dGFibGUsCiAgfTsKfQoKZnVuY3Rpb24gdmVyaWZ5V2luZG93c0V4ZWN1dGFibGVBbGlhc2VzKG5hbWVzcGFjZUV4ZWN1dGFibGUsIGV4ZWN1dGFibGUsIGZpbGVzeXN0ZW0pIHsKICBsZXQgbmFtZXNwYWNlRGVzY3JpcHRvcjsKICBsZXQgY2FuZGlkYXRlRGVzY3JpcHRvcjsKICBsZXQgb3BlcmF0aW9uRXJyb3I7CiAgdHJ5IHsKICAgIGNvbnN0IG5hbWVzcGFjZUJlZm9yZSA9IGZpbGVzeXN0ZW0ubHN0YXQobmFtZXNwYWNlRXhlY3V0YWJsZSk7CiAgICBjb25zdCBjYW5kaWRhdGVCZWZvcmUgPSBmaWxlc3lzdGVtLmxzdGF0KGV4ZWN1dGFibGUpOwogICAgYXNzZXJ0UmVndWxhcldpbmRvd3NFeGVjdXRhYmxlKG5hbWVzcGFjZUJlZm9yZSwgIkdMT0JBTFJPT1QgcGF0aCIpOwogICAgYXNzZXJ0UmVndWxhcldpbmRvd3NFeGVjdXRhYmxlKGNhbmRpZGF0ZUJlZm9yZSwgIkRPUyBwYXRoIik7CiAgICBuYW1lc3BhY2VEZXNjcmlwdG9yID0gZmlsZXN5c3RlbS5vcGVuKG5hbWVzcGFjZUV4ZWN1dGFibGUpOwogICAgY2FuZGlkYXRlRGVzY3JpcHRvciA9IGZpbGVzeXN0ZW0ub3BlbihleGVjdXRhYmxlKTsKICAgIGNvbnN0IG5hbWVzcGFjZU9wZW5lZCA9IGZpbGVzeXN0ZW0uZnN0YXQobmFtZXNwYWNlRGVzY3JpcHRvcik7CiAgICBjb25zdCBjYW5kaWRhdGVPcGVuZWQgPSBmaWxlc3lzdGVtLmZzdGF0KGNhbmRpZGF0ZURlc2NyaXB0b3IpOwogICAgY29uc3QgbmFtZXNwYWNlQWZ0ZXIgPSBmaWxlc3lzdGVtLmxzdGF0KG5hbWVzcGFjZUV4ZWN1dGFibGUpOwogICAgY29uc3QgY2FuZGlkYXRlQWZ0ZXIgPSBmaWxlc3lzdGVtLmxzdGF0KGV4ZWN1dGFibGUpOwogICAgYXNzZXJ0UmVndWxhcldpbmRvd3NFeGVjdXRhYmxlKG5hbWVzcGFjZU9wZW5lZCwgIkdMT0JBTFJPT1QgZGVzY3JpcHRvciIpOwogICAgYXNzZXJ0UmVndWxhcldpbmRvd3NFeGVjdXRhYmxlKGNhbmRpZGF0ZU9wZW5lZCwgIkRPUyBkZXNjcmlwdG9yIik7CiAgICBhc3NlcnRSZWd1bGFyV2luZG93c0V4ZWN1dGFibGUobmFtZXNwYWNlQWZ0ZXIsICJHTE9CQUxST09UIHBhdGgiKTsKICAgIGFzc2VydFJlZ3VsYXJXaW5kb3dzRXhlY3V0YWJsZShjYW5kaWRhdGVBZnRlciwgIkRPUyBwYXRoIik7CiAgICBmb3IgKGNvbnN0IGlkZW50aXR5IG9mIFsKICAgICAgbmFtZXNwYWNlQmVmb3JlLAogICAgICBjYW5kaWRhdGVCZWZvcmUsCiAgICAgIG5hbWVzcGFjZU9wZW5lZCwKICAgICAgY2FuZGlkYXRlT3BlbmVkLAogICAgICBuYW1lc3BhY2VBZnRlciwKICAgICAgY2FuZGlkYXRlQWZ0ZXIsCiAgICBdKSB7CiAgICAgIGlmICgKICAgICAgICBpZGVudGl0eS5kZXYgPD0gMG4gfHwgaWRlbnRpdHkuaW5vIDw9IDBuIHx8CiAgICAgICAgaWRlbnRpdHkuZGV2ID09PSBVTlNVUFBPUlRFRF9GSUxFX0lEXzY0IHx8IGlkZW50aXR5LmlubyA9PT0gVU5TVVBQT1JURURfRklMRV9JRF82NAogICAgICApIHsKICAgICAgICB0aHJvdyBuZXcgRXJyb3IoInRydXN0ZWQgV2luZG93cyBzeXN0ZW0gZXhlY3V0YWJsZSBpZGVudGl0eSBpcyB1bmF2YWlsYWJsZSIpOwogICAgICB9CiAgICB9CiAgICBpZiAoCiAgICAgICFzYW1lRmlsZUlkZW50aXR5KG5hbWVzcGFjZUJlZm9yZSwgbmFtZXNwYWNlT3BlbmVkKSB8fAogICAgICAhc2FtZUZpbGVJZGVudGl0eShuYW1lc3BhY2VPcGVuZWQsIG5hbWVzcGFjZUFmdGVyKSB8fAogICAgICAhc2FtZUZpbGVJZGVudGl0eShjYW5kaWRhdGVCZWZvcmUsIGNhbmRpZGF0ZU9wZW5lZCkgfHwKICAgICAgIXNhbWVGaWxlSWRlbnRpdHkoY2FuZGlkYXRlT3BlbmVkLCBjYW5kaWRhdGVBZnRlcikgfHwKICAgICAgIXNhbWVGaWxlSWRlbnRpdHkobmFtZXNwYWNlT3BlbmVkLCBjYW5kaWRhdGVPcGVuZWQpCiAgICApIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJ0cnVzdGVkIFdpbmRvd3Mgc3lzdGVtIGV4ZWN1dGFibGUgaWRlbnRpdHkgbWlzbWF0Y2giKTsKICAgIH0KICB9IGNhdGNoIChlcnJvcikgewogICAgb3BlcmF0aW9uRXJyb3IgPSBlcnJvcjsKICB9CiAgY29uc3QgY2xvc2VFcnJvcnMgPSBbXTsKICBmb3IgKGNvbnN0IGRlc2NyaXB0b3Igb2YgW2NhbmRpZGF0ZURlc2NyaXB0b3IsIG5hbWVzcGFjZURlc2NyaXB0b3JdKSB7CiAgICBpZiAoZGVzY3JpcHRvciA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTsKICAgIHRyeSB7IGZpbGVzeXN0ZW0uY2xvc2UoZGVzY3JpcHRvcik7IH0gY2F0Y2ggKGVycm9yKSB7IGNsb3NlRXJyb3JzLnB1c2goZXJyb3IpOyB9CiAgfQogIGlmIChvcGVyYXRpb25FcnJvciAhPT0gdW5kZWZpbmVkKSB7CiAgICBpZiAoY2xvc2VFcnJvcnMubGVuZ3RoID4gMCkgewogICAgICB0aHJvdyBuZXcgQWdncmVnYXRlRXJyb3IoCiAgICAgICAgW29wZXJhdGlvbkVycm9yLCAuLi5jbG9zZUVycm9yc10sCiAgICAgICAgInRydXN0ZWQgV2luZG93cyBleGVjdXRhYmxlIHZhbGlkYXRpb24gYW5kIGNsZWFudXAgYm90aCBmYWlsZWQiLAogICAgICApOwogICAgfQogICAgdGhyb3cgb3BlcmF0aW9uRXJyb3I7CiAgfQogIGlmIChjbG9zZUVycm9ycy5sZW5ndGggPT09IDEpIHRocm93IGNsb3NlRXJyb3JzWzBdOwogIGlmIChjbG9zZUVycm9ycy5sZW5ndGggPiAxKSB7CiAgICB0aHJvdyBuZXcgQWdncmVnYXRlRXJyb3IoCiAgICAgIGNsb3NlRXJyb3JzLAogICAgICAidHJ1c3RlZCBXaW5kb3dzIGV4ZWN1dGFibGUgZGVzY3JpcHRvciBjbGVhbnVwIGZhaWxlZCIsCiAgICApOwogIH0KfQoKZnVuY3Rpb24gYXNzZXJ0UmVndWxhcldpbmRvd3NFeGVjdXRhYmxlKGlkZW50aXR5LCBzcGVsbGluZykgewogIGlmICghaWRlbnRpdHkuaXNGaWxlKCkgfHwgaWRlbnRpdHkuaXNTeW1ib2xpY0xpbmsoKSkgewogICAgdGhyb3cgbmV3IEVycm9yKGB0cnVzdGVkIFdpbmRvd3MgJHtzcGVsbGluZ30gZXhlY3V0YWJsZSBpcyBub3QgYSByZWd1bGFyIG5vbi1saW5rIGZpbGVgKTsKICB9Cn0KCmZ1bmN0aW9uIHNhbWVGaWxlSWRlbnRpdHkobGVmdCwgcmlnaHQpIHsKICByZXR1cm4gbGVmdC5kZXYgPT09IHJpZ2h0LmRldiAmJiBsZWZ0LmlubyA9PT0gcmlnaHQuaW5vOwp9CgpmdW5jdGlvbiB3aW5kb3dzUG93ZXJTaGVsbEVudmlyb25tZW50KHBhdGhzLCB0cnVzdGVkUGF0aHMgPSB0cnVzdGVkV2luZG93c1Bvd2VyU2hlbGxQYXRoKCkpIHsKICBjb25zdCB7IHN5c3RlbVJvb3QsIHdvcmtpbmdEaXJlY3RvcnkgfSA9IHRydXN0ZWRQYXRoczsKICAvLyBsaWJ1diBmaWxscyBhIGZpeGVkIHNldCBvZiAicmVxdWlyZWQiIFdpbmRvd3MgdmFyaWFibGVzIGZyb20gdGhlIHBhcmVudAogIC8vIHdoZW4gdGhleSBhcmUgYWJzZW50LiBEZWZpbmUgZXZlcnkgb25lIHNvIHBvaXNvbmVkIGNhbGxlciBzdGF0ZSBjYW5ub3QgYmUKICAvLyBzaWxlbnRseSBpbmhlcml0ZWQgaW50byB0aGUgdmFsaWRhdGlvbiBoZWxwZXIuCiAgcmV0dXJuIHsKICAgIEFHRU5DX0xPQ0tfUEFUSFM6IHdpbmRvd3NQYXRoVHJhbnNwb3J0KHBhdGhzKSwKICAgIEFQUERBVEE6ICIiLAogICAgQ09NU1BFQzogIiIsCiAgICBIT01FRFJJVkU6ICIiLAogICAgSE9NRVBBVEg6ICIiLAogICAgTE9DQUxBUFBEQVRBOiAiIiwKICAgIExPR09OU0VSVkVSOiAiIiwKICAgIFBBVEg6IHdvcmtpbmdEaXJlY3RvcnksCiAgICBQQVRIRVhUOiAiLkVYRSIsCiAgICBQU01PRFVMRVBBVEg6ICIiLAogICAgU1lTVEVNRFJJVkU6ICIiLAogICAgU1lTVEVNUk9PVDogc3lzdGVtUm9vdCwKICAgIFRFTVA6IHdvcmtpbmdEaXJlY3RvcnksCiAgICBUTVA6IHdvcmtpbmdEaXJlY3RvcnksCiAgICBVU0VSRE9NQUlOOiAiIiwKICAgIFVTRVJOQU1FOiAiIiwKICAgIFVTRVJQUk9GSUxFOiB3b3JraW5nRGlyZWN0b3J5LAogICAgV0lORElSOiBzeXN0ZW1Sb290LAogIH07Cn0KCmZ1bmN0aW9uIHdpbmRvd3NQYXRoVHJhbnNwb3J0KGVudHJpZXMpIHsKICBpZiAoCiAgICAhQXJyYXkuaXNBcnJheShlbnRyaWVzKSB8fAogICAgZW50cmllcy5sZW5ndGggPCAxIHx8CiAgICBlbnRyaWVzLmxlbmd0aCA+IFdJTkRPV1NfUEFUSF9UUkFOU1BPUlRfTUFYX0VOVFJJRVMKICApIHsKICAgIHRocm93IG5ldyBFcnJvcigiYWdlbmM6IFdpbmRvd3MgcHJvdGVjdGVkLXBhdGggdHJhbnNwb3J0IGhhcyBhbiBpbnZhbGlkIGVudHJ5IGNvdW50Iik7CiAgfQogIGNvbnN0IHJlY29yZHMgPSBbXTsKICBsZXQgdHJhbnNwb3J0Q2hhcnMgPSAwOwogIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykgewogICAgY29uc3QgcGF0aCA9IGVudHJ5Py5wYXRoOwogICAgY29uc3Qgcm9sZSA9IGVudHJ5Py5yb2xlOwogICAgaWYgKAogICAgICB0eXBlb2YgcGF0aCAhPT0gInN0cmluZyIgfHwKICAgICAgcGF0aC5sZW5ndGggPT09IDAgfHwKICAgICAgcGF0aC5sZW5ndGggPiBXSU5ET1dTX1BBVEhfVFJBTlNQT1JUX01BWF9DSEFSUyB8fAogICAgICAocm9sZSAhPT0gImxlYWZEaXJlY3RvcnkiICYmIHJvbGUgIT09ICJhbmNlc3RvckRpcmVjdG9yeSIgJiYgcm9sZSAhPT0gImZpbGUiKQogICAgKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigiYWdlbmM6IFdpbmRvd3MgcHJvdGVjdGVkLXBhdGggdHJhbnNwb3J0IGVudHJ5IGlzIGludmFsaWQiKTsKICAgIH0KICAgIGNvbnN0IHJlY29yZCA9IGAke3JvbGV9OiR7QnVmZmVyLmZyb20ocGF0aCwgInV0ZjE2bGUiKS50b1N0cmluZygiYmFzZTY0Iil9YDsKICAgIHRyYW5zcG9ydENoYXJzICs9IHJlY29yZC5sZW5ndGggKyAocmVjb3Jkcy5sZW5ndGggPT09IDAgPyAwIDogMSk7CiAgICBpZiAodHJhbnNwb3J0Q2hhcnMgPiBXSU5ET1dTX1BBVEhfVFJBTlNQT1JUX01BWF9DSEFSUykgewogICAgICB0aHJvdyBuZXcgRXJyb3IoImFnZW5jOiBXaW5kb3dzIHByb3RlY3RlZC1wYXRoIHRyYW5zcG9ydCBleGNlZWRzIGl0cyBsaW1pdCIpOwogICAgfQogICAgcmVjb3Jkcy5wdXNoKHJlY29yZCk7CiAgfQogIHJldHVybiByZWNvcmRzLmpvaW4oIlxuIik7Cn0KCmFzeW5jIGZ1bmN0aW9uIGFzc2VydFdpbmRvd3NQYXRoU2VjdXJpdHkoZW50cmllcywgY29udGV4dCkgewogIGNvbnN0IGRpc3BsYXlQYXRoID0gZW50cmllcy5hdCgtMSk/LnBhdGggPz8gInVua25vd24iOwogIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIGRpc3BsYXlQYXRoKTsKICBjb25zdCB0cnVzdGVkUGF0aHMgPSB0cnVzdGVkV2luZG93c1Bvd2VyU2hlbGxQYXRoKCk7CiAgY29uc3QgeyB3b3JraW5nRGlyZWN0b3J5LCBleGVjdXRhYmxlIH0gPSB0cnVzdGVkUGF0aHM7CiAgbGV0IHJlc3VsdDsKICB0cnkgewogICAgcmVzdWx0ID0gYXdhaXQgZXhlY0ZpbGVVdGY4KAogICAgICBleGVjdXRhYmxlLAogICAgICBbCiAgICAgICAgIi1Ob0xvZ28iLAogICAgICAgICItTm9Qcm9maWxlIiwKICAgICAgICAiLU5vbkludGVyYWN0aXZlIiwKICAgICAgICAiLUVuY29kZWRDb21tYW5kIiwKICAgICAgICBXSU5ET1dTX1NFQ1VSSVRZX1NDUklQVF9CQVNFNjQsCiAgICAgIF0sCiAgICAgIHsKICAgICAgICBjd2Q6IHdvcmtpbmdEaXJlY3RvcnksCiAgICAgICAgZW52OiB3aW5kb3dzUG93ZXJTaGVsbEVudmlyb25tZW50KGVudHJpZXMsIHRydXN0ZWRQYXRocyksCiAgICAgICAgbWF4QnVmZmVyOiAxMDI0ICogMTAyNCwKICAgICAgICB3aW5kb3dzSGlkZTogdHJ1ZSwKICAgICAgfSwKICAgICAgY29udGV4dCwKICAgICAgZGlzcGxheVBhdGgsCiAgICApOwogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICB0aHJvdyBub3JtYWxpemVUaW1lZENvbW1hbmRFcnJvcihlcnJvciwgY29udGV4dCwgZGlzcGxheVBhdGgpOwogIH0KICBpZiAocmVzdWx0LnN0ZG91dCAhPT0gIk9LIikgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogV2luZG93cyBsb2NrLXBhdGggdmFsaWRhdGlvbiByZXR1cm5lZCBhbiBpbnZhbGlkIHJlc3BvbnNlIGZvciAke2Rpc3BsYXlQYXRofWApOwogIH0KICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBkaXNwbGF5UGF0aCk7Cn0KCmFzeW5jIGZ1bmN0aW9uIGFzc2VydExvY2FsRmlsZXN5c3RlbShwYXJlbnQsIGNvbnRleHQpIHsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwYXJlbnQpOwogIGxldCBmaWxlc3lzdGVtVHlwZTsKICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gImxpbnV4IikgewogICAgY29uc3QgbW91bnRzID0gYXdhaXQgcmVhZEZpbGUoIi9wcm9jL3NlbGYvbW91bnRpbmZvIiwgInV0ZjgiKTsKICAgIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIHBhcmVudCk7CiAgICBsZXQgbG9uZ2VzdCA9IC0xOwogICAgZm9yIChjb25zdCBsaW5lIG9mIG1vdW50cy5zcGxpdCgiXG4iKSkgewogICAgICBjb25zdCBmaWVsZHMgPSBsaW5lLnNwbGl0KCIgIik7CiAgICAgIGNvbnN0IHNlcGFyYXRvckluZGV4ID0gZmllbGRzLmluZGV4T2YoIi0iKTsKICAgICAgaWYgKAogICAgICAgIHNlcGFyYXRvckluZGV4IDwgNiB8fAogICAgICAgIGZpZWxkc1s0XSA9PT0gdW5kZWZpbmVkIHx8CiAgICAgICAgZmllbGRzW3NlcGFyYXRvckluZGV4ICsgMV0gPT09IHVuZGVmaW5lZAogICAgICApIGNvbnRpbnVlOwogICAgICBjb25zdCBtb3VudFBvaW50ID0gZGVjb2RlTW91bnRQYXRoKGZpZWxkc1s0XSk7CiAgICAgIGlmIChwYXRoSXNXaXRoaW4ocGFyZW50LCBtb3VudFBvaW50KSAmJiBtb3VudFBvaW50Lmxlbmd0aCA+IGxvbmdlc3QpIHsKICAgICAgICBsb25nZXN0ID0gbW91bnRQb2ludC5sZW5ndGg7CiAgICAgICAgZmlsZXN5c3RlbVR5cGUgPSBmaWVsZHNbc2VwYXJhdG9ySW5kZXggKyAxXTsKICAgICAgfQogICAgfQogIH0gZWxzZSBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gImRhcndpbiIpIHsKICAgIGxldCBzdGRvdXQ7CiAgICB0cnkgewogICAgICAoeyBzdGRvdXQgfSA9IGF3YWl0IGV4ZWNGaWxlVXRmOCgiL3NiaW4vbW91bnQiLCBbXSwgewogICAgICAgIGVudjogeyBMQ19BTEw6ICJDIiB9LAogICAgICAgIG1heEJ1ZmZlcjogNCAqIDEwMjQgKiAxMDI0LAogICAgICB9LCBjb250ZXh0LCBwYXJlbnQpKTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIHRocm93IG5vcm1hbGl6ZVRpbWVkQ29tbWFuZEVycm9yKGVycm9yLCBjb250ZXh0LCBwYXJlbnQpOwogICAgfQogICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcGFyZW50KTsKICAgIGxldCBsb25nZXN0ID0gLTE7CiAgICBmb3IgKGNvbnN0IGxpbmUgb2Ygc3Rkb3V0LnNwbGl0KCJcbiIpKSB7CiAgICAgIGNvbnN0IG1hdGNoID0gbGluZS5tYXRjaCgvIG9uICguKykgXCgoW14sXSspLyk7CiAgICAgIGlmIChtYXRjaCA9PT0gbnVsbCkgY29udGludWU7CiAgICAgIGNvbnN0IG1vdW50UG9pbnQgPSBkZWNvZGVNb3VudFBhdGgobWF0Y2hbMV0pOwogICAgICBpZiAocGF0aElzV2l0aGluKHBhcmVudCwgbW91bnRQb2ludCkgJiYgbW91bnRQb2ludC5sZW5ndGggPiBsb25nZXN0KSB7CiAgICAgICAgbG9uZ2VzdCA9IG1vdW50UG9pbnQubGVuZ3RoOwogICAgICAgIGZpbGVzeXN0ZW1UeXBlID0gbWF0Y2hbMl07CiAgICAgIH0KICAgIH0KICB9IGVsc2UgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJ3aW4zMiIpIHsKICAgIGF3YWl0IGFzc2VydFdpbmRvd3NQYXRoU2VjdXJpdHkoW3sgcGF0aDogcGFyZW50LCByb2xlOiAibGVhZkRpcmVjdG9yeSIgfV0sIGNvbnRleHQpOwogICAgcmV0dXJuOwogIH0gZWxzZSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoCiAgICAgIGBhZ2VuYzogY2Fubm90IGVzdGFibGlzaCBsb2NrIGZpbGVzeXN0ZW0gbG9jYWxpdHkgb24gJHtwcm9jZXNzLnBsYXRmb3JtfWAsCiAgICApOwogIH0KICBpZiAoZmlsZXN5c3RlbVR5cGUgPT09IHVuZGVmaW5lZCB8fCAhTE9DQUxfRklMRVNZU1RFTV9UWVBFUy5oYXMoZmlsZXN5c3RlbVR5cGUpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoCiAgICAgIGBhZ2VuYzogbm9uLWxvY2FsIG9yIHVua25vd24gbG9jayBmaWxlc3lzdGVtIGlzIHVuc3VwcG9ydGVkICgke2ZpbGVzeXN0ZW1UeXBlID8/ICJ1bmtub3duIn0pOiAke3BhcmVudH1gLAogICAgKTsKICB9Cn0KCi8qKgogKiBFc3RhYmxpc2ggdGhhdCBhbiBleGlzdGluZyBkaXJlY3RvcnkgaXMgYSBsb2NhbCwgcHJpdmF0ZWx5IG11dGFibGUKICogY29vcmRpbmF0aW9uIGJvdW5kYXJ5LiBXcmFwcGVyIHJlcGxhY2VtZW50IHVzZXMgYSByZWdpc3RyeS1ob3N0ZWQgU1FMaXRlCiAqIGxvY2ssIHNvIGEgc2hhcmVkIG9yIGF0dGFja2VyLXdyaXRhYmxlIHdyYXBwZXIgZGlyZWN0b3J5IHdvdWxkIG90aGVyd2lzZQogKiBwZXJtaXQgY3Jvc3MtaG9zdCByYWNlcyBvciBwYXRoIHN1YnN0aXR1dGlvbiBvdXRzaWRlIHRoYXQgbG9jay4KICovCmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhc3NlcnRMb2NhbFByaXZhdGVEaXJlY3RvcnkoCiAgcmVxdWVzdGVkUGF0aCwKICB7CiAgICB0aW1lb3V0TXMgPSA2MF8wMDAsCiAgICBsYWJlbCA9ICJBZ2VuQyBvcGVyYXRpb24iLAogICAgZGVhZGxpbmU6IHN1cHBsaWVkRGVhZGxpbmUsCiAgICBhbGxvd1RydXN0ZWRTdGlja3lMZWFmID0gZmFsc2UsCiAgICBvblByb2dyZXNzLAogIH0gPSB7fSwKKSB7CiAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcih0aW1lb3V0TXMpIHx8IHRpbWVvdXRNcyA8PSAwKSB7CiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCJsb2NrIHRpbWVvdXRNcyBtdXN0IGJlIGEgcG9zaXRpdmUgc2FmZSBpbnRlZ2VyIik7CiAgfQogIGlmIChzdXBwbGllZERlYWRsaW5lICE9PSB1bmRlZmluZWQgJiYgIU51bWJlci5pc0Zpbml0ZShzdXBwbGllZERlYWRsaW5lKSkgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayBkZWFkbGluZSBtdXN0IGJlIGZpbml0ZSIpOwogIH0KICBpZiAodHlwZW9mIGFsbG93VHJ1c3RlZFN0aWNreUxlYWYgIT09ICJib29sZWFuIikgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigiYWxsb3dUcnVzdGVkU3RpY2t5TGVhZiBtdXN0IGJlIGJvb2xlYW4iKTsKICB9CiAgaWYgKG9uUHJvZ3Jlc3MgIT09IHVuZGVmaW5lZCAmJiB0eXBlb2Ygb25Qcm9ncmVzcyAhPT0gImZ1bmN0aW9uIikgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayBvblByb2dyZXNzIG11c3QgYmUgYSBmdW5jdGlvbiIpOwogIH0KICBjb25zdCBjb250ZXh0ID0gewogICAgZGVhZGxpbmU6IE1hdGgubWluKAogICAgICBzdXBwbGllZERlYWRsaW5lID8/IE51bWJlci5QT1NJVElWRV9JTkZJTklUWSwKICAgICAgcGVyZm9ybWFuY2Uubm93KCkgKyB0aW1lb3V0TXMsCiAgICApLAogICAgbGFiZWwsCiAgICB0aW1lb3V0TXMsCiAgICBvblByb2dyZXNzLAogIH07CiAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgInByaXZhdGUgZGlyZWN0b3J5IHZhbGlkYXRpb24gc3RhcnRlZCIpOwogIGNvbnN0IGFic29sdXRlID0gcmVzb2x2ZShyZXF1ZXN0ZWRQYXRoKTsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBhYnNvbHV0ZSk7CiAgY29uc3QgY2Fub25pY2FsID0gYXdhaXQgcmVhbHBhdGgoYWJzb2x1dGUpOwogIGNvbnN0IGFuY2VzdG9ycyA9IFtdOwogIGZvciAobGV0IGN1cnJlbnQgPSBjYW5vbmljYWw7IDsgY3VycmVudCA9IGRpcm5hbWUoY3VycmVudCkpIHsKICAgIGFuY2VzdG9ycy5wdXNoKGN1cnJlbnQpOwogICAgaWYgKGRpcm5hbWUoY3VycmVudCkgPT09IGN1cnJlbnQpIGJyZWFrOwogIH0KICBjb25zdCBjdXJyZW50VWlkID0gcHJvY2Vzcy5nZXR1aWQ/LigpOwogIGNvbnN0IGJlZm9yZUlkZW50aXRpZXMgPSBuZXcgTWFwKCk7CiAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IGFuY2VzdG9ycy5sZW5ndGg7IGluZGV4ICs9IDEpIHsKICAgIGNvbnN0IHBhdGggPSBhbmNlc3RvcnNbaW5kZXhdOwogICAgY29uc3Qgc3RhdHMgPSBhd2FpdCBsc3RhdChwYXRoLCB7IGJpZ2ludDogdHJ1ZSB9KTsKICAgIGlmICghc3RhdHMuaXNEaXJlY3RvcnkoKSB8fCBzdGF0cy5pc1N5bWJvbGljTGluaygpKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBwYXRoIGFuY2VzdG9yIGlzIG5vdCBhIHJlYWwgZGlyZWN0b3J5OiAke3BhdGh9YCk7CiAgICB9CiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gIndpbjMyIikgewogICAgICBjb25zdCBsZWFmID0gaW5kZXggPT09IDA7CiAgICAgIGNvbnN0IHRydXN0ZWRPd25lciA9IHN0YXRzLnVpZCA9PT0gMG4gfHwKICAgICAgICAoY3VycmVudFVpZCAhPT0gdW5kZWZpbmVkICYmIHN0YXRzLnVpZCA9PT0gQmlnSW50KGN1cnJlbnRVaWQpKTsKICAgICAgY29uc3Qgc3RpY2t5Qm91bmRhcnkgPSAoIWxlYWYgfHwgYWxsb3dUcnVzdGVkU3RpY2t5TGVhZikgJiYKICAgICAgICAoc3RhdHMubW9kZSAmIDBvMTAwMG4pICE9PSAwbiAmJiB0cnVzdGVkT3duZXI7CiAgICAgIGlmICghdHJ1c3RlZE93bmVyIHx8ICgoc3RhdHMubW9kZSAmIDBvMDIybikgIT09IDBuICYmICFzdGlja3lCb3VuZGFyeSkpIHsKICAgICAgICB0aHJvdyBuZXcgRXJyb3IoCiAgICAgICAgICBgYWdlbmM6IHByb3RlY3RlZCBkaXJlY3RvcnkgY2hhaW4gcGVybWl0cyB1bnRydXN0ZWQgbXV0YXRpb246ICR7cGF0aH07IGAgKwogICAgICAgICAgInJlbW92ZSBncm91cC93b3JsZCB3cml0ZSBhY2Nlc3MgYmVmb3JlIHJldHJ5aW5nIiwKICAgICAgICApOwogICAgICB9CiAgICAgIGlmICgKICAgICAgICBsZWFmICYmICFzdGlja3lCb3VuZGFyeSAmJiBjdXJyZW50VWlkICE9PSB1bmRlZmluZWQgJiYKICAgICAgICBzdGF0cy51aWQgIT09IEJpZ0ludChjdXJyZW50VWlkKQogICAgICApIHsKICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBwcm90ZWN0ZWQgZGlyZWN0b3J5IGlzIG5vdCBvd25lZCBieSB0aGUgY3VycmVudCB1c2VyOiAke3BhdGh9YCk7CiAgICAgIH0KICAgIH0KICAgIGJlZm9yZUlkZW50aXRpZXMuc2V0KHBhdGgsIHsgZGV2OiBzdGF0cy5kZXYsIGlubzogc3RhdHMuaW5vIH0pOwogICAgaWRlbnRpdHlGcm9tU3RhdHMoc3RhdHMsIHBhdGgpOwogIH0KICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gIndpbjMyIikgewogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIldpbmRvd3MgYW5jZXN0b3IgQUNMIHZhbGlkYXRpb24gc3RhcnRlZCIpOwogICAgYXdhaXQgYXNzZXJ0V2luZG93c1BhdGhTZWN1cml0eSgKICAgICAgYW5jZXN0b3JzLm1hcCgocGF0aCwgaW5kZXgpID0+ICh7CiAgICAgICAgcGF0aCwKICAgICAgICByb2xlOiBpbmRleCA9PT0gMCA/ICJsZWFmRGlyZWN0b3J5IiA6ICJhbmNlc3RvckRpcmVjdG9yeSIsCiAgICAgIH0pKSwKICAgICAgY29udGV4dCwKICAgICk7CiAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiV2luZG93cyBhbmNlc3RvciBBQ0wgdmFsaWRhdGlvbiBjb21wbGV0ZSIpOwogIH0gZWxzZSB7CiAgICBhd2FpdCBhc3NlcnRMb2NhbEZpbGVzeXN0ZW0oY2Fub25pY2FsLCBjb250ZXh0KTsKICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAiZGFyd2luIikgewogICAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgYW5jZXN0b3JzLmxlbmd0aDsgaW5kZXggKz0gMSkgewogICAgICAgIGF3YWl0IGFzc2VydERhcndpblBhdGhTZWN1cml0eSgKICAgICAgICAgIGFuY2VzdG9yc1tpbmRleF0sCiAgICAgICAgICBpbmRleCA9PT0gMCA/ICJsZWFmIGRpcmVjdG9yeSIgOiAiYW5jZXN0b3IgZGlyZWN0b3J5IiwKICAgICAgICAgIGNvbnRleHQsCiAgICAgICAgKTsKICAgICAgfQogICAgfQogIH0KICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBjYW5vbmljYWwpOwogIGZvciAoY29uc3QgcGF0aCBvZiBhbmNlc3RvcnMpIHsKICAgIGNvbnN0IGFmdGVyID0gYXdhaXQgbHN0YXQocGF0aCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgICBjb25zdCBiZWZvcmUgPSBiZWZvcmVJZGVudGl0aWVzLmdldChwYXRoKTsKICAgIGlmICgKICAgICAgIWFmdGVyLmlzRGlyZWN0b3J5KCkgfHwgYWZ0ZXIuaXNTeW1ib2xpY0xpbmsoKSB8fCBiZWZvcmUgPT09IHVuZGVmaW5lZCB8fAogICAgICBhZnRlci5kZXYgIT09IGJlZm9yZS5kZXYgfHwgYWZ0ZXIuaW5vICE9PSBiZWZvcmUuaW5vCiAgICApIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogcHJvdGVjdGVkIGRpcmVjdG9yeSBpZGVudGl0eSBjaGFuZ2VkIGR1cmluZyB2YWxpZGF0aW9uOiAke3BhdGh9YCk7CiAgICB9CiAgfQogIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJwcml2YXRlIGRpcmVjdG9yeSB2YWxpZGF0aW9uIGNvbXBsZXRlIik7CiAgcmV0dXJuIGNhbm9uaWNhbDsKfQoKZnVuY3Rpb24gYXNzZXJ0UmVndWxhclNpbmdsZUxpbmsoc3RhdHMsIHBhdGgpIHsKICBpZiAoIXN0YXRzLmlzRmlsZSgpIHx8IHN0YXRzLmlzU3ltYm9saWNMaW5rKCkpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgaXMgbm90IGEgcmVndWxhciBmaWxlOiAke3BhdGh9YCk7CiAgfQogIGlmIChzdGF0cy5ubGluayAhPT0gMW4pIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgbXVzdCBub3QgaGF2ZSBoYXJkLWxpbmsgYWxpYXNlczogJHtwYXRofWApOwogIH0KfQoKZnVuY3Rpb24gaWRlbnRpdHlGcm9tU3RhdHMoc3RhdHMsIHBhdGgpIHsKICBpZiAoCiAgICBzdGF0cy5kZXYgPT09IDBuIHx8CiAgICBzdGF0cy5pbm8gPT09IDBuIHx8CiAgICBzdGF0cy5pbm8gPT09IC0xbiB8fAogICAgQmlnSW50LmFzVWludE4oNjQsIHN0YXRzLmlubykgPT09IFVOU1VQUE9SVEVEX0ZJTEVfSURfNjQKICApIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgaGFzIG5vIHN0YWJsZSBmaWxlc3lzdGVtIGlkZW50aXR5OiAke3BhdGh9YCk7CiAgfQogIHJldHVybiBgJHtzdGF0cy5kZXZ9OiR7c3RhdHMuaW5vfWA7Cn0KCmZ1bmN0aW9uIGFzc2VydFBvc2l4T3duZXJzaGlwKHN0YXRzLCBwYXRoLCBraW5kKSB7CiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJ3aW4zMiIpIHJldHVybjsKICBjb25zdCBjdXJyZW50VWlkID0gcHJvY2Vzcy5nZXR1aWQ/LigpOwogIGlmIChjdXJyZW50VWlkICE9PSB1bmRlZmluZWQgJiYgc3RhdHMudWlkICE9PSBCaWdJbnQoY3VycmVudFVpZCkpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgJHtraW5kfSBpcyBub3Qgb3duZWQgYnkgdGhlIGN1cnJlbnQgdXNlcjogJHtwYXRofWApOwogIH0KICBpZiAoKHN0YXRzLm1vZGUgJiAwbzAyMm4pICE9PSAwbikgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogbG9jayBkYXRhYmFzZSAke2tpbmR9IGlzIGdyb3VwL3dvcmxkLXdyaXRhYmxlOiAke3BhdGh9YCk7CiAgfQp9CgovKioKICogVmFsaWRhdGUgYSByZWd1bGFyIGZpbGUgYW5kIGl0cyBjb21wbGV0ZSBkaXJlY3RvcnkgY2hhaW4gYmVmb3JlIGEgY2FsbGVyCiAqIHRydXN0cyBpdHMgY29udGVudHMuIFRoaXMgaXMgaW50ZW50aW9uYWxseSBub24tbXV0YXRpbmc6IHVuc2FmZSBvd25lcnNoaXAsCiAqIG1vZGUgYml0cywgQUNMcywgYWxpYXNlcywgb3IgaWRlbnRpdHkgY2hhbmdlcyBmYWlsIGNsb3NlZC4KICovCmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhc3NlcnRMb2NhbFByaXZhdGVGaWxlKAogIHJlcXVlc3RlZFBhdGgsCiAgewogICAgdGltZW91dE1zID0gNjBfMDAwLAogICAgbGFiZWwgPSAiQWdlbkMgb3BlcmF0aW9uIiwKICAgIGRlYWRsaW5lOiBzdXBwbGllZERlYWRsaW5lLAogICAgb25Qcm9ncmVzcywKICB9ID0ge30sCikgewogIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIodGltZW91dE1zKSB8fCB0aW1lb3V0TXMgPD0gMCkgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayB0aW1lb3V0TXMgbXVzdCBiZSBhIHBvc2l0aXZlIHNhZmUgaW50ZWdlciIpOwogIH0KICBpZiAoc3VwcGxpZWREZWFkbGluZSAhPT0gdW5kZWZpbmVkICYmICFOdW1iZXIuaXNGaW5pdGUoc3VwcGxpZWREZWFkbGluZSkpIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgZGVhZGxpbmUgbXVzdCBiZSBmaW5pdGUiKTsKICB9CiAgaWYgKG9uUHJvZ3Jlc3MgIT09IHVuZGVmaW5lZCAmJiB0eXBlb2Ygb25Qcm9ncmVzcyAhPT0gImZ1bmN0aW9uIikgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayBvblByb2dyZXNzIG11c3QgYmUgYSBmdW5jdGlvbiIpOwogIH0KICBjb25zdCBjb250ZXh0ID0gewogICAgZGVhZGxpbmU6IE1hdGgubWluKAogICAgICBzdXBwbGllZERlYWRsaW5lID8/IE51bWJlci5QT1NJVElWRV9JTkZJTklUWSwKICAgICAgcGVyZm9ybWFuY2Uubm93KCkgKyB0aW1lb3V0TXMsCiAgICApLAogICAgbGFiZWwsCiAgICB0aW1lb3V0TXMsCiAgICBvblByb2dyZXNzLAogIH07CiAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgInByaXZhdGUgZmlsZSB2YWxpZGF0aW9uIHN0YXJ0ZWQiKTsKICBjb25zdCBhYnNvbHV0ZSA9IHJlc29sdmUocmVxdWVzdGVkUGF0aCk7CiAgY29uc3QgcGFyZW50ID0gZGlybmFtZShhYnNvbHV0ZSk7CiAgY29uc3QgY2Fub25pY2FsUGFyZW50ID0gYXdhaXQgYXNzZXJ0TG9jYWxQcml2YXRlRGlyZWN0b3J5KHBhcmVudCwgewogICAgdGltZW91dE1zLAogICAgbGFiZWwsCiAgICBkZWFkbGluZTogY29udGV4dC5kZWFkbGluZSwKICAgIC4uLihvblByb2dyZXNzID09PSB1bmRlZmluZWQgPyB7fSA6IHsgb25Qcm9ncmVzcyB9KSwKICB9KTsKICBpZiAoY2Fub25pY2FsUGFyZW50ICE9PSBwYXJlbnQpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBmaWxlIHBhcmVudCBtdXN0IHVzZSBpdHMgY2Fub25pY2FsIHBhdGg6ICR7cGFyZW50fWApOwogIH0KICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBhYnNvbHV0ZSk7CiAgY29uc3QgYmVmb3JlID0gYXdhaXQgbHN0YXQoYWJzb2x1dGUsIHsgYmlnaW50OiB0cnVlIH0pOwogIGlmICghYmVmb3JlLmlzRmlsZSgpIHx8IGJlZm9yZS5pc1N5bWJvbGljTGluaygpIHx8IGJlZm9yZS5ubGluayAhPT0gMW4pIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBmaWxlIG11c3QgYmUgYSByZWd1bGFyIHNpbmdsZS1saW5rIGZpbGU6ICR7YWJzb2x1dGV9YCk7CiAgfQogIGlkZW50aXR5RnJvbVN0YXRzKGJlZm9yZSwgYWJzb2x1dGUpOwogIGlmIChwcm9jZXNzLnBsYXRmb3JtICE9PSAid2luMzIiKSB7CiAgICBjb25zdCBjdXJyZW50VWlkID0gcHJvY2Vzcy5nZXR1aWQ/LigpOwogICAgaWYgKGN1cnJlbnRVaWQgIT09IHVuZGVmaW5lZCAmJiBiZWZvcmUudWlkICE9PSBCaWdJbnQoY3VycmVudFVpZCkpIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogcHJvdGVjdGVkIGZpbGUgaXMgbm90IG93bmVkIGJ5IHRoZSBjdXJyZW50IHVzZXI6ICR7YWJzb2x1dGV9YCk7CiAgICB9CiAgICBpZiAoKGJlZm9yZS5tb2RlICYgMG8wMjJuKSAhPT0gMG4pIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogcHJvdGVjdGVkIGZpbGUgaXMgZ3JvdXAvd29ybGQtd3JpdGFibGU6ICR7YWJzb2x1dGV9YCk7CiAgICB9CiAgfQogIGNvbnN0IGNhbm9uaWNhbCA9IGF3YWl0IHJlYWxwYXRoKGFic29sdXRlKTsKICBpZiAoY2Fub25pY2FsICE9PSBhYnNvbHV0ZSkgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogcHJvdGVjdGVkIGZpbGUgbXVzdCB1c2UgaXRzIGNhbm9uaWNhbCBwYXRoOiAke2Fic29sdXRlfWApOwogIH0KICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gIndpbjMyIikgewogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIldpbmRvd3MgZmlsZSBBQ0wgdmFsaWRhdGlvbiBzdGFydGVkIik7CiAgICBhd2FpdCBhc3NlcnRXaW5kb3dzUGF0aFNlY3VyaXR5KFt7IHBhdGg6IGNhbm9uaWNhbCwgcm9sZTogImZpbGUiIH1dLCBjb250ZXh0KTsKICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJXaW5kb3dzIGZpbGUgQUNMIHZhbGlkYXRpb24gY29tcGxldGUiKTsKICB9IGVsc2UgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJkYXJ3aW4iKSB7CiAgICBhd2FpdCBhc3NlcnREYXJ3aW5QYXRoU2VjdXJpdHkoY2Fub25pY2FsLCAiZmlsZSIsIGNvbnRleHQpOwogIH0KICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBjYW5vbmljYWwpOwogIGNvbnN0IGFmdGVyID0gYXdhaXQgbHN0YXQoY2Fub25pY2FsLCB7IGJpZ2ludDogdHJ1ZSB9KTsKICBpZiAoCiAgICAhYWZ0ZXIuaXNGaWxlKCkgfHwgYWZ0ZXIuaXNTeW1ib2xpY0xpbmsoKSB8fCBhZnRlci5ubGluayAhPT0gMW4gfHwKICAgIGFmdGVyLmRldiAhPT0gYmVmb3JlLmRldiB8fCBhZnRlci5pbm8gIT09IGJlZm9yZS5pbm8KICApIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IHByb3RlY3RlZCBmaWxlIGlkZW50aXR5IGNoYW5nZWQgZHVyaW5nIHZhbGlkYXRpb246ICR7Y2Fub25pY2FsfWApOwogIH0KICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAicHJpdmF0ZSBmaWxlIHZhbGlkYXRpb24gY29tcGxldGUiKTsKICByZXR1cm4gY2Fub25pY2FsOwp9Cgphc3luYyBmdW5jdGlvbiBwcmVwYXJlTG9ja1BhdGgocmVxdWVzdGVkUGF0aCwgY29udGV4dCkgewogIGNvbnN0IGFic29sdXRlID0gcmVzb2x2ZShyZXF1ZXN0ZWRQYXRoKTsKICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAibG9jayBwYXRoIHByZXBhcmF0aW9uIHN0YXJ0ZWQiKTsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBhYnNvbHV0ZSk7CiAgYXdhaXQgbWtkaXIoZGlybmFtZShhYnNvbHV0ZSksIHsgcmVjdXJzaXZlOiB0cnVlLCBtb2RlOiAwbzcwMCB9KTsKICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAibG9jayBwYXJlbnQgY3JlYXRpb24gY29tcGxldGUiKTsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBhYnNvbHV0ZSk7CiAgY29uc3QgcGFyZW50ID0gYXdhaXQgcmVhbHBhdGgoZGlybmFtZShhYnNvbHV0ZSkpOwogIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJsb2NrIHBhcmVudCBjYW5vbmljYWxpemF0aW9uIGNvbXBsZXRlIik7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgYWJzb2x1dGUpOwogIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJsb2NrIHBhcmVudCBzZWN1cml0eSB2YWxpZGF0aW9uIHN0YXJ0ZWQiKTsKICBjb25zdCB2YWxpZGF0ZWRQYXJlbnQgPSBhd2FpdCBhc3NlcnRMb2NhbFByaXZhdGVEaXJlY3RvcnkocGFyZW50LCB7CiAgICB0aW1lb3V0TXM6IGNvbnRleHQudGltZW91dE1zLAogICAgbGFiZWw6IGNvbnRleHQubGFiZWwsCiAgICBkZWFkbGluZTogY29udGV4dC5kZWFkbGluZSwKICAgIC4uLihjb250ZXh0Lm9uUHJvZ3Jlc3MgPT09IHVuZGVmaW5lZAogICAgICA/IHt9CiAgICAgIDogeyBvblByb2dyZXNzOiBjb250ZXh0Lm9uUHJvZ3Jlc3MgfSksCiAgfSk7CiAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgImxvY2sgcGFyZW50IHNlY3VyaXR5IHZhbGlkYXRpb24gY29tcGxldGUiKTsKICBpZiAodmFsaWRhdGVkUGFyZW50ICE9PSBwYXJlbnQpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgcGFyZW50IG11c3QgdXNlIGl0cyBjYW5vbmljYWwgcGF0aDogJHtwYXJlbnR9YCk7CiAgfQogIGNvbnN0IHBhcmVudFN0YXRzID0gYXdhaXQgbHN0YXQocGFyZW50LCB7IGJpZ2ludDogdHJ1ZSB9KTsKICBpZiAoIXBhcmVudFN0YXRzLmlzRGlyZWN0b3J5KCkgfHwgcGFyZW50U3RhdHMuaXNTeW1ib2xpY0xpbmsoKSkgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogbG9jayBkYXRhYmFzZSBwYXJlbnQgaXMgbm90IGEgcmVhbCBkaXJlY3Rvcnk6ICR7cGFyZW50fWApOwogIH0KICBhc3NlcnRQb3NpeE93bmVyc2hpcChwYXJlbnRTdGF0cywgcGFyZW50LCAicGFyZW50Iik7CgogIGNvbnN0IHBhdGggPSBqb2luKHBhcmVudCwgYmFzZW5hbWUoYWJzb2x1dGUpKTsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwYXRoKTsKICB0cnkgewogICAgY29uc3QgaGFuZGxlID0gYXdhaXQgb3BlbihwYXRoLCAid3giLCAwbzYwMCk7CiAgICB0cnkgewogICAgICBhd2FpdCBoYW5kbGUuY2xvc2UoKTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIGF3YWl0IGhhbmRsZS5jbG9zZSgpLmNhdGNoKCgpID0+IHt9KTsKICAgICAgdGhyb3cgZXJyb3I7CiAgICB9CiAgfSBjYXRjaCAoZXJyb3IpIHsKICAgIGlmIChlcnJvcj8uY29kZSAhPT0gIkVFWElTVCIpIHRocm93IGVycm9yOwogIH0KICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAibG9jayBkYXRhYmFzZSBmaWxlIGNyZWF0aW9uIGNvbXBsZXRlIik7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcGF0aCk7CiAgY29uc3QgcGF0aFN0YXRzID0gYXdhaXQgbHN0YXQocGF0aCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgYXNzZXJ0UmVndWxhclNpbmdsZUxpbmsocGF0aFN0YXRzLCBwYXRoKTsKICBhc3NlcnRQb3NpeE93bmVyc2hpcChwYXRoU3RhdHMsIHBhdGgsICJmaWxlIik7CiAgY29uc3QgY2Fub25pY2FsID0gYXdhaXQgcmVhbHBhdGgocGF0aCk7CiAgY29uc3Qgc3RhdHMgPSBhd2FpdCBsc3RhdChjYW5vbmljYWwsIHsgYmlnaW50OiB0cnVlIH0pOwogIGFzc2VydFJlZ3VsYXJTaW5nbGVMaW5rKHN0YXRzLCBjYW5vbmljYWwpOwogIGFzc2VydFBvc2l4T3duZXJzaGlwKHN0YXRzLCBjYW5vbmljYWwsICJmaWxlIik7CiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09ICJ3aW4zMiIpIHsKICAgIGF3YWl0IGNobW9kKGNhbm9uaWNhbCwgMG82MDApOwogICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJkYXJ3aW4iKSB7CiAgICAgIGF3YWl0IGFzc2VydERhcndpblBhdGhTZWN1cml0eShjYW5vbmljYWwsICJsb2NrIGRhdGFiYXNlIGZpbGUiLCBjb250ZXh0KTsKICAgIH0KICB9IGVsc2UgewogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgImxvY2sgZGF0YWJhc2UgQUNMIHZhbGlkYXRpb24gc3RhcnRlZCIpOwogICAgYXdhaXQgYXNzZXJ0V2luZG93c1BhdGhTZWN1cml0eShbCiAgICAgIHsgcGF0aDogcGFyZW50LCByb2xlOiAibGVhZkRpcmVjdG9yeSIgfSwKICAgICAgeyBwYXRoOiBjYW5vbmljYWwsIHJvbGU6ICJmaWxlIiB9LAogICAgXSwgY29udGV4dCk7CiAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAibG9jayBkYXRhYmFzZSBBQ0wgdmFsaWRhdGlvbiBjb21wbGV0ZSIpOwogIH0KICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBjYW5vbmljYWwpOwogIGNvbnN0IHNlY3VyZWRTdGF0cyA9IGF3YWl0IGxzdGF0KGNhbm9uaWNhbCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgYXNzZXJ0UmVndWxhclNpbmdsZUxpbmsoc2VjdXJlZFN0YXRzLCBjYW5vbmljYWwpOwogIGFzc2VydFBvc2l4T3duZXJzaGlwKHNlY3VyZWRTdGF0cywgY2Fub25pY2FsLCAiZmlsZSIpOwogIHJldHVybiB7CiAgICBwYXRoOiBjYW5vbmljYWwsCiAgICBwYXJlbnQsCiAgICBkZXY6IHNlY3VyZWRTdGF0cy5kZXYsCiAgICBpbm86IHNlY3VyZWRTdGF0cy5pbm8sCiAgICBpZGVudGl0eUtleTogaWRlbnRpdHlGcm9tU3RhdHMoc2VjdXJlZFN0YXRzLCBjYW5vbmljYWwpLAogIH07Cn0KCmFzeW5jIGZ1bmN0aW9uIHJldmFsaWRhdGVQcmVwYXJlZExvY2soCiAgcHJlcGFyZWQsCiAgY29udGV4dCwKICB7IHZhbGlkYXRlV2luZG93c0FjbCA9IGZhbHNlIH0gPSB7fSwKKSB7CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcHJlcGFyZWQucGF0aCk7CiAgY29uc3QgcGFyZW50U3RhdHMgPSBhd2FpdCBsc3RhdChwcmVwYXJlZC5wYXJlbnQsIHsgYmlnaW50OiB0cnVlIH0pOwogIGlmICghcGFyZW50U3RhdHMuaXNEaXJlY3RvcnkoKSB8fCBwYXJlbnRTdGF0cy5pc1N5bWJvbGljTGluaygpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIHBhcmVudCBpcyBubyBsb25nZXIgYSByZWFsIGRpcmVjdG9yeTogJHtwcmVwYXJlZC5wYXJlbnR9YCk7CiAgfQogIGFzc2VydFBvc2l4T3duZXJzaGlwKHBhcmVudFN0YXRzLCBwcmVwYXJlZC5wYXJlbnQsICJwYXJlbnQiKTsKICBjb25zdCBzdGF0cyA9IGF3YWl0IGxzdGF0KHByZXBhcmVkLnBhdGgsIHsgYmlnaW50OiB0cnVlIH0pOwogIGFzc2VydFJlZ3VsYXJTaW5nbGVMaW5rKHN0YXRzLCBwcmVwYXJlZC5wYXRoKTsKICBhc3NlcnRQb3NpeE93bmVyc2hpcChzdGF0cywgcHJlcGFyZWQucGF0aCwgImZpbGUiKTsKICBpZiAoc3RhdHMuZGV2ICE9PSBwcmVwYXJlZC5kZXYgfHwgc3RhdHMuaW5vICE9PSBwcmVwYXJlZC5pbm8pIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWdlbmM6IGxvY2sgZGF0YWJhc2UgaWRlbnRpdHkgY2hhbmdlZCBkdXJpbmcgYWNxdWlzaXRpb246ICR7cHJlcGFyZWQucGF0aH1gKTsKICB9CiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICJ3aW4zMiIgJiYgdmFsaWRhdGVXaW5kb3dzQWNsKSB7CiAgICBhd2FpdCBhc3NlcnRXaW5kb3dzUGF0aFNlY3VyaXR5KFsKICAgICAgeyBwYXRoOiBwcmVwYXJlZC5wYXJlbnQsIHJvbGU6ICJsZWFmRGlyZWN0b3J5IiB9LAogICAgICB7IHBhdGg6IHByZXBhcmVkLnBhdGgsIHJvbGU6ICJmaWxlIiB9LAogICAgXSwgY29udGV4dCk7CiAgfSBlbHNlIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAiZGFyd2luIikgewogICAgYXdhaXQgYXNzZXJ0RGFyd2luUGF0aFNlY3VyaXR5KHByZXBhcmVkLnBhdGgsICJsb2NrIGRhdGFiYXNlIGZpbGUiLCBjb250ZXh0KTsKICB9CiAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcHJlcGFyZWQucGF0aCk7Cn0KCmZ1bmN0aW9uIHByYWdtYVZhbHVlKGRhdGFiYXNlLCBwcmFnbWEpIHsKICBjb25zdCByb3cgPSBkYXRhYmFzZS5wcmVwYXJlKGBQUkFHTUEgJHtwcmFnbWF9YCkuZ2V0KCk7CiAgcmV0dXJuIHJvdyA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogT2JqZWN0LnZhbHVlcyhyb3cpWzBdOwp9CgpmdW5jdGlvbiBwcmFnbWFOdW1iZXIoZGF0YWJhc2UsIHByYWdtYSkgewogIGNvbnN0IHZhbHVlID0gcHJhZ21hVmFsdWUoZGF0YWJhc2UsIHByYWdtYSk7CiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gIm51bWJlciIgPyB2YWx1ZSA6IHVuZGVmaW5lZDsKfQoKZnVuY3Rpb24gcHJhZ21hVGV4dChkYXRhYmFzZSwgcHJhZ21hKSB7CiAgY29uc3QgdmFsdWUgPSBwcmFnbWFWYWx1ZShkYXRhYmFzZSwgcHJhZ21hKTsKICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAic3RyaW5nIiA/IHZhbHVlLnRvTG93ZXJDYXNlKCkgOiB1bmRlZmluZWQ7Cn0KCmV4cG9ydCBmdW5jdGlvbiBjb25maWd1cmVMb2NhbFNxbGl0ZUxvY2tDb25uZWN0aW9uKGRhdGFiYXNlKSB7CiAgZGF0YWJhc2UuZXhlYygiUFJBR01BIGJ1c3lfdGltZW91dCA9IDAiKTsKICBkYXRhYmFzZS5leGVjKCJQUkFHTUEgdHJ1c3RlZF9zY2hlbWEgPSBPRkYiKTsKICBkYXRhYmFzZS5leGVjKCJQUkFHTUEgc3luY2hyb25vdXMgPSBFWFRSQSIpOwogIGRhdGFiYXNlLmVuYWJsZURlZmVuc2l2ZSh0cnVlKTsKICBkYXRhYmFzZS5lbmFibGVMb2FkRXh0ZW5zaW9uKGZhbHNlKTsKICBpZiAoCiAgICBwcmFnbWFOdW1iZXIoZGF0YWJhc2UsICJidXN5X3RpbWVvdXQiKSAhPT0gMCB8fAogICAgcHJhZ21hTnVtYmVyKGRhdGFiYXNlLCAidHJ1c3RlZF9zY2hlbWEiKSAhPT0gMCB8fAogICAgcHJhZ21hTnVtYmVyKGRhdGFiYXNlLCAic3luY2hyb25vdXMiKSAhPT0gMwogICkgewogICAgdGhyb3cgbmV3IEVycm9yKCJhZ2VuYzogU1FMaXRlIGxvY2sgY29ubmVjdGlvbiBoYXJkZW5pbmcgZGlkIG5vdCB0YWtlIGVmZmVjdCIpOwogIH0KfQoKZnVuY3Rpb24gaW5zcGVjdExvY2tEYXRhYmFzZShkYXRhYmFzZSwgcGF0aCkgewogIGNvbnN0IGFwcGxpY2F0aW9uSWQgPSBwcmFnbWFOdW1iZXIoZGF0YWJhc2UsICJhcHBsaWNhdGlvbl9pZCIpOwogIGlmIChhcHBsaWNhdGlvbklkID09PSAwKSB7CiAgICBjb25zdCByb3cgPSBkYXRhYmFzZS5wcmVwYXJlKAogICAgICAiU0VMRUNUIGNvdW50KCopIEFTIGNvdW50IEZST00gc3FsaXRlX3NjaGVtYSBXSEVSRSBuYW1lIE5PVCBMSUtFICdzcWxpdGVfJSciLAogICAgKS5nZXQoKTsKICAgIGlmIChyb3c/LmNvdW50ICE9PSAwKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigKICAgICAgICBgYWdlbmM6IHJlZnVzaW5nIHRvIHJldXNlIGFuIHVucmVsYXRlZCBTUUxpdGUgZGF0YWJhc2UgYXMgYSBsb2NrOiAke3BhdGh9YCwKICAgICAgKTsKICAgIH0KICAgIHJldHVybiAiZW1wdHkiOwogIH0KICBpZiAoYXBwbGljYXRpb25JZCAhPT0gTE9DS19BUFBMSUNBVElPTl9JRCkgewogICAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogbG9jayBkYXRhYmFzZSBoYXMgYW4gaW5jb21wYXRpYmxlIGFwcGxpY2F0aW9uIGlkOiAke3BhdGh9YCk7CiAgfQogIHRyeSB7CiAgICBjb25zdCBzY2hlbWEgPSBkYXRhYmFzZS5wcmVwYXJlKAogICAgICAiU0VMRUNUIHR5cGUsIHNxbCBGUk9NIHNxbGl0ZV9zY2hlbWEgV0hFUkUgbmFtZSA9ICdhZ2VuY19sb2NhbF9wcm9jZXNzX2xvY2snIiwKICAgICkuZ2V0KCk7CiAgICBjb25zdCBvYmplY3RzID0gZGF0YWJhc2UucHJlcGFyZSgKICAgICAgIlNFTEVDVCBjb3VudCgqKSBBUyBjb3VudCBGUk9NIHNxbGl0ZV9zY2hlbWEgV0hFUkUgbmFtZSBOT1QgTElLRSAnc3FsaXRlXyUnIiwKICAgICkuZ2V0KCk7CiAgICBjb25zdCByb3dzID0gZGF0YWJhc2UucHJlcGFyZSgKICAgICAgIlNFTEVDVCBzaW5nbGV0b24sIGZvcm1hdF92ZXJzaW9uIEZST00gYWdlbmNfbG9jYWxfcHJvY2Vzc19sb2NrIiwKICAgICkuYWxsKCk7CiAgICBjb25zdCBub3JtYWxpemVkU2NoZW1hID0gdHlwZW9mIHNjaGVtYT8uc3FsID09PSAic3RyaW5nIgogICAgICA/IHNjaGVtYS5zcWwucmVwbGFjZSgvXHMrL2csICIgIikudHJpbSgpCiAgICAgIDogdW5kZWZpbmVkOwogICAgaWYgKAogICAgICBzY2hlbWE/LnR5cGUgIT09ICJ0YWJsZSIgfHwKICAgICAgbm9ybWFsaXplZFNjaGVtYSAhPT0KICAgICAgICAiQ1JFQVRFIFRBQkxFIGFnZW5jX2xvY2FsX3Byb2Nlc3NfbG9jayAoIHNpbmdsZXRvbiBJTlRFR0VSIFBSSU1BUlkgS0VZIENIRUNLIChzaW5nbGV0b24gPSAxKSwgZm9ybWF0X3ZlcnNpb24gSU5URUdFUiBOT1QgTlVMTCApIFNUUklDVCIgfHwKICAgICAgb2JqZWN0cz8uY291bnQgIT09IDEgfHwKICAgICAgcm93cy5sZW5ndGggIT09IDEgfHwKICAgICAgcm93c1swXT8uc2luZ2xldG9uICE9PSAxIHx8CiAgICAgIHJvd3NbMF0/LmZvcm1hdF92ZXJzaW9uICE9PSBMT0NLX0ZPUk1BVF9WRVJTSU9OCiAgICApIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJpbnZhbGlkIHNlbnRpbmVsIHNjaGVtYSIpOwogICAgfQogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFnZW5jOiBsb2NrIGRhdGFiYXNlIGhhcyBhbiBpbmNvbXBhdGlibGUgZm9ybWF0OiAke3BhdGh9YCwgewogICAgICBjYXVzZTogZXJyb3IsCiAgICB9KTsKICB9CiAgcmV0dXJuICJ2YWxpZCI7Cn0KCmZ1bmN0aW9uIGJ1c3lUcmFuc2l0aW9uRXJyb3IocGF0aCwgbW9kZSkgewogIHJldHVybiBPYmplY3QuYXNzaWduKAogICAgbmV3IEVycm9yKGBhZ2VuYzogU1FMaXRlIGxvY2sgam91cm5hbCBtb2RlIHJlbWFpbmVkICR7bW9kZSA/PyAidW5rbm93biJ9OiAke3BhdGh9YCksCiAgICB7IGVycmNvZGU6IFNRTElURV9CVVNZIH0sCiAgKTsKfQoKZnVuY3Rpb24gYmVnaW5BbmRWYWxpZGF0ZUxvY2soZGF0YWJhc2UsIHBhdGgsIGNvbnRleHQpIHsKICBmb3IgKGxldCBwaGFzZSA9IDA7IHBoYXNlIDwgODsgcGhhc2UgKz0gMSkgewogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSB0cmFuc2FjdGlvbiBiZWdpbiBzdGFydGVkIik7CiAgICBkYXRhYmFzZS5leGVjKCJCRUdJTiBJTU1FRElBVEUiKTsKICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgdHJhbnNhY3Rpb24gYmVnaW4gY29tcGxldGUiKTsKICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgbG9jayBkYXRhYmFzZSBpbnNwZWN0aW9uIHN0YXJ0ZWQiKTsKICAgIGNvbnN0IHN0YXRlID0gaW5zcGVjdExvY2tEYXRhYmFzZShkYXRhYmFzZSwgcGF0aCk7CiAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIGxvY2sgZGF0YWJhc2UgaW5zcGVjdGlvbiBjb21wbGV0ZSIpOwogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBqb3VybmFsIG1vZGUgaW5zcGVjdGlvbiBzdGFydGVkIik7CiAgICBjb25zdCBqb3VybmFsTW9kZSA9IHByYWdtYVRleHQoZGF0YWJhc2UsICJqb3VybmFsX21vZGUiKTsKICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgam91cm5hbCBtb2RlIGluc3BlY3Rpb24gY29tcGxldGUiKTsKICAgIGlmIChqb3VybmFsTW9kZSAhPT0gImRlbGV0ZSIpIHsKICAgICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBqb3VybmFsIG1vZGUgcmVzZXQgc3RhcnRlZCIpOwogICAgICBkYXRhYmFzZS5leGVjKCJST0xMQkFDSyIpOwogICAgICBjb25zdCBzZWxlY3RlZCA9IHByYWdtYVRleHQoZGF0YWJhc2UsICJqb3VybmFsX21vZGU9REVMRVRFIik7CiAgICAgIGlmIChzZWxlY3RlZCAhPT0gImRlbGV0ZSIpIHRocm93IGJ1c3lUcmFuc2l0aW9uRXJyb3IocGF0aCwgc2VsZWN0ZWQpOwogICAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIGpvdXJuYWwgbW9kZSByZXNldCBjb21wbGV0ZSIpOwogICAgICBjb250aW51ZTsKICAgIH0KICAgIGlmIChzdGF0ZSA9PT0gImVtcHR5IikgewogICAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIGxvY2sgZGF0YWJhc2UgaW5pdGlhbGl6YXRpb24gc3RhcnRlZCIpOwogICAgICBkYXRhYmFzZS5leGVjKGAKICAgICAgICBQUkFHTUEgYXBwbGljYXRpb25faWQgPSAke0xPQ0tfQVBQTElDQVRJT05fSUR9OwogICAgICAgIENSRUFURSBUQUJMRSBhZ2VuY19sb2NhbF9wcm9jZXNzX2xvY2sgKAogICAgICAgICAgc2luZ2xldG9uIElOVEVHRVIgUFJJTUFSWSBLRVkgQ0hFQ0sgKHNpbmdsZXRvbiA9IDEpLAogICAgICAgICAgZm9ybWF0X3ZlcnNpb24gSU5URUdFUiBOT1QgTlVMTAogICAgICAgICkgU1RSSUNUOwogICAgICAgIElOU0VSVCBJTlRPIGFnZW5jX2xvY2FsX3Byb2Nlc3NfbG9jayAoc2luZ2xldG9uLCBmb3JtYXRfdmVyc2lvbikKICAgICAgICBWQUxVRVMgKDEsICR7TE9DS19GT1JNQVRfVkVSU0lPTn0pOwogICAgICAgIENPTU1JVDsKICAgICAgYCk7CiAgICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgbG9jayBkYXRhYmFzZSBpbml0aWFsaXphdGlvbiBjb21wbGV0ZSIpOwogICAgICBjb250aW51ZTsKICAgIH0KICAgIHJldHVybjsKICB9CiAgdGhyb3cgbmV3IEVycm9yKGBhZ2VuYzogbG9jayBkYXRhYmFzZSBpbml0aWFsaXphdGlvbiBkaWQgbm90IGNvbnZlcmdlOiAke3BhdGh9YCk7Cn0KCmZ1bmN0aW9uIGNsb3NlRGF0YWJhc2UoZGF0YWJhc2UpIHsKICBpZiAoIWRhdGFiYXNlPy5pc09wZW4pIHJldHVybjsKICBjb25zdCBlcnJvcnMgPSBbXTsKICB0cnkgewogICAgaWYgKGRhdGFiYXNlLmlzVHJhbnNhY3Rpb24pIGRhdGFiYXNlLmV4ZWMoIlJPTExCQUNLIik7CiAgfSBjYXRjaCAoZXJyb3IpIHsKICAgIGVycm9ycy5wdXNoKGVycm9yKTsKICB9CiAgdHJ5IHsKICAgIGRhdGFiYXNlLmNsb3NlKCk7CiAgfSBjYXRjaCAoZXJyb3IpIHsKICAgIGVycm9ycy5wdXNoKGVycm9yKTsKICB9CiAgaWYgKGVycm9ycy5sZW5ndGggPT09IDEpIHRocm93IGVycm9yc1swXTsKICBpZiAoZXJyb3JzLmxlbmd0aCA+IDEpIHsKICAgIHRocm93IG5ldyBBZ2dyZWdhdGVFcnJvcihlcnJvcnMsICJhZ2VuYzogZmFpbGVkIHRvIGNsb3NlIGEgbG9jYWwgcHJvY2VzcyBsb2NrIGRhdGFiYXNlIik7CiAgfQp9CgpleHBvcnQgZnVuY3Rpb24gaXNTcWxpdGVCdXN5RXJyb3IoZXJyb3IpIHsKICByZXR1cm4gdHlwZW9mIGVycm9yPy5lcnJjb2RlID09PSAibnVtYmVyIiAmJgogICAgKGVycm9yLmVycmNvZGUgJiAweGZmKSA9PT0gU1FMSVRFX0JVU1k7Cn0KCmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JCdXN5UmV0cnkoY29udGV4dCwgcGF0aCwgYXR0ZW1wdCwgY2F1c2UpIHsKICBjb25zdCByZW1haW5pbmcgPSByZW1haW5pbmdNaWxsaXNlY29uZHMoY29udGV4dCk7CiAgaWYgKHJlbWFpbmluZyA8PSAwKSB0aHJvdyB0aW1lb3V0RXJyb3IoY29udGV4dCwgcGF0aCwgY2F1c2UpOwogIGNvbnN0IGV4cG9uZW50aWFsQ2FwID0gTWF0aC5taW4oTUFYX0JVU1lfUkVUUllfTVMsIDIgKiogTWF0aC5taW4oYXR0ZW1wdCwgNikpOwogIGNvbnN0IGppdHRlciA9IE1hdGgubWF4KDEsIE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIChleHBvbmVudGlhbENhcCArIDEpKSk7CiAgYXdhaXQgZGVsYXkoTWF0aC5taW4ocmVtYWluaW5nLCBqaXR0ZXIpKTsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwYXRoLCBjYXVzZSk7Cn0KCmFzeW5jIGZ1bmN0aW9uIGFjcXVpcmVTcWxpdGVEYXRhYmFzZShEYXRhYmFzZVN5bmMsIHByZXBhcmVkLCBjb250ZXh0KSB7CiAgbGV0IGF0dGVtcHQgPSAwOwogIGxldCBsYXN0QnVzeTsKICB3aGlsZSAodHJ1ZSkgewogICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcHJlcGFyZWQucGF0aCwgbGFzdEJ1c3kpOwogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBwcmUtb3BlbiBsb2NrIHZhbGlkYXRpb24gc3RhcnRlZCIpOwogICAgYXdhaXQgcmV2YWxpZGF0ZVByZXBhcmVkTG9jayhwcmVwYXJlZCwgY29udGV4dCwgewogICAgICAvLyBUaGUgY3JlYXRpb24gcGF0aCBhbHJlYWR5IHZhbGlkYXRlZCB0aGUgY29tcGxldGUgYW5jZXN0b3IgY2hhaW4gYW5kCiAgICAgIC8vIHRoZSBleGFjdCBwYXJlbnQvZmlsZSBBQ0xzLiBSZXZhbGlkYXRlIEFDTHMgYWZ0ZXIgY29udGVudGlvbiBiZWNhdXNlCiAgICAgIC8vIGFub3RoZXIgaG9sZGVyIGFuZCBhbiB1bmJvdW5kZWQgaW50ZXJ2YWwgaGF2ZSBjcm9zc2VkIHRoaXMgYXR0ZW1wdC4KICAgICAgdmFsaWRhdGVXaW5kb3dzQWNsOiBhdHRlbXB0ID4gMCwKICAgIH0pOwogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBwcmUtb3BlbiBsb2NrIHZhbGlkYXRpb24gY29tcGxldGUiKTsKICAgIGxldCBkYXRhYmFzZTsKICAgIHRyeSB7CiAgICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgZGF0YWJhc2Ugb3BlbiBzdGFydGVkIik7CiAgICAgIGRhdGFiYXNlID0gbmV3IERhdGFiYXNlU3luYyhwcmVwYXJlZC5wYXRoLCB7CiAgICAgICAgYWxsb3dFeHRlbnNpb246IGZhbHNlLAogICAgICAgIHRpbWVvdXQ6IDAsCiAgICAgIH0pOwogICAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIGRhdGFiYXNlIG9wZW4gY29tcGxldGUiKTsKICAgICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBjb25uZWN0aW9uIGhhcmRlbmluZyBzdGFydGVkIik7CiAgICAgIGNvbmZpZ3VyZUxvY2FsU3FsaXRlTG9ja0Nvbm5lY3Rpb24oZGF0YWJhc2UpOwogICAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIGNvbm5lY3Rpb24gaGFyZGVuaW5nIGNvbXBsZXRlIik7CiAgICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgcG9zdC1vcGVuIGxvY2sgdmFsaWRhdGlvbiBzdGFydGVkIik7CiAgICAgIGF3YWl0IHJldmFsaWRhdGVQcmVwYXJlZExvY2socHJlcGFyZWQsIGNvbnRleHQpOwogICAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIHBvc3Qtb3BlbiBsb2NrIHZhbGlkYXRpb24gY29tcGxldGUiKTsKICAgICAgYmVnaW5BbmRWYWxpZGF0ZUxvY2soZGF0YWJhc2UsIHByZXBhcmVkLnBhdGgsIGNvbnRleHQpOwogICAgICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBwcmVwYXJlZC5wYXRoLCBsYXN0QnVzeSk7CiAgICAgIHJldHVybiBkYXRhYmFzZTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIGNvbnN0IGNsZWFudXBFcnJvcnMgPSBbXTsKICAgICAgaWYgKGRhdGFiYXNlICE9PSB1bmRlZmluZWQpIHsKICAgICAgICB0cnkgewogICAgICAgICAgY2xvc2VEYXRhYmFzZShkYXRhYmFzZSk7CiAgICAgICAgfSBjYXRjaCAoY2xlYW51cEVycm9yKSB7CiAgICAgICAgICBjbGVhbnVwRXJyb3JzLnB1c2goY2xlYW51cEVycm9yKTsKICAgICAgICB9CiAgICAgIH0KICAgICAgaWYgKGNsZWFudXBFcnJvcnMubGVuZ3RoID4gMCkgewogICAgICAgIHRocm93IG5ldyBBZ2dyZWdhdGVFcnJvcigKICAgICAgICAgIFtlcnJvciwgLi4uY2xlYW51cEVycm9yc10sCiAgICAgICAgICBgYWdlbmM6IGxvY2sgYXR0ZW1wdCBhbmQgY2xlYW51cCBib3RoIGZhaWxlZCBmb3IgJHtwcmVwYXJlZC5wYXRofWAsCiAgICAgICAgKTsKICAgICAgfQogICAgICBpZiAoIWlzU3FsaXRlQnVzeUVycm9yKGVycm9yKSkgdGhyb3cgZXJyb3I7CiAgICAgIGxhc3RCdXN5ID0gZXJyb3I7CiAgICAgIGF0dGVtcHQgKz0gMTsKICAgICAgYXdhaXQgd2FpdEZvckJ1c3lSZXRyeShjb250ZXh0LCBwcmVwYXJlZC5wYXRoLCBhdHRlbXB0LCBsYXN0QnVzeSk7CiAgICB9CiAgfQp9CgpmdW5jdGlvbiByZWxlYXNlQWNxdWlyZWQoYWNxdWlyZWQsIGxhYmVsKSB7CiAgY29uc3QgZXJyb3JzID0gW107CiAgZm9yIChjb25zdCBpdGVtIG9mIGFjcXVpcmVkLnRvUmV2ZXJzZWQoKSkgewogICAgdHJ5IHsKICAgICAgY2xvc2VEYXRhYmFzZShpdGVtLmRhdGFiYXNlKTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIGVycm9ycy5wdXNoKGVycm9yKTsKICAgIH0KICAgIGlmICgoIWl0ZW0uZGF0YWJhc2UgfHwgIWl0ZW0uZGF0YWJhc2UuaXNPcGVuKSAmJiAhaXRlbS5pblByb2Nlc3NSZWxlYXNlZCkgewogICAgICB0cnkgewogICAgICAgIGl0ZW0ucmVsZWFzZUluUHJvY2VzcygpOwogICAgICAgIGl0ZW0uaW5Qcm9jZXNzUmVsZWFzZWQgPSB0cnVlOwogICAgICB9IGNhdGNoIChlcnJvcikgewogICAgICAgIGVycm9ycy5wdXNoKGVycm9yKTsKICAgICAgfQogICAgfQogIH0KICBpZiAoZXJyb3JzLmxlbmd0aCA9PT0gMSkgdGhyb3cgZXJyb3JzWzBdOwogIGlmIChlcnJvcnMubGVuZ3RoID4gMSkgewogICAgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKGVycm9ycywgYGFnZW5jOiAke2xhYmVsfSBsb2NrIHJlbGVhc2UgZmFpbGVkYCk7CiAgfQp9CgpleHBvcnQgYXN5bmMgZnVuY3Rpb24gYWNxdWlyZUxvY2FsU3FsaXRlTG9ja3MoCiAgcmVxdWVzdGVkUGF0aHMsCiAgewogICAgdGltZW91dE1zID0gNjBfMDAwLAogICAgbGFiZWwgPSAiQWdlbkMgb3BlcmF0aW9uIiwKICAgIGRlYWRsaW5lOiBzdXBwbGllZERlYWRsaW5lLAogICAgb25Qcm9ncmVzcywKICB9ID0ge30sCikgewogIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIodGltZW91dE1zKSB8fCB0aW1lb3V0TXMgPD0gMCkgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayB0aW1lb3V0TXMgbXVzdCBiZSBhIHBvc2l0aXZlIHNhZmUgaW50ZWdlciIpOwogIH0KICBpZiAoc3VwcGxpZWREZWFkbGluZSAhPT0gdW5kZWZpbmVkICYmICFOdW1iZXIuaXNGaW5pdGUoc3VwcGxpZWREZWFkbGluZSkpIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgZGVhZGxpbmUgbXVzdCBiZSBmaW5pdGUiKTsKICB9CiAgaWYgKCFBcnJheS5pc0FycmF5KHJlcXVlc3RlZFBhdGhzKSkgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcigibG9jayBwYXRocyBtdXN0IGJlIGFuIGFycmF5Iik7CiAgfQogIGlmIChvblByb2dyZXNzICE9PSB1bmRlZmluZWQgJiYgdHlwZW9mIG9uUHJvZ3Jlc3MgIT09ICJmdW5jdGlvbiIpIHsKICAgIHRocm93IG5ldyBUeXBlRXJyb3IoImxvY2sgb25Qcm9ncmVzcyBtdXN0IGJlIGEgZnVuY3Rpb24iKTsKICB9CiAgaWYgKHJlcXVlc3RlZFBhdGhzLmxlbmd0aCA9PT0gMCkgcmV0dXJuICgpID0+IHt9OwoKICBjb25zdCBzdGFydGVkQXQgPSBwZXJmb3JtYW5jZS5ub3coKTsKICBjb25zdCBjb250ZXh0ID0gewogICAgZGVhZGxpbmU6IE1hdGgubWluKAogICAgICBzdXBwbGllZERlYWRsaW5lID8/IE51bWJlci5QT1NJVElWRV9JTkZJTklUWSwKICAgICAgc3RhcnRlZEF0ICsgdGltZW91dE1zLAogICAgKSwKICAgIGxhYmVsLAogICAgdGltZW91dE1zLAogICAgb25Qcm9ncmVzcywKICB9OwogIGNvbnN0IGZpcnN0RGlzcGxheVBhdGggPSByZXNvbHZlKHJlcXVlc3RlZFBhdGhzWzBdKTsKICB0aHJvd0lmRXhwaXJlZChjb250ZXh0LCBmaXJzdERpc3BsYXlQYXRoKTsKCiAgY29uc3QgcHJlcGFyZWRCeUlkZW50aXR5ID0gbmV3IE1hcCgpOwogIGZvciAoY29uc3QgcmVxdWVzdGVkUGF0aCBvZiByZXF1ZXN0ZWRQYXRocykgewogICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgcmVzb2x2ZShyZXF1ZXN0ZWRQYXRoKSk7CiAgICBjb25zdCBwcmVwYXJlZCA9IGF3YWl0IHByZXBhcmVMb2NrUGF0aChyZXF1ZXN0ZWRQYXRoLCBjb250ZXh0KTsKICAgIHByZXBhcmVkQnlJZGVudGl0eS5zZXQocHJlcGFyZWQuaWRlbnRpdHlLZXksIHByZXBhcmVkKTsKICB9CiAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgImxvY2sgcGF0aCBwcmVwYXJhdGlvbiBjb21wbGV0ZSIpOwogIGNvbnN0IHByZXBhcmVkTG9ja3MgPSBbLi4ucHJlcGFyZWRCeUlkZW50aXR5LnZhbHVlcygpXS5zb3J0KChsZWZ0LCByaWdodCkgPT4KICAgIGxlZnQuaWRlbnRpdHlLZXkgPCByaWdodC5pZGVudGl0eUtleSA/IC0xIDogbGVmdC5pZGVudGl0eUtleSA+IHJpZ2h0LmlkZW50aXR5S2V5ID8gMSA6IDApOwogIGNvbnN0IHBlbmRpbmdMb2NhbCA9IFtdOwogIGNvbnN0IGFjcXVpcmVkID0gW107CiAgbGV0IGN1cnJlbnRQYXRoID0gcHJlcGFyZWRMb2Nrc1swXT8ucGF0aCA/PyBmaXJzdERpc3BsYXlQYXRoOwogIHRyeSB7CiAgICBmb3IgKGNvbnN0IHByZXBhcmVkIG9mIHByZXBhcmVkTG9ja3MpIHsKICAgICAgY3VycmVudFBhdGggPSBwcmVwYXJlZC5wYXRoOwogICAgICBjb25zdCByZWxlYXNlID0gYXdhaXQgYWNxdWlyZUluUHJvY2Vzc0xvY2socHJlcGFyZWQsIGNvbnRleHQpOwogICAgICBwZW5kaW5nTG9jYWwucHVzaCh7IHByZXBhcmVkLCByZWxlYXNlIH0pOwogICAgfQogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgImluLXByb2Nlc3MgbG9jayBhY3F1aXNpdGlvbiBjb21wbGV0ZSIpOwogICAgdGhyb3dJZkV4cGlyZWQoY29udGV4dCwgY3VycmVudFBhdGgpOwogICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSBtb2R1bGUgaW1wb3J0IHN0YXJ0ZWQiKTsKICAgIGNvbnN0IHsgRGF0YWJhc2VTeW5jIH0gPSBhd2FpdCBpbXBvcnQoIm5vZGU6c3FsaXRlIik7CiAgICByZXBvcnRQcm9ncmVzcyhjb250ZXh0LCAiU1FMaXRlIG1vZHVsZSBpbXBvcnQgY29tcGxldGUiKTsKICAgIHRocm93SWZFeHBpcmVkKGNvbnRleHQsIGN1cnJlbnRQYXRoKTsKICAgIGZvciAoY29uc3QgeyBwcmVwYXJlZCwgcmVsZWFzZSB9IG9mIHBlbmRpbmdMb2NhbCkgewogICAgICBjdXJyZW50UGF0aCA9IHByZXBhcmVkLnBhdGg7CiAgICAgIGNvbnN0IGl0ZW0gPSB7CiAgICAgICAgZGF0YWJhc2U6IHVuZGVmaW5lZCwKICAgICAgICByZWxlYXNlSW5Qcm9jZXNzOiByZWxlYXNlLAogICAgICAgIGluUHJvY2Vzc1JlbGVhc2VkOiBmYWxzZSwKICAgICAgfTsKICAgICAgYWNxdWlyZWQucHVzaChpdGVtKTsKICAgICAgcmVwb3J0UHJvZ3Jlc3MoY29udGV4dCwgIlNRTGl0ZSB0cmFuc2FjdGlvbiBhY3F1aXNpdGlvbiBzdGFydGVkIik7CiAgICAgIGl0ZW0uZGF0YWJhc2UgPSBhd2FpdCBhY3F1aXJlU3FsaXRlRGF0YWJhc2UoRGF0YWJhc2VTeW5jLCBwcmVwYXJlZCwgY29udGV4dCk7CiAgICAgIHJlcG9ydFByb2dyZXNzKGNvbnRleHQsICJTUUxpdGUgdHJhbnNhY3Rpb24gYWNxdWlzaXRpb24gY29tcGxldGUiKTsKICAgIH0KICB9IGNhdGNoIChlcnJvcikgewogICAgY29uc3QgY2xlYW51cEVycm9ycyA9IFtdOwogICAgdHJ5IHsKICAgICAgcmVsZWFzZUFjcXVpcmVkKGFjcXVpcmVkLCBsYWJlbCk7CiAgICB9IGNhdGNoIChjbGVhbnVwRXJyb3IpIHsKICAgICAgY2xlYW51cEVycm9ycy5wdXNoKGNsZWFudXBFcnJvcik7CiAgICB9CiAgICBmb3IgKGNvbnN0IHsgcmVsZWFzZSB9IG9mIHBlbmRpbmdMb2NhbC5zbGljZShhY3F1aXJlZC5sZW5ndGgpLnRvUmV2ZXJzZWQoKSkgewogICAgICB0cnkgewogICAgICAgIHJlbGVhc2UoKTsKICAgICAgfSBjYXRjaCAoY2xlYW51cEVycm9yKSB7CiAgICAgICAgY2xlYW51cEVycm9ycy5wdXNoKGNsZWFudXBFcnJvcik7CiAgICAgIH0KICAgIH0KICAgIGNvbnN0IGZvcm1hdHRlZCA9IGlzU3FsaXRlQnVzeUVycm9yKGVycm9yKQogICAgICA/IHRpbWVvdXRFcnJvcihjb250ZXh0LCBjdXJyZW50UGF0aCwgZXJyb3IpCiAgICAgIDogZXJyb3I7CiAgICBpZiAoY2xlYW51cEVycm9ycy5sZW5ndGggPiAwKSB7CiAgICAgIHRocm93IG5ldyBBZ2dyZWdhdGVFcnJvcigKICAgICAgICBbZm9ybWF0dGVkLCAuLi5jbGVhbnVwRXJyb3JzXSwKICAgICAgICBgYWdlbmM6ICR7bGFiZWx9IGxvY2sgYWNxdWlzaXRpb24gYW5kIHJvbGxiYWNrIGJvdGggZmFpbGVkYCwKICAgICAgKTsKICAgIH0KICAgIHRocm93IGZvcm1hdHRlZDsKICB9CgogIGxldCByZWxlYXNlZCA9IGZhbHNlOwogIHJldHVybiAoKSA9PiB7CiAgICBpZiAocmVsZWFzZWQpIHJldHVybjsKICAgIHJlbGVhc2VBY3F1aXJlZChhY3F1aXJlZCwgbGFiZWwpOwogICAgcmVsZWFzZWQgPSBhY3F1aXJlZC5ldmVyeSgoaXRlbSkgPT4gaXRlbS5pblByb2Nlc3NSZWxlYXNlZCk7CiAgfTsKfQoKZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFjcXVpcmVMb2NhbFNxbGl0ZUxvY2socGF0aCwgb3B0aW9ucykgewogIHJldHVybiBhY3F1aXJlTG9jYWxTcWxpdGVMb2NrcyhbcGF0aF0sIG9wdGlvbnMpOwp9Cg==";
let sqliteLockModulePromise;
function loadSqliteLockModule() {
  sqliteLockModulePromise ??= import(
    `data:text/javascript;base64,${AGENC_SQLITE_LOCK_SOURCE_BASE64}`,
  );
  return sqliteLockModulePromise;
}
// END GENERATED AGENC SQLITE LOCK MODULE

function strictRelativeRuntimeFile(root, relativePath) {
  if (relativePath.length === 0 || isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/).some((part) => part.length === 0 || part === "." || part === "..")) {
    return false;
  }
  const finalPath = resolve(root, relativePath);
  const within = relative(resolve(root), finalPath);
  if (within === "" || within === ".." ||
      within.startsWith(`..${pathSeparator}`) || isAbsolute(within)) return false;
  let current = root;
  const parts = relativePath.split(/[\\/]/);
  try {
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return false;
      if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) return false;
    }
    return true;
  } catch { return false; }
}
function strictMarkerMatches(path) {
  try {
    const marker = join(path, ".agenc-runtime-ok");
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128) return false;
    const content = readFileSync(marker, "utf8");
    return content === expectedSha || content === `${expectedSha}\n`;
  } catch { return false; }
}
const PROVENANCE_RECEIPT_NAME = ".agenc-runtime-provenance-v1.json";
function compareAsciiKeys(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
function exactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort(compareAsciiKeys).join("\0") ===
      [...expected].sort(compareAsciiKeys).join("\0");
}
function decodeProvenanceJson(encoded, label) {
  if (encoded === "" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error(`invalid ${label}`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || bytes.length > 4096) throw new Error(`invalid ${label}`);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`invalid ${label}`); }
}
function validProvenanceExpectation(value) {
  const baseKeys = [
    "schema", "artifactSha256", "artifactUrl", "sourceRepository", "sourceWorkflow",
    "sourceCommit", "sourceRef", "attestationUrl", "attestationSha256",
    "attestationBytes", "verificationPolicy",
  ];
  const dual = value?.schema === "agenc-runtime-provenance/v2";
  return exactKeys(value, dual ? [
    ...baseKeys,
    "buildProvenanceUrl", "buildProvenanceSha256", "buildProvenanceBytes",
    "buildSourceRef",
  ] : baseKeys) &&
    (dual || value.schema === "agenc-runtime-provenance/v1") &&
    value.artifactSha256 === expectedSha &&
    typeof value.artifactUrl === "string" &&
    value.artifactUrl.startsWith("https://github.com/tetsuo-ai/agenc-releases/releases/download/") &&
    value.sourceRepository === "tetsuo-ai/agenc-core" &&
    value.sourceWorkflow === "tetsuo-ai/agenc-core/.github/workflows/release-runtime.yml" &&
    /^[0-9a-f]{40,64}$/.test(value.sourceCommit) &&
    /^refs\/tags\/agenc-v[^\r\n]+$/.test(value.sourceRef) &&
    value.attestationUrl === `${value.artifactUrl}.sigstore.json` &&
    /^[0-9a-f]{64}$/.test(value.attestationSha256) &&
    Number.isSafeInteger(value.attestationBytes) && value.attestationBytes > 0 &&
    value.attestationBytes <= 4 * 1024 * 1024 &&
    (!dual || (
      value.buildProvenanceUrl === `${value.artifactUrl}.build.sigstore.json` &&
      /^[0-9a-f]{64}$/.test(value.buildProvenanceSha256) &&
      Number.isSafeInteger(value.buildProvenanceBytes) &&
      value.buildProvenanceBytes > 0 &&
      value.buildProvenanceBytes <= 4 * 1024 * 1024 &&
      value.buildSourceRef === "refs/heads/main"
    )) &&
    exactKeys(value.verificationPolicy, [
      "hostname", "certOidcIssuer", "predicateType", "denySelfHostedRunners",
    ]) && value.verificationPolicy.hostname === "github.com" &&
    value.verificationPolicy.certOidcIssuer === "https://token.actions.githubusercontent.com" &&
    value.verificationPolicy.predicateType === "https://slsa.dev/provenance/v1" &&
    value.verificationPolicy.denySelfHostedRunners === true;
}
const provenanceExpectation = provenanceExpectationBase64 === ""
  ? undefined
  : decodeProvenanceJson(provenanceExpectationBase64, "provenance expectation");
if (provenanceExpectation !== undefined && !validProvenanceExpectation(provenanceExpectation)) {
  throw new Error("invalid provenance expectation");
}
function validProvenanceReceipt(value) {
  if (provenanceExpectation === undefined ||
      !exactKeys(value, Object.keys(provenanceExpectation))) return false;
  for (const key of Object.keys(provenanceExpectation)) {
    if (JSON.stringify(value[key]) !== JSON.stringify(provenanceExpectation[key])) return false;
  }
  return true;
}
function strictProvenanceReceiptMatches(path) {
  if (provenanceExpectation === undefined) return true;
  try {
    const receipt = join(path, PROVENANCE_RECEIPT_NAME);
    const stat = lstatSync(receipt);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 4096) return false;
    return validProvenanceReceipt(JSON.parse(readFileSync(receipt, "utf8")));
  } catch { return false; }
}
function readyAt(path) {
  try {
    const root = lstatSync(path);
    return root.isDirectory() && !root.isSymbolicLink() &&
      strictRelativeRuntimeFile(path, binRel) &&
      (embeddedNodeRel === "" || (
        strictRelativeRuntimeFile(path, embeddedNodeRel) &&
        strictRelativeRuntimeFile(path, "node_modules/.agenc-node/identity.json")
      )) &&
      (embeddedNodeLibraryRel === "" ||
        strictRelativeRuntimeFile(path, `${embeddedNodeLibraryRel}/libatomic.so.1`)) &&
      strictMarkerMatches(path) &&
      strictProvenanceReceiptMatches(path);
  } catch { return false; }
}
function hasResidue(versionDir, base) {
  return readdirSync(versionDir).some((name) =>
    name.startsWith(`.${base}.install-`) || name.startsWith(`${base}.old-`));
}

function promote(candidate, canonical) {
  const backup = `${canonical}.old-${process.pid}-${randomUUID()}`;
  let movedExisting = false;
  try {
    if (existsSync(canonical)) {
      renameSync(canonical, backup);
      syncDirectory(dirname(canonical));
      movedExisting = true;
    }
    renameSync(candidate, canonical);
    syncDirectory(dirname(canonical));
  } catch (error) {
    if (!existsSync(canonical) && movedExisting && existsSync(backup)) {
      try {
        renameSync(backup, canonical);
        syncDirectory(dirname(canonical));
      }
      catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `runtime promotion failed; prior tree retained at ${backup}`);
      }
    }
    throw error;
  }
}
async function trustedReadyAt(path, assertLocalPrivateDirectory) {
  if (!readyAt(path)) return false;
  const canonical = await assertLocalPrivateDirectory(path, {
    label: "runtime cache validation",
    timeoutMs: 120_000,
  });
  if (canonical !== resolve(path)) {
    throw new Error(`runtime cache must use its canonical path: ${path}`);
  }
  return readyAt(path);
}
async function reconcile(versionDir, base, assertLocalPrivateDirectory) {
  const entries = readdirSync(versionDir);
  const newestReady = async (prefix) => {
    const candidates = entries.filter((name) => name.startsWith(prefix))
      .map((name) => join(versionDir, name))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    for (const candidate of candidates) {
      if (await trustedReadyAt(candidate, assertLocalPrivateDirectory)) return candidate;
    }
    return undefined;
  };
  if (!(await trustedReadyAt(installDir, assertLocalPrivateDirectory))) {
    const candidate = await newestReady(`.${base}.install-`) ??
      await newestReady(`${base}.old-`);
    if (candidate !== undefined) promote(candidate, installDir);
  }
  if (!(await trustedReadyAt(installDir, assertLocalPrivateDirectory))) return false;
  for (const name of readdirSync(versionDir)) {
    if (name.startsWith(`.${base}.install-`) || name.startsWith(`${base}.old-`)) {
      try { removeDurably(join(versionDir, name), { recursive: true, force: true }); } catch { /* retry later */ }
    }
  }
  return true;
}

function readOptionalFile(path) {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
function replaceFileAtomically(path, content, fileMode) {
  const temporary = `${path}.agenc-activate-${process.pid}-${randomUUID()}`;
  try {
    writeFileDurably(temporary, content, { flag: "wx", mode: fileMode });
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    try {
      if (existsSync(temporary)) removeDurably(temporary, { force: true });
    } catch { /* transaction recovery retries */ }
  }
}
// BEGIN GENERATED AGENC WRAPPER CONTRACT MODULE
// Generated by scripts/sync-installer-sqlite-lock.mjs from the canonical
// launcher module. Do not edit this embedded payload by hand.
const AGENC_GENERATED_WRAPPER_SOURCE_BASE64 = "Ly8gQnl0ZS1jYW5vbmljYWwgc3RhbmRhbG9uZS1pbnN0YWxsZXIgd3JhcHBlciBjb250cmFjdCBzaGFyZWQgYnkgdGhlIHJ1bnRpbWUKLy8gdXBkYXRlciBhbmQgYm90aCBlbWJlZGRlZCBpbnN0YWxsZXJzLiBQYXJzaW5nIGlzIGRlbGliZXJhdGVseSBmdWxsLWZpbGU6Ci8vIG1hcmtlciBzdWJzdHJpbmdzIG11c3QgbmV2ZXIgZ3JhbnQgb3duZXJzaGlwIG9mIGEgdXNlci1hdXRob3JlZCBleGVjdXRhYmxlLgoKaW1wb3J0IHsgaXNBYnNvbHV0ZSwgcG9zaXgsIHdpbjMyIH0gZnJvbSAibm9kZTpwYXRoIjsKCmV4cG9ydCBjb25zdCBHRU5FUkFURURfV1JBUFBFUl9NQVhfQllURVMgPSA2NCAqIDEwMjQ7CmNvbnN0IFBPU0lYX1dSQVBQRVJfU0lHTkFUVVJFID0gIkdlbmVyYXRlZCBieSBBZ2VuQyBpbnN0YWxsLnNoIjsKY29uc3QgQ01EX1dSQVBQRVJfU0lHTkFUVVJFID0gIkdlbmVyYXRlZCBieSBBZ2VuQyBpbnN0YWxsLnBzMSI7CmNvbnN0IFdSQVBQRVJfTUVUQURBVEFfUFJFRklYID0gIkFnZW5DIHdyYXBwZXIgbWV0YWRhdGEgdjE6IjsKCmZ1bmN0aW9uIHZhbGlkYXRlVmFsdWVzKGtpbmQsIHZhbHVlcykgewogIGlmICghdmFsdWVzIHx8IHR5cGVvZiB2YWx1ZXMgIT09ICJvYmplY3QiKSB7CiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCJ3cmFwcGVyIHZhbHVlcyBtdXN0IGJlIGFuIG9iamVjdCIpOwogIH0KICBmb3IgKGNvbnN0IGxhYmVsIG9mIFsibm9kZUJpbiIsICJydW50aW1lQmluIiwgImFnZW5jSG9tZSJdKSB7CiAgICBjb25zdCB2YWx1ZSA9IHZhbHVlc1tsYWJlbF07CiAgICBpZiAodHlwZW9mIHZhbHVlICE9PSAic3RyaW5nIikgdGhyb3cgbmV3IFR5cGVFcnJvcihgd3JhcHBlciAke2xhYmVsfSBtdXN0IGJlIGEgc3RyaW5nYCk7CiAgICBpZiAodmFsdWUuaW5jbHVkZXMoIlwwIikpIHRocm93IG5ldyBFcnJvcihgd3JhcHBlciAke2xhYmVsfSBjb250YWlucyBOVUxgKTsKICAgIGlmIChraW5kID09PSAiY21kIiAmJiAvWyJcclxuXS91LnRlc3QodmFsdWUpKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgV2luZG93cyB3cmFwcGVyICR7bGFiZWx9IGNvbnRhaW5zIGFuIHVuc3VwcG9ydGVkIGNoYXJhY3RlcmApOwogICAgfQogIH0KICBpZiAoIWlzQWJzb2x1dGUodmFsdWVzLmFnZW5jSG9tZSkpIHsKICAgIHRocm93IG5ldyBFcnJvcigid3JhcHBlciBBR0VOQ19IT01FIG11c3QgYmUgYW4gYWJzb2x1dGUgcGF0aCIpOwogIH0KICBpZiAodmFsdWVzLm5vZGVMaWJyYXJ5UGF0aCAhPT0gdW5kZWZpbmVkKSB7CiAgICBpZiAodHlwZW9mIHZhbHVlcy5ub2RlTGlicmFyeVBhdGggIT09ICJzdHJpbmciKSB7CiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoIndyYXBwZXIgbm9kZUxpYnJhcnlQYXRoIG11c3QgYmUgYSBzdHJpbmciKTsKICAgIH0KICAgIGlmICh2YWx1ZXMubm9kZUxpYnJhcnlQYXRoLmluY2x1ZGVzKCJcMCIpKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigid3JhcHBlciBub2RlTGlicmFyeVBhdGggY29udGFpbnMgTlVMIik7CiAgICB9CiAgICBpZiAoIWlzQWJzb2x1dGUodmFsdWVzLm5vZGVMaWJyYXJ5UGF0aCkpIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJ3cmFwcGVyIG5vZGVMaWJyYXJ5UGF0aCBtdXN0IGJlIGFuIGFic29sdXRlIHBhdGgiKTsKICAgIH0KICAgIGlmIChraW5kID09PSAiY21kIikgewogICAgICB0aHJvdyBuZXcgRXJyb3IoIldpbmRvd3Mgd3JhcHBlcnMgZG8gbm90IHN1cHBvcnQgbm9kZUxpYnJhcnlQYXRoIik7CiAgICB9CiAgfQp9CgpmdW5jdGlvbiBtZXRhZGF0YUZvcih2YWx1ZXMpIHsKICBjb25zdCBtZXRhZGF0YSA9IHsKICAgIG5vZGVCaW46IHZhbHVlcy5ub2RlQmluLAogICAgcnVudGltZUJpbjogdmFsdWVzLnJ1bnRpbWVCaW4sCiAgICBhZ2VuY0hvbWU6IHZhbHVlcy5hZ2VuY0hvbWUsCiAgICAuLi4odmFsdWVzLm5vZGVMaWJyYXJ5UGF0aCA9PT0gdW5kZWZpbmVkCiAgICAgID8ge30KICAgICAgOiB7IG5vZGVMaWJyYXJ5UGF0aDogdmFsdWVzLm5vZGVMaWJyYXJ5UGF0aCB9KSwKICB9OwogIHJldHVybiBCdWZmZXIuZnJvbShKU09OLnN0cmluZ2lmeShtZXRhZGF0YSksICJ1dGY4IikudG9TdHJpbmcoImJhc2U2NHVybCIpOwp9CgpmdW5jdGlvbiByZW5kZXJMZWdhY3lPb21Qb3NpeFdyYXBwZXIoeyBub2RlQmluLCBydW50aW1lQmluLCBhZ2VuY0hvbWUgfSkgewogIHJldHVybiBbCiAgICAiIyEvYmluL3NoIiwKICAgIGAjICR7UE9TSVhfV1JBUFBFUl9TSUdOQVRVUkV9IOKAlCByZXdyaXR0ZW4gb24gZXZlcnkgaW5zdGFsbC91cGdyYWRlLmAsCiAgICBgZXhwb3J0IEFHRU5DX0hPTUU9Ilwke0FHRU5DX0hPTUU6LSR7YWdlbmNIb21lfX0iYCwKICAgICIjIE9PTSBzZWxmLWRpYWdub3NpczogaGF2ZSBWOCB3cml0ZSBhIGhlYXAgc25hcHNob3QgZnJvbSBpbnNpZGUgdGhlIEdDIHdoZW4iLAogICAgIiMgdGhlIGhlYXAgbmVhcnMgaXRzIGxpbWl0IChyZWxpYWJsZSBldmVuIGluIHRoZSBlbmQtc3RhZ2UgR0Mgc3RhbGwgd2hlcmUgSlMiLAogICAgIiMgdGltZXJzIHN0YXJ2ZSksIGludG8gJEFHRU5DX0hPTUUvb29tLXNuYXBzaG90cy4gVGhlIHJ1bnRpbWUgcHJ1bmVzIG9sZCIsCiAgICAiIyBjYXB0dXJlcyBhbmQgcG9pbnRzIGF0IGZyZXNoIG9uZXMgb24gdGhlIG5leHQgc3RhcnR1cC4gVXNlci1wcm92aWRlZCIsCiAgICAiIyBOT0RFX09QVElPTlMgd2luOiBvdXJzIGFyZSBwcmVwZW5kZWQsIGFuZCB3ZSBza2lwIGVudGlyZWx5IHdoZW4gdGhlIHVzZXIiLAogICAgIiMgYWxyZWFkeSB0dW5lcyBoZWFwIHNuYXBzaG90cy4iLAogICAgJ2Nhc2UgIiAke05PREVfT1BUSU9OUzotfSAiIGluJywKICAgICIgICpoZWFwc25hcHNob3QtbmVhci1oZWFwLWxpbWl0KikgOiA7OyIsCiAgICAiICAqKSIsCiAgICAnICAgIG1rZGlyIC1wICIke0FHRU5DX0hPTUV9L29vbS1zbmFwc2hvdHMiIDI+L2Rldi9udWxsIHx8IDonLAogICAgJyAgICBOT0RFX09QVElPTlM9Ii0taGVhcHNuYXBzaG90LW5lYXItaGVhcC1saW1pdD0xIC0tZGlhZ25vc3RpYy1kaXI9JHtBR0VOQ19IT01FfS9vb20tc25hcHNob3RzICR7Tk9ERV9PUFRJT05TOi19IicsCiAgICAiICAgIGV4cG9ydCBOT0RFX09QVElPTlMiLAogICAgIiAgICA7OyIsCiAgICAiZXNhYyIsCiAgICBgZXhlYyAiJHtub2RlQmlufSIgIiR7cnVudGltZUJpbn0iICIkQCJgLAogICAgIiIsCiAgXS5qb2luKCJcbiIpOwp9CgpleHBvcnQgZnVuY3Rpb24gcmVuZGVyR2VuZXJhdGVkV3JhcHBlckNvbnRlbnQoewogIGtpbmQsCiAgbm9kZUJpbiwKICBydW50aW1lQmluLAogIGFnZW5jSG9tZSwKICBub2RlTGlicmFyeVBhdGgsCn0pIHsKICBpZiAoa2luZCAhPT0gInBvc2l4IiAmJiBraW5kICE9PSAiY21kIikgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcihgdW5zdXBwb3J0ZWQgd3JhcHBlciBraW5kOiAke1N0cmluZyhraW5kKX1gKTsKICB9CiAgY29uc3QgdmFsdWVzID0geyBub2RlQmluLCBydW50aW1lQmluLCBhZ2VuY0hvbWUsIG5vZGVMaWJyYXJ5UGF0aCB9OwogIHZhbGlkYXRlVmFsdWVzKGtpbmQsIHZhbHVlcyk7CiAgY29uc3QgbWV0YWRhdGEgPSBtZXRhZGF0YUZvcih2YWx1ZXMpOwogIGlmIChraW5kID09PSAiY21kIikgewogICAgY29uc3QgYmF0Y2ggPSAodmFsdWUpID0+IHZhbHVlLnJlcGxhY2VBbGwoIiUiLCAiJSUiKTsKICAgIGNvbnN0IG5vZGVEaXIgPSB3aW4zMi5kaXJuYW1lKG5vZGVCaW4pOwogICAgcmV0dXJuIFsKICAgICAgIkBlY2hvIG9mZiIsCiAgICAgICJzZXRsb2NhbCBEaXNhYmxlRGVsYXllZEV4cGFuc2lvbiIsCiAgICAgIGByZW0gJHtDTURfV1JBUFBFUl9TSUdOQVRVUkV9IC0gcmV3cml0dGVuIG9uIGV2ZXJ5IGluc3RhbGwvdXBncmFkZS5gLAogICAgICBgcmVtICR7V1JBUFBFUl9NRVRBREFUQV9QUkVGSVh9ICR7bWV0YWRhdGF9YCwKICAgICAgYGlmIG5vdCBkZWZpbmVkIEFHRU5DX0hPTUUgc2V0ICJBR0VOQ19IT01FPSR7YmF0Y2goYWdlbmNIb21lKX0iYCwKICAgICAgYHNldCAiUEFUSD0ke2JhdGNoKG5vZGVEaXIpfTslUEFUSCUiYCwKICAgICAgYCIke2JhdGNoKG5vZGVCaW4pfSIgIiR7YmF0Y2gocnVudGltZUJpbil9IiAlKmAsCiAgICAgICIiLAogICAgXS5qb2luKCJcclxuIik7CiAgfQogIGNvbnN0IHF1b3RlID0gKHZhbHVlKSA9PiBgJyR7dmFsdWUucmVwbGFjZUFsbCgiJyIsIGAnIiciJ2ApfSdgOwogIGNvbnN0IG5vZGVEaXIgPSBwb3NpeC5kaXJuYW1lKG5vZGVCaW4pOwogIGNvbnN0IGV4ZWNQcmVmaXggPSBub2RlTGlicmFyeVBhdGggPT09IHVuZGVmaW5lZAogICAgPyAiZXhlYyAiCiAgICA6IGBMRF9MSUJSQVJZX1BBVEg9JHtxdW90ZShub2RlTGlicmFyeVBhdGgpfSBleGVjIGA7CiAgcmV0dXJuIFsKICAgICIjIS9iaW4vc2giLAogICAgYCMgJHtQT1NJWF9XUkFQUEVSX1NJR05BVFVSRX0g4oCUIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsL3VwZ3JhZGUuYCwKICAgIGAjICR7V1JBUFBFUl9NRVRBREFUQV9QUkVGSVh9ICR7bWV0YWRhdGF9YCwKICAgICdpZiBbIC16ICIke0FHRU5DX0hPTUU6LX0iIF07IHRoZW4nLAogICAgYCAgZXhwb3J0IEFHRU5DX0hPTUU9JHtxdW90ZShhZ2VuY0hvbWUpfWAsCiAgICAiZmkiLAogICAgJ2lmIFsgLW4gIiR7UEFUSDotfSIgXTsgdGhlbicsCiAgICBgICBleHBvcnQgUEFUSD0ke3F1b3RlKG5vZGVEaXIpfToiJFBBVEgiYCwKICAgICJlbHNlIiwKICAgIGAgIGV4cG9ydCBQQVRIPSR7cXVvdGUobm9kZURpcil9YCwKICAgICJmaSIsCiAgICAiIyBDYXB0dXJlIG9uZSBWOCBuZWFyLWhlYXAtbGltaXQgc25hcHNob3QgdW5sZXNzIHRoZSBvcGVyYXRvciBhbHJlYWR5IGNvbmZpZ3VyZWQgaXQuIiwKICAgICdjYXNlICIgJHtOT0RFX09QVElPTlM6LX0gIiBpbicsCiAgICAiICAqaGVhcHNuYXBzaG90LW5lYXItaGVhcC1saW1pdCopIiwKICAgIGAgICAgJHtleGVjUHJlZml4fSR7cXVvdGUobm9kZUJpbil9ICR7cXVvdGUocnVudGltZUJpbil9ICIkQCJgLAogICAgIiAgICA7OyIsCiAgICAiICAqKSIsCiAgICAnICAgIG1rZGlyIC1wICIke0FHRU5DX0hPTUV9L29vbS1zbmFwc2hvdHMiIDI+L2Rldi9udWxsIHx8IDonLAogICAgYCAgICAke2V4ZWNQcmVmaXh9JHtxdW90ZShub2RlQmluKX0gLS1oZWFwc25hcHNob3QtbmVhci1oZWFwLWxpbWl0PTEgYCArCiAgICAgICctLWRpYWdub3N0aWMtZGlyPSIke0FHRU5DX0hPTUV9L29vbS1zbmFwc2hvdHMiICcgKwogICAgICBgJHtxdW90ZShydW50aW1lQmluKX0gIiRAImAsCiAgICAiICAgIDs7IiwKICAgICJlc2FjIiwKICAgICIiLAogIF0uam9pbigiXG4iKTsKfQoKLy8gUmVsZWFzZXMgMC42LjIgdGhyb3VnaCAwLjEwLjAgZW1pdHRlZCB0aGlzIGltbXV0YWJsZSBtZXRhZGF0YS12MSBzaGFwZQovLyBiZWZvcmUgc3RhbmRhbG9uZSBpbnN0YWxscyBjYXJyaWVkIGEgcHJpdmF0ZSBOb2RlIHJ1bnRpbWUuIEtlZXAgdGhlIHJlbmRlcmVyCi8vIHByaXZhdGU6IGl0IGV4aXN0cyBvbmx5IHNvIG93bmVyc2hpcCBjYW4gYmUgcHJvdmVuIGJ5IGV4YWN0IGZ1bGwtZmlsZQovLyByZWNvbnN0cnVjdGlvbiwgbmV2ZXIgYnkgdHJ1c3RpbmcgdGhlIGhpc3RvcmljYWwgbWFya2VyIG9yIG1ldGFkYXRhIGFsb25lLgpmdW5jdGlvbiByZW5kZXJQcmVQcml2YXRlTm9kZVdyYXBwZXJDb250ZW50KHsKICBraW5kLAogIG5vZGVCaW4sCiAgcnVudGltZUJpbiwKICBhZ2VuY0hvbWUsCn0pIHsKICBpZiAoa2luZCAhPT0gInBvc2l4IiAmJiBraW5kICE9PSAiY21kIikgewogICAgdGhyb3cgbmV3IFR5cGVFcnJvcihgdW5zdXBwb3J0ZWQgd3JhcHBlciBraW5kOiAke1N0cmluZyhraW5kKX1gKTsKICB9CiAgY29uc3QgdmFsdWVzID0geyBub2RlQmluLCBydW50aW1lQmluLCBhZ2VuY0hvbWUgfTsKICB2YWxpZGF0ZVZhbHVlcyhraW5kLCB2YWx1ZXMpOwogIGNvbnN0IG1ldGFkYXRhID0gQnVmZmVyLmZyb20oSlNPTi5zdHJpbmdpZnkoewogICAgbm9kZUJpbiwKICAgIHJ1bnRpbWVCaW4sCiAgICBhZ2VuY0hvbWUsCiAgfSksICJ1dGY4IikudG9TdHJpbmcoImJhc2U2NHVybCIpOwogIGlmIChraW5kID09PSAiY21kIikgewogICAgY29uc3QgYmF0Y2ggPSAodmFsdWUpID0+IHZhbHVlLnJlcGxhY2VBbGwoIiUiLCAiJSUiKTsKICAgIHJldHVybiBbCiAgICAgICJAZWNobyBvZmYiLAogICAgICAic2V0bG9jYWwgRGlzYWJsZURlbGF5ZWRFeHBhbnNpb24iLAogICAgICBgcmVtICR7Q01EX1dSQVBQRVJfU0lHTkFUVVJFfSAtIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsL3VwZ3JhZGUuYCwKICAgICAgYHJlbSAke1dSQVBQRVJfTUVUQURBVEFfUFJFRklYfSAke21ldGFkYXRhfWAsCiAgICAgIGBpZiBub3QgZGVmaW5lZCBBR0VOQ19IT01FIHNldCAiQUdFTkNfSE9NRT0ke2JhdGNoKGFnZW5jSG9tZSl9ImAsCiAgICAgIGAiJHtiYXRjaChub2RlQmluKX0iICIke2JhdGNoKHJ1bnRpbWVCaW4pfSIgJSpgLAogICAgICAiIiwKICAgIF0uam9pbigiXHJcbiIpOwogIH0KICBjb25zdCBxdW90ZSA9ICh2YWx1ZSkgPT4gYCcke3ZhbHVlLnJlcGxhY2VBbGwoIiciLCBgJyInIidgKX0nYDsKICByZXR1cm4gWwogICAgIiMhL2Jpbi9zaCIsCiAgICBgIyAke1BPU0lYX1dSQVBQRVJfU0lHTkFUVVJFfSDigJQgcmV3cml0dGVuIG9uIGV2ZXJ5IGluc3RhbGwvdXBncmFkZS5gLAogICAgYCMgJHtXUkFQUEVSX01FVEFEQVRBX1BSRUZJWH0gJHttZXRhZGF0YX1gLAogICAgJ2lmIFsgLXogIiR7QUdFTkNfSE9NRTotfSIgXTsgdGhlbicsCiAgICBgICBleHBvcnQgQUdFTkNfSE9NRT0ke3F1b3RlKGFnZW5jSG9tZSl9YCwKICAgICJmaSIsCiAgICAiIyBDYXB0dXJlIG9uZSBWOCBuZWFyLWhlYXAtbGltaXQgc25hcHNob3QgdW5sZXNzIHRoZSBvcGVyYXRvciBhbHJlYWR5IGNvbmZpZ3VyZWQgaXQuIiwKICAgICdjYXNlICIgJHtOT0RFX09QVElPTlM6LX0gIiBpbicsCiAgICAiICAqaGVhcHNuYXBzaG90LW5lYXItaGVhcC1saW1pdCopIiwKICAgIGAgICAgZXhlYyAke3F1b3RlKG5vZGVCaW4pfSAke3F1b3RlKHJ1bnRpbWVCaW4pfSAiJEAiYCwKICAgICIgICAgOzsiLAogICAgIiAgKikiLAogICAgJyAgICBta2RpciAtcCAiJHtBR0VOQ19IT01FfS9vb20tc25hcHNob3RzIiAyPi9kZXYvbnVsbCB8fCA6JywKICAgIGAgICAgZXhlYyAke3F1b3RlKG5vZGVCaW4pfSAtLWhlYXBzbmFwc2hvdC1uZWFyLWhlYXAtbGltaXQ9MSBgICsKICAgICAgJy0tZGlhZ25vc3RpYy1kaXI9IiR7QUdFTkNfSE9NRX0vb29tLXNuYXBzaG90cyIgJyArCiAgICAgIGAke3F1b3RlKHJ1bnRpbWVCaW4pfSAiJEAiYCwKICAgICIgICAgOzsiLAogICAgImVzYWMiLAogICAgIiIsCiAgXS5qb2luKCJcbiIpOwp9CgpmdW5jdGlvbiBkZWNvZGVDYW5vbmljYWxNZXRhZGF0YShlbmNvZGVkKSB7CiAgdHJ5IHsKICAgIGNvbnN0IGJ5dGVzID0gQnVmZmVyLmZyb20oZW5jb2RlZCwgImJhc2U2NHVybCIpOwogICAgaWYgKGJ5dGVzLnRvU3RyaW5nKCJiYXNlNjR1cmwiKSAhPT0gZW5jb2RlZCkgcmV0dXJuIHVuZGVmaW5lZDsKICAgIGNvbnN0IGRlY29kZWQgPSBuZXcgVGV4dERlY29kZXIoInV0Zi04IiwgeyBmYXRhbDogdHJ1ZSB9KS5kZWNvZGUoYnl0ZXMpOwogICAgY29uc3QgdmFsdWUgPSBKU09OLnBhcnNlKGRlY29kZWQpOwogICAgaWYgKHZhbHVlID09PSBudWxsIHx8IHR5cGVvZiB2YWx1ZSAhPT0gIm9iamVjdCIgfHwgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiB1bmRlZmluZWQ7CiAgICBjb25zdCBrZXlzID0gT2JqZWN0LmtleXModmFsdWUpOwogICAgY29uc3QgZXhwZWN0ZWRLZXlzID0gdmFsdWUubm9kZUxpYnJhcnlQYXRoID09PSB1bmRlZmluZWQKICAgICAgPyBbIm5vZGVCaW4iLCAicnVudGltZUJpbiIsICJhZ2VuY0hvbWUiXQogICAgICA6IFsibm9kZUJpbiIsICJydW50aW1lQmluIiwgImFnZW5jSG9tZSIsICJub2RlTGlicmFyeVBhdGgiXTsKICAgIGlmICgKICAgICAga2V5cy5sZW5ndGggIT09IGV4cGVjdGVkS2V5cy5sZW5ndGggfHwKICAgICAgIWV4cGVjdGVkS2V5cy5ldmVyeSgoa2V5LCBpbmRleCkgPT4ga2V5c1tpbmRleF0gPT09IGtleSkgfHwKICAgICAgdHlwZW9mIHZhbHVlLm5vZGVCaW4gIT09ICJzdHJpbmciIHx8CiAgICAgIHR5cGVvZiB2YWx1ZS5ydW50aW1lQmluICE9PSAic3RyaW5nIiB8fAogICAgICB0eXBlb2YgdmFsdWUuYWdlbmNIb21lICE9PSAic3RyaW5nIiB8fAogICAgICAodmFsdWUubm9kZUxpYnJhcnlQYXRoICE9PSB1bmRlZmluZWQgJiYgdHlwZW9mIHZhbHVlLm5vZGVMaWJyYXJ5UGF0aCAhPT0gInN0cmluZyIpCiAgICApIHJldHVybiB1bmRlZmluZWQ7CiAgICByZXR1cm4gewogICAgICBub2RlQmluOiB2YWx1ZS5ub2RlQmluLAogICAgICBydW50aW1lQmluOiB2YWx1ZS5ydW50aW1lQmluLAogICAgICBhZ2VuY0hvbWU6IHZhbHVlLmFnZW5jSG9tZSwKICAgICAgLi4uKHZhbHVlLm5vZGVMaWJyYXJ5UGF0aCA9PT0gdW5kZWZpbmVkCiAgICAgICAgPyB7fQogICAgICAgIDogeyBub2RlTGlicmFyeVBhdGg6IHZhbHVlLm5vZGVMaWJyYXJ5UGF0aCB9KSwKICAgIH07CiAgfSBjYXRjaCB7CiAgICByZXR1cm4gdW5kZWZpbmVkOwogIH0KfQoKZnVuY3Rpb24gcGFyc2VNb2Rlcm4ocGF0aCwgY29udGVudCkgewogIGNvbnN0IG1hcmtlciA9IGNvbnRlbnQubWF0Y2goCiAgICAvXigjfHJlbSkgQWdlbkMgd3JhcHBlciBtZXRhZGF0YSB2MTogKFtBLVphLXowLTlfLV0rKVxyPyQvbXUsCiAgKTsKICBpZiAobWFya2VyID09PSBudWxsKSByZXR1cm4gdW5kZWZpbmVkOwogIGNvbnN0IGtpbmQgPSBtYXJrZXJbMV0gPT09ICJyZW0iID8gImNtZCIgOiAicG9zaXgiOwogIGNvbnN0IHZhbHVlcyA9IGRlY29kZUNhbm9uaWNhbE1ldGFkYXRhKG1hcmtlclsyXSk7CiAgaWYgKHZhbHVlcyA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkOwogIHRyeSB7CiAgICBjb25zdCB3cmFwcGVyID0geyBraW5kLCBwYXRoLCAuLi52YWx1ZXMgfTsKICAgIGlmIChyZW5kZXJHZW5lcmF0ZWRXcmFwcGVyQ29udGVudCh3cmFwcGVyKSA9PT0gY29udGVudCkgcmV0dXJuIHdyYXBwZXI7CiAgICBpZiAoCiAgICAgIHZhbHVlcy5ub2RlTGlicmFyeVBhdGggPT09IHVuZGVmaW5lZCAmJgogICAgICByZW5kZXJQcmVQcml2YXRlTm9kZVdyYXBwZXJDb250ZW50KHdyYXBwZXIpID09PSBjb250ZW50CiAgICApIHJldHVybiB3cmFwcGVyOwogICAgcmV0dXJuIHVuZGVmaW5lZDsKICB9IGNhdGNoIHsKICAgIHJldHVybiB1bmRlZmluZWQ7CiAgfQp9CgpmdW5jdGlvbiBwYXJzZUxlZ2FjeShwYXRoLCBjb250ZW50KSB7CiAgY29uc3QgcG9zaXggPSBjb250ZW50Lm1hdGNoKAogICAgL14jIVwvYmluXC9zaFxuIyBHZW5lcmF0ZWQgYnkgQWdlbkMgaW5zdGFsbFwuc2gg4oCUIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsXC91cGdyYWRlXC5cbmV4cG9ydCBBR0VOQ19IT01FPSJcJFx7QUdFTkNfSE9NRTotKFtefSJcbl0rKVx9IlxuZXhlYyAiKFteIlxuXSspIiAiKFteIlxuXSspIiAiXCRAIlxuJC91LAogICk7CiAgaWYgKHBvc2l4ICE9PSBudWxsKSB7CiAgICBjb25zdCB2YWx1ZXMgPSB7IGFnZW5jSG9tZTogcG9zaXhbMV0sIG5vZGVCaW46IHBvc2l4WzJdLCBydW50aW1lQmluOiBwb3NpeFszXSB9OwogICAgdHJ5IHsKICAgICAgdmFsaWRhdGVWYWx1ZXMoInBvc2l4IiwgdmFsdWVzKTsKICAgICAgcmV0dXJuIHsga2luZDogInBvc2l4IiwgcGF0aCwgLi4udmFsdWVzIH07CiAgICB9IGNhdGNoIHsKICAgICAgcmV0dXJuIHVuZGVmaW5lZDsKICAgIH0KICB9CiAgLy8gMC42LjIgZGV2ZWxvcG1lbnQgbWFpbiBicmllZmx5IGVtaXR0ZWQgdGhpcyBleGFjdCBmdWxsLWZpbGUgd3JhcHBlciBiZWZvcmUKICAvLyBhY3RpdmF0aW9uIG93bmVyc2hpcCBiZWNhbWUgY2Fub25pY2FsLiBBY2NlcHRpbmcgb25seSBhIGJ5dGUtZm9yLWJ5dGUKICAvLyByZWNvbnN0cnVjdGlvbiBwcmVzZXJ2ZXMgdXBncmFkZXMgZnJvbSB0aGF0IHN1cmZhY2Ugd2l0aG91dCB0dXJuaW5nIHRoZQogIC8vIGhpc3RvcmljYWwgbWFya2VyIGludG8gYSBnZW5lcmFsIG93bmVyc2hpcCBvcmFjbGUuCiAgY29uc3Qgb29tUG9zaXggPSBjb250ZW50Lm1hdGNoKAogICAgL14jIVwvYmluXC9zaFxuIyBHZW5lcmF0ZWQgYnkgQWdlbkMgaW5zdGFsbFwuc2gg4oCUIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsXC91cGdyYWRlXC5cbmV4cG9ydCBBR0VOQ19IT01FPSJcJFx7QUdFTkNfSE9NRTotKFtefSJcbl0rKVx9IlxuW1xzXFNdKlxuZXhlYyAiKFteIlxuXSspIiAiKFteIlxuXSspIiAiXCRAIlxuJC91LAogICk7CiAgaWYgKG9vbVBvc2l4ICE9PSBudWxsKSB7CiAgICBjb25zdCB2YWx1ZXMgPSB7CiAgICAgIGFnZW5jSG9tZTogb29tUG9zaXhbMV0sCiAgICAgIG5vZGVCaW46IG9vbVBvc2l4WzJdLAogICAgICBydW50aW1lQmluOiBvb21Qb3NpeFszXSwKICAgIH07CiAgICB0cnkgewogICAgICB2YWxpZGF0ZVZhbHVlcygicG9zaXgiLCB2YWx1ZXMpOwogICAgICBpZiAocmVuZGVyTGVnYWN5T29tUG9zaXhXcmFwcGVyKHZhbHVlcykgPT09IGNvbnRlbnQpIHsKICAgICAgICByZXR1cm4geyBraW5kOiAicG9zaXgiLCBwYXRoLCAuLi52YWx1ZXMgfTsKICAgICAgfQogICAgfSBjYXRjaCB7CiAgICAgIHJldHVybiB1bmRlZmluZWQ7CiAgICB9CiAgfQogIGNvbnN0IGNtZCA9IGNvbnRlbnQubWF0Y2goCiAgICAvXkBlY2hvIG9mZihccj9cbilyZW0gR2VuZXJhdGVkIGJ5IEFnZW5DIGluc3RhbGxcLnBzMSAtIHJld3JpdHRlbiBvbiBldmVyeSBpbnN0YWxsXC91cGdyYWRlXC5cMWlmIG5vdCBkZWZpbmVkIEFHRU5DX0hPTUUgc2V0ICJBR0VOQ19IT01FPShbXiJcclxuXSspIlwxIihbXiJcclxuXSspIiAiKFteIlxyXG5dKykiICVcKlwxJC91LAogICk7CiAgaWYgKGNtZCA9PT0gbnVsbCkgcmV0dXJuIHVuZGVmaW5lZDsKICBjb25zdCB2YWx1ZXMgPSB7IGFnZW5jSG9tZTogY21kWzJdLCBub2RlQmluOiBjbWRbM10sIHJ1bnRpbWVCaW46IGNtZFs0XSB9OwogIHRyeSB7CiAgICB2YWxpZGF0ZVZhbHVlcygiY21kIiwgdmFsdWVzKTsKICAgIHJldHVybiB7IGtpbmQ6ICJjbWQiLCBwYXRoLCAuLi52YWx1ZXMgfTsKICB9IGNhdGNoIHsKICAgIHJldHVybiB1bmRlZmluZWQ7CiAgfQp9CgpleHBvcnQgZnVuY3Rpb24gcGFyc2VHZW5lcmF0ZWRXcmFwcGVyQ29udGVudChwYXRoLCBjb250ZW50KSB7CiAgaWYgKAogICAgdHlwZW9mIHBhdGggIT09ICJzdHJpbmciIHx8ICFpc0Fic29sdXRlKHBhdGgpIHx8CiAgICB0eXBlb2YgY29udGVudCAhPT0gInN0cmluZyIgfHwgQnVmZmVyLmJ5dGVMZW5ndGgoY29udGVudCwgInV0ZjgiKSA+IEdFTkVSQVRFRF9XUkFQUEVSX01BWF9CWVRFUwogICkgcmV0dXJuIG51bGw7CiAgcmV0dXJuIHBhcnNlTW9kZXJuKHBhdGgsIGNvbnRlbnQpID8/IHBhcnNlTGVnYWN5KHBhdGgsIGNvbnRlbnQpID8/IG51bGw7Cn0K";
let generatedWrapperModulePromise;
function loadGeneratedWrapperModule() {
  generatedWrapperModulePromise ??= import(
    `data:text/javascript;base64,${AGENC_GENERATED_WRAPPER_SOURCE_BASE64}`,
  );
  return generatedWrapperModulePromise;
}
// END GENERATED AGENC WRAPPER CONTRACT MODULE

function validateActivationTransaction(raw, parseGeneratedWrapperContent) {
  if (raw.length > 4 * 1024 * 1024) throw new Error("wrapper activation journal is too large");
  const transaction = JSON.parse(raw);
  if (transaction?.version !== 1 ||
      typeof transaction.targetVersion !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(transaction.targetVersion) ||
      !Array.isArray(transaction.entries) ||
      transaction.entries.length === 0 || transaction.entries.length > 64) {
    throw new Error("wrapper activation journal is invalid");
  }
  const seen = new Set();
  for (const entry of transaction.entries) {
    if (typeof entry?.path !== "string" || !isAbsolute(entry.path) || seen.has(entry.path) ||
        (entry.original !== null && typeof entry.original !== "string") ||
        typeof entry.desired !== "string" ||
        !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
      throw new Error("wrapper activation journal entry is invalid");
    }
    const originalWrapper = entry.original === null
      ? null
      : parseGeneratedWrapperContent(entry.path, entry.original);
    const desiredWrapper = parseGeneratedWrapperContent(entry.path, entry.desired);
    if ((entry.original !== null && originalWrapper === null) || desiredWrapper === null ||
        (originalWrapper !== null && originalWrapper.kind !== desiredWrapper.kind) ||
        entry.mode !== (desiredWrapper.kind === "cmd" ? 0o644 : 0o755)) {
      throw new Error("wrapper activation journal entry is invalid");
    }
    seen.add(entry.path);
  }
  return transaction;
}
function completeActivationTransaction(journalPath, parseGeneratedWrapperContent) {
  const raw = readOptionalFile(journalPath);
  if (raw === null) return;
  const transaction = validateActivationTransaction(raw, parseGeneratedWrapperContent);
  for (const entry of transaction.entries) {
    const current = readOptionalFile(entry.path);
    if (current !== entry.original && current !== entry.desired) {
      throw new Error(`wrapper changed outside interrupted activation: ${entry.path}`);
    }
  }
  for (const entry of transaction.entries) {
    if (readOptionalFile(entry.path) !== entry.desired) {
      replaceFileAtomically(entry.path, entry.desired, entry.mode);
    }
  }
  removeDurably(journalPath, { force: true });
}
function compareSemver(left, right) {
  const parse = (value) => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match) throw new Error(`invalid semantic version: ${value}`);
    return { core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") };
  };
  const a = parse(left), b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return Math.sign(a.core[index] - b.core[index]);
  }
  if (a.pre === undefined || b.pre === undefined) return a.pre === b.pre ? 0 : a.pre === undefined ? 1 : -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const ai = a.pre[index], bi = b.pre[index];
    if (ai === undefined || bi === undefined) return ai === bi ? 0 : ai === undefined ? -1 : 1;
    if (ai === bi) continue;
    const an = /^\d+$/.test(ai), bn = /^\d+$/.test(bi);
    if (an && bn) return Math.sign(Number(ai) - Number(bi));
    if (an !== bn) return an ? -1 : 1;
    return ai < bi ? -1 : 1;
  }
  return 0;
}
function activeRuntimeVersion(wrapper, agencHome) {
  if (wrapper === null) return undefined;
  const runtimeBin = wrapper.runtimeBin;
  const root = resolve(agencHome, "runtime");
  const within = relative(root, resolve(runtimeBin));
  if (within === "" || within === ".." || within.startsWith(`..${require("node:path").sep}`) || isAbsolute(within)) {
    return undefined;
  }
  const version = within.split(/[\\/]/)[0];
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : undefined;
}
// BEGIN GENERATED AGENC ACTIVATION LOCK IDENTITY MODULE
// Generated by scripts/sync-installer-sqlite-lock.mjs from the canonical
// launcher module. Do not edit this embedded payload by hand.
const AGENC_ACTIVATION_LOCK_IDENTITY_SOURCE_BASE64 = "Ly8gU3RhYmxlIGFjY291bnQgYW5kIHdyYXBwZXIgaWRlbnRpdGllcyBzaGFyZWQgYnkgdGhlIGxhdW5jaGVyLCBydW50aW1lCi8vIHVwZGF0ZXIsIGFuZCBzdGFuZGFsb25lIGluc3RhbGxlcnMuIFdyYXBwZXIgZmlsZXMgYXJlIGF0b21pY2FsbHkgcmVwbGFjZWQsCi8vIHNvIHRoZWlyIG93biBpbm9kZSBpcyBpbnRlbnRpb25hbGx5IG5vdCBwYXJ0IG9mIHRoZSBwZXJzaXN0ZW50IGxvY2sga2V5LgoKaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gIm5vZGU6Y3J5cHRvIjsKaW1wb3J0IHsKICBjaG1vZFN5bmMsCiAgZXhpc3RzU3luYywKICBsc3RhdFN5bmMsCiAgbWtkaXJTeW5jLAogIHJlYWxwYXRoU3luYywKfSBmcm9tICJub2RlOmZzIjsKaW1wb3J0IHsgdXNlckluZm8gfSBmcm9tICJub2RlOm9zIjsKaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGlzQWJzb2x1dGUsIGpvaW4sIHJlc29sdmUgfSBmcm9tICJub2RlOnBhdGgiOwoKbGV0IGNhY2hlZEFjdGl2YXRpb25Mb2NrUmVnaXN0cnk7CmNvbnN0IFVOU1VQUE9SVEVEX0ZJTEVfSURfNjQgPSAweGZmZmZfZmZmZl9mZmZmX2ZmZmZuOwoKZnVuY3Rpb24gaGFzVXNhYmxlRmlsZUlkZW50aXR5KHN0YXQpIHsKICByZXR1cm4gc3RhdC5kZXYgIT09IDBuICYmCiAgICBzdGF0LmlubyAhPT0gMG4gJiYKICAgIHN0YXQuaW5vICE9PSAtMW4gJiYKICAgIEJpZ0ludC5hc1VpbnROKDY0LCBzdGF0LmlubykgIT09IFVOU1VQUE9SVEVEX0ZJTEVfSURfNjQ7Cn0KCmV4cG9ydCBmdW5jdGlvbiBleGlzdGluZ0FnZW5DSG9tZUlkZW50aXR5KHJlcXVlc3RlZCkgewogIGlmICh0eXBlb2YgcmVxdWVzdGVkICE9PSAic3RyaW5nIiB8fCAhaXNBYnNvbHV0ZShyZXF1ZXN0ZWQpKSByZXR1cm4gdW5kZWZpbmVkOwogIHRyeSB7CiAgICBjb25zdCBjYW5vbmljYWwgPSByZWFscGF0aFN5bmMubmF0aXZlKHJlc29sdmUocmVxdWVzdGVkKSk7CiAgICBjb25zdCBzdGF0ID0gbHN0YXRTeW5jKGNhbm9uaWNhbCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgICBpZiAoIXN0YXQuaXNEaXJlY3RvcnkoKSB8fCBzdGF0LmlzU3ltYm9saWNMaW5rKCkpIHJldHVybiB1bmRlZmluZWQ7CiAgICBpZiAoCiAgICAgIHByb2Nlc3MucGxhdGZvcm0gIT09ICJ3aW4zMiIgJiYKICAgICAgdHlwZW9mIHByb2Nlc3MuZ2V0dWlkID09PSAiZnVuY3Rpb24iICYmCiAgICAgIHN0YXQudWlkICE9PSBCaWdJbnQocHJvY2Vzcy5nZXR1aWQoKSkKICAgICkgcmV0dXJuIHVuZGVmaW5lZDsKICAgIGlmICghaGFzVXNhYmxlRmlsZUlkZW50aXR5KHN0YXQpKSByZXR1cm4gdW5kZWZpbmVkOwogICAgcmV0dXJuIGAke3N0YXQuZGV2fToke3N0YXQuaW5vfWA7CiAgfSBjYXRjaCB7CiAgICByZXR1cm4gdW5kZWZpbmVkOwogIH0KfQoKZnVuY3Rpb24gZW5zdXJlQWNjb3VudFJlZ2lzdHJ5UGF0aChhY2NvdW50SG9tZSwgc2VnbWVudHMsIHVpZCkgewogIGNvbnN0IGNhbm9uaWNhbEhvbWUgPSByZWFscGF0aFN5bmMoYWNjb3VudEhvbWUpOwogIGNvbnN0IGhvbWVTdGF0ID0gbHN0YXRTeW5jKGNhbm9uaWNhbEhvbWUpOwogIGlmICghaG9tZVN0YXQuaXNEaXJlY3RvcnkoKSB8fCBob21lU3RhdC5pc1N5bWJvbGljTGluaygpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFjY291bnQgaG9tZSBpcyBub3QgYSByZWFsIGRpcmVjdG9yeTogJHtjYW5vbmljYWxIb21lfWApOwogIH0KICBpZiAodWlkICE9PSB1bmRlZmluZWQgJiYgaG9tZVN0YXQudWlkICE9PSB1aWQpIHsKICAgIHRocm93IG5ldyBFcnJvcihgYWNjb3VudCBob21lIGhhcyB0aGUgd3Jvbmcgb3duZXI6ICR7Y2Fub25pY2FsSG9tZX1gKTsKICB9CiAgaWYgKHVpZCAhPT0gdW5kZWZpbmVkICYmIChob21lU3RhdC5tb2RlICYgMG8wMjIpICE9PSAwKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYGFjY291bnQgaG9tZSBpcyBncm91cC93b3JsZCB3cml0YWJsZTogJHtjYW5vbmljYWxIb21lfWApOwogIH0KICBsZXQgY3VycmVudCA9IGNhbm9uaWNhbEhvbWU7CiAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IHNlZ21lbnRzLmxlbmd0aDsgaW5kZXggKz0gMSkgewogICAgY3VycmVudCA9IGpvaW4oY3VycmVudCwgc2VnbWVudHNbaW5kZXhdKTsKICAgIHRyeSB7CiAgICAgIG1rZGlyU3luYyhjdXJyZW50LCB7IG1vZGU6IDBvNzAwIH0pOwogICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgaWYgKGVycm9yPy5jb2RlICE9PSAiRUVYSVNUIikgdGhyb3cgZXJyb3I7CiAgICB9CiAgICBjb25zdCBzdGF0ID0gbHN0YXRTeW5jKGN1cnJlbnQpOwogICAgaWYgKCFzdGF0LmlzRGlyZWN0b3J5KCkgfHwgc3RhdC5pc1N5bWJvbGljTGluaygpKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcihgYWN0aXZhdGlvbiBsb2NrIHJlZ2lzdHJ5IHBhdGggaXMgbm90IGEgcmVhbCBkaXJlY3Rvcnk6ICR7Y3VycmVudH1gKTsKICAgIH0KICAgIGlmICh1aWQgIT09IHVuZGVmaW5lZCkgewogICAgICBpZiAoc3RhdC51aWQgIT09IHVpZCkgewogICAgICAgIHRocm93IG5ldyBFcnJvcihgYWN0aXZhdGlvbiBsb2NrIHJlZ2lzdHJ5IHBhdGggaGFzIHRoZSB3cm9uZyBvd25lcjogJHtjdXJyZW50fWApOwogICAgICB9CiAgICAgIGlmICgoc3RhdC5tb2RlICYgMG8wMjIpICE9PSAwKSB7CiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBhY3RpdmF0aW9uIGxvY2sgcmVnaXN0cnkgcGF0aCBpcyBncm91cC93b3JsZCB3cml0YWJsZTogJHtjdXJyZW50fWApOwogICAgICB9CiAgICAgIC8vIEFnZW5DLW93bmVkIGNvbXBvbmVudHMgYXJlIHByaXZhdGUuIERvIG5vdCByZXdyaXRlIGNvbnZlbnRpb25hbAogICAgICAvLyBhY2NvdW50IGRpcmVjdG9yaWVzIHN1Y2ggYXMgLmxvY2FsL3N0YXRlIG9yIExpYnJhcnkvQXBwbGljYXRpb24gU3VwcG9ydC4KICAgICAgaWYgKGluZGV4ID49IHNlZ21lbnRzLmxlbmd0aCAtIDIpIGNobW9kU3luYyhjdXJyZW50LCAwbzcwMCk7CiAgICB9CiAgfQogIHJldHVybiBjdXJyZW50Owp9CgpleHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUFjdGl2YXRpb25Mb2NrUmVnaXN0cnkoKSB7CiAgaWYgKGNhY2hlZEFjdGl2YXRpb25Mb2NrUmVnaXN0cnkgIT09IHVuZGVmaW5lZCkgcmV0dXJuIGNhY2hlZEFjdGl2YXRpb25Mb2NrUmVnaXN0cnk7CiAgaWYgKCFbImxpbnV4IiwgImRhcndpbiIsICJ3aW4zMiJdLmluY2x1ZGVzKHByb2Nlc3MucGxhdGZvcm0pKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYHVuc3VwcG9ydGVkIHBsYXRmb3JtIGZvciB3cmFwcGVyIGxvY2tpbmc6ICR7cHJvY2Vzcy5wbGF0Zm9ybX1gKTsKICB9CiAgY29uc3QgYWNjb3VudCA9IHVzZXJJbmZvKCk7CiAgaWYgKCFpc0Fic29sdXRlKGFjY291bnQuaG9tZWRpcikpIHsKICAgIHRocm93IG5ldyBFcnJvcigib3BlcmF0aW5nLXN5c3RlbSBhY2NvdW50IGhvbWUgaXMgdW5hdmFpbGFibGUiKTsKICB9CgogIGxldCBzZWdtZW50czsKICBsZXQgdWlkOwogIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAid2luMzIiKSB7CiAgICAvLyBvcy51c2VySW5mbygpLmhvbWVkaXIgaXMgc3VwcGxpZWQgYnkgdGhlIG9wZXJhdGluZyBzeXN0ZW0gcmF0aGVyIHRoYW4KICAgIC8vIFVTRVJQUk9GSUxFLiBLZWVwIHRoZSByZWdpc3RyeSB1bmRlciB0aGF0IHN0YWJsZSBwcm9maWxlIHJvb3QgYW5kIGxldAogICAgLy8gdGhlIFNRTGl0ZSBsb2NrIGxheWVyIGVuZm9yY2UgbG9jYWwtdm9sdW1lIGFuZCBBQ0wgcG9saWN5LgogICAgc2VnbWVudHMgPSBbIi5hZ2VuYy1zdGF0ZSIsICJhY3RpdmF0aW9uLWxvY2tzIl07CiAgfSBlbHNlIHsKICAgIGlmICh0eXBlb2YgcHJvY2Vzcy5nZXR1aWQgIT09ICJmdW5jdGlvbiIgfHwgYWNjb3VudC51aWQgIT09IHByb2Nlc3MuZ2V0dWlkKCkpIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJvcGVyYXRpbmctc3lzdGVtIGFjY291bnQgaWRlbnRpdHkgaXMgaW5jb25zaXN0ZW50Iik7CiAgICB9CiAgICB1aWQgPSBwcm9jZXNzLmdldHVpZCgpOwogICAgc2VnbWVudHMgPSBwcm9jZXNzLnBsYXRmb3JtID09PSAiZGFyd2luIgogICAgICA/IFsiTGlicmFyeSIsICJBcHBsaWNhdGlvbiBTdXBwb3J0IiwgIkFnZW5DIiwgImFjdGl2YXRpb24tbG9ja3MiXQogICAgICA6IFsiLmxvY2FsIiwgInN0YXRlIiwgIkFnZW5DIiwgImFjdGl2YXRpb24tbG9ja3MiXTsKICB9CiAgY2FjaGVkQWN0aXZhdGlvbkxvY2tSZWdpc3RyeSA9IHJlYWxwYXRoU3luYygKICAgIGVuc3VyZUFjY291bnRSZWdpc3RyeVBhdGgoYWNjb3VudC5ob21lZGlyLCBzZWdtZW50cywgdWlkKSwKICApOwogIHJldHVybiBjYWNoZWRBY3RpdmF0aW9uTG9ja1JlZ2lzdHJ5Owp9CgpleHBvcnQgZnVuY3Rpb24gd3JhcHBlckFjdGl2YXRpb25Mb2NrUGF0aCh3cmFwcGVyUGF0aCwgcmVnaXN0cnkpIHsKICBjb25zdCBhYnNvbHV0ZSA9IHJlc29sdmUod3JhcHBlclBhdGgpOwogIGNvbnN0IHBhcmVudCA9IHJlYWxwYXRoU3luYy5uYXRpdmUoZGlybmFtZShhYnNvbHV0ZSkpOwogIGNvbnN0IGNhbmRpZGF0ZSA9IGpvaW4ocGFyZW50LCBiYXNlbmFtZShhYnNvbHV0ZSkpOwogIGxldCBlbnRyeU5hbWUgPSBiYXNlbmFtZShhYnNvbHV0ZSk7CiAgaWYgKGV4aXN0c1N5bmMoY2FuZGlkYXRlKSkgewogICAgY29uc3Qgc3RhdCA9IGxzdGF0U3luYyhjYW5kaWRhdGUpOwogICAgaWYgKCFzdGF0LmlzRmlsZSgpIHx8IHN0YXQuaXNTeW1ib2xpY0xpbmsoKSkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoYHdyYXBwZXIgaXMgbm90IGEgcmVndWxhciBub24tc3ltbGluayBmaWxlOiAke2NhbmRpZGF0ZX1gKTsKICAgIH0KICAgIGlmIChzdGF0Lm5saW5rID4gMSkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoYHdyYXBwZXIgbXVzdCBub3QgaGF2ZSBoYXJkLWxpbmsgYWxpYXNlczogJHtjYW5kaWRhdGV9YCk7CiAgICB9CiAgICBlbnRyeU5hbWUgPSBiYXNlbmFtZShyZWFscGF0aFN5bmMubmF0aXZlKGNhbmRpZGF0ZSkpOwogIH0KICBjb25zdCBwYXJlbnRTdGF0ID0gbHN0YXRTeW5jKHBhcmVudCwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgaWYgKCFwYXJlbnRTdGF0LmlzRGlyZWN0b3J5KCkgfHwgcGFyZW50U3RhdC5pc1N5bWJvbGljTGluaygpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYHdyYXBwZXIgcGFyZW50IGlzIG5vdCBhIHJlYWwgZGlyZWN0b3J5OiAke3BhcmVudH1gKTsKICB9CiAgaWYgKAogICAgcHJvY2Vzcy5wbGF0Zm9ybSAhPT0gIndpbjMyIiAmJgogICAgdHlwZW9mIHByb2Nlc3MuZ2V0dWlkID09PSAiZnVuY3Rpb24iICYmCiAgICAocGFyZW50U3RhdC51aWQgIT09IEJpZ0ludChwcm9jZXNzLmdldHVpZCgpKSB8fCAocGFyZW50U3RhdC5tb2RlICYgMG8wMjJuKSAhPT0gMG4pCiAgKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYHdyYXBwZXIgcGFyZW50IGlzIG5vdCBwcml2YXRlbHkgb3duZWQgYnkgdGhlIGN1cnJlbnQgdXNlcjogJHtwYXJlbnR9YCk7CiAgfQogIGlmICghaGFzVXNhYmxlRmlsZUlkZW50aXR5KHBhcmVudFN0YXQpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYHdyYXBwZXIgcGFyZW50IGhhcyBubyBzdGFibGUgZmlsZXN5c3RlbSBpZGVudGl0eTogJHtwYXJlbnR9YCk7CiAgfQogIC8vIERvIG5vdCBjYXNlLWZvbGQgV2luZG93cyBwYXRocyBvciBlbnRyeSBuYW1lcy4gTlRGUyBzdXBwb3J0cyBwZXItZGlyZWN0b3J5CiAgLy8gY2FzZSBzZW5zaXRpdml0eSwgc28gdHdvIGRpZmZlcmVudGx5LWNhc2VkIG5hbWVzIGNhbiBiZSBkaWZmZXJlbnQgZmlsZXMuCiAgLy8gVGhlIHZhbGlkYXRlZCBkaXJlY3RvcnkgaWRlbnRpdHkgaXMgc3RhYmxlIGFjcm9zcyBhbGlhc2VzIGFuZCByZW5hbWVzOwogIC8vIHJlYWxwYXRoLWRlcml2ZWQgZW50cnkgY2FzaW5nIGRpc3Rpbmd1aXNoZXMgZXhpc3Rpbmcgd3JhcHBlciBlbnRyaWVzLgogIGNvbnN0IGlkZW50aXR5ID0gYHBhcmVudDoke3BhcmVudFN0YXQuZGV2fToke3BhcmVudFN0YXQuaW5vfTpuYW1lOiR7ZW50cnlOYW1lfWA7CiAgY29uc3QgZGlnZXN0ID0gY3JlYXRlSGFzaCgic2hhMjU2IikudXBkYXRlKGlkZW50aXR5KS5kaWdlc3QoImhleCIpOwogIHJldHVybiBqb2luKHJlZ2lzdHJ5LCBgJHtkaWdlc3R9LnNxbGl0ZWApOwp9Cg==";
let activationLockIdentityModulePromise;
function loadActivationLockIdentityModule() {
  activationLockIdentityModulePromise ??= import(
    `data:text/javascript;base64,${AGENC_ACTIVATION_LOCK_IDENTITY_SOURCE_BASE64}`,
  );
  return activationLockIdentityModulePromise;
}
// END GENERATED AGENC ACTIVATION LOCK IDENTITY MODULE

function activationTestDelay(name) {
  const raw = process.env[name];
  if (raw === undefined) return;
  if (!/^\d+$/.test(raw) || Number(raw) > 5_000) throw new Error(`invalid ${name}`);
  sleep(Number(raw));
}
function cleanupTestFailure(name, message) {
  const raw = process.env[name];
  if (raw === undefined) return;
  if (raw !== "1") throw new Error(`invalid ${name}`);
  throw new Error(message);
}
async function activationMain() {
  const desiredPath = archivePath;
  const wrapperPath = installDir;
  const [
    {
      acquireLocalSqliteLock,
      acquireLocalSqliteLocks,
      assertLocalPrivateDirectory,
      assertLocalPrivateFile,
    },
    {
      existingAgenCHomeIdentity,
      resolveActivationLockRegistry,
      wrapperActivationLockPath,
    },
    { parseGeneratedWrapperContent },
  ] = await Promise.all([
    loadSqliteLockModule(),
    loadActivationLockIdentityModule(),
    loadGeneratedWrapperModule(),
  ]);
  const agencHome = typeof binRel === "string" && isAbsolute(binRel)
    ? realpathSync(resolve(binRel))
    : undefined;
  const agencHomeIdentity = agencHome === undefined
    ? undefined
    : existingAgenCHomeIdentity(agencHome);
  const targetVersion = expectedSha;
  const allowDowngrade = artifactPlatform === "true";
  if (!isAbsolute(wrapperPath) || agencHomeIdentity === undefined ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(targetVersion)) {
    throw new Error("invalid wrapper activation arguments");
  }
  const desired = readFileSync(desiredPath, "utf8");
  const desiredWrapper = parseGeneratedWrapperContent(wrapperPath, desired);
  if (desiredWrapper === null) throw new Error("desired wrapper is not generated by AgenC");
  const runtimeRoot = join(agencHome, "runtime");
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  chmodLockSync(runtimeRoot, 0o700);
  const activationLock = join(runtimeRoot, ".activation-lock.sqlite");
  const journalPath = join(runtimeRoot, ".activation-transaction.json");
  const timeoutMs = 120_000;
  const deadline = performance.now() + timeoutMs;
  const releaseHomeLock = await acquireLocalSqliteLock(activationLock, {
    label: "wrapper activation", timeoutMs, deadline,
  });
  let releaseWrapperLocks;
  let result = "activated";
  let operationError;
  try {
    const wrapperLockRegistry = resolveActivationLockRegistry();
    const wrapperPaths = new Set([resolve(wrapperPath)]);
    const interrupted = readOptionalFile(journalPath);
    if (interrupted !== null) {
      for (const entry of validateActivationTransaction(
        interrupted,
        parseGeneratedWrapperContent,
      ).entries) {
        wrapperPaths.add(resolve(entry.path));
      }
    }
    const wrapperParents = new Set([...wrapperPaths].map((path) => dirname(path)));
    await Promise.all([...wrapperParents].map(async (path) => {
      const canonical = await assertLocalPrivateDirectory(path, {
        label: "wrapper activation", timeoutMs, deadline,
      });
      if (canonical !== resolve(path)) {
        throw new Error(`wrapper parent must use its canonical path: ${path}`);
      }
    }));
    releaseWrapperLocks = await acquireLocalSqliteLocks(
      [...wrapperPaths].map((path) => wrapperActivationLockPath(path, wrapperLockRegistry)),
      { label: "wrapper activation", timeoutMs, deadline },
    );
    activationTestDelay("AGENC_INSTALL_TEST_HOLD_ACTIVATION_LOCK_MS");
    for (const path of wrapperPaths) {
      if (!existsSync(path)) continue;
      const canonical = await assertLocalPrivateFile(path, {
        label: "wrapper activation", timeoutMs, deadline,
      });
      if (canonical !== resolve(path)) {
        throw new Error(`wrapper must use its canonical path: ${path}`);
      }
    }
    completeActivationTransaction(journalPath, parseGeneratedWrapperContent);
    const original = readOptionalFile(wrapperPath);
    const originalWrapper = original === null
      ? null
      : parseGeneratedWrapperContent(wrapperPath, original);
    if (original !== null && originalWrapper === null) {
      throw new Error(`refusing to replace a wrapper not generated by AgenC: ${wrapperPath}`);
    }
    if (originalWrapper !== null &&
        existingAgenCHomeIdentity(originalWrapper.agencHome) !== agencHomeIdentity) {
      throw new Error(`wrapper belongs to a different AGENC_HOME: ${wrapperPath}`);
    }
    const currentVersion = activeRuntimeVersion(originalWrapper, agencHome);
    if (original !== null && currentVersion === undefined) {
      throw new Error(`wrapper runtime target is outside its AGENC_HOME: ${wrapperPath}`);
    }
    if (existingAgenCHomeIdentity(desiredWrapper.agencHome) !== agencHomeIdentity ||
        activeRuntimeVersion(desiredWrapper, agencHome) !== targetVersion) {
      throw new Error("desired wrapper metadata does not match its AGENC_HOME/runtime version");
    }
    activationTestDelay("AGENC_INSTALL_TEST_AFTER_ACTIVATION_READ_MS");
    if (!allowDowngrade && currentVersion !== undefined && compareSemver(currentVersion, targetVersion) > 0) {
      result = `retained ${currentVersion}`;
      return;
    }
    const transaction = {
      version: 1,
      targetVersion,
      entries: [{ path: wrapperPath, original, desired, mode: desiredWrapper.kind === "cmd" ? 0o644 : 0o755 }],
    };
    const serializedTransaction = `${JSON.stringify(transaction)}\n`;
    validateActivationTransaction(serializedTransaction, parseGeneratedWrapperContent);
    replaceFileAtomically(journalPath, serializedTransaction, 0o600);
    completeActivationTransaction(journalPath, parseGeneratedWrapperContent);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const releaseErrors = [];
    try { releaseWrapperLocks?.(); } catch (error) { releaseErrors.push(error); }
    try { releaseHomeLock(); } catch (error) { releaseErrors.push(error); }
    process.stdout.write(`${result}\n`);
    if (releaseErrors.length > 0) {
      throw new AggregateError(
        operationError === undefined ? releaseErrors : [operationError, ...releaseErrors],
        "wrapper activation and lock release did not both complete",
      );
    }
  }
}

async function runtimeMain() {
  const versionDir = dirname(installDir);
  const base = basename(installDir);
  mkdirSync(versionDir, { recursive: true, mode: 0o700 });
  chmodLockSync(versionDir, 0o700);
  const { acquireLocalSqliteLock, assertLocalPrivateDirectory } =
    await loadSqliteLockModule();
  const canonicalVersionDir = await assertLocalPrivateDirectory(versionDir, {
    label: "runtime cache validation",
    timeoutMs: 120_000,
  });
  if (canonicalVersionDir !== resolve(versionDir)) {
    throw new Error(`runtime version directory must use its canonical path: ${versionDir}`);
  }
  if (await trustedReadyAt(installDir, assertLocalPrivateDirectory) &&
      !hasResidue(versionDir, base)) {
    if (mode === "recover") process.stdout.write("ready\n");
    return;
  }
  const lockPath = `${installDir}.agenc-lock.sqlite`;
  const releaseLock = await acquireLocalSqliteLock(lockPath, {
    label: "runtime install",
    timeoutMs: 120_000,
  });
  let stagingDir;
  let operationError;
  try {
    activationTestDelay("AGENC_INSTALL_TEST_HOLD_RUNTIME_LOCK_MS");
    const recovered = await reconcile(versionDir, base, assertLocalPrivateDirectory);
    if (mode === "recover") {
      process.stdout.write(recovered ? "ready\n" : "missing\n");
      return;
    }
    if (recovered) return;
    validateArchive(archivePath);
    stagingDir = mkdtempSync(join(versionDir, `.${base}.install-`));
    let verifiedExtractionTool = extractionTool;
    let verifiedExtractionEnvironment;
    let verifiedExtractionWorkingDirectory = stagingDir;
    if (process.platform === "win32") {
      verifiedExtractionTool = trustedWindowsTarExecutable();
      if (
        win32.normalize(extractionTool).toLowerCase() !==
          verifiedExtractionTool.toLowerCase()
      ) {
        throw new Error("runtime extraction tool is not the trusted Windows tar path");
      }
      const system32 = win32.dirname(verifiedExtractionTool);
      const systemRoot = win32.dirname(system32);
      verifiedExtractionWorkingDirectory = system32;
      verifiedExtractionEnvironment = {
        APPDATA: "",
        COMSPEC: win32.join(system32, "cmd.exe"),
        HOME: "",
        HOMEDRIVE: "",
        HOMEPATH: "",
        LOCALAPPDATA: "",
        LOGONSERVER: "",
        PATH: system32,
        PATHEXT: ".COM;.EXE",
        PSModulePath: "",
        SYSTEMDRIVE: "",
        SystemRoot: systemRoot,
        TEMP: win32.join(systemRoot, "Temp"),
        TMP: win32.join(systemRoot, "Temp"),
        USERDOMAIN: "",
        USERNAME: "",
        USERPROFILE: system32,
        WINDIR: systemRoot,
      };
    } else {
      if (!isAbsolute(extractionTool)) {
        throw new Error("runtime extraction tool must be an absolute path");
      }
      const extractionToolStat = lstatSync(extractionTool);
      if (!extractionToolStat.isFile() || extractionToolStat.isSymbolicLink()) {
        throw new Error("runtime extraction tool must be a regular file");
      }
    }
    const extracted = spawnSync(
      verifiedExtractionTool,
      ["-xzf", archivePath, "-C", stagingDir],
      {
        cwd: verifiedExtractionWorkingDirectory,
        stdio: "inherit",
        ...(verifiedExtractionEnvironment === undefined
          ? {}
          : { env: verifiedExtractionEnvironment }),
      },
    );
    if (extracted.status !== 0) throw new Error(`tar extraction failed (${extracted.status ?? extracted.signal})`);
    if (!strictRelativeRuntimeFile(stagingDir, binRel)) {
      throw new Error("runtime entrypoint is not a contained regular file");
    }
    if (embeddedNodeRel !== "" && (
      !strictRelativeRuntimeFile(stagingDir, embeddedNodeRel) ||
      !strictRelativeRuntimeFile(stagingDir, "node_modules/.agenc-node/identity.json")
    )) {
      throw new Error("runtime private Node payload is incomplete");
    }
    if (embeddedNodeLibraryRel !== "" &&
        !strictRelativeRuntimeFile(stagingDir, `${embeddedNodeLibraryRel}/libatomic.so.1`)) {
      throw new Error("runtime private Node library payload is incomplete");
    }
    syncTree(stagingDir);
    if (provenanceExpectation !== undefined) {
      const receipt = decodeProvenanceJson(provenanceReceiptBase64, "provenance receipt");
      if (!validProvenanceReceipt(receipt)) throw new Error("invalid provenance receipt");
      writeFileDurably(
        join(stagingDir, PROVENANCE_RECEIPT_NAME),
        `${JSON.stringify(receipt)}\n`,
        { mode: 0o600 },
      );
    } else if (provenanceReceiptBase64 !== "") {
      throw new Error("unexpected provenance receipt");
    }
    writeFileDurably(join(stagingDir, ".agenc-runtime-ok"), expectedSha, { mode: 0o600 });
    syncDirectory(stagingDir);
    promote(stagingDir, installDir);
    stagingDir = undefined;
    if (!(await reconcile(versionDir, base, assertLocalPrivateDirectory))) {
      throw new Error("promoted runtime failed its marker contract");
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (stagingDir !== undefined) {
      try {
        removeDurably(stagingDir, { recursive: true, force: true });
        cleanupTestFailure(
          "AGENC_INSTALL_TEST_FAIL_STAGING_CLEANUP",
          "injected staging cleanup failure",
        );
      }
      catch (error) { cleanupErrors.push(error); }
    }
    try {
      releaseLock();
      if (mode === "install") {
        cleanupTestFailure(
          "AGENC_INSTALL_TEST_FAIL_RELEASE_CLEANUP",
          "injected release cleanup failure",
        );
      }
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
        "runtime install and cleanup did not both complete",
      );
    }
  }
}
async function renderWrapperMain() {
  const { parseGeneratedWrapperContent, renderGeneratedWrapperContent } =
    await loadGeneratedWrapperModule();
  const kind = artifactPlatform;
  const content = renderGeneratedWrapperContent({
    kind,
    nodeBin: installDir,
    runtimeBin: binRel,
    agencHome: expectedSha,
    ...(extractionTool === "" ? {} : { nodeLibraryPath: extractionTool }),
  });
  if (parseGeneratedWrapperContent(resolve(archivePath), content) === null) {
    throw new Error("rendered wrapper failed canonical validation");
  }
  writeFileSync(archivePath, content, {
    flag: "wx",
    mode: kind === "cmd" ? 0o644 : 0o755,
  });
}
async function prepareWrapperDirectoriesMain() {
  const prefix = resolve(archivePath);
  const wrapperDirectory = resolve(installDir);
  const repairExisting = binRel === "true";
  if (
    !isAbsolute(archivePath) ||
    !isAbsolute(installDir) ||
    wrapperDirectory !== join(prefix, "bin") ||
    !["true", "false"].includes(binRel)
  ) {
    throw new Error("invalid wrapper directory preparation arguments");
  }

  const prefixExisted = existsSync(prefix);
  mkdirSync(prefix, { recursive: true, mode: 0o700 });
  const prefixSecured = secureOwnerDirectory(prefix, {
    repairWritable: repairExisting,
    ownerOnly: !prefixExisted,
  });
  let repairedExisting = prefixExisted && prefixSecured;

  const wrapperDirectoryExisted = existsSync(wrapperDirectory);
  mkdirSync(wrapperDirectory, { recursive: true, mode: 0o700 });
  const wrapperDirectorySecured = secureOwnerDirectory(wrapperDirectory, {
    repairWritable: repairExisting,
    ownerOnly: !wrapperDirectoryExisted,
  });
  repairedExisting =
    (wrapperDirectoryExisted && wrapperDirectorySecured) || repairedExisting;

  const { assertLocalPrivateDirectory } = await loadSqliteLockModule();
  for (const path of [prefix, wrapperDirectory]) {
    const canonical = await assertLocalPrivateDirectory(path, {
      label: "wrapper directory preparation",
      timeoutMs: 120_000,
    });
    if (canonical !== path) {
      throw new Error(`wrapper directory must use its canonical path: ${path}`);
    }
  }
  process.stdout.write(repairedExisting ? "repaired\n" : "ready\n");
}
async function main() {
  if (mode === "render-wrapper") await renderWrapperMain();
  else if (mode === "prepare-wrapper-directories") await prepareWrapperDirectoriesMain();
  else if (mode === "activate") await activationMain();
  else await runtimeMain();
}
function installerErrorMessages(error, seen = new Set()) {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    if (seen.has(error)) return [];
    seen.add(error);
  }
  if (error instanceof AggregateError) {
    return [
      error.message,
      ...error.errors.flatMap((item) => installerErrorMessages(item, seen)),
    ];
  }
  return [error instanceof Error ? error.message : String(error)];
}
main().catch((error) => {
  console.error(installerErrorMessages(error).join("\n"));
  process.exitCode = 1;
});
