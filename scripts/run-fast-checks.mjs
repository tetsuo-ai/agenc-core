#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";

function isDocumentationPath(file) {
  return file === "README.md" ||
    file === "memory_todo.md" ||
    file === "todo.txt" ||
    file.startsWith("docs/");
}

function isRuntimeVitestFile(file) {
  return /^runtime\/(?:tests|platform-tests)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/su.test(file);
}

function isRuntimeNodeTest(file) {
  return /^runtime\/scripts\/.*\.test\.mjs$/su.test(file);
}

function isRuntimeInput(file) {
  if (isRuntimeVitestFile(file) || isRuntimeNodeTest(file)) return false;
  if (/^runtime\/(?:vitest\.[^/]+\.[cm]?[jt]s|build\.config\.ts)$/u.test(file)) {
    return true;
  }
  return /^runtime\/(?:src|tests|scripts|plugins|native|platform-tests)\//u.test(file) &&
    /\.[cm]?[jt]sx?$/u.test(file);
}

export function mappedRuntimeTestTargets(files) {
  const targets = new Set();
  for (const file of files) {
    if (
      /^runtime\/src\/conversation\/realtime\/prompts\/(?:backend_prompt|realtime_start|realtime_end)\.md$/u.test(file)
    ) {
      targets.add("tests/conversation/realtime/prompt.contract.test.ts");
    }
  }
  return [...targets].sort();
}

export function classifyChangedFiles(files) {
  const changedFiles = [...new Set(files)].sort();
  const documentationOnly = changedFiles.length > 0 && changedFiles.every(isDocumentationPath);
  if (documentationOnly || changedFiles.length === 0) {
    return {
      changedFiles,
      documentationOnly,
      runtimeTests: [],
      runtimeNodeTests: [],
      runtimeInputs: [],
      mappedRuntimeTests: [],
      launcher: false,
      sdk: false,
      policy: false,
      typecheck: false,
    };
  }

  return {
    changedFiles,
    documentationOnly: false,
    runtimeTests: changedFiles.filter(isRuntimeVitestFile),
    runtimeNodeTests: changedFiles.filter(isRuntimeNodeTest),
    runtimeInputs: changedFiles.filter(isRuntimeInput),
    mappedRuntimeTests: mappedRuntimeTestTargets(changedFiles),
    launcher: changedFiles.some((file) => file.startsWith("packages/agenc/")),
    sdk: changedFiles.some((file) => file.startsWith("packages/agenc-sdk/")),
    policy: changedFiles.some((file) =>
      file.startsWith(".github/workflows/") ||
      file.startsWith(".githooks/") ||
      file.startsWith("scripts/") ||
      /^runtime\/(?:package\.json|tsconfig(?:\.[^/]+)?\.json|vitest\.[^/]+|build\.config\.ts)$/u.test(file) ||
      /^(?:package-lock\.json|package\.json|release-toolchain\.json)$/u.test(file)
    ),
    typecheck: true,
  };
}

