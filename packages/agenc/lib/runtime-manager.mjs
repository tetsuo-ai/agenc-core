// Install-side runtime resolver for the published launcher.
//
// The npm launcher is tiny; the real runtime is a per-platform tarball on
// GitHub Releases (see scripts/build-runtime-tarball.mjs). This module:
//   1. resolves the already-extracted runtime under <agenc-home>/runtime/<ver>/,
//   2. or, if absent, reads the bundled manifest, downloads the artifact for the
//      current platform, verifies its sha256, and extracts it there.
//
// It is intentionally dependency-free (Node built-ins only) so it can run from
// `postinstall` before anything else is available.

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  assertArtifactCompatible,
  currentRuntimeCompatibility,
  runtimeArtifactKey,
} from "./runtime-compatibility.mjs";
import { validateRuntimeArchive } from "./runtime-archive.mjs";
import {
  canonicalLocalFileUrlToPath,
  MAX_RUNTIME_ARTIFACT_BYTES,
  MAX_RUNTIME_MANIFEST_BYTES,
  validateRuntimeReleaseManifest,
} from "./runtime-release-contract.mjs";
import { acquireLocalSqliteLock } from "./sqlite-lock.mjs";

export {
  MAX_RUNTIME_ARTIFACT_BYTES,
  MAX_RUNTIME_MANIFEST_BYTES,
} from "./runtime-release-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAUNCHER_VERSION = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
).version;
const MANIFEST_PATH = resolve(
  __dirname,
  "..",
  "generated",
  "agenc-runtime-manifest-v2.json",
);
const DEFAULT_RUNTIME_FETCH_TIMEOUT_MS = 120_000;
const DEFAULT_RUNTIME_EXTRACTION_TIMEOUT_MS = 120_000;
const WINDOWS_SYSTEM_ROOT = String.raw`\\?\GLOBALROOT\SystemRoot`;

export function resolveAgenCHome(env = process.env, userHome = homedir()) {
  const configured = env.AGENC_HOME;
  const requested = configured && configured.length > 0
    ? configured
    : join(userHome, ".agenc");
  if (!isAbsolute(requested)) {
    throw new Error(
      "agenc: AGENC_HOME must be an absolute path so its identity does not change with the working directory",
    );
  }
  return resolve(requested);
}

function canonicalizeAgenCHome(requested) {
  if (!isAbsolute(requested)) {
    throw new Error("agenc: AGENC_HOME must be an absolute path");
  }
  const existed = existsSync(requested);
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const requestedStat = lstatSync(requested);
  if (!requestedStat.isDirectory() && !requestedStat.isSymbolicLink()) {
    throw new Error(`agenc: AGENC_HOME is not a directory: ${requested}`);
  }
  // An existing symlink alias is deliberately resolved once. All subsequent
  // install paths and lock identities use the canonical target, so changing
  // the alias cannot move an in-flight install into another home.
  if (!existed && requestedStat.isSymbolicLink()) {
    throw new Error(`agenc: newly created AGENC_HOME became a symlink: ${requested}`);
  }
  const canonical = realpathSync(requested);
  const canonicalStat = lstatSync(canonical);
  if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) {
    throw new Error(`agenc: canonical AGENC_HOME is not a real directory: ${canonical}`);
  }
  if (process.platform !== "win32" && typeof process.getuid === "function") {
    if (canonicalStat.uid !== process.getuid()) {
      throw new Error(`agenc: AGENC_HOME is owned by another user: ${canonical}`);
    }
    chmodSync(canonical, 0o700);
  }
  return canonical;
}

export function platformSlug(platform = process.platform, arch = process.arch) {
  const os = platform === "win32" ? "win" : platform;
  return { os, arch };
}

function readBoundedManifest(path, maximumBytes) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`agenc: runtime manifest must be a plain file (${path})`);
  }
  if (before.size > maximumBytes) {
    throw new Error(
      `agenc: runtime manifest exceeds ${maximumBytes} bytes (${before.size})`,
    );
  }
  const fd = openSync(path, "r");
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > maximumBytes) {
      throw new Error(`agenc: runtime manifest exceeds ${maximumBytes} bytes`);
    }
    if (
      process.platform !== "win32" &&
      (opened.dev !== before.dev || opened.ino !== before.ino)
    ) {
      throw new Error("agenc: runtime manifest changed while it was opened");
    }
    const bytes = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maximumBytes) {
      throw new Error(`agenc: runtime manifest exceeds ${maximumBytes} bytes`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    } catch {
      throw new Error("agenc: runtime manifest is not valid UTF-8");
    }
  } finally {
    closeSync(fd);
  }
}

