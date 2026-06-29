#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const work = mkdtempSync(join(tmpdir(), "agenc-sbom-check-"));
const output = join(work, "sbom.spdx.json");

try {
  const generated = spawnSync(
    process.execPath,
    ["scripts/generate-spdx-sbom.mjs", "--output", output],
    { encoding: "utf8" },
  );
  if (generated.status !== 0) {
    process.stderr.write(generated.stdout);
    process.stderr.write(generated.stderr);
    process.exit(generated.status ?? 1);
  }

  const document = JSON.parse(readFileSync(output, "utf8"));
  assertEqual(document.spdxVersion, "SPDX-2.3", "spdxVersion");
  assertEqual(document.dataLicense, "CC0-1.0", "dataLicense");
  assertString(document.documentNamespace, "documentNamespace");
  assertArray(document.packages, "packages");
  assertArray(document.relationships, "relationships");

  const rootPackage = document.packages.find(
    (pkg) => pkg.name === "agenc-core",
  );
  if (rootPackage === undefined) {
    throw new Error("SBOM is missing the agenc-core root package");
  }
  if (
    !document.relationships.some(
      (relationship) =>
        relationship.spdxElementId === "SPDXRef-DOCUMENT" &&
        relationship.relationshipType === "DESCRIBES" &&
        relationship.relatedSpdxElement === rootPackage.SPDXID,
    )
  ) {
    throw new Error("SBOM is missing the document DESCRIBES root relationship");
  }

  const runtimePackage = document.packages.find(
    (pkg) => pkg.name === "@tetsuo-ai/runtime",
  );
  if (runtimePackage === undefined) {
    throw new Error("SBOM is missing @tetsuo-ai/runtime");
  }
  const purl = runtimePackage.externalRefs?.find(
    (ref) =>
      ref.referenceCategory === "PACKAGE-MANAGER" &&
      ref.referenceType === "purl",
  );
  if (purl === undefined || typeof purl.referenceLocator !== "string") {
    throw new Error("@tetsuo-ai/runtime is missing a package-url externalRef");
  }

  console.log(
    `SBOM check passed (${document.packages.length} packages, ${document.relationships.length} relationships)`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`expected ${label} to be ${expected}, got ${actual}`);
  }
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