export function runCommand(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${executable} exited with status ${result.status ?? 1}`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

function run(executable, args) {
  runCommand(executable, args);
}

export function parseNulNames(buffer) {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  if (decoded.length === 0) return [];
  if (!decoded.endsWith("\0")) throw new Error("Git returned an unterminated name list");
  return decoded.slice(0, -1).split("\0");
}

function gitNames(args) {
  const result = spawnSync("git", ["diff", "--name-only", "-z", ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "buffer",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return parseNulNames(result.stdout);
}

function untrackedNames() {
  const result = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: REPOSITORY_ROOT,
    encoding: "buffer",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return parseNulNames(result.stdout);
}

export function readChangedFiles(base, {
  diffNames = gitNames,
  listUntracked = untrackedNames,
} = {}) {
  return [
    ...diffNames([`${base}...HEAD`]),
    ...diffNames([]),
    ...diffNames(["--cached"]),
    ...listUntracked(),
  ];
}

export function resolveBaseCommit(base) {
  if (typeof base !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._/-]{0,255}$/u.test(base)) {
    throw new Error("base must be a non-option Git ref");
  }
  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  const commit = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error(`base does not resolve to one commit: ${base}`);
  }
  return commit;
}

function runtimePath(file) {
  return file.slice("runtime/".length);
}

export function deletedRuntimeFallbackPlan(runtimeInputs, {
  fileExists = (file) => existsSync(path.join(REPOSITORY_ROOT, file)),
  isDirectory = (candidate) => {
    try {
      return statSync(path.join(REPOSITORY_ROOT, candidate)).isDirectory();
    } catch {
      return false;
    }
  },
} = {}) {
  const targets = new Set();
  const uncovered = [];
  for (const file of runtimeInputs) {
    if (fileExists(file)) continue;

    const candidates = [];
    if (file.startsWith("runtime/src/")) {
      const relative = file.slice("runtime/src/".length);
      const [area] = relative.split("/");
      const rootStem = relative.includes("/") ? area : path.parse(relative).name;
      if (rootStem) {
        candidates.push({ kind: "directory", repoPath: `runtime/tests/${rootStem}` });
        for (const suffix of ["test.ts", "test.tsx", "spec.ts", "spec.tsx"]) {
          candidates.push({ kind: "file", repoPath: `runtime/tests/${rootStem}.${suffix}` });
        }
      }
    }
    if (file === "runtime/scripts/run-hermetic-vitest.mjs") {
      candidates.push({
        kind: "file",
        repoPath: "runtime/tests/hermetic-test-discovery.test.ts",
      });
    }
    if (/^runtime\/vitest\.[^/]+\.[cm]?[jt]s$/u.test(file)) {
      candidates.push({
        kind: "file",
        repoPath: "runtime/tests/hermetic-test-discovery.test.ts",
      });
    }
    if (file === "runtime/build.config.ts") {
      candidates.push(
        { kind: "file", repoPath: "runtime/tests/zpurgec-build-resolution.test.ts" },
        { kind: "file", repoPath: "runtime/tests/utils/buildConfig.test.ts" },
      );
    }
    if (
      file ===
      "runtime/scripts/check-tui-e2e/scenarios/74-slash-add-dir.mjs"
    ) {
      candidates.push(
        {
          kind: "file",
          repoPath: "runtime/tests/bin/agenc.cli-branch.test.ts",
        },
        {
          kind: "file",
          repoPath: "runtime/tests/commands/command-surface.test.ts",
        },
      );
    }

    for (const candidate of candidates) {
      const exists = candidate.kind === "directory"
        ? isDirectory(candidate.repoPath)
        : fileExists(candidate.repoPath);
      if (exists) targets.add(runtimePath(candidate.repoPath));
    }
    if (![...targets].some((target) => candidates.some(
      (candidate) => runtimePath(candidate.repoPath) === target,
    ))) {
      uncovered.push(file);
    }
  }
  return { targets: [...targets].sort(), uncovered: uncovered.sort() };
}

export function commandsForPlan(plan, {
  fileExists = (file) => existsSync(path.join(REPOSITORY_ROOT, file)),
  isDirectory,
} = {}) {
  if (!plan.typecheck) return [];

  const commands = [{ executable: npmExecutable, args: ["run", "typecheck"] }];
  const existingRuntimeNodeTests = plan.runtimeNodeTests.filter(fileExists);
  if (existingRuntimeNodeTests.length > 0) {
    commands.push({ executable: process.execPath, args: ["--test", ...existingRuntimeNodeTests] });
  }

  const existingRuntimeInputs = plan.runtimeInputs.filter(fileExists);
  const deletedRuntime = deletedRuntimeFallbackPlan(plan.runtimeInputs, {
    fileExists,
    isDirectory,
  });
  if (deletedRuntime.uncovered.length > 0) {
    throw new Error(
      `deleted runtime inputs have no bounded test mapping: ${deletedRuntime.uncovered.join(", ")}. ` +
      "Add an explicit target or run the full checks and record the manual review.",
    );
  }
  const missingMappedRuntimeTests = plan.mappedRuntimeTests.filter(
    (target) => !fileExists(`runtime/${target}`),
  );
  if (missingMappedRuntimeTests.length > 0) {
    throw new Error(
      `mapped runtime tests do not exist: ${missingMappedRuntimeTests.join(", ")}`,
    );
  }
  const runtimeTestTargets = [...new Set([
    ...plan.runtimeTests.filter(fileExists).map(runtimePath),
    ...plan.mappedRuntimeTests,
    ...deletedRuntime.targets,
  ])].sort();
  if (runtimeTestTargets.length > 0) {
    commands.push({
      executable: process.execPath,
      args: [
        "runtime/scripts/run-hermetic-vitest.mjs",
        "run",
        ...runtimeTestTargets,
        "--passWithNoTests",
        "--maxWorkers=2",
        "--bail=1",
        "--allowOnly=false",
      ],
    });
  }
  if (existingRuntimeInputs.length > 0) {
    commands.push({
      executable: process.execPath,
      args: [
        "runtime/scripts/run-hermetic-vitest.mjs",
        "related",
        ...existingRuntimeInputs.map(runtimePath),
        "--passWithNoTests",
        "--maxWorkers=2",
        "--bail=1",
        "--allowOnly=false",
      ],
    });
  }
  if (plan.launcher) {
    commands.push({ executable: npmExecutable, args: ["test", "--workspace=@tetsuo-ai/agenc"] });
  }
  if (plan.sdk) {
    commands.push({
      executable: npmExecutable,
      args: ["run", "typecheck", "--workspace=@tetsuo-ai/agenc-sdk"],
    });
  }
  if (plan.policy) {
    commands.push({ executable: npmExecutable, args: ["run", "test:required-gates"] });
  }
  return commands;
}

export function runFastChecks({ base = "origin/main" } = {}) {
  const baseCommit = resolveBaseCommit(base);
  run("git", ["diff", "--check", `${baseCommit}...HEAD`]);
  run("git", ["diff", "--check"]);
  run("git", ["diff", "--cached", "--check"]);

  const plan = classifyChangedFiles(readChangedFiles(baseCommit));
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  for (const command of commandsForPlan(plan)) run(command.executable, command.args);
}

function parseBase(args) {
  if (args.length === 0) return "origin/main";
  if (args.length === 2 && args[0] === "--base" && args[1]) return args[1];
  throw new Error("usage: node scripts/run-fast-checks.mjs [--base <git-ref>]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runFastChecks({ base: parseBase(process.argv.slice(2)) });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  }
}
