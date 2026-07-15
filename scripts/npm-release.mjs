#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { list as listTar } from "tar";
import { validateLauncherManifest } from "../packages/agenc/scripts/check-package-ready.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const EXPECTED_REPOSITORY = "git+https://github.com/tetsuo-ai/agenc-core.git";
const RECEIPT_SCHEMA_VERSION = 2;
const MAX_JSON_ENTRY_BYTES = 1024 * 1024;
const MAX_PACKAGE_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES = 512;
const RUNTIME_MANIFEST_PATH = "generated/agenc-runtime-manifest-v2.json";
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";
const REGISTRY_RECEIPT_ATTEMPTS = 8;
const REGISTRY_RECEIPT_RETRY_MS = 2_000;

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function hash(bytes, algorithm, encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function runNpmDefault(args, { cwd = repoRoot, capture = false, allowFailure = false } = {}) {
  const result = spawnSync(npmCommand, args, {
    cwd,
    env: {
      ...process.env,
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
    },
    encoding: capture ? "utf8" : undefined,
    shell: process.platform === "win32",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `npm ${args[0] ?? "command"} failed (${result.status ?? result.signal})` +
        (capture && result.stderr ? `:\n${result.stderr}` : ""),
    );
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    signal: result.signal,
  };
}

function gitDefault(args, { cwd = repoRoot } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function requireFullCommit(value, label) {
  if (!/^[0-9a-f]{40,64}$/.test(value ?? "")) {
    throw new Error(`${label} must be a full hexadecimal Git object id`);
  }
  return value;
}

function exactToolchain(runNpm, cwd, nodeVersion = process.versions.node) {
  const contract = JSON.parse(readFileSync(join(repoRoot, "release-toolchain.json"), "utf8"));
  if (nodeVersion !== contract.nodeVersion) {
    throw new Error(
      `npm release requires Node.js ${contract.nodeVersion}; found ${nodeVersion}`,
    );
  }
  const npmVersion = runNpm(["--version"], { cwd, capture: true }).stdout.trim();
  if (npmVersion !== contract.npmVersion) {
    throw new Error(
      `npm release requires npm ${contract.npmVersion}; found ${npmVersion || "unknown"}`,
    );
  }
  return { nodeVersion: `v${nodeVersion}`, npmVersion };
}

function parsePackOptions(args, cwd) {
  const forwarded = [];
  let workspace;
  let destination = ".";
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--silent" || value === "--silent=true") {
      forwarded.push(value);
      continue;
    }
    if (value === "--workspace" || value === "-w") {
      if (workspace !== undefined) throw new Error("npm release pack accepts one workspace");
      const next = args[index + 1];
      if (!next || next.startsWith("-")) throw new Error(`${value} requires a value`);
      workspace = next;
      index += 1;
      continue;
    }
    if (value.startsWith("--workspace=")) {
      if (workspace !== undefined) throw new Error("npm release pack accepts one workspace");
      workspace = value.slice("--workspace=".length);
      continue;
    }
    if (value === "--pack-destination") {
      const next = args[index + 1];
      if (!next || next.startsWith("-")) throw new Error("--pack-destination requires a value");
      destination = next;
      index += 1;
      continue;
    }
    if (value.startsWith("--pack-destination=")) {
      destination = value.slice("--pack-destination=".length);
      continue;
    }
    throw new Error(`unsupported npm release pack option: ${value}`);
  }
  if (workspace !== undefined && workspace !== "@tetsuo-ai/agenc") {
    throw new Error(`npm release pack refuses workspace ${workspace}`);
  }
  if (workspace !== undefined) forwarded.push(`--workspace=${workspace}`);
  return { forwarded, workspace, destination: resolve(cwd, destination) };
}

