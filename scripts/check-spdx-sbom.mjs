#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import parseSpdxExpression from "spdx-expression-parse";

const work = mkdtempSync(join(tmpdir(), "agenc-sbom-check-"));
const output = join(work, "sbom.spdx.json");
const repeatedOutput = join(work, "sbom-repeated.spdx.json");

try {
  for (const path of [output, repeatedOutput]) {
    const generated = spawnSync(
      process.execPath,
      ["scripts/generate-spdx-sbom.mjs", "--output", path],
      {
        encoding: "utf8",
        env: { ...process.env, SOURCE_DATE_EPOCH: "0" },
      },
    );
    if (generated.status !== 0) {
      process.stderr.write(generated.stdout);
      process.stderr.write(generated.stderr);
      process.exit(generated.status ?? 1);
    }
  }

  const generatedBytes = readFileSync(output, "utf8");
  assertEqual(readFileSync(repeatedOutput, "utf8"), generatedBytes, "repeated SBOM bytes");
  const document = JSON.parse(generatedBytes);
  const lockfileBytes = readFileSync("package-lock.json");
  const lock = JSON.parse(lockfileBytes);
  const lockfileSha = sha256(lockfileBytes);
  const sourceCommit = gitHead();

  assertEqual(document.spdxVersion, "SPDX-2.3", "spdxVersion");
  assertEqual(document.dataLicense, "CC0-1.0", "dataLicense");
  assertEqual(document.SPDXID, "SPDXRef-DOCUMENT", "document SPDXID");
  assertEqual(document.creationInfo?.created, "1970-01-01T00:00:00.000Z", "creationInfo.created");
  assertArray(document.creationInfo?.creators, "creationInfo.creators");
  assertArray(document.packages, "packages");
  assertArray(document.relationships, "relationships");

  const namespace = document.documentNamespace;
  assertString(namespace, "documentNamespace");
  const namespaceParts = namespace.match(
    /^https:\/\/tetsuo\.ai\/agenc-core\/sbom\/v3\/([0-9a-f]{40,64})\/([0-9a-f]{64})\/([0-9a-f]{64})$/,
  );
  if (namespaceParts === null) throw new Error("SBOM namespace is not source/lock/graph bound");
  assertEqual(namespaceParts[1], sourceCommit, "namespace source commit");
  assertEqual(namespaceParts[2], lockfileSha, "namespace lockfile digest");

  const packageIds = new Set();
  const purls = new Set();
  for (const pkg of document.packages) {
    assertString(pkg.name, "package name");
    assertString(pkg.versionInfo, `${pkg.name} versionInfo`);
    if (!/^SPDXRef-[A-Za-z0-9.-]+$/.test(pkg.SPDXID ?? "")) {
      throw new Error(`invalid package SPDXID: ${pkg.SPDXID}`);
    }
    if (packageIds.has(pkg.SPDXID)) throw new Error(`duplicate package SPDXID: ${pkg.SPDXID}`);
    packageIds.add(pkg.SPDXID);
    if (pkg.filesAnalyzed !== false) throw new Error(`${pkg.name} must declare filesAnalyzed=false`);
    assertDownloadLocation(pkg.downloadLocation, pkg.name);
    if (pkg.licenseConcluded !== "NOASSERTION") {
      throw new Error(`${pkg.name} has an unsupported concluded license assertion`);
    }
    assertString(pkg.licenseDeclared, `${pkg.name} licenseDeclared`);
    if (pkg.licenseDeclared !== "NONE" && pkg.licenseDeclared !== "NOASSERTION") {
      try {
        parseSpdxExpression(pkg.licenseDeclared);
      } catch {
        throw new Error(`${pkg.name} has an invalid SPDX licenseDeclared expression`);
      }
    }
    assertEqual(pkg.copyrightText, "NOASSERTION", `${pkg.name} copyrightText`);
    const purl = pkg.externalRefs?.find((reference) =>
      reference?.referenceCategory === "PACKAGE-MANAGER" &&
      reference?.referenceType === "purl"
    )?.referenceLocator;
    if (typeof purl !== "string" || !purl.startsWith("pkg:npm/")) {
      throw new Error(`${pkg.name} is missing an npm package-url`);
    }
    if (purls.has(purl)) throw new Error(`duplicate package-url identity: ${purl}`);
    purls.add(purl);
    for (const checksum of pkg.checksums ?? []) {
      if (!/^(SHA256|SHA384|SHA512)$/.test(checksum?.algorithm ?? "") ||
          !/^[0-9a-f]+$/.test(checksum?.checksumValue ?? "")) {
        throw new Error(`${pkg.name} has an invalid integrity checksum`);
      }
    }
  }

  const rootPackages = document.packages.filter((pkg) => pkg.name === "agenc-core");
  if (rootPackages.length !== 1) throw new Error("SBOM must contain one agenc-core root package");
  const rootPackage = rootPackages[0];
  assertEqual(rootPackage.versionInfo, lock.packages[""].version, "root package version");
  const workspaceTargets = new Set(
    Object.values(lock.packages)
      .filter((entry) => entry?.link === true && typeof entry.resolved === "string")
      .map((entry) => entry.resolved),
  );
  for (const workspacePath of workspaceTargets) {
    const workspaceEntry = lock.packages[workspacePath];
    const matches = document.packages.filter((pkg) =>
      pkg.name === workspaceEntry.name && pkg.versionInfo === workspaceEntry.version
    );
    if (matches.length !== 1) {
      throw new Error(`workspace ${workspacePath} must map to one canonical SPDX package`);
    }
    if (!document.relationships.some((relationship) =>
      relationship.spdxElementId === rootPackage.SPDXID &&
      relationship.relationshipType === "CONTAINS" &&
      relationship.relatedSpdxElement === matches[0].SPDXID
    )) {
      throw new Error(`root package does not CONTAIN workspace ${workspacePath}`);
    }
  }

  const relationshipKeys = new Set();
  const allowedRelationshipTypes = new Set([
    "CONTAINS",
    "DEPENDS_ON",
    "DESCRIBES",
    "DEV_DEPENDENCY_OF",
    "OPTIONAL_DEPENDENCY_OF",
  ]);
  for (const relationship of document.relationships) {
    if (!allowedRelationshipTypes.has(relationship.relationshipType)) {
      throw new Error(`unsupported relationship type: ${relationship.relationshipType}`);
    }
    if (relationship.spdxElementId !== "SPDXRef-DOCUMENT" &&
        !packageIds.has(relationship.spdxElementId)) {
      throw new Error(`relationship source does not exist: ${relationship.spdxElementId}`);
    }
    if (!packageIds.has(relationship.relatedSpdxElement)) {
      throw new Error(`relationship target does not exist: ${relationship.relatedSpdxElement}`);
    }
    const key = JSON.stringify(relationship);
    if (relationshipKeys.has(key)) throw new Error(`duplicate relationship: ${key}`);
    relationshipKeys.add(key);
  }
  const describes = document.relationships.filter((relationship) =>
    relationship.spdxElementId === "SPDXRef-DOCUMENT" &&
    relationship.relationshipType === "DESCRIBES"
  );
  if (describes.length !== 1 || describes[0].relatedSpdxElement !== rootPackage.SPDXID) {
    throw new Error("SBOM must DESCRIBE exactly the canonical root package");
  }
  if (!document.relationships.some((relationship) =>
    relationship.relationshipType === "DEPENDS_ON" &&
    relationship.spdxElementId !== rootPackage.SPDXID
  )) {
    throw new Error("SBOM dependency graph was flattened onto the root package");
  }

  const canonicalGraph = JSON.stringify({
    packages: document.packages,
    relationships: document.relationships,
  });
  assertEqual(namespaceParts[3], sha256(`${canonicalGraph}\n`), "namespace graph digest");
  if (!document.creationInfo.comment.includes(`git:${sourceCommit}`) ||
      !document.creationInfo.comment.includes(`sha256:${lockfileSha}`) ||
      !document.creationInfo.comment.includes(`graph sha256:${namespaceParts[3]}`)) {
    throw new Error("SBOM creationInfo is not bound to source, lockfile, and graph");
  }

  console.log(
    `SBOM check passed (${document.packages.length} canonical packages, ` +
      `${document.relationships.length} graph relationships)`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0 || !/^[0-9a-f]{40,64}$/.test(result.stdout.trim())) {
    throw new Error("could not resolve Git source commit for SBOM check");
  }
  return result.stdout.trim();
}

function assertDownloadLocation(value, name) {
  if (value === "NONE" || value === "NOASSERTION") return;
  if (typeof value !== "string") throw new Error(`${name} has no downloadLocation`);
  try {
    const url = new URL(value);
    if (!["https:", "http:", "git:", "git+https:", "git+ssh:"].includes(url.protocol)) {
      throw new Error("unsupported scheme");
    }
  } catch {
    throw new Error(`${name} has an invalid SPDX downloadLocation: ${value}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`expected ${label} to be ${expected}, got ${actual}`);
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`expected ${label} to be a non-empty string`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`expected ${label} to be a non-empty array`);
  }
}
