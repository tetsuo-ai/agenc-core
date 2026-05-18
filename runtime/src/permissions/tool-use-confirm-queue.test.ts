import { afterEach, describe, it, expect, vi } from "vitest";

import type { ApprovalCtx } from "../tools/orchestrator.js";
import type { ReviewDecision } from "./review-decision.js";
import {
  ABORT,
  APPROVED,
  APPROVED_FOR_SESSION,
  DENIED,
} from "./review-decision.js";
import { buildToolUseConfirmQueue } from "../tui/permission-requests.js";
import { clearAskUserQuestionResponsesForTest, createAskUserQuestionTool } from "../tools/ask-user-question/tool.js";
import type { AskUserQuestionInput } from "../tools/ask-user-question/tool.js";

interface PendingRequestLike {
  readonly id: string;
  readonly ctx: ApprovalCtx;
  readonly input: Record<string, unknown>;
  readonly description: string;
  resolve(decision: ReviewDecision): void;
}

function fakeCtx(toolName: string, callId: string): ApprovalCtx {
  return {
    toolName,
    callId,
    invocation: { payload: { kind: "function", arguments: "{}" } },
  } as unknown as ApprovalCtx;
}

function makeRequest(
  toolName: string,
  callId: string,
  resolveSpy: (decision: ReviewDecision) => void,
): PendingRequestLike {
  return {
    id: callId,
    ctx: fakeCtx(toolName, callId),
    input: {},
    description: `permission to use ${toolName}`,
    resolve: resolveSpy,
  };
}

const ASK_USER_QUESTION_INPUT: AskUserQuestionInput = {
  questions: [
    {
      header: "Scope",
      question: "Which implementation path should AgenC take?",
      options: [
        {
          label: "Use AgenC picker (Recommended)",
          description: "Use the interactive question flow.",
          preview: "Wire onAllow(updatedInput) to the model result.",
        },
        {
          label: "Keep current plan mode",
          description: "Skip the structured question flow.",
        },
      ],
    },
  ],
};

