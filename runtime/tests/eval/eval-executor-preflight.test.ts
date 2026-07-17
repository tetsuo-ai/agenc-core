import { describe, expect, test } from "vitest";
import {
  DEFAULT_PARSER_FALLBACK_IMAGE,
  DockerContainerRunner,
  EvalExecutorError,
  extractParserResults,
  mintUpstreamPreflightEvidence,
  PARSE_RESULT_SENTINEL,
  runTriplePreflight,
  testPassed,
  type ContainerEnvironment,
  type ContainerExecRequest,
  type ContainerExecResult,
  type ContainerHandle,
  type ContainerRunner,
  type PilotSourceLockTask,
  type PreflightTaskInputs,
  type VerifierBundle,
} from "../../src/eval-executor/index.js";

const digestOf = (char: string): `sha256:${string}` => `sha256:${char.repeat(64)}`;

const IMAGE = `registry.example/fake-task@sha256:${"a".repeat(64)}`;

const TASK: PilotSourceLockTask = {
  ordinal: 1,
  language: "c",
  instanceId: "Fake__task-1",
  categories: ["multi_file_fix"],
  stressors: [],
  sourceRowDigest: digestOf("b"),
  repository: "fake/task",
  pullNumber: "1",
  issueNumbers: ["2"],
  baseCommit: "c".repeat(40),
  createdAt: "2026-07-01T00:00:00Z",
  commitUrl: "https://example.invalid/fake/task",
  issueText: "fake issue",
  image: IMAGE,
  artifacts: {
    setupPatch: {
      digest: digestOf("d"),
      sizeBytes: 0,
      mediaType: "text/x-diff",
      uri: `cas://sha256/${"d".repeat(64)}`,
    },
    referencePatch: {
      digest: digestOf("e"),
      sizeBytes: 10,
      mediaType: "text/x-diff",
      uri: `cas://sha256/${"e".repeat(64)}`,
    },
    verifierBundle: {
      digest: digestOf("f"),
      sizeBytes: 10,
      mediaType: "application/vnd.agenc.eval.verifier+json+gzip",
      uri: `cas://sha256/${"f".repeat(64)}`,
    },
    sourceEvidence: {
      digest: digestOf("0"),
      sizeBytes: 10,
      mediaType: "application/vnd.agenc.eval.source-evidence+json",
      uri: `cas://sha256/${"0".repeat(64)}`,
    },
  },
};

const BUNDLE: VerifierBundle = {
  kind: "agenc.eval.swe-bench-live-verifier-bundle",
  version: "1.0.0",
  instanceId: TASK.instanceId,
  testPatch: "diff --git a/test b/test\n",
  rebuildCommands: ["make rebuild"],
  testCommands: ["make test 2>&1 | tee test-output.log"],
  printCommands: ["cat test-output.log"],
  logParser: "def parser(log):\n    return {}\n",
  failToPass: ["target-1", "target-2"],
  passToPass: ["regression-1"],
};

const INPUTS: PreflightTaskInputs = {
  task: TASK,
  bundle: BUNDLE,
  setupPatch: new Uint8Array(0),
  referencePatch: new TextEncoder().encode("diff --git a/fix b/fix\n"),
};

const OK: ContainerExecResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  truncated: false,
  durationMs: 1,
};

interface PhasePlan {
  readonly applyExitCode?: number;
  readonly rebuildExitCode?: number;
  readonly rebuildStderr?: string;
  readonly testTimedOut?: boolean;
  readonly parserExitCode?: number;
  readonly parserResults?: Record<string, string>;
  readonly pythonMissing?: boolean;
}

class FakeContainerRunner implements ContainerRunner {
  readonly writtenFiles: string[] = [];
  readonly executedScripts: string[] = [];
  readonly auxiliaryImages: string[] = [];
  readonly copiedFiles: string[] = [];
  readonly removedIds: string[] = [];
  private phaseIndex = -1;

  constructor(private readonly phases: readonly PhasePlan[]) {}

  async createAuxiliaryContainer(imageReference: string): Promise<ContainerHandle> {
    this.auxiliaryImages.push(imageReference);
    return { id: `aux-${this.auxiliaryImages.length}`, imageDigest: imageReference, workdir: "/" };
  }

  async copyFile(
    _source: ContainerHandle,
    sourcePath: string,
    _target: ContainerHandle,
    targetPath: string,
  ): Promise<void> {
    this.copiedFiles.push(`${sourcePath} -> ${targetPath}`);
  }

  async environment(): Promise<ContainerEnvironment> {
    return { engine: "docker", serverVersion: "0.0.0-fake", platform: "linux", arch: "x64" };
  }