export function readManifest(
  manifestPath = MANIFEST_PATH,
  maximumBytes = MAX_RUNTIME_MANIFEST_BYTES,
) {
  if (!existsSync(manifestPath)) {
    throw new Error(
      `agenc: runtime manifest missing (${manifestPath}); this launcher build is incomplete`,
    );
  }
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAX_RUNTIME_MANIFEST_BYTES
  ) {
    throw new TypeError("agenc: runtime manifest byte limit is invalid");
  }
  const source = readBoundedManifest(manifestPath, maximumBytes);
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error("agenc: runtime manifest is not valid JSON", { cause: error });
  }
}

export function selectArtifact(
  manifest,
  slug = platformSlug(),
  nodeModuleAbi = process.versions.modules,
  runtime = currentRuntimeCompatibility({
    platform: slug.os,
    arch: slug.arch,
    nodeModuleAbi,
  }),
  { trustMode = "official" } = {},
) {
  validateRuntimeReleaseManifest(manifest, {
    trustMode,
    expectedRuntimeVersion: trustMode === "official" ? LAUNCHER_VERSION : undefined,
  });
  const matches = manifest.artifacts.filter(
    (a) =>
      a.platform === slug.os &&
      a.arch === slug.arch &&
      a.nodeModuleAbi === nodeModuleAbi,
  );
  if (matches.length !== 1) {
    const have = manifest.artifacts
      .map((a) => `${a.platform}-${a.arch}/abi${a.nodeModuleAbi ?? "?"}`)
      .join(", ");
    if (matches.length > 1) {
      throw new Error(
        `agenc: runtime manifest contains multiple builds for ` +
          `${slug.os}-${slug.arch}/abi${nodeModuleAbi}`,
      );
    }
    throw new Error(
      `agenc: no runtime build for ${slug.os}-${slug.arch}/abi${nodeModuleAbi} ` +
        `(Node ${process.version}; available: ${have || "none"}). ` +
        `Use a Node.js version supported by @tetsuo-ai/agenc ${LAUNCHER_VERSION}, ` +
        "then reinstall @tetsuo-ai/agenc before retrying; no runtime was downloaded",
    );
  }
  const [match] = matches;
  return assertArtifactCompatible(match, runtime);
}

// Directory the artifact extracts to, and the runtime bin inside it.
export function runtimeInstallDir(
  home,
  version,
  artifact,
) {
  return join(
    home,
    "runtime",
    version,
    `${runtimeArtifactKey(artifact)}-sha256-${artifact.sha256}`,
  );
}
export function runtimeBinPath(home, version, artifact) {
  const rel = artifact?.bins?.agenc ?? "node_modules/@tetsuo-ai/runtime/bin/agenc";
  return join(runtimeInstallDir(home, version, artifact), rel);
}

function markerPath(installDir) {
  return join(installDir, ".agenc-runtime-ok");
}

function strictRelativeRegularFile(root, relativePath) {
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).some((part) => part.length === 0 || part === "." || part === "..")
  ) return false;
  const finalPath = resolve(root, relativePath);
  const within = relative(resolve(root), finalPath);
  if (within === "" || within === ".." || within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(within)) {
    return false;
  }
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
  } catch {
    return false;
  }
}

function strictMarkerMatches(installDir, expectedSha) {
  try {
    const marker = markerPath(installDir);
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128) return false;
    const content = readFileSync(marker, "utf8");
    return content === expectedSha || content === `${expectedSha}\n`;
  } catch {
    return false;
  }
}

// A runtime install is "good" only if the success marker exists AND records the
// expected sha256 — guards against a half-extracted or stale tree.
export function isInstalled(installDir, expectedSha, expectedBin) {
  try {
    const root = lstatSync(installDir);
    if (!root.isDirectory() || root.isSymbolicLink()) return false;
    if (!strictMarkerMatches(installDir, expectedSha)) return false;
    return expectedBin === undefined || strictRelativeRegularFile(
      installDir,
      relative(installDir, expectedBin),
    );
  } catch {
    return false;
  }
}

function readyInstallAt(path, expectedSha, binRel) {
  try {
    const root = lstatSync(path);
    return root.isDirectory() &&
      !root.isSymbolicLink() &&
      strictRelativeRegularFile(path, binRel) &&
      strictMarkerMatches(path, expectedSha);
  } catch {
    return false;
  }
}

function hasInstallResidue(versionDir, base) {
  return readdirSync(versionDir).some((name) =>
    name.startsWith(`.${base}.install-`) ||
    name.startsWith(`${base}.old-`));
}

function durabilityEvent(hook, event, details) {
  hook?.(event, details);
}

