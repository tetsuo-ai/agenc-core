import { describe, expect, it } from "vitest";

import {
  buildToolExecutionGroundingMessage,
  generateFallbackContent,
  normalizeHistory,
  prepareToolResultForPrompt,
  reconcileDirectShellObservationContent,
  reconcileExactResponseContract,
  reconcileTerminalCompletionStateContent,
  reconcileStructuredToolOutcome,
  reconcileVerifiedFileWorkflowContent,
  reconcileTerminalFailureContent,
  summarizeToolCalls,
} from "./chat-executor-text.js";

describe("chat-executor-text", () => {
  it("builds an authoritative runtime tool ledger with tool calls and provider citations", () => {
    const message = buildToolExecutionGroundingMessage({
      toolCalls: [
        {
          name: "desktop.bash",
          args: { command: "mkdir -p /workspace/pong" },
          result: JSON.stringify({
            stdout: "",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 11,
        },
        {
          name: "execute_with_agent",
          args: { objective: "Research mechanics" },
          result: JSON.stringify({
            success: false,
            error: "Delegated task required browser-grounded evidence",
          }),
          isError: true,
          durationMs: 37,
        },
      ],
      providerEvidence: {
        citations: ["https://docs.x.ai/developers/tools/web-search"],
      },
    });

    expect(message).toBeDefined();
    expect(message?.role).toBe("system");
    expect(String(message?.content)).toContain("Runtime execution ledger");
    expect(String(message?.content)).toContain('"tool":"desktop.bash"');
    expect(String(message?.content)).toContain('"tool":"execute_with_agent"');
    expect(String(message?.content)).toContain('"providerCitations"');
    expect(String(message?.content)).toContain(
      "https://docs.x.ai/developers/tools/web-search",
    );
  });

  it("surfaces provider-native server-side tool telemetry even without citations", () => {
    const message = buildToolExecutionGroundingMessage({
      toolCalls: [],
      providerEvidence: {
        serverSideToolCalls: [
          {
            type: "web_search_call",
            toolType: "web_search",
            id: "ws_123",
            status: "completed",
          },
        ],
        serverSideToolUsage: [
          {
            category: "SERVER_SIDE_TOOL_WEB_SEARCH",
            toolType: "web_search",
            count: 1,
          },
        ],
      },
    });

    expect(message).toBeDefined();
    expect(String(message?.content)).toContain('"providerServerSideToolCallCount":1');
    expect(String(message?.content)).toContain('"type":"web_search_call"');
    expect(String(message?.content)).toContain('"category":"SERVER_SIDE_TOOL_WEB_SEARCH"');
  });

  it("keeps oversized runtime tool ledgers bounded and marks them truncated", () => {
    const message = buildToolExecutionGroundingMessage({
      toolCalls: Array.from({ length: 30 }, (_, index) => ({
        name: index === 0 ? "execute_with_agent" : "desktop.bash",
        args: {
          command: `echo ${"x".repeat(400)}`,
          index,
        },
        result: JSON.stringify({
          stdout: "y".repeat(4_000),
          stderr: index === 0 ? "delegated child failed" : "",
          exitCode: index === 0 ? 1 : 0,
        }),
        isError: index === 0,
        durationMs: 10 + index,
      })),
    });

    expect(message).toBeDefined();
    expect(String(message?.content).length).toBeLessThanOrEqual(100_000);
    expect(String(message?.content)).toContain('"failedToolNames":["execute_with_agent"]');
  });

  it("replaces unsolicited shell advice with the direct command output for simple successful shell calls", () => {
    const content = reconcileDirectShellObservationContent(
      "Note: `desktop.bash` spawns fresh shells from `/workspace` each time (non-persistent).\n\nTo work in `~` (/home/agenc): Prefix like `cd ~ && your_command`.\n\nDemo:\n```sh\ncd ~ && pwd\n```",
      [
        {
          name: "desktop.bash",
          args: { command: "pwd" },
          result: JSON.stringify({
            stdout: "/workspace\n",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 7,
        },
      ],
    );

    expect(content).toBe("/workspace");
  });

  it("preserves shell follow-up text that already includes the actual command output", () => {
    const content = reconcileDirectShellObservationContent(
      "Current directory: /workspace",
      [
        {
          name: "desktop.bash",
          args: { command: "pwd" },
          result: JSON.stringify({
            stdout: "/workspace\n",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 7,
        },
      ],
    );

    expect(content).toBe("Current directory: /workspace");
  });

  it("rewrites contradictory success copy when the honest state is needs_verification", () => {
    const content = reconcileTerminalCompletionStateContent({
      content:
        "Implemented. The shell is fully functional and matches the spec.",
      completionState: "needs_verification",
      stopReason: "completed",
      completionProgress: {
        completionState: "needs_verification",
        stopReason: "completed",
        requiredRequirements: ["workflow_verifier_pass"],
        satisfiedRequirements: [],
        remainingRequirements: ["workflow_verifier_pass"],
        reusableEvidence: [
          {
            requirement: "build_verification",
            summary: "make test",
            observedAt: 7,
          },
        ],
        updatedAt: 7,
      },
      toolCalls: [
        {
          name: "system.writeFile",
          args: { path: "/workspace/src/main.c" },
          result: JSON.stringify({ ok: true }),
          isError: false,
          durationMs: 7,
        },
      ],
    });

    expect(content).toContain("needs verification");
    expect(content).toContain("Still required before completion: workflow_verifier_pass");
    expect(content).toContain("Reusable grounded evidence: make test");
    expect(content).not.toContain("fully functional");
  });

  it("keeps explicit partial summaries honest when the run only partially completed", () => {
    const content = reconcileTerminalCompletionStateContent({
      content:
        "Partial implementation complete: parser and build files are in place, but pipelines remain unfinished.",
      completionState: "partial",
      stopReason: "validation_error",
      stopReasonDetail: "Behavior checks still missing",
      completionProgress: {
        completionState: "partial",
        stopReason: "validation_error",
        stopReasonDetail: "Behavior checks still missing",
        requiredRequirements: ["behavior_verification"],
        satisfiedRequirements: [],
        remainingRequirements: ["behavior_verification"],
        reusableEvidence: [],
        updatedAt: 9,
      },
      toolCalls: [
        {
          name: "system.writeFile",
          args: { path: "/workspace/src/parser.c" },
          result: JSON.stringify({ ok: true }),
          isError: false,
          durationMs: 9,
        },
      ],
    });

    expect(content).toContain("Partial implementation");
    expect(content).toContain("Behavior checks still missing");
    expect(content).toContain(
      "Do not present the work as finished; continue from the grounded evidence and close the remaining requirements.",
    );
  });

  it("does not render blocked implementation work as effectively complete", () => {
    const content = reconcileTerminalCompletionStateContent({
      content: "Implemented the core changes and everything should be done now.",
      completionState: "blocked",
      stopReason: "validation_error",
      stopReasonDetail: "Verification artifacts are still missing",
      completionProgress: {
        completionState: "blocked",
        stopReason: "validation_error",
        stopReasonDetail: "Verification artifacts are still missing",
        requiredRequirements: ["workflow_verifier_pass"],
        satisfiedRequirements: [],
        remainingRequirements: ["workflow_verifier_pass"],
        reusableEvidence: [
          {
            requirement: "build_verification",
            summary: "npm test",
            observedAt: 12,
          },
        ],
        updatedAt: 12,
      },
      toolCalls: [
        {
          name: "system.writeFile",
          args: { path: "/workspace/src/main.c" },
          result: JSON.stringify({ ok: true }),
          isError: false,
          durationMs: 7,
        },
      ],
    });

    expect(content).toContain("Verification artifacts are still missing");
    expect(content).toContain("Workflow state: blocked");
    expect(content).toContain("Still required before completion: workflow_verifier_pass");
    expect(content).toContain(
      "Do not present the work as complete; address the blocking condition or report it explicitly.",
    );
  });

  it("reconciles verified file workflow output when final synthesis mangles the absolute path", () => {
    const content = reconcileVerifiedFileWorkflowContent(
      "/ tmp/agenc-autonomy-LIVE.txt\nAUTONOMY_STAGE2::LIVE",
      [
        {
          name: "desktop.bash",
          args: {
            command: "echo -n 'AUTONOMY_STAGE2::LIVE' > /tmp/agenc-autonomy-LIVE.txt",
          },
          result: JSON.stringify({
            stdout: "",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 5,
        },
        {
          name: "desktop.bash",
          args: {
            command: "cat /tmp/agenc-autonomy-LIVE.txt",
          },
          result: JSON.stringify({
            stdout: "AUTONOMY_STAGE2::LIVE",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 4,
        },
      ],
    );

    expect(content).toBe("/tmp/agenc-autonomy-LIVE.txt\nAUTONOMY_STAGE2::LIVE");
  });

  it("preserves verified file workflow output when the exact absolute path is already present", () => {
    const content = reconcileVerifiedFileWorkflowContent(
      "/tmp/agenc-autonomy-LIVE.txt\nAUTONOMY_STAGE2::LIVE",
      [
        {
          name: "desktop.bash",
          args: {
            command: "echo -n 'AUTONOMY_STAGE2::LIVE' > /tmp/agenc-autonomy-LIVE.txt",
          },
          result: JSON.stringify({
            stdout: "",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 5,
        },
        {
          name: "desktop.bash",
          args: {
            command: "cat /tmp/agenc-autonomy-LIVE.txt",
          },
          result: JSON.stringify({
            stdout: "AUTONOMY_STAGE2::LIVE",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 4,
        },
      ],
    );

    expect(content).toBe("/tmp/agenc-autonomy-LIVE.txt\nAUTONOMY_STAGE2::LIVE");
  });

  it("enforces exact-output contracts when synthesis includes extra verified context", () => {
    const content = reconcileExactResponseContract(
      "/workspace/autonomy_stage2.txt\nAUTONOMY_STAGE2::FILE_OK",
      [
        {
          name: "desktop.bash",
          args: {
            command: "printf 'AUTONOMY_STAGE2::FILE_OK\n' > /workspace/autonomy_stage2.txt",
          },
          result: JSON.stringify({
            stdout: "",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 5,
        },
        {
          name: "desktop.bash",
          args: {
            command: "cat /workspace/autonomy_stage2.txt",
          },
          result: JSON.stringify({
            stdout: "AUTONOMY_STAGE2::FILE_OK\n",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 4,
        },
      ],
      "Create the file, verify it, and finally return exactly AUTONOMY_STAGE2::FILE_OK and nothing else.",
    );

    expect(content).toBe("AUTONOMY_STAGE2::FILE_OK");
  });

  it("enforces quoted exact-output contracts for direct shell observations", () => {
    const content = reconcileExactResponseContract(
      "Current token: AUTONOMY_STAGE0::SMOKE",
      [
        {
          name: "desktop.bash",
          args: { command: "printf 'AUTONOMY_STAGE0::SMOKE\n'" },
          result: JSON.stringify({
            stdout: "AUTONOMY_STAGE0::SMOKE\n",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 3,
        },
      ],
      'Reply with exactly "AUTONOMY_STAGE0::SMOKE" and nothing else.',
    );

    expect(content).toBe("AUTONOMY_STAGE0::SMOKE");
  });

  it("preserves unquoted exact-output contracts with delimiters like equals and pipe", () => {
    const content = reconcileExactResponseContract(
      "TOKEN=BLACK-CIRCUIT-91|CODE=ORBITAL-SHARD",
      [],
      "Return exactly TOKEN=BLACK-CIRCUIT-91|CODE=ORBITAL-SHARD with no extra text.",
    );

    expect(content).toBe("TOKEN=BLACK-CIRCUIT-91|CODE=ORBITAL-SHARD");
  });

  it("preserves unquoted exact-output contracts with spaces", () => {
    const content = reconcileExactResponseContract(
      "terminal check complete",
      [],
      "Reply with exactly terminal check complete and nothing else.",
    );

    expect(content).toBe("terminal check complete");
  });

  it("supports answer exactly directives and strips formatting drift", () => {
    const content = reconcileExactResponseContract(
      "**PARENT-STORED-P1**",
      [],
      "Parent endurance P1. Memorize token OBSIDIAN-SIGNAL-61 for later recall and answer exactly PARENT-STORED-P1.",
    );

    expect(content).toBe("PARENT-STORED-P1");
  });

  it("supports exact-as directives for recall prompts", () => {
    const content = reconcileExactResponseContract(
      "**TOKEN=OBSIDIAN-SIGNAL-61**",
      [],
      "After compaction, without extra words return the parent token from P1 exactly as TOKEN=OBSIDIAN-SIGNAL-61.",
    );

    expect(content).toBe("TOKEN=OBSIDIAN-SIGNAL-61");
  });

  it("supports as-literal child-answer directives", () => {
    const content = reconcileExactResponseContract(
      "**TOKEN=ONYX-SHARD-58**",
      [],
      "In the child agent, without extra words return the memorized token from test C1 as TOKEN=ONYX-SHARD-58. Return exactly the child answer.",
    );

    expect(content).toBe("TOKEN=ONYX-SHARD-58");
  });

  it("forces literal compliance for exact-response turns when the model only acknowledges", () => {
    const content = reconcileExactResponseContract(
      "Memorized.",
      [],
      "Task: Child endurance F2 exact task\nObjective: In the child agent only, memorize token TOKEN=LUNAR-NOVA-88 for later recall, do not reveal it now, and answer exactly CHILD-STORED-F2.",
      { forceLiteralWhenNoToolEvidence: true },
    );

    expect(content).toBe("CHILD-STORED-F2");
  });

  it("does not force literal compliance over explicit refusal text", () => {
    const content = reconcileExactResponseContract(
      "I cannot comply with that request.",
      [],
      "Reply with exactly ACK and nothing else.",
      { forceLiteralWhenNoToolEvidence: true },
    );

    expect(content).toBe("I cannot comply with that request.");
  });

  it("recovers exact-output contracts from successful delegated child output", () => {
    const content = reconcileExactResponseContract(
      "Completed execute_with_agent",
      [
        {
          name: "execute_with_agent",
          args: {
            task: "Recall the token",
          },
          result: JSON.stringify({
            status: "completed",
            success: true,
            output: "TOKEN=IVORY-CIRCUIT-92",
            subagentSessionId: "subagent:memory",
            toolCalls: [],
          }),
          isError: false,
          durationMs: 12,
        },
      ],
      "Reply with exactly TOKEN=IVORY-CIRCUIT-92 and nothing else.",
    );

    expect(content).toBe("TOKEN=IVORY-CIRCUIT-92");
  });

  it("overrides exact success sentinels when a tool failed", () => {
    const content = reconcileStructuredToolOutcome(
      "R2_DONE_A2",
      [
        {
          name: "social.requestCollaboration",
          args: {
            title: "Launch Ritual Drill",
          },
          result: JSON.stringify({
            error:
              "Collaboration request failed: Feed post failed: AnchorError thrown in src/instructions/post_to_feed.rs:62. Error Code: InsufficientReputation.",
          }),
          isError: true,
          durationMs: 0,
        },
      ],
      "Use social.requestCollaboration, then after the tool calls finish, reply with exactly R2_DONE_A2.",
    );

    expect(content).toContain(
      "Execution could not be completed due to unresolved tool errors.",
    );
    expect(content).toContain("social.requestCollaboration");
    expect(content).not.toBe("R2_DONE_A2");
  });

  it("overrides paraphrased invocation text when every tool in the turn failed", () => {
    const content = reconcileStructuredToolOutcome(
      "invoke social.requestCollaboration with title is Launch Ritual Drill",
      [
        {
          name: "social.requestCollaboration",
          args: {
            requiredCapabilities: "3",
            maxMembers: 3,
          },
          result: JSON.stringify({
            error: "title must be a non-empty string",
          }),
          isError: true,
          durationMs: 3,
        },
      ],
      "Use social.requestCollaboration with title Launch Ritual Drill, then reply with exactly R5_DONE_A2.",
    );

    expect(content).toContain(
      "Execution could not be completed due to unresolved tool errors.",
    );
    expect(content).toContain("title must be a non-empty string");
    expect(content).not.toContain(
      "invoke social.requestCollaboration with title is Launch Ritual Drill",
    );
  });

  it("restores prefixed exact literals from delegated child recall output", () => {
    const content = reconcileExactResponseContract(
      "ONYX-SHARD-58",
      [
        {
          name: "execute_with_agent",
          args: {
            task: "Return memorized token from C1 without extra words as TOKEN=ONYX-SHARD-58",
          },
          result: JSON.stringify({
            status: "completed",
            success: true,
            output: "ONYX-SHARD-58",
            subagentSessionId: "subagent:memory",
            toolCalls: [],
          }),
          isError: false,
          durationMs: 12,
        },
      ],
      "Use execute_with_agent for this exact task. In the child agent, without extra words return the memorized token from test C1 as TOKEN=ONYX-SHARD-58. Return exactly the child answer.",
    );

    expect(content).toBe("TOKEN=ONYX-SHARD-58");
  });

  it("uses successful delegated child output in fallback summaries", () => {
    const content = summarizeToolCalls([
      {
        name: "execute_with_agent",
        args: {
          task: "Recall the token",
        },
        result: JSON.stringify({
          status: "completed",
          success: true,
          output: "TOKEN=IVORY-CIRCUIT-92",
          subagentSessionId: "subagent:memory",
          toolCalls: [],
        }),
        isError: false,
        durationMs: 12,
      },
    ]);

    expect(content).toBe("TOKEN=IVORY-CIRCUIT-92");
  });

  it("does not replay delegated cwd claims as authoritative fallback summaries", () => {
    const content = summarizeToolCalls([
      {
        name: "execute_with_agent",
        args: {
          task: "What is the current working directory in the child agent?",
        },
        result: JSON.stringify({
          status: "completed",
          success: true,
          output: "Subagent cwd: /",
          subagentSessionId: "subagent:cwd",
          toolCalls: [],
        }),
        isError: false,
        durationMs: 12,
      },
    ]);

    expect(content).toBe("Completed execute_with_agent");
  });

  it("propagates delegated child output from generateFallbackContent", () => {
    const content = generateFallbackContent([
      {
        name: "execute_with_agent",
        args: {
          task: "Recall the token",
        },
        result: JSON.stringify({
          status: "completed",
          success: true,
          output: "TOKEN=IVORY-CIRCUIT-92",
          subagentSessionId: "subagent:memory",
          toolCalls: [],
        }),
        isError: false,
        durationMs: 12,
      },
    ]);

    expect(content).toBe("TOKEN=IVORY-CIRCUIT-92");
  });

  it("suppresses delegated cwd echoes from the authoritative runtime tool ledger preview", () => {
    const message = buildToolExecutionGroundingMessage({
      toolCalls: [
        {
          name: "execute_with_agent",
          args: {
            task: "Run pwd in the child agent and report it.",
          },
          result: JSON.stringify({
            status: "completed",
            success: true,
            output: "Subagent cwd: /",
            subagentSessionId: "subagent:cwd",
            toolCalls: [],
          }),
          isError: false,
          durationMs: 17,
        },
      ],
    });

    expect(String(message?.content)).toContain(
      "[delegated output suppressed: untrusted cwd/workspace-root claim]",
    );
    expect(String(message?.content)).not.toContain("Subagent cwd: /");
  });

  it("rewrites rejected delegated scope failures before replaying them to the model", () => {
    const prepared = prepareToolResultForPrompt(
      JSON.stringify({
        success: false,
        error:
          'Requested delegated workspace root "/" is outside the trusted parent workspace root "/tmp/project".',
        issues: [{ code: "workspace_root_outside_parent_workspace" }],
        delegatedScopeTrust: "rejected_invalid_scope",
      }),
    );

    expect(prepared.text).toContain("Delegated scope was rejected by the runtime");
    expect(prepared.text).not.toContain('workspace root "/"');
    expect(prepared.text).not.toContain('"issues"');
  });

  it("omits assistant delegated cwd summaries from replay history", () => {
    const normalized = normalizeHistory([
      {
        role: "assistant",
        content: "Subagent cwd: /",
      },
    ]);

    expect(String(normalized[0]?.content)).toContain(
      "[assistant summary omitted: delegated cwd/workspace-root claim not replayed]",
    );
    expect(String(normalized[0]?.content)).not.toContain("Subagent cwd: /");
  });

  it("replaces low-information partial timeout completions with a failure fallback", () => {
    const content = reconcileTerminalFailureContent({
      content: "Completed execute_with_agent\nCompleted execute_with_agent",
      stopReason: "timeout",
      stopReasonDetail:
        "Request exceeded end-to-end timeout (600000ms) during planner pipeline execution",
      toolCalls: [
        {
          name: "execute_with_agent",
          args: { task: "core_implementation" },
          result: JSON.stringify({
            error:
              "Delegated task required file creation/edit evidence but child used no file mutation tools",
          }),
          isError: true,
          durationMs: 0,
        },
      ],
    });

    expect(content).toContain("Execution stopped before completion (timeout).");
    expect(content).toContain("execute_with_agent");
    expect(content).not.toContain("Partial response before failure:");
    expect(content).not.toContain("Completed execute_with_agent");
  });
});
