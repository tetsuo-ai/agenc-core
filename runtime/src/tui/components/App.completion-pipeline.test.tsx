import { describe, expect, test } from "vitest";

import { shouldShowPromptInputState } from "./App.js";

describe("App completion pipeline prompt ownership", () => {
  test("hides prompt input while the completion pipeline owns the terminal", () => {
    expect(
      shouldShowPromptInputState({
        isMessageSelectorVisible: false,
        permissionRequestCount: 0,
        hasElicitationPrompt: false,
        completionPipelineOwnsPrompt: true,
      }),
    ).toBe(false);
  });

  test("returns prompt input when the pipeline and overlays are clear", () => {
    expect(
      shouldShowPromptInputState({
        isMessageSelectorVisible: false,
        permissionRequestCount: 0,
        hasElicitationPrompt: false,
        completionPipelineOwnsPrompt: false,
      }),
    ).toBe(true);
  });

  test("keeps overlay suppression ahead of pipeline state", () => {
    expect(
      shouldShowPromptInputState({
        isMessageSelectorVisible: true,
        permissionRequestCount: 1,
        hasElicitationPrompt: true,
        completionPipelineOwnsPrompt: false,
      }),
    ).toBe(false);
  });
});
