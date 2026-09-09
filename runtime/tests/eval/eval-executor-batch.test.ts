import { mkdir, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createRealAgentBatchDeps, runRealAgentBatch, writeRealAgentBatchSummary, type RealAgentBatchDeps } from "../../src/eval-executor/batch.js";
import { digestCanonicalJson } from "../../src/eval-contract/index.js";
import { computeOverlayManifestDigest, type OverlayManifest } from "../../src/eval-executor/overlay-manifest.js";
import type { AgentRunOutcome, AgentRunReport, LoadedPilotSourceLock, PilotSourceLockTask } from "../../src/eval-executor/types.js";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";

const digestOf = (c: string): `sha256:${string}` => `sha256:${c.repeat(64)}`;
const workspaces = createTempWorkspaceFixture("agenc-batch-resume-");
afterEach(async () => { await workspaces.cleanup(); });

function makeReport(task: PilotSourceLockTask, outcome: AgentRunOutcome = "verified_fix") {
  const overlayManifest: OverlayManifest = {
    kind: "agenc.eval.executor-overlay-manifest", version: "1.0.0", mode: "real-provider",
    files: [
      "node/bin/node", "node/compat/libatomic.so.1", "mock/serve.mjs",
      "runtime/node_modules/@tetsuo-ai/runtime/dist/bin/agenc.js",
      "runtime/node_modules/@tetsuo-ai/runtime/dist/VERSION",
      "proxy/allowlist-proxy.mjs", "proxy/eval-egress-probe.mjs",
    ].sort().map((filePath) => ({ path: filePath, digest: digestOf("d"), sizeBytes: 1, mode: 0o644 })),
    links: [],
  };
  const reportBody = {
    taskId: task.instanceId,
    sourceTaskDigest: digestCanonicalJson("agenc.eval.executor-source-task.v1", task),
    startedAt: "2026-09-09T00:00:00.000Z",
    finishedAt: "2026-09-09T00:01:00.000Z",
    promptDigest: digestOf("a"),
    agent: {
      exitCode: 0, timedOut: false, resultTruncated: false, sessionId: "test-session",
      finalMessageDigest: digestOf("b"), tokenUsage: { totalTokens: 0 },
    },
    patch: { digest: digestOf("c"), sizeBytes: 1, truncated: false },
    verification: {
      phase: "reference" as const, imageDigest: task.image, parserImageDigest: null,
      appliedPatches: ["candidate"], commands: [], testResults: { target: "pass" },
    },
    outcome,
    failureDetail: outcome === "verified_fix" ? null : "test failure",
    egress: {
      mode: "real-provider" as const, allowHost: "provider.invalid", keyExposure: "agent-env" as const,
      sidecarOverlayDigest: computeOverlayManifestDigest(overlayManifest), oracleContainment: "contained" as const,
      denyProbes: {
        noRouteOffNet: true, githubBlocked: true, dnsBlackholed: true,
        ipv6Absent: true, ipLiteralRejected: true, sniPinned: true,
      },
      patchKeyScan: "clean" as const,
    },
    environmentDigest: digestOf("e"),
    overlayManifest,
  };
  return {
    ...reportBody,
    reportDigest: digestCanonicalJson("agenc.eval.executor-agent-run-report.v1", reportBody),
  } satisfies AgentRunReport;
}

async function createDiskBatch(taskIds: readonly string[] = ["t-a"]) {
  const outputDir = await workspaces.create();
  const loaded = makeLoaded(taskIds);
  const runTask = vi.fn(async () => ({ outcome: "verified_fix" }));
  const pullImage = vi.fn(async () => {});
  const refreshKey = vi.fn(async () => "test-provider-key");
  const log = vi.fn(async (_line: string) => {});
  const deps = {
    ...createRealAgentBatchDeps({ outputDir, runTask }),
    pullImage, refreshKey, log, setKeyEnv: vi.fn(),
  };
  const reportPath = path.join(outputDir, "t-a", "agent-run-report.json");
  await mkdir(path.dirname(reportPath));
  const run = () => runRealAgentBatch({ loaded, outputDir, keyEnvVar: "TEST_KEY" }, deps);
  return { loaded, outputDir, reportPath, runTask, pullImage, refreshKey, log, run };
}

