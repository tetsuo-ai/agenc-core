import { describe, expect, test, vi } from "vitest";

import { submitViaElicitationPrompt } from "./elicitation-submit-routing.js";

function helpers() {
  return {
    clearBuffer: vi.fn(),
    resetHistory: vi.fn(),
    setCursorOffset: vi.fn(),
  };
}

describe("submitViaElicitationPrompt", () => {
  test("clears the composer before dispatching normal submissions", async () => {
    const clear = helpers();
    const submit = vi.fn(async () => {
      expect(clear.clearBuffer).toHaveBeenCalledTimes(1);
      expect(clear.resetHistory).toHaveBeenCalledTimes(1);
      expect(clear.setCursorOffset).toHaveBeenCalledWith(0);
    });

    await submitViaElicitationPrompt(
      { submit: () => false },
      submit,
      "/mcp tools",
      clear,
    );

    expect(submit).toHaveBeenCalledWith("/mcp tools");
    expect(clear.clearBuffer).toHaveBeenCalledTimes(1);
  });

  test("clears the composer when an elicitation prompt handles the input", async () => {
    const submit = vi.fn();
    const clear = helpers();

    await submitViaElicitationPrompt(
      { submit: () => true },
      submit,
      "yes",
      clear,
    );

    expect(submit).not.toHaveBeenCalled();
    expect(clear.clearBuffer).toHaveBeenCalledTimes(1);
    expect(clear.resetHistory).toHaveBeenCalledTimes(1);
    expect(clear.setCursorOffset).toHaveBeenCalledWith(0);
  });
});
