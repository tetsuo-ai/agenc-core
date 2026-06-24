import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import Text from "../../ink/components/Text.js";
import { renderToString } from "../../../utils/staticRender.js";
import { usePromptInputPlaceholder } from "./usePromptInputPlaceholder.js";

const mocks = vi.hoisted(() => ({
  config: {} as { queuedCommandUpHintCount?: number },
  exampleCommand: "/example",
  features: {} as Record<string, boolean>,
  proactiveActive: false,
  promptSuggestionEnabled: false,
  queuedCommands: [] as Array<Record<string, unknown>>,
}));

vi.mock("bun:bundle", () => ({
  feature: (name: string) => mocks.features[name] === true,
}));

vi.mock("../../hooks/useCommandQueue.js", () => ({
  useCommandQueue: () => mocks.queuedCommands,
}));

vi.mock("../../state/AppState.js", () => ({
  useAppState: (
    selector: (state: { promptSuggestionEnabled: boolean }) => unknown,
  ) =>
    selector({
      promptSuggestionEnabled: mocks.promptSuggestionEnabled,
    }),
}));

vi.mock("../../../utils/config.js", () => ({
  getGlobalConfig: () => mocks.config,
}));

vi.mock("../../../utils/exampleCommands.js", () => ({
  getExampleCommandFromCache: () => mocks.exampleCommand,
}));

vi.mock("../../../utils/messageQueueManager.js", () => ({
  isQueuedCommandEditable: (command: { editable?: boolean }) =>
    command.editable !== false,
}));

vi.mock("./proactiveAdapter.js", () => ({
  isPromptInputProactiveActive: () => mocks.proactiveActive,
}));

function PlaceholderProbe({
  input = "",
  submitCount = 0,
  viewingAgentName,
}: {
  input?: string;
  submitCount?: number;
  viewingAgentName?: string;
}) {
  const placeholder = usePromptInputPlaceholder({
    input,
    submitCount,
    viewingAgentName,
  });

  return <Text>{placeholder ?? "none"}</Text>;
}

async function renderPlaceholder(
  props: React.ComponentProps<typeof PlaceholderProbe> = {},
) {
  return renderToString(<PlaceholderProbe {...props} />, 120);
}

describe("usePromptInputPlaceholder", () => {
  beforeEach(() => {
    mocks.config = {};
    mocks.exampleCommand = "/example";
    mocks.features = {};
    mocks.proactiveActive = false;
    mocks.promptSuggestionEnabled = false;
    mocks.queuedCommands = [];
  });

  test("does not show a placeholder while input is non-empty", async () => {
    await expect(renderPlaceholder({ input: "hello" })).resolves.toContain(
      "none",
    );
  });

  test("prompts for the viewed teammate using a bounded display name", async () => {
    await expect(
      renderPlaceholder({ viewingAgentName: "Scout" }),
    ).resolves.toContain("Message @Scout…");

    await expect(
      renderPlaceholder({
        viewingAgentName: "abcdefghijklmnopqrstuvwxyz",
      }),
    ).resolves.toContain("Message @abcdefghijklmnopq...…");
  });

  test("shows the queued-message edit hint for editable queued commands", async () => {
    mocks.queuedCommands = [{ editable: false }, { editable: true }];

    await expect(renderPlaceholder()).resolves.toContain(
      "Press up to edit queued messages",
    );
  });

  test("falls back to the cold-start hint after the queued-message hint is exhausted", async () => {
    mocks.config.queuedCommandUpHintCount = 3;
    mocks.queuedCommands = [{ editable: true }];

    // No queue/example hint applies, so the composer shows the stable
    // cold-start guidance rather than sitting blank at rest.
    await expect(renderPlaceholder()).resolves.toContain(
      "Describe a task",
    );
  });

  test("shows an example command before the first submit when suggestions are enabled", async () => {
    mocks.promptSuggestionEnabled = true;
    mocks.exampleCommand = "/review";

    await expect(renderPlaceholder()).resolves.toContain("/review");
  });

  test("does not show example commands after submit or when suggestions are disabled", async () => {
    mocks.promptSuggestionEnabled = true;

    await expect(renderPlaceholder({ submitCount: 1 })).resolves.toContain(
      "none",
    );

    // Suggestions disabled at cold start: no example command, but the composer
    // still surfaces the stable cold-start hint instead of a blank line.
    mocks.promptSuggestionEnabled = false;
    await expect(renderPlaceholder()).resolves.toContain(
      "Describe a task",
    );
  });

  test("shows the cold-start hint when no other hint applies, and only before the first submit", async () => {
    // Default cold start: suggestions disabled, no queue, no teammate.
    const coldStart = await renderPlaceholder();
    expect(coldStart).toContain("Describe a task");
    // The placeholder stays minimal: the `/` and `@` affordances are taught on
    // the cold-start welcome card (on screen at this same moment), so the
    // composer no longer restates them — that triplicated one idea across three
    // adjacent rows. Revert-sensitive: re-adding the hints here fails these.
    expect(coldStart).not.toContain("/ for commands");
    expect(coldStart).not.toContain("@ to attach");

    // The hint is a cold-start affordance only — it disappears once the user
    // has started the conversation.
    await expect(renderPlaceholder({ submitCount: 1 })).resolves.toContain(
      "none",
    );

    // And it never competes with a non-empty input.
    await expect(
      renderPlaceholder({ input: "x" }),
    ).resolves.toContain("none");
  });

  test("suppresses examples when proactive mode is active", async () => {
    mocks.promptSuggestionEnabled = true;
    mocks.features.PROACTIVE = true;
    mocks.proactiveActive = true;

    await expect(renderPlaceholder()).resolves.toContain("none");

    mocks.features = { KAIROS: true };
    await expect(renderPlaceholder()).resolves.toContain("none");
  });
});