  async createTaskContainer(imageReference: string): Promise<ContainerHandle> {
    expect(imageReference).toBe(IMAGE);
    this.phaseIndex += 1;
    if (this.phaseIndex >= this.phases.length) {
      throw new Error("fake runner ran out of scripted phases");
    }
    return {
      id: `fake-${this.phaseIndex}`,
      imageDigest: imageReference.slice(imageReference.lastIndexOf("@") + 1),
      workdir: "/testbed",
    };
  }

  async exec(_handle: ContainerHandle, request: ContainerExecRequest): Promise<ContainerExecResult> {
    const plan = this.phases[this.phaseIndex]!;
    this.executedScripts.push(request.script);
    if (request.script.includes(" apply ")) {
      return { ...OK, exitCode: plan.applyExitCode ?? 0, stderr: "apply output" };
    }
    if (request.script.endsWith(">> /agenc-eval/parser-input.log")) {
      return OK;
    }
    if (request.script === "command -v python3") {
      return { ...OK, exitCode: plan.pythonMissing ? 1 : 0 };
    }
    if (request.script === "make rebuild") {
      return {
        ...OK,
        exitCode: plan.rebuildExitCode ?? 0,
        stderr: plan.rebuildStderr ?? "",
      };
    }
    if (request.script.startsWith("make test")) {
      return { ...OK, exitCode: 1, stdout: "raw test log", timedOut: plan.testTimedOut ?? false };
    }
    if (request.script.includes("parse-log.py")) {
      return {
        ...OK,
        exitCode: plan.parserExitCode ?? 0,
        stdout: `${PARSE_RESULT_SENTINEL}${JSON.stringify(plan.parserResults ?? {})}\n`,
      };
    }
    throw new Error(`unexpected script: ${request.script}`);
  }

  async writeFile(_handle: ContainerHandle, containerPath: string): Promise<void> {
    this.writtenFiles.push(containerPath);
  }

  async remove(handle: ContainerHandle): Promise<void> {
    this.removedIds.push(handle.id);
  }
}

const BASE_OK: PhasePlan = {
  parserResults: { "target-1": "FAILED", "target-2": "ERROR", "regression-1": "PASSED" },
};
const REFERENCE_OK: PhasePlan = {
  parserResults: { "target-1": "PASSED", "target-2": "PASSED", "regression-1": "PASSED" },
};

