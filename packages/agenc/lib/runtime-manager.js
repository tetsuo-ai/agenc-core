import { createHash, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const GENERATED_DIRNAME = "generated";
const GENERATED_MANIFEST_BASENAME = "agenc-runtime-manifest.json";
const GENERATED_SIGNATURE_BASENAME = "agenc-runtime-manifest.json.sig";
const GENERATED_PUBLIC_KEY_BASENAME = "agenc-runtime-public-key.pem";
const GENERATED_TRUST_POLICY_BASENAME = "agenc-runtime-trust-policy.json";
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_INTERVAL_MS = 100;
const SUPPORTED_PLATFORM_ARCH = new Set(["darwin-arm64", "linux-x64"]);

export class RuntimeInstallError extends Error {
  constructor(message, code = "runtime_install_error") {
    super(message);
    this.name = "RuntimeInstallError";
    this.code = code;
  }
}

/**
 * Remove a filesystem path regardless of whether it's a symlink, a
 * regular file, or a directory. `fs.rm` with `recursive: true`
 * follows symlinks to directories (removing the TARGET, not the
 * link), so we `lstat` first and use `unlink` for the symlink case.
 */
async function removePathSafe(targetPath) {
  let info;
  try {
    info = await lstat(targetPath);
  } catch (error) {
    if ((error && error.code) === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || info.isFile()) {
    await unlink(targetPath);
    return;
  }
  await rm(targetPath, { recursive: true, force: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOptionalString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function computeSha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function toPlatformArch(platform, arch) {
  return `${platform}-${arch}`;
}

function parseVersion(version) {
  const match = /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(version);
  if (!match?.groups) {
    return null;
  }
  return [
    Number.parseInt(match.groups.major, 10),
    Number.parseInt(match.groups.minor, 10),
    Number.parseInt(match.groups.patch, 10),
  ];
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }
  return 0;
}

function satisfiesNodeRange(nodeVersion, range) {
  const parsedNodeVersion = parseVersion(nodeVersion);
  if (!parsedNodeVersion) {
    return false;
  }
  const trimmedRange = range.trim();
  if (trimmedRange.startsWith(">=")) {
    const required = parseVersion(trimmedRange.slice(2));
    return required ? compareVersions(parsedNodeVersion, required) >= 0 : false;
  }
  const exact = parseVersion(trimmedRange);
  return exact ? compareVersions(parsedNodeVersion, exact) === 0 : false;
}

function packageRootFromMeta(metaUrl) {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), "..");
}

export function getPackageRoot(metaUrl = import.meta.url) {
  return packageRootFromMeta(metaUrl);
}

async function readJsonAbsolute(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function getWrapperVersion(packageRoot) {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = await readJsonAbsolute(packageJsonPath);
  const version = parseOptionalString(packageJson.version);
  if (!version) {
    throw new RuntimeInstallError(
      `wrapper package version missing at ${packageJsonPath}`,
      "invalid_wrapper_package",
    );
  }
  return version;
}

export function getOperatorHome(homeDir = os.homedir()) {
  return path.join(homeDir, ".agenc");
}

export function getWrapperRuntimeHome(homeDir = os.homedir()) {
  return path.join(getOperatorHome(homeDir), "runtime");
}

export function getGeneratedManifestPaths(packageRoot = getPackageRoot()) {
  return {
    manifestPath: path.join(
      packageRoot,
      GENERATED_DIRNAME,
      GENERATED_MANIFEST_BASENAME,
    ),
    signaturePath: path.join(
      packageRoot,
      GENERATED_DIRNAME,
      GENERATED_SIGNATURE_BASENAME,
    ),
    publicKeyPath: path.join(
      packageRoot,
      GENERATED_DIRNAME,
      GENERATED_PUBLIC_KEY_BASENAME,
    ),
    trustPolicyPath: path.join(
      packageRoot,
      GENERATED_DIRNAME,
      GENERATED_TRUST_POLICY_BASENAME,
    ),
  };
}

function resolveManifestSource({
  packageRoot = getPackageRoot(),
  env = process.env,
}) {
  const manifestPathOverride = parseOptionalString(env.AGENC_RUNTIME_MANIFEST_FILE);
  if (manifestPathOverride) {
    const manifestPath = path.resolve(manifestPathOverride);
    return {
      manifestPath,
      signaturePath: path.resolve(
        parseOptionalString(env.AGENC_RUNTIME_SIGNATURE_FILE) ??
          `${manifestPath}.sig`,
      ),
      publicKeyPath: path.resolve(
        parseOptionalString(env.AGENC_RUNTIME_PUBLIC_KEY_FILE) ??
          getGeneratedManifestPaths(packageRoot).publicKeyPath,
      ),
      trustPolicyPath: path.resolve(
        parseOptionalString(env.AGENC_RUNTIME_TRUST_POLICY_FILE) ??
          getGeneratedManifestPaths(packageRoot).trustPolicyPath,
      ),
      description: `local manifest ${manifestPath}`,
      embedded: false,
    };
  }

  const embedded = getGeneratedManifestPaths(packageRoot);
  if (
    existsSync(embedded.manifestPath) &&
    existsSync(embedded.signaturePath) &&
    existsSync(embedded.publicKeyPath) &&
    existsSync(embedded.trustPolicyPath)
  ) {
    return {
      ...embedded,
      description: "embedded package manifest",
      embedded: true,
    };
  }

  return null;
}

function validateManifestShape(manifest, manifestPath) {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new RuntimeInstallError(
      `runtime manifest at ${manifestPath} must be a JSON object`,
      "invalid_manifest",
    );
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new RuntimeInstallError(
      `runtime manifest at ${manifestPath} must include at least one artifact`,
      "invalid_manifest",
    );
  }
  if (typeof manifest.wrapperVersion !== "string" || manifest.wrapperVersion.length === 0) {
    throw new RuntimeInstallError(
      `runtime manifest at ${manifestPath} must declare wrapperVersion`,
      "invalid_manifest",
    );
  }
  if (typeof manifest.keyId !== "string" || manifest.keyId.length === 0) {
    throw new RuntimeInstallError(
      `runtime manifest at ${manifestPath} must declare keyId`,
      "invalid_manifest",
    );
  }
}

function validateTrustPolicyShape(trustPolicy, trustPolicyPath) {
  if (
    typeof trustPolicy !== "object" ||
    trustPolicy === null ||
    Array.isArray(trustPolicy)
  ) {
    throw new RuntimeInstallError(
      `runtime trust policy at ${trustPolicyPath} must be a JSON object`,
      "invalid_trust_policy",
    );
  }
  if (
    typeof trustPolicy.wrapperVersion !== "string" ||
    trustPolicy.wrapperVersion.length === 0
  ) {
    throw new RuntimeInstallError(
      `runtime trust policy at ${trustPolicyPath} must declare wrapperVersion`,
      "invalid_trust_policy",
    );
  }
  if (typeof trustPolicy.keyId !== "string" || trustPolicy.keyId.length === 0) {
    throw new RuntimeInstallError(
      `runtime trust policy at ${trustPolicyPath} must declare keyId`,
      "invalid_trust_policy",
    );
  }
  if (
    !Array.isArray(trustPolicy.revokedManifestDigests) ||
    !Array.isArray(trustPolicy.revokedRuntimeVersions)
  ) {
    throw new RuntimeInstallError(
      `runtime trust policy at ${trustPolicyPath} must declare revokedManifestDigests and revokedRuntimeVersions arrays`,
      "invalid_trust_policy",
    );
  }
}

export async function loadVerifiedManifest(options = {}) {
  const packageRoot = options.packageRoot ?? getPackageRoot();
  const env = options.env ?? process.env;
  const source = resolveManifestSource({ packageRoot, env });
  if (!source) {
    return null;
  }

  const wrapperVersion =
    options.wrapperVersion ?? (await getWrapperVersion(packageRoot));
  const manifestBytes = await readFile(source.manifestPath);
  const manifestDigest = computeSha256(manifestBytes);
  const signatureText = (await readFile(source.signaturePath, "utf8")).trim();
  const publicKeyPem = await readFile(source.publicKeyPath, "utf8");
  const trustPolicy = JSON.parse(await readFile(source.trustPolicyPath, "utf8"));
  validateTrustPolicyShape(trustPolicy, source.trustPolicyPath);

  const signature = Buffer.from(signatureText, "base64");
  const verified = verify(null, manifestBytes, publicKeyPem, signature);
  if (!verified) {
    throw new RuntimeInstallError(
      `runtime manifest signature verification failed for ${source.manifestPath}`,
      "invalid_manifest_signature",
    );
  }

  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  validateManifestShape(manifest, source.manifestPath);

  if (
    manifest.wrapperVersion !== wrapperVersion ||
    trustPolicy.wrapperVersion !== wrapperVersion
  ) {
    throw new RuntimeInstallError(
      `runtime manifest wrapperVersion ${manifest.wrapperVersion} is incompatible with wrapper package ${wrapperVersion}`,
      "incompatible_wrapper_version",
    );
  }
  if (manifest.keyId !== trustPolicy.keyId) {
    throw new RuntimeInstallError(
      `runtime manifest keyId ${manifest.keyId} does not match trust policy keyId ${trustPolicy.keyId}`,
      "unexpected_manifest_key",
    );
  }
  if (trustPolicy.revokedManifestDigests.includes(manifestDigest)) {
    throw new RuntimeInstallError(
      `runtime manifest ${manifestDigest} has been revoked`,
      "revoked_manifest",
    );
  }
  const runtimeVersions = new Set(
    manifest.artifacts
      .map((artifact) => artifact?.runtimeVersion)
      .filter((value) => typeof value === "string"),
  );
  for (const runtimeVersion of runtimeVersions) {
    if (trustPolicy.revokedRuntimeVersions.includes(runtimeVersion)) {
      throw new RuntimeInstallError(
        `runtime version ${runtimeVersion} has been revoked`,
        "revoked_runtime_version",
      );
    }
  }

  return {
    manifest,
    source,
    manifestDigest,
    trustPolicy,
    wrapperVersion,
  };
}

export function selectArtifactEntry(
  manifest,
  {
    platform = process.platform,
    arch = process.arch,
    nodeVersion = process.versions.node,
  } = {},
) {
  const platformArch = toPlatformArch(platform, arch);
  if (!SUPPORTED_PLATFORM_ARCH.has(platformArch)) {
    throw new RuntimeInstallError(
      `unsupported platform ${platformArch}; supported targets: ${Array.from(SUPPORTED_PLATFORM_ARCH).sort().join(", ")}`,
      "unsupported_platform",
    );
  }

  const selected = manifest.artifacts.find(
    (artifact) => artifact.platform === platform && artifact.arch === arch,
  );
  if (!selected) {
    const supported = manifest.artifacts
      .map((artifact) => toPlatformArch(artifact.platform, artifact.arch))
      .sort()
      .join(", ");
    throw new RuntimeInstallError(
      `runtime manifest does not contain an artifact for ${platformArch}; available: ${supported || "none"}`,
      "missing_platform_artifact",
    );
  }
  if (
    typeof selected.nodeRange === "string" &&
    !satisfiesNodeRange(nodeVersion, selected.nodeRange)
  ) {
    throw new RuntimeInstallError(
      `runtime artifact for ${platformArch} requires Node ${selected.nodeRange}; current Node is ${nodeVersion}`,
      "unsupported_node",
    );
  }
  return selected;
}

function getInstallPaths(selectedArtifact, homeDir = os.homedir()) {
  const runtimeHome = getWrapperRuntimeHome(homeDir);
  const releaseDir = path.join(
    runtimeHome,
    "releases",
    selectedArtifact.runtimeVersion,
    toPlatformArch(selectedArtifact.platform, selectedArtifact.arch),
  );
  return {
    runtimeHome,
    releaseDir,
    currentDir: path.join(runtimeHome, "current"),
    statePath: path.join(runtimeHome, "install-state.json"),
    lockPath: path.join(runtimeHome, ".install.lock"),
    tempRoot: path.join(runtimeHome, "tmp"),
  };
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

async function acquireLock(lockPath, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
  const start = Date.now();
  await mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      return await open(lockPath, "wx");
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "EEXIST"
        )
      ) {
        throw error;
      }
      if (Date.now() - start >= timeoutMs) {
        throw new RuntimeInstallError(
          `timed out waiting for runtime install lock at ${lockPath}`,
          "install_lock_timeout",
        );
      }
      await sleep(LOCK_POLL_INTERVAL_MS);
    }
  }
}