function serializeChangedReport(report: ReturnType<typeof makeReport>, changes: Record<string, unknown>): string {
  const body = JSON.parse(JSON.stringify({ ...report, ...changes })) as Record<string, unknown>;
  delete body.reportDigest;
  return JSON.stringify({ ...body, reportDigest: digestCanonicalJson("agenc.eval.executor-agent-run-report.v1", body) });
}

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
      loadReport: async (task) => overrides.existingReports?.includes(task.instanceId)
        ? makeReport(task)
        : null,
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
  test("refuses direct resume lookup outside outputDir even for a self-consistent report", async () => {
    const fixture = await createDiskBatch();
    const outside = await workspaces.create();
    const task = { ...fixture.loaded.lock.tasks[0]!, instanceId: path.relative(fixture.outputDir, outside) };
    const bytes = JSON.stringify(makeReport(task));
    const outsideReport = path.join(outside, "agent-run-report.json");
    await writeFile(outsideReport, bytes);
    const deps = createRealAgentBatchDeps({ outputDir: fixture.outputDir, runTask: fixture.runTask });
    await expect(deps.loadReport(task)).rejects.toThrow(/instanceId/u);
    expect(await readFile(outsideReport, "utf8")).toBe(bytes);
    expect(fixture.runTask).not.toHaveBeenCalled();
  });

  test.runIf(process.platform !== "win32")("refuses a linked batch summary instead of overwriting an outside file", async () => {
    const output = await workspaces.create();
    const outside = path.join(await workspaces.create(), "sentinel");
    await writeFile(outside, "unchanged");
    await symlink(outside, path.join(output, "batch-summary.json"));
    await expect(writeRealAgentBatchSummary(output, {
      total: 0, completed: 0, skipped: 0, driverErrors: 0, verifiedFixes: 0, results: [],
    })).rejects.toThrow(/regular file/u);
    expect(await readFile(outside, "utf8")).toBe("unchanged");
  });

  test.each([
    ["empty", () => ""],
    ["truncated", () => '{"taskId":"t-a",'],
    ["scalar", () => "42"],
    ["null", () => "null"],
    ["incomplete", () => '{"taskId":"t-a","outcome":"verified_fix"}'],
    ["wrong task", (report: ReturnType<typeof makeReport>) => serializeChangedReport(report, { taskId: "t-other" })],
    ["wrong source task", (report: ReturnType<typeof makeReport>) => serializeChangedReport(report, { sourceTaskDigest: digestOf("f") })],
    ["legacy unbound", (report: ReturnType<typeof makeReport>) => serializeChangedReport(report, { sourceTaskDigest: undefined })],
    ["legacy unattested overlay", (report: ReturnType<typeof makeReport>) => serializeChangedReport(report, { overlayManifest: undefined })],
    ["mismatched overlay digest", (report: ReturnType<typeof makeReport>) => serializeChangedReport(report, { egress: { ...report.egress, sidecarOverlayDigest: digestOf("f") } })],
    ["wrong overlay lane", (report: ReturnType<typeof makeReport>) => serializeChangedReport(report, { overlayManifest: { ...report.overlayManifest, mode: "offline" } })],
    ["unsupported overlay manifest", (report: ReturnType<typeof makeReport>) => serializeChangedReport(report, { overlayManifest: { ...report.overlayManifest, version: "0.0.0" } })],
    ["incomplete agent", (report: ReturnType<typeof makeReport>) => serializeChangedReport(report, { agent: {} })],
    ["invalid outcome", (report: ReturnType<typeof makeReport>) => serializeChangedReport(report, { outcome: "success" })],
    ["invalid timestamp", (report: ReturnType<typeof makeReport>) => serializeChangedReport(report, { finishedAt: "yesterday" })],
    ["reversed timestamps", (report: ReturnType<typeof makeReport>) => serializeChangedReport(report, { finishedAt: "2026-09-08T00:00:00.000Z" })],
    ["missing verification", (report: ReturnType<typeof makeReport>) => serializeChangedReport(report, { verification: null })],
    ["missing patch", (report: ReturnType<typeof makeReport>) => serializeChangedReport(report, { patch: null })],
    ["unverified containment", (report: ReturnType<typeof makeReport>) => serializeChangedReport(report, { egress: { ...report.egress, oracleContainment: "unverified" } })],
    ["missing deny probe", (report: ReturnType<typeof makeReport>) => serializeChangedReport(report, { egress: { ...report.egress, denyProbes: {} } })],
    ["mock-provider lane", (report: ReturnType<typeof makeReport>) => serializeChangedReport(report, { egress: null })],
    ["incomplete verification command", (report: ReturnType<typeof makeReport>) => serializeChangedReport(report, { verification: { ...report.verification, commands: [{}] } })],
    ["wrong digest", (report: ReturnType<typeof makeReport>) => JSON.stringify({ ...report, reportDigest: digestOf("0") })],
    ["duplicate key", (report: ReturnType<typeof makeReport>) => JSON.stringify(report).replace('{"taskId":', '{"taskId":"t-a","taskId":')],
    ["secret in malformed JSON", () => '{"sensitive":"do-not-print-this-secret"'],
  ] as const)("reports a %s prior report as a driver error without spending", async (_label, serialize) => {
    const fixture = await createDiskBatch();
    const bytes = serialize(makeReport(fixture.loaded.lock.tasks[0]!));
    await writeFile(fixture.reportPath, bytes);
    const summary = await fixture.run();
    expect(summary).toMatchObject({ completed: 0, skipped: 0, driverErrors: 1, verifiedFixes: 0 });
    expect(summary.results[0]).toMatchObject({ outcome: null, status: "driver_error" });
    expect(summary.results[0]?.detail).toMatch(/move.*task directory|new output directory/iu);
    expect(fixture.runTask).not.toHaveBeenCalled();
    expect(fixture.pullImage).not.toHaveBeenCalled();
    expect(fixture.refreshKey).not.toHaveBeenCalled();
    expect(await readFile(fixture.reportPath, "utf8")).toBe(bytes);
    expect(JSON.stringify([summary, fixture.log.mock.calls])).not.toContain("do-not-print-this-secret");
  });

  test("retains a valid prior outcome alongside a newly completed task", async () => {
    const fixture = await createDiskBatch(["t-a", "t-b"]);
    await writeFile(fixture.reportPath, JSON.stringify(makeReport(fixture.loaded.lock.tasks[0]!)));
    const summary = await fixture.run();
    expect(summary).toMatchObject({ total: 2, completed: 1, skipped: 1, driverErrors: 0, verifiedFixes: 2 });
    expect(summary.results[0]).toMatchObject({ status: "skipped", outcome: "verified_fix" });
    expect(fixture.runTask).toHaveBeenCalledExactlyOnceWith("t-b");
  });

  test("retains every outcome when the entire requested batch resumes", async () => {
    const outcomes: readonly AgentRunOutcome[] = [
      "verified_fix", "verification_failure", "empty_patch", "agent_error", "agent_timeout",
      "oracle_containment_unverified", "infrastructure_error",
    ];
    const fixture = await createDiskBatch(outcomes.map((_outcome, index) => `t-${index}`));
    for (const [index, task] of fixture.loaded.lock.tasks.entries()) {
      const directory = path.join(fixture.outputDir, task.instanceId);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "agent-run-report.json"), JSON.stringify(makeReport(task, outcomes[index])));
    }
    const summary = await fixture.run();
    expect(summary).toMatchObject({ total: 7, completed: 0, skipped: 7, driverErrors: 0, verifiedFixes: 1 });
    expect(summary.results.map((result) => result.outcome)).toEqual(outcomes);
    expect(fixture.runTask).not.toHaveBeenCalled();
    expect(fixture.pullImage).not.toHaveBeenCalled();
    expect(fixture.refreshKey).not.toHaveBeenCalled();
  });

  test("keeps processing other tasks after a corrupt prior report", async () => {
    const fixture = await createDiskBatch(["t-a", "t-b"]);
    await writeFile(fixture.reportPath, "");
    expect(await fixture.run()).toMatchObject({ total: 2, completed: 1, skipped: 0, driverErrors: 1, verifiedFixes: 1 });
    expect(fixture.runTask).toHaveBeenCalledExactlyOnceWith("t-b");
  });

  test("rejects a report after the same task ID changes its locked inputs", async () => {
    const fixture = await createDiskBatch();
    const task = fixture.loaded.lock.tasks[0]!;
    await writeFile(fixture.reportPath, JSON.stringify(makeReport({ ...task, baseCommit: "f".repeat(40) })));
    expect(await fixture.run()).toMatchObject({ skipped: 0, driverErrors: 1 });
    expect(fixture.runTask).not.toHaveBeenCalled();
  });

  test("accepts finite usage metrics and truncated agent telemetry when the patch is verified", async () => {
    const fixture = await createDiskBatch();
    const report = makeReport(fixture.loaded.lock.tasks[0]!);
    await writeFile(fixture.reportPath, serializeChangedReport(report, {
      agent: { ...report.agent, resultTruncated: true, tokenUsage: { totalTokens: 12, cost: 0.01 } },
    }));
    expect(await fixture.run()).toMatchObject({ skipped: 1, driverErrors: 0, verifiedFixes: 1 });
  });

  test.each(["infrastructure_error", "verified_fix"] as const)("handles an uncreated verifier container for %s", async (outcome) => {
    const fixture = await createDiskBatch();
    const report = makeReport(fixture.loaded.lock.tasks[0]!, outcome);
    await writeFile(fixture.reportPath, serializeChangedReport(report, {
      verification: { ...report.verification, imageDigest: "", appliedPatches: [], commands: [], testResults: null },
    }));
    const summary = await fixture.run();
    if (outcome === "infrastructure_error") {
      expect(summary).toMatchObject({ skipped: 1, driverErrors: 0, verifiedFixes: 0 });
      expect(summary.results[0]?.outcome).toBe(outcome);
    } else expect(summary).toMatchObject({ skipped: 0, driverErrors: 1, verifiedFixes: 0 });
    expect(fixture.runTask).not.toHaveBeenCalled();
    expect(fixture.pullImage).not.toHaveBeenCalled();
    expect(fixture.refreshKey).not.toHaveBeenCalled();
  });

  test("executes absent reports but refuses a directory, symlink, oversized file, and invalid UTF-8", async () => {
    const absent = await createDiskBatch();
    expect(await absent.run()).toMatchObject({ completed: 1, skipped: 0, driverErrors: 0 });
    for (const kind of ["directory", "symlink", "oversized", "invalid-utf8"]) {
      const fixture = await createDiskBatch();
      if (kind === "directory") await mkdir(fixture.reportPath);
      else if (kind === "symlink") {
        const target = path.join(fixture.outputDir, "report-target.json");
        await writeFile(target, JSON.stringify(makeReport(fixture.loaded.lock.tasks[0]!)));
        await symlink(target, fixture.reportPath);
      } else if (kind === "oversized") {
        await writeFile(fixture.reportPath, "");
        await truncate(fixture.reportPath, 16_777_217);
      } else await writeFile(fixture.reportPath, Uint8Array.of(0xff, 0xfe));
      expect(await fixture.run()).toMatchObject({ completed: 0, skipped: 0, driverErrors: 1 });
      expect(fixture.runTask).not.toHaveBeenCalled();
      expect(fixture.pullImage).not.toHaveBeenCalled();
    }
  });

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
