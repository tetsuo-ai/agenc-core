#!/usr/bin/env node
// Build a self-contained, per-platform runtime artifact for GitHub Releases.
//
// The runtime (@tetsuo-ai/runtime) is NOT published to npm — it ships as a
// platform-specific tarball because it pulls native deps (better-sqlite3,
// node-pty) that must be compiled for the host OS/arch. This script produces
// one such artifact for the CURRENT platform; the release CI matrix runs it on
// each target runner.
//
// Output layout (what the install-side runtime-manager extracts verbatim into
// ~/.agenc/runtime/<version>/):
//
//   node_modules/@tetsuo-ai/runtime/{bin,dist,package.json,README.md}
//   node_modules/<every production dep, natively built for this platform>/...
//
// So the runtime entry after extraction is:
//   <root>/node_modules/@tetsuo-ai/runtime/bin/agenc
//
// Steps: build runtime → `npm pack` it (respects its `files`) → recreate the
// runtime workspace in a staging root containing the COMMITTED root lock →
// `npm ci --omit=dev --workspace=@tetsuo-ai/runtime` → replace the workspace
// link with the packed runtime → write a canonical node_modules archive. No
// release dependency is resolved outside package-lock.json.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { create as createTar, extract as extractTar } from "tar";
import { validateRuntimeArchive } from "../lib/runtime-archive.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const launcherDir = resolve(__dirname, "..");
const repoRoot = resolve(launcherDir, "..", "..");
const runtimeDir = join(repoRoot, "runtime");
const rootPackagePath = join(repoRoot, "package.json");
const lockfilePath = join(repoRoot, "package-lock.json");
const releaseToolchainPath = join(repoRoot, "release-toolchain.json");

// On Windows, npm/tar-style launchers are .cmd shims that spawnSync cannot
// exec directly (ENOENT surfaces as a null status — exactly the CI matrix
// failure mode). `shell: true` resolves them through cmd.exe; argv here is
// always static, never user input.
const IS_WINDOWS = process.platform === "win32";

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: IS_WINDOWS,
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(
      `command failed (${res.status ?? res.signal}): ${cmd} ${args.join(" ")}`,
    );
  }
  return res;
}

function capture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: IS_WINDOWS,
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(
      `command failed (${res.status ?? res.signal}): ${cmd} ${args.join(" ")}\n${res.stderr ?? ""}`,
    );
  }
  return res.stdout.trim();
}

function captureOptional(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: IS_WINDOWS,
    ...opts,
  });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

function captureCombined(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: IS_WINDOWS,
    ...opts,
  });
  if (res.error?.code === "ENOENT") return undefined;
  const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  if (
    res.status !== 0 &&
    /(?:command not found|is not recognized|cannot find|no such file)/i.test(output)
  ) {
    return undefined;
  }
  return output || undefined;
}

function firstLine(value) {
  return value?.split(/\r?\n/, 1)[0];
}

const RPM_CONTENT_INVENTORY_FORMAT =
  "name|epoch|version|release|arch|sha256header|payloaddigest|payloaddigestalgo|rsaheader-pgpsig";
const RPM_CONTENT_QUERY =
  "%{NAME}|%{EPOCHNUM}|%{VERSION}|%{RELEASE}|%{ARCH}|%{SHA256HEADER}|" +
  "%{PAYLOADDIGEST}|%{PAYLOADDIGESTALGO}|%{RSAHEADER:pgpsig}\\n";

export function canonicalizeRpmContentInventory(inventory, allowedSigningKeyIds) {
  if (typeof inventory !== "string") {
    throw new TypeError("RPM content inventory must be text");
  }
  if (
    !Array.isArray(allowedSigningKeyIds) ||
    allowedSigningKeyIds.length === 0 ||
    allowedSigningKeyIds.some((keyId) => !/^[0-9a-f]{16}$/.test(keyId))
  ) {
    throw new Error("release-toolchain RPM signing key IDs are invalid");
  }
  const allowed = new Set(allowedSigningKeyIds);
  const signingKeyIds = new Set();
  const lines = inventory.split(/\r?\n/).filter(Boolean).filter((line) => {
    const [name] = line.split("|", 1);
    // rpm models imported public keys as pseudo-packages without a signed
    // payload. They are represented by the signer IDs below, not as content.
    return name !== "gpg-pubkey";
  });
  if (lines.length === 0) throw new Error("RPM content inventory is empty");
  for (const line of lines) {
    const fields = line.split("|");
    if (fields.length !== 9) {
      throw new Error(`RPM content inventory line has ${fields.length} fields`);
    }
    const [name, epoch, version, release, arch, headerSha256, payloadSha256,
      payloadDigestAlgorithm, signature] = fields;
    if (
      !/^[A-Za-z0-9+_.-]+$/.test(name) ||
      !/^\d+$/.test(epoch) ||
      !version ||
      !release ||
      !/^(?:aarch64|noarch|x86_64)$/.test(arch) ||
      !/^[0-9a-f]{64}$/.test(headerSha256) ||
      !/^[0-9a-f]{64}$/.test(payloadSha256) ||
      payloadDigestAlgorithm !== "8"
    ) {
      throw new Error(`RPM content identity is incomplete for ${name || "unknown package"}`);
    }
    const signatureMatch = /(?:^|, )Key ID ([0-9a-f]{16})$/.exec(signature);
    if (signatureMatch === null || !allowed.has(signatureMatch[1])) {
      throw new Error(`RPM signature identity is not approved for ${name}`);
    }
    signingKeyIds.add(signatureMatch[1]);
  }
  const canonical = `${lines.sort(utf8Compare).join("\n")}\n`;
  return {
    canonical,
    sha256: sha256Bytes(canonical),
    signingKeyIds: [...signingKeyIds].sort(utf8Compare),
  };
}

function expectedHostedBuilder(contract) {
  return `github-hosted:${contract.runnerLabel}:${contract.imageOS}:` +
    `${contract.imageVersion}:${contract.runnerArch}`;
}

