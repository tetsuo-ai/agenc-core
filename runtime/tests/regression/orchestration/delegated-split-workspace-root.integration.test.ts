import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TrajectoryReplayEngine } from "../../../src/eval/replay.js";
import { parseTrajectoryTrace } from "../../../src/eval/types.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../../../benchmarks/v1/incidents", import.meta.url),
);

describe("delegated split-workspace-root regression fixture", () => {
  it("freezes the real delegated workspace mismatch as a failed replay outcome", async () => {
    const [rawTrace, rawExpected, rawSnapshot] = await Promise.all([
      readFile(`${FIXTURE_DIR}/delegated-split-workspace-root.trace.json`, "utf8"),
      readFile(
        `${FIXTURE_DIR}/delegated-split-workspace-root.expected.json`,
        "utf8",
      ),
      readFile(
        `${FIXTURE_DIR}/delegated-split-workspace-root.snapshot.json`,
        "utf8",
      ),
    ]);

    const trace = parseTrajectoryTrace(JSON.parse(rawTrace) as unknown);
    const expected = JSON.parse(rawExpected) as {
      expectedReplay: {
        taskPda: string;
        finalStatus: string;
        policyViolations: number;
        verifierVerdicts: number;
      };
      sourceArtifacts: string[];
      baselineMetrics: {
        toolCalls: number;
        fallbackCount: number;
        spuriousSubagentCount: number;
      };
    };
    const snapshot = JSON.parse(rawSnapshot) as {
      plan: {
        requiresSynthesis: boolean;
        subagentSteps: number;
        sharedArtifact: string;
      };
      childContract: {
        workspaceRoot: string;
        requiredSourceArtifacts: string[];
        targetArtifacts: string[];
      };
      runtimeMismatch: {
        requestedReadPath: string;
        translatedReadPath: string;
        error: string;
      };
      verifier: {
        overall: string;
        pipelineStatus: string;
        unresolvedItems: string[];
      };
    };

    const replay = new TrajectoryReplayEngine({ strictMode: true }).replay(trace);
    const task = replay.tasks[expected.expectedReplay.taskPda];

    expect(task?.status).toBe(expected.expectedReplay.finalStatus);
    expect(task?.status).not.toBe("completed");
    expect(task?.policyViolations).toBe(
      expected.expectedReplay.policyViolations,
    );
    expect(task?.verifierVerdicts).toBe(
      expected.expectedReplay.verifierVerdicts,
    );
    expect(replay.errors).toEqual([]);
    expect(replay.warnings).toEqual([]);

    expect(snapshot.plan).toMatchObject({
      requiresSynthesis: true,
      subagentSteps: 3,
      sharedArtifact: "/workspace/PLAN.md",
    });
    expect(snapshot.childContract.workspaceRoot).toBe("/workspace");
    expect(snapshot.childContract.requiredSourceArtifacts).toEqual([
      "/workspace/PLAN.md",
    ]);
    expect(snapshot.childContract.targetArtifacts).toEqual([
      "/workspace/PLAN.md",
    ]);
    expect(snapshot.runtimeMismatch).toEqual({
      requestedReadPath: "/workspace/PLAN.md",
      translatedReadPath: "/home/tetsuo/git/AgenC/agenc-core/PLAN.md",
      error:
        "Delegated read path \"/home/tetsuo/git/AgenC/agenc-core/PLAN.md\" is outside the execution envelope roots",
    });
    expect(snapshot.verifier.overall).toBe("fail");
    expect(snapshot.verifier.pipelineStatus).toBe("completed");
    expect(snapshot.verifier.unresolvedItems).toContain(
      "contract_violation:required_readFile_not_performed",
    );
    expect(snapshot.verifier.unresolvedItems).toContain(
      "path_inconsistency:workspace_vs_home_tetsuo",
    );

    expect(expected.baselineMetrics.toolCalls).toBe(5);
    expect(expected.baselineMetrics.fallbackCount).toBe(3);
    expect(expected.baselineMetrics.spuriousSubagentCount).toBe(3);
    expect(expected.sourceArtifacts).toHaveLength(5);
  });
});
