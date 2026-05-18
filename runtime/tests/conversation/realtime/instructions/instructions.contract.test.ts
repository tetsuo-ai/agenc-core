import { describe, expect, test } from "vitest";

import {
  isContextualDeveloperMessageContent,
} from "../../../session/rollout-reconstruction.js";
import {
  REALTIME_CONVERSATION_CLOSE_TAG,
  REALTIME_CONVERSATION_OPEN_TAG,
} from "./markers.js";
import {
  realtimeEndInstructionMessage,
  realtimeStartInstructionMessage,
  realtimeStartWithInstructionsMessage,
  renderRealtimeEndInstructions,
  renderRealtimeStartInstructions,
  renderRealtimeStartWithInstructions,
} from "./messages.js";

describe("realtime instruction fragments", () => {
  test("renders default start instructions inside realtime markers", () => {
    const rendered = renderRealtimeStartInstructions();

    expect(rendered.startsWith(`${REALTIME_CONVERSATION_OPEN_TAG}\n`)).toBe(true);
    expect(rendered).toContain("Realtime conversation started.");
    expect(rendered.endsWith(`\n${REALTIME_CONVERSATION_CLOSE_TAG}`)).toBe(true);
  });

  test("renders end instructions with the close reason", () => {
    const rendered = renderRealtimeEndInstructions("inactive");

    expect(rendered).toContain("Realtime conversation ended.");
    expect(rendered).toContain("\n\nReason: inactive\n");
    expect(rendered.endsWith(`\n${REALTIME_CONVERSATION_CLOSE_TAG}`)).toBe(true);
  });

  test("preserves custom start instruction body without trimming", () => {
    expect(renderRealtimeStartWithInstructions("  custom\n")).toBe(
      `${REALTIME_CONVERSATION_OPEN_TAG}\n  custom\n\n${REALTIME_CONVERSATION_CLOSE_TAG}`,
    );
    expect(renderRealtimeStartWithInstructions("")).toBe(
      `${REALTIME_CONVERSATION_OPEN_TAG}\n\n${REALTIME_CONVERSATION_CLOSE_TAG}`,
    );
  });

  test("builds developer-role message items", () => {
    expect(realtimeStartInstructionMessage()).toMatchObject({
      role: "developer",
      content: [{ type: "text", text: expect.stringContaining("Realtime conversation started.") }],
    });
    expect(realtimeStartWithInstructionsMessage("custom")).toMatchObject({
      role: "developer",
      content: [{ type: "text", text: expect.stringContaining("\ncustom\n") }],
    });
    expect(realtimeEndInstructionMessage("inactive")).toMatchObject({
      role: "developer",
      content: [{ type: "text", text: expect.stringContaining("Reason: inactive") }],
    });
  });

  test("matches realtime developer fragments by prefix across text part shapes", () => {
    expect(
      isContextualDeveloperMessageContent(
        `  ${REALTIME_CONVERSATION_OPEN_TAG}\nbody\n${REALTIME_CONVERSATION_CLOSE_TAG}`,
      ),
    ).toBe(true);
    expect(
      isContextualDeveloperMessageContent([
        {
          type: "input_text",
          text: `\n<REALTIME_CONVERSATION>\nbody\n</REALTIME_CONVERSATION>`,
        },
      ]),
    ).toBe(true);
    expect(
      isContextualDeveloperMessageContent([
        {
          type: "output_text",
          text: `\t${REALTIME_CONVERSATION_OPEN_TAG}\nbody`,
        },
      ]),
    ).toBe(true);
    expect(
      isContextualDeveloperMessageContent(
        `${REALTIME_CONVERSATION_OPEN_TAG}\nbody`,
      ),
    ).toBe(true);
    expect(
      isContextualDeveloperMessageContent([
        {
          type: "text",
          text: `${REALTIME_CONVERSATION_OPEN_TAG}\nbody\n${REALTIME_CONVERSATION_CLOSE_TAG} trailing`,
        },
      ]),
    ).toBe(true);
    expect(isContextualDeveloperMessageContent("ordinary developer text")).toBe(false);
  });
});