export function assertHostedRunnerContract(metadata, contract, slug) {
  if (contract === null || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error(`release-toolchain.json has no hosted runner contract for ${slug}`);
  }
  for (const [field, metadataField] of [
    ["runnerLabel", "runnerLabel"],
    ["imageOS", "runnerImage"],
    ["imageVersion", "runnerImageVersion"],
    ["runnerArch", "runnerArch"],
  ]) {
    if (typeof contract[field] !== "string" || metadata[metadataField] !== contract[field]) {
      throw new Error(
        `release ${slug} ${metadataField} does not match release-toolchain.json: ` +
        `${metadata[metadataField] ?? "missing"} != ${contract[field] ?? "missing"}`,
      );
    }
  }
  const builder = expectedHostedBuilder(contract);
  if (metadata.builder !== builder) {
    throw new Error(
      `release ${slug} builder identity does not match release-toolchain.json: ` +
      `${metadata.builder ?? "missing"} != ${builder}`,
    );
  }
  if (slug.startsWith("darwin-")) {
    const expectedXcode = `Xcode ${contract.xcodeVersion}\nBuild version ${contract.xcodeBuild}`;
    for (const [actual, expected, label] of [
      [metadata.xcode, expectedXcode, "Xcode"],
      [metadata.sdk, contract.macosSdkVersion, "macOS SDK"],
      [metadata.cc, contract.clangVersion, "C compiler"],
      [metadata.cxx, contract.clangVersion, "C++ compiler"],
    ]) {
      if (typeof expected !== "string" || actual !== expected) {
        throw new Error(
          `release ${slug} ${label} does not match release-toolchain.json: ` +
          `${actual ?? "missing"} != ${expected ?? "missing"}`,
        );
      }
    }
  } else if (slug === "win-x64") {
    const expectedCompiler =
      `Microsoft (R) C/C++ Optimizing Compiler Version ${contract.msvcCompilerVersion} for x64`;
    for (const [actual, expected, label] of [
      [metadata.visualStudioVersion, contract.visualStudioVersion, "Visual Studio"],
      [metadata.visualStudioInstallPath, contract.visualStudioInstallPath, "Visual Studio path"],
      [metadata.msvcToolsVersion, contract.msvcToolsVersion, "MSVC tools"],
      [metadata.windowsSdkVersion, contract.windowsSdkVersion, "Windows SDK"],
      [metadata.cc, expectedCompiler, "C compiler"],
      [metadata.cxx, expectedCompiler, "C++ compiler"],
    ]) {
      if (typeof expected !== "string" || actual !== expected) {
        throw new Error(
          `release ${slug} ${label} does not match release-toolchain.json: ` +
          `${actual ?? "missing"} != ${expected ?? "missing"}`,
        );
      }
    }
  } else {
    throw new Error(`unsupported hosted runner release slug: ${slug}`);
  }
  return metadata;
}