function syncRegularFile(path, event, hook) {
  durabilityEvent(hook, event, { path });
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`agenc: durability target is not a regular file: ${path}`);
  }
  const fd = openSync(
    path,
    (process.platform === "win32" ? fsConstants.O_RDWR : fsConstants.O_RDONLY) |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameLocalArtifactIdentity(before, opened)) {
      throw new Error(`agenc: durability target changed while it was opened: ${path}`);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path, event, hook) {
  if (process.platform === "win32") {
    // Node does not expose Win32 directory handles with write-through flags.
    // Reopen and enumerate the renamed directory so Windows at least verifies
    // the new name, while every regular file is flushed individually.
    durabilityEvent(hook, `verify-${event}`, { path });
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`agenc: durable directory verification failed: ${path}`);
    }
    readdirSync(path);
    return;
  }
  durabilityEvent(hook, event, { path });
  const fd = openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0),
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncExtractedTree(root, hook) {
  const entries = readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) continue;
    if (metadata.isDirectory()) {
      syncExtractedTree(path, hook);
    } else if (metadata.isFile()) {
      syncRegularFile(path, "sync-tree-file", hook);
    } else {
      throw new Error(`agenc: extracted runtime contains an unsupported file type: ${path}`);
    }
  }
  syncDirectory(root, "sync-tree-directory", hook);
}

function durableWriteMarker(path, content, hook) {
  durabilityEvent(hook, "write-marker", { path });
  const fd = openSync(
    path,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const bytes = Buffer.from(content);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) throw new Error("agenc: marker write made no progress");
      offset += written;
    }
    durabilityEvent(hook, "sync-marker", { path });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function verifyRenamedDirectory(path, hook) {
  if (process.platform !== "win32") return;
  durabilityEvent(hook, "verify-rename", { path });
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  ) {
    throw new Error(`agenc: renamed runtime directory failed verification: ${path}`);
  }
  readdirSync(path);
}

function durableRenameDirectory(from, to, event, hook) {
  durabilityEvent(hook, event, { from, to });
  renameSync(from, to);
  verifyRenamedDirectory(to, hook);
  syncDirectory(dirname(to), "sync-parent-after-rename", hook);
}

function durableRemoveDirectory(path, parent, hook) {
  durabilityEvent(hook, "remove-residue", { path });
  rmSync(path, { recursive: true, force: true });
  syncDirectory(parent, "sync-parent-after-remove", hook);
}

function reconcileInstallState(versionDir, installDir, expectedSha, binRel, durabilityHook) {
  const base = basename(installDir);
  const entries = readdirSync(versionDir);
  const readyStages = entries
    .filter((name) => name.startsWith(`.${base}.install-`))
    .map((name) => join(versionDir, name))
    .filter((path) => readyInstallAt(path, expectedSha, binRel))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  const readyBackups = entries
    .filter((name) => name.startsWith(`${base}.old-`))
    .map((name) => join(versionDir, name))
    .filter((path) => readyInstallAt(path, expectedSha, binRel))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);

  if (!readyInstallAt(installDir, expectedSha, binRel)) {
    // A staged tree is written and marked before the first promotion rename,
    // so it is the newest intended state. Prefer it over a backup, then use a
    // verified backup as the fallback. promoteInstall quarantines any invalid
    // canonical tree and rolls it back if the candidate rename fails.
    const recoveryCandidate = readyStages[0] ?? readyBackups[0];
    if (recoveryCandidate !== undefined) {
      syncExtractedTree(recoveryCandidate, durabilityHook);
      promoteInstall(recoveryCandidate, installDir, durabilityHook);
    }
  }
  const ready = readyInstallAt(installDir, expectedSha, binRel);
  // Never destroy crash evidence or the only recoverable tree until a fully
  // verified canonical installation exists.
  if (!ready) return false;
  for (const name of readdirSync(versionDir)) {
    if (
      name.startsWith(`.${base}.install-`) ||
      name.startsWith(`${base}.old-`)
    ) {
      try {
        durableRemoveDirectory(join(versionDir, name), versionDir, durabilityHook);
      } catch { /* residue cleanup is retried on the next launch */ }
    }
  }
  return true;
}

function promoteInstall(stagingDir, installDir, durabilityHook) {
  const backup = `${installDir}.old-${process.pid}-${randomUUID()}`;
  let movedExisting = false;
  try {
    if (existsSync(installDir)) {
      durableRenameDirectory(
        installDir,
        backup,
        "rename-current-to-backup",
        durabilityHook,
      );
      movedExisting = true;
    }
    durableRenameDirectory(
      stagingDir,
      installDir,
      "rename-stage-to-current",
      durabilityHook,
    );
  } catch (error) {
    if (!existsSync(installDir) && movedExisting && existsSync(backup)) {
      try {
        durableRenameDirectory(
          backup,
          installDir,
          "rename-backup-to-current",
          durabilityHook,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `agenc: runtime promotion failed; previous install retained at ${backup}`,
        );
      }
    }
    throw error;
  }
}

function identityOf(stats) {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameIdentity(left, right, { includeContent = true } = {}) {
  return left.dev === right.dev && left.ino === right.ino &&
    (!includeContent || (
      left.size === right.size &&
      left.mtimeNs === right.mtimeNs &&
      left.ctimeNs === right.ctimeNs
    ));
}

function snapshotRegularFile(path, label) {
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
    throw new Error(`agenc: ${label} must be a regular single-link file`);
  }
  return identityOf(stats);
}

