#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import parseSpdxExpression from "spdx-expression-parse";

const GENERATOR_REVISION = 4;
const REPOSITORY_VCS = "git+https://github.com/tetsuo-ai/agenc-core.git";
const args = process.argv.slice(2);

function argValue(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function gitValue(parameters) {
  const result = spawnSync("git", parameters, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function sourceCommit() {
  const value =
    argValue("--source-commit", process.env.AGENC_BUILD_COMMIT?.trim()) ||
    gitValue(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40,64}$/.test(value ?? "")) {
    throw new Error("a full hexadecimal source commit is required for the SBOM");
  }
  return value;
}

function sourceDateEpoch() {
  const value =
    process.env.SOURCE_DATE_EPOCH?.trim() ||
    gitValue(["show", "-s", "--format=%ct", "HEAD"]);
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? "")) {
    throw new Error("SOURCE_DATE_EPOCH or a Git commit timestamp is required");
  }
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch) || epoch > 8_640_000_000_000) {
    throw new Error(`SOURCE_DATE_EPOCH is outside the supported range: ${value}`);
  }
  return epoch;
}

function sanitizeSpdxId(value) {
  const sanitized = value.replace(/[^A-Za-z0-9.-]/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "package";
}

function packageNameFromPath(path, entry) {
  if (typeof entry.name === "string" && entry.name.length > 0) return entry.name;
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  if (index === -1) throw new Error(`lockfile package ${path} has no name`);
  return path.slice(index + marker.length);
}

function purlForPackage(name, version) {
  const encoded = name.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`;
}

function integrityChecksum(integrity) {
  if (typeof integrity !== "string") return undefined;
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (match === null) return undefined;
  return {
    algorithm: match[1].toUpperCase(),
    checksumValue: Buffer.from(match[2], "base64").toString("hex"),
  };
}

function validDownloadLocation(value) {
  if (typeof value !== "string" || value.length === 0) return "NOASSERTION";
  try {
    const parsed = new URL(value);
    return ["https:", "http:", "git:", "git+https:", "git+ssh:"].includes(parsed.protocol)
      ? value
      : "NOASSERTION";
  } catch {
    return "NOASSERTION";
  }
}

function declaredLicense(value) {
  if (typeof value !== "string" || value.length === 0) return "NOASSERTION";
  try {
    parseSpdxExpression(value);
    return value;
  } catch {
    // package-lock license metadata is not guaranteed to use SPDX syntax
    // (`UNLICENSED` is common). Do not emit an invalid SPDX expression or
    // infer legal meaning from free-form registry metadata.
    return "NOASSERTION";
  }
}

function dependencyCandidates(ownerPath, dependencyName) {
  const candidates = [];
  let current = ownerPath;
  while (true) {
    candidates.push(current === ""
      ? `node_modules/${dependencyName}`
      : `${current}/node_modules/${dependencyName}`);
    if (current === "") break;
    const nested = current.lastIndexOf("/node_modules/");
    if (nested !== -1) current = current.slice(0, nested);
    else if (current.startsWith("node_modules/")) current = "";
    else current = "";
  }
  return [...new Set(candidates)];
}

const lockfilePath = resolve(argValue("--lockfile", "package-lock.json"));
const toolchainPath = resolve(argValue("--toolchain", "release-toolchain.json"));
const outputPath = resolve(argValue("--output", "dist/agenc-core.spdx.json"));
const lockfileBytes = readFileSync(lockfilePath);
const lockfileSha256 = sha256(lockfileBytes);
const toolchainBytes = readFileSync(toolchainPath);
const toolchainSha256 = sha256(toolchainBytes);
const lock = JSON.parse(lockfileBytes);
const toolchain = JSON.parse(toolchainBytes);
const sourceCommitSha = sourceCommit();
const created = new Date(sourceDateEpoch() * 1000).toISOString();

if (lock.lockfileVersion !== 3 || lock.packages === null || typeof lock.packages !== "object") {
  throw new Error("expected npm package-lock.json v3 with a packages object");
}
const rootEntry = lock.packages[""];
if (rootEntry === null || typeof rootEntry !== "object") {
  throw new Error("package-lock.json is missing its root package");
}
const rootName = rootEntry.name ?? lock.name;
const rootVersion = rootEntry.version ?? lock.version;
if (typeof rootName !== "string" || typeof rootVersion !== "string") {
  throw new Error("package-lock.json root package requires name and version");
}

const workspacePaths = new Set([""]);
for (const entry of Object.values(lock.packages)) {
  if (entry?.link === true && typeof entry.resolved === "string") {
    workspacePaths.add(entry.resolved.replaceAll("\\", "/"));
  }
}

const recordsByIdentity = new Map();
const identityByPath = new Map();
for (const [rawPath, entry] of Object.entries(lock.packages).sort(([a], [b]) => utf8Compare(a, b))) {
  const path = rawPath.replaceAll("\\", "/");
  if (entry?.link === true) continue;
  const name = path === "" ? rootName : packageNameFromPath(path, entry);
  const version = path === "" ? rootVersion : entry.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`lockfile package ${path || "(root)"} has no version`);
  }
  const isWorkspace = workspacePaths.has(path);
  const identity = isWorkspace
    ? `workspace:${path}:${name}@${version}`
    : `npm:${name}@${version}:${entry.integrity ?? entry.resolved ?? path}`;
  let record = recordsByIdentity.get(identity);
  if (record === undefined) {
    record = { identity, name, version, entry, isWorkspace, paths: [] };
    recordsByIdentity.set(identity, record);
  }
  record.paths.push(path);
  identityByPath.set(path, identity);
}
for (const [rawPath, entry] of Object.entries(lock.packages)) {
  if (entry?.link !== true || typeof entry.resolved !== "string") continue;
  const target = entry.resolved.replaceAll("\\", "/");
  const identity = identityByPath.get(target);
  if (identity === undefined) throw new Error(`workspace link ${rawPath} has no target ${target}`);
  identityByPath.set(rawPath.replaceAll("\\", "/"), identity);
}

for (const record of recordsByIdentity.values()) {
  const suffix = sha256(record.identity).slice(0, 20);
  record.spdxId = `SPDXRef-Package-${sanitizeSpdxId(`${record.name}-${record.version}`)}-${suffix}`;
}
const rootIdentity = identityByPath.get("");
const rootRecord = recordsByIdentity.get(rootIdentity);
if (rootRecord === undefined) throw new Error("could not identify the root SPDX package");

function resolveDependency(ownerPath, name) {
  for (const candidate of dependencyCandidates(ownerPath, name)) {
    const identity = identityByPath.get(candidate);
    if (identity !== undefined) return recordsByIdentity.get(identity);
  }
  return undefined;
}

const relationships = [{
  spdxElementId: "SPDXRef-DOCUMENT",
  relationshipType: "DESCRIBES",
  relatedSpdxElement: rootRecord.spdxId,
}];
const relationshipKeys = new Set(relationships.map((relationship) => JSON.stringify(relationship)));
function addRelationship(spdxElementId, relationshipType, relatedSpdxElement) {
  if (spdxElementId === relatedSpdxElement) return;
  const relationship = { spdxElementId, relationshipType, relatedSpdxElement };
  const key = JSON.stringify(relationship);
  if (relationshipKeys.has(key)) return;
  relationshipKeys.add(key);
  relationships.push(relationship);
}

for (const workspacePath of [...workspacePaths].filter(Boolean).sort(utf8Compare)) {
  const identity = identityByPath.get(workspacePath);
  const workspace = recordsByIdentity.get(identity);
  if (workspace === undefined) throw new Error(`workspace ${workspacePath} has no package record`);
  addRelationship(rootRecord.spdxId, "CONTAINS", workspace.spdxId);
}

for (const [rawPath, entry] of Object.entries(lock.packages).sort(([a], [b]) => utf8Compare(a, b))) {
  if (entry?.link === true) continue;
  const ownerPath = rawPath.replaceAll("\\", "/");
  const owner = recordsByIdentity.get(identityByPath.get(ownerPath));
  if (owner === undefined) throw new Error(`lockfile package ${ownerPath} has no SPDX record`);
  const optionalNames = new Set(Object.keys(entry.optionalDependencies ?? {}));
  const devNames = new Set(Object.keys(entry.devDependencies ?? {}));
  const peerNames = new Set(Object.keys(entry.peerDependencies ?? {}));
  const names = new Set([
    ...Object.keys(entry.dependencies ?? {}),
    ...optionalNames,
    ...devNames,
    ...peerNames,
  ]);
  for (const name of [...names].sort(utf8Compare)) {
    const dependency = resolveDependency(ownerPath, name);
    const optionalPeer = entry.peerDependenciesMeta?.[name]?.optional === true;
    const optional = optionalNames.has(name) || optionalPeer;
    if (dependency === undefined) {
      if (optional) continue;
      throw new Error(`lockfile cannot resolve ${name} required by ${ownerPath || "(root)"}`);
    }
    if (optional) {
      addRelationship(dependency.spdxId, "OPTIONAL_DEPENDENCY_OF", owner.spdxId);
    } else if (devNames.has(name)) {
      addRelationship(dependency.spdxId, "DEV_DEPENDENCY_OF", owner.spdxId);
    } else {
      addRelationship(owner.spdxId, "DEPENDS_ON", dependency.spdxId);
    }
  }
}

const npmPackages = [...recordsByIdentity.values()].map((record) => {
  const workspacePath = record.paths.find((path) => workspacePaths.has(path));
  const checksum = integrityChecksum(record.entry.integrity);
  const downloadLocation = record.isWorkspace
    ? `${REPOSITORY_VCS}@${sourceCommitSha}${workspacePath ? `#${workspacePath}` : ""}`
    : validDownloadLocation(record.entry.resolved);
  return {
    name: record.name,
    SPDXID: record.spdxId,
    versionInfo: record.version,
    downloadLocation,
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: declaredLicense(record.entry.license),
    copyrightText: "NOASSERTION",
    ...(checksum === undefined ? {} : { checksums: [checksum] }),
    externalRefs: [{
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: purlForPackage(record.name, record.version),
    }],
    comment: `npm lockfile path${record.paths.length === 1 ? "" : "s"}: ${record.paths
      .map((path) => path || "(root)")
      .sort(utf8Compare)
      .join(", ")}`,
  };
});

function componentSpdxId(identity, name, version) {
  return `SPDXRef-Package-${sanitizeSpdxId(`${name}-${version}`)}-${sha256(identity).slice(0, 20)}`;
}

function componentPurl(type, name, version, qualifiers) {
  const query = Object.entries(qualifiers)
    .sort(([left], [right]) => utf8Compare(left, right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `pkg:${type}/${encodeURIComponent(name)}@${encodeURIComponent(version)}?${query}`;
}

if (
  toolchain.schemaVersion !== 1 ||
  !/^\d+\.\d+\.\d+$/.test(toolchain.nodeVersion ?? "") ||
  toolchain.nodeMajor !== Number(toolchain.nodeVersion.split(".")[0]) ||
  toolchain.nodeDistributions === null ||
  typeof toolchain.nodeDistributions !== "object"
) {
  throw new Error("release-toolchain.json has an invalid embedded Node contract");
}

const expectedNodeTargets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win-x64",
];
const nodeTargets = Object.keys(toolchain.nodeDistributions).sort(utf8Compare);
if (JSON.stringify(nodeTargets) !== JSON.stringify(expectedNodeTargets)) {
  throw new Error("release-toolchain.json must describe the five embedded Node targets");
}

const componentPackages = [];
for (const target of expectedNodeTargets) {
  const distribution = toolchain.nodeDistributions[target];
  const [platform, arch] = target.split("-");
  if (
    distribution === null ||
    typeof distribution !== "object" ||
    typeof distribution.file !== "string" ||
    !/^[0-9a-f]{64}$/.test(distribution.sha256 ?? "") ||
    !Number.isSafeInteger(distribution.bytes) ||
    distribution.bytes <= 0
  ) {
    throw new Error(`release-toolchain.json has an invalid Node distribution for ${target}`);
  }
  const expectedFile =
    `node-v${toolchain.nodeVersion}-${target}.${platform === "win" ? "zip" : "tar.gz"}`;
  if (distribution.file !== expectedFile) {
    throw new Error(`release-toolchain.json has a non-canonical Node filename for ${target}`);
  }
  const identity = `embedded-node:${target}:${toolchain.nodeVersion}:${distribution.sha256}`;
  const spdxId = componentSpdxId(identity, `node-${target}`, toolchain.nodeVersion);
  componentPackages.push({
    name: `Node.js runtime (${target})`,
    SPDXID: spdxId,
    versionInfo: toolchain.nodeVersion,
    downloadLocation:
      `https://nodejs.org/dist/v${toolchain.nodeVersion}/${distribution.file}`,
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "MIT",
    copyrightText: "NOASSERTION",
    checksums: [{ algorithm: "SHA256", checksumValue: distribution.sha256 }],
    externalRefs: [{
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: componentPurl("generic", "nodejs", toolchain.nodeVersion, {
        arch,
        os: platform,
      }),
    }],
    comment:
      `Embedded private Node distribution ${distribution.file}; ${distribution.bytes} bytes. ` +
      "The extracted executable and bundled license are additionally bound by runtime identity.json.",
  });
  addRelationship(rootRecord.spdxId, "CONTAINS", spdxId);
}

