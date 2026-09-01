import assert from "node:assert/strict";
import test from "node:test";

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyChangedFiles,
  commandsForPlan,
  deletedRuntimeFallbackPlan,
  parseNulNames,
  readChangedFiles,
  runCommand,
} from "./run-fast-checks.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("documentation paths skip code checks", () => {
  const plan = classifyChangedFiles(["README.md", "docs/ci-required-gates.md", "todo.txt"]);
  assert.equal(plan.documentationOnly, true);
  assert.equal(plan.typecheck, false);
});

test("runtime prompt Markdown selects only its bounded contract test", () => {
  const prompt = "runtime/src/conversation/realtime/prompts/backend_prompt.md";
  const plan = classifyChangedFiles([prompt]);
  assert.deepEqual(plan.runtimeInputs, []);
  assert.deepEqual(plan.mappedRuntimeTests, [
    "tests/conversation/realtime/prompt.contract.test.ts",
  ]);
  const commands = commandsForPlan(plan);
  const vitest = commands.find((command) =>
    command.args.includes("runtime/scripts/run-hermetic-vitest.mjs")
  );
  assert.deepEqual(vitest.args.slice(0, 3), [
    "runtime/scripts/run-hermetic-vitest.mjs",
    "run",
    "tests/conversation/realtime/prompt.contract.test.ts",
  ]);
  assert.equal(commands.some((command) => command.args.includes("related")), false);
  assert.equal(plan.typecheck, true);
});

test("runtime prompt mapping fails when its contract is missing", () => {
  const plan = classifyChangedFiles([
    "runtime/src/conversation/realtime/prompts/backend_prompt.md",
    "runtime/tests/conversation/realtime/prompt.contract.test.ts",
  ]);
  assert.throws(
    () => commandsForPlan(plan, { fileExists: () => false, isDirectory: () => false }),
    /mapped runtime tests do not exist: tests\/conversation\/realtime\/prompt\.contract\.test\.ts/u,
  );
});

test("other runtime Markdown does not enter Vitest related mode", () => {
  const plan = classifyChangedFiles(["runtime/src/providers/README.md"]);
  assert.deepEqual(plan.runtimeInputs, []);
  assert.deepEqual(plan.mappedRuntimeTests, []);
  assert.equal(commandsForPlan(plan).some((command) => command.args.includes("related")), false);
});

test("runtime source and tests select separate Vitest modes", () => {
  const source = "runtime/src/session/Session.ts";
  const testFile = "runtime/tests/session/Session.test.ts";
  const plan = classifyChangedFiles([testFile, source]);
  assert.deepEqual(plan.runtimeInputs, [source]);
  assert.deepEqual(plan.runtimeTests, [testFile]);
  const related = commandsForPlan(plan, { fileExists: () => true })
    .find((command) => command.args.includes("related"));
  assert.equal(related.args.includes("src/session/Session.ts"), true);
});

test("deleted runtime source selects its subsystem tests", () => {
  const plan = deletedRuntimeFallbackPlan(
    ["runtime/src/session/removed.ts", "runtime/src/session/also-removed.ts"],
    {
      fileExists: () => false,
      isDirectory: (candidate) => candidate === "runtime/tests/session",
    },
  );
  assert.deepEqual(plan, { targets: ["tests/session"], uncovered: [] });
});

test("deleted root source selects matching root tests", () => {
  const plan = deletedRuntimeFallbackPlan(["runtime/src/commands.ts"], {
    fileExists: (file) => file === "runtime/tests/commands.test.ts",
    isDirectory: (candidate) => candidate === "runtime/tests/commands",
  });
  assert.deepEqual(plan, {
    targets: ["tests/commands", "tests/commands.test.ts"],
    uncovered: [],
  });
});

test("deleted runtime source command runs the subsystem target", () => {
  const plan = classifyChangedFiles(["runtime/src/session/removed.ts"]);
  const commands = commandsForPlan(plan, {
    fileExists: () => false,
    isDirectory: (candidate) => candidate === "runtime/tests/session",
  });
  assert.equal(commands.some((command) =>
    command.args.includes("run") && command.args.includes("tests/session")
  ), true);
  assert.equal(commands.some((command) => command.args.includes("related")), false);
});

test("unmapped deleted source fails instead of passing on typecheck alone", () => {
  const plan = classifyChangedFiles(["runtime/src/build/deleted.ts"]);
  assert.throws(
    () => commandsForPlan(plan, { fileExists: () => false, isDirectory: () => false }),
    /deleted runtime inputs have no bounded test mapping: runtime\/src\/build\/deleted\.ts/u,
  );
});

test("unmapped deleted runtime scripts also fail closed", () => {
  const plan = classifyChangedFiles(["runtime/scripts/removed-runner.mjs"]);
  assert.throws(
    () => commandsForPlan(plan, { fileExists: () => false, isDirectory: () => false }),
    /deleted runtime inputs have no bounded test mapping: runtime\/scripts\/removed-runner\.mjs/u,
  );
});

test("deleted hermetic Vitest runner selects its discovery contract", () => {
  const plan = deletedRuntimeFallbackPlan(
    ["runtime/scripts/run-hermetic-vitest.mjs"],
    {
      fileExists: (file) => file === "runtime/tests/hermetic-test-discovery.test.ts",
      isDirectory: () => false,
    },
  );
  assert.deepEqual(plan, {
    targets: ["tests/hermetic-test-discovery.test.ts"],
    uncovered: [],
  });
});

