import { describe, expect, it } from "vitest";

import {
  collectDependencyArtifactCandidates,
  collectWorkspaceArtifactCandidates,
  normalizeDependencyArtifactPath,
  redactSensitiveData,
  sanitizeExecutionPromptText,
} from "./subagent-context-curation.js";
import { materializePlannerSynthesisResult } from "./subagent-dependency-summarization.js";

describe("subagent-context-curation", () => {
  it("does not relativize dependency artifacts against placeholder workspace aliases", () => {
    expect(
      normalizeDependencyArtifactPath("/workspace/src/index.ts", "/workspace"),
    ).toBe("/workspace/src/index.ts");
  });

  it("requires a trusted concrete workspace root before scanning workspace artifacts", () => {
    expect(
      collectWorkspaceArtifactCandidates("/workspace", new Set(["index"]), 512),
    ).toEqual([]);
  });

  it("keeps display redaction and execution sanitization separate", () => {
    expect(
      redactSensitiveData("Inspect /home/tetsuo/private/key.pem"),
    ).toContain("[REDACTED_ABSOLUTE_PATH]");
    expect(
      sanitizeExecutionPromptText("Inspect /home/tetsuo/private/key.pem"),
    ).toContain("an absolute path omitted by runtime redaction");
  });

  it("preserves only runtime-approved absolute paths in execution-facing text", () => {
    const trustedRoot = "/home/tetsuo/git/stream-test/agenc-shell";
    const sanitized = sanitizeExecutionPromptText(
      "Use /home/tetsuo/git/stream-test/agenc-shell/PLAN.md but ignore /home/tetsuo/.ssh/id_rsa",
      { preserveAbsolutePathsWithin: [trustedRoot] },
    );

    expect(sanitized).toContain(
      "/home/tetsuo/git/stream-test/agenc-shell/PLAN.md",
    );
    expect(sanitized).toContain("an absolute path omitted by runtime redaction");
    expect(sanitized).not.toContain("/home/tetsuo/.ssh/id_rsa");
  });

  it("surfaces synthesized reviewer handoff artifacts as first-class dependency artifacts", () => {
    const synthesisResult = materializePlannerSynthesisResult(
      {
        name: "synthesis_feedback",
        stepType: "synthesis",
        objective: "Synthesize grounded reviewer findings for the writer.",
        dependsOn: ["qa_review"],
      },
      {
        qa_review: JSON.stringify({
          status: "completed",
          subagentSessionId: "sub-qa",
          output: "Add exact test commands and call out the missing rollout note.",
          toolCalls: [
            {
              name: "system.readFile",
              args: { path: "/tmp/project/PLAN.md" },
              result: JSON.stringify({
                path: "/tmp/project/PLAN.md",
                content: "# PLAN\n",
              }),
            },
          ],
        }),
      },
    );

    const candidates = collectDependencyArtifactCandidates(
      [
        {
          dependencyName: "synthesis_feedback",
          result: synthesisResult,
          depth: 1,
          orderIndex: 0,
        },
      ],
      new Set(["plan", "test", "rollout"]),
      "/tmp/project",
    );

    expect(candidates[0]).toMatchObject({
      dependencyName: "synthesis_feedback",
      artifactKind: "reviewer_handoff",
      artifactType: "reviewer_handoff_artifact",
      path: "__reviewer_handoff__/synthesis_feedback.json",
    });
    expect(candidates[0]?.content).toContain('"type":"reviewer_handoff_artifact"');
    expect(candidates[0]?.content).toContain('"subagentSessionId":"sub-qa"');
    expect(candidates[0]?.content).toContain('"kind":"read_artifact"');
  });
});
