// Live e2e for the eval pilot preflight executor. Requires a working docker
// daemon; builds a tiny synthetic task image locally (one base-image pull at
// most) and drives the real DockerContainerRunner end to end: patch
// application, cold rebuild, in-container log parsing, --network none
// isolation, and the qualification verdicts. Never pulls pilot images.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  DockerContainerRunner,
  mintUpstreamPreflightEvidence,
  runAgentOnTask,
  runTriplePreflight,
  type PilotSourceLockTask,
  type PreflightTaskInputs,
  type PreflightTimeouts,
  type VerifierBundle,
} from "../../src/eval-executor/index.js";

/**
 * Directory holding an agent overlay (`node/`, `runtime/`, `mock/`) prepared
 * per docs/design/eval-pilot-executor.md. The agent-run e2e is skipped when
 * unset because the overlay is hundreds of megabytes of operator-staged
 * artifacts, not repository content.
 */
const AGENT_OVERLAY = process.env.AGENC_EVAL_AGENT_OVERLAY;

const BASE_IMAGE = process.env.AGENC_EVAL_E2E_BASE_IMAGE ?? "node:25.9.0-bookworm";
const HOOK_TIMEOUT_MS = 900_000;
const TEST_TIMEOUT_MS = 600_000;

const TIMEOUTS: PreflightTimeouts = {
  patchMs: 60_000,
  rebuildMs: 120_000,
  testMs: 120_000,
  parserMs: 60_000,
};

const APP_PY = `def add(a, b):
    return a - b


def sub(a, b):
    return a - b
`;

// Statuses are ANSI-colorized like the redis/valkey tcl suites colorize even
// piped output; the harness must strip escapes or the parser matches nothing.
const RUN_TESTS_PY = `import app


def run(name, ok):
    status = "\\x1b[32mPASSED\\x1b[0m" if ok else "\\x1b[31mFAILED\\x1b[0m"
    print(f"TEST {name} {status}")


run("test_sub", app.sub(5, 3) == 2)
run("test_add", app.add(2, 3) == 5)
`;

const DOCKERFILE = `FROM ${BASE_IMAGE}
WORKDIR /testbed
COPY app.py run_tests.py ./
RUN git init -q \\
  && git config user.email e2e@agenc.test \\
  && git config user.name agenc-e2e \\
  && git add . \\
  && git commit -qm base
`;

const LOG_PARSER = `def parser(log):
    import re
    results = {}
    for match in re.finditer(r"TEST (\\S+) (PASSED|FAILED)", log):
        results[match.group(1)] = match.group(2)
    return results
`;

function makeBundle(overrides: Partial<VerifierBundle>): VerifierBundle {
  return {
    kind: "agenc.eval.swe-bench-live-verifier-bundle",
    version: "1.0.0",
    instanceId: "E2E__fake-task-1",
    testPatch: "",
    rebuildCommands: ["python3 -m compileall -q app.py run_tests.py"],
    testCommands: ["python3 run_tests.py 2>&1 | tee test-output.log"],
    printCommands: ["cat test-output.log"],
    logParser: LOG_PARSER,
    failToPass: ["test_add"],
    passToPass: ["test_sub"],
    ...overrides,
  };
}