describe("eval executor triple preflight", () => {
  test("qualifies a task when all three cold runs hold every verdict", async () => {
    const runner = new FakeContainerRunner([
      BASE_OK, REFERENCE_OK, BASE_OK, REFERENCE_OK, BASE_OK, REFERENCE_OK,
    ]);
    const result = await runTriplePreflight(runner, INPUTS);
    expect(result.qualified).toBe(true);
    expect(result.runs).toHaveLength(3);
    for (const run of result.runs) {
      expect(run.failure).toBeNull();
      expect(run.verdicts).toMatchObject({
        coldRebuild: true,
        baseFailsTargetChecks: true,
        basePassesRegressionChecks: true,
        referencePassesAllChecks: true,
      });
      expect(run.phases).toHaveLength(2);
      expect(run.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }
    expect(new Set(result.runs.map((run) => run.evidenceDigest)).size).toBe(3);
    expect(runner.writtenFiles.filter((file) => file.endsWith("test.patch"))).toHaveLength(6);
    expect(runner.writtenFiles.filter((file) => file.endsWith("reference.patch"))).toHaveLength(3);
    expect(runner.writtenFiles.filter((file) => file.endsWith("parse-log.py"))).toHaveLength(6);
    expect(
      runner.executedScripts.filter((script) =>
        script === "( cat test-output.log ) >> /agenc-eval/parser-input.log"
      ),
    ).toHaveLength(6);
    expect(
      runner.executedScripts.filter((script) => script.includes("parse-log.py")).every((script) =>
        script.includes("/agenc-eval/parser-input.log ")
      ),
    ).toBe(true);
  });

  test("a target check passing on base disqualifies the candidate", async () => {
    const runner = new FakeContainerRunner([
      { parserResults: { "target-1": "PASSED", "target-2": "FAILED", "regression-1": "PASSED" } },
    ]);
    const result = await runTriplePreflight(runner, INPUTS);
    expect(result.qualified).toBe(false);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]!.failure).toMatchObject({ reason: "base_unexpectedly_passes" });
    expect(result.runs[0]!.failure!.detail).toContain("target-1");
  });

  test("a target check missing from the parsed results counts as failing, not passing", async () => {
    const runner = new FakeContainerRunner([
      { parserResults: { "target-2": "FAILED", "regression-1": "PASSED" } },
      REFERENCE_OK,
      BASE_OK,
      REFERENCE_OK,
      BASE_OK,
      REFERENCE_OK,
    ]);
    const result = await runTriplePreflight(runner, INPUTS);
    expect(result.qualified).toBe(true);
  });

  test("a failing regression check on base disqualifies the candidate", async () => {
    const runner = new FakeContainerRunner([
      { parserResults: { "target-1": "FAILED", "target-2": "FAILED", "regression-1": "FAILED" } },
    ]);
    const result = await runTriplePreflight(runner, INPUTS);
    expect(result.runs[0]!.failure).toMatchObject({ reason: "regression_check_failed" });
    expect(result.runs[0]!.failure!.detail).toContain("regression-1");
  });

  test("a reference solution that does not pass everything disqualifies the candidate", async () => {
    const runner = new FakeContainerRunner([
      BASE_OK,
      { parserResults: { "target-1": "PASSED", "target-2": "FAILED", "regression-1": "PASSED" } },
    ]);
    const result = await runTriplePreflight(runner, INPUTS);
    expect(result.runs[0]!.verdicts.baseFailsTargetChecks).toBe(true);
    expect(result.runs[0]!.failure).toMatchObject({ reason: "reference_solution_failed" });
    expect(result.runs[0]!.failure!.detail).toContain("target-2");
  });

  test("a reference run missing a regression result is a reference failure", async () => {
    const runner = new FakeContainerRunner([
      BASE_OK,
      { parserResults: { "target-1": "PASSED", "target-2": "PASSED" } },
    ]);
    const result = await runTriplePreflight(runner, INPUTS);
    expect(result.runs[0]!.failure).toMatchObject({ reason: "reference_solution_failed" });
    expect(result.runs[0]!.failure!.detail).toContain("regression-1");
  });

  test("classifies patch, rebuild, network, timeout, and parser failures", async () => {
    const scenarios: Array<{ plan: PhasePlan; reason: string }> = [
      { plan: { applyExitCode: 1 }, reason: "patch_apply_failed" },
      { plan: { rebuildExitCode: 2, rebuildStderr: "make: *** error" }, reason: "rebuild_failed" },
      {
        plan: {
          rebuildExitCode: 128,
          rebuildStderr: "fatal: unable to access 'https://github.com/x': Could not resolve host",
        },
        reason: "network_required",
      },
      { plan: { testTimedOut: true }, reason: "timeout" },
      { plan: { parserExitCode: 1 }, reason: "parser_failed" },
      { plan: { parserResults: {} }, reason: "test_command_failed" },
    ];
    for (const scenario of scenarios) {
      const runner = new FakeContainerRunner([scenario.plan]);
      const result = await runTriplePreflight(runner, INPUTS);
      expect(result.qualified).toBe(false);
      expect(result.runs[0]!.failure?.reason).toBe(scenario.reason);
    }
  });

  test("runs the parser in an auxiliary container when the task image has no python3", async () => {
    // Regression for the .NET pilot candidates (spectre.console, MudBlazor):
    // their images ship no python3, and the parser step previously failed as
    // parser_failed, falsely disqualifying healthy candidates.
    const runner = new FakeContainerRunner([
      { ...BASE_OK, pythonMissing: true },
      { ...REFERENCE_OK, pythonMissing: true },
      { ...BASE_OK, pythonMissing: true },
      { ...REFERENCE_OK, pythonMissing: true },
      { ...BASE_OK, pythonMissing: true },
      { ...REFERENCE_OK, pythonMissing: true },
    ]);
    const result = await runTriplePreflight(runner, INPUTS);
    expect(result.runs[0]!.failure).toBeNull();
    expect(result.qualified).toBe(true);
    expect(runner.auxiliaryImages).toHaveLength(6);
    expect(new Set(runner.auxiliaryImages)).toEqual(new Set([DEFAULT_PARSER_FALLBACK_IMAGE]));
    expect(
      runner.copiedFiles.filter((copy) => copy.startsWith("/agenc-eval/parser-input.log")),
    ).toHaveLength(6);
    // Every auxiliary container is removed alongside the six phase containers.
    expect(runner.removedIds.filter((id) => id.startsWith("aux-"))).toHaveLength(6);
    expect(runner.removedIds.filter((id) => id.startsWith("fake-"))).toHaveLength(6);
    const fallbackParses = runner.executedScripts.filter((script) =>
      script.includes("parse-log.py")
    );
    expect(fallbackParses).toHaveLength(6);
  });

  test("a custom parser fallback image is honored", async () => {
    const runner = new FakeContainerRunner([{ ...BASE_OK, pythonMissing: true }]);
    await runTriplePreflight(runner, INPUTS, undefined, {
      parserFallbackImage: "python:3.12-slim",
    });
    expect(new Set(runner.auxiliaryImages)).toEqual(new Set(["python:3.12-slim"]));
  });

  test("mints upstream preflight evidence only for a fully qualified triple", async () => {
    const runner = new FakeContainerRunner([
      BASE_OK, REFERENCE_OK, BASE_OK, REFERENCE_OK, BASE_OK, REFERENCE_OK,
    ]);
    const qualified = await runTriplePreflight(runner, INPUTS);
    const digest = digestOf("9");
    const evidence = mintUpstreamPreflightEvidence(qualified, digest);
    expect(evidence).toMatchObject({
      kind: "agenc.eval.pilot-upstream-triple-preflight",
      evidenceVersion: "1.0.0",
      taskId: TASK.instanceId,
      operatorTaskDigest: digest,
      status: "complete",
    });
    expect(evidence.runs.map((run) => run.runIndex)).toEqual([1, 2, 3]);
    for (const run of evidence.runs) {
      expect(run).toMatchObject({
        coldRebuild: true,
        baseFailsTargetChecks: true,
        basePassesRegressionChecks: true,
        referencePassesAllChecks: true,
      });
    }

    const failedRunner = new FakeContainerRunner([{ applyExitCode: 1 }]);
    const failed = await runTriplePreflight(failedRunner, INPUTS);
    expect(() => mintUpstreamPreflightEvidence(failed, digest)).toThrow(EvalExecutorError);
  });
});

