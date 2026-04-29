import { describe, expect, it } from "vitest";

import {
  compactHistoryIntoArtifactContext,
  createCompactBoundaryMessage,
  isCompactBoundaryMessage,
} from "./context-compaction.js";
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
    expect(
      compacted.state.artifactRefs.some((artifact) =>
        artifact.summary.includes("Compilation test passed"),
      ),
    ).toBe(true);
    expect(
      compacted.state.artifactRefs.some((artifact) =>
        artifact.title.includes("/tmp/agenc-shell/src/parser.c"),
      ),
    ).toBe(true);
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

    expect(
      compacted.state.artifactRefs.some(
        (artifact) => artifact.kind === "compiler_diagnostic",
      ),
    ).toBe(true);
    expect(
      compacted.state.artifactRefs.some((artifact) =>
        artifact.summary.includes("has no member named 'next'"),
      ),
    ).toBe(true);
    expect(
      compacted.state.artifactRefs.some((artifact) =>
        artifact.summary.includes("did you mean 'Redir'"),
      ),
    ).toBe(true);
    expect(
      compacted.state.artifactRefs.some((artifact) =>
        artifact.summary.includes("TOK_REDIR_IN"),
      ),
    ).toBe(true);
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
    expect(String(compacted.compactedHistory[0]?.content)).toContain("[boundary]");
    expect(compacted.boundaryMessage).toEqual(compacted.compactedHistory[0]);
    expect(compacted.compactedHistory[1]).toMatchObject(history[0]);
    expect(compacted.compactedHistory[1]?.content).toEqual(history[0].content);
    expect(compacted.compactedHistory[2]).toEqual(history[2]);
  });

  it("keeps session compaction tails aligned to whole tool turns", () => {
    const history: LLMMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc-1", name: "system.grep", arguments: '{"pattern":"foo"}' }],
      },
      {
        role: "tool",
        toolCallId: "tc-1",
        toolName: "system.grep",
        content: '{"error":"failed"}',
      },
      {
        role: "assistant",
        content: "Continuing after the failed grep.",
      },
      {
        role: "user",
        content: "Keep going.",
      },
    ];

    const compacted = compactHistoryIntoArtifactContext({
      sessionId: "session-safe-tail",
      history,
      keepTailCount: 3,
      source: "session_compaction",
    });

    expect(compacted.compactedHistory.slice(1, 5)).toEqual(history);
  });

  it("preserves a pre-existing boundary verbatim across re-compaction", () => {
    const priorBoundary = createCompactBoundaryMessage({
      boundaryId: "snapshot:priorboundary1",
      source: "executor_compaction",
      sourceMessageCount: 12,
      retainedTailCount: 3,
      summaryText: "earlier summary text",
    });
    const history: LLMMessage[] = [
      priorBoundary,
      { role: "assistant", content: "work after prior boundary" },
      { role: "assistant", content: "more work" },
      { role: "user", content: "continue" },
      { role: "assistant", content: "will do" },
    ];

    const compacted = compactHistoryIntoArtifactContext({
      sessionId: "session-rec",
      history,
      keepTailCount: 1,
      source: "executor_compaction",
    });

    // Prior boundary must appear verbatim at its original relative
    // position so the prefix hash seen by the provider cache does not
    // drift across successive compactions.
    expect(compacted.compactedHistory[0]).toEqual(priorBoundary);
    // The new boundary is the second message (after the prior one).
    expect(compacted.boundaryMessage).toBe(compacted.compactedHistory[1]);
    expect(isCompactBoundaryMessage(compacted.compactedHistory[1]!)).toBe(true);
  });

  it("excludes prior-boundary content from the new boundary's hash", () => {
    const priorBoundaryA = createCompactBoundaryMessage({
      boundaryId: "snapshot:aaaaaaaa",
      source: "executor_compaction",
      sourceMessageCount: 9,
      retainedTailCount: 2,
      summaryText: "summary A",
    });
    const priorBoundaryB = createCompactBoundaryMessage({
      boundaryId: "snapshot:bbbbbbbb",
      source: "executor_compaction",
      sourceMessageCount: 11,
      retainedTailCount: 3,
      summaryText: "summary B — totally different text",
    });
    const nonBoundaryTail: LLMMessage[] = [
      { role: "assistant", content: "identical work item 1" },
      { role: "assistant", content: "identical work item 2" },
      { role: "user", content: "same user prompt" },
    ];

    const compactedWithA = compactHistoryIntoArtifactContext({
      sessionId: "session-hash",
      history: [priorBoundaryA, ...nonBoundaryTail],
      keepTailCount: 1,
      source: "executor_compaction",
    });
    const compactedWithB = compactHistoryIntoArtifactContext({
      sessionId: "session-hash",
      history: [priorBoundaryB, ...nonBoundaryTail],
      keepTailCount: 1,
      source: "executor_compaction",
    });

    // The new boundary's hash is derived from the non-boundary content
    // only, so swapping the prior boundary produces the same
    // snapshotId. This is what keeps the xAI prompt_cache_key prefix
    // match region stable across successive compactions that carry
    // different prior-summary text forward.
    expect(compactedWithA.state.snapshotId).toBe(compactedWithB.state.snapshotId);
  });

  it("isCompactBoundaryMessage recognizes both boundary shapes", () => {
    const executorBoundary = createCompactBoundaryMessage({
      boundaryId: "snapshot:aa",
      source: "executor_compaction",
      sourceMessageCount: 1,
      retainedTailCount: 1,
    });
    const reactiveBoundary: LLMMessage = {
      role: "system",
      content: "[reactive-compact] trimmed 5 oldest messages (attempt 1)",
    };
    const regularSystem: LLMMessage = {
      role: "system",
      content: "You are a helpful assistant.",
    };

    expect(isCompactBoundaryMessage(executorBoundary)).toBe(true);
    expect(isCompactBoundaryMessage(reactiveBoundary)).toBe(true);
    expect(isCompactBoundaryMessage(regularSystem)).toBe(false);
  });
});
