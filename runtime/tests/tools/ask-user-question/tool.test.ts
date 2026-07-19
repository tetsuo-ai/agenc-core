import { afterEach, describe, expect, test } from "vitest";

import { clearAskUserQuestionResponsesForTest, createAskUserQuestionTool, parseAskUserQuestionInput, recordAskUserQuestionResponse } from "./tool.js";
import type { AskUserQuestionInput } from "./tool.js";

const BASE_INPUT: AskUserQuestionInput = {
  questions: [
    {
      header: "Scope",
      question: "Which implementation path should AgenC take?",
      options: [
        {
          label: "Use AgenC picker (Recommended)",
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

  test("parses AgenC-style question payloads", () => {
    const parsed = parseAskUserQuestionInput(BASE_INPUT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.questions[0]?.options[0]?.label).toBe(
      "Use AgenC picker (Recommended)",
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
    expect(
      parseAskUserQuestionInput({
        questions: [
          {
            header: "Bad",
            question: "Pick one",
            options: [
              { label: "A", description: "first" },
              { label: "B" },
            ],
          },
        ],
      }),
    ).toEqual({
      ok: false,
      error: "questions[0].options[1] needs a description (or preview)",
    });
  });

  test("accepts preview-only options (Grok-style payloads)", () => {
    // Grok consistently sends `preview` instead of `description` and does not
    // recover from the validation error — the parser maps preview →
    // description so those calls succeed.
    const parsed = parseAskUserQuestionInput({
      questions: [
        {
          header: "Scope",
          question: "Which approach?",
          options: [
            { label: "A", preview: "the first approach" },
            { label: "B", preview: "the second approach" },
          ],
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.questions[0]?.options[0]?.description).toBe(
      "the first approach",
    );
    expect(parsed.input.questions[0]?.options[0]?.preview).toBe(
      "the first approach",
    );
  });

  test("requires TUI-recorded answers before returning model-facing result", async () => {
    const tool = createAskUserQuestionTool();

    await expect(
      tool.execute({
        ...BASE_INPUT,
        answers: {
          "Which implementation path should AgenC take?":
            "Use AgenC picker (Recommended)",
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
          "Use AgenC picker (Recommended)",
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
      '"Which implementation path should AgenC take?"="Use AgenC picker (Recommended)"',
    );
    expect(result.codeModeResult).toMatchObject({
      answers: {
        "Which implementation path should AgenC take?":
          "Use AgenC picker (Recommended)",
      },
    });
  });

  test("recorded answers are consumed once", async () => {
    const tool = createAskUserQuestionTool();
    recordAskUserQuestionResponse("call-once", {
      ...BASE_INPUT,
      answers: {
        "Which implementation path should AgenC take?":
          "Use AgenC picker (Recommended)",
      },
    });

    const first = await tool.execute({ ...BASE_INPUT, __callId: "call-once" });
    expect(first.isError).toBeUndefined();
    await expect(
      tool.execute({ ...BASE_INPUT, __callId: "call-once" }),
    ).resolves.toEqual({
      content: "User did not provide answers.",
      isError: true,
    });
  });

  test("recorded answers are isolated by call id", async () => {
    const tool = createAskUserQuestionTool();
    recordAskUserQuestionResponse("expected-call", {
      ...BASE_INPUT,
      answers: {
        "Which implementation path should AgenC take?":
          "Use AgenC picker (Recommended)",
      },
    });

    await expect(
      tool.execute({ ...BASE_INPUT, __callId: "other-call" }),
    ).resolves.toEqual({
      content: "User did not provide answers.",
      isError: true,
    });
    const expected = await tool.execute({
      ...BASE_INPUT,
      __callId: "expected-call",
    });
    expect(expected.isError).toBeUndefined();
  });
});
