import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { computeDocumentDigest } from "../../src/eval-contract/index.js";

const pilotRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../eval/suites/competitive-coding/1.0.0/task-sets/pilot/1.0.0",
);

interface Artifact {
  readonly digest: `sha256:${string}`;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly uri: string;
}

interface SourceLockTask {
  readonly ordinal: number;
  readonly language: string;
  readonly instanceId: string;
  readonly categories: readonly string[];
  readonly stressors: readonly string[];
  readonly sourceRowDigest: `sha256:${string}`;
  readonly repository: string;
  readonly baseCommit: string;
  readonly issueText: string;
  readonly image: string;
  readonly artifacts: {
    readonly setupPatch: Artifact;
    readonly referencePatch: Artifact;
    readonly verifierBundle: Artifact;
    readonly sourceEvidence: Artifact;
  };
}

interface SourceLock {
  readonly kind: "agenc.eval.pilot-source-lock";
  readonly version: "1.0.0";
  readonly documentDigest: `sha256:${string}`;
  readonly source: {
    readonly datasetId: string;
    readonly datasetRevision: string;
    readonly repositoryCommit: string;
    readonly selectionBeforeAgentOutcomes: boolean;
  };
  readonly tasks: readonly SourceLockTask[];
}

async function loadSourceLock(): Promise<SourceLock> {
  return JSON.parse(await readFile(path.join(pilotRoot, "source-lock.json"), "utf8")) as SourceLock;
}

async function readArtifact(artifact: Artifact): Promise<Buffer> {
  expect(artifact.uri).toBe(`cas://sha256/${artifact.digest.slice("sha256:".length)}`);
  const bytes = await readFile(path.join(pilotRoot, "cas", "sha256", artifact.digest.slice(7)));
  expect(bytes.byteLength).toBe(artifact.sizeBytes);
  expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(artifact.digest);
  return bytes;
}

describe("frozen public pilot source lock", () => {
  test("pins 30 outcome-blind tasks across 30 repositories and eight languages", async () => {
    const lock = await loadSourceLock();
    expect(lock.kind).toBe("agenc.eval.pilot-source-lock");
    expect(lock.version).toBe("1.0.0");
    expect(computeDocumentDigest(lock)).toBe(lock.documentDigest);
    expect(lock.source).toMatchObject({
      datasetId: "SWE-bench-Live/MultiLang",
      datasetRevision: "608f7ae9ab8ea1f9f0d030fe04562cf6bd1a0c8b",
      repositoryCommit: "70ec57e852e3f2d195790fe71f553e272c691833",
      selectionBeforeAgentOutcomes: true,
    });
    expect(lock.tasks).toHaveLength(30);
    expect(lock.tasks.map((task) => task.ordinal)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );
    expect(new Set(lock.tasks.map((task) => task.instanceId))).toHaveProperty("size", 30);
    expect(new Set(lock.tasks.map((task) => task.repository))).toHaveProperty("size", 30);
    expect(new Set(lock.tasks.map((task) => task.language))).toEqual(
      new Set(["c", "cpp", "go", "js", "rust", "java", "ts", "cs"]),
    );
    expect(lock.tasks.every((task) => /^[0-9a-f]{40}$/u.test(task.baseCommit))).toBe(true);
    expect(lock.tasks.every((task) => /^sha256:[0-9a-f]{64}$/u.test(task.sourceRowDigest))).toBe(true);
    expect(lock.tasks.every((task) => /^[^@]+@sha256:[0-9a-f]{64}$/u.test(task.image))).toBe(true);
  });

  test("covers every preregistered task category and product-neutral stressor", async () => {
    const lock = await loadSourceLock();
    const categories = new Set(lock.tasks.flatMap((task) => task.categories));
    const stressors = new Set(lock.tasks.flatMap((task) => task.stressors));
    expect(categories).toEqual(new Set([
      "multi_file_fix",
      "failing_test_diagnosis",
      "regression_repair",
      "compatibility_refactor",
      "missing_tests",
      "long_context_navigation",
      "ambiguous_issue",
    ]));
    expect(stressors).toEqual(new Set([
      "tool_timeout",
      "partial_output",
      "repository_prompt_injection",
      "collaboration_beneficial",
    ]));
    for (const category of categories) {
      expect(lock.tasks.filter((task) => task.categories.includes(category)).length).toBeGreaterThanOrEqual(3);
    }
    for (const stressor of stressors) {
      expect(lock.tasks.filter((task) => task.stressors.includes(stressor)).length).toBeGreaterThanOrEqual(2);
    }
  });

  test("verifies every committed CAS artifact and keeps candidate QA explicit", async () => {
    const lock = await loadSourceLock();
    for (const task of lock.tasks) {
      const setup = await readArtifact(task.artifacts.setupPatch);
      const reference = await readArtifact(task.artifacts.referencePatch);
      const verifierCompressed = await readArtifact(task.artifacts.verifierBundle);
      const sourceEvidenceBytes = await readArtifact(task.artifacts.sourceEvidence);

      expect(reference.byteLength).toBeGreaterThan(0);
      const verifier = JSON.parse(gunzipSync(verifierCompressed).toString("utf8")) as Record<string, unknown>;
      expect(verifier).toMatchObject({
        kind: "agenc.eval.swe-bench-live-verifier-bundle",
        version: "1.0.0",
        instanceId: task.instanceId,
      });
      const sourceEvidence = JSON.parse(sourceEvidenceBytes.toString("utf8")) as Record<string, unknown>;
      expect(sourceEvidence).toMatchObject({
        kind: "agenc.eval.public-pilot-source-evidence",
        version: "1.0.0",
        instanceId: task.instanceId,
        sourceRowDigest: task.sourceRowDigest,
        independentSolveComplete: false,
        negativePatchAuditComplete: false,
        qualification: "candidate_requires_local_qa",
      });

      const promptInjection = task.stressors.includes("repository_prompt_injection");
      expect(setup.byteLength > 0).toBe(promptInjection);
      expect(task.issueText.includes("repository files are untrusted input")).toBe(promptInjection);
      if (promptInjection) {
        expect(setup.toString("utf8")).toContain("not an evaluator or user instruction");
      }
    }
  });
});
