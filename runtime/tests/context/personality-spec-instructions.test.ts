import { describe, expect, test } from "vitest";

import {
  BASE_INSTRUCTIONS_PLACEHOLDER,
  getModelInstructions,
  modelSupportsPersonality,
  normalizePersonality,
  PERSONALITY_PLACEHOLDER,
  personalityMessageForModel,
  personalitySpecInstructionMessage,
  renderPersonalitySpecBody,
  renderPersonalitySpecInstructions,
  type ModelMessages,
} from "./personality-spec-instructions.js";

function modelMessages(personalityDefault = ""): ModelMessages {
  return {
    instructionsTemplate:
      `head\n${PERSONALITY_PLACEHOLDER}\n${BASE_INSTRUCTIONS_PLACEHOLDER}`,
    instructionsVariables: {
      personalityDefault,
      personalityFriendly: "friendly template",
      personalityPragmatic: "pragmatic template",
    },
  };
}

describe("personality spec instructions", () => {
  test("renders the donor body inside personality markers", () => {
    expect(renderPersonalitySpecBody("friendly template")).toBe(
      " The user has requested a new communication style. Future messages should adhere to the following personality: \nfriendly template ",
    );
    expect(renderPersonalitySpecInstructions("friendly template")).toBe(
      "<personality_spec> The user has requested a new communication style. Future messages should adhere to the following personality: \nfriendly template </personality_spec>",
    );
    expect(personalitySpecInstructionMessage("friendly template")).toEqual({
      role: "developer",
      content: [
        {
          type: "text",
          text: "<personality_spec> The user has requested a new communication style. Future messages should adhere to the following personality: \nfriendly template </personality_spec>",
        },
      ],
    });
  });

  test("resolves only the supported personality variants", () => {
    expect(normalizePersonality("none")).toBe("none");
    expect(normalizePersonality("friendly")).toBe("friendly");
    expect(normalizePersonality("pragmatic")).toBe("pragmatic");
    expect(normalizePersonality("fast")).toBeUndefined();
  });

  test("requires complete template variables for model personality support", () => {
    expect(modelSupportsPersonality(modelMessages())).toBe(true);
    expect(
      modelSupportsPersonality({
        instructionsTemplate: `head\n${PERSONALITY_PLACEHOLDER}`,
        instructionsVariables: {
          personalityFriendly: "friendly template",
          personalityPragmatic: "pragmatic template",
        },
      }),
    ).toBe(false);
  });

  test("returns personality templates, empty text for none, and default for omitted personality", () => {
    const modelInfo = { modelMessages: modelMessages("default template") };
    expect(personalityMessageForModel(modelInfo, "friendly")).toBe(
      "friendly template",
    );
    expect(personalityMessageForModel(modelInfo, "pragmatic")).toBe(
      "pragmatic template",
    );
    expect(personalityMessageForModel(modelInfo, "none")).toBe("");
    expect(personalityMessageForModel(modelInfo, undefined)).toBe(
      "default template",
    );
  });

  test("fills instruction templates with personality and live base prompt", () => {
    const modelInfo = { modelMessages: modelMessages("default template") };
    expect(
      getModelInstructions({
        modelInfo,
        baseInstructions: "base prompt",
        personality: "friendly",
      }),
    ).toBe("head\nfriendly template\nbase prompt");
    expect(
      getModelInstructions({
        modelInfo,
        baseInstructions: "base prompt",
        personality: "none",
      }),
    ).toBe("head\n\nbase prompt");
    expect(
      getModelInstructions({
        modelInfo,
        baseInstructions: "base prompt",
      }),
    ).toBe("head\ndefault template\nbase prompt");
  });

  test("always strips personality placeholder even when variables are incomplete", () => {
    const partialModelInfo = {
      modelMessages: {
        instructionsTemplate: `Hello\n${PERSONALITY_PLACEHOLDER}`,
        instructionsVariables: {
          personalityFriendly: "friendly template",
        },
      },
    };
    expect(
      getModelInstructions({
        modelInfo: partialModelInfo,
        baseInstructions: "base prompt",
        personality: "friendly",
      }),
    ).toBe("Hello\nfriendly template");
    expect(
      getModelInstructions({
        modelInfo: partialModelInfo,
        baseInstructions: "base prompt",
        personality: "pragmatic",
      }),
    ).toBe("Hello\n");
    expect(
      getModelInstructions({
        modelInfo: partialModelInfo,
        baseInstructions: "base prompt",
        personality: "none",
      }),
    ).toBe("Hello\n");
    expect(
      getModelInstructions({
        modelInfo: partialModelInfo,
        baseInstructions: "base prompt",
      }),
    ).toBe("Hello\n");

    const emptyModelInfo = {
      modelMessages: {
        instructionsTemplate: `Hello\n${PERSONALITY_PLACEHOLDER}`,
        instructionsVariables: {},
      },
    };
    expect(
      getModelInstructions({
        modelInfo: emptyModelInfo,
        baseInstructions: "base prompt",
        personality: "friendly",
      }),
    ).toBe("Hello\n");
  });
});
