import { describe, expect, test } from "vitest";

import {
  DEFAULT_REALTIME_BACKEND_PROMPT,
  DEFAULT_REALTIME_END_INSTRUCTIONS,
  DEFAULT_REALTIME_START_INSTRUCTIONS,
  REALTIME_USER_FIRST_NAME_PLACEHOLDER,
  currentRealtimeUserFirstName,
  prepareRealtimeBackendPrompt,
} from "./prompt.js";

describe("realtime backend prompt preparation", () => {
  test("uses nonblank config prompt before caller prompt and preserves it", () => {
    expect(
      prepareRealtimeBackendPrompt("caller prompt", "  config prompt  "),
    ).toBe("  config prompt  ");
  });

  test("uses caller prompt when config prompt is blank", () => {
    expect(prepareRealtimeBackendPrompt("caller prompt", "   ")).toBe(
      "caller prompt",
    );
    expect(prepareRealtimeBackendPrompt("", "   ")).toBe("");
  });

  test("null caller prompt clears the backend prompt when config is absent", () => {
    expect(prepareRealtimeBackendPrompt(null, null)).toBe("");
    expect(prepareRealtimeBackendPrompt(null, "")).toBe("");
  });

  test("bundled default replaces user first name placeholder", () => {
    const rendered = prepareRealtimeBackendPrompt(undefined, null, {
      candidates: ["  Ada Lovelace  "],
    });

    expect(rendered.startsWith("## Identity, tone, and role")).toBe(true);
    expect(rendered).toContain("The user's name is Ada.");
    expect(rendered).not.toContain(REALTIME_USER_FIRST_NAME_PLACEHOLDER);
    expect(rendered.endsWith("\n")).toBe(false);
  });

  test("first-name discovery skips blank candidates and falls back", () => {
    expect(
      currentRealtimeUserFirstName({
        candidates: ["", "   ", "Grace Hopper"],
      }),
    ).toBe("Grace");
    expect(
      currentRealtimeUserFirstName({
        candidates: ["", null, undefined, "   "],
      }),
    ).toBe("there");
  });

  test("exports literal realtime prompt assets", () => {
    expect(DEFAULT_REALTIME_BACKEND_PROMPT).toContain(
      REALTIME_USER_FIRST_NAME_PLACEHOLDER,
    );
    expect(DEFAULT_REALTIME_START_INSTRUCTIONS.trim()).toContain(
      "Realtime conversation started.",
    );
    expect(DEFAULT_REALTIME_END_INSTRUCTIONS.trim()).toContain(
      "Realtime conversation ended.",
    );
  });
});
