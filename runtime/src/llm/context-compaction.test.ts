import { describe, expect, it } from "vitest";

import { compactHistoryIntoArtifactContext } from "./context-compaction.js";
import type { LLMMessage } from "./types.js";

function multimodalMessage(): LLMMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: "See the attached diagram." },
      { type: "image_url", image_url: { url: "https://example.com/diagram.png" } },
    ],
  };
}

describe("context compaction", () => {
  it("preserves unresolved stub work even when the narrative summary falsely claims closure", () => {
    const history: LLMMessage[] = [
      {
        role: "system",
        content:
          "PLAN status: Phase 1 is stub only, not implemented. Phase 2 is not started and still needs verification.",
      },
      {
        role: "assistant",
        content:
          "Current state is partial. Parser remains incomplete and implementation is not finished.",
      },
      {
        role: "user",
        content: "Keep implementing and do not claim this is done yet.",
      },
      {
        role: "assistant",
        content: "Working on it.",
      },
    ];

    const compacted = compactHistoryIntoArtifactContext({
      sessionId: "session-1",
      history,
      keepTailCount: 1,
      source: "executor_compaction",
      narrativeSummary: "No unresolved work identified in history. All work complete.",
    });

    expect(compacted.summaryText).toContain("Unresolved work remains");
    expect(compacted.summaryText).toContain("stub only");
    expect(compacted.summaryText).toContain("needs verification");
  });

  it("overrides no-blocker compaction summaries when open verification loops remain", () => {
    const history: LLMMessage[] = [
      {
        role: "tool",
        toolName: "system.readFile",
        content: JSON.stringify({
          path: "/tmp/agenc-shell/tests/run_tests.sh",
          content:
            "#!/bin/bash\n# TODO expand tests\n./agenc-shell --help || echo 'Binary runs (stub)'\n",
        }),
      },
      {
        role: "assistant",
        content:
          "Build succeeded in build-agenc-fresh, but the repo test harness is still stubbed and needs verification before this request is complete.",
      },
      {
        role: "assistant",
        content: "Continuing with grounded verification work.",
      },
    ];

    const compacted = compactHistoryIntoArtifactContext({
      sessionId: "session-no-blockers",
      history,
      keepTailCount: 1,
      source: "executor_compaction",
      narrativeSummary:
        "### Key Decisions\n- Built the workspace in a fresh directory.\n\n### Explicit Blockers\nNone identified.\n\n### Unresolved Work\n- Execute the full test harness and finish verification.",
    });

    expect(compacted.summaryText).toContain("Unresolved work remains");
    expect(compacted.summaryText).toContain("run_tests.sh");
    expect(compacted.summaryText).toContain("stub");
    expect(compacted.summaryText).toContain("needs verification");
    expect(compacted.summaryText).not.toContain("None identified.");
  });

  it("drops stale blocker narratives when later file changes and passing tests supersede them", () => {
    const history: LLMMessage[] = [
      {
        role: "tool",
        toolName: "system.bash",
        content: JSON.stringify({
          stderr: "invalid command format: shell operators require shell mode",
          stdout: "",
          exitCode: 1,
        }),
      },
      {
        role: "tool",
        toolName: "system.writeFile",
        content: JSON.stringify({
          path: "/tmp/agenc-shell/src/parser.c",
          bytesWritten: 1717,
        }),
      },
      {
        role: "tool",
        toolName: "system.bash",
        content: JSON.stringify({
          stderr: "",
          stdout:
            "Running tests...\n[100%] Built target agenc-shell\nCompilation test passed\nAgenc Shell\n> All tests passed\n",
          exitCode: 0,
        }),
      },
      {
        role: "assistant",
        content: "Continuing with grounded implementation work.",
      },
    ];

    const compacted = compactHistoryIntoArtifactContext({
      sessionId: "session-2",
      history,
      keepTailCount: 1,
      source: "executor_compaction",
      narrativeSummary:
        "The run is blocked by invalid command format and still requires full implementation before tests can pass.",
    });

    expect(compacted.summaryText).toContain("supersede earlier blockers");
    expect(compacted.summaryText).toContain("Compilation test passed");
    expect(compacted.summaryText).toContain("/tmp/agenc-shell/src/parser.c");
    expect(compacted.summaryText).not.toContain("invalid command format and still requires full implementation");
  });

  it("preserves compiler interface-drift diagnostics as first-class artifact refs across compaction", () => {
    const history: LLMMessage[] = [
      {
        role: "tool",
        toolName: "system.bash",
        content: JSON.stringify({
          exitCode: 2,
          stderr:
            "/tmp/agenc-shell/src/parser.c:87:23: error: 'ASTNode' has no member named 'next'\n" +
            "/tmp/agenc-shell/src/parser.c:102:17: error: unknown type name 'Redirect'; did you mean 'Redir'?\n" +
            "/tmp/agenc-shell/src/parser.c:133:21: error: 'TOK_REDIRECT_IN' undeclared (first use in this function); did you mean 'TOK_REDIR_IN'?\n",
        }),
      },
      {
        role: "assistant",
        content:
          "I need to align parser.c with the shared header contract before rebuilding.",
      },
      {
        role: "assistant",
        content: "Working on the repair now.",
      },
    ];

    const compacted = compactHistoryIntoArtifactContext({
      sessionId: "session-3",
      history,
      keepTailCount: 1,
      source: "executor_compaction",
      narrativeSummary:
        "Build still failing; preserve the exact compiler drift until the interface is repaired.",
    });

    expect(compacted.state.artifactRefs.some((artifact) => artifact.kind === "compiler_diagnostic")).toBe(true);
    expect(compacted.summaryText).toContain("compiler_diagnostic");
    expect(compacted.summaryText).toContain("has no member named 'next'");
    expect(compacted.summaryText).toContain("did you mean 'Redir'");
    expect(compacted.summaryText).toContain("TOK_REDIR_IN");
  });

  it("rebuilds the compacted history with preserved multimodal messages", () => {
    const history: LLMMessage[] = [
      multimodalMessage(),
      {
        role: "assistant",
        content: "Continuing with the image context.",
      },
      {
        role: "user",
        content: "Wrap up the remaining work.",
      },
    ];

    const compacted = compactHistoryIntoArtifactContext({
      sessionId: "session-4",
      history,
      keepTailCount: 1,
      source: "session_compaction",
    });

    expect(compacted.compactedHistory).toHaveLength(3);
    expect(compacted.compactedHistory[0]?.role).toBe("system");
    expect(compacted.compactedHistory[1]).toMatchObject(history[0]);
    expect(compacted.compactedHistory[1]?.content).toEqual(history[0].content);
    expect(compacted.compactedHistory[2]).toEqual(history[2]);
  });
});