describe("eval executor parser-result extraction", () => {
  test("reads the sentinel line and rejects non-string statuses", () => {
    expect(
      extractParserResults(`noise\n${PARSE_RESULT_SENTINEL}{"a":"PASSED"}\n`),
    ).toEqual({ a: "PASSED" });
    expect(() => extractParserResults("no sentinel")).toThrow(/sentinel/u);
    expect(() => extractParserResults(`${PARSE_RESULT_SENTINEL}[1]`)).toThrow(/JSON object/u);
  });

  test("accepts the full pilot passing vocabulary and nothing looser", () => {
    for (const status of ["PASSED", "passed", "pass", "PASS", "passes", "ok", "OK", " pass "]) {
      expect(testPassed({ t: status }, "t"), status).toBe(true);
    }
    for (
      const status of [
        "fail", "FAILED", "failure", "error", "errored", "skip", "skipped", "SKIPPED",
        "xpass", "not passed", "",
      ]
    ) {
      expect(testPassed({ t: status }, "t"), status).toBe(false);
    }
    expect(testPassed({}, "t")).toBe(false);
  });

  test("a lowercase pass/fail vocabulary qualifies a healthy candidate", async () => {
    // Regression for the first real pilot run: cthackers__adm-zip-559 emits
    // lowercase "pass"/"fail" and was wrongly disqualified as
    // regression_check_failed when only the uppercase vocabulary counted.
    const runner = new FakeContainerRunner([
      { parserResults: { "target-1": "fail", "target-2": "fail", "regression-1": "pass" } },
      { parserResults: { "target-1": "pass", "target-2": "pass", "regression-1": "pass" } },
      { parserResults: { "target-1": "fail", "target-2": "fail", "regression-1": "pass" } },
      { parserResults: { "target-1": "pass", "target-2": "pass", "regression-1": "pass" } },
      { parserResults: { "target-1": "fail", "target-2": "fail", "regression-1": "pass" } },
      { parserResults: { "target-1": "pass", "target-2": "pass", "regression-1": "pass" } },
    ]);
    const result = await runTriplePreflight(runner, INPUTS);
    expect(result.runs[0]!.failure).toBeNull();
    expect(result.qualified).toBe(true);
  });
});

describe("docker runner hermetic guards", () => {
  test("refuses to run an image without an immutable manifest digest", async () => {
    const runner = new DockerContainerRunner();
    await expect(runner.createTaskContainer("ubuntu:latest")).rejects.toThrow(
      /pinned by @sha256 digest/u,
    );
  });

  test("refuses a bare local image ID unless explicitly allowed", async () => {
    const runner = new DockerContainerRunner();
    await expect(runner.createTaskContainer(`sha256:${"a".repeat(64)}`)).rejects.toThrow(
      /pinned by @sha256 digest/u,
    );
  });

  test("refuses container paths that escape simple quoting", async () => {
    const runner = new DockerContainerRunner();
    const handle: ContainerHandle = { id: "x", imageDigest: "sha256:0", workdir: "/testbed" };
    await expect(
      runner.writeFile(handle, "/tmp/it's-a-trap", new Uint8Array(1)),
    ).rejects.toThrow(/invalid container path/u);
    await expect(
      runner.writeFile(handle, "relative/path", new Uint8Array(1)),
    ).rejects.toThrow(/invalid container path/u);
    await expect(
      runner.copyFile(handle, "/ok/source", handle, "relative/target"),
    ).rejects.toThrow(/invalid container path/u);
    await expect(
      runner.copyFile(handle, "/it's-a-trap", handle, "/ok/target"),
    ).rejects.toThrow(/invalid container path/u);
  });
});
