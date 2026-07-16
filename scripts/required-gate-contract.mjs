#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_GATE_SCHEMA_VERSION = 1;
export const REQUIRED_GATE_CONTEXT = "agenc-local-required-v1";
const REQUIRED_GATE_CONTEXT_MATCH =
  /^agenc-local-required-v([1-9][0-9]*)$/u.exec(REQUIRED_GATE_CONTEXT);
const REQUIRED_GATE_CONTEXT_EPOCH = Number(REQUIRED_GATE_CONTEXT_MATCH?.[1]);
if (
  REQUIRED_GATE_CONTEXT_MATCH === null ||
  !Number.isSafeInteger(REQUIRED_GATE_CONTEXT_EPOCH) ||
  REQUIRED_GATE_CONTEXT_EPOCH >= Number.MAX_SAFE_INTEGER
) {
  throw new Error("required gate context is not a canonical incrementable vN epoch");
}
export const NEXT_REQUIRED_GATE_CONTEXT =
  `agenc-local-required-v${REQUIRED_GATE_CONTEXT_EPOCH + 1}`;
export const REQUIRED_NODE_VERSION = "v25.9.0";
export const REQUIRED_NPM_VERSION = "11.17.0";
export const REQUIRED_DOCKER_IMAGE =
  "node:25.9.0-bookworm@sha256:78839ac448c23517f8eab2e8f7943d9b4f73979eb7f8bed2c73dbf72ff869e7b";

export const REQUIRED_GATES = Object.freeze([
  Object.freeze({
    id: "sdk-build",
    label: "SDK build",
    executable: "npm",
    args: Object.freeze(["run", "build", "--workspace=@tetsuo-ai/agenc-sdk"]),
    timeoutMs: 5 * 60_000,
    dockerAccess: false,
    writablePaths: Object.freeze(["packages/agenc-sdk/dist"]),
    freezePaths: Object.freeze(["packages/agenc-sdk/dist"]),
  }),
  Object.freeze({
    id: "launcher-tests",
    label: "Launcher package tests",
    executable: "npm",
    args: Object.freeze(["test", "--workspace=@tetsuo-ai/agenc"]),
    timeoutMs: 5 * 60_000,
    dockerAccess: false,
    writablePaths: Object.freeze([]),
    freezePaths: Object.freeze([]),
  }),
  Object.freeze({
    id: "gate-policy-tests",
    label: "Local gate policy tests",
    executable: "npm",
    args: Object.freeze(["run", "test:required-gates"]),
    timeoutMs: 5 * 60_000,
    dockerAccess: false,
    writablePaths: Object.freeze([]),
    freezePaths: Object.freeze([]),
  }),
  Object.freeze({
    id: "agent-surface-tests",
    label: "Agent-surface contract tests",
    executable: "npm",
    args: Object.freeze(["run", "test:agent-surface-contract"]),
    timeoutMs: 5 * 60_000,
    dockerAccess: false,
    writablePaths: Object.freeze(["runtime/node_modules/.vite-temp"]),
    freezePaths: Object.freeze([]),
  }),
  Object.freeze({
    id: "stable-tests",
    label: "Hermetic runtime typecheck and stable Vitest suite",
    executable: "node",
    args: Object.freeze(["runtime/scripts/run-hermetic-test-boundary.mjs", "run"]),
    timeoutMs: 20 * 60_000,
    dockerAccess: true,
    writablePaths: Object.freeze(["runtime/node_modules/.vite-temp"]),
    freezePaths: Object.freeze([]),
  }),
  Object.freeze({
    id: "agent-surface",
    label: "Agent-surface contract",
    executable: "npm",
    args: Object.freeze([
      "run",
      "check:agent-surface-contract",
      "--",
      "--no-run-commands",
    ]),
    timeoutMs: 5 * 60_000,
    dockerAccess: false,
    writablePaths: Object.freeze([]),
    freezePaths: Object.freeze([]),
  }),
  Object.freeze({
    id: "runtime-build",
    label: "Runtime build and declarations",
    executable: "npm",
    args: Object.freeze(["run", "build"]),
    timeoutMs: 10 * 60_000,
    dockerAccess: false,
    writablePaths: Object.freeze(["runtime/dist"]),
    freezePaths: Object.freeze(["runtime/dist"]),
  }),
  Object.freeze({
    id: "sbom",
    label: "Deterministic SPDX SBOM check",
    executable: "npm",
    args: Object.freeze(["run", "check:sbom"]),
    timeoutMs: 5 * 60_000,
    dockerAccess: false,
    writablePaths: Object.freeze([]),
    freezePaths: Object.freeze([]),
  }),
  Object.freeze({
    id: "tui-startup",
    label: "PTY/TUI runtime startup smoke",
    executable: "trusted-node",
    args: Object.freeze(["runtime/scripts/check-tui-runtime-startup.mjs"]),
    timeoutMs: 10 * 60_000,
    dockerAccess: false,
    writablePaths: Object.freeze([]),
    freezePaths: Object.freeze([]),
  }),
]);

