import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const files = [
  "runtime/src/tui/ink.ts",
  "runtime/src/tui/ink/ink.tsx",
  "runtime/src/tui/ink/render-node-to-output.ts",
  "runtime/src/tui/context/overlayContext.tsx",
  "runtime/src/tui/context/promptOverlayContext.tsx",
  "runtime/src/tui/context/modalContext.tsx",
  "runtime/src/tui/components/ScrollKeybindingHandler.tsx",
  "runtime/src/tui/components/SearchBox.tsx",
  "runtime/src/tui/components/HelpV2/HelpV2.tsx",
  "runtime/src/tui/components/tasks/BackgroundTaskStatus.tsx",
  "runtime/src/tui/components/AutoModeOptInDialog.tsx",
  "runtime/src/tui/components/AutoUpdaterWrapper.tsx",
  "runtime/src/tui/components/CustomSelect/select.tsx",
  "runtime/src/tui/components/IdeOnboardingDialog.tsx",
  "runtime/src/tui/components/design-system/Dialog.tsx",
  "runtime/src/tui/components/spinner/Spinner.tsx",
  "runtime/src/tui/components/teams/TeamStatus.tsx",
  "runtime/src/tui/components/teams/TeamsDialog.tsx",
];

const repoRoot = new URL("../../../", import.meta.url).pathname;

describe("moved-source marker cleanup", () => {
  test("audited live TUI render files start with real source", () => {
    for (const file of files) {
      const firstLines = readFileSync(`${repoRoot}${file}`, "utf8")
        .split(/\r?\n/)
        .slice(0, 2)
        .join("\n");

      expect(firstLines).not.toContain("@ts-nocheck");
      expect(firstLines).not.toContain("Moved-source note");
    }
  });

  test("owned live TUI files do not keep donor import or obsolete runtime residue", () => {
    for (const file of [
      "runtime/src/tui/components/AutoModeOptInDialog.tsx",
      "runtime/src/tui/components/IdeOnboardingDialog.tsx",
    ]) {
      const source = readFileSync(`${repoRoot}${file}`, "utf8");

      expect(source).not.toContain("@ts-nocheck");
      expect(source).not.toContain("Moved-source note");
      expect(source).not.toContain("upstream-import");
      expect(source).not.toContain("tengu_");
      expect(source).not.toContain("•");
    }
  });

  test("design-system dialog does not keep moved-source or upstream-import residue", () => {
    const source = readFileSync(
      `${repoRoot}runtime/src/tui/components/design-system/Dialog.tsx`,
      "utf8",
    );

    expect(source).not.toContain("@ts-nocheck");
    expect(source).not.toContain("Moved-source note");
    expect(source).not.toContain("upstream-import");
  });

  test("owned message renderers do not keep donor import markers or provider SDK block types", () => {
    for (const file of [
      "runtime/src/tui/components/Message.tsx",
      "runtime/src/tui/message-renderers/AssistantTextMessage.tsx",
      "runtime/src/tui/message-renderers/AssistantToolUseMessage.tsx",
      "runtime/src/tui/message-renderers/GroupedToolUseContent.tsx",
      "runtime/src/tui/components/v2/messagePrimitives.tsx",
      "runtime/src/tui/message-renderers/UserPromptMessage.tsx",
      "runtime/src/tui/message-renderers/UserTeammateMessage.tsx",
      "runtime/src/tui/message-renderers/UserTextMessage.tsx",
      "runtime/src/tui/message-renderers/UserToolResultMessage/UserToolErrorMessage.tsx",
      "runtime/src/tui/message-renderers/UserToolResultMessage/UserToolResultMessage.tsx",
      "runtime/src/tui/message-renderers/UserToolResultMessage/utils.tsx",
      "runtime/src/utils/groupToolUses.ts",
    ]) {
      const source = readFileSync(`${repoRoot}${file}`, "utf8");

      expect(source).not.toContain("upstream-import");
      expect(source).not.toContain("@anthropic-ai/sdk");
    }
  });
});
