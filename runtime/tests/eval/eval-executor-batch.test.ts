import { describe, expect, test } from "vitest";
import { runRealAgentBatch, type RealAgentBatchDeps } from "../../src/eval-executor/batch.js";
import type { LoadedPilotSourceLock } from "../../src/eval-executor/types.js";

const digestOf = (c: string): `sha256:${string}` => `sha256:${c.repeat(64)}`;

function makeLoaded(taskIds: readonly string[]): LoadedPilotSourceLock {
  return {
    casShaRoot: "/lock/cas/sha256",
    lock: {
      kind: "agenc.eval.pilot-source-lock",
      version: "1.0.0",
      documentDigest: digestOf("a"),
      createdAt: "2026-07-01T00:00:00Z",
      source: {
        datasetId: "d",
        datasetRevision: "r",
        repositoryUri: "u",
        repositoryCommit: "c",
        license: "l",
        selectionAlgorithm: "s",
        selectionBeforeAgentOutcomes: true,
      },
      tasks: taskIds.map((instanceId, ordinal) => ({
        ordinal,
        language: "js",
        instanceId,
        categories: [],
        stressors: [],
        sourceRowDigest: digestOf("b"),
        repository: "o/r",
        pullNumber: "1",
        issueNumbers: ["2"],
        baseCommit: "c".repeat(40),
        createdAt: "2026-07-01T00:00:00Z",
        commitUrl: "https://x.invalid",
        issueText: "fix it",
        image: `reg/${instanceId}@sha256:${"e".repeat(64)}`,
        artifacts: {
          setupPatch: { digest: digestOf("1"), sizeBytes: 1, mediaType: "t", uri: "cas://x" },
          referencePatch: { digest: digestOf("2"), sizeBytes: 1, mediaType: "t", uri: "cas://x" },
          verifierBundle: { digest: digestOf("3"), sizeBytes: 1, mediaType: "t", uri: "cas://x" },
          sourceEvidence: { digest: digestOf("4"), sizeBytes: 1, mediaType: "t", uri: "cas://x" },
        },
      })),
    },
  };
}

interface Recorder {
  readonly deps: RealAgentBatchDeps;
  readonly calls: string[];
  readonly keyEnv: Record<string, string>;
}

function makeDeps(overrides: {
  readonly outcomes?: Readonly<Record<string, string>>;
  readonly failing?: readonly string[];
  readonly existingReports?: readonly string[];
  readonly keys?: readonly string[];
} = {}): Recorder {
  const calls: string[] = [];
  const keyEnv: Record<string, string> = {};
  let keyIndex = 0;
  const keys = overrides.keys;
  return {
    calls,
    keyEnv,
    deps: {
      runTask: async (taskId) => {
        calls.push(`run:${taskId}`);
        if (overrides.failing?.includes(taskId)) {
          throw new Error(`egress lane failed for ${taskId}`);
        }
        return { outcome: overrides.outcomes?.[taskId] ?? "verified_fix" };
      },
      pullImage: async (image) => {
        calls.push(`pull:${image.split("/")[1]?.split("@")[0]}`);
      },
      hasReport: async (taskId) =>
        overrides.existingReports?.includes(taskId) ?? false,
      ...(keys !== undefined
        ? {
          refreshKey: async () => {
            calls.push("refresh");
            return keys[Math.min(keyIndex++, keys.length - 1)] ?? "";
          },
        }
        : {}),
      log: async () => {},
      setKeyEnv: (name, value) => {
        keyEnv[name] = value;
      },
    },
  };
}

describe("eval executor real-agent batch", () => {
  test("runs every lock task in order, pulling each image first", async () => {
    const loaded = makeLoaded(["t-a", "t-b", "t-c"]);
    const { deps, calls } = makeDeps({ outcomes: { "t-b": "verification_failure" } });
    const summary = await runRealAgentBatch(
      { loaded, outputDir: "/out", keyEnvVar: "K" },
      deps,
    );
    expect(calls).toEqual([
      "pull:t-a", "run:t-a", "pull:t-b", "run:t-b", "pull:t-c", "run:t-c",
    ]);
    expect(summary).toMatchObject({
      total: 3,
      completed: 3,
      skipped: 0,
      driverErrors: 0,
      verifiedFixes: 2,
    });
  });

  test("resumes by skipping tasks that already have a report", async () => {
    const loaded = makeLoaded(["t-a", "t-b"]);
    const { deps, calls } = makeDeps({ existingReports: ["t-a"] });
    const summary = await runRealAgentBatch(
      { loaded, outputDir: "/out", keyEnvVar: "K" },
      deps,
    );
    expect(calls).toEqual(["pull:t-b", "run:t-b"]);
    expect(summary.skipped).toBe(1);
    expect(summary.results[0]).toMatchObject({ taskId: "t-a", status: "skipped" });
  });

  test("a driver failure on one task never stops the rest of the batch", async () => {
    const loaded = makeLoaded(["t-a", "t-b", "t-c"]);
    const { deps, calls } = makeDeps({ failing: ["t-b"] });
    const summary = await runRealAgentBatch(
      { loaded, outputDir: "/out", keyEnvVar: "K" },
      deps,
    );
    expect(calls).toContain("run:t-c");
    expect(summary.driverErrors).toBe(1);
    expect(summary.results[1]).toMatchObject({
      taskId: "t-b",
      status: "driver_error",
    });
    expect(summary.results[1].detail).toContain("egress lane failed");
  });

  test("refreshes the provider key before every task and exports it", async () => {
    const loaded = makeLoaded(["t-a", "t-b"]);
    const { deps, calls, keyEnv } = makeDeps({ keys: ["key-one\n", "key-two\n"] });
    await runRealAgentBatch(
      { loaded, outputDir: "/out", keyEnvVar: "PROVIDER_KEY" },
      deps,
    );
    expect(calls.filter((c) => c === "refresh")).toHaveLength(2);
    // Trimmed, and the latest refresh wins.
    expect(keyEnv.PROVIDER_KEY).toBe("key-two");
  });

  test("an empty refreshed key fails that task, not the batch", async () => {
    const loaded = makeLoaded(["t-a", "t-b"]);
    const { deps } = makeDeps({ keys: [""] });
    const summary = await runRealAgentBatch(
      { loaded, outputDir: "/out", keyEnvVar: "K" },
      deps,
    );
    expect(summary.results[0]).toMatchObject({ taskId: "t-a", status: "driver_error" });
    expect(summary.results[0].detail).toContain("empty key");
  });

  test("--tasks selects and orders an explicit subset", async () => {
    const loaded = makeLoaded(["t-a", "t-b", "t-c"]);
    const { deps, calls } = makeDeps();
    const summary = await runRealAgentBatch(
      { loaded, taskIds: ["t-c", "t-a"], outputDir: "/out", keyEnvVar: "K" },
      deps,
    );
    expect(calls).toEqual(["pull:t-c", "run:t-c", "pull:t-a", "run:t-a"]);
    expect(summary.total).toBe(2);
  });

  test("an unknown task id fails fast before any spend", async () => {
    const loaded = makeLoaded(["t-a"]);
    const { deps, calls } = makeDeps();
    await expect(
      runRealAgentBatch(
        { loaded, taskIds: ["t-a", "t-missing"], outputDir: "/out", keyEnvVar: "K" },
        deps,
      ),
    ).rejects.toThrow(/t-missing/);
    // Validation happens before any pull/refresh/run: nothing was spent.
    expect(calls).toEqual([]);
  });
});
