#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY_REPOSITORY = "actions/runner-images";
const MAX_INVENTORY_BYTES = 1024 * 1024;
const MAX_RELEASE_INDEX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const RELEASE_INDEX_URL =
  "https://api.github.com/repos/actions/runner-images/releases?per_page=100&page=1";
const HASH_RE = /^[0-9a-f]{64}$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;
// The trailing component is GitHub's image revision, not always 1: a respin
// of win25-vs2026/20260810.198 ships as 20260810.198.2 and its own inventory
// readme records that. Accept any revision and keep pinning the exact one.
const IMAGE_VERSION_RE = /^\d{8}\.\d{3,4}\.\d+$/u;

const TARGET_CONTRACTS = Object.freeze({
  "darwin-arm64": Object.freeze({
    runnerLabel: "macos-15",
    imageOS: "macos15",
    runnerArch: "ARM64",
    path: "images/macos/macos-15-arm64-Readme.md",
    releasePrefix: "macos-15-arm64/",
    kind: "macos",
  }),
  "darwin-x64": Object.freeze({
    runnerLabel: "macos-15-intel",
    imageOS: "macos15",
    runnerArch: "X64",
    path: "images/macos/macos-15-Readme.md",
    releasePrefix: "macos-15/",
    kind: "macos",
  }),
  "win-x64": Object.freeze({
    runnerLabel: "windows-2025-vs2026",
    imageOS: "win25-vs2026",
    runnerArch: "X64",
    path: "images/windows/Windows2025-VS2026-Readme.md",
    releasePrefix: "win25-vs2026/",
    kind: "windows",
  }),
});

function fail(message) {
  throw new Error(`hosted runner contract: ${message}`);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value;
}

function requireExactKeys(value, expected, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${field} keys must be exactly ${wanted.join(", ")}`);
  }
}

function uniqueMatch(text, pattern, field) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) {
    fail(`${field} must appear exactly once in the inventory`);
  }
  return matches[0];
}

function inventoryCommit(profile, target) {
  const expected = TARGET_CONTRACTS[target];
  const urlPattern = new RegExp(
    `^https://raw\\.githubusercontent\\.com/${INVENTORY_REPOSITORY}/` +
      `([0-9a-f]{40})/${expected.path.replaceAll(".", "\\.")}$`,
    "u",
  );
  return urlPattern.exec(profile.inventoryUrl)?.[1];
}

export function validateHostedRunnerInventoryConfig(toolchain) {
  const contracts = toolchain?.hostedRunners;
  requireExactKeys(
    contracts,
    Object.keys(TARGET_CONTRACTS),
    "hostedRunners",
  );

  for (const [target, expected] of Object.entries(TARGET_CONTRACTS)) {
    const contract = contracts[target];
    requireExactKeys(
      contract,
      ["imageOS", "imageProfiles", "runnerArch", "runnerLabel"],
      `hostedRunners.${target}`,
    );
    for (const field of ["runnerLabel", "imageOS", "runnerArch"]) {
      if (contract[field] !== expected[field]) {
        fail(
          `hostedRunners.${target}.${field} must be ${expected[field]}`,
        );
      }
    }

    const profiles = contract.imageProfiles;
    if (!Array.isArray(profiles) || profiles.length === 0) {
      fail(`hostedRunners.${target}.imageProfiles must be a non-empty array`);
    }
    const seenVersions = new Set();
    for (const [index, profile] of profiles.entries()) {
      const field = `hostedRunners.${target}.imageProfiles[${index}]`;
      const profileKeys =
        expected.kind === "macos"
          ? [
              "clangVersion",
              "imageVersion",
              "inventoryBytes",
              "inventorySha256",
              "inventoryUrl",
              "macosSdkVersion",
              "xcodeBuild",
              "xcodeVersion",
            ]
          : [
              "imageVersion",
              "inventoryBytes",
              "inventorySha256",
              "inventoryUrl",
              "msvcCompilerSha256",
              "msvcCompilerVersion",
              "msvcLinkerSha256",
              "msvcToolsVersion",
              "visualStudioInstallPath",
              "visualStudioVersion",
              "windowsSdkVersion",
            ];
      requireExactKeys(
        profile,
        profileKeys,
        field,
      );
      if (
        !IMAGE_VERSION_RE.test(
          requireString(profile.imageVersion, `${field}.imageVersion`),
        )
      ) {
        fail(`${field}.imageVersion is invalid`);
      }
      if (seenVersions.has(profile.imageVersion)) {
        fail(`${field}.imageVersion is duplicated`);
      }
      seenVersions.add(profile.imageVersion);
      requireString(profile.inventoryUrl, `${field}.inventoryUrl`);
      const commit = inventoryCommit(profile, target);
      if (!commit || !COMMIT_RE.test(commit)) {
        fail(`${field}.inventoryUrl must pin the exact official inventory commit`);
      }
      if (
        !Number.isSafeInteger(profile.inventoryBytes) ||
        profile.inventoryBytes <= 0 ||
        profile.inventoryBytes > MAX_INVENTORY_BYTES
      ) {
        fail(
          `${field}.inventoryBytes must be between 1 and ${MAX_INVENTORY_BYTES}`,
        );
      }
      if (
        !HASH_RE.test(
          requireString(profile.inventorySha256, `${field}.inventorySha256`),
        )
      ) {
        fail(`${field}.inventorySha256 must be a lowercase SHA-256 digest`);
      }
      if (expected.kind === "windows") {
        for (const hashField of [
          "msvcCompilerSha256",
          "msvcLinkerSha256",
        ]) {
          if (
            !HASH_RE.test(requireString(profile[hashField], `${field}.${hashField}`))
          ) {
            fail(`${field}.${hashField} must be a lowercase SHA-256 digest`);
          }
        }
      }
    }
  }

  return contracts;
}

