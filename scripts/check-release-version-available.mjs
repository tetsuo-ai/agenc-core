#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NPM_PACKAGE = "@tetsuo-ai/agenc";
const SOURCE_REPOSITORY = "tetsuo-ai/agenc-core";
const RELEASE_REPOSITORY = "tetsuo-ai/agenc-releases";
const DEFAULT_TIMEOUT_MS = 15_000;

function stableVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`release version is not stable canonical semver: ${JSON.stringify(value)}`);
  }
  return value;
}

function checkoutVersion() {
  const versions = [
    "package.json",
    "runtime/package.json",
    "packages/agenc/package.json",
  ].map((path) => JSON.parse(readFileSync(join(repoRoot, path), "utf8")).version);
  if (new Set(versions).size !== 1) {
    throw new Error(`release package versions differ: ${versions.join(", ")}`);
  }
  return stableVersion(versions[0]);
}

async function requireExplicitAbsence({ url, label, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("availability request timed out")), timeoutMs);
  timeout.unref?.();
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "error",
      signal: controller.signal,
      headers: url.hostname === "api.github.com"
        ? {
            Accept: "application/vnd.github+json",
            "User-Agent": "agenc-release-preflight",
            "X-GitHub-Api-Version": "2026-03-10",
          }
        : { Accept: "application/json" },
    });
  } catch (error) {
    throw new Error(`${label} availability is inconclusive: request failed`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
  response.body?.cancel().catch(() => {});
  if (response.status === 404) return;
  if (response.status === 200) {
    throw new Error(`${label} already exists; immutable version reuse is forbidden`);
  }
  throw new Error(`${label} availability is inconclusive: HTTP ${response.status}`);
}

async function requirePublicRepository({ repository, fetchImpl, timeoutMs }) {
  const url = new URL(`repos/${repository}`, "https://api.github.com/");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("repository request timed out")), timeoutMs);
  timeout.unref?.();
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "agenc-release-preflight",
        "X-GitHub-Api-Version": "2026-03-10",
      },
    });
  } catch (error) {
    throw new Error(`${repository} public-visibility check is inconclusive`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
  response.body?.cancel().catch(() => {});
  if (response.status !== 200) {
    throw new Error(
      `${repository} must be publicly visible before release preflight: HTTP ${response.status}`,
    );
  }
}

export async function assertReleaseVersionAvailable({
  version,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const checkedVersion = stableVersion(version);
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new TypeError(`timeout must be an integer from 1 through ${DEFAULT_TIMEOUT_MS}`);
  }
  const tag = `agenc-v${checkedVersion}`;
  for (const repository of [SOURCE_REPOSITORY, RELEASE_REPOSITORY]) {
    await requirePublicRepository({ repository, fetchImpl, timeoutMs });
  }
  const checks = [
    {
      label: `${NPM_PACKAGE}@${checkedVersion} on the public npm registry`,
      url: new URL(`%40tetsuo-ai%2Fagenc/${checkedVersion}`, "https://registry.npmjs.org/"),
    },
    {
      label: `${SOURCE_REPOSITORY} source tag ${tag}`,
      url: new URL(`repos/${SOURCE_REPOSITORY}/git/ref/tags/${tag}`, "https://api.github.com/"),
    },
    {
      label: `${RELEASE_REPOSITORY} artifact tag ${tag}`,
      url: new URL(`repos/${RELEASE_REPOSITORY}/git/ref/tags/${tag}`, "https://api.github.com/"),
    },
    {
      label: `${RELEASE_REPOSITORY} release ${tag}`,
      url: new URL(`repos/${RELEASE_REPOSITORY}/releases/tags/${tag}`, "https://api.github.com/"),
    },
  ];
  for (const check of checks) {
    await requireExplicitAbsence({ ...check, fetchImpl, timeoutMs });
  }
  return Object.freeze({
    version: checkedVersion,
    tag,
    publicRepositories: 2,
    absentNamespaces: checks.length,
  });
}

async function main() {
  const version = checkoutVersion();
  const result = await assertReleaseVersionAvailable({ version });
  process.stdout.write(
    `release version ${result.version} is explicitly absent at all ` +
      `${result.absentNamespaces} immutable namespaces; ${result.publicRepositories} repositories are public\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error) => {
    console.error(`release-preflight: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
