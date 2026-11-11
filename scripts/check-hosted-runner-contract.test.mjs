import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  parseRolloutStatus,
  validateHostedRunnerInventoryConfig,
  verifyHostedRunnerInventories,
} from "./check-hosted-runner-contract.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const HASH = "a".repeat(64);

const MACOS_INVENTORY = `# macOS 15
- Image Version: 20260727.0256.1
- Clang/LLVM 17.0.0
| 16.4 (default) | 16F6 | /Applications/Xcode_16.4.app |
| macOS 15.5 | macosx15.5 | 16.4 |
`;

const WINDOWS_INVENTORY = `# Windows Server 2025
- Image Version: 20260728.188.1
### Visual Studio Enterprise 2026
| Visual Studio Enterprise 2026 | 18.8.12023.21 | C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise |
#### Microsoft Visual C++
| Microsoft Visual C++ 2022 Minimum Runtime | x64 | 14.51.36247 |
#### Installed Windows SDKs
- 10.0.26100.0
### .NET Core Tools
`;

function inventoryMetadata(path, text) {
  const bytes = Buffer.from(text);
  return {
    inventoryUrl:
      `https://raw.githubusercontent.com/actions/runner-images/${COMMIT}/${path}`,
    inventoryBytes: bytes.byteLength,
    inventorySha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function fixtureToolchain() {
  const macosProfile = {
    imageVersion: "20260727.0256.1",
    ...inventoryMetadata(
      "images/macos/macos-15-arm64-Readme.md",
      MACOS_INVENTORY,
    ),
    xcodeVersion: "16.4",
    xcodeBuild: "16F6",
    macosSdkVersion: "15.5",
    clangVersion: "Apple clang version 17.0.0 (clang-1700.0.13.5)",
  };
  const windowsProfile = {
    imageVersion: "20260728.188.1",
    ...inventoryMetadata(
      "images/windows/Windows2025-VS2026-Readme.md",
      WINDOWS_INVENTORY,
    ),
    visualStudioVersion: "18.8.12023.21",
    visualStudioInstallPath:
      "C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise",
    msvcToolsVersion: "14.51.36231",
    msvcCompilerVersion: "19.51.36252",
    msvcCompilerSha256: HASH,
    msvcLinkerSha256: HASH,
    windowsSdkVersion: "10.0.26100.0",
  };
  return {
    hostedRunners: {
      "darwin-arm64": {
        runnerLabel: "macos-15",
        imageOS: "macos15",
        runnerArch: "ARM64",
        imageProfiles: [macosProfile],
      },
      "darwin-x64": {
        runnerLabel: "macos-15-intel",
        imageOS: "macos15",
        runnerArch: "X64",
        imageProfiles: [
          {
            ...macosProfile,
            ...inventoryMetadata(
              "images/macos/macos-15-Readme.md",
              MACOS_INVENTORY,
            ),
          },
        ],
      },
      "win-x64": {
        runnerLabel: "windows-2025-vs2026",
        imageOS: "win25-vs2026",
        runnerArch: "X64",
        imageProfiles: [windowsProfile],
      },
    },
  };
}

function fixtureReleaseIndex() {
  return [
    {
      tag_name: "macos-15-arm64/20260727.0256",
      draft: false,
      prerelease: false,
      target_commitish: COMMIT,
    },
    {
      tag_name: "macos-15/20260727.0256",
      draft: false,
      prerelease: false,
      target_commitish: COMMIT,
    },
    {
      tag_name: "win25-vs2026/20260728.188",
      draft: false,
      prerelease: false,
      target_commitish: COMMIT,
    },
  ];
}

const ROLLOUT_FEED =
  "https://gist.githubusercontent.com/hosted-runners-images-bot/79267492faab096d04cdd25ce7014cec/raw/";

const RELEASE_INDEX_PAGE =
  /^https:\/\/api\.github\.com\/repos\/actions\/runner-images\/releases\?per_page=(\d+)&page=(\d+)$/u;

/**
 * The release index is `releases` followed by `laterPages`, served at any
 * page size. `releases` can instead be a function from the 1-based number of
 * an index request to the whole list, for a list that changes between reads.
 * Each index request is recorded in `fetch.indexReads` as the [start, end)
 * positions it asked for.
 */
function fixtureFetch(toolchain, releases = fixtureReleaseIndex(), rolloutFeeds = {}, laterPages = []) {
  const listForRead =
    typeof releases === "function" ? releases : () => [releases, ...laterPages].flat();
  const indexReads = [];
  const bodies = new Map();
  for (const [file, text] of Object.entries(rolloutFeeds)) {
    bodies.set(`${ROLLOUT_FEED}${file}`, text);
  }
  for (const [target, contract] of Object.entries(toolchain.hostedRunners)) {
    const text = target.startsWith("darwin-")
      ? MACOS_INVENTORY
      : WINDOWS_INVENTORY;
    for (const profile of contract.imageProfiles) {
      bodies.set(profile.inventoryUrl, text);
    }
  }
  const fetchImpl = async (url) => {
    const index = RELEASE_INDEX_PAGE.exec(url);
    if (index !== null) {
      const perPage = Number(index[1]);
      const start = (Number(index[2]) - 1) * perPage;
      indexReads.push([start, start + perPage]);
      const body = listForRead(indexReads.length).slice(start, start + perPage);
      const text = JSON.stringify(body);
      return new Response(text, {
        status: 200,
        headers: { "Content-Length": String(Buffer.byteLength(text)) },
      });
    }
    const text = bodies.get(url);
    if (text === undefined) return new Response("missing", { status: 404 });
    return new Response(text, {
      status: 200,
      headers: { "Content-Length": String(Buffer.byteLength(text)) },
    });
  };
  fetchImpl.indexReads = indexReads;
  return fetchImpl;
}

/** Stable releases of images no target uses, to fill an index page. */
function otherImageReleases(count, from = 0) {
  return Array.from({ length: count }, (_, index) => ({
    tag_name: `ubuntu24/20260901.${String(from + index).padStart(3, "0")}`,
    draft: false,
    prerelease: false,
    target_commitish: COMMIT,
  }));
}

test("verifies every commit-pinned inventory and its parsed toolchain facts", async () => {
  const toolchain = fixtureToolchain();
  const verified = await verifyHostedRunnerInventories({
    toolchain,
    fetchImpl: fixtureFetch(toolchain),
  });
  assert.deepEqual(
    verified.map(({ target }) => target),
    ["darwin-arm64", "darwin-x64", "win-x64"],
  );
});

test("rejects an inventory URL that is not pinned to an exact commit", () => {
  const toolchain = fixtureToolchain();
  toolchain.hostedRunners["darwin-arm64"].imageProfiles[0].inventoryUrl =
    "https://raw.githubusercontent.com/actions/runner-images/main/images/macos/macos-15-arm64-Readme.md";
  assert.throws(
    () => validateHostedRunnerInventoryConfig(toolchain),
    /must pin the exact official inventory commit/u,
  );
});

test("rejects inventory byte-count drift before parsing", async () => {
  const toolchain = fixtureToolchain();
  toolchain.hostedRunners["darwin-arm64"].imageProfiles[0].inventoryBytes += 1;
  await assert.rejects(
    verifyHostedRunnerInventories({
      toolchain,
      fetchImpl: fixtureFetch(toolchain),
    }),
    /Content-Length does not match the pinned byte count/u,
  );
});

test("rejects inventory digest drift", async () => {
  const toolchain = fixtureToolchain();
  toolchain.hostedRunners["darwin-x64"].imageProfiles[0].inventorySha256 = HASH;
  await assert.rejects(
    verifyHostedRunnerInventories({
      toolchain,
      fetchImpl: fixtureFetch(toolchain),
    }),
    /inventory SHA-256 changed/u,
  );
});

test("rejects parsed toolchain facts that drift from the reviewed profile", async () => {
  const toolchain = fixtureToolchain();
  toolchain.hostedRunners["win-x64"].imageProfiles[0].visualStudioVersion =
    "18.8.99999.99";
  await assert.rejects(
    verifyHostedRunnerInventories({
      toolchain,
      fetchImpl: fixtureFetch(toolchain),
    }),
    /Visual Studio inventory does not match/u,
  );
});

test("rejects a newer official rollout image missing from reviewed profiles", async () => {
  const toolchain = fixtureToolchain();
  const releases = [
    ...fixtureReleaseIndex(),
    {
      tag_name: "macos-15/20260803.0400",
      draft: false,
      prerelease: true,
      target_commitish: "fedcba9876543210fedcba9876543210fedcba98",
    },
  ];
  await assert.rejects(
    verifyHostedRunnerInventories({
      toolchain,
      fetchImpl: fixtureFetch(toolchain, releases),
    }),
    /darwin-x64 is missing active official runner image 20260803\.0400\.\*/u,
  );
});

function releasesWithMacosPrerelease() {
  return [
    ...fixtureReleaseIndex(),
    {
      tag_name: "macos-15/20260803.0400",
      draft: false,
      prerelease: true,
      target_commitish: "fedcba9876543210fedcba9876543210fedcba98",
    },
  ];
}

test("parses only the two rollout feed shapes GitHub publishes", () => {
  assert.deepEqual(
    parseRolloutStatus({ label: "20260925.250", message: "Deployed", color: "#17781c", schemaVersion: 1 }),
    { deployed: "20260925.250", deploying: null },
  );
  assert.deepEqual(
    parseRolloutStatus({ label: "20260922.246", message: "Deploying to 20260925.250" }),
    { deployed: "20260922.246", deploying: "20260925.250" },
  );
  for (const value of [
    null,
    [],
    {},
    { label: "20260925.250" },
    { label: "20260925.250.1", message: "Deployed" },
    { label: "20260925.250", message: "Rolling" },
    { label: "20260925.250", message: "Deploying to latest" },
  ]) {
    assert.equal(parseRolloutStatus(value), null);
  }
});

test("does not require a newer prerelease that GitHub's rollout feed does not deploy", async () => {
  // Live 2026-10-14: win25-vs2026/20261007.264 was published as a prerelease
  // while the feed still read 20260925.250 Deployed, and no hosted runner
  // served it, so its compiler could not be measured for a reviewed profile.
  const toolchain = fixtureToolchain();
  const skipped = [];
  const verified = await verifyHostedRunnerInventories({
    toolchain,
    fetchImpl: fixtureFetch(toolchain, releasesWithMacosPrerelease(), {
      "macos-15.json": JSON.stringify({ label: "20260727.0256", message: "Deployed" }),
    }),
    onSkippedPrerelease: (target, tag, status) => skipped.push({ target, tag, status }),
  });
  assert.ok(verified.length > 0);
  assert.deepEqual(skipped, [
    {
      target: "darwin-x64",
      tag: "macos-15/20260803.0400",
      status: { deployed: "20260727.0256", deploying: null },
    },
  ]);
});

test("requires a newer prerelease while GitHub's rollout feed deploys it", async () => {
  const toolchain = fixtureToolchain();
  await assert.rejects(
    verifyHostedRunnerInventories({
      toolchain,
      fetchImpl: fixtureFetch(toolchain, releasesWithMacosPrerelease(), {
        "macos-15.json": JSON.stringify({
          label: "20260727.0256",
          message: "Deploying to 20260803.0400",
        }),
      }),
    }),
    /darwin-x64 is missing active official runner image 20260803\.0400\.\*/u,
  );
});

test("fails closed when the rollout feed is unreadable or names an unknown version", async () => {
  for (const feed of [
    undefined,
    "not json",
    JSON.stringify({ label: "20260901.0500", message: "Deployed" }),
    JSON.stringify({ label: "20260727.0256", message: "Deploying to 20260901.0500" }),
    JSON.stringify({ label: "20260727.0256", message: "Rolling" }),
  ]) {
    const toolchain = fixtureToolchain();
    await assert.rejects(
      verifyHostedRunnerInventories({
        toolchain,
        fetchImpl: fixtureFetch(
          toolchain,
          releasesWithMacosPrerelease(),
          feed === undefined ? {} : { "macos-15.json": feed },
        ),
      }),
      /darwin-x64 is missing active official runner image 20260803\.0400\.\*/u,
    );
  }
});

// GitHub lists runner-images releases newest first, 100 to a page. On
// 2026-10-22 the stable macos-15 Intel release (2026-08-24) was on page 2.
test("reads later index pages until every target has a stable release", async () => {
  const toolchain = fixtureToolchain();
  const [arm64, intel, windows] = fixtureReleaseIndex();
  const firstPage = [arm64, windows, ...otherImageReleases(98)];
  const fetchImpl = fixtureFetch(toolchain, firstPage, {}, [
    [...otherImageReleases(50, 98), intel, ...otherImageReleases(49, 148)],
    otherImageReleases(100, 197),
  ]);
  const verified = await verifyHostedRunnerInventories({ toolchain, fetchImpl });
  assert.deepEqual(
    verified.map(({ target }) => target),
    ["darwin-arm64", "darwin-x64", "win-x64"],
  );
  assert.deepEqual(fetchImpl.indexReads, [[0, 100], [99, 198]]);
});

test("stops at the page budget when a target has no stable release", async () => {
  const toolchain = fixtureToolchain();
  const [arm64, , windows] = fixtureReleaseIndex();
  const pages = Array.from({ length: 11 }, (_, index) => otherImageReleases(100, index * 100));
  const fetchImpl = fixtureFetch(toolchain, [arm64, windows, ...otherImageReleases(98, 5000)], {}, pages);
  await assert.rejects(
    verifyHostedRunnerInventories({ toolchain, fetchImpl }),
    /official runner release index has no stable macos-15\/ release/u,
  );
  // Each read after the first starts at or before the last entry of the one
  // before it, and together they cover the first 1000 entries.
  const reads = fetchImpl.indexReads;
  assert.deepEqual(reads[0], [0, 100]);
  for (let index = 1; index < reads.length; index += 1) {
    assert.ok(reads[index][0] <= reads[index - 1][1] - 1, `read ${index} overlaps the one before it`);
    assert.ok(reads[index][1] > reads[index - 1][1], `read ${index} moves past the one before it`);
  }
  assert.equal(reads.at(-1)[1], 1000);
  assert.equal(reads.length, 11);
});

test("stops at a short last page", async () => {
  const toolchain = fixtureToolchain();
  const [arm64, , windows] = fixtureReleaseIndex();
  const fetchImpl = fixtureFetch(toolchain, [arm64, windows, ...otherImageReleases(98)], {}, [
    otherImageReleases(7, 98),
  ]);
  await assert.rejects(
    verifyHostedRunnerInventories({ toolchain, fetchImpl }),
    /official runner release index has no stable macos-15\/ release/u,
  );
  assert.deepEqual(fetchImpl.indexReads, [[0, 100], [99, 198]]);
});

test("drops a release that moved to the next page while the pages were read", async () => {
  const toolchain = fixtureToolchain();
  const [arm64, intel, windows] = fixtureReleaseIndex();
  const firstPage = [arm64, windows, ...otherImageReleases(98)];
  const published = otherImageReleases(1, 900)[0];
  const fetchImpl = fixtureFetch(toolchain, (read) =>
    read === 1 ? [...firstPage, intel] : [published, ...firstPage, intel],
  );
  const verified = await verifyHostedRunnerInventories({ toolchain, fetchImpl });
  assert.equal(verified.length, 3);
  assert.deepEqual(fetchImpl.indexReads, [[0, 100], [99, 198]]);
});

test("still rejects a release repeated on one page or changed on the next", async () => {
  const toolchain = fixtureToolchain();
  const [arm64, intel, windows] = fixtureReleaseIndex();
  await assert.rejects(
    verifyHostedRunnerInventories({
      toolchain,
      fetchImpl: fixtureFetch(toolchain, [arm64, arm64, intel, windows]),
    }),
    /official runner release index duplicated macos-15-arm64\/20260727\.0256/u,
  );
  const firstPage = [arm64, windows, ...otherImageReleases(98)];
  await assert.rejects(
    verifyHostedRunnerInventories({
      toolchain,
      fetchImpl: fixtureFetch(toolchain, firstPage, {}, [[{ ...arm64, prerelease: true }, intel]]),
    }),
    /official runner release index duplicated macos-15-arm64\/20260727\.0256/u,
  );
});

// Releases deleted between two page reads shift the list up: after two
// deletions the first entry of page 2 sits in a slot of page 1 that the
// one-entry overlap does not read again.
test("reads the index again when releases are deleted between page reads", async () => {
  const toolchain = fixtureToolchain();
  const [arm64, intel, windows] = fixtureReleaseIndex();
  const deleted = otherImageReleases(2, 500);
  const rest = [arm64, windows, ...otherImageReleases(96, 2), intel, ...otherImageReleases(100, 98)];
  const fetchImpl = fixtureFetch(toolchain, (read) => (read === 1 ? [...deleted, ...rest] : rest));
  const verified = await verifyHostedRunnerInventories({ toolchain, fetchImpl });
  assert.deepEqual(
    verified.map(({ target }) => target),
    ["darwin-arm64", "darwin-x64", "win-x64"],
  );
  assert.deepEqual(fetchImpl.indexReads, [[0, 100], [99, 198], [0, 100]]);
});

// A release before the page boundary is deleted before page 2 is read, and an
// unrelated release is published before the next index request. The entry
// that ended page 1 is back in its slot by then, but the newer Intel stable
// release that slid into that slot was never read.
test("reads the index again when a deletion and a publish meet between page reads", async () => {
  const toolchain = fixtureToolchain();
  const [arm64, intel, windows] = fixtureReleaseIndex();
  const newerIntel = { ...intel, tag_name: "macos-15/20260901.0100" };
  const deleted = otherImageReleases(1, 500)[0];
  const published = otherImageReleases(1, 900)[0];
  const original = [
    arm64,
    windows,
    deleted,
    ...otherImageReleases(97),
    newerIntel,
    intel,
    ...otherImageReleases(100, 97),
  ];
  const afterDelete = original.filter((release) => release !== deleted);
  const lists = [original, afterDelete, [published, ...afterDelete]];
  const fetchImpl = fixtureFetch(toolchain, (read) => lists[Math.min(read, lists.length) - 1]);
  await assert.rejects(
    verifyHostedRunnerInventories({ toolchain, fetchImpl }),
    /darwin-x64 is missing active official runner image 20260901\.0100\.\*/u,
  );
});

test("gives up when the index keeps changing between page reads", async () => {
  const toolchain = fixtureToolchain();
  const [arm64, intel, windows] = fixtureReleaseIndex();
  const deleted = otherImageReleases(1)[0];
  const rest = [arm64, windows, ...otherImageReleases(97, 1), intel, ...otherImageReleases(99, 98)];
  const fetchImpl = fixtureFetch(toolchain, (read) => (read % 2 === 1 ? [deleted, ...rest] : rest));
  await assert.rejects(
    verifyHostedRunnerInventories({ toolchain, fetchImpl }),
    /official runner release index kept changing while its pages were read/u,
  );
  assert.equal(fetchImpl.indexReads.length, 6);
});