function runnerReleaseVersion(tag, prefix) {
  if (!tag.startsWith(prefix)) return undefined;
  const suffix = tag.slice(prefix.length);
  const match = /^(\d{8})\.(\d{3,4})$/u.exec(suffix);
  if (!match) fail(`official runner release tag is invalid: ${tag}`);
  return {
    // GitHub respins an image without cutting a new release, so the deployed
    // revision is not always `.1`: win25-vs2026/20260810.198 ships
    // 20260810.198.2. The release tag identifies the build; the trailing
    // revision is GitHub's, not ours, so match on the build and let the
    // pinned profile carry whichever revision the fleet actually serves.
    imageVersionPrefix: `${suffix}.`,
    date: Number(match[1]),
    build: Number(match[2]),
  };
}

function compareReleaseVersion(left, right) {
  return left.date - right.date || left.build - right.build;
}

export function requiredHostedRunnerReleases(contracts, releases) {
  if (!Array.isArray(releases)) {
    fail("official runner release index must be an array");
  }
  const required = new Map();
  for (const [target, expected] of Object.entries(TARGET_CONTRACTS)) {
    const candidates = [];
    const tags = new Set();
    for (const release of releases) {
      if (
        release === null ||
        typeof release !== "object" ||
        Array.isArray(release) ||
        typeof release.tag_name !== "string" ||
        !release.tag_name.startsWith(expected.releasePrefix)
      ) {
        continue;
      }
      if (
        typeof release.draft !== "boolean" ||
        typeof release.prerelease !== "boolean"
      ) {
        fail(`official runner release metadata is invalid for ${release.tag_name}`);
      }
      if (release.draft) continue;
      if (tags.has(release.tag_name)) {
        fail(`official runner release index duplicated ${release.tag_name}`);
      }
      tags.add(release.tag_name);
      if (
        typeof release.target_commitish !== "string" ||
        !COMMIT_RE.test(release.target_commitish)
      ) {
        fail(
          `official runner release ${release.tag_name} is not bound to an exact commit`,
        );
      }
      candidates.push({
        ...runnerReleaseVersion(release.tag_name, expected.releasePrefix),
        tag: release.tag_name,
        commit: release.target_commitish,
        prerelease: release.prerelease,
      });
    }
    const stable = candidates
      .filter(({ prerelease }) => !prerelease)
      .sort(compareReleaseVersion)
      .at(-1);
    if (!stable) {
      fail(
        `official runner release index has no stable ${expected.releasePrefix} release`,
      );
    }
    const active = [
      stable,
      ...candidates.filter(
        (candidate) =>
          candidate.prerelease &&
          compareReleaseVersion(candidate, stable) > 0,
      ),
    ].sort(compareReleaseVersion);
    for (const release of active) {
      const profile = contracts[target].imageProfiles.find(({ imageVersion }) =>
        imageVersion.startsWith(release.imageVersionPrefix),
      );
      if (!profile) {
        fail(
          `${target} is missing active official runner image ${release.imageVersionPrefix}* (${release.tag})`,
        );
      }
      if (inventoryCommit(profile, target) !== release.commit) {
        fail(
          `${target} ${profile.imageVersion} inventory commit does not match the official release`,
        );
      }
    }
    required.set(target, active);
  }
  return required;
}