function canonicalPayloadPath(value, label = "package payload path") {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") ||
      value.startsWith("./") || /[\\\0\r\n]/.test(value) ||
      value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${label} is not canonical: ${String(value)}`);
  }
  return value;
}

async function readCompleteArchive(archivePath) {
  const entries = new Map();
  const collisionPaths = new Map();
  const pending = [];
  let totalBytes = 0;
  await listTar({
    file: archivePath,
    strict: true,
    onReadEntry(entry) {
      if (entry.type !== "File" || !entry.path.startsWith("package/")) {
        entry.resume();
        throw new Error(`unsupported npm tarball member: ${entry.path}`);
      }
      const path = canonicalPayloadPath(entry.path.slice("package/".length), "npm tarball path");
      const collisionKey = path.normalize("NFC").toLowerCase();
      const prior = collisionPaths.get(collisionKey);
      if (prior !== undefined) {
        entry.resume();
        throw new Error(`duplicate or portable-colliding npm tarball path: ${prior} and ${path}`);
      }
      collisionPaths.set(collisionKey, path);
      if (entries.size >= MAX_PACKAGE_ENTRIES || !Number.isSafeInteger(entry.size) ||
          entry.size < 1 || entry.size > MAX_PACKAGE_ENTRY_BYTES ||
          totalBytes + entry.size > MAX_PACKAGE_BYTES) {
        entry.resume();
        throw new Error(`invalid or oversized npm tarball member: ${entry.path}`);
      }
      totalBytes += entry.size;
      entries.set(path, undefined);
      const chunks = [];
      let bytes = 0;
      pending.push(new Promise((resolveEntry, rejectEntry) => {
        entry.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > entry.size || bytes > MAX_PACKAGE_ENTRY_BYTES) {
            rejectEntry(new Error(`${entry.path} exceeds its declared size`));
            entry.resume();
            return;
          }
          chunks.push(chunk);
        });
        entry.on("error", rejectEntry);
        entry.on("end", () => {
          const value = Buffer.concat(chunks);
          if (value.length !== entry.size) {
            rejectEntry(new Error(`${entry.path} did not match its declared size`));
            return;
          }
          const mode = Number(entry.mode) & 0o777;
          if (mode !== 0o644 && mode !== 0o755) {
            rejectEntry(new Error(`${entry.path} has noncanonical mode ${mode.toString(8)}`));
            return;
          }
          entries.set(path, { bytes: value, mode });
          resolveEntry();
        });
      }));
    },
  });
  await Promise.all(pending);
  return entries;
}

function readArchiveJsonEntries(entries, requiredPaths) {
  const parsed = new Map();
  for (const path of requiredPaths) {
    const entry = entries.get(path);
    if (entry === undefined || entry.bytes.length > MAX_JSON_ENTRY_BYTES) {
      throw new Error(`npm tarball is missing or has an oversized ${path}`);
    }
    try {
      parsed.set(path, { bytes: entry.bytes, value: JSON.parse(entry.bytes.toString("utf8")) });
    } catch {
      throw new Error(`npm tarball contains invalid JSON at ${path}`);
    }
  }
  return parsed;
}

function packageRootForArgs(cwd, workspace) {
  return workspace === undefined ? resolve(cwd) : resolve(cwd, "packages", "agenc");
}

function payloadSnapshot(packageRoot, { overlays = new Map() } = {}) {
  const packagePath = join(packageRoot, "package.json");
  const packageBytes = readFileSync(packagePath);
  const pkg = JSON.parse(packageBytes.toString("utf8"));
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    throw new Error("launcher package requires an explicit files allowlist");
  }
  const bins = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
  const executable = new Set();
  for (const value of Object.values(bins)) {
    const path = canonicalPayloadPath(String(value).replace(/^\.\//, ""), "launcher bin path");
    executable.add(path);
  }
  const paths = new Set(["package.json"]);
  for (const value of pkg.files) {
    const path = canonicalPayloadPath(value, "launcher files entry");
    if (/[*?![\]{}]/.test(path)) throw new Error(`launcher files entry is not literal: ${path}`);
    paths.add(path);
  }
  if (typeof pkg.main === "string") paths.add(canonicalPayloadPath(pkg.main.replace(/^\.\//, "")));
  for (const path of executable) paths.add(path);
  for (const name of readdirSync(packageRoot)) {
    if (/^(readme|license|licence|changelog)(?:\..*)?$/i.test(name)) paths.add(name);
  }
  const entries = new Map();
  const collisionPaths = new Map();
  for (const path of [...paths].sort(utf8Compare)) {
    const collisionKey = path.normalize("NFC").toLowerCase();
    const prior = collisionPaths.get(collisionKey);
    if (prior !== undefined) throw new Error(`portable-colliding launcher payload paths: ${prior} and ${path}`);
    collisionPaths.set(collisionKey, path);
    const overlay = overlays.get(path);
    let bytes;
    if (overlay !== undefined) {
      bytes = Buffer.from(overlay.bytes);
    } else {
      const sourcePath = join(packageRoot, ...path.split("/"));
      const metadata = lstatSync(sourcePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`launcher payload entry must be a regular file: ${path}`);
      }
      bytes = readFileSync(sourcePath);
    }
    entries.set(path, { bytes, mode: executable.has(path) ? 0o755 : 0o644 });
  }
  return { pkg, entries };
}

function assertPayloadMatches(actual, expected, label) {
  const actualPaths = [...actual.keys()].sort(utf8Compare);
  const expectedPaths = [...expected.keys()].sort(utf8Compare);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`${label} member inventory differs from the exact source payload`);
  }
  for (const path of expectedPaths) {
    const left = actual.get(path);
    const right = expected.get(path);
    if (left.mode !== right.mode || !left.bytes.equals(right.bytes)) {
      throw new Error(`${label} differs from exact source at ${path}`);
    }
  }
}

function payloadInventory(entries) {
  return [...entries.entries()].sort(([left], [right]) => utf8Compare(left, right)).map(
    ([path, entry]) => ({
      path,
      mode: entry.mode,
      bytes: entry.bytes.length,
      sha256: hash(entry.bytes, "sha256"),
    }),
  );
}

function assertPayloadTracking({ entries, packageRoot, cwd, git }) {
  const checkoutRoot = resolve(cwd);
  for (const path of entries.keys()) {
    const sourcePath = join(packageRoot, ...path.split("/"));
    const repositoryPath = relative(checkoutRoot, sourcePath).split(sep).join("/");
    if (
      repositoryPath === "" || repositoryPath === ".." ||
      repositoryPath.startsWith("../")
    ) {
      throw new Error(`launcher payload is outside the exact checkout: ${path}`);
    }
    const listed = git(["ls-files", "--", repositoryPath], { cwd });
    if (path === RUNTIME_MANIFEST_PATH) {
      if (listed !== "") {
        throw new Error("generated runtime manifest must remain an explicit untracked release overlay");
      }
    } else if (listed !== repositoryPath) {
      throw new Error(`launcher payload is not tracked at the exact source commit: ${path}`);
    }
  }
}

function assertNpmFileManifest(result, expected) {
  if (!Array.isArray(result.files) || result.entryCount !== expected.size) {
    throw new Error("npm pack file manifest is incomplete");
  }
  const files = new Map(result.files.map((entry) => [entry.path, entry]));
  if (files.size !== result.files.length) throw new Error("npm pack file manifest has duplicates");
  for (const [path, entry] of expected) {
    const metadata = files.get(path);
    if (metadata?.size !== entry.bytes.length || (metadata.mode & 0o777) !== entry.mode) {
      throw new Error(`npm pack file manifest differs from exact source at ${path}`);
    }
  }
  const unpackedSize = [...expected.values()].reduce((total, entry) => total + entry.bytes.length, 0);
  if (result.unpackedSize !== unpackedSize || files.size !== expected.size) {
    throw new Error("npm pack unpacked size or inventory differs from exact source");
  }
}

function assertExactTaggedSource({ cwd, git, version }) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    throw new Error("npm release packing requires a stable X.Y.Z version");
  }
  const head = requireFullCommit(git(["rev-parse", "HEAD"], { cwd }), "checkout commit");
  const ref = `refs/tags/agenc-v${version}`;
  const tagged = requireFullCommit(
    git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd }),
    "release tag commit",
  );
  if (head !== tagged) throw new Error(`npm release checkout does not match ${ref}`);
  const explicit = process.env.AGENC_BUILD_COMMIT?.trim();
  if (explicit !== undefined && requireFullCommit(explicit, "AGENC_BUILD_COMMIT") !== head) {
    throw new Error("AGENC_BUILD_COMMIT does not match the exact checkout commit");
  }
  const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd });
  if (status.length !== 0) throw new Error("npm release packing requires a clean tagged checkout");
  const tree = requireFullCommit(git(["rev-parse", "HEAD^{tree}"], { cwd }), "source tree");
  return { commit: head, ref, tree };
}

function assertPackageIdentity(pkg) {
  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg) ||
      typeof pkg.name !== "string" || !/^@?[A-Za-z0-9._/-]+$/.test(pkg.name) ||
      typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    throw new Error("npm tarball has an invalid package name/version");
  }
  return { name: pkg.name, version: pkg.version };
}

function writeReceiptAtomic(path, receipt) {
  if (existsSync(path)) throw new Error(`refusing to replace existing release receipt: ${path}`);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o644);
    writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    if (process.platform !== "win32") {
      const parentDescriptor = openSync(dirname(path), "r");
      try {
        fsyncSync(parentDescriptor);
      } finally {
        closeSync(parentDescriptor);
      }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function parsePackJson(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(`npm pack did not emit valid JSON: ${stdout.slice(0, 500)}`);
  }
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("npm release pack must produce exactly one tarball");
  }
  return value[0];
}

export async function packRelease({
  args = [],
  cwd = process.cwd(),
  runNpm = runNpmDefault,
  git = gitDefault,
  nodeVersion = process.versions.node,
  lockfilePath = join(repoRoot, "package-lock.json"),
  validateManifest = validateLauncherManifest,
} = {}) {
  const packOptions = parsePackOptions(args, cwd);
  const toolchain = exactToolchain(runNpm, cwd, nodeVersion);
  const packageRoot = packageRootForArgs(cwd, packOptions.workspace);
  const sourcePayload = payloadSnapshot(packageRoot);
  assertPayloadTracking({ entries: sourcePayload.entries, packageRoot, cwd, git });
  const packageIdentity = assertPackageIdentity(sourcePayload.pkg);
  if (packageIdentity.name !== "@tetsuo-ai/agenc") {
    throw new Error(`npm release pack refuses package ${packageIdentity.name}`);
  }
  validateManifest({
    launcherPackagePath: join(packageRoot, "package.json"),
    manifestPath: join(packageRoot, RUNTIME_MANIFEST_PATH),
  });
  const source = assertExactTaggedSource({ cwd, git, version: packageIdentity.version });
  const preflight = parsePackJson(runNpm([
    "pack",
    ...packOptions.forwarded,
    "--dry-run",
    "--ignore-scripts",
    "--json",
  ], { cwd, capture: true }).stdout.trim());
  if (typeof preflight.filename !== "string" || basename(preflight.filename) !== preflight.filename ||
      !preflight.filename.endsWith(".tgz")) {
    throw new Error("npm pack reported an unsafe tarball filename");
  }
  if (preflight.name !== packageIdentity.name || preflight.version !== packageIdentity.version) {
    throw new Error("npm pack preflight identity does not match exact source");
  }
  assertNpmFileManifest(preflight, sourcePayload.entries);
  if (!existsSync(packOptions.destination)) {
    throw new Error(`npm pack destination does not exist: ${packOptions.destination}`);
  }
  const destinationMetadata = lstatSync(packOptions.destination);
  if (!destinationMetadata.isDirectory() || destinationMetadata.isSymbolicLink()) {
    throw new Error(`npm pack destination must be a plain directory: ${packOptions.destination}`);
  }
  const artifactPath = join(packOptions.destination, preflight.filename);
  const receiptPath = `${artifactPath}.release.json`;
  if (existsSync(artifactPath) || existsSync(receiptPath)) {
    throw new Error("refusing to replace an existing npm release artifact or receipt");
  }
  const temporaryRoot = mkdtempSync(join(packOptions.destination, ".agenc-pack-"));
  let copiedArtifact = false;
  try {
    const result = parsePackJson(runNpm([
      "pack",
      ...packOptions.forwarded,
      "--pack-destination",
      temporaryRoot,
      "--json",
    ], { cwd, capture: true }).stdout.trim());
    if (result.filename !== preflight.filename || result.name !== packageIdentity.name ||
        result.version !== packageIdentity.version) {
      throw new Error("npm pack result drifted from the source-bound preflight");
    }
    assertNpmFileManifest(result, sourcePayload.entries);
    const temporaryArtifact = join(temporaryRoot, result.filename);
    const metadata = lstatSync(temporaryArtifact);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`npm pack output is not a regular file: ${temporaryArtifact}`);
    }
    const bytes = readFileSync(temporaryArtifact);
    const archiveEntries = await readCompleteArchive(temporaryArtifact);
    assertPayloadMatches(archiveEntries, sourcePayload.entries, "npm tarball");
    const currentPayload = payloadSnapshot(packageRoot);
    assertPayloadMatches(currentPayload.entries, sourcePayload.entries, "post-lifecycle source payload");
    const sourceAfter = assertExactTaggedSource({ cwd, git, version: packageIdentity.version });
    if (JSON.stringify(sourceAfter) !== JSON.stringify(source)) {
      throw new Error("npm release source identity changed while packing");
    }
    const sha1 = hash(bytes, "sha1");
    const sha512Base64 = hash(bytes, "sha512", "base64");
    if (result.size !== bytes.length || result.shasum !== sha1 ||
        result.integrity !== `sha512-${sha512Base64}`) {
      throw new Error("npm pack metadata does not match the exact tarball bytes");
    }
    const packageEntry = archiveEntries.get("package.json");
    const runtimeManifestEntry = archiveEntries.get(RUNTIME_MANIFEST_PATH);
    if (packageEntry === undefined || runtimeManifestEntry === undefined) {
      throw new Error("npm tarball is missing a required source-bound manifest");
    }
    const inventory = payloadInventory(archiveEntries);
    const receipt = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      artifact: result.filename,
      bytes: bytes.length,
      hashes: {
        sha256: hash(bytes, "sha256"),
        sha512: hash(bytes, "sha512"),
      },
      integrity: `sha512-${sha512Base64}`,
      package: packageIdentity,
      packageManifestSha256: hash(packageEntry.bytes, "sha256"),
      runtimeManifestSha256: hash(runtimeManifestEntry.bytes, "sha256"),
      payload: {
        entryCount: archiveEntries.size,
        inventorySha256: hash(Buffer.from(JSON.stringify(inventory)), "sha256"),
      },
      source: {
        ...source,
        lockfileSha256: hash(readFileSync(lockfilePath), "sha256"),
      },
      toolchain,
    };
    copyFileSync(temporaryArtifact, artifactPath, fsConstants.COPYFILE_EXCL);
    copiedArtifact = true;
    writeReceiptAtomic(receiptPath, receipt);
    return { artifactPath, filename: result.filename, receiptPath, receipt };
  } catch (error) {
    if (copiedArtifact) rmSync(artifactPath, { force: true });
    throw error;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function parsePublishOptions(args) {
  const forwarded = [];
  let tag;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--dry-run") {
      forwarded.push(value);
      continue;
    }
    if (value === "--tag" || value === "--otp") {
      const next = args[index + 1];
      if (!next || next.startsWith("-")) throw new Error(`${value} requires a value`);
      if (/\r|\n/.test(next)) throw new Error(`${value} contains invalid characters`);
      if (value === "--tag") {
        if (tag !== undefined) throw new Error("npm release publish accepts one dist-tag");
        if (next !== "latest") {
          throw new Error("stable launcher publication requires the latest dist-tag");
        }
        tag = next;
        forwarded.push("--tag=latest");
      } else {
        forwarded.push(value, next);
      }
      index += 1;
      continue;
    }
    if (/^--(?:tag|otp)=[^\r\n]+$/.test(value)) {
      if (value.startsWith("--tag=")) {
        if (tag !== undefined) throw new Error("npm release publish accepts one dist-tag");
        tag = value.slice("--tag=".length);
        if (tag !== "latest") {
          throw new Error("stable launcher publication requires the latest dist-tag");
        }
        forwarded.push("--tag=latest");
      } else {
        forwarded.push(value);
      }
      continue;
    }
    throw new Error(`unsupported npm publish option: ${value}`);
  }
  if (tag === undefined) forwarded.push("--tag=latest");
  return forwarded;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function canonicalRegistryTarball(identity) {
  const leaf = identity.name.includes("/")
    ? identity.name.slice(identity.name.lastIndexOf("/") + 1)
    : identity.name;
  return `${PUBLIC_REGISTRY}${identity.name}/-/${leaf}-${identity.version}.tgz`;
}

function canonicalAttestationUrl(identity) {
  return `${PUBLIC_REGISTRY}-/npm/v1/attestations/${identity.name}@${identity.version}`;
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${label} was not valid JSON`);
  }
}