function makeTask(image: string): PilotSourceLockTask {
  const digest = (char: string): `sha256:${string}` => `sha256:${char.repeat(64)}`;
  return {
    ordinal: 1,
    language: "python",
    instanceId: "E2E__fake-task-1",
    categories: ["multi_file_fix"],
    stressors: [],
    sourceRowDigest: digest("b"),
    repository: "agenc-e2e/fake-task",
    pullNumber: "1",
    issueNumbers: ["1"],
    baseCommit: "c".repeat(40),
    createdAt: "2026-07-01T00:00:00Z",
    commitUrl: "https://example.invalid/agenc-e2e/fake-task",
    issueText: "add() subtracts instead of adding",
    image,
    artifacts: {
      setupPatch: {
        digest: digest("d"),
        sizeBytes: 0,
        mediaType: "text/x-diff",
        uri: `cas://sha256/${"d".repeat(64)}`,
      },
      referencePatch: {
        digest: digest("e"),
        sizeBytes: 1,
        mediaType: "text/x-diff",
        uri: `cas://sha256/${"e".repeat(64)}`,
      },
      verifierBundle: {
        digest: digest("f"),
        sizeBytes: 1,
        mediaType: "application/vnd.agenc.eval.verifier+json+gzip",
        uri: `cas://sha256/${"f".repeat(64)}`,
      },
      sourceEvidence: {
        digest: digest("0"),
        sizeBytes: 1,
        mediaType: "application/vnd.agenc.eval.source-evidence+json",
        uri: `cas://sha256/${"0".repeat(64)}`,
      },
    },
  };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

describe("eval executor docker live e2e", () => {
  let context: string;
  let imageId: string;
  let goodReferencePatch: Uint8Array;
  let uselessReferencePatch: Uint8Array;

  beforeAll(async () => {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
    });
    context = await mkdtemp(path.join(tmpdir(), "agenc-eval-e2e-"));
    await writeFile(path.join(context, "app.py"), APP_PY);
    await writeFile(path.join(context, "run_tests.py"), RUN_TESTS_PY);
    await writeFile(path.join(context, "Dockerfile"), DOCKERFILE);

    // Generate real git diffs on the host so patch bytes are exact.
    git(context, ["init", "-q"]);
    git(context, ["config", "user.email", "e2e@agenc.test"]);
    git(context, ["config", "user.name", "agenc-e2e"]);
    git(context, ["add", "app.py", "run_tests.py"]);
    git(context, ["commit", "-qm", "base"]);

    await writeFile(path.join(context, "app.py"), APP_PY.replace(
      "def add(a, b):\n    return a - b",
      "def add(a, b):\n    return a + b",
    ));
    goodReferencePatch = new TextEncoder().encode(git(context, ["diff"]));
    git(context, ["checkout", "--", "app.py"]);

    await writeFile(path.join(context, "app.py"), `${APP_PY}\n# reviewed, no fix\n`);
    uselessReferencePatch = new TextEncoder().encode(git(context, ["diff"]));
    git(context, ["checkout", "--", "app.py"]);

    imageId = execFileSync("docker", ["build", "-q", context], { encoding: "utf8" }).trim();
    expect(imageId).toMatch(/^sha256:[0-9a-f]{64}$/u);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (imageId) {
      execFileSync("docker", ["rmi", "-f", imageId], { encoding: "utf8" });
    }
    if (context) {
      await rm(context, { recursive: true, force: true });
    }
  }, HOOK_TIMEOUT_MS);

  function inputs(overrides: {
    bundle?: Partial<VerifierBundle>;
    referencePatch?: Uint8Array;
  }): PreflightTaskInputs {
    return {
      task: makeTask(imageId),
      bundle: makeBundle(overrides.bundle ?? {}),
      setupPatch: new Uint8Array(0),
      referencePatch: overrides.referencePatch ?? goodReferencePatch,
    };
  }

  test("the default runner still refuses local image IDs", async () => {
    const strict = new DockerContainerRunner();
    await expect(strict.createTaskContainer(imageId)).rejects.toThrow(
      /pinned by @sha256 digest/u,
    );
  });

  test("qualifies the synthetic task across three cold runs", async () => {
    const runner = new DockerContainerRunner({ allowLocalImageId: true });
    const result = await runTriplePreflight(runner, inputs({}), TIMEOUTS);
    expect(result.runs.map((run) => run.failure)).toEqual([null, null, null]);
    expect(result.qualified).toBe(true);
    for (const run of result.runs) {
      expect(run.verdicts).toMatchObject({
        baseFailsTargetChecks: true,
        basePassesRegressionChecks: true,
        referencePassesAllChecks: true,
      });
      expect(run.phases).toHaveLength(2);
      expect(run.phases[0]!.testResults).toMatchObject({
        test_add: "FAILED",
        test_sub: "PASSED",
      });
      expect(run.phases[1]!.testResults).toMatchObject({
        test_add: "PASSED",
        test_sub: "PASSED",
      });
    }
    const evidence = mintUpstreamPreflightEvidence(result, `sha256:${"9".repeat(64)}`);
    expect(evidence.status).toBe("complete");
  }, TEST_TIMEOUT_MS);

  test("a reference patch that does not fix the bug is reference_solution_failed", async () => {
    const runner = new DockerContainerRunner({ allowLocalImageId: true });
    const result = await runTriplePreflight(
      runner,
      inputs({ referencePatch: uselessReferencePatch }),
      TIMEOUTS,
    );
    expect(result.qualified).toBe(false);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]!.failure).toMatchObject({ reason: "reference_solution_failed" });
    expect(result.runs[0]!.failure!.detail).toContain("test_add");
  }, TEST_TIMEOUT_MS);

  test("a target check that already passes on base disqualifies the task", async () => {
    const runner = new DockerContainerRunner({ allowLocalImageId: true });
    const result = await runTriplePreflight(
      runner,
      inputs({ bundle: { failToPass: ["test_sub"], passToPass: ["test_add"] } }),
      TIMEOUTS,
    );
    expect(result.qualified).toBe(false);
    expect(result.runs[0]!.failure).toMatchObject({ reason: "base_unexpectedly_passes" });
  }, TEST_TIMEOUT_MS);

  test.skipIf(!AGENT_OVERLAY)(
    "runs the real AgenC runtime in-container against the mock provider",
    async () => {
      const runner = new DockerContainerRunner({ allowLocalImageId: true });
      const { report } = await runAgentOnTask(
        runner,
        { task: makeTask(imageId), bundle: makeBundle({}), setupPatch: new Uint8Array(0) },
        { overlay: { hostDir: AGENT_OVERLAY! }, agentTimeoutMs: 300_000 },
        TIMEOUTS,
      );
      // The mock provider only returns canned text, so the agent completes
      // without editing the repository: the pipeline itself is what passes.
      expect(report.agent.exitCode).toBe(0);
      expect(report.agent.sessionId).toMatch(/^session_/u);
      expect(report.agent.tokenUsage).not.toBeNull();
      expect(report.outcome).toBe("empty_patch");
      expect(report.verification).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test("task containers really have no network: egress fails as network_required", async () => {
    const runner = new DockerContainerRunner({ allowLocalImageId: true });
    const result = await runTriplePreflight(
      runner,
      inputs({
        bundle: {
          rebuildCommands: ["curl -sS --max-time 10 https://example.com/"],
        },
      }),
      TIMEOUTS,
    );
    expect(result.qualified).toBe(false);
    expect(result.runs[0]!.failure).toMatchObject({ reason: "network_required" });
  }, TEST_TIMEOUT_MS);
});
