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
// GitHub lists runner-images releases newest first, 100 to a page. An image
// GitHub no longer refreshes often (macos-15 Intel: its stable release of
// 2026-08-24 had left the first page by 2026-10-22) is still the image the
// runner serves, so the index is read page by page until every target has a
// stable release, within a fixed page budget.
const RELEASE_INDEX_PAGE_SIZE = 100;
const MAX_RELEASE_INDEX_PAGES = 10;
function releaseIndexUrl(page) {
  return `https://api.github.com/repos/actions/runner-images/releases?per_page=${RELEASE_INDEX_PAGE_SIZE}&page=${page}`;
}
// GitHub's own rollout feed per image label: the badge source in the
// actions/runner-images README. It reads {"label":"<deployed>","message":
// "Deployed"} or {"label":"<deployed>","message":"Deploying to <next>"}.
const ROLLOUT_STATUS_ROOT =
  "https://gist.githubusercontent.com/hosted-runners-images-bot/79267492faab096d04cdd25ce7014cec/raw/";
const MAX_ROLLOUT_STATUS_BYTES = 4 * 1024;
const RUNNER_RELEASE_VERSION_RE = /^\d{8}\.\d{3,4}$/u;
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
    rolloutStatus: "macos-15-arm64.json",
    kind: "macos",
  }),
  "darwin-x64": Object.freeze({
    runnerLabel: "macos-15-intel",
    imageOS: "macos15",
    runnerArch: "X64",
    path: "images/macos/macos-15-Readme.md",
    releasePrefix: "macos-15/",
    rolloutStatus: "macos-15.json",
    kind: "macos",
  }),
  "win-x64": Object.freeze({
    runnerLabel: "windows-2025-vs2026",
    imageOS: "win25-vs2026",
    runnerArch: "X64",
    path: "images/windows/Windows2025-VS2026-Readme.md",
    releasePrefix: "win25-vs2026/",
    rolloutStatus: "win25-vs2026.json",
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
    version: suffix,
    date: Number(match[1]),
    build: Number(match[2]),
  };
}

/**
 * Parse one rollout feed document. Returns null for anything that is not
 * exactly the two shapes the feed publishes, so callers fail closed.
 */
export function parseRolloutStatus(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const { label, message } = value;
  if (typeof label !== "string" || !RUNNER_RELEASE_VERSION_RE.test(label)) {
    return null;
  }
  if (message === "Deployed") return { deployed: label, deploying: null };
  const deploying =
    typeof message === "string" ? /^Deploying to (\S+)$/u.exec(message)?.[1] : undefined;
  if (deploying === undefined || !RUNNER_RELEASE_VERSION_RE.test(deploying)) {
    return null;
  }
  return { deployed: label, deploying };
}

function compareReleaseVersion(left, right) {
  return left.date - right.date || left.build - right.build;
}

/**
 * The latest stable release of each image label, plus every newer prerelease
 * that GitHub actually serves. A prerelease is served when the rollout feed
 * names it as deployed or as the deployment target. Without a usable feed
 * (missing, unreadable, or naming a version absent from the release index)
 * every newer prerelease stays required: the feed can only relax the check
 * for a prerelease GitHub has not started rolling out. The release preflight
 * on each hosted runner still rejects an image without a reviewed profile.
 */
export function requiredHostedRunnerReleases(
  contracts,
  releases,
  { rolloutStatuses = {}, onSkippedPrerelease } = {},
) {
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
    const status = rolloutStatuses[target] ?? null;
    const knownVersions = new Set(candidates.map(({ version }) => version));
    const statusUsable =
      status !== null &&
      knownVersions.has(status.deployed) &&
      (status.deploying === null || knownVersions.has(status.deploying));
    const served = (candidate) =>
      !statusUsable ||
      candidate.version === status.deployed ||
      candidate.version === status.deploying;
    const newerPrereleases = candidates.filter(
      (candidate) =>
        candidate.prerelease && compareReleaseVersion(candidate, stable) > 0,
    );
    for (const candidate of newerPrereleases) {
      if (!served(candidate)) onSkippedPrerelease?.(target, candidate.tag, status);
    }
    const active = [stable, ...newerPrereleases.filter(served)].sort(
      compareReleaseVersion,
    );
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

async function fetchReleaseIndexPage(fetchImpl, page) {
  const url = releaseIndexUrl(page);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
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
    if (response.url && response.url !== url) {
      fail("official runner release index response URL changed");
    }
    const bytes = await readBoundedBytes(
      response,
      MAX_RELEASE_INDEX_BYTES,
      "official runner release index",
    );
    let releases;
    try {
      releases = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      fail("official runner release index is not valid UTF-8 JSON");
    }
    if (!Array.isArray(releases)) {
      fail("official runner release index must be an array");
    }
    return releases;
  } finally {
    clearTimeout(timeout);
  }
}