function parseRegistryReceipt(dist, identity, bytes, receipt) {
  const expectedSha1 = hash(bytes, "sha1");
  const expectedTarball = canonicalRegistryTarball(identity);
  if (dist === null || typeof dist !== "object" || Array.isArray(dist) ||
      dist.shasum !== expectedSha1 || dist.integrity !== receipt.integrity ||
      dist.tarball !== expectedTarball ||
      dist.attestations?.url !== canonicalAttestationUrl(identity) ||
      dist.attestations?.provenance?.predicateType !== "https://slsa.dev/provenance/v1") {
    throw new Error(
      "npm registry receipt/provenance does not match the reviewed tarball bytes and identity",
    );
  }
  return {
    shasum: dist.shasum,
    integrity: dist.integrity,
    tarball: dist.tarball,
    attestationUrl: dist.attestations.url,
    predicateType: dist.attestations.provenance.predicateType,
  };
}

function queryRegistryReceipt({ identity, bytes, receipt, cwd, runNpm }) {
  const result = runNpm([
    "view",
    `${identity.name}@${identity.version}`,
    "dist",
    "--json",
    `--registry=${PUBLIC_REGISTRY}`,
  ], { cwd, capture: true, allowFailure: true });
  const parsed = parseJson(result.stdout.trim(), "npm registry response");
  if (result.status !== 0) {
    if (parsed?.error?.code === "E404") return undefined;
    throw new Error(
      `npm registry lookup failed (${result.status ?? result.signal ?? "unknown"}): ` +
        `${parsed?.error?.summary ?? result.stderr?.trim() ?? "unknown error"}`,
    );
  }
  return parseRegistryReceipt(parsed, identity, bytes, receipt);
}

