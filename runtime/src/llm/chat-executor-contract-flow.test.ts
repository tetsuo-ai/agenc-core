import { describe, expect, it } from "vitest";
import {
  buildRequiredToolEvidenceRetryInstruction,
  canRetryDelegatedOutputWithoutAdditionalToolCalls,
  requiresWorkflowOwnedImplementationCompletion,
  resolveCorrectionAllowedToolNames,
  resolveExecutionToolContractGuidance,
  resolveLegacyCompletionCompatibility,
  resolveRuntimeWorkflowContext,
  validateRequiredToolEvidence,
} from "./chat-executor-contract-flow.js";

describe("chat-executor-contract-flow", () => {
  it("resolves contract guidance against the broader allowed tool universe", () => {
    const guidance = resolveExecutionToolContractGuidance({
      ctx: {
        messageText:
          "Start a durable HTTP server on port 3000 and keep it running until I tell you to stop.",
        allToolCalls: [],
        activeRoutedToolNames: ["system.serverStatus"],
        initialRoutedToolNames: ["desktop.bash"],
        expandedRoutedToolNames: [
          "system.serverStatus",
        ],
        requiredToolEvidence: undefined,
        providerEvidence: undefined,
        response: undefined,
      },
      allowedTools: [
        "desktop.bash",
        "system.serverStart",
        "system.serverStatus",
      ],
    });

    expect(guidance?.routedToolNames).toEqual(["system.serverStart"]);
    expect(guidance?.toolChoice).toBe("required");
  });

  it("prefers the full allowed tool collection for correction retries", () => {
    expect(
      resolveCorrectionAllowedToolNames(
        ["mcp.doom.get_situation_report"],
        ["mcp.doom.start_game", "mcp.doom.set_objective"],
      ),
    ).toEqual([
      "mcp.doom.start_game",
      "mcp.doom.set_objective",
    ]);
  });

  it("synthesizes a runtime-owned workflow contract for direct deterministic implementation", () => {
    const workflowContext = resolveRuntimeWorkflowContext({
      ctx: {
        messageText:
          "Implement src/main.c in the current workspace and finish only when the implementation is complete.",
        allToolCalls: [
          {
            name: "system.writeFile",
            args: {
              path: "/tmp/project/src/main.c",
              content: "int main(void) { return 0; }\n",
            },
            result: JSON.stringify({
              path: "/tmp/project/src/main.c",
              bytesWritten: 30,
            }),
            isError: false,
            durationMs: 2,
          },
        ],
        activeRoutedToolNames: ["system.writeFile"],
        initialRoutedToolNames: ["system.writeFile"],
        expandedRoutedToolNames: [],
        requiredToolEvidence: undefined,
        providerEvidence: undefined,
        response: undefined,
        plannerSummaryState: {
          routeReason: "tool_loop",
        },
        runtimeWorkspaceRoot: "/tmp/project",
        plannerVerificationContract: undefined,
        plannerCompletionContract: undefined,
      } as any,
    });

    expect(workflowContext).toMatchObject({
      ownershipSource: "direct_deterministic_implementation",
      verificationContract: {
        workspaceRoot: "/tmp/project",
        targetArtifacts: ["/tmp/project/src/main.c"],
        verificationMode: "mutation_required",
      },
      completionContract: {
        taskClass: "artifact_only",
      },
    });
  });

  it("does not synthesize implementation ownership for documentation-only direct writes", () => {
    const workflowContext = resolveRuntimeWorkflowContext({
      ctx: {
        messageText: "Update README.md with usage notes for the workspace.",
        allToolCalls: [
          {
            name: "system.writeFile",
            args: {
              path: "/tmp/project/README.md",
              content: "# Usage\n",
            },
            result: JSON.stringify({
              path: "/tmp/project/README.md",
              bytesWritten: 8,
            }),
            isError: false,
            durationMs: 2,
          },
        ],
        activeRoutedToolNames: ["system.writeFile"],
        initialRoutedToolNames: ["system.writeFile"],
        expandedRoutedToolNames: [],
        requiredToolEvidence: undefined,
        providerEvidence: undefined,
        response: undefined,
        plannerSummaryState: {
          routeReason: "tool_loop",
        },
        runtimeWorkspaceRoot: "/tmp/project",
        plannerVerificationContract: undefined,
        plannerCompletionContract: undefined,
      } as any,
    });

    expect(workflowContext).toEqual({});
  });

  it("synthesizes direct implementation ownership for implement-from-plan requests", () => {
    const workflowContext = resolveRuntimeWorkflowContext({
      ctx: {
        messageText:
          "Read all of @PLAN.md and complete every single phase in full.",
        allToolCalls: [
          {
            name: "system.writeFile",
            args: {
              path: "/tmp/project/src/main.c",
              content: "int main(void) { return 0; }\n",
            },
            result: JSON.stringify({
              path: "/tmp/project/src/main.c",
              bytesWritten: 30,
            }),
            isError: false,
            durationMs: 2,
          },
        ],
        activeRoutedToolNames: ["system.writeFile"],
        initialRoutedToolNames: ["system.writeFile"],
        expandedRoutedToolNames: [],
        requiredToolEvidence: undefined,
        providerEvidence: undefined,
        response: undefined,
        plannerSummaryState: {
          routeReason: "plan_artifact_execution_request",
        },
        runtimeWorkspaceRoot: "/tmp/project",
        plannerVerificationContract: undefined,
        plannerCompletionContract: undefined,
      } as any,
    });

    expect(workflowContext).toMatchObject({
      ownershipSource: "direct_deterministic_implementation",
      verificationContract: {
        workspaceRoot: "/tmp/project",
        verificationMode: "mutation_required",
        targetArtifacts: ["/tmp/project/src/main.c"],
      },
      completionContract: {
        taskClass: "artifact_only",
      },
    });
  });

  it("requires workflow-owned completion for implementation-class turns outside legacy compatibility", () => {
    expect(
      requiresWorkflowOwnedImplementationCompletion({
        ctx: {
          messageText:
            "Implement src/main.c in the current workspace and finish only when the implementation is complete.",
          allToolCalls: [
            {
              name: "system.writeFile",
              args: {
                path: "/tmp/project/src/main.c",
                content: "int main(void) { return 0; }\n",
              },
              result: JSON.stringify({
                path: "/tmp/project/src/main.c",
                bytesWritten: 30,
              }),
              isError: false,
              durationMs: 2,
            },
          ],
          activeRoutedToolNames: ["system.writeFile"],
          initialRoutedToolNames: ["system.writeFile"],
          expandedRoutedToolNames: [],
          requiredToolEvidence: undefined,
          providerEvidence: undefined,
          response: undefined,
          plannerSummaryState: {
            routeReason: "tool_loop",
          },
        } as any,
      }),
    ).toBe(true);
  });

  it("keeps implement-from-plan reconnaissance turns inside workflow-owned completion", () => {
    expect(
      requiresWorkflowOwnedImplementationCompletion({
        ctx: {
          messageText:
            "Read all of @PLAN.md and complete every single phase in full.",
          allToolCalls: [
            {
              name: "system.readFile",
              args: {
                path: "/tmp/project/PLAN.md",
              },
              result: JSON.stringify({
                path: "/tmp/project/PLAN.md",
                size: 4096,
              }),
              isError: false,
              durationMs: 2,
            },
          ],
          activeRoutedToolNames: ["system.readFile"],
          initialRoutedToolNames: ["system.readFile"],
          expandedRoutedToolNames: [],
          requiredToolEvidence: undefined,
          providerEvidence: undefined,
          response: undefined,
          plannerSummaryState: {
            routeReason: "plan_artifact_execution_request",
          },
        } as any,
      }),
    ).toBe(true);
  });

  it("does not classify documentation reconnaissance turns as implementation-class work", () => {
    expect(
      requiresWorkflowOwnedImplementationCompletion({
        ctx: {
          messageText: "Update README.md with usage notes for the workspace.",
          allToolCalls: [
            {
              name: "system.readFile",
              args: {
                path: "/tmp/project/README.md",
              },
              result: JSON.stringify({
                path: "/tmp/project/README.md",
                size: 1024,
              }),
              isError: false,
              durationMs: 2,
            },
          ],
          activeRoutedToolNames: ["system.readFile"],
          initialRoutedToolNames: ["system.readFile"],
          expandedRoutedToolNames: [],
          requiredToolEvidence: undefined,
          providerEvidence: undefined,
          response: undefined,
          plannerSummaryState: {
            routeReason: "tool_loop",
          },
        } as any,
      }),
    ).toBe(false);
  });

  it("limits legacy completion compatibility to docs, research, and plan-only turns", () => {
    const docsDecision = resolveLegacyCompletionCompatibility({
      ctx: {
        messageText: "Update README.md with usage notes for the workspace.",
        allToolCalls: [
          {
            name: "system.writeFile",
            args: {
              path: "/tmp/project/README.md",
              content: "# Usage\n",
            },
            result: JSON.stringify({
              path: "/tmp/project/README.md",
              bytesWritten: 8,
            }),
            isError: false,
            durationMs: 2,
          },
        ],
        activeRoutedToolNames: ["system.writeFile"],
        initialRoutedToolNames: ["system.writeFile"],
        expandedRoutedToolNames: [],
        requiredToolEvidence: undefined,
        providerEvidence: undefined,
        response: undefined,
        plannerSummaryState: {
          routeReason: "tool_loop",
        },
      } as any,
    });

    expect(docsDecision).toMatchObject({
      allowed: true,
      compatibilityClass: "docs",
    });

    const researchDecision = resolveLegacyCompletionCompatibility({
      ctx: {
        messageText: "Compare PixiJS and Phaser from official docs and cite sources.",
        allToolCalls: [],
        activeRoutedToolNames: ["web_search"],
        initialRoutedToolNames: ["web_search"],
        expandedRoutedToolNames: [],
        requiredToolEvidence: undefined,
        providerEvidence: {
          citations: ["https://pixijs.com", "https://docs.phaser.io"],
        },
        response: undefined,
        plannerSummaryState: {
          routeReason: "tool_loop",
        },
      } as any,
    });

    expect(researchDecision).toMatchObject({
      allowed: true,
      compatibilityClass: "research",
    });
  });

  it("adds validation-specific retry guidance", () => {
    expect(
      buildRequiredToolEvidenceRetryInstruction({
        missingEvidenceMessage: "Expected browser-grounded evidence",
        validationCode: "low_signal_browser_evidence",
        allowedToolNames: ["browser.navigate", "browser.snapshot"],
      }),
    ).toContain("about:blank state checks do not count");
  });

  it("adapts browser retry guidance for localhost checks on host-only tools", () => {
    const instruction = buildRequiredToolEvidenceRetryInstruction({
      missingEvidenceMessage: "Expected browser-grounded evidence",
      validationCode: "low_signal_browser_evidence",
      allowedToolNames: ["system.bash", "system.browserSessionStart"],
    });

    expect(instruction).toContain("do not use `system.browse` or `system.browserSession*`");
    expect(instruction).toContain("host-side browser verification command");
    expect(instruction).toContain("system.bash");
  });

  it("adds contradictory-completion retry guidance", () => {
    expect(
      buildRequiredToolEvidenceRetryInstruction({
        missingEvidenceMessage:
          "Delegated task output claimed completion while still reporting unresolved work",
        validationCode: "contradictory_completion_claim",
        allowedToolNames: ["system.bash", "system.writeFile"],
      }),
    ).toContain("Do not claim the phase is complete");
  });

  it("adds behavior-first retry guidance when no runnable harness was executed", () => {
    const instruction = buildRequiredToolEvidenceRetryInstruction({
      missingEvidenceMessage:
        "Behavior verification was required, but no runnable behavior harness was executed.",
      validationCode: "missing_behavior_harness",
      allowedToolNames: ["system.bash", "system.writeFile"],
    });

    expect(instruction).toContain(
      "First prefer existing repo-local test, smoke, scenario, or validation commands",
    );
    expect(instruction).toContain(
      "If you add a new test or scenario harness, run it before the implementation",
    );
    expect(instruction).toContain(
      "do not claim completion; report that behavior verification still needs to run",
    );
  });

  it("tells contradictory-completion retries to re-emit a completion-only answer after a fix", () => {
    const instruction = buildRequiredToolEvidenceRetryInstruction({
      missingEvidenceMessage:
        "Delegated task output claimed completion while still reporting unresolved work",
      validationCode: "contradictory_completion_claim",
      allowedToolNames: ["system.readFile", "system.writeFile"],
    });

    expect(instruction).toContain(
      "If the latest allowed-tool evidence fixes the issue, re-emit a completion-only answer grounded in that evidence.",
    );
    expect(instruction).toContain(
      "Report the phase as blocked only when the blocking issue still remains",
    );
  });

  it("adds forbidden-phase retry guidance", () => {
    expect(
      buildRequiredToolEvidenceRetryInstruction({
        missingEvidenceMessage:
          "Delegated phase contract forbids dependency-install commands in this phase",
        validationCode: "forbidden_phase_action",
        allowedToolNames: ["system.listDir", "system.writeFile"],
      }),
    ).toContain("leave verification for the later step");
  });

  it("allows toolless structured-output retries when evidence already exists", () => {
    expect(
      canRetryDelegatedOutputWithoutAdditionalToolCalls({
        validationCode: "expected_json_object",
        toolCalls: [
          {
            name: "system.writeFile",
            args: { path: "README.md" },
            result: JSON.stringify({ path: "/tmp/README.md", bytesWritten: 42 }),
            isError: false,
            durationMs: 3,
          },
        ],
        delegationSpec: {
          task: "write_docs",
          objective: "Write the README in workspace files",
          acceptanceCriteria: ["README.md written"],
        },
      }),
    ).toBe(true);

    const instruction = buildRequiredToolEvidenceRetryInstruction({
      missingEvidenceMessage: "Malformed result contract: expected JSON object output",
      validationCode: "expected_json_object",
      allowedToolNames: [],
      requiresAdditionalToolCalls: false,
    });

    expect(instruction).toContain(
      "The required tool-grounded evidence is already present in this turn.",
    );
    expect(instruction).toContain("Do not call additional tools for this retry.");
    expect(instruction).not.toContain("Before answering, call one or more allowed tools");
  });

  it("allows toolless delegated retries when only the final blocked/completion prose is wrong", () => {
    const toolCalls = [
      {
        name: "system.writeFile",
        args: { path: "/workspace/space-colony/src/simulation.ts" },
        result: JSON.stringify({
          path: "/workspace/space-colony/src/simulation.ts",
          bytesWritten: 4082,
        }),
        isError: false,
        durationMs: 3,
      },
      {
        name: "system.readFile",
        args: { path: "/workspace/space-colony/src/simulation.ts" },
        result: JSON.stringify({
          content: "export function generateAsteroidSurface() { return []; }\n",
        }),
        isError: false,
        durationMs: 2,
      },
    ] as const;

    // blocked_phase_output + file-mutation-requiring spec now returns false
    // because specRequiresFileMutationEvidence detects write intent in the criteria.
    expect(
      canRetryDelegatedOutputWithoutAdditionalToolCalls({
        validationCode: "blocked_phase_output",
        toolCalls,
        delegationSpec: {
          task: "implement_core_drones",
          objective: "Implement the colony simulation and drone core",
          acceptanceCriteria: [
            "Core modules are written in src/",
            "Deterministic serialization implemented",
          ],
        },
      }),
    ).toBe(false);

    expect(
      canRetryDelegatedOutputWithoutAdditionalToolCalls({
        validationCode: "contradictory_completion_claim",
        toolCalls,
        delegationSpec: {
          task: "implement_core_drones",
          objective: "Implement the colony simulation and drone core",
          acceptanceCriteria: [
            "Core modules are written in src/",
            "Deterministic serialization implemented",
          ],
        },
      }),
    ).toBe(false);
  });

  it("validates workflow-owned completion contracts without delegated specs", () => {
    const result = validateRequiredToolEvidence({
      ctx: {
        messageText: "Implement the runtime entry point",
        allToolCalls: [
          {
            name: "system.writeFile",
            args: { path: "/tmp/project/src/main.c" },
            result: JSON.stringify({
              path: "/tmp/project/src/main.c",
              bytesWritten: 64,
            }),
            isError: false,
            durationMs: 2,
          },
        ],
        activeRoutedToolNames: ["system.writeFile"],
        initialRoutedToolNames: ["system.writeFile"],
        expandedRoutedToolNames: [],
        requiredToolEvidence: {
          maxCorrectionAttempts: 1,
          verificationContract: {
            workspaceRoot: "/tmp/project",
            requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
            targetArtifacts: ["/tmp/project/src/main.c"],
            verificationMode: "mutation_required",
          },
          completionContract: {
            taskClass: "build_required",
            placeholdersAllowed: false,
            partialCompletionAllowed: false,
          },
        },
        providerEvidence: undefined,
        response: {
          role: "assistant",
          content: "Implemented /tmp/project/src/main.c.",
          finishReason: "stop",
        },
      } as any,
    });

    expect(result.contractValidation?.code).toBe("missing_required_source_evidence");
    expect(result.missingEvidenceMessage).toContain("source artifacts");
  });

  it("returns an explicit no-harness validation result when behavior is required but no behavior command ran", () => {
    const result = validateRequiredToolEvidence({
      ctx: {
        messageText: "Implement shell job control and verify the behavior",
        allToolCalls: [
          {
            name: "system.writeFile",
            args: { path: "/tmp/project/src/shell.c" },
            result: JSON.stringify({
              path: "/tmp/project/src/shell.c",
              bytesWritten: 128,
            }),
            isError: false,
            durationMs: 2,
          },
        ],
        activeRoutedToolNames: ["system.writeFile"],
        initialRoutedToolNames: ["system.writeFile"],
        expandedRoutedToolNames: [],
        requiredToolEvidence: {
          maxCorrectionAttempts: 1,
          verificationContract: {
            workspaceRoot: "/tmp/project",
            targetArtifacts: ["/tmp/project/src/shell.c"],
            acceptanceCriteria: [
              "Shell job-control behavior is verified with scenario coverage",
            ],
            verificationMode: "mutation_required",
          },
          completionContract: {
            taskClass: "artifact_only",
            placeholdersAllowed: false,
            partialCompletionAllowed: false,
          },
        },
        providerEvidence: undefined,
        response: {
          role: "assistant",
          content: "Implemented /tmp/project/src/shell.c.",
          finishReason: "stop",
        },
      } as any,
    });

    expect(result.contractValidation?.code).toBe("missing_behavior_harness");
    expect(result.missingEvidenceMessage).toContain("Behavior verification was required");
  });

  it("still enforces delegated validation truth in unsafe benchmark mode", () => {
    const result = validateRequiredToolEvidence({
      ctx: {
        messageText: "Scaffold manifests only for the workspace",
        allToolCalls: [
          {
            name: "system.bash",
            args: { command: "npm", args: ["install"] },
            result: JSON.stringify({ stdout: "ok", stderr: "", exitCode: 0 }),
            isError: false,
            durationMs: 3,
          },
        ],
        activeRoutedToolNames: ["system.bash"],
        initialRoutedToolNames: ["system.bash"],
        expandedRoutedToolNames: [],
        requiredToolEvidence: {
          maxCorrectionAttempts: 1,
          unsafeBenchmarkMode: true,
          delegationSpec: {
            task: "scaffold_manifests",
            objective: "Author only manifests/configs and do not execute install/build/test commands in this phase",
            inputContract: "Scaffold only; later deterministic verification runs npm install",
            acceptanceCriteria: ["No install/build/test commands executed or claimed"],
            requiredToolCapabilities: ["system.writeFile", "system.bash"],
          },
        },
        providerEvidence: undefined,
        response: {
          role: "assistant",
          content:
            "**Phase scaffold_manifests completed.** Authored manifests and ran npm install to confirm the links work.",
          finishReason: "stop",
        },
      } as any,
    });

    expect(result.contractValidation).toMatchObject({
      ok: false,
      code: "forbidden_phase_action",
    });
    expect(result.missingEvidenceMessage).toContain("dependency-install commands");
  });
});