test("runtime JSON configuration uses policy tests, not Vitest related mode", () => {
  for (const file of ["runtime/package.json", "runtime/tsconfig.bundle.json"]) {
    const plan = classifyChangedFiles([file]);
    assert.equal(plan.policy, true, file);
    assert.deepEqual(plan.runtimeInputs, [], file);
    assert.equal(commandsForPlan(plan).some((command) => command.args.includes("related")), false);
  }
});

test("NUL-delimited names preserve newlines, tabs, and leading dashes", () => {
  const names = [
    "runtime/tests/session/line\nbreak.test.ts",
    "runtime/tests/session/tab\tname.test.ts",
    "-leading-dash.md",
  ];
  assert.deepEqual(parseNulNames(Buffer.from(`${names.join("\0")}\0`)), names);
  const plan = classifyChangedFiles(names);
  assert.deepEqual(plan.runtimeTests, names.slice(0, 2).sort());
});

test("invalid UTF-8 Git names fail instead of being changed silently", () => {
  assert.throws(() => parseNulNames(Buffer.from([0x66, 0x80, 0x00])), TypeError);
});

test("change collection includes untracked files", () => {
  const calls = [];
  const changed = readChangedFiles("abc123", {
    diffNames: (args) => {
      calls.push(args);
      return [];
    },
    listUntracked: () => ["runtime/src/session/untracked.ts"],
  });
  assert.deepEqual(calls, [["abc123...HEAD"], [], ["--cached"]]);
  assert.deepEqual(changed, ["runtime/src/session/untracked.ts"]);
});

test("launcher-only changes do not run runtime Vitest", () => {
  const plan = classifyChangedFiles(["packages/agenc/src/launcher.mjs"]);
  assert.equal(plan.launcher, true);
  assert.deepEqual(plan.runtimeInputs, []);
  assert.deepEqual(plan.runtimeTests, []);
});

test("SDK-only changes select SDK typecheck", () => {
  const plan = classifyChangedFiles(["packages/agenc-sdk/src/client.ts"]);
  assert.equal(plan.sdk, true);
  assert.deepEqual(plan.runtimeInputs, []);
});

test("workflow and policy changes select policy tests", () => {
  for (const file of [".github/workflows/pr-fast.yml", "scripts/run-fast-checks.mjs", "package.json"]) {
    assert.equal(classifyChangedFiles([file]).policy, true, file);
  }
});

test("option-like base refs fail before change selection", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/run-fast-checks.mjs", "--base", "--relative=runtime"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /base must be a non-option Git ref/u);
});

test("child command failures retain their exit status", () => {
  assert.throws(
    () => runCommand(process.execPath, ["-e", "process.exit(23)"], { stdio: "pipe" }),
    (error) => error.exitCode === 23,
  );
});

test("ci-required-gates documents the skip set and fail-closed deletion", () => {
  const docs = readFileSync(path.join(repositoryRoot, "docs/ci-required-gates.md"), "utf8");
  assert.match(docs, /memory_todo\.md/u);
  assert.match(docs, /todo\.txt/u);
  assert.match(docs, /deleted runtime inputs have no bounded test mapping/u);
  assert.match(docs, /--base/u);
  assert.match(docs, /packages\/agenc-sdk/u);
  assert.match(docs, /#fast-testfast-checks/u);
  assert.match(docs, /typecheck only/u);
  assert.match(docs, /agenc-landlock-run\.c/u);
  assert.match(docs, /--passWithNoTests/u);
  assert.match(docs, /required-gate inventory/u);
});

test("native C and C# sources typecheck only", () => {
  for (const file of [
    "runtime/native/agenc-landlock-run.c",
    "runtime/native/agenc-process-broker.c",
    "runtime/native/agenc-process-job-broker.cs",
    "runtime/native/agenc-keychain-helper.c",
    "runtime/native/agenc-secret-service-helper.c",
  ]) {
    const plan = classifyChangedFiles([file]);
    assert.equal(plan.typecheck, true, file);
    assert.deepEqual(plan.runtimeInputs, [], file);
    assert.equal(plan.policy, false, file);
    assert.deepEqual(commandsForPlan(plan).map((command) => command.args), [["run", "typecheck"]], file);
  }
});

test("deleted native C does not use the JS/TS fail-closed mapping", () => {
  const plan = classifyChangedFiles(["runtime/native/agenc-landlock-run.c"]);
  const commands = commandsForPlan(plan, {
    fileExists: () => false,
    isDirectory: () => false,
  });
  assert.deepEqual(commands.map((command) => command.args), [["run", "typecheck"]]);
});

test("required-gate inventory outside the policy selector typechecks only", () => {
  for (const file of [
    ".npmrc",
    "packaging/systemd/agenc-local-gatekeeper.config.example.json",
    "parity/agent-surface-contract.json",
  ]) {
    const plan = classifyChangedFiles([file]);
    assert.equal(plan.policy, false, file);
    assert.equal(plan.typecheck, true, file);
    assert.deepEqual(commandsForPlan(plan).map((command) => command.args), [["run", "typecheck"]], file);
  }
});

test("runtime lock and toolchain files do not select policy tests", () => {
  for (const file of [
    "runtime/package-lock.json",
    "runtime/release-toolchain.json",
  ]) {
    const plan = classifyChangedFiles([file]);
    assert.equal(plan.policy, false, file);
    assert.equal(plan.typecheck, true, file);
    assert.deepEqual(commandsForPlan(plan).map((command) => command.args), [["run", "typecheck"]], file);
  }
});