export function parseMacosInventory(text) {
  const imageVersion = uniqueMatch(
    text,
    /^- Image Version:\s*(\S+)\s*$/gmu,
    "macOS image version",
  )[1];
  const clangVersion = uniqueMatch(
    text,
    /^- Clang\/LLVM ([0-9.]+)\s*$/gmu,
    "macOS Clang version",
  )[1];
  const xcode = uniqueMatch(
    text,
    /^\|\s*([0-9.]+) \(default\)\s*\|\s*([0-9A-Za-z]+)\s*\|/gmu,
    "default Xcode row",
  );
  const sdkRows = [
    ...text.matchAll(
      /^\|\s*macOS ([0-9.]+)\s*\|\s*macosx[0-9.]+\s*\|\s*([0-9.]+)\s*\|/gmu,
    ),
  ].map((match) => ({
    macosSdkVersion: match[1],
    xcodeVersion: match[2],
  }));
  if (sdkRows.length === 0) {
    fail("macOS SDK inventory is missing");
  }
  return {
    imageVersion,
    clangVersion,
    xcodeVersion: xcode[1],
    xcodeBuild: xcode[2],
    sdkRows,
  };
}

export function parseWindowsInventory(text) {
  const imageVersion = uniqueMatch(
    text,
    /^- Image Version:\s*(\S+)\s*$/gmu,
    "Windows image version",
  )[1];
  const visualStudio = uniqueMatch(
    text,
    /^\|\s*Visual Studio Enterprise 2026\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gmu,
    "Visual Studio inventory row",
  );
  const sdkSection = uniqueMatch(
    text,
    /^#### Installed Windows SDKs\s*$([\s\S]*?)(?=^#### |^### |(?![\s\S]))/gmu,
    "installed Windows SDK section",
  )[1];
  const windowsSdks = [
    ...sdkSection.matchAll(/^- ([0-9]+(?:\.[0-9]+){3})\s*$/gmu),
  ].map((match) => match[1]);
  if (windowsSdks.length === 0) {
    fail("Windows SDK inventory is empty");
  }
  const visualCpp = uniqueMatch(
    text,
    /^\|\s*Microsoft Visual C\+\+ 2022 Minimum Runtime\s*\|\s*x64\s*\|\s*([0-9.]+)\s*\|$/gmu,
    "x64 Visual C++ runtime row",
  );
  return {
    imageVersion,
    visualStudioVersion: visualStudio[1].trim(),
    visualStudioInstallPath: visualStudio[2].trim(),
    visualCppRuntimeVersion: visualCpp[1],
    windowsSdks,
  };
}

