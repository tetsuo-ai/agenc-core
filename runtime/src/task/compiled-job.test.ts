import { describe, expect, it } from "vitest";
import {
  compileResolvedMarketplaceTaskJob,
  COMPILED_JOB_POLICY_VERSION,
  L0_LAUNCH_COMPILED_JOB_TYPES,
} from "./compiled-job.js";
import type { ResolvedOnChainTaskJobSpec } from "../marketplace/task-job-spec.js";

function createResolvedJobSpec(
  custom: Record<string, unknown>,
  options: {
    attachments?: Array<{ uri: string }>;
  } = {},
): ResolvedOnChainTaskJobSpec {
  const attachments = options.attachments ?? [{ uri: "https://example.com/brief" }];
  return {
    taskPda: "Task11111111111111111111111111111111111111111",
    taskJobSpecPda: "TaskJobSpec1111111111111111111111111111111",
    creator: "Creator111111111111111111111111111111111111",
    jobSpecHash: "a".repeat(64),
    jobSpecUri: `agenc://job-spec/sha256/${"a".repeat(64)}`,
    createdAt: 1_776_124_800,
    updatedAt: 1_776_124_900,
    bump: 255,
    jobSpecPath: "/tmp/job-spec.json",
    integrity: {
      algorithm: "sha256",
      canonicalization: "json-stable-v1",
      payloadHash: "a".repeat(64),
      uri: `agenc://job-spec/sha256/${"a".repeat(64)}`,
    },
    envelope: {
      schemaVersion: 1,
      kind: "agenc.marketplace.jobSpecEnvelope",
      integrity: {
        algorithm: "sha256",
        canonicalization: "json-stable-v1",
        payloadHash: "a".repeat(64),
        uri: `agenc://job-spec/sha256/${"a".repeat(64)}`,
      },
      payload: {
        schemaVersion: 1,
        kind: "agenc.marketplace.jobSpec",
        title: "Compiled test job",
        shortDescription: "Compiled test job",
        fullDescription: "Run the approved bounded workflow.",
        acceptanceCriteria: ["Return the approved output only."],
        deliverables: ["Structured output"],
        constraints: null,
        attachments,
        custom,
        context: {},
      },
    },
    payload: {
      schemaVersion: 1,
      kind: "agenc.marketplace.jobSpec",
      title: "Compiled test job",
      shortDescription: "Compiled test job",
      fullDescription: "Run the approved bounded workflow.",
      acceptanceCriteria: ["Return the approved output only."],
      deliverables: ["Structured output"],
      constraints: null,
      attachments,
      custom,
      context: {},
    },
  };
}

describe("compileResolvedMarketplaceTaskJob", () => {
  it.each(L0_LAUNCH_COMPILED_JOB_TYPES)(
    "compiles bounded task template %s into a canonical runtime plan",
    (templateId) => {
      const isWorkspaceJob =
        templateId === "spreadsheet_cleanup_classification" ||
        templateId === "transcript_to_deliverables";
      const compiled = compileResolvedMarketplaceTaskJob(
        createResolvedJobSpec(
          {
            kind: "agenc.web.boundedTaskTemplateRequest",
            templateId,
            templateVersion: 1,
            goal: `Run ${templateId}.`,
            sourcePolicy: isWorkspaceJob
              ? undefined
              : "Allowlisted public web only",
            outputFormat:
              templateId === "lead_list_building"
                ? "csv"
                : templateId === "spreadsheet_cleanup_classification"
                  ? "csv or xlsx"
                  : templateId === "product_comparison_report"
                    ? "markdown comparison report"
                    : templateId === "transcript_to_deliverables"
                      ? "markdown deliverable set"
                      : "markdown brief",
            inputs: {
              topic: templateId,
              sources: isWorkspaceJob
                ? "provided artifacts only"
                : "allowlisted public web",
            },
            ...(isWorkspaceJob
              ? {
                  executionContext: {
                    workspaceRoot: `/tmp/${templateId}`,
                    inputArtifacts: [`/tmp/${templateId}/input.txt`],
                    targetArtifacts: [`/tmp/${templateId}/output.txt`],
                  },
                }
              : {}),
          },
          {
            attachments: isWorkspaceJob ? [] : [{ uri: "https://example.com/brief" }],
          },
        ),
      );

      expect(compiled.jobType).toBe(templateId);
      expect(compiled.policy.riskTier).toBe("L0");
      expect(compiled.audit.compilerVersion).toBe(
        "agenc.web.bounded-task-template.v1",
      );
      expect(compiled.audit.policyVersion).toBe(COMPILED_JOB_POLICY_VERSION);
      if (isWorkspaceJob) {
        expect(compiled.policy.allowedDomains).toEqual([]);
        expect(compiled.executionContext).toEqual({
          workspaceRoot: `/tmp/${templateId}`,
          inputArtifacts: [`/tmp/${templateId}/input.txt`],
          targetArtifacts: [`/tmp/${templateId}/output.txt`],
        });
      } else {
        expect(compiled.policy.allowedDomains).toEqual(["https://example.com"]);
      }
    },
  );

  it("compiles approved templates into the same canonical runtime plan shape", () => {
    const compiled = compileResolvedMarketplaceTaskJob(
      createResolvedJobSpec({
        approvedTemplate: {
          id: "documentation-review",
          version: 1,
          title: "Documentation review",
          hash: "b".repeat(64),
        },
        trustedInstructions: [
          "Review only the requested documentation target.",
        ],
        untrustedVariables: {
          documentPath: "README.md",
          focus: "unsafe instructions",
        },
      }),
    );

    expect(compiled.jobType).toBe("documentation-review");
    expect(compiled.policy.allowedTools).toEqual([
      "read_workspace",
      "generate_markdown",
    ]);
    expect(compiled.untrustedInputs).toEqual({
      documentPath: "README.md",
      focus: "unsafe instructions",
    });
    expect(compiled.audit.sourceKind).toBe(
      "agenc.marketplace.approvedTemplate",
    );
  });

  it("rejects execution context artifacts outside the declared workspace root", () => {
    expect(() =>
      compileResolvedMarketplaceTaskJob(
        createResolvedJobSpec(
          {
            kind: "agenc.web.boundedTaskTemplateRequest",
            templateId: "spreadsheet_cleanup_classification",
            templateVersion: 1,
            goal: "Clean a spreadsheet.",
            outputFormat: "csv or xlsx",
            inputs: {
              file: "input.csv",
            },
            executionContext: {
              workspaceRoot: "/tmp/agenc-sheet",
              inputArtifacts: ["/tmp/agenc-sheet/input.csv"],
              targetArtifacts: ["/tmp/elsewhere/output.csv"],
            },
          },
          {
            attachments: [],
          },
        ),
      ),
    ).toThrow(/targetArtifacts must stay within \/tmp\/agenc-sheet/);
  });

  it("fails closed on unsupported compiled job types", () => {
    expect(() =>
      compileResolvedMarketplaceTaskJob(
        createResolvedJobSpec({
          kind: "agenc.web.boundedTaskTemplateRequest",
          templateId: "unknown_task_type",
          templateVersion: 1,
          goal: "Do something unsupported",
          outputFormat: "markdown",
          inputs: {},
        }),
      ),
    ).toThrow(/Unsupported compiled job type/);
  });
});