async function verifyRegistryReceipt({
  identity,
  bytes,
  receipt,
  cwd,
  runNpm,
  wait = delay,
  attempts = REGISTRY_RECEIPT_ATTEMPTS,
} = {}) {
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new TypeError("registry receipt attempts must be a positive safe integer");
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const published = queryRegistryReceipt({ identity, bytes, receipt, cwd, runNpm });
      if (published !== undefined) return published;
      throw new Error(`${identity.name}@${identity.version} is not yet visible`);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(REGISTRY_RECEIPT_RETRY_MS);
    }
  }
  throw new Error(
    `npm publish completed but the registry receipt could not be verified after ${attempts} attempts: ` +
      `${lastError?.message ?? lastError}`,
  );
}

async function verifyLatestDistTag({
  identity,
  cwd,
  runNpm,
  wait = delay,
  attempts = REGISTRY_RECEIPT_ATTEMPTS,
} = {}) {
  let observed = "unavailable";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = runNpm([
      "view",
      identity.name,
      "dist-tags",
      "--json",
      `--registry=${PUBLIC_REGISTRY}`,
    ], { cwd, capture: true, allowFailure: true });
    try {
      const tags = parseJson(result.stdout.trim(), "npm dist-tag response");
      observed = typeof tags?.latest === "string" ? tags.latest : "missing";
      if (result.status === 0 && observed === identity.version) {
        return { latest: observed };
      }
    } catch (error) {
      observed = error.message;
    }
    if (attempt < attempts) await wait(REGISTRY_RECEIPT_RETRY_MS);
  }
  throw new Error(
    `npm latest dist-tag is ${observed}, expected ${identity.version}; ` +
      `an operator must reconcile ${identity.name}@${identity.version} to latest`,
  );
}

