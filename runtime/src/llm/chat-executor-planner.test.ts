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
  extractExplicitDeterministicToolRequirements,
  extractExplicitSubagentOrchestrationRequirements,
  parsePlannerPlan,
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

  // Two tests previously here ("grounds plan-artifact edit schema examples to
  // the requested artifact instead of AGENC.md" and "filters same-target
  // artifact-edit history when the current turn is implementing from the
  // artifact") were removed on 2026-04-06 along with the regex pre-call
  // classifier. They asserted on:
  //   - the EDIT-branch system message text injected into the planner prompt
  //   - schema example targetArtifacts conditioned on intent flags
  //   - history filtering that suppressed prior assistant turns when the
  //     current turn was an `implement_from_artifact` request
  // All three behaviors lived in `buildPlannerMessages` and depended on
  // `classifyPlannerPlanArtifactIntent`. The new model-driven path emits a
  // single intent-agnostic rubric system message and lets the model decide,
  // so these regex-coupled assertions no longer make sense. End-to-end
  // coverage for the new behavior belongs in a planner-pipeline integration
  // test against a recorded model response.

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

  // The two `classifies … as edit_artifact` tests that lived here previously
  // exercised `classifyPlannerPlanArtifactIntent`, the regex-based pre-call
  // classifier removed on 2026-04-06. Intent is now decided by the model and
  // surfaced as `plan_intent` on the parsed PlannerPlan. New end-to-end tests
  // for that behavior belong in a fixture-driven planner integration test, not
  // a regex unit test.

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

  it("adds grounded runtime todo repair guidance when the todo artifact is missing", () => {
    const hint = buildPipelineFailureRepairRefinementHint({
      pipelineResult: {
        status: "failed",
        completedSteps: 1,
        totalSteps: 3,
        error: "File not found: /tmp/project/todo",
        stopReasonHint: "tool_error",
      },
      plannerPlan: {
        reason: "repair",
        requiresSynthesis: true,
        steps: [
          {
            name: "read_runtime_todo",
            stepType: "deterministic_tool",
            tool: "system.readFile",
            args: {
              path: "/tmp/project/todo",
            },
          },
        ],
      },
      plannerToolCalls: [
        {
          name: "system.readFile",
          args: {
            path: "/tmp/project/todo",
          },
          result: '{"error":"File not found: /tmp/project/todo"}',
          isError: true,
          durationMs: 0,
        },
      ],
    });

    expect(hint).toContain("runtime-owned `/todo` artifact is missing");
    expect(hint).toContain("directory listing alone");
    expect(hint).toContain("non-target implementation, project, or config file");
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

  it("forces planner routing whenever the user message references an artifact path", () => {
    const decision = assessPlannerDecision(
      true,
      "Update PLAN.md so it reflects the corrected architecture.",
      [],
    );

    expect(decision.shouldPlan).toBe(true);
    expect(decision.reason).toContain("plan_artifact_reference");
  });

  it("does not treat generic planning requests without explicit artifact refs as artifact-backed routes", () => {
    const messageText =
      "Turn this into a complete implementation plan for building a shell in the C programming language.";

    const decision = assessPlannerDecision(true, messageText, []);

    expect(decision.reason).not.toContain("plan_artifact_reference");
  });

  // The tests that previously asserted the regex classifier returned
  // `edit_artifact`, `implement_from_artifact`, or `grounded_plan_generation`
  // for specific surface-keyword phrasings were removed on 2026-04-06 along
  // with `classifyPlannerPlanArtifactIntent` itself. Intent is now decided by
  // the model and surfaced as `plan_intent` on the parsed PlannerPlan;
  // end-to-end coverage for that decision belongs in a planner-pipeline
  // integration test, not a regex unit test.

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

  it("reports incomplete planner workflows in synthesis fallback content when execution fails", () => {
    const content = buildPlannerSynthesisFallbackContent(
      {
        reason: "review_and_update_plan",
        requiresSynthesis: true,
        steps: [
          {
            name: "read_plan",
            stepType: "deterministic_tool",
            tool: "system.readFile",
          },
        ],
      } as any,
      {
        status: "failed",
        context: {
          results: {},
        },
        completedSteps: 0,
        totalSteps: 2,
        error: "path must be a non-empty string",
      } as any,
      undefined,
      undefined,
      "path must be a non-empty string",
    );

    expect(content).toContain("The requested workflow did not complete.");
    expect(content).toContain("Fallback reason: path must be a non-empty string");
    expect(content).not.toContain("Completed the requested workflow");
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


  it("canonicalizes aliased filesystem arguments in parsed deterministic planner steps", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "review_plan",
        requiresSynthesis: false,
        steps: [
          {
            name: "read_plan",
            step_type: "deterministic_tool",
            tool: "system.readFile",
            args: {
              filePath: "/tmp/project/PLAN.md",
            },
          },
        ],
      }),
    );

    expect(result.plan?.steps).toEqual([
      expect.objectContaining({
        stepType: "deterministic_tool",
        tool: "system.readFile",
        args: {
          path: "/tmp/project/PLAN.md",
        },
      }),
    ]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "parse",
          code: "planner_tool_args_canonicalized",
          details: expect.objectContaining({
            canonicalizedFields: "filePath->path",
          }),
        }),
      ]),
    );
  });

  it("rejects conflicting deterministic planner arg aliases instead of guessing", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "review_plan",
        requiresSynthesis: false,
        steps: [
          {
            name: "read_plan",
            step_type: "deterministic_tool",
            tool: "system.readFile",
            args: {
              path: "/tmp/project/PLAN.md",
              filePath: "/tmp/project/OTHER.md",
            },
          },
        ],
      }),
    );

    expect(result.plan).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "parse",
          code: "planner_tool_arg_alias_conflict",
        }),
      ]),
    );
  });

  it("canonicalizes salvaged planner tool calls before building deterministic steps", () => {
    const result = salvagePlannerToolCallsAsPlan([
      {
        id: "tc-1",
        name: "system.listDirectory",
        arguments: JSON.stringify({
          directoryPath: "/tmp/project/src",
        }),
      },
    ]);

    expect(result.plan?.steps).toEqual([
      expect.objectContaining({
        stepType: "deterministic_tool",
        tool: "system.listDir",
        args: {
          path: "/tmp/project/src",
        },
      }),
    ]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "parse",
          code: "planner_tool_name_canonicalized",
        }),
        expect.objectContaining({
          category: "parse",
          code: "planner_tool_args_canonicalized",
        }),
      ]),
    );
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
        // Pre-2026-04-06 the validator inferred this from the message text via
        // `classifyPlannerPlanArtifactIntent`. After the rip-out, intent is
        // model-emitted and lives on the parsed plan; tests must set it
        // explicitly to exercise the validator branch.
        planIntent: "grounded_plan_generation",
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
        planIntent: "edit_artifact",
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

  it("allows generic workspace-grounded artifact rewrites when the planner lists directories before rewriting the target doc", () => {
    const workspaceRoot = "/tmp/agenc-shell";
    const diagnostics = validatePlannerStepContracts(
      {
        reason: "review_and_update_plan",
        requiresSynthesis: false,
        confidence: 0.8,
        steps: [
          {
            name: "list_src",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.listDir",
            args: {
              path: `${workspaceRoot}/src`,
            },
          },
          {
            name: "read_plan",
            stepType: "deterministic_tool",
            dependsOn: ["list_src"],
            tool: "system.readFile",
            args: {
              path: `${workspaceRoot}/PLAN.md`,
            },
          },
          {
            name: "rewrite_plan",
            stepType: "deterministic_tool",
            dependsOn: ["read_plan"],
            tool: "system.writeFile",
            args: {
              path: `${workspaceRoot}/PLAN.md`,
              content: "updated plan",
            },
          },
        ],
      },
      "Review the codebase layout against Phase1 in PLAN.md and update PLAN.md so it reflects the current workspace state.",
    );

    expect(diagnostics).toEqual([]);
  });

  it("rejects runtime-owned todo repairs that only list directories before recreating the artifact", () => {
    const workspaceRoot = "/tmp/agenc-shell";
    const diagnostics = validatePlannerStepContracts(
      {
        reason: "repair_missing_runtime_todo",
        requiresSynthesis: false,
        confidence: 0.74,
        steps: [
          {
            name: "inspect_workspace",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.listDir",
            args: {
              path: workspaceRoot,
            },
          },
          {
            name: "rewrite_runtime_todo",
            stepType: "deterministic_tool",
            dependsOn: ["inspect_workspace"],
            tool: "system.writeFile",
            args: {
              path: `${workspaceRoot}/todo`,
              content: "continue work",
            },
          },
        ],
      },
      "Inspect the current workspace state, compare it to the implementation, and continue the remaining app work.",
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "planner_plan_artifact_missing_workspace_grounding",
        }),
      ]),
    );
  });

  it("allows runtime-owned todo repairs when the planner reads a non-target workspace file before recreating the artifact", () => {
    const workspaceRoot = "/tmp/agenc-shell";
    const diagnostics = validatePlannerStepContracts(
      {
        reason: "repair_missing_runtime_todo",
        requiresSynthesis: false,
        confidence: 0.78,
        steps: [
          {
            name: "inspect_source_file",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.readFile",
            args: {
              path: `${workspaceRoot}/src/ContentView.swift`,
            },
          },
          {
            name: "rewrite_runtime_todo",
            stepType: "deterministic_tool",
            dependsOn: ["inspect_source_file"],
            tool: "system.writeFile",
            args: {
              path: `${workspaceRoot}/todo`,
              content: "continue work",
            },
          },
        ],
      },
      "Inspect the current workspace state, compare it to the implementation, and continue the remaining app work.",
    );

    expect(diagnostics).toEqual([]);
  });

  it("rejects plan-artifact execution requests that emit multiple mutable delegated owners for one workspace root", () => {
    const workspaceRoot = "/tmp/agenc-shell";
    const diagnostics = validatePlannerStepContracts(
      {
        reason: "complete_plan_artifact_execution",
        requiresSynthesis: false,
        confidence: 0.82,
        planIntent: "implement_from_artifact",
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
              targetArtifacts: [workspaceRoot],
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

  // The "classifies the full existing artifact alias family consistently",
  // "detects workspace-grounded artifact update requests separately from plain
  // artifact edits", and "adds explicit workspace-grounding guidance to
  // planner prompts for grounded artifact rewrites" tests previously here all
  // covered the regex-based pre-call classifier (`classifyPlannerPlanArtifactIntent`,
  // `plannerRequestNeedsWorkspaceGroundedArtifactUpdate`) and the three
  // intent-conditional system messages in `buildPlannerMessages`. Both layers
  // were removed on 2026-04-06: intent is now decided by the model and
  // surfaced as `plan_intent` on the parsed PlannerPlan, and the planner
  // prompt now ships a single intent-agnostic rubric instead of three
  // mutually-exclusive constraint blocks. End-to-end coverage for the new
  // model-driven path belongs in a planner-pipeline integration test.

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
  it("rejects planner-emitted documentation artifact routes when the user never named an artifact", () => {
    const diagnostics = validatePlannerStepContracts(
      {
        reason: "invented_plan_artifact",
        requiresSynthesis: true,
        confidence: 0.8,
        steps: [
          {
            name: "review_and_update",
            stepType: "subagent_task",
            dependsOn: [],
            objective: "Review and update the planning document",
            inputContract: "Current workspace state",
            acceptanceCriteria: ["Planning document updated"],
            requiredToolCapabilities: ["system.writeFile", "system.readFile"],
            contextRequirements: ["repo_context"],
            executionContext: {
              workspaceRoot: "/tmp/project",
              requiredSourceArtifacts: ["/tmp/project/PLAN.md"],
              targetArtifacts: ["/tmp/project/PLAN.md"],
              effectClass: "filesystem_write",
              verificationMode: "mutation_required",
              stepKind: "delegated_write",
            },
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
        ],
        edges: [],
      },
      "Build the shell in full and verify it before returning.",
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "planner_unrequested_artifact_route",
        }),
      ]),
    );
  });

  it("rejects implement-from-artifact plans that ground on a different source artifact than the user requested", () => {
    const diagnostics = validatePlannerStepContracts(
      {
        reason: "wrong_source_artifact",
        requiresSynthesis: true,
        confidence: 0.8,
        planIntent: "implement_from_artifact",
        steps: [
          {
            name: "implement_phase",
            stepType: "subagent_task",
            dependsOn: [],
            objective: "Implement the project from the spec",
            inputContract: "Spec and workspace are available",
            acceptanceCriteria: ["Implementation updated"],
            requiredToolCapabilities: ["system.writeFile", "system.readFile"],
            contextRequirements: ["repo_context"],
            executionContext: {
              workspaceRoot: "/tmp/project",
              requiredSourceArtifacts: ["/tmp/project/README.md"],
              targetArtifacts: ["/tmp/project/src/main.ts"],
              effectClass: "filesystem_write",
              verificationMode: "mutation_required",
              stepKind: "delegated_write",
            },
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
        ],
        edges: [],
      },
      "Read all of @PLAN.md and complete every single phase in full.",
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "planner_artifact_source_does_not_match_request",
        }),
      ]),
    );
  });

  it("rejects delegated sidecar artifact plans for explicit single-artifact documentation updates", () => {
    const workspaceRoot = "/tmp/project";
    const diagnostics = validatePlannerStepContracts(
      {
        reason: "fill_plan_gaps",
        requiresSynthesis: true,
        confidence: 0.8,
        planIntent: "edit_artifact",
        steps: [
          {
            name: "read_plan",
            stepType: "deterministic_tool",
            tool: "system.readFile",
            args: {
              path: `${workspaceRoot}/PLAN.md`,
            },
          },
          {
            name: "analyze_plan_gaps",
            stepType: "subagent_task",
            dependsOn: ["read_plan"],
            objective: "Analyze PLAN.md and write a findings artifact.",
            inputContract: "Use PLAN.md as the source of truth.",
            acceptanceCriteria: ["plan_gaps.md lists the missing sections"],
            requiredToolCapabilities: ["system.readFile", "system.writeFile"],
            contextRequirements: ["repo_context"],
            executionContext: {
              workspaceRoot,
              requiredSourceArtifacts: [`${workspaceRoot}/PLAN.md`],
              targetArtifacts: [`${workspaceRoot}/plan_gaps.md`],
              effectClass: "filesystem_write",
              verificationMode: "mutation_required",
              stepKind: "delegated_write",
            },
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
          {
            name: "fill_plan_gaps",
            stepType: "deterministic_tool",
            dependsOn: ["analyze_plan_gaps"],
            tool: "system.writeFile",
            args: {
              path: `${workspaceRoot}/PLAN.md`,
              content: "updated plan",
            },
          },
        ],
        edges: [],
      },
      "Read @PLAN.md, find any gaps, and fill them.",
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "planner_plan_artifact_direct_owner_required",
        }),
        expect.objectContaining({
          code: "planner_plan_artifact_sidecar_write_forbidden",
        }),
      ]),
    );
  });


});
