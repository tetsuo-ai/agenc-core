import { afterEach, describe, expect, test } from "vitest";

import {
  clearAskUserQuestionResponsesForTest,
  createAskUserQuestionTool,
  parseAskUserQuestionInput,
  recordAskUserQuestionResponse,
  type AskUserQuestionInput,
} from "./ask-user-question.js";

const BASE_INPUT: AskUserQuestionInput = {
  questions: [
    {
      header: "Scope",
      question: "Which implementation path should AgenC take?",
      options: [
        {
          label: "Port OpenClaude picker (Recommended)",
          description: "Match upstream's choice-based interview flow.",
          preview: "Implement AskUserQuestion in the TUI permission path.",
        },
        {
          label: "Keep current plan mode",
          description: "Do not add interactive planner questions.",
        },
      ],
    },
  ],
};

describe("AskUserQuestion tool", () => {
  afterEach(() => {
    clearAskUserQuestionResponsesForTest();
  });

  test("parses OpenClaude-style question payloads", () => {
    const parsed = parseAskUserQuestionInput(BASE_INPUT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.questions[0]?.options[0]?.label).toBe(
      "Port OpenClaude picker (Recommended)",
    );
  });

  test("rejects malformed or ambiguous payloads", () => {
    expect(parseAskUserQuestionInput({ questions: [] })).toEqual({
      ok: false,
      error: "questions must contain 1-4 items",
    });
    expect(
      parseAskUserQuestionInput({
        questions: [
          {
            header: "Bad",
            question: "Pick one",
            options: [
              { label: "Same", description: "first" },
              { label: "Same", description: "second" },
            ],
          },
        ],
      }),
    ).toEqual({
      ok: false,
      error: 'option labels must be unique within question "Pick one"',
    });
  });

  test("requires TUI-recorded answers before returning model-facing result", async () => {
    const tool = createAskUserQuestionTool();

    await expect(
      tool.execute({
        ...BASE_INPUT,
        answers: {
          "Which implementation path should AgenC take?":
            "Port OpenClaude picker (Recommended)",
        },
      }),
    ).resolves.toEqual({
      content: "User did not provide answers.",
      isError: true,
    });
  });

  test("does not expose internal answer fields in the model schema", () => {
    const schema = createAskUserQuestionTool().inputSchema as {
      properties: Record<string, unknown>;
    };

    expect(Object.keys(schema.properties).sort()).toEqual(["questions"]);
  });

  test("consumes TUI-recorded answers keyed by call id", async () => {
    const tool = createAskUserQuestionTool();
    recordAskUserQuestionResponse("call-1", {
      ...BASE_INPUT,
      answers: {
        "Which implementation path should AgenC take?":
          "Port OpenClaude picker (Recommended)",
      },
      annotations: {
        "Which implementation path should AgenC take?": {
          preview: "Implement AskUserQuestion in the TUI permission path.",
        },
      },
    });

    const result = await tool.execute({ ...BASE_INPUT, __callId: "call-1" });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("User has answered your questions");
    expect(result.content).toContain(
      '"Which implementation path should AgenC take?"="Port OpenClaude picker (Recommended)"',
    );
    expect(result.codeModeResult).toMatchObject({
      answers: {
        "Which implementation path should AgenC take?":
          "Port OpenClaude picker (Recommended)",
      },
    });
  });
});
