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
  "runtime/src/tui/components/Settings/Settings.tsx",
  "runtime/src/tui/components/HelpV2/HelpV2.tsx",
  "runtime/src/tui/components/tasks/BackgroundTaskStatus.tsx",
  "runtime/src/tui/components/AutoModeOptInDialog.tsx",
  "runtime/src/tui/components/AutoUpdaterWrapper.tsx",
  "runtime/src/tui/components/CustomSelect/select.tsx",
  "runtime/src/tui/components/DesktopUpsell/DesktopUpsellStartup.tsx",
  "runtime/src/tui/components/IdeOnboardingDialog.tsx",
  "runtime/src/tui/components/IdleReturnDialog.tsx",
  "runtime/src/tui/components/spinner/Spinner.tsx",
  "runtime/src/tui/components/teams/TeamStatus.tsx",
  "runtime/src/tui/components/teams/TeamsDialog.tsx",
  "runtime/src/tui/components/permissions/PermissionRequest.tsx",
  "runtime/src/tui/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx",
  "runtime/src/tui/components/permissions/FilesystemPermissionRequest/FilesystemPermissionRequest.tsx",
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

  test("owned live TUI files do not keep donor import or analytics residue", () => {
    for (const file of [
      "runtime/src/tui/components/AutoModeOptInDialog.tsx",
      "runtime/src/tui/components/DesktopUpsell/DesktopUpsellStartup.tsx",
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

  test("settings and help surfaces do not keep moved-source or donor telemetry residue", () => {
    for (const file of [
      "runtime/src/tui/components/Settings/Settings.tsx",
      "runtime/src/tui/components/Settings/Config.tsx",
      "runtime/src/tui/components/HelpV2/HelpV2.tsx",
    ]) {
      const source = readFileSync(`${repoRoot}${file}`, "utf8");

      expect(source).not.toContain("@ts-nocheck");
      expect(source).not.toContain("Moved-source note");
      expect(source).not.toContain("tengu_");
      expect(source).not.toContain("key: 'env.ANTHROPIC_API_KEY'");
    }
  });

  test("agent management surfaces do not keep moved-source or upstream-import residue", () => {
    for (const file of [
      "runtime/src/tui/components/agents/AgentsMenu.tsx",
      "runtime/src/tui/components/agents/AgentEditor.tsx",
      "runtime/src/tui/components/agents/AgentDetail.tsx",
      "runtime/src/tui/components/agents/ToolSelector.tsx",
      "runtime/src/tui/components/agents/ModelSelector.tsx",
      "runtime/src/tui/components/agents/ColorPicker.tsx",
    ]) {
      const source = readFileSync(`${repoRoot}${file}`, "utf8");

      expect(source).not.toContain("@ts-nocheck");
      expect(source).not.toContain("Moved-source note");
      expect(source).not.toContain("upstream-import");
    }
  });

  test("owned message renderers do not import provider SDK block types directly", () => {
    for (const file of [
      "runtime/src/tui/components/Message.tsx",
      "runtime/src/tui/components/messages/AssistantTextMessage.tsx",
      "runtime/src/tui/components/messages/AssistantThinkingMessage.tsx",
      "runtime/src/tui/components/messages/AssistantToolUseMessage.tsx",
      "runtime/src/tui/components/messages/GroupedToolUseContent.tsx",
      "runtime/src/tui/components/messages/UserAgentNotificationMessage.tsx",
      "runtime/src/tui/components/messages/UserBashInputMessage.tsx",
      "runtime/src/tui/components/messages/UserChannelMessage.tsx",
      "runtime/src/tui/components/messages/UserCommandMessage.tsx",
      "runtime/src/tui/components/messages/UserPromptMessage.tsx",
      "runtime/src/tui/components/messages/UserResourceUpdateMessage.tsx",
      "runtime/src/tui/components/messages/UserTeammateMessage.tsx",
      "runtime/src/tui/components/messages/UserTextMessage.tsx",
      "runtime/src/tui/components/messages/UserToolResultMessage/UserToolErrorMessage.tsx",
      "runtime/src/tui/components/messages/UserToolResultMessage/UserToolResultMessage.tsx",
      "runtime/src/tui/components/messages/UserToolResultMessage/utils.tsx",
      "runtime/src/utils/groupToolUses.ts",
    ]) {
      const source = readFileSync(`${repoRoot}${file}`, "utf8");

      expect(source).not.toContain("@anthropic-ai/sdk");
    }
  });
});
