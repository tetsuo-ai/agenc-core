import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  assessPlannerDecision,
  buildPipelineFailureRepairRefinementHint,
  buildPlannerMessages,
  buildPlannerStructuredOutputRequest,
  buildPlannerSynthesisFallbackContent,
  buildPlannerVerificationRequirementsFailureMessage,
  buildPlannerVerificationRequirementsRefinementHint,
  extractPlannerVerificationCommandRequirements,
  extractPlannerVerificationRequirements,
  buildPlannerStructuralRefinementHint,
  classifyPlannerPlanArtifactIntent,
  extractExplicitDeterministicToolRequirements,
  extractExplicitSubagentOrchestrationRequirements,
  parsePlannerPlan,
  plannerRequestImplementsFromArtifact,
  plannerRequestNeedsWorkspaceGroundedArtifactUpdate,
  requestExplicitlyRequestsDelegation,
  salvagePlannerToolCallsAsPlan,
  validatePlannerVerificationRequirements,
  validatePlannerGraph,
  validatePlannerStepContracts,
  validateSalvagedPlannerToolPlan,
  validateExplicitDeterministicToolRequirements,
  validateExplicitSubagentOrchestrationRequirements,
} from "./chat-executor-planner.js";

describe("chat-executor-planner explicit orchestration requirements", () => {
  it("builds a strict documented planner json_schema request", () => {
    expect(buildPlannerStructuredOutputRequest()).toEqual({
      enabled: true,
      schema: expect.objectContaining({
        type: "json_schema",
        name: "agenc_planner_plan",
        strict: true,
      }),
    });
  });

  it("includes non-interactive validation guidance in planner messages", () => {
    const messages = buildPlannerMessages(
      "Create a TypeScript package and run tests before finishing.",
      [],
      512,
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "Verification/build/test commands must be non-interactive and exit on their own.",
          ),
        }),
      ]),
    );
  });

  it("includes first-pass runtime fanout guidance in planner messages", () => {
    const messages = buildPlannerMessages(
      "Create a TypeScript monorepo from scratch with multiple packages, tests, and docs.",
      [],
      512,
      undefined,
      undefined,
      undefined,
      { maxSubagentFanout: 8 },
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "do not rely on more than 8 concurrently runnable subagent_task steps at once unless the user explicitly required a higher child-agent count",
          ),
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "Never merge research with setup/manifest work, or code implementation with broad validation/browser QA.",
          ),
        }),
      ]),
    );
  });

  it("omits numeric fanout guidance when runtime fanout is unlimited", () => {
    const messages = buildPlannerMessages(
      "Create a TypeScript monorepo from scratch with multiple packages, tests, and docs.",
      [],
      512,
      undefined,
      undefined,
      undefined,
      { maxSubagentFanout: 0 },
    );

    expect(messages[0]).toMatchObject({
      role: "system",
    });
    expect(messages[0]?.content).not.toContain(
      "do not rely on more than 0 concurrently runnable subagent_task steps at once",
    );
  });

  it("grounds planner schema examples to the known workspace root", () => {
    const messages = buildPlannerMessages(
      "Go through PLAN.md and implement it.",
      [],
      512,
      undefined,
      undefined,
      undefined,
      undefined,
      "/home/tetsuo/git/AgenC",
    );

    expect(messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining(
        '"workspaceRoot": "/home/tetsuo/git/AgenC"',
      ),
    });
    expect(messages[0]?.content).not.toContain(
      '"workspaceRoot": "/abs/path"',
    );
    expect(messages[0]?.content).not.toContain(
      '"requiredSourceArtifacts": ["/abs/path/PLAN.md"]',
    );
  });

  it("grounds plan-artifact edit schema examples to the requested artifact instead of AGENC.md", () => {
    const messages = buildPlannerMessages(
      "Update PLAN.md so it reflects the corrected architecture and missing validation steps.",
      [],
      512,
      undefined,
      undefined,
      undefined,
      undefined,
      "/home/tetsuo/git/AgenC",
    );

    expect(messages[0]?.content).toContain(
      '"requiredSourceArtifacts": ["/home/tetsuo/git/AgenC/PLAN.md"]',
    );
    expect(messages[0]?.content).toContain(
      '"targetArtifacts": ["/home/tetsuo/git/AgenC/PLAN.md"]',
    );
    expect(messages[0]?.content).not.toContain("AGENC.md");
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "This request must materialize the named planning artifact itself.",
          ),
        }),
      ]),
    );
  });

  it("filters same-target artifact-edit history when the current turn is implementing from the artifact", () => {
    const messages = buildPlannerMessages(
      "Read all of @PLAN.md and implement every phase in full.",
      [
        {
          role: "user",
          content: "Go through @PLAN.md and make sure it is perfect before we implement anything.",
        },
        {
          role: "assistant",
          content: "I found several gaps in PLAN.md and can fix them next.",
        },
        {
          role: "user",
          content: "Keep the workspace root at /tmp/agenc-shell and use gcc with non-interactive tests.",
        },
      ],
      512,
    );

    const finalUserMessage = messages[messages.length - 1];
    expect(finalUserMessage?.role).toBe("user");
    expect(finalUserMessage?.content).not.toContain("make sure it is perfect");
    expect(finalUserMessage?.content).not.toContain("I found several gaps in PLAN.md");
    expect(finalUserMessage?.content).toContain(
      "Keep the workspace root at /tmp/agenc-shell",
    );
  });

  it("keeps different-target artifact history when implementing from a plan artifact", () => {
    const messages = buildPlannerMessages(
      "Read all of @PLAN.md and implement every phase in full.",
      [
        {
          role: "user",
          content: "Please perfect ROADMAP.md before the release.",
        },
      ],
      512,
    );

    const finalUserMessage = messages[messages.length - 1];
    expect(finalUserMessage?.content).toContain("perfect ROADMAP.md");
  });

  it("filters same-target failed implement-from-artifact history when retrying implementation", () => {
    const messages = buildPlannerMessages(
      "Read all of @PLAN.md and implement every phase in full.",
      [
        {
          role: "user",
          content:
            "Can you go through @PLAN.md and implement every phase sequentially in full and make sure they are fully tested.",
        },
        {
          role: "assistant",
          content:
            "Execution stopped before completion (validation_error). Planner emitted a structured plan that failed local validation.",
        },
        {
          role: "user",
          content:
            "Keep the workspace root at /tmp/agenc-shell and do not move to the next phase until tests pass.",
        },
      ],
      512,
    );

    const finalUserMessage = messages[messages.length - 1];
    expect(finalUserMessage?.role).toBe("user");
    expect(finalUserMessage?.content).not.toContain(
      "implement every phase sequentially in full",
    );
    expect(finalUserMessage?.content).not.toContain(
      "Planner emitted a structured plan that failed local validation",
    );
    expect(finalUserMessage?.content).toContain(
      "Keep the workspace root at /tmp/agenc-shell",
    );
  });

  it("treats plain-language delegation research requests as explicit delegation", () => {
    expect(
      requestExplicitlyRequestsDelegation(
        "First run setup checks, then delegate deeper research, then synthesize results.",
      ),
    ).toBe(true);
  });

  it("extracts explicit request-level verification requirements from verification directives", () => {
    expect(
      extractPlannerVerificationRequirements(
        "Create the project from scratch.\n" +
          "Verify with install, build, test, and browser-grounded checks before finishing.\n" +
          "Do not ask clarifying questions.",
      ),
    ).toEqual(["install", "build", "test", "browser"]);
  });

  it("does not infer browser verification from local headless smoke-test prompts", () => {
    expect(
      extractPlannerVerificationRequirements(
        "Build a complete standalone C++ Quake 1-inspired software-rendered FPS prototype in /tmp/codegen-bench-quakeclone-cpp-20260312-r2.\n" +
          "Make it substantial and visually interesting for a live stream: multi-file CMake project, textured or shaded pseudo-3D renderer, player movement, collision, enemies or pickups, map format/loading, and a headless validation mode or scripted smoke test so it can verify progress as it builds.\n" +
          "Keep iterating until it builds and runs cleanly.",
      ),
    ).toEqual(["build", "test"]);
  });

  it("extracts explicit acceptance commands from acceptance criteria", () => {
    expect(
      extractPlannerVerificationCommandRequirements(
        "Acceptance criteria:\n" +
          "- `package.json` exists and uses ESM.\n" +
          "- `node --test` passes from `/tmp/agenc-codegen/regexkit`.\n" +
          "- `node src/cli.mjs match 'a(b|c)+d' 'abbd'` reports a match.\n" +
          "- `node src/cli.mjs grep 'colou?r' fixtures/sample.txt` returns only matching lines.\n" +
          "Hard constraints:\n" +
          "- Do not run `npm install`.\n",
      ),
    ).toEqual([
      "node --test",
      "node src/cli.mjs match 'a(b|c)+d' 'abbd'",
      "node src/cli.mjs grep 'colou?r' fixtures/sample.txt",
    ]);
  });

  it("adds planner guidance to preserve explicit verification coverage", () => {
    const messages = buildPlannerMessages(
      "Create the project from scratch.\n" +
        "Verify with install, build, test, and browser-grounded checks before finishing.",
      [],
      256,
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "Preserve these verification modes in the plan: install -> build -> test -> browser.",
          ),
        }),
      ]),
    );
  });

  it("adds planner guidance to preserve explicit acceptance commands", () => {
    const messages = buildPlannerMessages(
      "Acceptance criteria:\n" +
        "- `node --test` passes from `/tmp/agenc-codegen/regexkit`.\n" +
        "- `node src/cli.mjs explain 'ab|cd*'` prints a useful structured explanation.\n",
      [],
      256,
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "The user explicitly named acceptance commands that must remain represented in the plan.",
          ),
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "`node src/cli.mjs explain 'ab|cd*'`",
          ),
        }),
      ]),
    );
  });

  it("flags planner plans that drop explicit verification modes", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "freight_flow",
        requiresSynthesis: true,
        steps: [
          {
            name: "scaffold_monorepo",
            step_type: "subagent_task",
            objective: "Author manifests and initial source files.",
            input_contract: "Empty project directory.",
            acceptance_criteria: [
              "Workspace files authored",
              "Core, CLI, and web packages scaffolded",
            ],
            required_tool_capabilities: [
              "system.writeFile",
              "system.readFile",
              "system.listDir",
            ],
            execution_context: {
              workspaceRoot: "/tmp/freight-flow-ts",
              allowedReadRoots: ["/tmp/freight-flow-ts"],
              allowedWriteRoots: ["/tmp/freight-flow-ts"],
            },
            max_budget_hint: "4m",
          },
          {
            name: "install_dependencies",
            step_type: "deterministic_tool",
            depends_on: ["scaffold_monorepo"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/freight-flow-ts",
            },
          },
          {
            name: "run_verification",
            step_type: "subagent_task",
            depends_on: ["install_dependencies"],
            objective: "Execute build checks on the workspace before finishing.",
            input_contract: "Implementation complete.",
            acceptance_criteria: [
              "Build succeeds cleanly",
            ],
            required_tool_capabilities: [
              "system.bash",
              "system.readFile",
              "system.writeFile",
            ],
            execution_context: {
              workspaceRoot: "/tmp/freight-flow-ts",
              allowedReadRoots: ["/tmp/freight-flow-ts"],
              allowedWriteRoots: ["/tmp/freight-flow-ts"],
            },
            max_budget_hint: "5m",
          },
          {
            name: "final_synthesis",
            step_type: "synthesis",
            depends_on: ["run_verification"],
          },
        ],
      }),
    );

    const diagnostics = validatePlannerVerificationRequirements(
      result.plan!,
      ["install", "build", "test", "browser"],
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        category: "validation",
        code: "planner_verification_requirements_missing",
        details: expect.objectContaining({
          missingCategories: "test,browser",
          requiredCategories: "install,build,test,browser",
        }),
      }),
    ]);
    expect(
      buildPlannerVerificationRequirementsRefinementHint(
        ["install", "build", "test", "browser"],
        diagnostics,
      ),
    ).toContain("The previous plan dropped: test, browser");
    expect(
      buildPlannerVerificationRequirementsFailureMessage(
        ["install", "build", "test", "browser"],
        diagnostics,
      ),
    ).toContain("Missing verification modes: test, browser");
  });

  it("flags planner plans that drop explicit acceptance commands", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "regexkit",
        requiresSynthesis: true,
        steps: [
          {
            name: "setup_manifests",
            step_type: "subagent_task",
            objective: "Author manifests and create the source layout.",
            input_contract: "Empty scratch directory.",
            acceptance_criteria: [
              "package.json exists and uses ESM",
              "src and test directories exist",
            ],
            required_tool_capabilities: [
              "system.writeFile",
              "system.readFile",
              "system.listDir",
            ],
            execution_context: {
              workspaceRoot: "/tmp/agenc-codegen/regexkit",
              allowedReadRoots: ["/tmp/agenc-codegen/regexkit"],
              allowedWriteRoots: ["/tmp/agenc-codegen/regexkit"],
            },
            max_budget_hint: "4m",
          },
          {
            name: "run_tests",
            step_type: "deterministic_tool",
            depends_on: ["setup_manifests"],
            tool: "system.bash",
            args: {
              command: "node",
              args: ["--test"],
              cwd: "/tmp/agenc-codegen/regexkit",
            },
          },
          {
            name: "final_synthesis",
            step_type: "synthesis",
            depends_on: ["run_tests"],
          },
        ],
      }),
    );

    const diagnostics = validatePlannerVerificationRequirements(
      result.plan!,
      [],
      [
        "node --test",
        "node src/cli.mjs match 'a(b|c)+d' 'abbd'",
        "node src/cli.mjs grep 'colou?r' fixtures/sample.txt",
      ],
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        category: "validation",
        code: "planner_verification_requirements_missing",
        details: expect.objectContaining({
          missingCommands:
            "node src/cli.mjs match 'a(b|c)+d' 'abbd'\n" +
            "node src/cli.mjs grep 'colou?r' fixtures/sample.txt",
        }),
      }),
    ]);
    expect(
      buildPlannerVerificationRequirementsRefinementHint([], diagnostics),
    ).toContain("dropped explicit acceptance commands");
    expect(
      buildPlannerVerificationRequirementsFailureMessage([], diagnostics),
    ).toContain("Missing acceptance commands:");
  });

  it("adds runner-compatible repair guidance for npm test -- --run failures", () => {
    const hint = buildPipelineFailureRepairRefinementHint({
      pipelineResult: {
        status: "failed",
        completedSteps: 4,
        totalSteps: 7,
        error:
          '● Unrecognized CLI Parameter:\n\n  Unrecognized option "run". Did you mean "u"?',
        stopReasonHint: "tool_error",
      },
      plannerPlan: {
        reason: "repair",
        requiresSynthesis: true,
        steps: [
          {
            name: "inspect_workspace",
            stepType: "deterministic_tool",
            tool: "system.listDir",
            args: { path: "/tmp/project" },
          },
          {
            name: "npm_install",
            stepType: "deterministic_tool",
            tool: "system.bash",
            args: { command: "npm", args: ["install"] },
          },
          {
            name: "run_tests",
            stepType: "deterministic_tool",
            tool: "system.bash",
            args: { command: "npm", args: ["test", "--", "--run"] },
          },
        ],
      },
    });

    expect(hint).toContain("runner-compatible single-run command");
    expect(hint).toContain("CI=1 npm test");
  });

  it("grounds missing npm script repair hints with the failing command and cwd", () => {
    const hint = buildPipelineFailureRepairRefinementHint({
      pipelineResult: {
        status: "failed",
        completedSteps: 2,
        totalSteps: 4,
        error:
          'npm ERR! Missing script: "build"\nnpm ERR! To see a list of scripts, run:\nnpm ERR!   npm run',
        stopReasonHint: "tool_error",
      },
      plannerPlan: {
        reason: "repair",
        requiresSynthesis: true,
        steps: [
          {
            name: "scaffold_workspace",
            stepType: "subagent_task",
            objective: "Scaffold the nested workspace app.",
            inputContract: "Repo root exists.",
            acceptanceCriteria: ["Workspace package.json exists"],
            requiredToolCapabilities: ["system.writeFile"],
            contextRequirements: ["repo root"],
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
          {
            name: "build_workspace_app",
            stepType: "deterministic_tool",
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["run", "build"],
              cwd: "/tmp/agenc-umbrella",
            },
          },
        ],
      },
      plannerToolCalls: [
        {
          name: "execute_with_agent",
          args: { objective: "Scaffold the nested workspace app." },
          result: '{"status":"completed","success":true}',
          isError: false,
          durationMs: 0,
        },
        {
          name: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build"],
            cwd: "/tmp/agenc-umbrella",
          },
          result:
            '{"exitCode":1,"stdout":"","stderr":"npm ERR! Missing script: \\"build\\""}',
          isError: true,
          durationMs: 0,
        },
      ],
    });

    expect(hint).toContain("The failed deterministic shell command was `npm run build`");
    expect(hint).toContain("cwd `/tmp/agenc-umbrella`");
    expect(hint).toContain("matching workspace/package-specific command");
    expect(hint).toContain("generic `npm run build`");
  });

  it("adds exact workspace selector repair guidance for planner retry hints", () => {
    const hint = buildPipelineFailureRepairRefinementHint({
      pipelineResult: {
        status: "failed",
        completedSteps: 3,
        totalSteps: 5,
        error:
          "npm error No workspaces found:\nnpm error   --workspace=core --workspace=cli --workspace=web",
        stopReasonHint: "tool_error",
      },
      plannerPlan: {
        reason: "repair",
        requiresSynthesis: true,
        steps: [
          {
            name: "build_workspace_packages",
            stepType: "deterministic_tool",
            tool: "system.bash",
            args: {
              command: "npm",
              args: [
                "run",
                "build",
                "--workspace=core",
                "--workspace=cli",
                "--workspace=web",
              ],
              cwd: "/tmp/transit-weave",
            },
          },
        ],
      },
      plannerToolCalls: [
        {
          name: "system.bash",
          args: {
            command: "npm",
            args: [
              "run",
              "build",
              "--workspace=core",
              "--workspace=cli",
              "--workspace=web",
            ],
            cwd: "/tmp/transit-weave",
          },
          result:
            '{"exitCode":1,"stdout":"","stderr":"npm error No workspaces found:\\nnpm error   --workspace=core --workspace=cli --workspace=web"}',
          isError: true,
          durationMs: 0,
        },
      ],
    });

    expect(hint).toContain("npm could not match one or more `--workspace` selectors");
    expect(hint).toContain("`core`");
    expect(hint).toContain("`cli`");
    expect(hint).toContain("`web`");
    expect(hint).toContain("matching workspace cwd");
  });

  it("adds host tooling planner guidance when npm workspace protocol is unsupported", () => {
    const messages = buildPlannerMessages(
      "Create a TypeScript npm workspace project with package.json files for core and cli.",
      [],
      512,
      undefined,
      undefined,
      {
        nodeVersion: "v25.2.1",
        npm: {
          version: "11.7.0",
          workspaceProtocolSupport: "unsupported",
          workspaceProtocolEvidence: "npm error code EUNSUPPORTEDPROTOCOL",
        },
      },
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "Do not emit `workspace:*` in generated manifests.",
          ),
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("npm error code EUNSUPPORTEDPROTOCOL"),
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "Do not mention `npm install`, build, test, coverage, typecheck, lint, or runtime success",
          ),
        }),
      ]),
    );
  });

  it("adds workspace protocol repair guidance for EUNSUPPORTEDPROTOCOL failures", () => {
    const hint = buildPipelineFailureRepairRefinementHint({
      pipelineResult: {
        status: "failed",
        completedSteps: 9,
        totalSteps: 16,
        error:
          'npm error code EUNSUPPORTEDPROTOCOL\nnpm error Unsupported URL Type "workspace:": workspace:*\n',
        stopReasonHint: "tool_error",
      },
      plannerPlan: {
        reason: "repair",
        requiresSynthesis: true,
        steps: [
          {
            name: "create_project_structure",
            stepType: "deterministic_tool",
            tool: "system.bash",
            args: { command: "mkdir", args: ["-p", "/tmp/project/packages/core"] },
          },
          {
            name: "write_cli_package_json",
            stepType: "deterministic_tool",
            tool: "system.writeFile",
            args: {
              path: "/tmp/project/packages/cli/package.json",
              content: '{"dependencies":{"core":"workspace:*"}}',
            },
          },
          {
            name: "npm_install",
            stepType: "deterministic_tool",
            tool: "system.bash",
            args: { command: "npm", args: ["install"] },
          },
        ],
      },
    });

    expect(hint).toContain("Do not emit `workspace:*`");
    expect(hint).toContain("rerun `npm install`");
  });

  it("adds explicit browser split guidance for implementation-browser decomposition", () => {
    const hint = buildPlannerStructuralRefinementHint([
      {
        category: "validation",
        code: "subagent_step_needs_decomposition",
        message:
          'Planner subagent step "implement_web" is overloaded: Delegated objective is overloaded (implementation, browser).',
        details: {
          stepName: "implement_web",
          phases: "implementation,browser",
          suggestedSteps: "implement_core_scope,browser_validation",
        },
      },
    ]);

    expect(hint).toContain(
      "move browser-session validation into its own later step",
    );
  });

  it("preserves numeric fanout limits in structural refinement hints", () => {
    const hint = buildPlannerStructuralRefinementHint([
      {
        category: "validation",
        code: "subagent_fanout_exceeded",
        message: "Planner fanout exceeded",
        details: {
          maxFanoutPerTurn: 8,
        },
      },
    ]);

    expect(hint).toContain("maxFanoutPerTurn=8");
    expect(hint).not.toContain("the configured limit");
  });

  it("adds explicit no-verification guidance for pre-install scaffold steps", () => {
    const hint = buildPlannerStructuralRefinementHint([
      {
        category: "validation",
        code: "node_workspace_install_phase_mismatch",
        message:
          'Planner subagent step "scaffold_manifests" mixes Node workspace manifest/config scaffolding with install-sensitive verification before install',
        details: {
          stepName: "scaffold_manifests",
          installSteps: "run_npm_install",
          verificationModes: "runner_or_build_tooling",
          requiresPhaseSplit: "true",
        },
      },
    ]);

    expect(hint).toContain(
      "do not mention install/build/test/typecheck/lint/coverage success",
    );
    expect(hint).toContain(
      "Limit it to authored files, scripts, configs, directories, and local dependency links",
    );
  });

  it("treats execute_with_agent child-memory prompts as planner-worthy delegation turns", () => {
    const decision = assessPlannerDecision(
      true,
      "LIVE-ENDURANCE-R7 C1. Use execute_with_agent for this exact task. In the child agent, memorize token ONYX-SHARD-58 for later recall and answer exactly CHILD-STORED-R7-C1. Return exactly the child answer.",
      [],
    );

    expect(decision.shouldPlan).toBe(true);
    expect(decision.reason).toContain("delegation_cue");
  });

  it("forces planner routing for grounded plan-artifact expansion requests", () => {
    const decision = assessPlannerDecision(
      true,
      "i want you to read @TODO.md and turn it into a complete plan for making a shell in the c-programming language.",
      [],
    );

    expect(decision.shouldPlan).toBe(true);
    expect(decision.reason).toContain("plan_artifact_request");
  });

  it("forces planner routing for plan-artifact execution requests", () => {
    const decision = assessPlannerDecision(
      true,
      "Update PLAN.md so it reflects the corrected architecture and missing validation steps.",
      [],
    );

    expect(decision.shouldPlan).toBe(true);
    expect(decision.reason).toContain("plan_artifact_execution_request");
  });

  it("routes implement-from-plan requests through the planner without classifying them as artifact edits", () => {
    const messageText =
      "You are to read all of @PLAN.md and complete every single phase in full.";

    expect(classifyPlannerPlanArtifactIntent(messageText)).toBe(
      "implement_from_artifact",
    );
    expect(plannerRequestImplementsFromArtifact(messageText)).toBe(true);

    const decision = assessPlannerDecision(true, messageText, []);

    expect(decision.shouldPlan).toBe(true);
    expect(decision.reason).toContain("artifact_spec_execution_request");
  });

  it("extracts required subagent steps from the compact 'plan required' prompt shape", () => {
    const requirements = extractExplicitSubagentOrchestrationRequirements(
      "Subagent context audit SG3. Sub-agent orchestration plan required: " +
        "1. recover_marker: recover the earlier continuity marker from parent conversation context only; do not invent missing facts. " +
        "2. echo_marker: using desktop.bash, run /usr/bin/printf so it prints the recovered marker exactly once. " +
        "Final deliverables: recovered marker, printed output, known limitations.",
    );

    expect(requirements).toBeDefined();
    expect(requirements?.stepNames).toEqual([
      "recover_marker",
      "echo_marker",
    ]);
    expect(requirements?.requiresSynthesis).toBe(true);
    expect(requirements?.steps[0]?.description).toContain(
      "recover the earlier continuity marker",
    );
  });

  it("extracts minimum-step orchestration requirements from natural-language multi-agent requests", () => {
    const requirements = extractExplicitSubagentOrchestrationRequirements(
      "Read PLAN.md, create 6 agents with different roles to review architecture, QA, security, documentation, layout, and completeness, then update PLAN.md with the result.",
    );

    expect(requirements).toMatchObject({
      mode: "minimum_steps",
      requiredStepCount: 6,
    });
    expect(requirements?.roleHints).toEqual(
      expect.arrayContaining([
        "architecture",
        "qa",
        "security",
        "documentation",
        "layout",
        "completeness",
      ]),
    );
  });

  it("fails validation when an implicit multi-agent request is collapsed into too few child steps", () => {
    const requirements = extractExplicitSubagentOrchestrationRequirements(
      "Read PLAN.md, create 3 agents with different roles to review architecture, QA, and security, then update PLAN.md.",
    );
    expect(requirements).toBeDefined();

    const diagnostics =
      validateExplicitSubagentOrchestrationRequirements(
        {
          reason: "collapsed_multi_agent_review",
          requiresSynthesis: true,
          steps: [
            {
              name: "architecture_review",
              stepType: "subagent_task",
              objective: "Review architecture alignment only.",
              inputContract: "Return architecture review notes.",
              acceptanceCriteria: ["Architecture review completed"],
              requiredToolCapabilities: ["system.readFile"],
              contextRequirements: ["repo_context"],
              maxBudgetHint: "2m",
              canRunParallel: true,
            },
            {
              name: "qa_review",
              stepType: "subagent_task",
              objective: "Review QA and test coverage only.",
              inputContract: "Return QA review notes.",
              acceptanceCriteria: ["QA review completed"],
              requiredToolCapabilities: ["system.readFile"],
              contextRequirements: ["repo_context"],
              maxBudgetHint: "2m",
              canRunParallel: true,
            },
          ],
          edges: [],
        },
        requirements!,
      );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "required_subagent_steps_missing",
        }),
        expect.objectContaining({
          code: "required_subagent_role_missing",
          details: expect.objectContaining({
            missingRoles: expect.stringContaining("security"),
          }),
        }),
      ]),
    );
  });

  it("does not flag user-mandated multi-agent reviewer plans as generic fanout overflow", () => {
    const requirements = extractExplicitSubagentOrchestrationRequirements(
      "Read PLAN.md, create 2 agents with different roles to review architecture and QA, then update PLAN.md.",
    );
    expect(requirements).toBeDefined();

    const diagnostics = validatePlannerGraph(
      {
        reason: "user_mandated_multi_agent_review",
        requiresSynthesis: true,
        steps: [
          {
            name: "architecture_review",
            stepType: "subagent_task",
            objective: "Review architecture alignment only.",
            inputContract: "Return architecture review notes.",
            acceptanceCriteria: ["Architecture review completed"],
            requiredToolCapabilities: ["system.readFile"],
            contextRequirements: ["repo_context"],
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
          {
            name: "qa_review",
            stepType: "subagent_task",
            objective: "Review QA/test gaps only.",
            inputContract: "Return QA review notes.",
            acceptanceCriteria: ["QA review completed"],
            requiredToolCapabilities: ["system.readFile"],
            contextRequirements: ["repo_context"],
            maxBudgetHint: "2m",
            canRunParallel: false,
            dependsOn: ["architecture_review"],
          },
        ],
        edges: [
          {
            from: "architecture_review",
            to: "qa_review",
          },
        ],
      },
      {
        maxSubagentFanout: 1,
        maxSubagentDepth: 4,
      },
      requirements,
    );

    expect(diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "subagent_fanout_exceeded",
        }),
      ]),
    );
  });

  it("preserves explicit planner tool capabilities instead of merging heuristic repair defaults", () => {
    const requirements = extractExplicitSubagentOrchestrationRequirements(
      "Sub-agent orchestration plan required: " +
        "1. design_research: define the simulator rules and data model in workspace files. " +
        "2. tech_research: choose the stack and repo layout. " +
        "Final deliverables: implementation-ready workspace.",
    );

    const parsed = parsePlannerPlan(
      JSON.stringify({
        reason: "explicit_orchestration",
        requiresSynthesis: true,
        steps: [
          {
            name: "design_research",
            step_type: "subagent_task",
            objective:
              "Define the rules and data model for a rail-freight dispatch simulator.",
            input_contract: "User requirements for the simulator",
            acceptance_criteria: [
              "Defined TypeScript interfaces for Network, Segment, Train, Job, Scenario",
              "Documented simulation rules including conflicts, locks, deadlock, deadlines",
              "Authored design document or types in workspace files",
            ],
            required_tool_capabilities: [
              "system.bash",
              "system.writeFile",
              "system.readFile",
              "system.listDir",
            ],
            execution_context: {
              workspaceRoot: "/tmp/freight-flow-ts",
              allowedReadRoots: ["/tmp/freight-flow-ts"],
              allowedWriteRoots: ["/tmp/freight-flow-ts"],
            },
            max_budget_hint: "3m",
          },
        ],
      }),
      requirements,
    );

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.plan?.steps).toEqual([
      expect.objectContaining({
        name: "design_research",
        stepType: "subagent_task",
        requiredToolCapabilities: [
          "system.bash",
          "system.writeFile",
          "system.readFile",
          "system.listDir",
        ],
      }),
    ]);
  });

  it("treats zero fanout as unlimited during planner graph validation", () => {
    const diagnostics = validatePlannerGraph(
      {
        requiresSynthesis: true,
        steps: [
          {
            name: "review_architecture",
            stepType: "subagent_task",
            objective: "Review the architecture grounding.",
            inputContract: "Read the workspace and return grounded findings.",
            acceptanceCriteria: ["Findings are grounded in the workspace."],
            requiredToolCapabilities: ["system.readFile"],
            contextRequirements: ["repo_context"],
            maxBudgetHint: "2m",
            canRunParallel: true,
          },
          {
            name: "review_quality",
            stepType: "subagent_task",
            objective: "Review the quality risks.",
            inputContract: "Read the workspace and return grounded findings.",
            acceptanceCriteria: ["Findings are grounded in the workspace."],
            requiredToolCapabilities: ["system.readFile"],
            contextRequirements: ["repo_context"],
            maxBudgetHint: "2m",
            canRunParallel: true,
          },
        ],
        edges: [],
      },
      {
        maxSubagentFanout: 0,
        maxSubagentDepth: 4,
      },
    );

    expect(diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "subagent_fanout_exceeded",
        }),
      ]),
    );
  });

  it("preserves semantic planner capabilities instead of falling back to heuristic repair defaults", () => {
    const requirements = extractExplicitSubagentOrchestrationRequirements(
      "Sub-agent orchestration plan required: " +
        "1. design_research: define the simulator rules and data model in workspace files. " +
        "2. tech_research: choose the stack and repo layout. " +
        "Final deliverables: implementation-ready workspace.",
    );

    const parsed = parsePlannerPlan(
      JSON.stringify({
        reason: "explicit_orchestration",
        requiresSynthesis: true,
        steps: [
          {
            name: "design_research",
            step_type: "subagent_task",
            objective:
              "Define rules, invariants, and data model for rail freight simulator in workspace files.",
            input_contract: "Fresh workspace dir at /tmp/freight-flow-ts",
            acceptance_criteria: [
              "Data models as TS interfaces in core/src",
              "Rules/invariants in Markdown or code comments",
              "Sample scenario JSONs authored",
              "Only file authoring completed",
            ],
            required_tool_capabilities: ["filesystem", "code_generation"],
            execution_context: {
              workspaceRoot: "/tmp/freight-flow-ts",
              allowedReadRoots: ["/tmp/freight-flow-ts"],
              allowedWriteRoots: ["/tmp/freight-flow-ts"],
            },
            max_budget_hint: "12m",
          },
        ],
      }),
      requirements,
    );

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.plan?.steps).toEqual([
      expect.objectContaining({
        name: "design_research",
        stepType: "subagent_task",
        requiredToolCapabilities: ["filesystem", "code_generation"],
      }),
    ]);
  });

  it("preserves the typed workflow step contract from planner parsing", () => {
    const parsed = parsePlannerPlan(
      JSON.stringify({
        reason: "artifact_review_and_rewrite",
        requiresSynthesis: true,
        steps: [
          {
            name: "architecture_review",
            step_type: "subagent_task",
            objective: "Review PLAN.md for architecture drift only.",
            input_contract: "Return grounded findings only.",
            acceptance_criteria: ["Ground findings in PLAN.md"],
            required_tool_capabilities: ["system.readFile"],
            execution_context: {
              workspaceRoot: "/tmp/project",
              allowedReadRoots: ["/tmp/project"],
              requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
              effectClass: "read_only",
              verificationMode: "grounded_read",
              stepKind: "delegated_review",
              role: "reviewer",
              artifactRelations: [
                {
                  relationType: "read_dependency",
                  artifactPath: "/tmp/project/PLAN.md",
                },
              ],
            },
            max_budget_hint: "2m",
          },
          {
            name: "rewrite_plan",
            step_type: "subagent_task",
            objective: "Update PLAN.md with the synthesized review findings.",
            input_contract: "Ground on the current PLAN.md and reviewer findings.",
            acceptance_criteria: ["PLAN.md updated accurately"],
            required_tool_capabilities: ["system.readFile", "system.writeFile"],
            execution_context: {
              workspaceRoot: "/tmp/project",
              allowedReadRoots: ["/tmp/project"],
              allowedWriteRoots: ["/tmp/project"],
              requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
              targetArtifacts: ["/tmp/project/PLAN.md"],
              effectClass: "filesystem_write",
              verificationMode: "mutation_required",
              stepKind: "delegated_write",
              role: "writer",
              artifactRelations: [
                {
                  relationType: "read_dependency",
                  artifactPath: "/tmp/project/PLAN.md",
                },
                {
                  relationType: "write_owner",
                  artifactPath: "/tmp/project/PLAN.md",
                },
              ],
            },
            max_budget_hint: "3m",
          },
        ],
      }),
    );

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.plan?.workflowContract).toMatchObject({
      workflowClass: "artifact_review_and_rewrite",
      steps: expect.arrayContaining([
        expect.objectContaining({
          name: "architecture_review",
          role: "reviewer",
          artifactRelations: [
            {
              relationType: "read_dependency",
              artifactPath: "/tmp/project/PLAN.md",
            },
          ],
        }),
        expect.objectContaining({
          name: "rewrite_plan",
          role: "writer",
          artifactRelations: expect.arrayContaining([
            {
              relationType: "write_owner",
              artifactPath: "/tmp/project/PLAN.md",
            },
          ]),
        }),
      ]),
    });
    expect(parsed.plan?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "architecture_review",
          workflowStep: expect.objectContaining({
            role: "reviewer",
            artifactRelations: [
              {
                relationType: "read_dependency",
                artifactPath: "/tmp/project/PLAN.md",
              },
            ],
          }),
        }),
        expect.objectContaining({
          name: "rewrite_plan",
          workflowStep: expect.objectContaining({
            role: "writer",
            artifactRelations: expect.arrayContaining([
              {
                relationType: "write_owner",
                artifactPath: "/tmp/project/PLAN.md",
              },
            ]),
          }),
        }),
      ]),
    );
  });

  it("extracts repeated deterministic tool counts and exact final literals from soak-style prompts", () => {
    const requirements = extractExplicitDeterministicToolRequirements(
      "Run token: social-live-20260310a.\n" +
        "Use `social.sendMessage` exactly 3 times in `off-chain` mode.\n" +
        "Recipients and themes:\n" +
        "- `agent-2`: throughput + backpressure\n" +
        "- `agent-3`: reputation gates + abuse resistance\n" +
        "- `agent-4`: restart/recovery + message durability\n" +
        "After the tool calls, reply with exactly `A1_R1_DONE`.",
      ["social.sendMessage"],
    );

    expect(requirements).toEqual({
      orderedToolNames: ["social.sendMessage"],
      minimumToolCallsByName: { "social.sendMessage": 3 },
      forcePlanner: true,
      exactResponseLiteral: "A1_R1_DONE",
    });
  });

  it("renders verifier rounds in planner synthesis fallback content from the summary state", () => {
    const content = buildPlannerSynthesisFallbackContent(
      {
        reason: "delegated_investigation",
        requiresSynthesis: true,
        steps: [
          {
            name: "delegate_logs",
            stepType: "subagent_task",
          },
        ],
      } as any,
      {
        status: "completed",
        context: {
          results: {
            delegate_logs: JSON.stringify({
              status: "completed",
              output: "Collected evidence",
            }),
          },
        },
        completedSteps: 1,
        totalSteps: 1,
      } as any,
      {
        overall: "pass",
        confidence: 0.92,
        unresolvedItems: [],
        steps: [],
        source: "model",
      },
      2,
      "planner_synthesis model call failed (timeout)",
    );

    expect(content).toContain("Verifier: pass (2 rounds)");
    expect(content).toContain("delegate_logs [source:delegate_logs]");
  });

  it("treats execute_with_agent as the explicit parent tool when child tool usage is nested", () => {
    const requirements = extractExplicitDeterministicToolRequirements(
      "Use the execute_with_agent tool exactly once. " +
        "Delegate a child task that uses system.bash to run /bin/pwd with working directory /home/tetsuo/git/AgenC. " +
        "The parent must not call system.bash directly. " +
        "After the child finishes, reply with exactly `SUBAGENT_SMOKE::/home/tetsuo/git/AgenC`.",
      ["execute_with_agent", "system.bash"],
    );

    expect(requirements).toEqual({
      orderedToolNames: ["execute_with_agent"],
      minimumToolCallsByName: { execute_with_agent: 1 },
      forcePlanner: false,
      exactResponseLiteral: "SUBAGENT_SMOKE::/home/tetsuo/git/AgenC",
    });
  });

  it("keeps parent-level tools after delegated work when they are not nested child instructions", () => {
    const requirements = extractExplicitDeterministicToolRequirements(
      "Use the execute_with_agent tool exactly once. " +
        "Delegate a child task that uses system.bash to inspect /tmp/example. " +
        "After the child completes, use system.bash to run /usr/bin/printf DONE\\n. " +
        "Reply with exactly `DONE`.",
      ["execute_with_agent", "system.bash"],
    );

    expect(requirements).toEqual({
      orderedToolNames: ["execute_with_agent", "system.bash"],
      minimumToolCallsByName: {
        execute_with_agent: 1,
        "system.bash": 1,
      },
      forcePlanner: false,
      exactResponseLiteral: "DONE",
    });
  });

  it("adds first-pass planner guidance for explicit deterministic tool contracts", () => {
    const requirements = extractExplicitDeterministicToolRequirements(
      "Run token: social-live-20260310f.\n" +
        "Use `social.getRecentMessages` first with `{ \"direction\": \"incoming\", \"limit\": 20, \"mode\": \"off-chain\" }`.\n" +
        "Then use `social.sendMessage` exactly 3 times in `off-chain` mode.\n" +
        "After the tool calls, reply with exactly `A1_R3_DONE`.",
      ["social.getRecentMessages", "social.sendMessage"],
    );

    const messages = buildPlannerMessages(
      "Run token: social-live-20260310f.\n" +
        "Use `social.getRecentMessages` first with `{ \"direction\": \"incoming\", \"limit\": 20, \"mode\": \"off-chain\" }`.\n" +
        "Then use `social.sendMessage` exactly 3 times in `off-chain` mode.\n" +
        "After the tool calls, reply with exactly `A1_R3_DONE`.",
      [],
      256,
      requirements,
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "The user supplied an explicit deterministic tool contract for this turn.",
          ),
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "Use only these tools in this order: social.getRecentMessages -> social.sendMessage x3.",
          ),
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "do not emit `subagent_task` steps",
          ),
        }),
      ]),
    );
  });

  it("defaults omitted subagent can_run_parallel to false", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "delegate_core_work",
        requiresSynthesis: true,
        steps: [
          {
            name: "implement_core",
            step_type: "subagent_task",
            objective: "Implement the core solver",
            input_contract: "Project scaffold already exists",
            acceptance_criteria: ["Exports compile", "Weighted search works"],
            required_tool_capabilities: ["system.writeFile", "system.readFile"],
            context_requirements: ["workspace ready"],
            max_budget_hint: "medium",
          },
        ],
      }),
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.steps).toEqual([
      expect.objectContaining({
        name: "implement_core",
        stepType: "subagent_task",
        canRunParallel: false,
      }),
    ]);
  });

  it("parses planner subagent steps whose delegation contract is nested inside args", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "delegate_core_work",
        requiresSynthesis: true,
        steps: [
          {
            name: "implement_core",
            step_type: "subagent_task",
            tool: "execute_with_agent",
            args: {
              task: "implement_core",
              objective: "Create src/ with parser and weighted pathfinding",
              input_contract: "Configured TS project with src/ ready",
              acceptance_criteria: [
                "Core parser+algorithms in src/grid.ts and src/algorithms.ts",
              ],
              required_tool_capabilities: [
                "system.writeFile",
                "system.readFile",
              ],
              execution_context: {
                workspaceRoot: "/tmp/grid-router-ts",
                allowedReadRoots: ["/tmp/grid-router-ts"],
                allowedWriteRoots: ["/tmp/grid-router-ts"],
              },
              max_budget_hint: "12m",
            },
          },
        ],
      }),
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.steps).toEqual([
      expect.objectContaining({
        name: "implement_core",
        stepType: "subagent_task",
        objective: "Create src/ with parser and weighted pathfinding",
        inputContract: "Configured TS project with src/ ready",
        acceptanceCriteria: [
          "Core parser+algorithms in src/grid.ts and src/algorithms.ts",
        ],
        requiredToolCapabilities: ["system.writeFile", "system.readFile"],
        executionContext: expect.objectContaining({
          workspaceRoot: "/tmp/grid-router-ts",
        }),
        maxBudgetHint: "12m",
        canRunParallel: false,
      }),
    ]);
  });

  it("parses typed execution envelopes for subagent steps and does not require cwd text inference", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "delegate_doc_write",
        requiresSynthesis: true,
        steps: [
          {
            name: "write_agenc_md",
            step_type: "subagent_task",
            objective: "Write the repository guide",
            input_contract: "Use the current PLAN.md as the source of truth.",
            acceptance_criteria: [
              "AGENC.md written under the repo root",
            ],
            required_tool_capabilities: ["system.writeFile", "system.readFile"],
            execution_context: {
              workspaceRoot: "/tmp/agenc-shell",
              allowedReadRoots: ["/tmp/agenc-shell"],
              allowedWriteRoots: ["/tmp/agenc-shell"],
              requiredSourceArtifacts: ["/tmp/agenc-shell/PLAN.md"],
              targetArtifacts: ["/tmp/agenc-shell/AGENC.md"],
              allowedTools: ["system.readFile", "system.writeFile"],
              effectClass: "filesystem_write",
              verificationMode: "mutation_required",
              stepKind: "delegated_write",
            },
            max_budget_hint: "6m",
          },
        ],
      }),
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.steps).toEqual([
      expect.objectContaining({
        name: "write_agenc_md",
        stepType: "subagent_task",
        executionContext: expect.objectContaining({
          version: "v1",
          workspaceRoot: "/tmp/agenc-shell",
          requiredSourceArtifacts: ["/tmp/agenc-shell/PLAN.md"],
          targetArtifacts: ["/tmp/agenc-shell/AGENC.md"],
          allowedTools: ["system.readFile", "system.writeFile"],
          effectClass: "filesystem_write",
          verificationMode: "mutation_required",
          stepKind: "delegated_write",
        }),
      }),
    ]);
  });

  it("canonicalizes contradictory review-tagged plan rewrites into delegated writes", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "delegate_plan_rewrite",
        requiresSynthesis: true,
        steps: [
          {
            name: "analyze_and_update_plan",
            step_type: "subagent_task",
            objective:
              "Review the repo against PLAN.md, then update PLAN.md so it reflects the current state.",
            input_contract: "Use PLAN.md and the workspace tree as the source of truth.",
            acceptance_criteria: [
              "PLAN.md reflects the current repo layout accurately.",
            ],
            required_tool_capabilities: ["system.readFile", "system.writeFile"],
            execution_context: {
              workspaceRoot: "/tmp/agenc-shell",
              allowedReadRoots: ["/tmp/agenc-shell"],
              allowedWriteRoots: ["/tmp/agenc-shell"],
              requiredSourceArtifacts: ["/tmp/agenc-shell/PLAN.md"],
              targetArtifacts: ["/tmp/agenc-shell/PLAN.md"],
              allowedTools: ["system.readFile", "system.writeFile"],
              effectClass: "filesystem_write",
              verificationMode: "mutation_required",
              stepKind: "delegated_review",
            },
            max_budget_hint: "8m",
          },
        ],
      }),
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.steps).toEqual([
      expect.objectContaining({
        name: "analyze_and_update_plan",
        stepType: "subagent_task",
        executionContext: expect.objectContaining({
          targetArtifacts: ["/tmp/agenc-shell/PLAN.md"],
          verificationMode: "mutation_required",
          stepKind: "delegated_write",
        }),
      }),
    ]);
  });

  it("rejects subagent execution envelopes that still use /workspace placeholder roots", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "delegate_write",
        requiresSynthesis: true,
        steps: [
          {
            name: "write_agenc_md",
            step_type: "subagent_task",
            objective: "Write the repository guide",
            input_contract: "Use PLAN.md as source of truth.",
            acceptance_criteria: ["AGENC.md written under the repo root"],
            required_tool_capabilities: ["system.writeFile", "system.readFile"],
            execution_context: {
              workspaceRoot: "/workspace/project-a",
              allowedReadRoots: ["/workspace/project-a"],
              allowedWriteRoots: ["/workspace/project-a"],
              requiredSourceArtifacts: ["/workspace/project-a/PLAN.md"],
              targetArtifacts: ["/workspace/project-a/AGENC.md"],
            },
            max_budget_hint: "6m",
          },
        ],
      }),
    );

    expect(result.plan).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "parse",
          code: "planner_execution_context_placeholder_root",
        }),
      ]),
    );
  });

  it("rejects planner placeholder paths instead of repairing them into live scope", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "implement_plan",
        requiresSynthesis: true,
        steps: [
          {
            name: "read_plan",
            step_type: "deterministic_tool",
            tool: "system.readFile",
            args: {
              path: "/abs/path/PLAN.md",
            },
          },
          {
            name: "implement_core",
            step_type: "subagent_task",
            objective: "Implement the plan",
            input_contract: "Use PLAN.md as the source of truth.",
            acceptance_criteria: ["Write src/index.ts"],
            required_tool_capabilities: ["system.readFile", "system.writeFile"],
            execution_context: {
              workspaceRoot: "/abs/path",
              allowedReadRoots: ["/abs/path"],
              allowedWriteRoots: ["/abs/path"],
              requiredSourceArtifacts: ["/abs/path/PLAN.md"],
              targetArtifacts: ["/abs/path/src/index.ts"],
              allowedTools: ["system.readFile", "system.writeFile"],
              effectClass: "filesystem_write",
              verificationMode: "mutation_required",
              stepKind: "delegated_write",
            },
            max_budget_hint: "6m",
          },
        ],
      }),
      undefined,
      { plannerWorkspaceRoot: "/home/tetsuo/git/AgenC" },
    );

    expect(result.plan).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "parse",
          code: "planner_deterministic_tool_placeholder_path",
        }),
      ]),
    );
  });

  it("rejects legacy planner cwd requirements instead of promoting them into execution context", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "legacy_cwd",
        requiresSynthesis: true,
        steps: [
          {
            name: "write_plan",
            step_type: "subagent_task",
            objective: "Review the plan",
            input_contract: "Use PLAN.md as the source of truth.",
            acceptance_criteria: ["Return one grounded finding"],
            required_tool_capabilities: ["system.readFile"],
            context_requirements: ["cwd=/workspace/project-a"],
            max_budget_hint: "2m",
          },
        ],
      }),
      undefined,
      { plannerWorkspaceRoot: "/home/tetsuo/agent-test" },
    );

    expect(result.plan).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "parse",
          code: "planner_legacy_runtime_scope_channel",
        }),
      ]),
    );
  });

  it("promotes deterministic tool parameters from the step root into args", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "verify_build",
        requiresSynthesis: false,
        steps: [
          {
            name: "run_tests",
            step_type: "deterministic_tool",
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["test", "--", "--run"],
            },
            cwd: "/tmp/grid-router-ts",
            timeoutMs: 45000,
          },
        ],
      }),
    );

    expect(result.plan?.steps).toEqual([
      expect.objectContaining({
        name: "run_tests",
        stepType: "deterministic_tool",
        tool: "system.bash",
        args: {
          command: "npm",
          args: ["test", "--", "--run"],
          cwd: "/tmp/grid-router-ts",
          timeoutMs: 45000,
        },
      }),
    ]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "parse",
          code: "planner_tool_root_args_promoted",
          details: expect.objectContaining({
            promotedFields: "cwd,timeoutMs",
          }),
        }),
      ]),
    );
  });

  it("normalizes planner bash direct args with shell separators into shell mode", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "verify_build",
        requiresSynthesis: false,
        steps: [
          {
            name: "verify_all",
            step_type: "deterministic_tool",
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["run", "build", "&&", "npm", "test", "--", "--coverage"],
              cwd: "/tmp/transit-weave",
            },
          },
        ],
      }),
    );

    expect(result.plan?.steps).toEqual([
      expect.objectContaining({
        name: "verify_all",
        stepType: "deterministic_tool",
        tool: "system.bash",
        args: {
          command: "npm run build && npm test -- --coverage",
          cwd: "/tmp/transit-weave",
        },
      }),
    ]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "parse",
          code: "planner_bash_direct_args_normalized_to_shell_mode",
          details: expect.objectContaining({
            shellTokens: "&&",
          }),
        }),
      ]),
    );
    expect(
      validatePlannerStepContracts(result.plan!).some((diagnostic) =>
        diagnostic.code === "planner_bash_shell_syntax_in_direct_args"
      ),
    ).toBe(false);
  });

  it("escapes literal find parentheses when planner bash direct args are normalized to shell mode", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "identify_source_files",
        requiresSynthesis: false,
        steps: [
          {
            name: "identify_source_files",
            step_type: "deterministic_tool",
            tool: "system.bash",
            args: {
              command: "find",
              args: [
                ".",
                "-type",
                "f",
                "(",
                "-name",
                "*.cpp",
                "-o",
                "-name",
                "*.h",
                ")",
              ],
              cwd: "/tmp/dungeon",
            },
          },
        ],
      }),
    );

    expect(result.plan?.steps).toEqual([
      expect.objectContaining({
        name: "identify_source_files",
        stepType: "deterministic_tool",
        tool: "system.bash",
        args: {
          command: "find . -type f \\( -name '*.cpp' -o -name '*.h' \\)",
          cwd: "/tmp/dungeon",
        },
      }),
    ]);
    expect(
      validatePlannerStepContracts(result.plan!).some((diagnostic) =>
        diagnostic.code === "planner_bash_shell_syntax_in_direct_args"
      ),
    ).toBe(false);
  });

  it("salvages direct planner tool calls into deterministic steps", () => {
    const result = salvagePlannerToolCallsAsPlan([
      {
        id: "tc-1",
        name: "execute_with_agent",
        arguments: JSON.stringify({
          task: "Return exactly TOKEN=ONYX-SHARD-58",
          objective: "Output exactly TOKEN=ONYX-SHARD-58",
        }),
      },
    ]);

    expect(result.plan).toBeDefined();
    expect(result.plan?.reason).toBe("planner_tool_call_salvaged");
    expect(result.plan?.steps).toEqual([
      expect.objectContaining({
        stepType: "deterministic_tool",
        tool: "execute_with_agent",
        args: {
          task: "Return exactly TOKEN=ONYX-SHARD-58",
          objective: "Output exactly TOKEN=ONYX-SHARD-58",
        },
      }),
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        category: "parse",
        code: "planner_tool_call_salvaged",
      }),
    ]);
  });

  it("flags salvaged raw tool calls that under-decompose structured implementation requests", () => {
    const result = salvagePlannerToolCallsAsPlan([
      {
        id: "tc-1",
        name: "system.bash",
        arguments: JSON.stringify({
          command: "mkdir",
          args: ["-p", "/tmp/grid-router-ts"],
        }),
      },
    ]);

    const diagnostics = validateSalvagedPlannerToolPlan({
      plannerPlan: result.plan!,
      messageText:
        "In /tmp create a reusable TypeScript library and CLI for ASCII grid maps.\n" +
        "Requirements:\n" +
        "- implement bfs, dijkstra, and astar\n" +
        "- include weighted tiles and portals\n" +
        "- add Vitest coverage\n" +
        "- write a README and report exact passing commands",
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        category: "validation",
        code: "salvaged_tool_plan_underdecomposed",
        details: expect.objectContaining({
          minimumExpectedSteps: 3,
        }),
      }),
    ]);
  });

  it("allows salvaged raw tool calls when the turn has an explicit single-tool contract", () => {
    const result = salvagePlannerToolCallsAsPlan([
      {
        id: "tc-1",
        name: "execute_with_agent",
        arguments: JSON.stringify({
          task: "Return exactly TOKEN=ONYX-SHARD-58",
          objective: "Output exactly TOKEN=ONYX-SHARD-58",
        }),
      },
    ]);
    const requirements = extractExplicitDeterministicToolRequirements(
      "Use `execute_with_agent` for this exact task and return exactly `TOKEN=ONYX-SHARD-58`.",
      ["execute_with_agent"],
    );

    const diagnostics = validateSalvagedPlannerToolPlan({
      plannerPlan: result.plan!,
      messageText:
        "Use `execute_with_agent` for this exact task and return exactly `TOKEN=ONYX-SHARD-58`.",
      explicitDeterministicRequirements: requirements,
    });

    expect(diagnostics).toEqual([]);
  });

  it("rejects planner plans that drift outside explicit deterministic social tools", () => {
    const requirements = extractExplicitDeterministicToolRequirements(
      "Use social.getRecentMessages first. Then use social.sendMessage twice.",
      ["social.getRecentMessages", "social.sendMessage"],
    );

    const diagnostics = validateExplicitDeterministicToolRequirements(
      {
        reason: "social_loop",
        requiresSynthesis: false,
        confidence: 0.8,
        steps: [
          {
            name: "get_incoming_msgs",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "social.getRecentMessages",
            args: { direction: "incoming", limit: 5 },
          },
          {
            name: "read_tagged_message",
            stepType: "subagent_task",
            dependsOn: ["get_incoming_msgs"],
            objective: "Read the newest tagged message through email tools.",
            inputContract: "Return the exact tagged content",
            acceptanceCriteria: ["Message read"],
            requiredToolCapabilities: ["system.emailMessageInfo"],
            contextRequirements: ["get_incoming_msgs"],
            maxBudgetHint: "2m",
            canRunParallel: true,
          },
          {
            name: "send_reply",
            stepType: "deterministic_tool",
            dependsOn: ["read_tagged_message"],
            tool: "social.sendMessage",
            args: { recipient: "agent-a", content: "reply", mode: "off-chain" },
          },
        ],
        edges: [],
      },
      requirements!,
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "explicit_tool_plan_subagent_forbidden",
        }),
      ]),
    );
  });

  it("allows deterministic bash wrapper steps that use bash -c", () => {
    const diagnostics = validatePlannerStepContracts({
      reason: "bad_bash_wrapper",
      requiresSynthesis: false,
      confidence: 0.7,
      steps: [
        {
          name: "setup_project",
          stepType: "deterministic_tool",
          dependsOn: [],
          tool: "system.bash",
          args: {
            command: "bash",
            args: ["-c", "mkdir -p grid-router-ts && touch tsconfig.json"],
          },
        },
      ],
      edges: [],
    });

    expect(diagnostics).toEqual([]);
  });

  it("rejects substantial software plan-doc requests that collapse directly to a single writeFile step", () => {
    const diagnostics = validatePlannerStepContracts(
      {
        reason: "write_todo_plan",
        requiresSynthesis: false,
        confidence: 0.7,
        steps: [
          {
            name: "create_todo_md",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.writeFile",
            args: {
              path: "TODO.md",
              content: "# TODO\n",
            },
          },
        ],
        edges: [],
      },
      "Write a TODO.md with a complete plan for building a C shell with jobs, fork(), argv parsing, and pipes.",
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "validation",
          code: "planner_plan_artifact_single_write_collapse",
        }),
      ]),
    );
  });

  it("allows substantial software plan-doc requests when the plan grounds before the final artifact write", () => {
    const diagnostics = validatePlannerStepContracts(
      {
        reason: "write_todo_plan",
        requiresSynthesis: false,
        confidence: 0.76,
        steps: [
          {
            name: "inspect_workspace",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.listDir",
            args: {
              path: "/tmp/agenc-shell",
            },
          },
          {
            name: "create_todo_md",
            stepType: "deterministic_tool",
            dependsOn: ["inspect_workspace"],
            tool: "system.writeFile",
            args: {
              path: "/tmp/agenc-shell/TODO.md",
              content: "# TODO\n",
            },
          },
        ],
        edges: [{ from: "inspect_workspace", to: "create_todo_md" }],
      },
      "Write a TODO.md with a complete plan for building a C shell with jobs, fork(), argv parsing, and pipes.",
    );

    expect(diagnostics).toEqual([]);
  });

  it("allows grounded plan-artifact update requests that end in a bounded delegated write to the requested artifact", () => {
    const workspaceRoot = "/tmp/agenc-shell";
    const diagnostics = validatePlannerStepContracts(
      {
        reason: "update_plan_artifact",
        requiresSynthesis: false,
        confidence: 0.79,
        steps: [
          {
            name: "read_plan",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.readFile",
            args: {
              path: `${workspaceRoot}/PLAN.md`,
            },
          },
          {
            name: "analyze_and_update_plan",
            stepType: "subagent_task",
            dependsOn: ["read_plan"],
            objective:
              "Review the codebase layout against phase1, identify plan gaps, and update PLAN.md.",
            inputContract: "PLAN.md plus the current source tree.",
            acceptanceCriteria: ["PLAN.md reflects the current workspace layout."],
            requiredToolCapabilities: ["read", "write"],
            contextRequirements: ["read_plan"],
            maxBudgetHint: "10m",
            canRunParallel: false,
            executionContext: {
              version: "v1",
              workspaceRoot,
              allowedReadRoots: [workspaceRoot],
              allowedWriteRoots: [workspaceRoot],
              requiredSourceArtifacts: [`${workspaceRoot}/PLAN.md`],
              targetArtifacts: [`${workspaceRoot}/PLAN.md`],
              effectClass: "filesystem_write",
              verificationMode: "mutation_required",
              stepKind: "delegated_write",
            },
          },
        ],
        edges: [{ from: "read_plan", to: "analyze_and_update_plan" }],
      },
      "Update PLAN.md so it reflects the corrected architecture and missing validation steps.",
    );

    expect(diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "planner_plan_artifact_missing_write_step",
        }),
      ]),
    );
  });

  it("rejects workspace-grounded artifact rewrites that only read the target doc before a generic rewrite", () => {
    const workspaceRoot = "/tmp/agenc-shell";
    const diagnostics = validatePlannerStepContracts(
      {
        reason: "review_and_update_plan",
        requiresSynthesis: false,
        confidence: 0.81,
        steps: [
          {
            name: "read_plan",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.readFile",
            args: {
              path: `${workspaceRoot}/PLAN.md`,
            },
          },
          {
            name: "review_and_update_plan",
            stepType: "subagent_task",
            dependsOn: ["read_plan"],
            objective:
              "Review PLAN.md from multiple perspectives and update it accordingly.",
            inputContract: "Provide the PLAN.md contents.",
            acceptanceCriteria: [
              "PLAN.md is updated cleanly and remains coherent.",
            ],
            requiredToolCapabilities: ["system.readFile", "system.writeFile"],
            maxBudgetHint: "8m",
            executionContext: {
              version: "v1",
              workspaceRoot,
              allowedReadRoots: [workspaceRoot],
              allowedWriteRoots: [workspaceRoot],
              requiredSourceArtifacts: [`${workspaceRoot}/PLAN.md`],
              targetArtifacts: [`${workspaceRoot}/PLAN.md`],
              allowedTools: ["system.readFile", "system.writeFile"],
              effectClass: "filesystem_write",
              verificationMode: "mutation_required",
              stepKind: "delegated_write",
            },
          },
        ],
      },
      "Review the codebase layout and code against Phase1 in PLAN.md, assess whether recent directory changes align with the plan, then update PLAN.md accordingly.",
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "planner_plan_artifact_missing_workspace_grounding",
        }),
      ]),
    );
  });

  it("rejects plan-artifact execution requests that emit multiple mutable delegated owners for one workspace root", () => {
    const workspaceRoot = "/tmp/agenc-shell";
    const diagnostics = validatePlannerStepContracts(
      {
        reason: "complete_plan_artifact_execution",
        requiresSynthesis: false,
        confidence: 0.82,
        steps: [
          {
            name: "read_plan",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.readFile",
            args: {
              path: `${workspaceRoot}/PLAN.md`,
            },
          },
          {
            name: "implement_changes",
            stepType: "subagent_task",
            dependsOn: ["read_plan"],
            objective: "Implement the requested code changes from PLAN.md.",
            inputContract: "PLAN.md plus existing source tree.",
            acceptanceCriteria: ["Required source files updated."],
            requiredToolCapabilities: ["read", "write", "bash"],
            contextRequirements: ["read_plan"],
            maxBudgetHint: "20m",
            canRunParallel: false,
            executionContext: {
              version: "v1",
              workspaceRoot,
              allowedReadRoots: [workspaceRoot],
              allowedWriteRoots: [workspaceRoot],
              requiredSourceArtifacts: [`${workspaceRoot}/PLAN.md`],
              targetArtifacts: [`${workspaceRoot}/src`],
              effectClass: "filesystem_write",
              verificationMode: "mutation_required",
              stepKind: "delegated_write",
            },
          },
          {
            name: "qa_doublecheck",
            stepType: "subagent_task",
            dependsOn: ["implement_changes"],
            objective: "Retest, polish, and keep fixing until PLAN.md is complete.",
            inputContract: "Updated repo and PLAN.md.",
            acceptanceCriteria: ["All tests pass after any fixes."],
            requiredToolCapabilities: ["read", "write", "bash"],
            contextRequirements: ["implement_changes"],
            maxBudgetHint: "15m",
            canRunParallel: false,
            executionContext: {
              version: "v1",
              workspaceRoot,
              allowedReadRoots: [workspaceRoot],
              allowedWriteRoots: [workspaceRoot],
              requiredSourceArtifacts: [`${workspaceRoot}/PLAN.md`],
              targetArtifacts: [workspaceRoot],
              effectClass: "mixed",
              verificationMode: "mutation_required",
              stepKind: "delegated_review",
            },
          },
        ],
        edges: [
          { from: "read_plan", to: "implement_changes" },
          { from: "implement_changes", to: "qa_doublecheck" },
        ],
      },
      "Read all of @PLAN.md and complete every single phase in full.",
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "validation",
          code: "planner_plan_artifact_single_owner_required",
        }),
      ]),
    );
  });

  it("does not treat read-only reviewers as mutable owners when artifact relations keep the writer distinct", () => {
    const workspaceRoot = "/tmp/agenc-shell";
    const planPath = `${workspaceRoot}/PLAN.md`;
    const diagnostics = validatePlannerStepContracts(
      {
        reason: "complete_plan_artifact_execution",
        requiresSynthesis: false,
        confidence: 0.82,
        steps: [
          {
            name: "architecture_review",
            stepType: "subagent_task",
            dependsOn: [],
            objective: "Review PLAN.md for architecture issues.",
            inputContract: "Read PLAN.md and return grounded findings only.",
            acceptanceCriteria: ["Architecture findings are grounded in PLAN.md."],
            requiredToolCapabilities: ["read"],
            contextRequirements: [],
            maxBudgetHint: "3m",
            canRunParallel: true,
            executionContext: {
              version: "v1",
              workspaceRoot,
              allowedReadRoots: [workspaceRoot],
              allowedWriteRoots: [workspaceRoot],
              requiredSourceArtifacts: [planPath],
              effectClass: "read_only",
              verificationMode: "grounded_read",
              stepKind: "delegated_review",
              role: "reviewer",
              artifactRelations: [
                {
                  relationType: "read_dependency",
                  artifactPath: planPath,
                },
              ],
            },
          },
          {
            name: "qa_review",
            stepType: "subagent_task",
            dependsOn: [],
            objective: "Review PLAN.md for QA gaps.",
            inputContract: "Read PLAN.md and return grounded findings only.",
            acceptanceCriteria: ["QA findings are grounded in PLAN.md."],
            requiredToolCapabilities: ["read"],
            contextRequirements: [],
            maxBudgetHint: "3m",
            canRunParallel: true,
            executionContext: {
              version: "v1",
              workspaceRoot,
              allowedReadRoots: [workspaceRoot],
              allowedWriteRoots: [workspaceRoot],
              requiredSourceArtifacts: [planPath],
              effectClass: "read_only",
              verificationMode: "grounded_read",
              stepKind: "delegated_review",
              role: "reviewer",
              artifactRelations: [
                {
                  relationType: "read_dependency",
                  artifactPath: planPath,
                },
              ],
            },
          },
          {
            name: "final_writer",
            stepType: "subagent_task",
            dependsOn: ["architecture_review", "qa_review"],
            objective: "Update PLAN.md with the synthesized reviewer findings.",
            inputContract:
              "Grounded reviewer findings are available for PLAN.md; update PLAN.md only.",
            acceptanceCriteria: ["PLAN.md includes the synthesized reviewer findings."],
            requiredToolCapabilities: ["read", "write"],
            contextRequirements: ["architecture_review", "qa_review"],
            maxBudgetHint: "6m",
            canRunParallel: false,
            executionContext: {
              version: "v1",
              workspaceRoot,
              allowedReadRoots: [workspaceRoot],
              allowedWriteRoots: [workspaceRoot],
              requiredSourceArtifacts: [planPath],
              targetArtifacts: [planPath],
              effectClass: "filesystem_write",
              verificationMode: "mutation_required",
              stepKind: "delegated_write",
              role: "writer",
              artifactRelations: [
                {
                  relationType: "read_dependency",
                  artifactPath: planPath,
                },
                {
                  relationType: "write_owner",
                  artifactPath: planPath,
                },
              ],
            },
          },
        ],
        edges: [
          { from: "architecture_review", to: "final_writer" },
          { from: "qa_review", to: "final_writer" },
        ],
      },
      "Review PLAN.md from multiple angles, then update PLAN.md with the synthesized result.",
    );

    expect(diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "planner_plan_artifact_single_owner_required",
        }),
      ]),
    );
  });

  it("does not require a final artifact write step for implement-from-plan requests", () => {
    const workspaceRoot = "/tmp/agenc-shell";
    const diagnostics = validatePlannerStepContracts(
      {
        reason: "implement_from_plan",
        requiresSynthesis: false,
        confidence: 0.82,
        steps: [
          {
            name: "read_plan",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.readFile",
            args: {
              path: `${workspaceRoot}/PLAN.md`,
            },
          },
          {
            name: "implement_phase_work",
            stepType: "subagent_task",
            dependsOn: ["read_plan"],
            objective: "Implement the requested shell phases from PLAN.md.",
            inputContract: "PLAN.md plus existing source tree.",
            acceptanceCriteria: ["Requested shell phases are implemented and tested."],
            requiredToolCapabilities: ["read", "write", "bash"],
            contextRequirements: ["read_plan"],
            maxBudgetHint: "20m",
            canRunParallel: false,
            executionContext: {
              version: "v1",
              workspaceRoot,
              allowedReadRoots: [workspaceRoot],
              allowedWriteRoots: [workspaceRoot],
              requiredSourceArtifacts: [`${workspaceRoot}/PLAN.md`],
              targetArtifacts: [`${workspaceRoot}/src`],
              effectClass: "filesystem_write",
              verificationMode: "mutation_required",
              stepKind: "delegated_write",
            },
          },
        ],
        edges: [{ from: "read_plan", to: "implement_phase_work" }],
      },
      "Read all of @PLAN.md and complete every single phase in full.",
    );

    expect(diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "planner_plan_artifact_missing_write_step",
        }),
      ]),
    );
  });

  it("rejects implement-from-plan plans that only contain read-only analysis", () => {
    const workspaceRoot = "/tmp/agenc-shell";
    const diagnostics = validatePlannerStepContracts(
      {
        reason: "implement_from_plan",
        requiresSynthesis: false,
        confidence: 0.82,
        steps: [
          {
            name: "read_plan",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.readFile",
            args: {
              path: `${workspaceRoot}/PLAN.md`,
            },
          },
          {
            name: "phase1_analysis",
            stepType: "subagent_task",
            dependsOn: ["read_plan"],
            objective:
              "Analyze PLAN.md to identify Phase 1 work. Do not implement code yet.",
            inputContract: "PLAN.md plus the existing source tree.",
            acceptanceCriteria: ["No code changes; output is analysis only."],
            requiredToolCapabilities: ["system.readFile", "system.listDir"],
            contextRequirements: ["read_plan"],
            maxBudgetHint: "2m",
            canRunParallel: false,
            executionContext: {
              version: "v1",
              workspaceRoot,
              allowedReadRoots: [workspaceRoot],
              requiredSourceArtifacts: [`${workspaceRoot}/PLAN.md`],
              effectClass: "read_only",
              verificationMode: "grounded_read",
              stepKind: "delegated_research",
            },
          },
        ],
        edges: [{ from: "read_plan", to: "phase1_analysis" }],
      },
      "Can you go through @PLAN.md and implement every phase sequentially in full and make sure they are fully tested.",
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "planner_implementation_missing_mutation_path",
        }),
      ]),
    );
  });

  it("classifies the full existing artifact alias family consistently", () => {
    expect(
      classifyPlannerPlanArtifactIntent(
        "Read TODO.md and turn it into a complete implementation plan.",
      ),
    ).toBe("grounded_plan_generation");
    expect(
      classifyPlannerPlanArtifactIntent(
        "Update roadmap.md so it reflects the latest sequencing and owners.",
      ),
    ).toBe("edit_artifact");
    expect(
      classifyPlannerPlanArtifactIntent(
        "Implement everything in implementation-plan.md and verify each phase before moving on.",
      ),
    ).toBe("implement_from_artifact");
    expect(
      classifyPlannerPlanArtifactIntent(
        "Use spec.md as the source of truth and implement the project in full.",
      ),
    ).toBe("implement_from_artifact");
  });

  it("detects workspace-grounded artifact update requests separately from plain artifact edits", () => {
    expect(
      plannerRequestNeedsWorkspaceGroundedArtifactUpdate(
        "Review the codebase layout against Phase1 in PLAN.md and update PLAN.md so it reflects the current workspace state.",
      ),
    ).toBe(true);
    expect(
      plannerRequestNeedsWorkspaceGroundedArtifactUpdate(
        "Update roadmap.md so it reflects the latest sequencing and owners.",
      ),
    ).toBe(false);
  });

  it("adds explicit workspace-grounding guidance to planner prompts for grounded artifact rewrites", () => {
    const messages = buildPlannerMessages(
      "Review the codebase layout against Phase1 in PLAN.md and update PLAN.md so it reflects the current workspace state.",
      [],
      4000,
      undefined,
      undefined,
      undefined,
      undefined,
      "/tmp/agenc-shell",
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "This is a workspace-grounded artifact update request.",
          ),
        }),
      ]),
    );
  });

  it("warns implement-from-artifact planner prompts that read-only plan inspection is invalid", () => {
    const messages = buildPlannerMessages(
      "Can you go through @PLAN.md and implement every phase sequentially in full and make sure they are fully tested.",
      [],
      4000,
      undefined,
      undefined,
      undefined,
      undefined,
      "/tmp/agenc-shell",
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "A plan that only reads the plan artifact, lists files, or produces read-only analysis is invalid for this request class.",
          ),
        }),
      ]),
    );
  });

  it("rejects deterministic bash steps that embed shell separators in direct args", () => {
    const diagnostics = validatePlannerStepContracts({
      reason: "bad_direct_bash_args",
      requiresSynthesis: false,
      confidence: 0.7,
      steps: [
        {
          name: "final_verify",
          stepType: "deterministic_tool",
          dependsOn: [],
          tool: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build", "&&", "npm", "test"],
          },
        },
      ],
      edges: [],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        category: "validation",
        code: "planner_bash_shell_syntax_in_direct_args",
        details: expect.objectContaining({
          shellTokens: "&&",
        }),
      }),
    ]);
  });

  it("rejects ambiguous or undersized planner subagent budget hints", () => {
    const diagnostics = validatePlannerStepContracts({
      reason: "bad_budgets",
      requiresSynthesis: true,
      confidence: 0.8,
      steps: [
        {
          name: "implement_core",
          stepType: "subagent_task",
          dependsOn: [],
          objective: "Implement the parser",
          inputContract: "Project scaffold exists",
          acceptanceCriteria: ["Parser compiles"],
          requiredToolCapabilities: ["system.writeFile", "system.readFile"],
          contextRequirements: ["repo_context"],
          maxBudgetHint: "0.08",
          canRunParallel: false,
        },
        {
          name: "run_tests",
          stepType: "subagent_task",
          dependsOn: ["implement_core"],
          objective: "Run tests",
          inputContract: "Parser exists",
          acceptanceCriteria: ["Tests pass"],
          requiredToolCapabilities: ["system.bash"],
          contextRequirements: ["implement_core"],
          maxBudgetHint: "30s",
          canRunParallel: false,
        },
      ],
      edges: [{ from: "implement_core", to: "run_tests" }],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        category: "validation",
        code: "planner_subagent_budget_hint_ambiguous",
      }),
    ]);
  });

  it("preserves explicit planner subagent budget hints during parsing", () => {
    const parsed = parsePlannerPlan(
      JSON.stringify({
        reason: "budget_repair",
        requiresSynthesis: true,
        steps: [
          {
            name: "create_readme",
            step_type: "subagent_task",
            objective: "Write project README with usage",
            input_contract: "All packages done",
            acceptance_criteria: ["README.md present with instructions"],
            required_tool_capabilities: ["system.writeFile"],
            execution_context: {
              workspaceRoot: "/tmp/maze-forge-ts",
              allowedReadRoots: ["/tmp/maze-forge-ts"],
              allowedWriteRoots: ["/tmp/maze-forge-ts"],
            },
            max_budget_hint: "30s",
          },
        ],
      }),
    );

    expect(parsed.plan?.steps[0]).toEqual(
      expect.objectContaining({
        stepType: "subagent_task",
        maxBudgetHint: "30s",
      }),
    );
    expect(parsed.diagnostics ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "planner_subagent_budget_hint_clamped",
        }),
      ]),
    );
  });

  it("rejects node workspace steps that mix manifest setup with pre-install verification", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "workspace_project",
        requiresSynthesis: true,
        confidence: 0.82,
        steps: [
          {
            name: "initialize_root",
            stepType: "subagent_task",
            dependsOn: [],
            objective:
              "Create root package.json with npm workspaces, tsconfig.json, and root scripts.",
            inputContract: "Workspace root does not exist yet.",
            acceptanceCriteria: [
              "package.json with workspaces and scripts",
              "tsconfig.json present",
            ],
            requiredToolCapabilities: ["system.writeFile", "system.readFile"],
            contextRequirements: ["cwd=/tmp/maze-forge-ts"],
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
          {
            name: "implement_web",
            stepType: "subagent_task",
            dependsOn: ["initialize_root"],
            objective:
              "Setup packages/web package.json, index.html, and src/main.ts for a Vite vanilla TS app that renders the grid.",
            inputContract: "Use a local file:../core dependency and add the web package manifest.",
            acceptanceCriteria: [
              "web package.json with vite",
              "index.html and src/main.ts created",
              "builds successfully",
            ],
            requiredToolCapabilities: ["system.writeFile", "system.bash"],
            contextRequirements: ["cwd=/tmp/maze-forge-ts"],
            maxBudgetHint: "4m",
            canRunParallel: false,
          },
          {
            name: "npm_install",
            stepType: "deterministic_tool",
            dependsOn: ["implement_web"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/maze-forge-ts",
            },
          },
        ],
        edges: [
          { from: "initialize_root", to: "implement_web" },
          { from: "implement_web", to: "npm_install" },
        ],
      },
      {
        maxSubagentFanout: 8,
        maxSubagentDepth: 4,
      },
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "validation",
          code: "node_workspace_install_phase_mismatch",
          details: expect.objectContaining({
            stepName: "implement_web",
            installSteps: "npm_install",
            requiresPhaseSplit: "true",
          }),
        }),
      ]),
    );
  });

  it("allows node workspace scaffold steps that only define scripts and configs before install", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "workspace_project",
        requiresSynthesis: true,
        confidence: 0.84,
        steps: [
          {
            name: "scaffold_structure_manifests",
            stepType: "subagent_task",
            dependsOn: [],
            objective:
              "Create all package.json, tsconfig.json, vite.config.ts, dirs for packages/core/cli/web/src; use file:../core for local deps, scripts for tsc/vitest/vite, no install or logic code.",
            inputContract:
              "Valid workspaces monorepo, no workspace:*, hoistable devDependencies.",
            acceptanceCriteria: [
              "package.json files valid",
              "tsconfig files present",
              "no node_modules",
            ],
            requiredToolCapabilities: [
              "system.writeFile",
              "system.bash",
              "system.listDir",
            ],
            contextRequirements: ["cwd=/tmp/maze-forge-ts"],
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
          {
            name: "npm_install",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_structure_manifests"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/maze-forge-ts",
            },
          },
        ],
        edges: [{ from: "scaffold_structure_manifests", to: "npm_install" }],
      },
      {
        maxSubagentFanout: 8,
        maxSubagentDepth: 4,
      },
    );

    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "node_workspace_install_phase_mismatch"
      ),
    ).toBe(false);
  });

  it("allows node workspace scaffold steps whose acceptance criteria only require script definitions", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "workspace_project",
        requiresSynthesis: true,
        confidence: 0.84,
        steps: [
          {
            name: "scaffold_monorepo_manifests",
            stepType: "subagent_task",
            dependsOn: [],
            objective:
              "Create all package.json, tsconfig.json, vite.config.ts and vitest config with proper scripts/deps.",
            inputContract:
              "Directory structure ready at /tmp/maze-forge-ts",
            acceptanceCriteria: [
              "Manifests present",
              "scripts for build/test/dev set",
              "no workspace:*",
            ],
            requiredToolCapabilities: [
              "system.writeFile",
              "system.readFile",
              "system.bash",
              "system.listDir",
            ],
            contextRequirements: ["cwd=/tmp/maze-forge-ts"],
            maxBudgetHint: "90s",
            canRunParallel: false,
          },
          {
            name: "install_dependencies",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_monorepo_manifests"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/maze-forge-ts",
            },
          },
        ],
        edges: [
          { from: "scaffold_monorepo_manifests", to: "install_dependencies" },
        ],
      },
      {
        maxSubagentFanout: 8,
        maxSubagentDepth: 4,
      },
    );

    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "node_workspace_install_phase_mismatch"
      ),
    ).toBe(false);
  });

  it("rejects node workspace scaffolding plans for a CMake workspace", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "planner-cmake-"));
    try {
      writeFileSync(join(workspaceRoot, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\nproject(agenc_shell C)\n");
      const diagnostics = validatePlannerGraph(
        {
          reason: "workspace_project",
          requiresSynthesis: true,
          confidence: 0.77,
          steps: [
            {
              name: "phase1_setup",
              stepType: "subagent_task",
              dependsOn: [],
              objective:
                "Create initial project structure, package.json, and scaffold files as specified.",
              inputContract:
                "Phase 1 details including file structure, initial package.json, and scaffold instructions.",
              acceptanceCriteria: [
                "package.json exists with exact dependencies/devDependencies from phase 1.",
                "Buildable TypeScript workspace packages use package-local tsconfig/project references.",
              ],
              requiredToolCapabilities: ["system.writeFile", "system.listDir"],
              contextRequirements: ["repo_context", "parse_phases"],
              maxBudgetHint: "2m",
              canRunParallel: false,
            },
          ],
          edges: [],
        },
        {
          maxSubagentFanout: 8,
          maxSubagentDepth: 4,
          workspaceRoot,
        },
      );

      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "validation",
            code: "planner_workspace_ecosystem_mismatch",
            details: expect.objectContaining({
              actualEcosystem: "cmake",
              mismatchedSteps:
                "phase1_setup:subagent_task:declared=node:scoped=cmake",
            }),
          }),
        ]),
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("allows generic runtime-repaired writer steps for a CMake workspace", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "planner-cmake-"));
    try {
      writeFileSync(
        join(workspaceRoot, "CMakeLists.txt"),
        "cmake_minimum_required(VERSION 3.20)\nproject(agenc_shell C)\n",
      );
      const diagnostics = validatePlannerGraph(
        {
          reason: "implement_from_artifact_repair",
          requiresSynthesis: false,
          confidence: 0.81,
          steps: [
            {
              name: "read_plan",
              stepType: "deterministic_tool",
              dependsOn: [],
              tool: "system.readFile",
              args: {
                path: `${workspaceRoot}/PLAN.md`,
              },
            },
            {
              name: "implement_owner",
              stepType: "subagent_task",
              dependsOn: ["read_plan"],
              objective:
                "Execute this implementation request inside the workspace: Can you go through @PLAN.md and implement every phase sequentially in full and make sure they are fully passing.",
              inputContract:
                "Use the planning artifact plus the current workspace to perform the requested implementation end to end. Do not stop at analysis only.",
              acceptanceCriteria: [
                "Workspace files are updated to satisfy the requested implementation phases.",
                "Grounded verification runs before completion, and passing or failing commands are reported concretely.",
              ],
              requiredToolCapabilities: [
                "system.readFile",
                "system.writeFile",
                "system.bash",
              ],
              contextRequirements: ["read_plan"],
              maxBudgetHint: "30m",
              canRunParallel: false,
              executionContext: {
                version: "v1",
                workspaceRoot,
                allowedReadRoots: [workspaceRoot],
                allowedWriteRoots: [workspaceRoot],
                allowedTools: ["system.readFile", "system.writeFile", "system.bash"],
                requiredSourceArtifacts: [`${workspaceRoot}/PLAN.md`],
                targetArtifacts: [workspaceRoot],
                effectClass: "filesystem_write",
                verificationMode: "mutation_required",
                stepKind: "delegated_write",
                role: "writer",
                artifactRelations: [
                  {
                    relationType: "read_dependency",
                    artifactPath: `${workspaceRoot}/PLAN.md`,
                  },
                  {
                    relationType: "write_owner",
                    artifactPath: workspaceRoot,
                  },
                ],
              },
            },
          ],
          edges: [{ from: "read_plan", to: "implement_owner" }],
        },
        {
          maxSubagentFanout: 8,
          maxSubagentDepth: 4,
          workspaceRoot,
        },
      );

      expect(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "planner_workspace_ecosystem_mismatch",
        ),
      ).toBe(false);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("does not treat generic node runner examples as node ownership inside a CMake-scoped step", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "planner-cmake-"));
    try {
      writeFileSync(
        join(workspaceRoot, "CMakeLists.txt"),
        "cmake_minimum_required(VERSION 3.20)\nproject(agenc_shell C)\n",
      );
      const diagnostics = validatePlannerGraph(
        {
          reason: "implementation_with_verification",
          requiresSynthesis: false,
          confidence: 0.81,
          steps: [
            {
              name: "implement_phase_1",
              stepType: "subagent_task",
              dependsOn: [],
              objective:
                "Implement Phase 1 from PLAN.md using only filesystem write tools. Create all specified files and directories exactly as described. Do not install, build, or test yet - only scaffold files.",
              inputContract: "PLAN.md content with Phase 1 details",
              acceptanceCriteria: [
                "All Phase 1 files created in targetArtifacts with correct structure",
                "No package.json changes or installs performed",
                "Files match Phase 1 spec from PLAN.md",
              ],
              requiredToolCapabilities: [
                "system.writeFile",
                "system.readFile",
                "system.listDir",
              ],
              contextRequirements: ["repo_context"],
              maxBudgetHint: "5m",
              canRunParallel: false,
              executionContext: {
                version: "v1",
                workspaceRoot,
                allowedReadRoots: [workspaceRoot],
                allowedWriteRoots: [workspaceRoot],
                requiredSourceArtifacts: [`${workspaceRoot}/PLAN.md`],
                targetArtifacts: [join(workspaceRoot, "src")],
                effectClass: "filesystem_scaffold",
                verificationMode: "mutation_required",
                stepKind: "delegated_scaffold",
                role: "writer",
                artifactRelations: [
                  {
                    relationType: "read_dependency",
                    artifactPath: `${workspaceRoot}/PLAN.md`,
                  },
                  {
                    relationType: "write_owner",
                    artifactPath: join(workspaceRoot, "src"),
                  },
                ],
              },
            },
            {
              name: "test_phase_1",
              stepType: "subagent_task",
              dependsOn: ["implement_phase_1"],
              objective:
                "Run all Phase 1 tests and verify 100% pass before completing.",
              inputContract: "Phase 1 scaffolded files + PLAN.md test specs",
              acceptanceCriteria: [
                "All Phase 1 tests pass (vitest run, jest --runInBand, etc.)",
                "No test failures or errors reported",
                "Build succeeds if Phase 1 includes build step",
              ],
              requiredToolCapabilities: [
                "system.bash",
                "system.readFile",
                "system.listDir",
              ],
              contextRequirements: ["repo_context", "implement_phase_1"],
              maxBudgetHint: "10m",
              canRunParallel: false,
              executionContext: {
                version: "v1",
                workspaceRoot,
                allowedReadRoots: [workspaceRoot],
                allowedWriteRoots: [workspaceRoot],
                requiredSourceArtifacts: [
                  `${workspaceRoot}/PLAN.md`,
                  join(workspaceRoot, "src"),
                ],
                targetArtifacts: [workspaceRoot],
                effectClass: "shell",
                verificationMode: "deterministic_followup",
                stepKind: "delegated_validation",
                role: "validator",
                artifactRelations: [
                  {
                    relationType: "verification_subject",
                    artifactPath: join(workspaceRoot, "src"),
                  },
                  {
                    relationType: "read_dependency",
                    artifactPath: `${workspaceRoot}/PLAN.md`,
                  },
                ],
              },
            },
          ],
          edges: [{ from: "implement_phase_1", to: "test_phase_1" }],
        },
        {
          maxSubagentFanout: 8,
          maxSubagentDepth: 4,
          workspaceRoot,
        },
      );

      expect(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "planner_workspace_ecosystem_mismatch",
        ),
      ).toBe(false);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed subagent acceptance criteria instead of throwing", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "planner-cmake-"));
    try {
      writeFileSync(
        join(workspaceRoot, "CMakeLists.txt"),
        "cmake_minimum_required(VERSION 3.20)\nproject(agenc_shell C)\n",
      );
      const diagnostics = validatePlannerGraph(
        {
          reason: "malformed_contract",
          requiresSynthesis: false,
          confidence: 0.7,
          steps: [
            {
              name: "implement_owner",
              stepType: "subagent_task",
              dependsOn: [],
              objective: "Implement the requested shell features in the workspace.",
              inputContract: "Use PLAN.md and the workspace as the source of truth.",
              acceptanceCriteria:
                "Workspace files are updated and verified." as unknown as readonly string[],
              requiredToolCapabilities: [
                "system.readFile",
                "system.writeFile",
                "system.bash",
              ],
              contextRequirements: ["read_plan"],
              maxBudgetHint: "30m",
              canRunParallel: false,
              executionContext: {
                version: "v1",
                workspaceRoot,
                allowedReadRoots: [workspaceRoot],
                allowedWriteRoots: [workspaceRoot],
                targetArtifacts: [workspaceRoot],
                effectClass: "filesystem_write",
                verificationMode: "mutation_required",
                stepKind: "delegated_write",
                role: "writer",
                artifactRelations: [
                  {
                    relationType: "write_owner",
                    artifactPath: workspaceRoot,
                  },
                ],
              },
            } as never,
          ],
          edges: [],
        },
        {
          maxSubagentFanout: 8,
          maxSubagentDepth: 4,
          workspaceRoot,
        },
      );

      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "planner_subagent_step_malformed_contract",
            details: expect.objectContaining({
              stepName: "implement_owner",
              malformedFields: expect.stringContaining("acceptanceCriteria"),
            }),
          }),
        ]),
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("allows node-scoped steps inside a mixed CMake and Node workspace", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "planner-polyglot-"));
    try {
      writeFileSync(
        join(workspaceRoot, "CMakeLists.txt"),
        "cmake_minimum_required(VERSION 3.20)\nproject(polyglot C)\n",
      );
      mkdirSync(join(workspaceRoot, "frontend"), { recursive: true });
      writeFileSync(
        join(workspaceRoot, "frontend", "package.json"),
        '{"name":"frontend","private":true}\n',
      );
      const frontendRoot = join(workspaceRoot, "frontend");
      const diagnostics = validatePlannerGraph(
        {
          reason: "polyglot_workspace",
          requiresSynthesis: false,
          confidence: 0.83,
          steps: [
            {
              name: "scaffold_frontend",
              stepType: "subagent_task",
              dependsOn: [],
              objective:
                "Create package.json scripts and TypeScript frontend scaffolding under frontend/.",
              inputContract:
                "Implement the frontend package using package.json, tsconfig.json, and npm scripts.",
              acceptanceCriteria: [
                "frontend/package.json defines scripts and dependencies.",
                "frontend/tsconfig.json is present and references the package-local source tree.",
              ],
              requiredToolCapabilities: ["system.writeFile", "system.bash"],
              contextRequirements: ["repo_context"],
              maxBudgetHint: "10m",
              canRunParallel: false,
              executionContext: {
                version: "v1",
                workspaceRoot: frontendRoot,
                allowedReadRoots: [frontendRoot],
                allowedWriteRoots: [frontendRoot],
                allowedTools: ["system.readFile", "system.writeFile", "system.bash"],
                targetArtifacts: [frontendRoot],
                effectClass: "filesystem_scaffold",
                verificationMode: "mutation_required",
                stepKind: "delegated_scaffold",
                role: "writer",
                artifactRelations: [
                  {
                    relationType: "write_owner",
                    artifactPath: frontendRoot,
                  },
                ],
              },
            },
          ],
          edges: [],
        },
        {
          maxSubagentFanout: 8,
          maxSubagentDepth: 4,
          workspaceRoot,
        },
      );

      expect(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "planner_workspace_ecosystem_mismatch",
        ),
      ).toBe(false);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("allows scaffold_environment plans that inventory package metadata and build/test scripts before install", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "workspace_project",
        requiresSynthesis: false,
        confidence: 0.82,
        steps: [
          {
            name: "create_project_dir",
            stepType: "deterministic_tool",
            tool: "system.bash",
            args: {
              command: "mkdir",
              args: ["-p", "/tmp/signal-cartography-ts-43"],
            },
            onError: "abort",
          },
          {
            name: "scaffold_environment",
            stepType: "subagent_task",
            dependsOn: ["create_project_dir"],
            objective:
              "Author root package.json (workspaces, build/test scripts), tsconfig.json, per-package manifests with file:../ local deps, src dirs and basic configs for core/data/cli/web only.",
            inputContract: "Empty target dir",
            acceptanceCriteria: [
              "Root package.json with workspaces and scripts",
              "Per-package package.json with names, file: deps, build/test scripts",
              "packages/*/src and tsconfigs present",
            ],
            requiredToolCapabilities: [
              "system.writeFile",
              "system.readFile",
              "system.listDir",
            ],
            contextRequirements: ["cwd=/tmp/signal-cartography-ts-43"],
            maxBudgetHint: "8m",
          },
          {
            name: "perform_npm_install",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_environment"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/signal-cartography-ts-43",
            },
            onError: "abort",
          },
        ],
        edges: [
          { from: "create_project_dir", to: "scaffold_environment" },
          { from: "scaffold_environment", to: "perform_npm_install" },
        ],
      },
      {
        maxSubagentFanout: 8,
        maxSubagentDepth: 4,
      },
    );

    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "node_workspace_install_phase_mismatch"
      ),
    ).toBe(false);
  });

  it("allows authored manifest acceptance criteria that mention build/test/coverage scripts and devDeps", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "workspace_project",
        requiresSynthesis: true,
        confidence: 0.84,
        steps: [
          {
            name: "scaffold_root_configs",
            stepType: "subagent_task",
            dependsOn: [],
            objective:
              "Author root package.json, tsconfig.json, .gitignore and README skeleton for a TypeScript workspaces monorepo.",
            inputContract: "None - create from scratch",
            acceptanceCriteria: [
              "Authored root package.json with private:true, workspaces:['packages/*'], scripts for build/test/coverage, devDeps including typescript, vitest, @vitest/coverage-v8. Authored tsconfig.json, .gitignore and basic README.md with setup/usage sections.",
            ],
            requiredToolCapabilities: [
              "system.writeFile",
              "system.readFile",
              "system.listDir",
            ],
            contextRequirements: ["cwd=/tmp/transit-weave-ts-26"],
            maxBudgetHint: "90s",
            canRunParallel: false,
          },
          {
            name: "install_dependencies",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_root_configs"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/transit-weave-ts-26",
            },
          },
        ],
        edges: [{ from: "scaffold_root_configs", to: "install_dependencies" }],
      },
      {
        maxSubagentFanout: 8,
        maxSubagentDepth: 4,
      },
    );

    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "node_workspace_install_phase_mismatch"
      ),
    ).toBe(false);
  });

  it("allows pre-install scaffold objectives that only author README install/build/test placeholders", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "freight_flow_scaffold",
        requiresSynthesis: true,
        confidence: 0.86,
        steps: [
          {
            name: "create_project_directory",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.bash",
            args: {
              command: "mkdir",
              args: ["-p", "/tmp/freight-flow-ts-26/packages/core/src"],
            },
          },
          {
            name: "scaffold_monorepo",
            stepType: "subagent_task",
            dependsOn: ["create_project_directory"],
            objective:
              "Author root package.json, per-package manifests, tsconfig.json files, vite.config.ts, index.html, placeholder src files, and short README.md with install/test/build/run placeholders. Only create directories, manifests, configs and initial file contents.",
            inputContract:
              "Newly created empty directory tree with package subfolders",
            acceptanceCriteria: [
              "Root and per-package package.json files exist with correct metadata, file: local deps, and scripts",
              "tsconfig.json, vite.config.ts and index.html are authored",
              "README.md and basic src placeholder files are present",
              "Directory structure matches monorepo layout",
            ],
            requiredToolCapabilities: [
              "system.writeFile",
              "system.readFile",
              "system.listDir",
              "system.bash",
            ],
            contextRequirements: ["cwd=/tmp/freight-flow-ts-26"],
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
          {
            name: "install_dependencies",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_monorepo"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/freight-flow-ts-26",
            },
          },
        ],
        edges: [
          { from: "create_project_directory", to: "scaffold_monorepo" },
          { from: "scaffold_monorepo", to: "install_dependencies" },
        ],
      },
      {
        maxSubagentFanout: 8,
        maxSubagentDepth: 4,
      },
    );

    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "node_workspace_install_phase_mismatch"
      ),
    ).toBe(false);
  });

  it("accepts live web-monorepo refinement steps that stay code-only and pre-install-only", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "transit_weave_refined_plan",
        requiresSynthesis: true,
        confidence: 0.86,
        steps: [
          {
            name: "create_directory",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.bash",
            args: {
              command: "mkdir",
              args: [
                "-p",
                "/tmp/transit-weave-ts-29/packages/core",
                "/tmp/transit-weave-ts-29/packages/cli",
                "/tmp/transit-weave-ts-29/packages/web",
              ],
            },
          },
          {
            name: "scaffold_manifests",
            stepType: "subagent_task",
            dependsOn: ["create_directory"],
            objective:
              "Author only root package.json with workspaces, packages/core/package.json, packages/cli/package.json, packages/web/package.json using file:../core for local dep, tsconfig.json files, vite.config.ts in web, and basic npm scripts. Create no source logic files.",
            inputContract: "Empty dir at target path",
            acceptanceCriteria: [
              "All package.json files authored with correct metadata and file: deps",
              "tsconfig.json and vite config present",
              "Directory structure ready",
              "No logic code or install commands in objective",
            ],
            requiredToolCapabilities: ["system.writeFile", "system.listDir"],
            contextRequirements: ["cwd=/tmp/transit-weave-ts-29"],
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
          {
            name: "install_dependencies",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_manifests"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/transit-weave-ts-29",
            },
          },
          {
            name: "implement_core",
            stepType: "subagent_task",
            dependsOn: ["install_dependencies"],
            objective:
              "Implement TypeScript parser and routing engine in packages/core supporting weighted terrain, one-way conveyors, paired portals, timed switches toggling on alternating turns, and itinerary search from S to G with path reconstruction and cost.",
            inputContract: "ASCII map string with defined symbols for S/G/terrain/mechanics",
            acceptanceCriteria: [
              "parseMap and findItinerary exported and functional",
              "All mechanics (portals, conveyors, switches, weights) implemented",
              "Path and total cost returned",
            ],
            requiredToolCapabilities: ["system.writeFile"],
            contextRequirements: ["cwd=/tmp/transit-weave-ts-29"],
            maxBudgetHint: "8m",
            canRunParallel: false,
          },
          {
            name: "implement_web",
            stepType: "subagent_task",
            dependsOn: ["implement_core"],
            objective:
              "Build Vite TS app in packages/web with map editor, in-browser solver using core, and visualization of path plus cost. Keep code/build only in this step.",
            inputContract: "Core imported via file dep",
            acceptanceCriteria: [
              "Vite app with editable map and solve button",
              "Visual path rendering and cost display",
              "Web source files complete",
            ],
            requiredToolCapabilities: ["system.writeFile"],
            contextRequirements: ["cwd=/tmp/transit-weave-ts-29"],
            maxBudgetHint: "6m",
            canRunParallel: false,
          },
        ],
        edges: [
          { from: "create_directory", to: "scaffold_manifests" },
          { from: "scaffold_manifests", to: "install_dependencies" },
          { from: "install_dependencies", to: "implement_core" },
          { from: "implement_core", to: "implement_web" },
        ],
      },
      {
        maxSubagentFanout: 8,
        maxSubagentDepth: 4,
      },
    );

    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "node_workspace_install_phase_mismatch" &&
        diagnostic.details.stepName === "scaffold_manifests"
      ),
    ).toBe(false);
    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "subagent_step_needs_decomposition" &&
        diagnostic.details.stepName === "implement_web"
      ),
    ).toBe(false);
  });

  it("allows refined workspace plans with source-code-free scaffolding and package-local compile acceptance", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "refined_workspace_project",
        requiresSynthesis: true,
        confidence: 0.88,
        steps: [
          {
            name: "create_root_directory",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.bash",
            args: {
              command: "mkdir",
              args: ["-p", "/tmp/transit-weave/packages/core/src"],
            },
          },
          {
            name: "scaffold_monorepo_configs",
            stepType: "subagent_task",
            dependsOn: ["create_root_directory"],
            objective:
              "Create root and per-package package.json/tsconfig/vite/vitest config files for workspaces monorepo; use file:../core links, add deps like typescript/vitest/commander/react/vite; no source code yet.",
            inputContract: "Root dir and empty package subdirs exist.",
            acceptanceCriteria: [
              "Root package.json has workspaces and scripts; per-package package.json and tsconfigs present; configs valid; no src implementation",
            ],
            requiredToolCapabilities: [
              "system.writeFile",
              "system.bash",
              "system.listDir",
            ],
            contextRequirements: ["cwd=/tmp/transit-weave"],
            maxBudgetHint: "4m",
          },
          {
            name: "install_dependencies",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_monorepo_configs"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/transit-weave",
            },
          },
          {
            name: "implement_core",
            stepType: "subagent_task",
            dependsOn: ["install_dependencies"],
            objective:
              "Implement packages/core/src for ASCII network parse and route search returning best itinerary plus two alternatives.",
            inputContract: "Monorepo scaffolded, deps installed, core/src empty.",
            acceptanceCriteria: [
              "parseNetwork and findRoutes exported with types; logic handles all features; compiles cleanly",
            ],
            requiredToolCapabilities: [
              "system.writeFile",
              "system.readFile",
              "system.bash",
            ],
            contextRequirements: ["cwd=/tmp/transit-weave"],
            maxBudgetHint: "6m",
          },
          {
            name: "implement_cli",
            stepType: "subagent_task",
            dependsOn: ["implement_core"],
            objective:
              "Implement packages/cli with commander commands validate and route that use core; output cost, transfer count, and ordered steps.",
            inputContract: "Core implemented and built; cli/src ready.",
            acceptanceCriteria: [
              "CLI commands functional and compile; uses core package",
            ],
            requiredToolCapabilities: [
              "system.writeFile",
              "system.readFile",
              "system.bash",
            ],
            contextRequirements: ["cwd=/tmp/transit-weave"],
            maxBudgetHint: "4m",
          },
        ],
        edges: [
          { from: "create_root_directory", to: "scaffold_monorepo_configs" },
          { from: "scaffold_monorepo_configs", to: "install_dependencies" },
          { from: "install_dependencies", to: "implement_core" },
          { from: "implement_core", to: "implement_cli" },
        ],
      },
      {
        maxSubagentFanout: 8,
        maxSubagentDepth: 4,
      },
    );

    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "subagent_step_needs_decomposition"
      ),
    ).toBe(false);
    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "node_workspace_install_phase_mismatch"
      ),
    ).toBe(false);
  });

  it("allows workspace bootstrap steps whose acceptance criteria only require build configs to exist", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "bootstrap_workspace_project",
        requiresSynthesis: true,
        confidence: 0.85,
        steps: [
          {
            name: "create_directories",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.bash",
            args: {
              command: "mkdir",
              args: ["-p", "/tmp/transit-weave/packages/core/src"],
            },
          },
          {
            name: "bootstrap_monorepo",
            stepType: "subagent_task",
            dependsOn: ["create_directories"],
            objective:
              "Scaffold root package.json with workspaces and scripts, per-package package.json using file:../core refs, tsconfig.json files, vite.config for web; no workspace:* specifiers",
            inputContract: "Empty dir at cwd",
            acceptanceCriteria: [
              "Root and package manifests valid",
              "TypeScript and build configs present",
              "No unsupported workspace:*",
              "All packages declared",
            ],
            requiredToolCapabilities: [
              "system.bash",
              "system.writeFile",
              "system.readFile",
              "system.listDir",
            ],
            contextRequirements: ["cwd=/tmp/transit-weave"],
            maxBudgetHint: "5m",
          },
          {
            name: "install_dependencies",
            stepType: "deterministic_tool",
            dependsOn: ["bootstrap_monorepo"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/transit-weave",
            },
          },
        ],
        edges: [
          { from: "create_directories", to: "bootstrap_monorepo" },
          { from: "bootstrap_monorepo", to: "install_dependencies" },
        ],
      },
      {
        maxSubagentFanout: 8,
        maxSubagentDepth: 4,
      },
    );

    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "node_workspace_install_phase_mismatch"
      ),
    ).toBe(false);
  });

  it("allows workspace scaffold steps that explicitly prohibit install or test verification before install", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "workspace_project",
        requiresSynthesis: true,
        confidence: 0.84,
        steps: [
          {
            name: "scaffold_web",
            stepType: "subagent_task",
            dependsOn: [],
            objective:
              "Scaffold packages/web: run create-vite react-ts, adjust package.json for monorepo/core dep file:../core, vite.config, no install/run or tests in this step.",
            inputContract: "cli scaffolded",
            acceptanceCriteria: ["web created and adjusted for monorepo"],
            requiredToolCapabilities: ["system.bash", "system.writeFile"],
            contextRequirements: ["cwd=/tmp/transit-weave"],
            maxBudgetHint: "3m",
          },
          {
            name: "npm_install",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_web"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/transit-weave",
            },
          },
        ],
        edges: [{ from: "scaffold_web", to: "npm_install" }],
      },
      {
        maxSubagentFanout: 8,
        maxSubagentDepth: 4,
      },
    );

    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "node_workspace_install_phase_mismatch"
      ),
    ).toBe(false);
  });

  it("rejects objective-only node verification before install even without acceptance verification criteria", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "workspace_project",
        requiresSynthesis: true,
        confidence: 0.84,
        steps: [
          {
            name: "scaffold_and_smoke_test",
            stepType: "subagent_task",
            dependsOn: [],
            objective:
              "Create root package.json and tsconfig.json, then run npm test and vite build to verify the workspace skeleton.",
            inputContract: "Workspace root does not exist yet.",
            acceptanceCriteria: [
              "package.json present",
              "tsconfig.json present",
              "no node_modules",
            ],
            requiredToolCapabilities: ["system.writeFile", "system.bash"],
            contextRequirements: ["cwd=/tmp/maze-forge-ts"],
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
          {
            name: "npm_install",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_and_smoke_test"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/maze-forge-ts",
            },
          },
        ],
        edges: [{ from: "scaffold_and_smoke_test", to: "npm_install" }],
      },
      {
        maxSubagentFanout: 8,
        maxSubagentDepth: 4,
      },
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "validation",
          code: "node_workspace_install_phase_mismatch",
          details: expect.objectContaining({
            stepName: "scaffold_and_smoke_test",
            installSteps: "npm_install",
            requiresPhaseSplit: "true",
          }),
        }),
      ]),
    );
  });

  it("requires dependency gating between explicitly ordered deterministic tools", () => {
    const requirements = extractExplicitDeterministicToolRequirements(
      "Use social.getRecentMessages first. Then use social.sendMessage twice.",
      ["social.getRecentMessages", "social.sendMessage"],
    );

    const diagnostics = validateExplicitDeterministicToolRequirements(
      {
        reason: "social_loop",
        requiresSynthesis: false,
        confidence: 0.8,
        steps: [
          {
            name: "get_incoming_msgs",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "social.getRecentMessages",
            args: { direction: "incoming", limit: 5 },
          },
          {
            name: "send_reply",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "social.sendMessage",
            args: { recipient: "agent-a", content: "reply", mode: "off-chain" },
          },
          {
            name: "send_followup",
            stepType: "deterministic_tool",
            dependsOn: ["send_reply"],
            tool: "social.sendMessage",
            args: { recipient: "agent-b", content: "followup", mode: "off-chain" },
          },
        ],
        edges: [],
      },
      requirements!,
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "explicit_tool_plan_dependency_mismatch",
        }),
      ]),
    );
  });

  it("requires enough repeated deterministic calls for explicitly repeated tools", () => {
    const requirements = extractExplicitDeterministicToolRequirements(
      "Use social.sendMessage exactly 3 times in off-chain mode. After the tool calls, reply with exactly DONE.",
      ["social.sendMessage"],
    );

    const diagnostics = validateExplicitDeterministicToolRequirements(
      {
        reason: "social_loop",
        requiresSynthesis: false,
        confidence: 0.8,
        steps: [
          {
            name: "send_reply_a",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "social.sendMessage",
            args: { recipient: "agent-a", content: "reply", mode: "off-chain" },
          },
          {
            name: "send_reply_b",
            stepType: "deterministic_tool",
            dependsOn: ["send_reply_a"],
            tool: "social.sendMessage",
            args: {
              recipient: "agent-b",
              content: "followup",
              mode: "off-chain",
            },
          },
        ],
        edges: [],
      },
      requirements!,
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "explicit_tool_plan_insufficient_tool_calls",
        }),
      ]),
    );
  });
});
