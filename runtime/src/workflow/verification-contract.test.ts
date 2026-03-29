import { describe, expect, it } from "vitest";
import { validateRuntimeVerificationContract } from "./verification-contract.js";

describe("verification-contract", () => {
  it("validates direct workflow verification contracts without a delegated spec", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
        targetArtifacts: ["/tmp/project/src/main.c"],
        verificationMode: "mutation_required",
        acceptanceCriteria: [
          "src/main.c is implemented",
        ],
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
        },
      },
      output: "Implemented /tmp/project/src/main.c.",
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: "/tmp/project/PLAN.md" },
          result: JSON.stringify({ content: "build shell" }),
          isError: false,
        },
        {
          name: "system.writeFile",
          args: { path: "/tmp/project/src/main.c" },
          result: JSON.stringify({
            path: "/tmp/project/src/main.c",
            bytesWritten: 128,
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: true,
      channels: expect.arrayContaining([
        expect.objectContaining({ channel: "artifact_state", ok: true }),
        expect.objectContaining({ channel: "placeholder_stub", ok: true }),
        expect.objectContaining({ channel: "executable_outcome", ok: true }),
        expect.objectContaining({ channel: "rubric", ok: true }),
      ]),
    });
  });

  it("fails workspace-grounded documentation rewrites that never inspect non-target workspace state", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
        targetArtifacts: ["/tmp/project/PLAN.md"],
        verificationMode: "mutation_required",
        acceptanceCriteria: [
          "PLAN.md reflects the current workspace layout and recent directory changes accurately.",
        ],
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "documentation",
        },
      },
      output: "Updated /tmp/project/PLAN.md to reflect the current workspace layout.",
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: "/tmp/project/PLAN.md" },
          result: JSON.stringify({
            path: "/tmp/project/PLAN.md",
            content: "# PLAN\n",
          }),
          isError: false,
        },
        {
          name: "system.writeFile",
          args: {
            path: "/tmp/project/PLAN.md",
            content: "# PLAN\nUpdated\n",
          },
          result: JSON.stringify({
            path: "/tmp/project/PLAN.md",
            bytesWritten: 16,
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: false,
      diagnostic: {
        code: "missing_workspace_inspection_evidence",
      },
      channels: expect.arrayContaining([
        expect.objectContaining({
          channel: "artifact_state",
          ok: false,
        }),
      ]),
    });
  });

  it("accepts workspace-grounded documentation rewrites when non-target workspace inspection is recorded", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
        targetArtifacts: ["/tmp/project/PLAN.md"],
        verificationMode: "mutation_required",
        acceptanceCriteria: [
          "PLAN.md reflects the current workspace layout and recent directory changes accurately.",
        ],
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "documentation",
        },
      },
      output: "Updated /tmp/project/PLAN.md to reflect the current workspace layout.",
      toolCalls: [
        {
          name: "system.listDir",
          args: { path: "/tmp/project/src" },
          result: JSON.stringify({
            path: "/tmp/project/src",
            entries: ["shell.c", "parser.c"],
          }),
          isError: false,
        },
        {
          name: "system.readFile",
          args: { path: "/tmp/project/PLAN.md" },
          result: JSON.stringify({
            path: "/tmp/project/PLAN.md",
            content: "# PLAN\n",
          }),
          isError: false,
        },
        {
          name: "system.writeFile",
          args: {
            path: "/tmp/project/PLAN.md",
            content:
              "# PLAN\nCurrent workspace layout includes src/shell.c and src/parser.c.\n",
          },
          result: JSON.stringify({
            path: "/tmp/project/PLAN.md",
            bytesWritten: 70,
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: true,
      channels: expect.arrayContaining([
        expect.objectContaining({
          channel: "artifact_state",
          ok: true,
        }),
      ]),
    });
  });

  it("accepts documentation rewrites that inherit verified workspace grounding from upstream dependencies", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
        targetArtifacts: ["/tmp/project/PLAN.md"],
        inheritedEvidence: {
          workspaceInspectionSatisfied: true,
          sourceSteps: ["qa_review", "layout_review"],
        },
        verificationMode: "mutation_required",
        acceptanceCriteria: [
          "PLAN.md reflects the current workspace layout and recent directory changes accurately.",
        ],
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "documentation",
        },
      },
      output: "Updated /tmp/project/PLAN.md with the integrated reviewer feedback.",
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: "/tmp/project/PLAN.md" },
          result: JSON.stringify({
            path: "/tmp/project/PLAN.md",
            content: "# PLAN\n",
          }),
          isError: false,
        },
        {
          name: "system.writeFile",
          args: {
            path: "/tmp/project/PLAN.md",
            content:
              "# PLAN\nIntegrated grounded reviewer findings about the current workspace layout.\n",
          },
          result: JSON.stringify({
            path: "/tmp/project/PLAN.md",
            bytesWritten: 82,
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: true,
      channels: expect.arrayContaining([
        expect.objectContaining({
          channel: "artifact_state",
          ok: true,
        }),
      ]),
    });
  });

  it("accepts grounded reviewer findings as successful reviewer work without mutation evidence", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
        verificationMode: "grounded_read",
        stepKind: "delegated_review",
        role: "reviewer",
        acceptanceCriteria: ["Architecture findings are grounded"],
        completionContract: {
          taskClass: "review_required",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
        },
      },
      output: "Grounded architecture findings: PLAN.md is missing the ownership section.",
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: "/tmp/project/PLAN.md" },
          result: JSON.stringify({
            path: "/tmp/project/PLAN.md",
            content: "# PLAN\n",
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: true,
      channels: expect.arrayContaining([
        expect.objectContaining({ channel: "artifact_state", ok: true }),
        expect.objectContaining({ channel: "executable_outcome", ok: true }),
      ]),
    });
  });

  it("rejects writer verification that only reports findings without mutating owned artifacts", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
        targetArtifacts: ["/tmp/project/PLAN.md"],
        verificationMode: "mutation_required",
        stepKind: "delegated_write",
        role: "writer",
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "documentation",
        },
      },
      output: "Grounded findings: PLAN.md still needs an ownership section.",
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: "/tmp/project/PLAN.md" },
          result: JSON.stringify({
            path: "/tmp/project/PLAN.md",
            content: "# PLAN\n",
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: false,
      diagnostic: {
        code: "missing_file_mutation_evidence",
      },
    });
  });

  it("accepts writer grounded no-op success when reported outcome and target reads agree", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
        targetArtifacts: ["/tmp/project/PLAN.md"],
        verificationMode: "mutation_required",
        stepKind: "delegated_write",
        role: "writer",
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "documentation",
        },
      },
      output: '{"reportedOutcome":"already_satisfied","summary":"PLAN.md already satisfies the requested sections."}',
      parsedOutput: {
        reportedOutcome: "already_satisfied",
        summary: "PLAN.md already satisfies the requested sections.",
      },
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: "/tmp/project/PLAN.md" },
          result: JSON.stringify({
            path: "/tmp/project/PLAN.md",
            content: "# PLAN\nOwnership section present.\n",
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: true,
      channels: expect.arrayContaining([
        expect.objectContaining({ channel: "artifact_state", ok: true }),
      ]),
    });
  });

  it("fails placeholder/stub grading when implementation content still contains stub markers", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        targetArtifacts: ["/tmp/project/src/jobs.c"],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "implementation",
        },
      },
      output: "Implemented /tmp/project/src/jobs.c.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/tmp/project/src/jobs.c",
            content: "/* Stub */\nint jobs_init(void) { return 0; }\n",
          },
          result: JSON.stringify({
            path: "/tmp/project/src/jobs.c",
            bytesWritten: 40,
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: false,
      diagnostic: {
        code: "contradictory_completion_claim",
      },
      channels: expect.arrayContaining([
        expect.objectContaining({
          channel: "placeholder_stub",
          ok: false,
        }),
      ]),
    });
  });

  it("allows valid scaffold placeholders when the completion contract explicitly marks the task as scaffold", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        targetArtifacts: ["/tmp/project/src/jobs.c"],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "scaffold_allowed",
          placeholdersAllowed: true,
          partialCompletionAllowed: true,
          placeholderTaxonomy: "scaffold",
        },
      },
      output: "Scaffolded /tmp/project/src/jobs.c with placeholder sections for later implementation.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/tmp/project/src/jobs.c",
            content: "/* Stub */\nint jobs_init(void) { return 0; }\n",
          },
          result: JSON.stringify({
            path: "/tmp/project/src/jobs.c",
            bytesWritten: 40,
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: true,
      channels: expect.arrayContaining([
        expect.objectContaining({
          channel: "placeholder_stub",
          ok: true,
        }),
      ]),
    });
  });

  it("passes repair grading when previously existing placeholders are replaced", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        targetArtifacts: ["/tmp/project/src/jobs.c"],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "repair",
        },
      },
      output: "Repaired /tmp/project/src/jobs.c and resolved the previous stubbed sections.",
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: "/tmp/project/src/jobs.c" },
          result: JSON.stringify({
            content: "/* Stub */\nint jobs_init(void) { return 0; }\n",
          }),
          isError: false,
        },
        {
          name: "system.writeFile",
          args: {
            path: "/tmp/project/src/jobs.c",
            content: "int jobs_init(void) { return 1; }\n",
          },
          result: JSON.stringify({
            path: "/tmp/project/src/jobs.c",
            bytesWritten: 33,
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: true,
      channels: expect.arrayContaining([
        expect.objectContaining({
          channel: "placeholder_stub",
          ok: true,
        }),
      ]),
    });
  });

  it("fails repair grading when previously existing placeholders are preserved", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        targetArtifacts: ["/tmp/project/src/jobs.c"],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "repair",
        },
      },
      output: "Repaired /tmp/project/src/jobs.c.",
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: "/tmp/project/src/jobs.c" },
          result: JSON.stringify({
            content: "/* Stub */\nint jobs_init(void) { return 0; }\n",
          }),
          isError: false,
        },
        {
          name: "system.writeFile",
          args: {
            path: "/tmp/project/src/jobs.c",
            content: "/* Stub */\nint jobs_init(void) { return 0; }\n",
          },
          result: JSON.stringify({
            path: "/tmp/project/src/jobs.c",
            bytesWritten: 40,
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: false,
      diagnostic: {
        code: "contradictory_completion_claim",
      },
      channels: expect.arrayContaining([
        expect.objectContaining({
          channel: "placeholder_stub",
          ok: false,
        }),
      ]),
    });
  });

  it("fails repair grading when new placeholders are introduced into a previously concrete file", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        targetArtifacts: ["/tmp/project/src/jobs.c"],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "repair",
        },
      },
      output: "Repaired /tmp/project/src/jobs.c.",
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: "/tmp/project/src/jobs.c" },
          result: JSON.stringify({
            content: "int jobs_init(void) { return 1; }\n",
          }),
          isError: false,
        },
        {
          name: "system.writeFile",
          args: {
            path: "/tmp/project/src/jobs.c",
            content: "/* Stub */\nint jobs_init(void) { return 0; }\n",
          },
          result: JSON.stringify({
            path: "/tmp/project/src/jobs.c",
            bytesWritten: 40,
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: false,
      diagnostic: {
        code: "contradictory_completion_claim",
      },
      channels: expect.arrayContaining([
        expect.objectContaining({
          channel: "placeholder_stub",
          ok: false,
        }),
      ]),
    });
  });

  it("fails executable-outcome grading when build verification is required but never run", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        targetArtifacts: ["/tmp/project/src/main.c"],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "build_required",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
        },
      },
      output: "Implemented /tmp/project/src/main.c.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/tmp/project/src/main.c",
            content: "int main(void) { return 0; }\n",
          },
          result: JSON.stringify({
            path: "/tmp/project/src/main.c",
            bytesWritten: 29,
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: false,
      diagnostic: {
        code: "acceptance_probe_failed",
      },
      channels: expect.arrayContaining([
        expect.objectContaining({
          channel: "executable_outcome",
          ok: false,
        }),
      ]),
    });
  });

  it("fails with an explicit no-harness diagnostic when behavior verification is required but no behavior command ran", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        targetArtifacts: ["/tmp/project/src/shell.c"],
        acceptanceCriteria: [
          "Shell job-control behavior is verified with scenario coverage",
        ],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
        },
      },
      output: "Implemented /tmp/project/src/shell.c.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/tmp/project/src/shell.c",
            content: "int main(void) { return 0; }\n",
          },
          result: JSON.stringify({
            path: "/tmp/project/src/shell.c",
            bytesWritten: 29,
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: false,
      diagnostic: {
        code: "missing_behavior_harness",
      },
      channels: expect.arrayContaining([
        expect.objectContaining({
          channel: "executable_outcome",
          ok: false,
        }),
      ]),
    });
  });

  it("passes build-only grading when a successful repo-local build command ran", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        targetArtifacts: ["/tmp/project/src/main.c"],
        acceptanceCriteria: ["Build completes cleanly"],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "build_required",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
        },
      },
      output: "Implemented /tmp/project/src/main.c and build passed.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/tmp/project/src/main.c",
            content: "int main(void) { return 0; }\n",
          },
          result: JSON.stringify({
            path: "/tmp/project/src/main.c",
            bytesWritten: 29,
          }),
          isError: false,
        },
        {
          name: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build"],
            cwd: "/tmp/project",
          },
          result: JSON.stringify({
            stdout: "build passed",
            exitCode: 0,
            __agencVerification: {
              category: "build",
              repoLocal: true,
              cwd: "/tmp/project",
              command: "npm run build",
            },
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: true,
      channels: expect.arrayContaining([
        expect.objectContaining({
          channel: "executable_outcome",
          ok: true,
        }),
      ]),
    });
  });

  it("fails rubric grading when grounded acceptance criteria are not evidenced", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
        targetArtifacts: ["/tmp/project/src/router.ts"],
        acceptanceCriteria: [
          "Weighted portal routing is implemented",
        ],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
        },
      },
      output: "Implemented /tmp/project/src/router.ts.",
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: "/tmp/project/PLAN.md" },
          result: JSON.stringify({ content: "Implement weighted portal routing" }),
          isError: false,
        },
        {
          name: "system.writeFile",
          args: {
            path: "/tmp/project/src/router.ts",
            content: "export function route() { return []; }\n",
          },
          result: JSON.stringify({
            path: "/tmp/project/src/router.ts",
            bytesWritten: 38,
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: false,
      diagnostic: {
        code: "acceptance_evidence_missing",
      },
      channels: expect.arrayContaining([
        expect.objectContaining({
          channel: "rubric",
          ok: false,
        }),
      ]),
    });
  });

  it("allows documentation rewrites that accurately describe stubbed or pending code", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        targetArtifacts: ["/tmp/project/PLAN.md"],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "documentation",
        },
      },
      output: "Updated PLAN.md to reflect the current stubbed modules and pending parser work.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/tmp/project/PLAN.md",
            content:
              "# Plan\n\nCurrent state: parser and dispatcher are still stub implementations. Remaining work is pending behind the next milestone.\n",
          },
          result: JSON.stringify({
            path: "/tmp/project/PLAN.md",
            bytesWritten: 124,
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: true,
      channels: expect.arrayContaining([
        expect.objectContaining({
          channel: "placeholder_stub",
          ok: true,
        }),
      ]),
    });
  });

  it("fails documentation rewrites that keep shorthand placeholder elisions", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        targetArtifacts: ["/tmp/project/PLAN.md"],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "documentation",
        },
      },
      output: "Updated PLAN.md completely.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/tmp/project/PLAN.md",
            content:
              "# Plan\n\n[Same as original, copied here]\n\n[etc., full content from original plan]\n",
          },
          result: JSON.stringify({
            path: "/tmp/project/PLAN.md",
            bytesWritten: 80,
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: false,
      diagnostic: {
        code: "contradictory_completion_claim",
      },
      channels: expect.arrayContaining([
        expect.objectContaining({
          channel: "placeholder_stub",
          ok: false,
          message: expect.stringContaining("Documentation completion"),
        }),
      ]),
    });
  });

  it("does not treat TODO.md source artifact paths as unresolved documentation placeholders", () => {
    const decision = validateRuntimeVerificationContract({
      verificationContract: {
        workspaceRoot: "/tmp/project",
        targetArtifacts: ["/tmp/project/PLAN.md"],
        verificationMode: "mutation_required",
        completionContract: {
          taskClass: "artifact_only",
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: "documentation",
        },
      },
      output:
        'result_1: {"path":"/tmp/project/TODO.md","size":849}\n' +
        'result_2: {"path":"/tmp/project/PLAN.md","bytesWritten":16}',
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: "/tmp/project/TODO.md" },
          result: JSON.stringify({
            path: "/tmp/project/TODO.md",
            content: "- shell parser\n- job control\n",
          }),
          isError: false,
        },
        {
          name: "system.writeFile",
          args: {
            path: "/tmp/project/PLAN.md",
            content:
              "# Plan\n\nImplement the shell parser and job control in the next two phases.\n",
          },
          result: JSON.stringify({
            path: "/tmp/project/PLAN.md",
            bytesWritten: 76,
          }),
          isError: false,
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: true,
      channels: expect.arrayContaining([
        expect.objectContaining({
          channel: "placeholder_stub",
          ok: true,
        }),
      ]),
    });
  });
});