function verifyRegistrySignatures({ identity, cwd, runNpm }) {
  const work = mkdtempSync(join(tmpdir(), "agenc-npm-provenance-"));
  try {
    writeFileSync(join(work, "package.json"), `${JSON.stringify({
      name: "agenc-release-provenance-verifier",
      version: "1.0.0",
      private: true,
    })}\n`, { mode: 0o600 });
    runNpm([
      "install",
      "--save-exact",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `--registry=${PUBLIC_REGISTRY}`,
      `${identity.name}@${identity.version}`,
    ], { cwd: work, capture: true });
    const result = runNpm([
      "audit",
      "signatures",
      "--json",
      `--registry=${PUBLIC_REGISTRY}`,
    ], { cwd: work, capture: true });
    const audit = parseJson(result.stdout.trim(), "npm signature audit response");
    if (!Array.isArray(audit?.invalid) || audit.invalid.length !== 0 ||
        !Array.isArray(audit?.missing) || audit.missing.length !== 0) {
      throw new Error("npm signature/provenance audit did not verify every registry artifact");
    }
    return { invalid: 0, missing: 0 };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function validateReceipt(
  receipt,
  artifactName,
  bytes,
  archiveEntries,
  packageEntry,
  manifestEntry,
) {
  const identity = assertPackageIdentity(packageEntry.value);
  const inventory = payloadInventory(archiveEntries);
  if (receipt?.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
      receipt.artifact !== artifactName || receipt.bytes !== bytes.length ||
      receipt.hashes?.sha256 !== hash(bytes, "sha256") ||
      receipt.hashes?.sha512 !== hash(bytes, "sha512") ||
      receipt.integrity !== `sha512-${hash(bytes, "sha512", "base64")}` ||
      receipt.package?.name !== identity.name || receipt.package?.version !== identity.version ||
      receipt.packageManifestSha256 !== hash(packageEntry.bytes, "sha256") ||
      receipt.runtimeManifestSha256 !== hash(manifestEntry.bytes, "sha256") ||
      receipt.payload?.entryCount !== archiveEntries.size ||
      receipt.payload?.inventorySha256 !== hash(Buffer.from(JSON.stringify(inventory)), "sha256") ||
      !/^[0-9a-f]{64}$/.test(receipt.source?.lockfileSha256 ?? "") ||
      !/^[0-9a-f]{40,64}$/.test(receipt.source?.commit ?? "") ||
      !/^[0-9a-f]{40,64}$/.test(receipt.source?.tree ?? "") ||
      receipt.source?.ref !== `refs/tags/agenc-v${identity.version}`) {
    throw new Error("npm release receipt does not match the exact tarball bytes and identity");
  }
  if (identity.name !== "@tetsuo-ai/agenc") {
    throw new Error(`public release wrapper only publishes @tetsuo-ai/agenc, not ${identity.name}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(identity.version)) {
    throw new Error("public launcher publication requires a stable X.Y.Z version");
  }
  const repository = packageEntry.value.repository;
  const repositoryUrl = typeof repository === "string" ? repository : repository?.url;
  const repositoryDirectory = typeof repository === "object" ? repository?.directory : undefined;
  if (repositoryUrl !== EXPECTED_REPOSITORY || repositoryDirectory !== "packages/agenc") {
    throw new Error("launcher package repository metadata is missing or detached from agenc-core");
  }
  const manifest = manifestEntry.value;
  if (manifest?.manifestVersion !== 2 ||
      manifest.runtimeVersion !== identity.version ||
      manifest.releaseRepository !== "tetsuo-ai/agenc-releases" ||
      manifest.releaseTag !== `agenc-v${identity.version}` ||
      manifest.build?.sourceCommit !== receipt.source.commit ||
      !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 5) {
    throw new Error("launcher release manifest is not bound to the package/source receipt");
  }
  const expectedPlatforms = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win-x64",
  ];
  const seen = new Set();
  for (const artifact of manifest.artifacts) {
    const key = `${artifact?.platform}-${artifact?.arch}`;
    const artifactName =
      `agenc-runtime-${identity.version}-${key}-node${artifact?.nodeMajor}` +
      `-abi${artifact?.nodeModuleAbi}.tar.gz`;
    const expectedUrl =
      `https://github.com/tetsuo-ai/agenc-releases/releases/download/` +
      `agenc-v${identity.version}/${artifactName}`;
    if (
      !expectedPlatforms.includes(key) ||
      seen.has(key) ||
      artifact.runtimeVersion !== identity.version ||
      !Number.isSafeInteger(artifact.nodeMajor) ||
      !/^\d+$/.test(artifact.nodeModuleAbi ?? "") ||
      !/^\d+$/.test(artifact.nodeApiVersion ?? "") ||
      artifact.url !== expectedUrl ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "") ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      artifact.bytes > 256 * 1024 * 1024 ||
      artifact.bins?.agenc !== "node_modules/@tetsuo-ai/runtime/bin/agenc"
    ) {
      throw new Error(`launcher release manifest artifact is invalid or duplicated: ${key}`);
    }
    seen.add(key);
  }
  if (JSON.stringify([...seen].sort(utf8Compare)) !== JSON.stringify(expectedPlatforms)) {
    throw new Error("launcher release manifest platform matrix is incomplete");
  }
  return identity;
}

async function inspectRelease({
  tarball,
  receiptPath,
  cwd = process.cwd(),
  runNpm = runNpmDefault,
  git = gitDefault,
  nodeVersion = process.versions.node,
  lockfilePath = join(repoRoot, "package-lock.json"),
  packageRoot: suppliedPackageRoot,
  validateManifest = validateLauncherManifest,
} = {}) {
  if (typeof tarball !== "string" || !tarball.endsWith(".tgz")) {
    throw new Error("release verification requires an explicit prebuilt .tgz path");
  }
  const artifactPath = resolve(cwd, tarball);
  const artifactMetadata = lstatSync(artifactPath);
  if (!artifactMetadata.isFile() || artifactMetadata.isSymbolicLink()) {
    throw new Error("publish tarball must be a non-symlink regular file");
  }
  const resolvedReceipt = resolve(cwd, receiptPath ?? `${tarball}.release.json`);
  const receiptMetadata = lstatSync(resolvedReceipt);
  if (!receiptMetadata.isFile() || receiptMetadata.isSymbolicLink()) {
    throw new Error("release receipt must be a non-symlink regular file");
  }
  const toolchain = exactToolchain(runNpm, cwd, nodeVersion);
  const bytes = readFileSync(artifactPath);
  const snapshotRoot = mkdtempSync(join(tmpdir(), "agenc-npm-publish-"));
  try {
    const snapshot = join(snapshotRoot, basename(artifactPath));
    writeFileSync(snapshot, bytes, { mode: 0o600, flag: "wx" });
    const archiveEntries = await readCompleteArchive(snapshot);
    const archive = readArchiveJsonEntries(archiveEntries, [
      "package.json",
      RUNTIME_MANIFEST_PATH,
    ]);
    const embeddedPackagePath = join(snapshotRoot, "package.json");
    const embeddedManifestPath = join(snapshotRoot, RUNTIME_MANIFEST_PATH);
    mkdirSync(dirname(embeddedManifestPath), { recursive: true, mode: 0o700 });
    writeFileSync(embeddedPackagePath, archive.get("package.json").bytes, {
      mode: 0o600,
      flag: "wx",
    });
    writeFileSync(embeddedManifestPath, archive.get(RUNTIME_MANIFEST_PATH).bytes, {
      mode: 0o600,
      flag: "wx",
    });
    validateManifest({
      launcherPackagePath: embeddedPackagePath,
      manifestPath: embeddedManifestPath,
    });
    const receipt = JSON.parse(readFileSync(resolvedReceipt, "utf8"));
    const identity = validateReceipt(
      receipt,
      basename(artifactPath),
      bytes,
      archiveEntries,
      archive.get("package.json"),
      archive.get(RUNTIME_MANIFEST_PATH),
    );
    if (receipt.toolchain?.nodeVersion !== toolchain.nodeVersion ||
        receipt.toolchain?.npmVersion !== toolchain.npmVersion ||
        receipt.source.lockfileSha256 !== hash(readFileSync(lockfilePath), "sha256")) {
      throw new Error("npm release receipt does not match the checkout/toolchain");
    }
    const source = assertExactTaggedSource({ cwd, git, version: identity.version });
    if (JSON.stringify(source) !== JSON.stringify({
      commit: receipt.source.commit,
      ref: receipt.source.ref,
      tree: receipt.source.tree,
    })) {
      throw new Error("release tag, checkout, tree, and receipt source identity differ");
    }
    const packageRoot = suppliedPackageRoot ?? (
      existsSync(join(cwd, "packages", "agenc", "package.json"))
        ? join(cwd, "packages", "agenc")
        : cwd
    );
    const expectedPayload = payloadSnapshot(packageRoot, {
      overlays: new Map([[RUNTIME_MANIFEST_PATH, archiveEntries.get(RUNTIME_MANIFEST_PATH)]]),
    });
    assertPayloadTracking({ entries: expectedPayload.entries, packageRoot, cwd, git });
    assertPayloadMatches(archiveEntries, expectedPayload.entries, "reviewed npm tarball");
    return {
      artifactPath,
      receiptPath: resolvedReceipt,
      identity,
      head: source.commit,
      receipt,
      bytes,
      snapshot,
      snapshotRoot,
    };
  } catch (error) {
    rmSync(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyRelease(options = {}) {
  const inspected = await inspectRelease(options);
  try {
    return {
      artifactPath: inspected.artifactPath,
      receiptPath: inspected.receiptPath,
      package: inspected.identity,
      sourceCommit: inspected.head,
      bytes: inspected.bytes.length,
      sha256: hash(inspected.bytes, "sha256"),
      integrity: inspected.receipt.integrity,
    };
  } finally {
    rmSync(inspected.snapshotRoot, { recursive: true, force: true });
  }
}

export async function publishRelease({
  args = [],
  waitForRegistry = delay,
  registryReceiptAttempts = REGISTRY_RECEIPT_ATTEMPTS,
  ...inspectionOptions
} = {}) {
  const publishOptions = parsePublishOptions(args);
  const inspected = await inspectRelease(inspectionOptions);
  const { identity, bytes, receipt, snapshot, head, artifactPath, receiptPath } = inspected;
  const { cwd = process.cwd(), runNpm = runNpmDefault } = inspectionOptions;
  try {
    const publishArgs = [
      "publish",
      snapshot,
      "--provenance",
      "--access=public",
      `--registry=${PUBLIC_REGISTRY}`,
      "--ignore-scripts",
      ...publishOptions,
    ];
    if (publishOptions.includes("--dry-run")) {
      runNpm(publishArgs, { cwd, capture: false });
      return {
        artifactPath,
        receiptPath,
        package: identity,
        sourceCommit: head,
        published: false,
        alreadyPublished: false,
      };
    }

    const existing = queryRegistryReceipt({ identity, bytes, receipt, cwd, runNpm });
    if (existing !== undefined) {
      const distTags = await verifyLatestDistTag({
        identity,
        cwd,
        runNpm,
        wait: waitForRegistry,
        attempts: registryReceiptAttempts,
      });
      const signatureAudit = verifyRegistrySignatures({ identity, cwd, runNpm });
      return {
        artifactPath,
        receiptPath,
        package: identity,
        sourceCommit: head,
        registryReceipt: existing,
        distTags,
        signatureAudit,
        published: false,
        alreadyPublished: true,
      };
    }

    let publishError;
    try {
      runNpm(publishArgs, { cwd, capture: false });
    } catch (error) {
      publishError = error;
    }
    let registryReceipt;
    try {
      registryReceipt = await verifyRegistryReceipt({
        identity,
        bytes,
        receipt,
        cwd,
        runNpm,
        wait: waitForRegistry,
        attempts: registryReceiptAttempts,
      });
    } catch (verificationError) {
      if (publishError !== undefined) {
        throw new AggregateError(
          [publishError, verificationError],
          "npm publish failed and no matching immutable registry receipt appeared",
        );
      }
      throw verificationError;
    }
    const signatureAudit = verifyRegistrySignatures({ identity, cwd, runNpm });
    const distTags = await verifyLatestDistTag({
      identity,
      cwd,
      runNpm,
      wait: waitForRegistry,
      attempts: registryReceiptAttempts,
    });
    return {
      artifactPath,
      receiptPath,
      package: identity,
      sourceCommit: head,
      registryReceipt,
      distTags,
      signatureAudit,
      published: publishError === undefined,
      alreadyPublished: publishError !== undefined,
      recoveredAfterPublishFailure: publishError !== undefined,
    };
  } finally {
    rmSync(inspected.snapshotRoot, { recursive: true, force: true });
  }
}

function usage() {
  return "usage:\n" +
    "  node scripts/npm-release.mjs pack [npm pack options]\n" +
    "  node scripts/npm-release.mjs verify <reviewed.tgz>\n" +
    "  node scripts/npm-release.mjs publish <reviewed.tgz> [--tag=latest] [--dry-run] [--otp OTP]";
}

async function main(argv) {
  const [command, ...args] = argv;
  // npm's tar writer applies the parent process umask to archive member modes.
  if (process.platform !== "win32") process.umask(0o022);
  if (command === "pack") {
    const result = await packRelease({ args });
    process.stderr.write(`wrote immutable release receipt ${result.receiptPath}\n`);
    process.stdout.write(`${result.filename}\n`);
    return;
  }
  if (command === "publish") {
    const [tarball, ...publishArgs] = args;
    await publishRelease({ tarball, args: publishArgs });
    return;
  }
  if (command === "verify") {
    const [tarball, ...unexpected] = args;
    if (unexpected.length > 0) throw new Error(usage());
    const result = await verifyRelease({ tarball });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error(usage());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
