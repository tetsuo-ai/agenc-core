import { describe, expect, test, vi } from "vitest";

import { GroupedToolUseContent } from "./GroupedToolUseContent.js";

function toolUseMessage(id: string) {
  return {
    message: {
      content: [
        {
          id,
          input: { prompt: id },
          name: "Agent",
          type: "tool_use",
        },
      ],
    },
  };
}

function resultMessage(toolUseId: string, output: unknown) {
  return {
    message: {
      content: [
        { text: "ignored", type: "text" },
        {
          content: "ok",
          tool_use_id: toolUseId,
          type: "tool_result",
        },
      ],
    },
    toolUseResult: output,
  };
}

function lookups(overrides: Record<string, unknown> = {}) {
  return {
    erroredToolUseIDs: new Set<string>(),
    progressMessagesByToolUseID: new Map<string, unknown[]>(),
    resolvedToolUseIDs: new Set<string>(),
    ...overrides,
  } as never;
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    messages: [toolUseMessage("tool-1")],
    results: [],
    toolName: "Agent",
    ...overrides,
  } as never;
}

describe("GroupedToolUseContent", () => {
  test("returns null when the tool cannot render grouped tool uses", () => {
    expect(
      GroupedToolUseContent({
        inProgressToolUseIDs: new Set(),
        lookups: lookups(),
        message: message(),
        shouldAnimate: true,
        tools: [],
      }),
    ).toBeNull();

    expect(
      GroupedToolUseContent({
        inProgressToolUseIDs: new Set(),
        lookups: lookups(),
        message: message(),
        shouldAnimate: true,
        tools: [{ name: "Agent" }] as never,
      }),
    ).toBeNull();
  });

  test("passes grouped tool use data with result, progress, and status flags", () => {
    const renderGroupedToolUse = vi.fn(() => "grouped");
    const progressMessage = { data: { type: "agent_progress" } };
    const hookProgressMessage = { data: { type: "hook_progress" } };
    const output = { ok: true };

    const rendered = GroupedToolUseContent({
      inProgressToolUseIDs: new Set(["tool-2"]),
      lookups: lookups({
        erroredToolUseIDs: new Set(["tool-2"]),
        progressMessagesByToolUseID: new Map([
          ["tool-1", [progressMessage, hookProgressMessage]],
        ]),
        resolvedToolUseIDs: new Set(["tool-1"]),
      }),
      message: message({
        messages: [toolUseMessage("tool-1"), toolUseMessage("tool-2")],
        results: [resultMessage("tool-1", output)],
      }),
      shouldAnimate: true,
      tools: [{ name: "Agent", renderGroupedToolUse }] as never,
    });

    expect(rendered).toBe("grouped");
    expect(renderGroupedToolUse).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          isError: false,
          isInProgress: false,
          isResolved: true,
          progressMessages: [progressMessage],
          result: expect.objectContaining({ output }),
        }),
        expect.objectContaining({
          isError: true,
          isInProgress: true,
          isResolved: false,
          progressMessages: [],
          result: undefined,
        }),
      ],
      {
        shouldAnimate: true,
        tools: [{ name: "Agent", renderGroupedToolUse }],
      },
    );
  });

  test("disables animation when requested or when no grouped tool use is in progress", () => {
    const renderWithoutRequestedAnimation = vi.fn(() => "not-animated");
    GroupedToolUseContent({
      inProgressToolUseIDs: new Set(["tool-1"]),
      lookups: lookups(),
      message: message(),
      shouldAnimate: false,
      tools: [
        {
          name: "Agent",
          renderGroupedToolUse: renderWithoutRequestedAnimation,
        },
      ] as never,
    });

    expect(renderWithoutRequestedAnimation.mock.calls[0]?.[1]).toMatchObject({
      shouldAnimate: false,
    });

    const renderWithoutProgress = vi.fn(() => "not-animated");
    GroupedToolUseContent({
      inProgressToolUseIDs: new Set(),
      lookups: lookups(),
      message: message(),
      shouldAnimate: true,
      tools: [
        {
          name: "Agent",
          renderGroupedToolUse: renderWithoutProgress,
        },
      ] as never,
    });

    expect(renderWithoutProgress.mock.calls[0]?.[1]).toMatchObject({
      shouldAnimate: false,
    });
  });
});