const libatomicPackage = toolchain.linux?.builderPackages?.libatomic;
const libatomicInventory = toolchain.linux?.rpmContentInventory;
const nodeBootstrap = toolchain.nodeBootstrap;
const libatomicMatch = /^libatomic-(\d+\.\d+\.\d+-\d+\.[A-Za-z0-9_]+)$/.exec(
  libatomicPackage ?? "",
);
if (
  libatomicMatch === null ||
  nodeBootstrap?.schemaVersion !== 1 ||
  nodeBootstrap.libatomicPackage !== libatomicPackage ||
  nodeBootstrap.licenseExpression !== "GPL-3.0-or-later WITH GCC-exception-3.1" ||
  !/^[0-9a-f]{64}$/.test(nodeBootstrap.licenses?.copying3Sha256 ?? "") ||
  !/^[0-9a-f]{64}$/.test(nodeBootstrap.licenses?.runtimeExceptionSha256 ?? "") ||
  libatomicInventory?.schemaVersion !== 1 ||
  !Array.isArray(libatomicInventory.signatureKeyIds) ||
  libatomicInventory.signatureKeyIds.length === 0
) {
  throw new Error("release-toolchain.json has an invalid embedded libatomic contract");
}
for (const [arch, rpmArch] of [["x64", "x86_64"], ["arm64", "aarch64"]]) {
  const inventorySha256 = libatomicInventory.sha256?.[arch];
  const bootstrap = nodeBootstrap[`linux-${arch}`];
  if (
    !/^[0-9a-f]{64}$/.test(inventorySha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(bootstrap?.librarySha256 ?? "") ||
    !Number.isSafeInteger(bootstrap?.libraryBytes) ||
    bootstrap.libraryBytes <= 0 ||
    !/^[0-9a-f]{64}$/.test(bootstrap?.sha256 ?? "") ||
    !Number.isSafeInteger(bootstrap?.bytes) ||
    bootstrap.bytes <= 0
  ) {
    throw new Error(`release-toolchain.json has no libatomic content identity for ${arch}`);
  }
  const identity =
    `embedded-libatomic:${arch}:${libatomicMatch[1]}:${bootstrap.librarySha256}`;
  const spdxId = componentSpdxId(identity, `libatomic-linux-${arch}`, libatomicMatch[1]);
  componentPackages.push({
    name: `libatomic runtime (linux-${arch})`,
    SPDXID: spdxId,
    versionInfo: libatomicMatch[1],
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "GPL-3.0-or-later WITH GCC-exception-3.1",
    copyrightText: "NOASSERTION",
    checksums: [{ algorithm: "SHA256", checksumValue: bootstrap.librarySha256 }],
    externalRefs: [{
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: componentPurl("rpm", "libatomic", libatomicMatch[1], {
        arch: rpmArch,
        distro: "rocky-8",
      }),
    }],
    comment:
      `Exact embedded libatomic.so.1 (${bootstrap.libraryBytes} bytes) from ` +
      `${libatomicPackage}; bootstrap archive sha256:${bootstrap.sha256}. ` +
      `GPLv3 sha256:${nodeBootstrap.licenses.copying3Sha256}; GCC Runtime Library ` +
      `Exception sha256:${nodeBootstrap.licenses.runtimeExceptionSha256}. ` +
      `The signed builder RPM inventory is sha256:${inventorySha256} ` +
      `(signer ${libatomicInventory.signatureKeyIds.join(", ")}).`,
  });
  addRelationship(rootRecord.spdxId, "CONTAINS", spdxId);
}

const packages = [...npmPackages, ...componentPackages]
  .sort((left, right) => utf8Compare(left.SPDXID, right.SPDXID));

relationships.sort((left, right) => utf8Compare(
  `${left.spdxElementId}\0${left.relationshipType}\0${left.relatedSpdxElement}`,
  `${right.spdxElementId}\0${right.relationshipType}\0${right.relatedSpdxElement}`,
));
const graphSha256 = sha256(`${JSON.stringify({ packages, relationships })}\n`);
const document = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `${rootName}@${rootVersion}`,
  documentNamespace:
    `https://tetsuo.ai/agenc-core/sbom/v${GENERATOR_REVISION}/` +
    `${sourceCommitSha}/${lockfileSha256}/${toolchainSha256}/${graphSha256}`,
  creationInfo: {
    created,
    creators: ["Organization: Tetsuo AI", `Tool: agenc-core-spdx-sbom-${GENERATOR_REVISION}`],
    comment:
      `Repository dependency and distributed runtime-component SBOM for git:${sourceCommitSha}; ` +
      `package-lock.json sha256:${lockfileSha256}; ` +
      `release-toolchain.json sha256:${toolchainSha256}; graph sha256:${graphSha256}`,
  },
  packages,
  relationships,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(
  `wrote ${outputPath} (${packages.length} packages, ${relationships.length} relationships)`,
);