// These files can change what a green required gate means. The trusted local
// gatekeeper independently hashes this fixed inventory and compares it with a
// root-owned approved digest before candidate code runs. Ordinary product and
// test files remain reviewable without requiring a gate-policy rotation.
export const REQUIRED_GATE_POLICY_PATHS = Object.freeze([
  ".npmrc",
  ".github/workflows/publish-npm.yml",
  ".github/workflows/release-runtime.yml",
  "package.json",
  "package-lock.json",
  "release-toolchain.json",
  "packages/agenc-sdk/package.json",
  "packages/agenc-sdk/tsconfig.json",
  "packages/agenc/package.json",
  "packages/agenc/scripts/postinstall.mjs",
  "packaging/github/agenc-local-gate-app-manifest.json",
  "packaging/systemd/agenc-local-gate-context-seed@.service",
  "packaging/systemd/agenc-local-gate-dispatcher@.service",
  "packaging/systemd/agenc-local-gate-docker.service",
  "packaging/systemd/agenc-local-gate-docker.service.conf",
  "packaging/systemd/agenc-local-gate-docker-user.slice.conf",
  "packaging/systemd/agenc-local-gatekeeper.config.example.json",
  "packaging/systemd/agenc-local-gate-publish@.service",
  "packaging/systemd/system-agencgate.slice",
  "parity/agent-surface-contract.json",
  "runtime/build.config.ts",
  "runtime/bin/agenc",
  "runtime/bin/agenc-linux-sandbox",
  "runtime/package.json",
  "runtime/tsconfig.bundle.json",
  "runtime/tsconfig.json",
  "runtime/vitest.config.ts",
  "runtime/scripts/build-runtime.mjs",
  "runtime/scripts/check-package-entrypoints.mjs",
  "runtime/scripts/check-sdk-generated-types.mjs",
  "runtime/scripts/check-tui-runtime-startup.mjs",
  "runtime/scripts/check-tui-runtime-startup.test.mjs",
  "runtime/scripts/hermetic-docker-seccomp.json",
  "runtime/scripts/hermetic-network-boundary.c",
  "runtime/scripts/run-hermetic-test-boundary.mjs",
  "runtime/scripts/run-hermetic-vitest.mjs",
  "runtime/scripts/write-build-version.mjs",
  "runtime/tests/helpers/hermetic-env.mjs",
  "runtime/tests/helpers/hermetic-managed-policy-mocks.ts",
  "runtime/tests/helpers/hermetic-secure-storage-mocks.ts",
  "runtime/tests/helpers/network-tripwire.cjs",
  "runtime/tests/helpers/network-tripwire.mjs",
  "runtime/vitest.setup.ts",
  "scripts/canonicalize-package-modes.mjs",
  "scripts/check-agent-surface-contract.mjs",
  "scripts/check-agent-surface-contract.test.mjs",
  "scripts/check-spdx-sbom.mjs",
  "scripts/docker-quiescence.mjs",
  "scripts/generate-spdx-sbom.mjs",
  "scripts/local-gate-github-app.mjs",
  "scripts/local-gate-github-app.test.mjs",
  "scripts/local-gate-context-seed.mjs",
  "scripts/local-gate-context-seed.test.mjs",
  "scripts/local-gatekeeper.mjs",
  "scripts/local-gatekeeper.test.mjs",
  "scripts/local-gate-ruleset.mjs",
  "scripts/local-gate-ruleset.test.mjs",
  "scripts/required-gate-contract.mjs",
  "scripts/run-required-gates.mjs",
  "scripts/run-required-gates.test.mjs",
  "scripts/systemd-worker-sandbox.mjs",
  "scripts/verify-required-gate-check.mjs",
]);

export const REQUIRED_GATE_REPOSITORY_ROOT = realpathSync(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertRelativePolicyPath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`invalid required-gate policy path: ${relativePath}`);
  }
}

export function computeRequiredGateContract({
  repositoryRoot = REQUIRED_GATE_REPOSITORY_ROOT,
  policyPaths = REQUIRED_GATE_POLICY_PATHS,
} = {}) {
  const resolvedRoot = realpathSync(repositoryRoot);
  const uniquePaths = [...new Set(policyPaths)];
  if (uniquePaths.length !== policyPaths.length) {
    throw new Error("required-gate policy paths must be unique");
  }
  const files = uniquePaths.map((relativePath) => {
    assertRelativePolicyPath(relativePath);
    const absolutePath = path.join(resolvedRoot, ...relativePath.split("/"));
    const metadata = lstatSync(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`required-gate policy path is not one regular file: ${relativePath}`);
    }
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > 16 * 1024 * 1024) {
      throw new Error(`required-gate policy file is outside the 16 MiB bound: ${relativePath}`);
    }
    const bytes = readFileSync(absolutePath);
    return Object.freeze({
      path: relativePath,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  });
  const contract = {
    schemaVersion: REQUIRED_GATE_SCHEMA_VERSION,
    context: REQUIRED_GATE_CONTEXT,
    nodeVersion: REQUIRED_NODE_VERSION,
    npmVersion: REQUIRED_NPM_VERSION,
    gates: REQUIRED_GATES,
    files,
  };
  return Object.freeze({
    ...contract,
    sha256: sha256(canonicalJson(contract)),
  });
}
