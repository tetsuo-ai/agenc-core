import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  runAgentOnTask,
  EvalExecutorError,
  PARSE_RESULT_SENTINEL,
  type AgentRunConfig,
  type AgentRunInputs,
  type ContainerEnvironment,
  type ContainerExecRequest,
  type ContainerExecResult,
  type ContainerHandle,
  type ContainerRunner,
  type CreateTaskContainerOptions,
  type PilotSourceLockTask,
  type VerifierBundle,
} from "../../src/eval-executor/index.js";

const digestOf = (char: string): `sha256:${string}` => `sha256:${char.repeat(64)}`;
const IMAGE = `registry.example/fake-task@sha256:${"a".repeat(64)}`;

function makeTask(setupPatchBytes: number): PilotSourceLockTask {
  return {
    ordinal: 1,
    language: "js",
    instanceId: "Fake__agent-task-1",
    categories: ["multi_file_fix"],
    stressors: [],
    sourceRowDigest: digestOf("b"),
    repository: "fake/agent-task",
    pullNumber: "1",
    issueNumbers: ["2"],
    baseCommit: "c".repeat(40),
    createdAt: "2026-07-01T00:00:00Z",
    commitUrl: "https://example.invalid/fake/agent-task",
    issueText: "add() subtracts instead of adding",
    image: IMAGE,
    artifacts: {
      setupPatch: {
        digest: digestOf("d"),
        sizeBytes: setupPatchBytes,
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
}

const BUNDLE: VerifierBundle = {
  kind: "agenc.eval.swe-bench-live-verifier-bundle",
  version: "1.0.0",
  instanceId: "Fake__agent-task-1",
  testPatch: "diff --git a/test b/test\n",
  rebuildCommands: ["make rebuild"],
  testCommands: ["make test 2>&1 | tee test-output.log"],
  printCommands: ["cat test-output.log"],
  logParser: "def parser(log):\n    return {}\n",
  failToPass: ["target-1"],
  passToPass: ["regression-1"],
};

const OK: ContainerExecResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  truncated: false,
  durationMs: 1,
};

interface AgentContainerPlan {
  readonly kind: "agent";
  readonly agentExitCode?: number;
  readonly agentTimedOut?: boolean;
  readonly agentResultJson?: string;
  /** Raw diff bytes; the fake base64-encodes them like the real collection. */
  readonly patchDiff?: string;
  readonly patchTruncated?: boolean;
}

interface VerifyContainerPlan {
  readonly kind: "verify";
  readonly parserResults: Record<string, string>;
}

type ContainerPlan = AgentContainerPlan | VerifyContainerPlan;

class FakeAgentRunner implements ContainerRunner {
  readonly createOptions: Array<CreateTaskContainerOptions | undefined> = [];
  readonly writtenFiles: string[] = [];
  private index = -1;

  constructor(private readonly plans: readonly ContainerPlan[]) {}

  async environment(): Promise<ContainerEnvironment> {
    return { engine: "docker", serverVersion: "0.0.0-fake", platform: "linux", arch: "x64" };
  }

  async createTaskContainer(
    imageReference: string,
    options?: CreateTaskContainerOptions,
  ): Promise<ContainerHandle> {
    expect(imageReference).toBe(IMAGE);
    this.index += 1;
    this.createOptions.push(options);
    if (this.index >= this.plans.length) throw new Error("fake ran out of container plans");
    return { id: `c-${this.index}`, imageDigest: "sha256:x", workdir: "/testbed" };
  }

  async createAuxiliaryContainer(imageReference: string): Promise<ContainerHandle> {
    return { id: "aux", imageDigest: imageReference, workdir: "/" };
  }

  async exec(_handle: ContainerHandle, request: ContainerExecRequest): Promise<ContainerExecResult> {
    const plan = this.plans[this.index]!;
    if (plan.kind === "agent") {
      if (request.script.includes("dist/bin/agenc.js") || request.script.startsWith("set -u")) {
        return { ...OK, exitCode: plan.agentExitCode ?? 0, timedOut: plan.agentTimedOut ?? false };
      }
      if (request.script.startsWith("cat /agenc-eval/agent-result.json")) {
        return { ...OK, stdout: plan.agentResultJson ?? "" };
      }
      if (request.script.startsWith("tail -c 2000")) {
        return { ...OK, stdout: "agent stderr tail" };
      }
      if (request.script.includes("diff agenc-eval-baseline HEAD")) {
        // latin1 gives a 1:1 char->byte mapping, modelling git emitting raw
        // bytes that the real collection base64-encodes in-container.
        return {
          ...OK,
          stdout: Buffer.from(plan.patchDiff ?? "", "latin1").toString("base64"),
          truncated: plan.patchTruncated ?? false,
        };
      }
      if (request.script.includes(" apply ")) return OK;
      throw new Error(`unexpected agent-container script: ${request.script}`);
    }
    if (request.script.includes(" apply ")) return OK;
    if (request.script === "make rebuild") return OK;
    if (request.script.startsWith("make test")) return { ...OK, exitCode: 1 };
    if (request.script.endsWith(">> /agenc-eval/parser-input.log")) return OK;
    if (request.script === "command -v python3") return OK;
    if (request.script.includes("parse-log.py")) {
      return { ...OK, stdout: `${PARSE_RESULT_SENTINEL}${JSON.stringify(plan.parserResults)}\n` };
    }
    throw new Error(`unexpected verify-container script: ${request.script}`);
  }

  async writeFile(handle: ContainerHandle, containerPath: string): Promise<void> {
    this.writtenFiles.push(`${handle.id}:${containerPath}`);
  }

  async copyFile(): Promise<void> {}
  async remove(): Promise<void> {}
}

async function makeOverlay(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agenc-agent-overlay-"));
  await mkdir(path.join(dir, "node", "bin"), { recursive: true });
  await writeFile(path.join(dir, "node", "bin", "node"), "");
  await mkdir(path.join(dir, "node", "compat"), { recursive: true });
  await writeFile(path.join(dir, "node", "compat", "libatomic.so.1"), "");
  const runtimeBin = path.join(
    dir, "runtime", "node_modules", "@tetsuo-ai", "runtime", "dist", "bin",
  );
  await mkdir(runtimeBin, { recursive: true });
  await writeFile(path.join(runtimeBin, "agenc.js"), "// fake agent build\n");
  await mkdir(path.join(dir, "mock"), { recursive: true });
  await writeFile(path.join(dir, "mock", "serve.mjs"), "");
  return dir;
}

const AGENT_RESULT = JSON.stringify({
  type: "result",
  sessionId: "session_test",
  exitCode: 0,
  finalMessage: "done",
  tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
});

const PATCH = "diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-x\n+y\n";

describe("eval executor agent run", () => {
  async function withOverlay(fn: (config: AgentRunConfig) => Promise<void>): Promise<void> {
    const dir = await makeOverlay();
    try {
      await fn({ overlay: { hostDir: dir } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const EMPTY_SETUP: AgentRunInputs = {
    task: makeTask(0),
    bundle: BUNDLE,
    setupPatch: new Uint8Array(0),
  };

  test("verified fix: agent patch passes every hidden check", async () => {
    await withOverlay(async (config) => {
      const runner = new FakeAgentRunner([
        { kind: "agent", agentResultJson: AGENT_RESULT, patchDiff: PATCH },
        { kind: "verify", parserResults: { "target-1": "pass", "regression-1": "pass" } },
      ]);
      const { report, patchBytes } = await runAgentOnTask(runner, EMPTY_SETUP, config);
      expect(report.outcome).toBe("verified_fix");
      expect(report.agent.sessionId).toBe("session_test");
      expect(report.agent.tokenUsage).toMatchObject({ totalTokens: 15 });
      expect(new TextDecoder().decode(patchBytes!)).toBe(PATCH);
      expect(report.verification).not.toBeNull();
      expect(report.reportDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      // Agent container carries only the overlay mount; verification runs
      // with no mounts. (Network isolation is unconditional in the runner.)
      expect(runner.createOptions[0]!.readOnlyMounts).toHaveLength(1);
      expect(runner.createOptions[1]?.readOnlyMounts ?? []).toHaveLength(0);
      // Oracle isolation: only the prompt reaches the agent container (c-0);
      // the test patch lands only in the verify container (c-1).
      expect(runner.writtenFiles.filter((f) => f.startsWith("c-0:"))).toEqual([
        "c-0:/agenc-eval/prompt.txt",
      ]);
      expect(
        runner.writtenFiles.filter((f) => f.startsWith("c-1:") && f.includes("test.patch")),
      ).toHaveLength(1);
    });
  });

  test("a patch failing a hidden check is verification_failure with evidence", async () => {
    await withOverlay(async (config) => {
      const runner = new FakeAgentRunner([
        { kind: "agent", agentResultJson: AGENT_RESULT, patchDiff: PATCH },
        { kind: "verify", parserResults: { "target-1": "fail", "regression-1": "pass" } },
      ]);
      const { report } = await runAgentOnTask(runner, EMPTY_SETUP, config);
      expect(report.outcome).toBe("verification_failure");
      expect(report.failureDetail).toContain("target-1");
    });
  });

  test("an unchanged repository is empty_patch and skips verification", async () => {
    await withOverlay(async (config) => {
      const runner = new FakeAgentRunner([
        { kind: "agent", agentResultJson: AGENT_RESULT, patchDiff: "" },
      ]);
      const { report, patchBytes } = await runAgentOnTask(runner, EMPTY_SETUP, config);
      expect(report.outcome).toBe("empty_patch");
      expect(report.verification).toBeNull();
      expect(patchBytes).toBeNull();
    });
  });

  test("a nonempty setup patch does not leak into the collected candidate", async () => {
    // The collected patch is base64 of `diff <baseline> HEAD`, where the
    // baseline is committed AFTER the setup patch — so setup hunks are never
    // in the candidate even when the task has a real setup patch. Regression
    // for the double-collection bug.
    await withOverlay(async (config) => {
      const inputs: AgentRunInputs = {
        task: makeTask(40),
        bundle: BUNDLE,
        setupPatch: new TextEncoder().encode("diff --git a/setup b/setup\n"),
      };
      const runner = new FakeAgentRunner([
        { kind: "agent", agentResultJson: AGENT_RESULT, patchDiff: PATCH },
        { kind: "verify", parserResults: { "target-1": "pass", "regression-1": "pass" } },
      ]);
      const { report, patchBytes } = await runAgentOnTask(runner, inputs, config);
      expect(report.outcome).toBe("verified_fix");
      expect(new TextDecoder().decode(patchBytes!)).toBe(PATCH);
      // setup.patch is applied in the agent container; the baseline commit +
      // tag are what exclude it from the candidate.
      expect(runner.writtenFiles).toContain("c-0:/agenc-eval/setup.patch");
    });
  });

  test("a binary patch survives collection without a lossy text round trip", async () => {
    // base64 transport means non-UTF-8 bytes are preserved exactly.
    await withOverlay(async (config) => {
      const binaryDiff = `diff --git a/x b/x\nGIT binary patch\n\x00\x80\xff\xfe raw\n`;
      const runner = new FakeAgentRunner([
        { kind: "agent", agentResultJson: AGENT_RESULT, patchDiff: binaryDiff },
        { kind: "verify", parserResults: { "target-1": "pass", "regression-1": "pass" } },
      ]);
      const { patchBytes } = await runAgentOnTask(runner, EMPTY_SETUP, config);
      expect(Buffer.from(patchBytes!).toString("latin1")).toBe(binaryDiff);
    });
  });

  test("a truncated patch is never verified", async () => {
    await withOverlay(async (config) => {
      const runner = new FakeAgentRunner([
        { kind: "agent", agentResultJson: AGENT_RESULT, patchDiff: PATCH, patchTruncated: true },
      ]);
      const { report } = await runAgentOnTask(runner, EMPTY_SETUP, config);
      expect(report.outcome).toBe("infrastructure_error");
      expect(report.failureDetail).toContain("capture bound");
      expect(report.verification).toBeNull();
    });
  });

  test("agent failures classify as agent_error, agent_timeout, and mock startup as infrastructure", async () => {
    await withOverlay(async (config) => {
      const errored = new FakeAgentRunner([{ kind: "agent", agentExitCode: 1 }]);
      const erroredRun = await runAgentOnTask(errored, EMPTY_SETUP, config);
      expect(erroredRun.report.outcome).toBe("agent_error");
      expect(erroredRun.report.failureDetail).toContain("agent stderr tail");
    });
    await withOverlay(async (config) => {
      const timed = new FakeAgentRunner([{ kind: "agent", agentTimedOut: true }]);
      const timedRun = await runAgentOnTask(timed, EMPTY_SETUP, config);
      expect(timedRun.report.outcome).toBe("agent_timeout");
    });
    await withOverlay(async (config) => {
      // Exit 86 = the in-container mock never came up: environment, not agent.
      const mockDown = new FakeAgentRunner([{ kind: "agent", agentExitCode: 86 }]);
      const mockRun = await runAgentOnTask(mockDown, EMPTY_SETUP, config);
      expect(mockRun.report.outcome).toBe("infrastructure_error");
      expect(mockRun.report.failureDetail).toContain("mock provider failed");
    });
  });

  test("rejects a broken overlay", async () => {
    const runner = new FakeAgentRunner([]);
    await expect(
      runAgentOnTask(runner, EMPTY_SETUP, { overlay: { hostDir: "/nonexistent-overlay" } }),
    ).rejects.toThrow(EvalExecutorError);
  });
});