function nativeToolchainMetadata(releaseToolchain, artifactProfile, buildEnvironment) {
  const cc = buildEnvironment.CC || (process.platform === "win32" ? "cl" : "cc");
  const cxx = buildEnvironment.CXX || (process.platform === "win32" ? "cl" : "c++");
  const python = buildEnvironment.npm_config_python || buildEnvironment.PYTHON ||
    (process.platform === "win32" ? "python" : "python3");
  const compilerArgs = process.platform === "win32" ? ["/Bv"] : ["--version"];
  const linkerArgs = process.platform === "darwin"
    ? ["-v"]
    : process.platform === "win32"
      ? ["/?"]
      : ["--version"];
  const metadata = {
    schemaVersion: 1,
    builder: buildEnvironment.AGENC_BUILDER_ID?.trim() ||
      (artifactProfile === "release" ? undefined : "local-unpinned"),
    runnerLabel: buildEnvironment.AGENC_RUNNER_LABEL?.trim() || undefined,
    runnerImage: buildEnvironment.ImageOS?.trim() || undefined,
    runnerImageVersion: buildEnvironment.ImageVersion?.trim() || undefined,
    runnerArch: buildEnvironment.RUNNER_ARCH?.trim() || undefined,
    cc: firstLine(captureCombined(cc, compilerArgs)),
    cxx: firstLine(captureCombined(cxx, compilerArgs)),
    linker: firstLine(captureCombined(process.platform === "win32" ? "link" : "ld", linkerArgs)),
    python: firstLine(captureCombined(python, ["--version"])),
    make: firstLine(captureCombined("make", ["--version"])),
    buildFlags: Object.fromEntries(
      [
        "CC", "CXX", "CFLAGS", "CXXFLAGS", "LDFLAGS", "CL", "LINK",
        "MACOSX_DEPLOYMENT_TARGET", "npm_config_build_from_source", "npm_config_python",
      ]
        .filter((name) => buildEnvironment[name] !== undefined)
        .map((name) => [name, buildEnvironment[name]]),
    ),
  };
  const os = process.platform === "win32" ? "win" : process.platform;
  const slug = `${os}-${process.arch}`;
  const expectedDistribution = releaseToolchain.nodeDistributions?.[slug];
  const expectedHeaders = releaseToolchain.nodeHeaders;
  const expectedNpm = releaseToolchain.npmDistribution;
  if (artifactProfile === "release") {
    if (
      typeof expectedDistribution?.file !== "string" ||
      !/^[0-9a-f]{64}$/.test(expectedDistribution.sha256 ?? "") ||
      typeof expectedHeaders?.file !== "string" ||
      !/^[0-9a-f]{64}$/.test(expectedHeaders.sha256 ?? "") ||
      typeof expectedNpm?.file !== "string" ||
      !/^[0-9a-f]{64}$/.test(expectedNpm.sha256 ?? "")
    ) {
      throw new Error(`release-toolchain.json has no valid Node inputs for ${slug}`);
    }
    const distributionSha256 = buildEnvironment.AGENC_NODE_DISTRIBUTION_SHA256?.trim();
    const headersSha256 = buildEnvironment.AGENC_NODE_HEADERS_SHA256?.trim();
    const npmDistributionSha256 =
      buildEnvironment.AGENC_NPM_DISTRIBUTION_SHA256?.trim();
    if (distributionSha256 !== expectedDistribution.sha256) {
      throw new Error(
        `release Node distribution digest does not match release-toolchain.json for ${slug}`,
      );
    }
    if (headersSha256 !== expectedHeaders.sha256) {
      throw new Error("release Node headers digest does not match release-toolchain.json");
    }
    if (npmDistributionSha256 !== expectedNpm.sha256) {
      throw new Error("release npm distribution digest does not match release-toolchain.json");
    }
    metadata.nodeDistributionFile = expectedDistribution.file;
    metadata.nodeDistributionSha256 = distributionSha256;
    metadata.nodeHeadersFile = expectedHeaders.file;
    metadata.nodeHeadersSha256 = headersSha256;
    metadata.npmDistributionFile = expectedNpm.file;
    metadata.npmDistributionSha256 = npmDistributionSha256;
  }
  if (process.platform === "linux") {
    const inventory = captureOptional("rpm", [
      "-qa",
      "--qf",
      RPM_CONTENT_QUERY,
    ]);
    if (inventory !== undefined) {
      const inventoryContract = releaseToolchain.linux.rpmContentInventory;
      if (
        inventoryContract?.schemaVersion !== 1 ||
        inventoryContract.format !== RPM_CONTENT_INVENTORY_FORMAT
      ) {
        throw new Error("release-toolchain RPM content inventory contract is invalid");
      }
      const contentIdentity = canonicalizeRpmContentInventory(
        inventory,
        inventoryContract.signatureKeyIds,
      );
      metadata.rpmContentInventorySchemaVersion = inventoryContract.schemaVersion;
      metadata.rpmContentInventoryFormat = inventoryContract.format;
      metadata.rpmContentInventorySha256 = contentIdentity.sha256;
      metadata.rpmSigningKeyIds = contentIdentity.signingKeyIds;
    }
    if (artifactProfile === "release") {
      metadata.rpmPackages = Object.entries(releaseToolchain.linux.builderPackages)
        .map(([name, expected]) => {
          const actual = capture("rpm", ["-q", "--qf", "%{NAME}-%{VERSION}-%{RELEASE}", name]);
          if (actual !== expected) {
            throw new Error(`release RPM ${name} does not match release-toolchain.json: ${actual}`);
          }
          return actual;
        })
        .sort(utf8Compare);
      for (const [actual, expected, label] of [
        [metadata.cxx, releaseToolchain.linux.compilerVersion, "C++ compiler"],
        [metadata.linker, releaseToolchain.linux.binutilsVersion, "linker"],
        [metadata.python, releaseToolchain.linux.pythonVersion, "Python"],
      ]) {
        if (typeof actual !== "string" || !actual.includes(expected)) {
          throw new Error(`release ${label} does not match release-toolchain.json: ${actual ?? "missing"}`);
        }
      }
      if (!metadata.rpmContentInventorySha256) {
        throw new Error("release Linux build could not inventory signed RPM content inputs");
      }
      const expectedInventory =
        releaseToolchain.linux.rpmContentInventory?.sha256?.[process.arch];
      if (
        !/^[0-9a-f]{64}$/.test(expectedInventory ?? "") ||
        metadata.rpmContentInventorySha256 !== expectedInventory
      ) {
        throw new Error(
          `release Linux signed RPM content inventory does not match release-toolchain.json ` +
          `for ${process.arch}: ${metadata.rpmContentInventorySha256} != ` +
          `${expectedInventory ?? "missing"}`,
        );
      }
      if (!isDeepStrictEqual(
        metadata.rpmSigningKeyIds,
        releaseToolchain.linux.rpmContentInventory.signatureKeyIds,
      )) {
        throw new Error("release Linux RPM signer set does not match release-toolchain.json");
      }
      const expectedBuilder =
        `${releaseToolchain.linux.containerImage}+rpm-content-sha256:${expectedInventory}`;
      if (metadata.builder !== expectedBuilder) {
        throw new Error(
          `release Linux builder identity does not match release-toolchain.json: ` +
          `${metadata.builder ?? "missing"} != ${expectedBuilder}`,
        );
      }
    }
  } else if (process.platform === "darwin") {
    metadata.xcode = captureCombined("xcodebuild", ["-version"]);
    metadata.sdk = firstLine(captureCombined("xcrun", ["--sdk", "macosx", "--show-sdk-version"]));
  } else if (process.platform === "win32") {
    metadata.visualStudioVersion =
      buildEnvironment.AGENC_VISUAL_STUDIO_VERSION?.trim() || undefined;
    metadata.visualStudioInstallPath =
      buildEnvironment.AGENC_VISUAL_STUDIO_INSTALL_PATH?.trim() || undefined;
    metadata.msvcToolsVersion =
      buildEnvironment.VCToolsVersion?.trim().replace(/[\\/]+$/, "") || undefined;
    metadata.windowsSdkVersion =
      buildEnvironment.WindowsSDKVersion?.trim().replace(/[\\/]+$/, "") || undefined;
    metadata.compilerDetails = captureCombined("cl", ["/Bv"]);
    metadata.msvcCompilerSha256 = buildEnvironment.AGENC_MSVC_COMPILER_SHA256?.trim();
    metadata.msvcLinkerSha256 = buildEnvironment.AGENC_MSVC_LINKER_SHA256?.trim();
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) delete metadata[key];
  }
  if (artifactProfile === "release" && !metadata.builder) {
    throw new Error("release build requires AGENC_BUILDER_ID");
  }
  if (artifactProfile === "release") {
    for (const field of [
      "cc",
      "cxx",
      "python",
      ...(process.platform === "win32" ? [] : ["make"]),
    ]) {
      if (typeof metadata[field] !== "string" || metadata[field].length === 0) {
        throw new Error(`release build could not inventory native tool ${field}`);
      }
    }
    if (process.platform === "darwin") {
      for (const field of [
        "runnerLabel", "runnerImage", "runnerImageVersion", "runnerArch", "xcode", "sdk",
      ]) {
        if (typeof metadata[field] !== "string" || metadata[field].length === 0) {
          throw new Error(`release macOS build could not inventory ${field}`);
        }
      }
    }
    if (process.platform === "win32") {
      for (const field of [
        "runnerImage",
        "runnerImageVersion",
        "runnerLabel",
        "runnerArch",
        "visualStudioVersion",
        "visualStudioInstallPath",
        "msvcToolsVersion",
        "windowsSdkVersion",
        "compilerDetails",
      ]) {
        if (typeof metadata[field] !== "string" || metadata[field].length === 0) {
          throw new Error(`release Windows build could not inventory ${field}`);
        }
      }
      for (const field of ["msvcCompilerSha256", "msvcLinkerSha256"]) {
        if (!/^[0-9a-f]{64}$/.test(metadata[field] ?? "")) {
          throw new Error(`release Windows build has invalid ${field}`);
        }
      }
    }
    if (process.platform === "darwin" || process.platform === "win32") {
      assertHostedRunnerContract(
        metadata,
        releaseToolchain.hostedRunners?.[slug],
        slug,
      );
    }
  }
  if (
    artifactProfile === "release" &&
    /(?:^|[:+_-])unknown(?:$|[:+_-])/i.test(metadata.builder)
  ) {
    throw new Error("release build refuses an unknown builder identity");
  }
  return metadata;
}

