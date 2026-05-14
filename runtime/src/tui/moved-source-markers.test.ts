import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const files = [
  "runtime/src/tui/ink.ts",
  "runtime/src/tui/ink/ink.tsx",
  "runtime/src/tui/ink/render-node-to-output.ts",
  "runtime/src/tui/context/overlayContext.tsx",
  "runtime/src/tui/context/promptOverlayContext.tsx",
  "runtime/src/tui/context/modalContext.tsx",
  "runtime/src/tui/components/tasks/BackgroundTaskStatus.tsx",
  "runtime/src/tui/components/AutoModeOptInDialog.tsx",
  "runtime/src/tui/components/AutoUpdaterWrapper.tsx",
  "runtime/src/tui/components/CustomSelect/select.tsx",
  "runtime/src/tui/components/DesktopUpsell/DesktopUpsellStartup.tsx",
  "runtime/src/tui/components/IdeOnboardingDialog.tsx",
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
});