async function withInstallLock(lockPath, callback) {
  const handle = await acquireLock(lockPath);
  try {
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

async function downloadArtifact(urlString, destinationPath) {
  const url = new URL(urlString);
  if (url.protocol === "file:") {
    await copyFile(fileURLToPath(url), destinationPath);
    return;
  }
  if (url.protocol !== "https:") {
    throw new RuntimeInstallError(
      `unsupported artifact URL protocol for ${urlString}`,
      "unsupported_artifact_protocol",
    );
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new RuntimeInstallError(
      `failed to download runtime artifact ${urlString}: ${response.status} ${response.statusText}`,
      "artifact_download_failed",
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destinationPath, bytes);
}

function extractTarball(tarballPath, destinationDir) {
  execFileSync("tar", ["-xzf", tarballPath, "-C", destinationDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function getBinPathForArtifact(rootDir, selectedArtifact, binName) {
  const binRelativePath = selectedArtifact?.bins?.[binName];
  if (typeof binRelativePath !== "string" || binRelativePath.length === 0) {
    throw new RuntimeInstallError(
      `runtime artifact does not provide a ${binName} bin`,
      "missing_runtime_bin",
    );
  }
  return path.join(rootDir, binRelativePath);
}

async function installationIsCurrent(installPaths, selectedArtifact) {
  try {
    const metadata = await readJsonIfExists(
      path.join(installPaths.releaseDir, "agenc-runtime-installation.json"),
    );
    if (!metadata) {
      return false;
    }
    if (
      metadata.sha256 !== selectedArtifact.sha256 ||
      metadata.url !== selectedArtifact.url ||
      metadata.runtimeVersion !== selectedArtifact.runtimeVersion
    ) {
      return false;
    }
    const agencBin = getBinPathForArtifact(
      installPaths.releaseDir,
      selectedArtifact,
      "agenc",
    );
    const runtimeBin = getBinPathForArtifact(
      installPaths.releaseDir,
      selectedArtifact,
      "agenc-runtime",
    );
    await stat(agencBin);
    await stat(runtimeBin);
    return true;
  } catch {
    return false;
  }
}

async function ensureCurrentPointer(installPaths) {
  await mkdir(path.dirname(installPaths.currentDir), { recursive: true });
  await rm(installPaths.currentDir, { recursive: true, force: true });
  await symlink(installPaths.releaseDir, installPaths.currentDir, "dir");
}

async function writeInstallState(statePath, payload) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function getStableManagedBinPaths(installPaths, selectedArtifact) {
  return {
    agenc: getBinPathForArtifact(installPaths.currentDir, selectedArtifact, "agenc"),
    "agenc-runtime": getBinPathForArtifact(
      installPaths.currentDir,
      selectedArtifact,
      "agenc-runtime",
    ),
    daemon: getBinPathForArtifact(installPaths.currentDir, selectedArtifact, "daemon"),
    watch: getBinPathForArtifact(installPaths.currentDir, selectedArtifact, "agenc-watch"),
  };
}

async function getDaemonPidInfo(homeDir) {
  const pidPath = path.join(getOperatorHome(homeDir), "daemon.pid");
  const pidInfo = await readJsonIfExists(pidPath);
  if (
    pidInfo &&
    typeof pidInfo.pid === "number" &&
    Number.isInteger(pidInfo.pid) &&
    pidInfo.pid > 0
  ) {
    try {
      process.kill(pidInfo.pid, 0);
      return pidInfo;
    } catch {
      return null;
    }
  }
  return null;
}

export async function ensureRuntimeInstalled(options = {}) {
  const packageRoot = options.packageRoot ?? getPackageRoot();
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const verifiedManifest = await loadVerifiedManifest({ packageRoot, env });
  if (!verifiedManifest) {
    throw new RuntimeInstallError(
      "no embedded or overridden runtime manifest is available; install a prepared agenc package or provide AGENC_RUNTIME_MANIFEST_FILE for local development",
      "missing_manifest",
    );
  }

  const selectedArtifact = selectArtifactEntry(verifiedManifest.manifest, {
    platform: options.platform,
    arch: options.arch,
    nodeVersion: options.nodeVersion,
  });
  const installPaths = getInstallPaths(selectedArtifact, homeDir);
  if (
    !options.force &&
    (await installationIsCurrent(installPaths, selectedArtifact))
  ) {
    await ensureCurrentPointer(installPaths);
    return {
      releaseDir: installPaths.releaseDir,
      currentDir: installPaths.currentDir,
      runtimeHome: installPaths.runtimeHome,
      statePath: installPaths.statePath,
      manifestSource: verifiedManifest.source.description,
      selectedArtifact,
      bins: getStableManagedBinPaths(installPaths, selectedArtifact),
    };
  }

  return withInstallLock(installPaths.lockPath, async () => {
    if (
      !options.force &&
      (await installationIsCurrent(installPaths, selectedArtifact))
    ) {
      await ensureCurrentPointer(installPaths);
      return {
        releaseDir: installPaths.releaseDir,
        currentDir: installPaths.currentDir,
        runtimeHome: installPaths.runtimeHome,
        statePath: installPaths.statePath,
        manifestSource: verifiedManifest.source.description,
        selectedArtifact,
        bins: getStableManagedBinPaths(installPaths, selectedArtifact),
      };
    }

    await mkdir(installPaths.tempRoot, { recursive: true });
    const tempDir = await mkdtemp(path.join(installPaths.tempRoot, "install-"));
    const tarballPath = path.join(tempDir, "runtime.tar.gz");
    const extractDir = path.join(tempDir, "extract");
    await mkdir(extractDir, { recursive: true });

    try {
      await downloadArtifact(selectedArtifact.url, tarballPath);
      const tarballBytes = await readFile(tarballPath);
      const actualSha = computeSha256(tarballBytes);
      if (actualSha !== selectedArtifact.sha256) {
        throw new RuntimeInstallError(
          `runtime artifact checksum mismatch for ${selectedArtifact.url}`,
          "artifact_checksum_mismatch",
        );
      }

      extractTarball(tarballPath, extractDir);
      const installMetadataPath = path.join(
        extractDir,
        "agenc-runtime-installation.json",
      );
      await writeFile(
        installMetadataPath,
        `${JSON.stringify(
          {
            installedAt: new Date().toISOString(),
            runtimeVersion: selectedArtifact.runtimeVersion,
            platform: selectedArtifact.platform,
            arch: selectedArtifact.arch,
            sha256: selectedArtifact.sha256,
            url: selectedArtifact.url,
            bins: selectedArtifact.bins,
            wrapperVersion: verifiedManifest.wrapperVersion,
            manifestDigest: verifiedManifest.manifestDigest,
            keyId: verifiedManifest.manifest.keyId,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await mkdir(path.dirname(installPaths.releaseDir), { recursive: true });
      await rm(installPaths.releaseDir, { recursive: true, force: true });
      await rename(extractDir, installPaths.releaseDir);
      await ensureCurrentPointer(installPaths);
      await writeInstallState(installPaths.statePath, {
        installedAt: new Date().toISOString(),
        manifestSource: verifiedManifest.source.description,
        manifestDigest: verifiedManifest.manifestDigest,
        runtimeVersion: selectedArtifact.runtimeVersion,
        platform: selectedArtifact.platform,
        arch: selectedArtifact.arch,
        releaseDir: installPaths.releaseDir,
        currentDir: installPaths.currentDir,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    return {
      releaseDir: installPaths.releaseDir,
      currentDir: installPaths.currentDir,
      runtimeHome: installPaths.runtimeHome,
      statePath: installPaths.statePath,
      manifestSource: verifiedManifest.source.description,
      selectedArtifact,
      bins: getStableManagedBinPaths(installPaths, selectedArtifact),
    };
  });
}

export async function uninstallRuntime(options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const force = options.force === true;
  const daemonPidInfo = await getDaemonPidInfo(homeDir);
  if (daemonPidInfo && !force) {
    throw new RuntimeInstallError(
      `refusing to uninstall while daemon ${daemonPidInfo.pid} is still running; stop AgenC first or rerun with --force`,
      "daemon_still_running",
    );
  }

  const packageRoot = options.packageRoot ?? getPackageRoot();
  const env = options.env ?? process.env;
  const verifiedManifest = await loadVerifiedManifest({ packageRoot, env }).catch(
    () => null,
  );
  const selectedArtifact = verifiedManifest
    ? selectArtifactEntry(verifiedManifest.manifest, {
        platform: options.platform,
        arch: options.arch,
        nodeVersion: options.nodeVersion,
      })
    : null;

  const runtimeHome = getWrapperRuntimeHome(homeDir);
  const statePath = path.join(runtimeHome, "install-state.json");
  const currentDir = path.join(runtimeHome, "current");
  const installDir = selectedArtifact
    ? getInstallPaths(selectedArtifact, homeDir).releaseDir
    : (await readJsonIfExists(statePath))?.releaseDir;

  if (!installDir) {
    return {
      removed: false,
      runtimeHome,
      releaseDir: null,
      preservedPaths: [getOperatorHome(homeDir)],
    };
  }

  await rm(installDir, { recursive: true, force: true });
  await rm(currentDir, { recursive: true, force: true });
  const state = await readJsonIfExists(statePath);
  if (state && state.releaseDir === installDir) {
    await rm(statePath, { force: true });
  }
  return {
    removed: true,
    runtimeHome,
    releaseDir: installDir,
    preservedPaths: [
      path.join(getOperatorHome(homeDir), "config.json"),
      path.join(getOperatorHome(homeDir), "daemon.pid"),
      path.join(getOperatorHome(homeDir), "replay-events.sqlite"),
      getOperatorHome(homeDir),
    ],
  };
}

export async function describeRuntimeInstall(options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const packageRoot = options.packageRoot ?? getPackageRoot();
  const env = options.env ?? process.env;
  const runtimeHome = getWrapperRuntimeHome(homeDir);
  const statePath = path.join(runtimeHome, "install-state.json");
  const state = await readJsonIfExists(statePath);
  const manifest = await loadVerifiedManifest({ packageRoot, env }).catch(
    () => null,
  );
  const selectedArtifact = manifest
    ? selectArtifactEntry(manifest.manifest, {
        platform: options.platform,
        arch: options.arch,
        nodeVersion: options.nodeVersion,
      })
    : null;

  return {
    runtimeHome,
    currentDir: path.join(runtimeHome, "current"),
    statePath,
    installed: state !== null && typeof state.releaseDir === "string",
    releaseDir: state?.releaseDir ?? null,
    manifestSource: manifest?.source.description ?? null,
    manifestDigest: manifest?.manifestDigest ?? null,
    selectedArtifact,
    trustPolicy: manifest?.trustPolicy ?? null,
  };
}

async function spawnNodeScript(scriptPath, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: "inherit",
      env,
      cwd,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

export async function spawnInstalledRuntimeBin(
  binName,
  args,
  options = {},
) {
  const runtime = await ensureRuntimeInstalled(options);
  const scriptPath = runtime.bins[binName];
  if (!scriptPath) {
    throw new RuntimeInstallError(
      `installed runtime does not expose ${binName}`,
      "missing_runtime_bin",
    );
  }
  const env = {
    ...(options.env ?? process.env),
    AGENC_WRAPPER_ACTIVE: "1",
    AGENC_WRAPPER_RUNTIME_HOME: runtime.runtimeHome,
    AGENC_WRAPPER_RELEASE_DIR: runtime.releaseDir,
    AGENC_WRAPPER_CURRENT_DIR: runtime.currentDir,
    AGENC_DAEMON_ENTRY: runtime.bins.daemon,
    AGENC_WATCH_ENTRY: runtime.bins.watch,
  };
  return spawnNodeScript(scriptPath, args, env, options.cwd);
}

export async function prefetchRuntimeOnInstall(options = {}) {
  const manifest = await loadVerifiedManifest(options);
  if (!manifest) {
    return { prefetched: false, reason: "missing_manifest" };
  }
  await ensureRuntimeInstalled({
    ...options,
    force: false,
  });
  return { prefetched: true };
}

// ---------------------------------------------------------------------------
// Cut 6.1: --from-source dev mode
//
// The published-tarball install path lives above. This block adds a parallel
// path that builds the runtime from a local source checkout and points
// `~/.agenc/runtime/current` at it. Without this, the only way to land
// changes on the running daemon is to publish a new tarball — which is
// exactly the failure mode that left a 2-month silent-failure window in
// place. The dev path is opt-in via `--from-source` and never runs by
// default.
// ---------------------------------------------------------------------------

const FROM_SOURCE_PLATFORM_ARCH = "from-source";

function resolveSourceRoot({
  env = process.env,
  cwd = process.cwd(),
  explicit,
} = {}) {
  const candidates = [];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    candidates.push(path.resolve(explicit.trim()));
  }
  const envValue = env?.AGENC_RUNTIME_SOURCE_DIR;
  if (typeof envValue === "string" && envValue.trim().length > 0) {
    candidates.push(path.resolve(envValue.trim()));
  }
  // Walk upward from cwd looking for `runtime/package.json` whose name is
  // `@tetsuo-ai/runtime` — that's the agenc-core monorepo root.
  let current = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(current, "runtime"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const candidate of candidates) {
    try {
      const pkgPath = path.join(candidate, "package.json");
      const raw = readFileSync(pkgPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.name === "@tetsuo-ai/runtime") {
        return candidate;
      }
    } catch {
      // try next
    }
  }
  return null;
}

async function readJsonSafe(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function runBuildScript(sourceRoot, env) {
  const result = spawn("npm", ["run", "build"], {
    cwd: sourceRoot,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...env },
  });
  return new Promise((resolvePromise, rejectPromise) => {
    result.on("error", rejectPromise);
    result.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(
          new RuntimeInstallError(
            `from-source build failed with exit code ${code}`,
            "from_source_build_failed",
          ),
        );
      }
    });
  });
}

async function readBuildVersion(sourceRoot) {
  const versionPath = path.join(sourceRoot, "dist", "VERSION");
  return await readJsonSafe(versionPath);
}

function buildFromSourceArtifactDescriptor(sourceRoot, packageJson, versionFile) {
  const runtimeVersion =
    typeof packageJson?.version === "string" ? packageJson.version : "0.0.0";
  const distRoot = path.join(sourceRoot, "dist");
  const bins = {
    agenc: "bin/agenc.js",
    "agenc-runtime": "bin/agenc-runtime.js",
    daemon: "bin/daemon.js",
    "agenc-watch": "bin/agenc-watch.js",
  };
  return {
    runtimeVersion,
    platform: FROM_SOURCE_PLATFORM_ARCH,
    arch: "local",
    bins,
    sha256: versionFile?.commit ?? "from-source",
    distRoot,
  };
}

async function ensureFromSourceCurrentPointer({
  homeDir = os.homedir(),
  distRoot,
}) {
  const runtimeHome = getWrapperRuntimeHome(homeDir);
  const releaseDir = path.join(
    runtimeHome,
    "releases",
    "from-source",
    FROM_SOURCE_PLATFORM_ARCH,
  );
  const currentDir = path.join(runtimeHome, "current");
  const statePath = path.join(runtimeHome, "install-state.json");

  await mkdir(path.dirname(releaseDir), { recursive: true });
  await removePathSafe(releaseDir);
  await mkdir(path.dirname(releaseDir), { recursive: true });

  // The release dir is a directory containing a single symlink (`dist`)
  // pointing back at the local source dist. The wrapper's bin paths look
  // for `<releaseDir>/bin/<binName>`, so we lay out the same shape using
  // a symlink for the entire `dist` tree.
  await symlink(distRoot, releaseDir, "dir");

  // Use removePathSafe (lstat-based) so we delete the SYMLINK at
  // `currentDir`, not the target it points at. The previous `rm
  // recursive` call followed the symlink and either failed silently
  // or removed the target dir contents while leaving the link intact,
  // causing the from-source flag to silently keep pointing at a
  // stale release.
  await removePathSafe(currentDir);
  await symlink(releaseDir, currentDir, "dir");

  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        installedAt: new Date().toISOString(),
        manifestSource: "from-source",
        runtimeVersion: path.basename(distRoot),
        platform: FROM_SOURCE_PLATFORM_ARCH,
        arch: "local",
        releaseDir,
        currentDir,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { runtimeHome, releaseDir, currentDir, statePath };
}

export async function ensureRuntimeFromSource(options = {}) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const sourceRoot = resolveSourceRoot({
    env,
    cwd,
    explicit: options.sourceDir,
  });
  if (!sourceRoot) {
    throw new RuntimeInstallError(
      "could not locate the agenc-core runtime source directory; pass --source-dir <path> or set AGENC_RUNTIME_SOURCE_DIR",
      "from_source_root_not_found",
    );
  }
  const distRoot = path.join(sourceRoot, "dist");
  const skipBuild =
    options.skipBuild === true || env?.AGENC_FROM_SOURCE_SKIP_BUILD === "1";

  if (!skipBuild) {
    await runBuildScript(sourceRoot, env);
  }
  if (!existsSync(distRoot)) {
    throw new RuntimeInstallError(
      `from-source build did not produce ${distRoot}`,
      "from_source_dist_missing",
    );
  }

  const packageJson = await readJsonSafe(path.join(sourceRoot, "package.json"));
  const versionFile = await readBuildVersion(sourceRoot);
  const selectedArtifact = buildFromSourceArtifactDescriptor(
    sourceRoot,
    packageJson,
    versionFile,
  );

  const installPaths = await ensureFromSourceCurrentPointer({
    homeDir,
    distRoot,
  });

  return {
    releaseDir: installPaths.releaseDir,
    currentDir: installPaths.currentDir,
    runtimeHome: installPaths.runtimeHome,
    statePath: installPaths.statePath,
    manifestSource: "from-source",
    selectedArtifact,
    fromSource: true,
    sourceRoot,
    versionFile,
    bins: {
      agenc: path.join(installPaths.currentDir, selectedArtifact.bins.agenc),
      "agenc-runtime": path.join(
        installPaths.currentDir,
        selectedArtifact.bins["agenc-runtime"],
      ),
      daemon: path.join(installPaths.currentDir, selectedArtifact.bins.daemon),
      watch: path.join(
        installPaths.currentDir,
        selectedArtifact.bins["agenc-watch"],
      ),
    },
  };
}

export async function spawnInstalledRuntimeBinFromSource(
  binName,
  args,
  options = {},
) {
  const runtime = await ensureRuntimeFromSource(options);
  const scriptPath = runtime.bins[binName];
  if (!scriptPath) {
    throw new RuntimeInstallError(
      `from-source runtime does not expose ${binName}`,
      "missing_runtime_bin",
    );
  }
  const env = {
    ...(options.env ?? process.env),
    AGENC_WRAPPER_ACTIVE: "1",
    AGENC_WRAPPER_RUNTIME_HOME: runtime.runtimeHome,
    AGENC_WRAPPER_RELEASE_DIR: runtime.releaseDir,
    AGENC_WRAPPER_CURRENT_DIR: runtime.currentDir,
    AGENC_WRAPPER_FROM_SOURCE: "1",
    AGENC_WRAPPER_SOURCE_ROOT: runtime.sourceRoot,
    AGENC_DAEMON_ENTRY: runtime.bins.daemon,
    AGENC_WATCH_ENTRY: runtime.bins.watch,
  };
  return spawnNodeScript(scriptPath, args, env, options.cwd);
}
