#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

const lockfilePath = resolve(argValue("--lockfile", "package-lock.json"));
const outputPath = resolve(argValue("--output", "dist/agenc-core.spdx.json"));
const created = new Date().toISOString();
const lock = JSON.parse(readFileSync(lockfilePath, "utf8"));

if (lock.lockfileVersion !== 3 || typeof lock.packages !== "object") {
  throw new Error("expected npm package-lock.json v3 with a packages object");
}

function sanitizeSpdxId(value) {
  return value.replace(/[^A-Za-z0-9.-]/g, "-").replace(/^-+|-+$/g, "");
}

function packageNameFromPath(path, entry) {
  if (typeof entry.name === "string" && entry.name.length > 0) return entry.name;
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  return index === -1 ? path : path.slice(index + marker.length);
}

function packageVersion(entry) {
  return typeof entry.version === "string" && entry.version.length > 0
    ? entry.version
    : "0.0.0";
}

function purlForPackage(name, version) {
  const encoded = name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`;
}

const rootEntry = lock.packages[""];
const rootName =
  typeof rootEntry?.name === "string" && rootEntry.name.length > 0
    ? rootEntry.name
    : lock.name ?? "agenc-core";
const rootVersion =
  typeof rootEntry?.version === "string" && rootEntry.version.length > 0
    ? rootEntry.version
    : lock.version ?? "0.0.0";
const rootSpdxId = `SPDXRef-Package-${sanitizeSpdxId(`${rootName}-${rootVersion}`)}`;
const packages = [];
const relationships = [
  {
    spdxElementId: "SPDXRef-DOCUMENT",
    relationshipType: "DESCRIBES",
    relatedSpdxElement: rootSpdxId,
  },
];

for (const [path, entry] of Object.entries(lock.packages)) {
  const name = path === "" ? rootName : packageNameFromPath(path, entry);
  const version = path === "" ? rootVersion : packageVersion(entry);
  const spdxId =
    path === ""
      ? rootSpdxId
      : `SPDXRef-Package-${sanitizeSpdxId(`${name}-${version}-${path}`)}`;
  const license =
    typeof entry.license === "string" && entry.license.length > 0
      ? entry.license
      : "NOASSERTION";
  const pkg = {
    name,
    SPDXID: spdxId,
    versionInfo: version,
    downloadLocation:
      typeof entry.resolved === "string" && entry.resolved.length > 0
        ? entry.resolved
        : "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: license,
    copyrightText: "NOASSERTION",
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: purlForPackage(name, version),
      },
    ],
  };
  packages.push(pkg);
  if (path !== "") {
    relationships.push({
      spdxElementId: rootSpdxId,
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: spdxId,
    });
  }
}

const document = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `${rootName}@${rootVersion}`,
  documentNamespace: `https://tetsuo.ai/agenc-core/sbom/${encodeURIComponent(
    rootName,
  )}-${encodeURIComponent(rootVersion)}-${created.replace(/[:.]/g, "-")}`,
  creationInfo: {
    created,
    creators: ["Organization: Tetsuo AI", "Tool: agenc-core-spdx-sbom"],
  },
  packages,
  relationships,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(
  `wrote ${outputPath} (${packages.length} packages, ${relationships.length} relationships)`,
);