function assertParsedFacts(target, contract, parsed) {
  if (parsed.imageVersion !== contract.imageVersion) {
    fail(
      `${target} inventory image ${parsed.imageVersion} does not match ${contract.imageVersion}`,
    );
  }
  if (target.startsWith("darwin-")) {
    const clang = /^Apple clang version ([0-9.]+) \(/u.exec(
      requireString(contract.clangVersion, `hostedRunners.${target}.clangVersion`),
    );
    if (!clang || clang[1] !== parsed.clangVersion) {
      fail(`${target} Clang inventory does not match release-toolchain.json`);
    }
    if (
      parsed.xcodeVersion !== contract.xcodeVersion ||
      parsed.xcodeBuild !== contract.xcodeBuild
    ) {
      fail(`${target} default Xcode inventory does not match release-toolchain.json`);
    }
    if (
      !parsed.sdkRows.some(
        (row) =>
          row.macosSdkVersion === contract.macosSdkVersion &&
          row.xcodeVersion === contract.xcodeVersion,
      )
    ) {
      fail(`${target} macOS SDK inventory does not match release-toolchain.json`);
    }
    return;
  }

  if (
    parsed.visualStudioVersion !== contract.visualStudioVersion ||
    parsed.visualStudioInstallPath !== contract.visualStudioInstallPath
  ) {
    fail(`${target} Visual Studio inventory does not match release-toolchain.json`);
  }
  if (!parsed.windowsSdks.includes(contract.windowsSdkVersion)) {
    fail(`${target} Windows SDK inventory does not match release-toolchain.json`);
  }
  const tools = /^([0-9]+\.[0-9]+)\.[0-9]+$/u.exec(
    requireString(contract.msvcToolsVersion, `hostedRunners.${target}.msvcToolsVersion`),
  );
  if (!tools || !parsed.visualCppRuntimeVersion.startsWith(`${tools[1]}.`)) {
    fail(`${target} Visual C++ inventory does not match the MSVC toolset family`);
  }
  if (
    !/^19\.[0-9]+\.[0-9]+$/u.test(
      requireString(
        contract.msvcCompilerVersion,
        `hostedRunners.${target}.msvcCompilerVersion`,
      ),
    )
  ) {
    fail(`hostedRunners.${target}.msvcCompilerVersion is invalid`);
  }
}

async function readExactBytes(response, expectedBytes, target) {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) !== expectedBytes)
  ) {
    fail(`${target} Content-Length does not match the pinned byte count`);
  }
  if (!response.body) {
    fail(`${target} inventory response has no body`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > expectedBytes || total > MAX_INVENTORY_BYTES) {
      await reader.cancel();
      fail(`${target} inventory exceeded the pinned byte count`);
    }
    chunks.push(value);
  }
  if (total !== expectedBytes) {
    fail(`${target} inventory byte count ${total} does not match ${expectedBytes}`);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedBytes(response, maximumBytes, label) {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumBytes)
  ) {
    fail(`${label} Content-Length exceeds the ${maximumBytes}-byte limit`);
  }
  if (!response.body) fail(`${label} response has no body`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      fail(`${label} exceeded the ${maximumBytes}-byte limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchOfficialReleaseIndex(fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(RELEASE_INDEX_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "agenc-hosted-runner-contract",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok || response.status !== 200) {
      fail(`official runner release index returned HTTP ${response.status}`);
    }
    if (response.url && response.url !== RELEASE_INDEX_URL) {
      fail("official runner release index response URL changed");
    }
    const bytes = await readBoundedBytes(
      response,
      MAX_RELEASE_INDEX_BYTES,
      "official runner release index",
    );
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      fail("official runner release index is not valid UTF-8 JSON");
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchProfile(fetchImpl, target, profile) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(profile.inventoryUrl, {
      headers: {
        Accept: "text/plain",
        "Accept-Encoding": "identity",
        "User-Agent": "agenc-hosted-runner-contract",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok || response.status !== 200) {
      fail(`${target} inventory returned HTTP ${response.status}`);
    }
    if (response.url && response.url !== profile.inventoryUrl) {
      fail(`${target} inventory response URL changed`);
    }
    return await readExactBytes(response, profile.inventoryBytes, target);
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyHostedRunnerInventories({
  toolchain,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    fail("fetch is unavailable");
  }
  const contracts = validateHostedRunnerInventoryConfig(toolchain);
  const releases = await fetchOfficialReleaseIndex(fetchImpl);
  requiredHostedRunnerReleases(contracts, releases);
  const tasks = [];
  for (const [target, contract] of Object.entries(contracts)) {
    for (const profile of contract.imageProfiles) {
      tasks.push(
        (async () => {
          const bytes = await fetchProfile(fetchImpl, target, profile);
          const digest = createHash("sha256").update(bytes).digest("hex");
          if (digest !== profile.inventorySha256) {
            fail(`${target} ${profile.imageVersion} inventory SHA-256 changed`);
          }
          let text;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            fail(`${target} ${profile.imageVersion} inventory is not valid UTF-8`);
          }
          const parsed =
            TARGET_CONTRACTS[target].kind === "macos"
              ? parseMacosInventory(text)
              : parseWindowsInventory(text);
          assertParsedFacts(target, profile, parsed);
          return {
            target,
            imageVersion: profile.imageVersion,
            bytes: profile.inventoryBytes,
            sha256: profile.inventorySha256,
          };
        })(),
      );
    }
  }
  return Promise.all(tasks);
}

async function main() {
  const toolchain = JSON.parse(
    await readFile(resolve(repoRoot, "release-toolchain.json"), "utf8"),
  );
  const verified = await verifyHostedRunnerInventories({ toolchain });
  for (const record of verified) {
    console.log(
      `[hosted-runner-contract] ${record.target} ${record.imageVersion}: ${record.bytes} bytes sha256:${record.sha256}`,
    );
  }
  console.log(
    `[hosted-runner-contract] verified the current official release index and ${verified.length} immutable hosted-runner inventories`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(
      `[hosted-runner-contract] FAILED: ${error?.message ?? String(error)}`,
    );
    process.exitCode = 1;
  });
}