function assertRegularFileIdentity(path, expected, label) {
  const actual = snapshotRegularFile(path, label);
  if (!sameIdentity(actual, expected)) {
    throw new Error(`agenc: ${label} identity changed during installation`);
  }
}

function snapshotDirectory(path, label) {
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`agenc: ${label} must be a real directory`);
  }
  return identityOf(stats);
}

function assertDirectoryIdentity(path, expected, label) {
  const actual = snapshotDirectory(path, label);
  if (!sameIdentity(actual, expected, { includeContent: false })) {
    throw new Error(`agenc: ${label} identity changed during installation`);
  }
}

function createPrivateTemporaryDirectory(parent, prefix) {
  const requestedParent = resolve(parent);
  const canonicalParent = realpathSync.native(requestedParent);
  if (canonicalParent !== requestedParent) {
    throw new Error(`agenc: temporary parent must use its canonical path: ${requestedParent}`);
  }
  const parentStats = lstatSync(canonicalParent, { bigint: true });
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error(`agenc: temporary parent is not a real directory: ${canonicalParent}`);
  }
  if (process.platform !== "win32" && typeof process.getuid === "function") {
    if (parentStats.uid !== BigInt(process.getuid()) || (parentStats.mode & 0o022n) !== 0n) {
      throw new Error(`agenc: temporary parent is not privately owned: ${canonicalParent}`);
    }
  }
  const created = mkdtempSync(join(canonicalParent, prefix));
  const before = snapshotDirectory(created, "temporary directory");
  chmodSync(created, 0o700);
  const canonical = realpathSync.native(created);
  const after = snapshotDirectory(canonical, "temporary directory");
  if (canonical !== created || !sameIdentity(before, after, { includeContent: false })) {
    throw new Error("agenc: temporary directory identity changed while it was secured");
  }
  return { path: canonical, identity: after };
}

