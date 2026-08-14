import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
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

function fixtureFetch(toolchain, releases = fixtureReleaseIndex()) {
  const bodies = new Map();
  for (const [target, contract] of Object.entries(toolchain.hostedRunners)) {
    const text = target.startsWith("darwin-")
      ? MACOS_INVENTORY
      : WINDOWS_INVENTORY;
    for (const profile of contract.imageProfiles) {
      bodies.set(profile.inventoryUrl, text);
    }
  }
  return async (url) => {
    if (
      url ===
      "https://api.github.com/repos/actions/runner-images/releases?per_page=100&page=1"
    ) {
      const text = JSON.stringify(releases);
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
