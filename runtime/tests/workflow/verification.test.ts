import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  parseVerificationVerdict,
  runRequiredVerification,
  type WorkflowCommandResult,
  type WorkflowCommandRunner,
} from "../../src/workflow/verification.js";
import type {
  RunArtifactPointer,
  RunStepIdentity,
} from "../../src/contracts/run-contracts.js";
import type { EvidenceArtifactSink } from "../../src/workflow/worktree-lifecycle.js";

const STEP: RunStepIdentity = { runId: "run-v", stepId: "workflow.verify" };

class MemorySink implements EvidenceArtifactSink {
  readonly artifacts: Array<{ role: string; text: string }> = [];

  async recordArtifact(input: {
    step: RunStepIdentity;
    role: RunArtifactPointer["role"];
    bytes: Uint8Array;
    mediaType: string;
  }): Promise<RunArtifactPointer> {
    const hex = createHash("sha256").update(input.bytes).digest("hex");
    this.artifacts.push({
      role: input.role,
      text: new TextDecoder().decode(input.bytes),
    });
    return {
      step: input.step,
      role: input.role,
      digest: `sha256:${hex}`,
      bytes: input.bytes.byteLength,
      storagePath: `cas://sha256/${hex}`,
      recordedAt: "2026-07-20T12:00:00Z",
    };
  }
}

function ok(stdout = "ok\n"): WorkflowCommandResult {
  return {
    exitCode: 0,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(0),
    timedOut: false,
    truncated: false,
    durationMs: 5,
  };
}

describe("M5 required verification", () => {
  it("runs every command bounded by parallelism and never short-circuits", async () => {
    let live = 0;
    let peak = 0;
    const seen: string[] = [];
    const runner: WorkflowCommandRunner = {
      async run({ script }) {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => setTimeout(resolve, 10));
        live -= 1;
        seen.push(script);
        if (script === "exit 1") {
          return { ...ok(), exitCode: 1, stderr: new TextEncoder().encode("boom") };
        }
        return ok(script);
      },
    };
    const sink = new MemorySink();
    const result = await runRequiredVerification({
      worktreePath: "/wt",
      commands: [
        { label: "a", script: "echo a" },
        { label: "fails", script: "exit 1" },
        { label: "b", script: "echo b" },
        { label: "c", script: "echo c" },
      ],
      runner,
      sink,
      step: STEP,
      parallelism: 2,
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(seen).toHaveLength(4);
    expect(result.allPassed).toBe(false);
    expect(result.records.map((record) => record.exitCode)).toEqual([0, 1, 0, 0]);
    expect(result.records[1].stderrDigest).toBe(
      `sha256:${createHash("sha256").update("boom").digest("hex")}`,
    );
    expect(sink.artifacts).toHaveLength(1);
    expect(sink.artifacts[0].role).toBe("test_result");
    expect(sink.artifacts[0].text).toContain('"label":"fails"');
    expect(result.excerpts.fails.stderr).toBe("boom");
  });

  it("treats a runner crash as a failing command with diagnostic stderr", async () => {
    const runner: WorkflowCommandRunner = {
      async run() {
        throw new Error("sandbox exploded");
      },
    };
    const result = await runRequiredVerification({
      worktreePath: "/wt",
      commands: [{ label: "only", script: "echo hi" }],
      runner,
      sink: new MemorySink(),
      step: STEP,
      parallelism: 4,
    });
    expect(result.allPassed).toBe(false);
    expect(result.records[0].exitCode).toBe(127);
    expect(result.excerpts.only.stderr).toContain("sandbox exploded");
  });

  it("a timed-out command can never pass", async () => {
    const runner: WorkflowCommandRunner = {
      async run() {
        return { ...ok(), timedOut: true };
      },
    };
    const result = await runRequiredVerification({
      worktreePath: "/wt",
      commands: [{ label: "hang", script: "sleep 999" }],
      runner,
      sink: new MemorySink(),
      step: STEP,
      parallelism: 1,
    });
    expect(result.allPassed).toBe(false);
  });

  it("rejects duplicate labels and empty command sets", async () => {
    const runner: WorkflowCommandRunner = { run: async () => ok() };
    await expect(
      runRequiredVerification({
        worktreePath: "/wt",
        commands: [],
        runner,
        sink: new MemorySink(),
        step: STEP,
        parallelism: 1,
      }),
    ).rejects.toThrow(/at least one command/);
    await expect(
      runRequiredVerification({
        worktreePath: "/wt",
        commands: [
          { label: "dup", script: "a" },
          { label: "dup", script: "b" },
        ],
        runner,
        sink: new MemorySink(),
        step: STEP,
        parallelism: 1,
      }),
    ).rejects.toThrow(/duplicate verification label/);
  });
});

describe("verification agent verdict parsing", () => {
  it("parses the terminal VERDICT line, last one winning", () => {
    expect(parseVerificationVerdict("...\nVERDICT: PASS\n")).toBe("PASS");
    expect(
      parseVerificationVerdict("VERDICT: PASS\nre-ran suite\nVERDICT: FAIL"),
    ).toBe("FAIL");
    expect(parseVerificationVerdict("  VERDICT: PARTIAL (2 checks skipped)")).toBe(
      "PARTIAL",
    );
  });

  it("a missing or malformed verdict is undefined — callers treat it as failure", () => {
    expect(parseVerificationVerdict("all good, ship it")).toBeUndefined();
    expect(parseVerificationVerdict("VERDICT: SHIP")).toBeUndefined();
    expect(parseVerificationVerdict("the VERDICT: PASS came earlier")).toBeUndefined();
    expect(parseVerificationVerdict("")).toBeUndefined();
  });
});
