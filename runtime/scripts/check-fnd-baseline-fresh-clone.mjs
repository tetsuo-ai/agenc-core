#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSanitizedGitEnvironment,
  materializeFreshCloneDefaultBranch,
  resolveBenchmarkGitExecutable,
  resolveDefaultBranchSelector,
} from "../benchmarks/fnd/provenance.mjs";

const DEFAULT_REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const RUNNER_RELATIVE_PATH = "runtime/benchmarks/fnd/run-baselines.mjs";
const NODE_MODULES_RELATIVE_PATH = "node_modules";
const BUNDLE_TIMEOUT_MS = 120_000;
const CLONE_TIMEOUT_MS = 120_000;
const CHECK_TIMEOUT_MS = 60_000;

const options = parseArguments(process.argv.slice(2));
const cloneParent = mkdtempSync(join(tmpdir(), "agenc-fnd-fresh-clone-"));
const bundlePath = join(cloneParent, "provenance.bundle");
const cloneRoot = join(cloneParent, "clone");

try {
  const environment = createSanitizedGitEnvironment();
  const gitExecutable = resolveBenchmarkGitExecutable(environment);
  const defaultBranchSelector = resolveDefaultBranchSelector(
    options.repositoryRoot,
  );
  const defaultRevision = gitText(
    gitExecutable,
    environment,
    options.repositoryRoot,
    [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${defaultBranchSelector}^{commit}`,
    ],
    "resolve fresh-clone default branch",
  );
  const headRevision = gitText(
    gitExecutable,
    environment,
    options.repositoryRoot,
    ["rev-parse", "HEAD"],
    "resolve fresh-clone HEAD",
  );
  // git bundle create requires named refs. Raw object IDs produce an empty
  // bundle and refuse to write a file.
  runGit(
    gitExecutable,
    environment,
    options.repositoryRoot,
    ["bundle", "create", bundlePath, "HEAD", defaultBranchSelector],
    "create a default-branch provenance bundle",
    BUNDLE_TIMEOUT_MS,
  );
  runGit(
    gitExecutable,
    environment,
    cloneParent,
    ["clone", "--quiet", bundlePath, cloneRoot],
    "clone the default-branch provenance bundle",
    CLONE_TIMEOUT_MS,
  );
  runGit(
    gitExecutable,
    environment,
    cloneRoot,
    ["-c", "advice.detachedHead=false", "checkout", "--quiet", headRevision],
    "check out the captured HEAD in the fresh clone",
  );
  materializeFreshCloneDefaultBranch(cloneRoot, defaultRevision);
  symlinkSync(
    join(options.repositoryRoot, NODE_MODULES_RELATIVE_PATH),
    join(cloneRoot, NODE_MODULES_RELATIVE_PATH),
    process.platform === "win32" ? "junction" : "dir",
  );
  execFileSync(process.execPath, [join(cloneRoot, RUNNER_RELATIVE_PATH), "--check"], {
    cwd: cloneRoot,
    env: createCheckEnvironment(),
    stdio: "inherit",
    timeout: CHECK_TIMEOUT_MS,
    windowsHide: true,
  });
} finally {
  rmSync(cloneParent, { force: true, recursive: true });
}

function parseArguments(args) {
  if (args.length === 0) {
    return { repositoryRoot: DEFAULT_REPOSITORY_ROOT };
  }
  if (args.length === 2 && args[0] === "--repository-root") {
    return { repositoryRoot: resolve(args[1]) };
  }
  throw new Error(
    "usage: check-fnd-baseline-fresh-clone.mjs [--repository-root PATH]",
  );
}

function createCheckEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    const normalizedName = name.toUpperCase();
    if (
      normalizedName.startsWith("NODE_") ||
      normalizedName.startsWith("TSX_")
    ) {
      delete environment[name];
    }
  }
  return environment;
}

function gitText(gitExecutable, environment, cwd, args, label) {
  return runGit(gitExecutable, environment, cwd, args, label)
    .toString("utf8")
    .trim();
}

function runGit(
  gitExecutable,
  environment,
  cwd,
  args,
  label,
  timeoutMs = 5_000,
) {
  try {
    return execFileSync(gitExecutable, args, {
      cwd,
      env: environment,
      timeout: timeoutMs,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`${label} failed`, { cause: error });
  }
}