// node platform/arch → the artifact slug used in filenames + the manifest.
function platformSlug() {
  const os = process.platform === "win32" ? "win" : process.platform; // linux | darwin | win
  const arch = process.arch; // x64 | arm64
  return { os, arch, slug: `${os}-${arch}` };
}

function sha256(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function utf8Compare(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function sourceMetadata() {
  const commit =
    process.env.AGENC_BUILD_COMMIT?.trim() ||
    captureOptional("git", ["rev-parse", "HEAD"], { cwd: repoRoot }) ||
    "unknown";
  if (commit !== "unknown" && !/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new Error(`AGENC_BUILD_COMMIT must be a full Git object id, got ${commit}`);
  }

  const epochText =
    process.env.SOURCE_DATE_EPOCH?.trim() ||
    captureOptional("git", ["show", "-s", "--format=%ct", "HEAD"], {
      cwd: repoRoot,
    }) ||
    "0";
  if (!/^(0|[1-9][0-9]*)$/.test(epochText)) {
    throw new Error(`SOURCE_DATE_EPOCH must be a non-negative integer, got ${epochText}`);
  }
  const epoch = Number(epochText);
  if (!Number.isSafeInteger(epoch) || epoch > 8_640_000_000_000) {
    throw new Error(`SOURCE_DATE_EPOCH is outside the supported range: ${epochText}`);
  }

  const explicitBuildTime = process.env.AGENC_BUILD_TIME?.trim();
  const buildTime = explicitBuildTime || new Date(epoch * 1000).toISOString();
  if (Number.isNaN(Date.parse(buildTime))) {
    throw new Error(`AGENC_BUILD_TIME must be an ISO-8601 timestamp, got ${buildTime}`);
  }
  return {
    sourceCommit: commit,
    sourceDateEpoch: epoch,
    buildTime: new Date(buildTime).toISOString(),
  };
}

function pinnedNpmVersion(rootPackage) {
  const match = /^npm@([0-9]+\.[0-9]+\.[0-9]+)$/.exec(
    rootPackage.packageManager ?? "",
  );
  if (!match) {
    throw new Error("root packageManager must pin an exact npm version");
  }
  return match[1];
}

function supportedNodeMajor(rootPackage) {
  const range = rootPackage.devEngines?.runtime?.version ?? "";
  const match = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)\.0\.0$/.exec(range);
  if (!match || Number(match[4]) !== Number(match[1]) + 1) {
    throw new Error(
      "root devEngines.runtime.version must select exactly one Node.js major",
    );
  }
  return Number(match[1]);
}

export function canonicalArchiveEntries(root, relativeRoot) {
  const entries = [];
  const visit = (relativePath) => {
    const absolutePath = join(root, ...relativePath.split("/"));
    const metadata = lstatSync(absolutePath);
    if (
      !metadata.isDirectory() &&
      !metadata.isFile() &&
      !metadata.isSymbolicLink()
    ) {
      throw new Error(`refusing unsupported archive entry: ${relativePath}`);
    }
    entries.push(relativePath);
    if (!metadata.isDirectory()) return;
    const children = readdirSync(absolutePath).sort(utf8Compare);
    for (const child of children) {
      visit(`${relativePath}/${child}`);
    }
  };
  visit(relativeRoot);
  return entries;
}

function installedPackageInventory(nodeModules) {
  const inventory = [];
  const visitPackage = (packagePath, displayPath) => {
    const metadata = lstatSync(packagePath);
    if (metadata.isSymbolicLink()) {
      inventory.push({
        path: displayPath,
        link: readlinkSync(packagePath).split(sep).join("/"),
      });
      return;
    }
    if (!metadata.isDirectory()) {
      throw new Error(`invalid installed package entry: ${displayPath}`);
    }
    const manifestPath = join(packagePath, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`installed package lacks name/version: ${displayPath}`);
    }
    inventory.push({
      path: displayPath,
      name: manifest.name,
      version: manifest.version,
    });
    const nested = join(packagePath, "node_modules");
    if (existsSync(nested)) visitNodeModules(nested, `${displayPath}/node_modules`);
  };
  const visitNodeModules = (directory, displayDirectory) => {
    for (const entry of readdirSync(directory).sort(utf8Compare)) {
      if (entry === ".bin" || entry === ".package-lock.json") continue;
      const entryPath = join(directory, entry);
      if (entry.startsWith("@")) {
        if (!lstatSync(entryPath).isDirectory()) {
          throw new Error(`invalid package scope: ${displayDirectory}/${entry}`);
        }
        for (const scoped of readdirSync(entryPath).sort(utf8Compare)) {
          visitPackage(
            join(entryPath, scoped),
            `${displayDirectory}/${entry}/${scoped}`,
          );
        }
      } else {
        visitPackage(entryPath, `${displayDirectory}/${entry}`);
      }
    }
  };
  visitNodeModules(nodeModules, "node_modules");
  return inventory;
}