function hasStableReleaseForEveryTarget(releases) {
  return Object.values(TARGET_CONTRACTS).every(({ releasePrefix }) =>
    releases.some(
      (release) =>
        release !== null &&
        typeof release === "object" &&
        typeof release.tag_name === "string" &&
        release.tag_name.startsWith(releasePrefix) &&
        release.draft === false &&
        release.prerelease === false,
    ),
  );
}

/**
 * The release index up to the page that holds a stable release of every
 * target. Newer prereleases sort before their image's stable release, so
 * they are already read by then. A release published between two page reads
 * pushes the list down by one, so an entry seen on an earlier page can come
 * back unchanged at the top of the next one; that copy is dropped. A changed
 * copy, or a duplicate within one page, is kept and fails the index checks.
 */
async function fetchOfficialReleaseIndex(fetchImpl) {
  const releases = [];
  const seen = new Map();
  for (let page = 1; page <= MAX_RELEASE_INDEX_PAGES; page += 1) {
    const batch = await fetchReleaseIndexPage(fetchImpl, page);
    for (const release of batch) {
      const earlier =
        typeof release?.tag_name === "string" ? seen.get(release.tag_name) : undefined;
      if (
        earlier !== undefined &&
        earlier.draft === release.draft &&
        earlier.prerelease === release.prerelease &&
        earlier.target_commitish === release.target_commitish
      ) {
        continue;
      }
      releases.push(release);
    }
    for (const release of batch) {
      if (typeof release?.tag_name === "string" && !seen.has(release.tag_name)) {
        seen.set(release.tag_name, release);
      }
    }
    if (
      batch.length < RELEASE_INDEX_PAGE_SIZE ||
      hasStableReleaseForEveryTarget(releases)
    ) {
      break;
    }
  }
  return releases;
}

/** Returns the parsed rollout feed for one target, or null on any failure. */
async function fetchRolloutStatus(fetchImpl, target) {
  const url = `${ROLLOUT_STATUS_ROOT}${TARGET_CONTRACTS[target].rolloutStatus}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "agenc-hosted-runner-contract",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok || response.status !== 200) return null;
    if (response.url && response.url !== url) return null;
    const bytes = await readBoundedBytes(
      response,
      MAX_ROLLOUT_STATUS_BYTES,
      `${target} rollout status`,
    );
    return parseRolloutStatus(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    return null;
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
  onSkippedPrerelease,
} = {}) {
  if (typeof fetchImpl !== "function") {
    fail("fetch is unavailable");
  }
  const contracts = validateHostedRunnerInventoryConfig(toolchain);
  const releases = await fetchOfficialReleaseIndex(fetchImpl);
  const rolloutStatuses = Object.fromEntries(
    await Promise.all(
      Object.keys(TARGET_CONTRACTS).map(async (target) => [
        target,
        await fetchRolloutStatus(fetchImpl, target),
      ]),
    ),
  );
  requiredHostedRunnerReleases(contracts, releases, {
    rolloutStatuses,
    onSkippedPrerelease,
  });
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
  const verified = await verifyHostedRunnerInventories({
    toolchain,
    onSkippedPrerelease: (target, tag, status) => {
      console.log(
        `[hosted-runner-contract] ${target} prerelease ${tag} not required: GitHub's rollout feed reports ${status.deployed} ${status.deploying === null ? "deployed" : `deploying to ${status.deploying}`}`,
      );
    },
  });
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