function sha256File(file, expectedIdentity) {
  const before = snapshotRegularFile(file, "runtime archive");
  if (expectedIdentity !== undefined && !sameIdentity(before, expectedIdentity)) {
    throw new Error("agenc: runtime archive identity changed before hashing");
  }
  const fd = openSync(
    file,
    fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = identityOf(fstatSync(fd, { bigint: true }));
    if (!sameIdentity(opened, before)) {
      throw new Error("agenc: runtime archive changed while it was opened for hashing");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    const after = identityOf(fstatSync(fd, { bigint: true }));
    if (!sameIdentity(after, before)) {
      throw new Error("agenc: runtime archive changed while it was hashed");
    }
    assertRegularFileIdentity(file, before, "runtime archive");
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function createFetchDeadline(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
    throw new TypeError("agenc: runtime fetch timeout must be an integer from 1 to 600000 ms");
  }
  return {
    controller: new AbortController(),
    deadline: performance.now() + timeoutMs,
    timeoutMs,
  };
}

function fetchTimeoutError(context, label) {
  const error = new Error(
    `agenc: ${label} timed out after ${context.timeoutMs} ms total`,
  );
  error.code = "AGENC_RUNTIME_FETCH_TIMEOUT";
  return error;
}

async function awaitWithinFetchDeadline(value, context, label) {
  const remaining = context.deadline - performance.now();
  if (remaining <= 0) {
    const error = fetchTimeoutError(context, label);
    context.controller.abort(error);
    throw error;
  }
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = fetchTimeoutError(context, label);
      // Settle the deadline promise with the policy error before aborting the
      // transport/pipeline, whose AbortError would otherwise obscure it.
      reject(error);
      context.controller.abort(error);
    }, Math.max(1, Math.ceil(remaining)));
  });
  try {
    return await Promise.race([Promise.resolve(value), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function cancelResponseBody(response, context, label) {
  if (typeof response?.body?.cancel !== "function") return;
  try {
    const cancellation = response.body.cancel();
    if (context === undefined) {
      await cancellation;
    } else {
      await awaitWithinFetchDeadline(cancellation, context, label);
    }
  } catch (error) {
    if (error?.code === "AGENC_RUNTIME_FETCH_TIMEOUT") throw error;
    // Cancellation is best-effort after a stronger policy error. Aborting the
    // shared controller below still tears down the transport.
  }
}

async function fetchHttps(url, fetchImpl, label, context) {
  let current;
  try {
    current = new URL(url);
  } catch {
    throw new Error(`agenc: ${label} URL is invalid`);
  }
  if (current.protocol !== "https:") {
    throw new Error(`agenc: refusing non-HTTPS ${label} URL: ${current.href}`);
  }
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await awaitWithinFetchDeadline(
      fetchImpl(current, {
        redirect: "manual",
        headers: { "accept-encoding": "identity" },
        signal: context.controller.signal,
      }),
      context,
      `${label} response headers`,
    );
    if (!REDIRECT_STATUSES.has(response.status)) {
      let finalProtocolIsHttps = true;
      try {
        finalProtocolIsHttps = !response.url || new URL(response.url).protocol === "https:";
      } catch {
        finalProtocolIsHttps = false;
      }
      if (response.redirected || !finalProtocolIsHttps) {
        await cancelResponseBody(response, context, `${label} response cancellation`);
        throw new Error(`agenc: ${label} fetch performed an unreviewed redirect`);
      }
      return response;
    }
    const location = response.headers?.get?.("location");
    if (!location) {
      await cancelResponseBody(response, context, `${label} redirect cancellation`);
      throw new Error(`agenc: ${label} redirect is missing Location`);
    }
    let next;
    try {
      next = new URL(location, current);
    } catch {
      await cancelResponseBody(response, context, `${label} redirect cancellation`);
      throw new Error(`agenc: ${label} redirect Location is invalid`);
    }
    if (next.protocol !== "https:") {
      await cancelResponseBody(response, context, `${label} redirect cancellation`);
      throw new Error(`agenc: refusing HTTPS downgrade while fetching ${label}`);
    }
    await cancelResponseBody(response, context, `${label} redirect cancellation`);
    current = next;
  }
  throw new Error(`agenc: too many redirects while fetching ${label}`);
}

async function* requireExactByteCount(source, expectedBytes, context) {
  let received = 0;
  const iterator = source[Symbol.asyncIterator]();
  let complete = false;
  try {
    while (true) {
      const step = context === undefined
        ? await iterator.next()
        : await awaitWithinFetchDeadline(
          iterator.next(),
          context,
          "runtime artifact response body",
        );
      if (step.done) {
        complete = true;
        break;
      }
      const chunk = Buffer.isBuffer(step.value) ? step.value : Buffer.from(step.value);
      received += chunk.length;
      if (received > expectedBytes) {
        throw new Error(
          `agenc: runtime byte count exceeds signed size ` +
            `(expected ${expectedBytes}, received at least ${received})`,
        );
      }
      yield chunk;
    }
  } finally {
    if (!complete && typeof iterator.return === "function") {
      try {
        const returning = iterator.return();
        if (context === undefined) await returning;
        else await awaitWithinFetchDeadline(
          returning,
          context,
          "runtime artifact body cancellation",
        );
      } catch { /* the primary error wins */ }
    }
  }
  if (received !== expectedBytes) {
    throw new Error(
      `agenc: runtime byte count mismatch (expected ${expectedBytes}, got ${received})`,
    );
  }
}

function parseContentLength(response) {
  const value = response.headers?.get?.("content-length");
  if (value === null || value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("agenc: runtime artifact Content-Length is invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("agenc: runtime artifact Content-Length is invalid");
  }
  return parsed;
}

function sameLocalArtifactIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameLocalArtifactSnapshot(left, right) {
  return sameLocalArtifactIdentity(left, right) &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function assertPlainSingleLinkArtifact(metadata, expectedBytes) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error("agenc: local runtime artifact must be a plain single-link file");
  }
  if (metadata.dev === 0n && metadata.ino === 0n) {
    throw new Error("agenc: local runtime artifact has no stable filesystem identity");
  }
  if (metadata.size !== BigInt(expectedBytes)) {
    throw new Error(
      `agenc: runtime byte count mismatch (expected ${expectedBytes}, got ${metadata.size})`,
    );
  }
}

async function copyLocalArtifact(
  url,
  dest,
  expectedBytes,
  localArtifactHook,
  durabilityHook,
) {
  const path = canonicalLocalFileUrlToPath(url);
  const before = lstatSync(path, { bigint: true });
  assertPlainSingleLinkArtifact(before, expectedBytes);
  localArtifactHook?.("after-lstat", { path, metadata: before });
  const flags = fsConstants.O_RDONLY |
    (fsConstants.O_NOFOLLOW ?? 0) |
    (fsConstants.O_NONBLOCK ?? 0);
  let fd;
  let operationError;
  try {
    fd = openSync(path, flags);
    const opened = fstatSync(fd, { bigint: true });
    assertPlainSingleLinkArtifact(opened, expectedBytes);
    if (!sameLocalArtifactSnapshot(before, opened)) {
      throw new Error("agenc: local runtime artifact changed while it was opened");
    }
    localArtifactHook?.("after-open", { path, fd, metadata: opened });
    await pipeline(
      createReadStream(path, { fd, autoClose: false }),
      (source) => requireExactByteCount(source, expectedBytes),
      createWriteStream(dest, { flags: "wx", mode: 0o600 }),
    );
    localArtifactHook?.("before-eof-validation", { path, fd, metadata: opened });
    const openedAfterRead = fstatSync(fd, { bigint: true });
    const pathAfterRead = lstatSync(path, { bigint: true });
    assertPlainSingleLinkArtifact(openedAfterRead, expectedBytes);
    assertPlainSingleLinkArtifact(pathAfterRead, expectedBytes);
    if (
      !sameLocalArtifactSnapshot(opened, openedAfterRead) ||
      !sameLocalArtifactSnapshot(openedAfterRead, pathAfterRead)
    ) {
      throw new Error("agenc: local runtime artifact changed while it was read");
    }
    syncRegularFile(dest, "sync-download", durabilityHook);
  } catch (error) {
    operationError = error;
  }
  let closeError;
  if (fd !== undefined) {
    try { closeSync(fd); } catch (error) { closeError = error; }
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [operationError, closeError],
      "agenc: local runtime artifact copy and descriptor close did not both complete",
    );
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
}

async function download(
  url,
  dest,
  expectedBytes,
  trustMode,
  fetchImpl = globalThis.fetch,
  {
    fetchTimeoutMs = DEFAULT_RUNTIME_FETCH_TIMEOUT_MS,
    localArtifactHook,
    durabilityHook,
  } = {},
) {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0 ||
    expectedBytes > MAX_RUNTIME_ARTIFACT_BYTES
  ) {
    throw new Error(
      `agenc: runtime artifact signed size must be between 1 and ` +
        `${MAX_RUNTIME_ARTIFACT_BYTES} bytes`,
    );
  }
  if (trustMode === "explicitLocal") {
    await copyLocalArtifact(url, dest, expectedBytes, localArtifactHook, durabilityHook);
    return;
  }
  const parsed = new URL(url);
  if (parsed.protocol === "file:") {
    throw new Error("agenc: remote runtime manifests must not access local files");
  }
  const context = createFetchDeadline(fetchTimeoutMs);
  let res;
  try {
    res = await fetchHttps(url, fetchImpl, "runtime artifact", context);
    if (!res.ok || res.body === null) {
      await cancelResponseBody(res, context, "runtime artifact error-body cancellation");
      throw new Error(`agenc: download failed ${res.status} ${res.statusText}: ${url}`);
    }
    const contentEncoding = res.headers?.get?.("content-encoding");
    if (
      contentEncoding !== null &&
      contentEncoding !== undefined &&
      contentEncoding !== "identity"
    ) {
      await cancelResponseBody(res, context, "runtime artifact error-body cancellation");
      throw new Error("agenc: runtime artifact response must use identity encoding");
    }
    let contentLength;
    try {
      contentLength = parseContentLength(res);
    } catch (error) {
      await cancelResponseBody(res, context, "runtime artifact error-body cancellation");
      throw error;
    }
    if (contentLength !== undefined && contentLength !== expectedBytes) {
      await cancelResponseBody(res, context, "runtime artifact error-body cancellation");
      throw new Error(
        `agenc: runtime artifact Content-Length mismatch ` +
          `(expected ${expectedBytes}, got ${contentLength})`,
      );
    }
    const readable = typeof res.body.getReader === "function"
      ? Readable.fromWeb(res.body)
      : res.body;
    await awaitWithinFetchDeadline(
      pipeline(
        readable,
        (source) => requireExactByteCount(source, expectedBytes, context),
        createWriteStream(dest, { flags: "wx", mode: 0o600 }),
        { signal: context.controller.signal },
      ),
      context,
      "runtime artifact download",
    );
    syncRegularFile(dest, "sync-download", durabilityHook);
  } catch (error) {
    context.controller.abort(error);
    if (res !== undefined) {
      // Do not let a transport that ignores abort hold the installer open.
      void cancelResponseBody(res, undefined, "runtime artifact cancellation")
        .catch(() => {});
    }
    throw error;
  }
}

function assertRootOwnedSystemExecutable(path) {
  const canonical = realpathSync.native(path);
  const executable = lstatSync(canonical, { bigint: true });
  if (
    !executable.isFile() || executable.isSymbolicLink() ||
    executable.nlink !== 1n || executable.uid !== 0n ||
    (executable.mode & 0o022n) !== 0n
  ) {
    throw new Error(`agenc: operating-system tar is not a trusted regular file: ${canonical}`);
  }
  for (let ancestor = dirname(canonical); ; ancestor = dirname(ancestor)) {
    const metadata = lstatSync(ancestor, { bigint: true });
    if (
      !metadata.isDirectory() || metadata.isSymbolicLink() ||
      metadata.uid !== 0n || (metadata.mode & 0o022n) !== 0n
    ) {
      throw new Error(`agenc: operating-system tar has an untrusted ancestor: ${ancestor}`);
    }
    if (dirname(ancestor) === ancestor) break;
  }
  return canonical;
}

/** Resolve tar independently of npm/project PATH and caller environment controls. */
export function resolveTrustedSystemTar(platform = process.platform) {
  if (platform === "linux" || platform === "darwin") {
    const candidates = platform === "darwin"
      ? ["/usr/bin/tar"]
      : ["/usr/bin/tar", "/bin/tar"];
    const candidate = candidates.find((path) => existsSync(path));
    if (candidate === undefined) {
      throw new Error(`agenc: trusted operating-system tar is unavailable on ${platform}`);
    }
    return {
      path: assertRootOwnedSystemExecutable(candidate),
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
    };
  }
  if (platform !== "win32") {
    throw new Error(`agenc: trusted operating-system tar is unsupported on ${platform}`);
  }

  // GLOBALROOT reaches the kernel's real SystemRoot namespace and cannot be
  // redirected with caller-controlled SystemRoot/WINDIR values or drive maps.
  const system32 = win32.join(WINDOWS_SYSTEM_ROOT, "System32");
  const powershellRoot = win32.join(system32, "WindowsPowerShell", "v1.0");
  const tarPath = win32.join(system32, "tar.exe");
  const powershell = win32.join(powershellRoot, "powershell.exe");
  for (const [path, label] of [[tarPath, "tar"], [powershell, "PowerShell"]]) {
    const metadata = lstatSync(path, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`agenc: trusted Windows ${label} is unavailable`);
    }
  }
  const env = {
    APPDATA: "",
    COMSPEC: win32.join(system32, "cmd.exe"),
    HOME: "",
    LOCALAPPDATA: "",
    PATH: `${system32};${powershellRoot}`,
    PATHEXT: ".COM;.EXE",
    PSModulePath: win32.join(powershellRoot, "Modules"),
    SystemRoot: WINDOWS_SYSTEM_ROOT,
    TEMP: win32.join(WINDOWS_SYSTEM_ROOT, "Temp"),
    TMP: win32.join(WINDOWS_SYSTEM_ROOT, "Temp"),
    USERPROFILE: powershellRoot,
    WINDIR: WINDOWS_SYSTEM_ROOT,
  };
  const signature = spawnSync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$s=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $args[0];" +
        "if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'Microsoft'){exit 51}",
      tarPath,
    ],
    {
      cwd: powershellRoot,
      encoding: "utf8",
      env,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      killSignal: "SIGKILL",
      windowsHide: true,
    },
  );
  if (signature.error !== undefined || signature.status !== 0) {
    throw new Error("agenc: Windows operating-system tar failed Authenticode validation");
  }
  return { path: tarPath, env };
}