function retainRuntimeBuildFiles(packageRoot, required, optional = []) {
  const buildRoot = join(packageRoot, "build");
  const retained = [];
  for (const relativePath of [...required, ...optional]) {
    const source = join(buildRoot, ...relativePath.split("/"));
    if (!existsSync(source)) {
      if (required.includes(relativePath)) {
        throw new Error(`native build did not produce ${source}`);
      }
      continue;
    }
    const metadata = statSync(source);
    if (!metadata.isFile()) {
      throw new Error(`native runtime output is not a file: ${source}`);
    }
    retained.push({
      relativePath,
      bytes: readFileSync(source),
      mode: metadata.mode & 0o777,
    });
  }
  rmSync(buildRoot, { recursive: true, force: true });
  for (const file of retained) {
    const destination = join(buildRoot, ...file.relativePath.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.bytes);
    chmodSync(destination, file.mode);
  }
}

export function pruneNativeBuildIntermediates(
  nodeModules,
  platform = process.platform,
) {
  retainRuntimeBuildFiles(
    join(nodeModules, "better-sqlite3"),
    ["Release/better_sqlite3.node"],
  );
  const nodePty = join(nodeModules, "node-pty");
  if (platform === "win32") {
    retainRuntimeBuildFiles(
      nodePty,
      [
        "Release/pty.node",
        "Release/conpty.node",
        "Release/conpty_console_list.node",
        "Release/winpty-agent.exe",
        "Release/winpty.dll",
      ],
      [
        "Release/conpty/conpty.dll",
        "Release/conpty/OpenConsole.exe",
      ],
    );
  } else if (platform === "darwin") {
    retainRuntimeBuildFiles(
      nodePty,
      ["Release/pty.node", "Release/spawn-helper"],
    );
  } else {
    // node-pty only defines spawn-helper on macOS. Linux source builds produce
    // pty.node alone (see node-pty's binding.gyp OS guards).
    retainRuntimeBuildFiles(nodePty, ["Release/pty.node"]);
  }
  // Source builds must never retain vendored prebuilds for another ABI or OS.
  rmSync(join(nodePty, "prebuilds"), { recursive: true, force: true });
}

function compareDottedVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function maximumRequiredSymbolVersion(readelfOutputs, namespace) {
  let maximum;
  const escapedNamespace = namespace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escapedNamespace}_(\\d+\\.\\d+(?:\\.\\d+)?)\\b`, "g");
  for (const output of readelfOutputs) {
    const needsIndex = output.indexOf("Version needs section");
    if (needsIndex === -1) continue;
    const needs = output.slice(needsIndex);
    for (const match of needs.matchAll(pattern)) {
      const version = match[1];
      if (maximum === undefined || compareDottedVersions(version, maximum) > 0) {
        maximum = version;
      }
    }
  }
  return maximum;
}

export function maximumGlibcVersion(readelfOutputs) {
  return maximumRequiredSymbolVersion(readelfOutputs, "GLIBC");
}

function isElf(path) {
  const descriptor = openSync(path, "r");
  try {
    const magic = Buffer.alloc(4);
    return readSync(descriptor, magic, 0, magic.length, 0) === magic.length &&
      magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } finally {
    closeSync(descriptor);
  }
}

function isMachO(path) {
  const descriptor = openSync(path, "r");
  try {
    const magic = Buffer.alloc(4);
    if (readSync(descriptor, magic, 0, magic.length, 0) !== magic.length) return false;
    const value = magic.readUInt32BE(0);
    return new Set([
      0xfeedface,
      0xcefaedfe,
      0xfeedfacf,
      0xcffaedfe,
      0xcafebabe,
      0xbebafeca,
      0xcafebabf,
      0xbfbafeca,
    ]).has(value);
  } finally {
    closeSync(descriptor);
  }
}

function retainedRegularFiles(nodeModules) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort(utf8Compare)) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) files.push(path);
    }
  };
  visit(nodeModules);
  return files;
}

function retainedElfFiles(nodeModules) {
  return retainedRegularFiles(nodeModules).filter(isElf);
}

function enforceMaximumSymbolVersion({ actual, allowed, environmentName, namespace }) {
  if (allowed === undefined || allowed.length === 0) return;
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(allowed)) {
    throw new Error(`${environmentName} must be a dotted version, got ${allowed}`);
  }
  if (actual !== undefined && compareDottedVersions(actual, allowed) > 0) {
    throw new Error(
      `native runtime requires ${namespace}_${actual}, above release floor ${allowed}`,
    );
  }
}

function linuxNativeCompatibility(nodeModules, releaseLimits) {
  if (process.platform !== "linux") return {};
  const glibcVersionRuntime = process.report?.getReport()?.header?.glibcVersionRuntime;
  if (typeof glibcVersionRuntime !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(glibcVersionRuntime)) {
    throw new Error(
      "generic Linux runtime artifacts must be built on glibc; musl/unknown libc is unsupported",
    );
  }
  const nativeFiles = retainedElfFiles(nodeModules);
  if (nativeFiles.length === 0) {
    throw new Error("Linux runtime artifact contains no retained native executables");
  }
  const readelfOutputs = nativeFiles.map((path) =>
    capture("readelf", ["--version-info", "--wide", path], {
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
    }),
  );
  const minimumGlibcVersion = maximumGlibcVersion(readelfOutputs);
  if (minimumGlibcVersion === undefined) {
    throw new Error("could not determine the Linux runtime artifact's GLIBC symbol floor");
  }
  const minimumGlibcxxVersion = maximumRequiredSymbolVersion(readelfOutputs, "GLIBCXX");
  const minimumCxxAbiVersion = maximumRequiredSymbolVersion(readelfOutputs, "CXXABI");
  if (minimumGlibcxxVersion === undefined || minimumCxxAbiVersion === undefined) {
    throw new Error(
      "could not determine the Linux runtime artifact's GLIBCXX/CXXABI symbol floors",
    );
  }
  if (releaseLimits !== undefined) {
    enforceMaximumSymbolVersion({
      actual: minimumGlibcVersion,
      allowed: releaseLimits.maximumGlibcVersion,
      environmentName: "release-toolchain Linux GLIBC ceiling",
      namespace: "GLIBC",
    });
    enforceMaximumSymbolVersion({
      actual: minimumGlibcxxVersion,
      allowed: releaseLimits.maximumGlibcxxVersion,
      environmentName: "release-toolchain Linux GLIBCXX ceiling",
      namespace: "GLIBCXX",
    });
    enforceMaximumSymbolVersion({
      actual: minimumCxxAbiVersion,
      allowed: releaseLimits.maximumCxxAbiVersion,
      environmentName: "release-toolchain Linux CXXABI ceiling",
      namespace: "CXXABI",
    });
  }
  return {
    libcFamily: "glibc",
    minimumGlibcVersion,
    minimumGlibcxxVersion,
    minimumCxxAbiVersion,
    buildGlibcVersion: glibcVersionRuntime,
  };
}

export function maximumMacosDeploymentVersion(outputs) {
  let minimumMacosVersion;
  for (const output of outputs) {
    const versions = [
      ...output.matchAll(/\bminos\s+(\d+\.\d+(?:\.\d+)?)\b/g),
      ...output.matchAll(/LC_VERSION_MIN_MACOSX[\s\S]{0,240}?\bversion\s+(\d+\.\d+(?:\.\d+)?)\b/g),
    ].map((match) => match[1]);
    for (const version of versions) {
      if (
        minimumMacosVersion === undefined ||
        compareDottedVersions(version, minimumMacosVersion) > 0
      ) {
        minimumMacosVersion = version;
      }
    }
  }
  return minimumMacosVersion;
}

function darwinNativeCompatibility(nodeModules, releaseLimits) {
  if (process.platform !== "darwin") return {};
  const outputs = retainedRegularFiles(nodeModules).filter(isMachO)
    .map((path) => captureOptional("otool", ["-l", path]))
    .filter((value) => value !== undefined);
  const minimumMacosVersion = maximumMacosDeploymentVersion(outputs);
  if (minimumMacosVersion === undefined) {
    throw new Error("could not determine the runtime artifact's macOS deployment floor");
  }
  if (
    releaseLimits !== undefined &&
    compareDottedVersions(minimumMacosVersion, releaseLimits.minimumVersion) > 0
  ) {
    throw new Error(
      `native runtime requires macOS ${minimumMacosVersion}, above release floor ${releaseLimits.minimumVersion}`,
    );
  }
  return { minimumMacosVersion };
}

function smokeInstalledNativeModules(installRoot, env) {
  const script = String.raw`
    const { createRequire } = require("node:module");
    const { join } = require("node:path");
    const requireFromArtifact = createRequire(join(process.cwd(), "smoke.cjs"));
    const Database = requireFromArtifact("better-sqlite3");
    const db = new Database(":memory:");
    if (db.prepare("select 42 as value").get().value !== 42) process.exit(20);
    db.close();
    const pty = requireFromArtifact("node-pty");
    const child = pty.spawn(process.execPath, ["-e", "process.stdout.write('pty-ok')"], {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH || "" },
    });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); process.exit(21); }, 10000);
    child.onData((chunk) => { output += chunk; });
    child.onExit(() => {
      clearTimeout(timeout);
      if (!output.includes("pty-ok")) process.exit(22);
    });
  `;
  run(process.execPath, ["-e", script], { cwd: installRoot, env });
}

function isDeveloperSpecificPath(value) {
  if (typeof value !== "string" || value.length < 4) return false;
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return normalized.slice(3).split("/").filter(Boolean).length >= 2;
  }
  if (normalized.startsWith("/")) {
    return normalized.slice(1).split("/").filter(Boolean).length >= 2;
  }
  return false;
}

export function assertNoLocalPathLeaks(root, localPaths) {
  const needles = [...new Set(
    localPaths
      // Top-level roots such as /root, /src, or C:\\src are too generic to
      // identify a developer machine and occur legitimately in dependency
      // source. Build stages use deeper, unique paths; scan only those paths.
      .filter(isDeveloperSpecificPath)
      .flatMap((value) => [value, value.split("\\").join("/"), value.split("/").join("\\")]),
  )].map((value) => Buffer.from(value));
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isDirectory()) {
        visit(path);
      } else if (metadata.isFile()) {
        const bytes = readFileSync(path);
        const leaked = needles.find((needle) => bytes.includes(needle));
        if (leaked !== undefined) {
          throw new Error(
            `release artifact embeds a developer-local path in ${path}: ${leaked.toString()}`,
          );
        }
      }
    }
  };
  visit(root);
}

export async function writeCanonicalArchive({ installRoot, artifactPath, epoch }) {
  const entries = canonicalArchiveEntries(installRoot, "node_modules");
  const fixedTime = new Date(epoch * 1000);
  rmSync(artifactPath, { force: true });
  await createTar(
    {
      cwd: installRoot,
      file: artifactPath,
      filter(_path, metadata) {
        metadata.mtime = fixedTime;
        // fs.Stats predicates derive the entry type from the high mode bits.
        // Preserve those bits while normalizing only permissions; clearing
        // them makes node-tar silently treat every selected path as unsupported.
        const entryType = metadata.mode & 0o170000;
        const permissions =
          metadata.isDirectory() ? 0o755
          : metadata.isSymbolicLink() ? 0o777
          : metadata.mode & 0o111 ? 0o755
          : 0o644;
        metadata.mode = entryType | permissions;
        return true;
      },
      gzip: { level: 9, mtime: 0 },
      mtime: fixedTime,
      noDirRecurse: true,
      portable: true,
      strict: true,
      umask: 0o022,
    },
    entries,
  );
}

export function assertRootLockSnapshot(rootPackage, lockfile) {
  const snapshot = lockfile?.packages?.[""];
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("root package-lock.json snapshot is missing");
  }
  if (rootPackage?.private !== true) {
    throw new Error("release source root must remain private");
  }
  for (const field of [
    "name",
    "version",
    "license",
    "workspaces",
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]) {
    const manifestValue = rootPackage[field] ?? null;
    const lockValue = snapshot[field] ?? null;
    if (!isDeepStrictEqual(manifestValue, lockValue)) {
      throw new Error(`root package-lock.json ${field} snapshot does not match package.json`);
    }
  }
}

async function main() {
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
  const releaseToolchain = JSON.parse(readFileSync(releaseToolchainPath, "utf8"));
  const runtimePkg = JSON.parse(
    readFileSync(join(runtimeDir, "package.json"), "utf8"),
  );
  if (!existsSync(lockfilePath) || !statSync(lockfilePath).isFile()) {
    throw new Error("committed root package-lock.json is required");
  }
  const lockfileBytes = readFileSync(lockfilePath);
  const lockfile = JSON.parse(lockfileBytes);
  if (lockfile.lockfileVersion !== 3 || lockfile.packages?.runtime === undefined) {
    throw new Error("root package-lock.json must be v3 and contain the runtime workspace");
  }
  assertRootLockSnapshot(rootPackage, lockfile);
  const expectedNpmVersion = pinnedNpmVersion(rootPackage);
  if (expectedNpmVersion !== releaseToolchain.npmVersion) {
    throw new Error("root packageManager and release-toolchain npm versions differ");
  }
  const npmVersion = capture("npm", ["--version"], { cwd: repoRoot });
  if (npmVersion !== expectedNpmVersion) {
    throw new Error(
      `release build requires npm ${expectedNpmVersion}; found ${npmVersion}`,
    );
  }
  const expectedNodeMajor = supportedNodeMajor(rootPackage);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (
    nodeMajor !== expectedNodeMajor ||
    releaseToolchain.nodeMajor !== expectedNodeMajor ||
    process.versions.node !== releaseToolchain.nodeVersion
  ) {
    throw new Error(
      `release build requires Node.js ${releaseToolchain.nodeVersion}; found ${process.version}`,
    );
  }
  const nodeModuleAbi = process.versions.modules;
  if (!/^\d+$/.test(nodeModuleAbi)) {
    throw new Error(`Node.js did not report a valid native module ABI: ${nodeModuleAbi}`);
  }
  if (
    nodeModuleAbi !== releaseToolchain.nodeModuleAbi ||
    process.versions.napi !== releaseToolchain.nodeApiVersion
  ) {
    throw new Error("current Node native ABI does not match release-toolchain.json");
  }
  const source = sourceMetadata();
  const artifactProfile = process.env.AGENC_ARTIFACT_PROFILE?.trim() || "release";
  if (!/^(release|clean-local|container-local)$/.test(artifactProfile)) {
    throw new Error(`unsupported AGENC_ARTIFACT_PROFILE: ${artifactProfile}`);
  }
  const nodeHeadersRoot = process.env.npm_config_nodedir?.trim();
  if (!nodeHeadersRoot || !isAbsolute(nodeHeadersRoot)) {
    throw new Error("native runtime builds require an absolute npm_config_nodedir");
  }
  const nodeHeader = join(nodeHeadersRoot, "include", "node", "node.h");
  if (!existsSync(nodeHeader) || !statSync(nodeHeader).isFile()) {
    throw new Error(`native runtime builds require verified Node headers at ${nodeHeader}`);
  }
  if (artifactProfile === "release") {
    const insideWorktree = captureOptional(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: repoRoot },
    );
    if (insideWorktree !== "true") {
      throw new Error("release-profile builds require a clean Git checkout");
    }
    const dirty = capture("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: repoRoot,
    });
    if (dirty.length > 0) {
      throw new Error(`release-profile build refuses a dirty source tree:\n${dirty}`);
    }
  }
  const version = runtimePkg.version;
  const { os, arch, slug } = platformSlug();
  const releaseEnv = {
    ...process.env,
    AGENC_BUILD_COMMIT: source.sourceCommit,
    AGENC_BUILD_TIME: source.buildTime,
    AGENC_SKIP_POSTINSTALL: "1",
    CI: "true",
    npm_config_build_from_source: "true",
    npm_config_strict_allow_scripts: "true",
    LANG: "C",
    LC_ALL: "C",
    SOURCE_DATE_EPOCH: String(source.sourceDateEpoch),
    TZ: "UTC",
  };
  if (process.platform === "linux") {
    releaseEnv.AGENC_MAX_GLIBC = releaseToolchain.linux.maximumGlibcVersion;
    releaseEnv.AGENC_MAX_GLIBCXX = releaseToolchain.linux.maximumGlibcxxVersion;
    releaseEnv.AGENC_MAX_CXXABI = releaseToolchain.linux.maximumCxxAbiVersion;
  }
  if (process.platform === "darwin") {
    releaseEnv.MACOSX_DEPLOYMENT_TARGET = releaseToolchain.macos.minimumVersion;
    releaseEnv.LDFLAGS = [releaseEnv.LDFLAGS, "-Wl,-no_uuid"].filter(Boolean).join(" ");
  }
  if (process.platform === "win32") {
    releaseEnv.CL = [releaseEnv.CL, "/Brepro"].filter(Boolean).join(" ");
    releaseEnv.LINK = [releaseEnv.LINK, "/Brepro"].filter(Boolean).join(" ");
  }
  const nativeToolchain = nativeToolchainMetadata(
    releaseToolchain,
    artifactProfile,
    releaseEnv,
  );

  const outDir = resolve(
    process.env.AGENC_RELEASE_OUT_DIR ?? join(launcherDir, "release-artifacts"),
  );
  mkdirSync(outDir, { recursive: true });

  const stage = mkdtempSync(join(tmpdir(), "agenc-runtime-build-"));
  try {
    // 1. Build the runtime (produces dist/).
    console.error(`[build] runtime ${version} (${slug})`);
    run("npm", ["run", "build"], { cwd: runtimeDir, env: releaseEnv });

    // 2. Pack the runtime package into a tgz (honors runtime's `files`).
    const packed = capture(
      "npm",
      ["pack", "--silent", "--ignore-scripts", "--pack-destination", stage],
      { cwd: runtimeDir, env: releaseEnv },
    )
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    const runtimeTgz = join(stage, packed);

    // 3. Recreate the runtime workspace beneath the committed root lock, then
    //    install exactly its production closure for THIS platform.
    const installRoot = join(stage, "install");
    mkdirSync(installRoot, { recursive: true });
    copyFileSync(rootPackagePath, join(installRoot, "package.json"));
    copyFileSync(lockfilePath, join(installRoot, "package-lock.json"));
    // npm validates lifecycle-script policy across every workspace named by
    // the lock even when --workspace filters the installed closure. Supply
    // the two non-runtime manifests so strict allowScripts checks the same
    // complete workspace graph as the root install.
    const stagedLauncher = join(installRoot, "packages", "agenc");
    const stagedSdk = join(installRoot, "packages", "agenc-sdk");
    mkdirSync(join(stagedLauncher, "scripts"), { recursive: true });
    mkdirSync(stagedSdk, { recursive: true });
    copyFileSync(join(launcherDir, "package.json"), join(stagedLauncher, "package.json"));
    copyFileSync(
      join(launcherDir, "scripts", "postinstall.mjs"),
      join(stagedLauncher, "scripts", "postinstall.mjs"),
    );
    copyFileSync(
      join(repoRoot, "packages", "agenc-sdk", "package.json"),
      join(stagedSdk, "package.json"),
    );
    const stagedRuntime = join(installRoot, "runtime");
    mkdirSync(stagedRuntime, { recursive: true });
    await extractTar({
      cwd: stagedRuntime,
      file: runtimeTgz,
      preserveOwner: false,
      strict: true,
      strip: 1,
    });
    run(
      "npm",
      [
        "ci",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--install-strategy=hoisted",
        "--workspace=@tetsuo-ai/runtime",
      ],
      { cwd: installRoot, env: releaseEnv },
    );

    const nodeModules = join(installRoot, "node_modules");
    const installedRuntime = join(
      nodeModules,
      "@tetsuo-ai",
      "runtime",
    );
    rmSync(installedRuntime, { recursive: true, force: true });
    renameSync(stagedRuntime, installedRuntime);
    pruneNativeBuildIntermediates(nodeModules);
    const nativeCompatibility = {
      ...linuxNativeCompatibility(
        nodeModules,
        artifactProfile === "release" ? releaseToolchain.linux : undefined,
      ),
      ...darwinNativeCompatibility(
        nodeModules,
        artifactProfile === "release" ? releaseToolchain.macos : undefined,
      ),
    };
    assertNoLocalPathLeaks(nodeModules, [
      stage,
      repoRoot,
      process.env.HOME,
      process.env.USERPROFILE,
      process.env.npm_config_cache,
    ]);
    const runtimeEntry = join(
      installedRuntime,
      "bin",
      "agenc",
    );
    statSync(runtimeEntry); // hard-fail if the layout isn't what we promise
    for (const devOnly of ["typescript", "vitest"]) {
      if (existsSync(join(nodeModules, devOnly))) {
        throw new Error(`dev dependency leaked into runtime artifact: ${devOnly}`);
      }
    }
    const inventory = installedPackageInventory(nodeModules);
    const dependencyTreeSha256 = sha256Bytes(`${JSON.stringify(inventory)}\n`);
    smokeInstalledNativeModules(installRoot, releaseEnv);

    // 4. Tar node_modules into the release artifact.
    const artifactName =
      `agenc-runtime-${version}-${slug}-node${nodeMajor}-abi${nodeModuleAbi}.tar.gz`;
    const artifactPath = join(outDir, artifactName);
    await writeCanonicalArchive({
      installRoot,
      artifactPath,
      epoch: source.sourceDateEpoch,
    });

    // Validate the exact final bytes with the same policy used by every
    // installer before hashing or exposing them as a release artifact.
    const validatedArchive = validateRuntimeArchive(artifactPath, os);
    const archiveValidation = {
      policy: "agenc-runtime-archive-v1",
      entries: validatedArchive.entries,
      uncompressedBytes: validatedArchive.uncompressedBytes,
    };

    // 5. Hash + report.
    const digest = await sha256(artifactPath);
    const size = statSync(artifactPath).size;
    const meta = {
      platform: os,
      arch,
      runtimeVersion: version,
      artifact: artifactName,
      sha256: digest,
      bytes: size,
      sourceCommit: source.sourceCommit,
      sourceDateEpoch: source.sourceDateEpoch,
      buildTime: source.buildTime,
      lockfileSha256: sha256Bytes(lockfileBytes),
      dependencyTreeSha256,
      dependencyPackages: inventory.length,
      nodeVersion: process.version,
      nodeMajor,
      nodeModuleAbi,
      nodeApiVersion: process.versions.napi,
      npmVersion,
      artifactProfile,
      nativeToolchain,
      ...nativeCompatibility,
      archiveFormat: "tar+gzip; portable; utf8-byte-order; normalized-mtime",
      archiveValidation,
      bins: {
        agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc",
      },
    };
    // Sidecar meta so gen-manifest.mjs can assemble the manifest by globbing
    // release-artifacts/ across the CI matrix's downloaded artifacts.
    writeFileSync(
      join(outDir, `${artifactName}.meta.json`),
      `${JSON.stringify(meta, null, 2)}\n`,
    );
    // Machine-readable line for CI; human summary on stderr.
    process.stdout.write(JSON.stringify(meta) + "\n");
    console.error(
      `[build] wrote ${artifactPath} (${(size / 1e6).toFixed(1)} MB)\n[build] sha256 ${digest}`,
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((err) => {
    console.error(`[build] FAILED: ${err?.stack ?? err}`);
    process.exitCode = 1;
  });
}