describe("buildToolUseConfirmQueue (TUI multi-approval queue)", () => {
  afterEach(() => {
    clearAskUserQuestionResponsesForTest();
  });

  it("returns empty when there are no pending requests", () => {
    const got = buildToolUseConfirmQueue([], [{ name: "Bash" }]);
    expect(got).toEqual([]);
  });

  it("projects a single pending request to one queue entry", () => {
    const r = makeRequest("Bash", "call-1", () => {});
    const got = buildToolUseConfirmQueue(
      [r as never],
      [{ name: "Bash" }],
    );
    expect(got.length).toBe(1);
  });

  it("projects every pending request — multi-approval queue does not collapse", () => {
    const r1 = makeRequest("Bash", "call-1", () => {});
    const r2 = makeRequest("FileEdit", "call-2", () => {});
    const r3 = makeRequest("Bash", "call-3", () => {});
    const got = buildToolUseConfirmQueue(
      [r1 as never, r2 as never, r3 as never],
      [{ name: "Bash" }, { name: "FileEdit" }],
    );
    expect(got.length).toBe(3);
    expect(got.map((c) => (c as { toolUseID: string }).toolUseID)).toEqual([
      "call-1",
      "call-2",
      "call-3",
    ]);
  });

  it("preserves arrival order", () => {
    const r1 = makeRequest("Bash", "first", () => {});
    const r2 = makeRequest("Bash", "second", () => {});
    const got = buildToolUseConfirmQueue(
      [r1 as never, r2 as never],
      [{ name: "Bash" }],
    );
    expect((got[0] as { toolUseID: string }).toolUseID).toBe("first");
    expect((got[1] as { toolUseID: string }).toolUseID).toBe("second");
  });

  it("each entry resolves its own request — onAllow calls the right resolver", () => {
    let resolved1: ReviewDecision | null = null;
    let resolved2: ReviewDecision | null = null;
    const r1 = makeRequest("Bash", "call-1", (d) => {
      resolved1 = d;
    });
    const r2 = makeRequest("Bash", "call-2", (d) => {
      resolved2 = d;
    });
    const got = buildToolUseConfirmQueue(
      [r1 as never, r2 as never],
      [{ name: "Bash" }],
    );
    (got[0] as { onAllow: (i: unknown, u: unknown[]) => void }).onAllow({}, []);
    expect(resolved1).toBe(APPROVED);
    expect(resolved2).toBeNull();
    (got[1] as { onReject: () => void }).onReject();
    expect(resolved2).toBe(DENIED);
  });

  it("onAllow with permission updates resolves to APPROVED_FOR_SESSION; onAbort resolves to ABORT", () => {
    let resolved: ReviewDecision | null = null;
    const r = makeRequest("Bash", "call-1", (d) => {
      resolved = d;
    });
    const queue = buildToolUseConfirmQueue([r as never], [{ name: "Bash" }]);
    (queue[0] as { onAllow: (i: unknown, u: unknown[]) => void }).onAllow({}, [
      "some-update",
    ]);
    expect(resolved).toBe(APPROVED_FOR_SESSION);

    let abortResolved: ReviewDecision | null = null;
    const r2 = makeRequest("Bash", "call-2", (d) => {
      abortResolved = d;
    });
    const queue2 = buildToolUseConfirmQueue([r2 as never], [{ name: "Bash" }]);
    (queue2[0] as { onAbort: () => void }).onAbort();
    expect(abortResolved).toBe(ABORT);
  });

  it("records AskUserQuestion updated input before resolving approval", async () => {
    let resolved: ReviewDecision | null = null;
    const request = {
      ...makeRequest("AskUserQuestion", "ask-call-1", (decision) => {
        resolved = decision;
      }),
      input: ASK_USER_QUESTION_INPUT as unknown as Record<string, unknown>,
    };
    const queue = buildToolUseConfirmQueue(
      [request as never],
      [{ name: "AskUserQuestion" }],
    );
    const updatedInput = {
      ...ASK_USER_QUESTION_INPUT,
      answers: {
        "Which implementation path should AgenC take?":
          "Use AgenC picker (Recommended)",
      },
      annotations: {
        "Which implementation path should AgenC take?": {
          preview: "Wire onAllow(updatedInput) to the model result.",
        },
      },
    };

    (queue[0] as { onAllow: (input: unknown, updates: unknown[]) => void }).onAllow(
      updatedInput,
      [],
    );

    expect(resolved).toBe(APPROVED);
    const result = await createAskUserQuestionTool().execute({
      ...ASK_USER_QUESTION_INPUT,
      __callId: "ask-call-1",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("User has answered your questions");
    expect(result.content).toContain(
      '"Which implementation path should AgenC take?"="Use AgenC picker (Recommended)"',
    );
  });

  it("maps AskUserQuestion clarify feedback into a chat continuation result", async () => {
    let resolved: ReviewDecision | null = null;
    const request = {
      ...makeRequest("AskUserQuestion", "ask-chat-1", (decision) => {
        resolved = decision;
      }),
      input: ASK_USER_QUESTION_INPUT as unknown as Record<string, unknown>,
    };
    const queue = buildToolUseConfirmQueue(
      [request as never],
      [{ name: "AskUserQuestion" }],
    );

    (queue[0] as { onReject: (feedback?: string) => void }).onReject(
      "The user wants to clarify these questions.",
    );

    expect(resolved).toBe(APPROVED);
    const result = await createAskUserQuestionTool().execute({
      ...ASK_USER_QUESTION_INPUT,
      __callId: "ask-chat-1",
    });
    expect(result.content).toContain("chat about these questions");
    expect(result.codeModeResult).toMatchObject({
      planInterviewAction: "chat_about_this",
    });
  });

  it("maps AskUserQuestion finish feedback into a skip-interview result", async () => {
    let resolved: ReviewDecision | null = null;
    const request = {
      ...makeRequest("AskUserQuestion", "ask-finish-1", (decision) => {
        resolved = decision;
      }),
      input: ASK_USER_QUESTION_INPUT as unknown as Record<string, unknown>,
    };
    const queue = buildToolUseConfirmQueue(
      [request as never],
      [{ name: "AskUserQuestion" }],
    );

    (queue[0] as { onReject: (feedback?: string) => void }).onReject(
      "The user has indicated they have provided enough answers for the plan interview.",
    );

    expect(resolved).toBe(APPROVED);
    const result = await createAskUserQuestionTool().execute({
      ...ASK_USER_QUESTION_INPUT,
      __callId: "ask-finish-1",
    });
    expect(result.content).toContain("skipped the planning interview");
    expect(result.codeModeResult).toMatchObject({
      planInterviewAction: "skip_plan_interview",
    });
  });

  it("returns empty when the tool registry is empty (no matching tool)", () => {
    const r = makeRequest("Bash", "call-1", () => {});
    const got = buildToolUseConfirmQueue([r as never], []);
    expect(got).toEqual([]);
  });

  it("fails closed when none of the registered tools match the request", () => {
    let resolved: ReviewDecision | null = null;
    const r = makeRequest("MissingTool", "call-1", (decision) => {
      resolved = decision;
    });
    const got = buildToolUseConfirmQueue([r as never], [{ name: "Bash" }]);
    expect(got).toEqual([]);
    expect(resolved).toBe(DENIED);
  });
});