function extractTarGz(archive, destDir) {
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  try { chmodSync(destDir, 0o700); } catch { /* ignore */ }
  const tar = resolveTrustedSystemTar();
  const res = spawnSync(tar.path, ["-xzf", archive, "-C", destDir], {
    cwd: destDir,
    encoding: "utf8",
    env: tar.env,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "ignore", "pipe"],
    timeout: DEFAULT_RUNTIME_EXTRACTION_TIMEOUT_MS,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (res.error !== undefined) {
    throw new Error(`agenc: tar extraction failed: ${res.error.message}`, { cause: res.error });
  }
  if (res.status !== 0) {
    const detail = res.stderr?.trim();
    throw new Error(
      `agenc: tar extraction failed (status ${res.status ?? res.signal})` +
        (detail ? `: ${detail}` : ""),
    );
  }
}

// Ensure the runtime for `manifest.runtimeVersion` is present; returns the bin
// path. Idempotent: a verified existing install short-circuits the download.
export async function ensureRuntime({
  env = process.env,
  userHome = homedir(),
  manifest = readManifest(),
  slug = platformSlug(),
  fetchImpl = globalThis.fetch,
  runtimeFetchTimeoutMs = DEFAULT_RUNTIME_FETCH_TIMEOUT_MS,
  manifestTrust = "official",
  runtimeCompatibility,
  localArtifactHook,
  durabilityHook,
  acquireLock = acquireLocalSqliteLock,
  remove = rmSync,
  log = (m) => process.stderr.write(m + "\n"),
} = {}) {
  const version = manifest.runtimeVersion;
  const artifact = selectArtifact(
    manifest,
    slug,
    process.versions.modules,
    runtimeCompatibility ?? currentRuntimeCompatibility(),
    { trustMode: manifestTrust },
  );
  // Validate identity, provenance, compatibility, and byte ceilings before
  // creating or changing any installation path.
  const home = canonicalizeAgenCHome(resolveAgenCHome(env, userHome));
  // Owner-only home (todo-120); install.sh already chmods 700.
  try {
    chmodSync(home, 0o700);
  } catch {
    /* ignore */
  }
  const installDir = runtimeInstallDir(home, version, artifact);
  const bin = runtimeBinPath(home, version, artifact);
  const binRel = artifact?.bins?.agenc ?? "node_modules/@tetsuo-ai/runtime/bin/agenc";
  const versionDir = dirname(installDir);
  mkdirSync(versionDir, { recursive: true, mode: 0o700 });
  chmodSync(versionDir, 0o700);
  const lockPath = `${installDir}.agenc-lock.sqlite`;

  if (
    readyInstallAt(installDir, artifact.sha256, binRel) &&
    !hasInstallResidue(versionDir, basename(installDir))
  ) return bin;

  // Reconcile a prior crash before doing network I/O. A process killed between
  // the two promotion renames leaves a complete backup that can be restored
  // offline under the same artifact-scoped lock.
  let releaseLock;
  let downloadDir;
  let downloadDirIdentity;
  let stagingDir;
  let stagingDirIdentity;
  let operationError;
  try {
    releaseLock = await acquireLock(lockPath, {
      label: "runtime install",
      timeoutMs: 60_000,
    });
    if (reconcileInstallState(
      versionDir,
      installDir,
      artifact.sha256,
      binRel,
      durabilityHook,
    )) {
      return bin;
    }
    // Network I/O must not hold the filesystem lock. Keep the release handle
    // registered until it succeeds so the outer cleanup can retry a failed
    // SQLite close without losing the original error.
    releaseLock();
    releaseLock = undefined;

    log(`agenc: fetching runtime ${version} (${slug.os}-${slug.arch})...`);
    ({ path: downloadDir, identity: downloadDirIdentity } =
      createPrivateTemporaryDirectory(versionDir, ".agenc-runtime-download-"));
    const tmp = join(downloadDir, "runtime.tar.gz");
    await download(artifact.url, tmp, artifact.bytes, manifestTrust, fetchImpl, {
      fetchTimeoutMs: runtimeFetchTimeoutMs,
      localArtifactHook,
      durabilityHook,
    });
    const archiveIdentity = snapshotRegularFile(tmp, "runtime archive");
    const actual = sha256File(tmp, archiveIdentity);
    if (actual !== artifact.sha256) {
      throw new Error(
        `agenc: runtime checksum mismatch (expected ${artifact.sha256}, got ${actual})`,
      );
    }
    if (archiveIdentity.size !== BigInt(artifact.bytes)) {
      throw new Error("agenc: bounded runtime download violated its byte-count invariant");
    }
    validateRuntimeArchive(tmp, artifact.platform);
    assertRegularFileIdentity(tmp, archiveIdentity, "runtime archive");
    releaseLock = await acquireLock(lockPath, {
      label: "runtime install",
      timeoutMs: 60_000,
    });
    // Another process may have completed while this one downloaded.
    if (reconcileInstallState(
      versionDir,
      installDir,
      artifact.sha256,
      binRel,
      durabilityHook,
    )) return bin;
    ({ path: stagingDir, identity: stagingDirIdentity } =
      createPrivateTemporaryDirectory(
        versionDir,
        `.${basename(installDir)}.install-`,
      ));
    assertRegularFileIdentity(tmp, archiveIdentity, "runtime archive");
    extractTarGz(tmp, stagingDir);
    assertRegularFileIdentity(tmp, archiveIdentity, "runtime archive");
    const stagedBin = join(stagingDir, binRel);
    if (!existsSync(stagedBin)) {
      throw new Error(`agenc: runtime extracted but entry missing: ${stagedBin}`);
    }
    durableWriteMarker(markerPath(stagingDir), artifact.sha256, durabilityHook);
    syncExtractedTree(stagingDir, durabilityHook);
    promoteInstall(stagingDir, installDir, durabilityHook);
    stagingDir = undefined;
    stagingDirIdentity = undefined;
    if (!reconcileInstallState(
      versionDir,
      installDir,
      artifact.sha256,
      binRel,
      durabilityHook,
    )) {
      throw new Error("agenc: promoted runtime did not satisfy the marker contract");
    }
    log(`agenc: runtime ${version} ready`);
    return bin;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (stagingDir !== undefined && existsSync(stagingDir)) {
      try {
        assertDirectoryIdentity(stagingDir, stagingDirIdentity, "runtime staging directory");
        durabilityEvent(durabilityHook, "remove-temporary", { path: stagingDir });
        remove(stagingDir, { recursive: true, force: true });
        syncDirectory(dirname(stagingDir), "sync-parent-after-remove", durabilityHook);
      }
      catch (error) { cleanupErrors.push(error); }
    }
    if (releaseLock !== undefined) {
      try { releaseLock(); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (downloadDir !== undefined) {
      try {
        assertDirectoryIdentity(downloadDir, downloadDirIdentity, "runtime download directory");
        durabilityEvent(durabilityHook, "remove-temporary", { path: downloadDir });
        remove(downloadDir, { recursive: true, force: true });
        syncDirectory(dirname(downloadDir), "sync-parent-after-remove", durabilityHook);
      }
      catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        operationError === undefined
          ? cleanupErrors
          : [operationError, ...cleanupErrors],
        "agenc: runtime install and cleanup did not both complete",
      );
    }
  }
}
