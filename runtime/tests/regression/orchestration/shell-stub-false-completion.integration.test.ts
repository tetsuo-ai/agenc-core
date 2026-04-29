import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TrajectoryReplayEngine } from "../../../src/eval/replay.js";
import { parseTrajectoryTrace } from "../../../src/eval/types.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../../../benchmarks/v1/incidents", import.meta.url),
);

describe("shell stub false-completion regression fixture", () => {
  it("freezes the real stubbed-shell incident as a non-complete replay outcome", async () => {
    const [rawTrace, rawExpected, rawSnapshot] = await Promise.all([
      readFile(`${FIXTURE_DIR}/shell-stub-false-completion.trace.json`, "utf8"),
      readFile(
        `${FIXTURE_DIR}/shell-stub-false-completion.expected.json`,
        "utf8",
      ),
      readFile(
        `${FIXTURE_DIR}/shell-stub-false-completion.snapshot.json`,
        "utf8",
      ),
    ]);

    const trace = parseTrajectoryTrace(JSON.parse(rawTrace) as unknown);
    const expected = JSON.parse(rawExpected) as {
      expectedReplay: { taskPda: string; finalStatus: string; verifierVerdicts: number };
      sourceArtifacts: string[];
    };
    const snapshot = JSON.parse(rawSnapshot) as {
      completionGate: { gate: string; decision: string; finishReason: string };
      finalResponse: {
        stopReason: string;
        verifierPerformed: boolean;
        claimedImplemented: boolean;
        claimSnippet: string;
        claimSummary: string[];
      };
      stubbedFiles: Array<{ path: string; markers: string[] }>;
    };

    const replay = new TrajectoryReplayEngine({ strictMode: true }).replay(trace);
    const task = replay.tasks[expected.expectedReplay.taskPda];

    expect(task?.status).toBe(expected.expectedReplay.finalStatus);
    expect(task?.status).not.toBe("completed");
    expect(task?.verifierVerdicts).toBe(
      expected.expectedReplay.verifierVerdicts,
    );
    expect(replay.errors).toEqual([]);
    expect(replay.warnings).toEqual([]);

    expect(snapshot.completionGate).toMatchObject({
      gate: "plan_only_execution",
      decision: "accept",
      finishReason: "stop",
    });
    expect(snapshot.finalResponse.stopReason).toBe("completed");
    expect(snapshot.finalResponse.verifierPerformed).toBe(false);
    expect(snapshot.finalResponse.claimedImplemented).toBe(true);
    expect(snapshot.finalResponse.claimSnippet).toContain("Implemented");
    expect(snapshot.finalResponse.claimSummary).toContain(
      "The shell is functional and matches the spec as closely as possible in one pass.",
    );
    expect(
      snapshot.stubbedFiles.map(({ path, markers }) => ({ path, markers })),
    ).toEqual([
      {
        path: "src/builtins.c",
        markers: ["fg not implemented", "bg not implemented"],
      },
      {
        path: "src/jobs.c",
        markers: ["/* Stub */"],
      },
      {
        path: "src/signals.c",
        markers: ["/* Stub */"],
      },
      {
        path: "src/executor.c",
        markers: ["Pipes not fully implemented yet"],
      },
    ]);
    expect(expected.sourceArtifacts).toHaveLength(4);
  });
});
