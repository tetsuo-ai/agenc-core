import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sourceUrl } from "../../helpers/source-path.ts";

const componentsRoot = fileURLToPath(sourceUrl("tui/components/"));
const tuiRoot = join(componentsRoot, "..");

function listSourceFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    if (
      !/\.(?:[jt]sx?|mjs)$/u.test(entry.name) ||
      /\.d\.ts$/u.test(entry.name) ||
      /\.test\.[jt]sx?$/u.test(entry.name)
    ) {
      return [];
    }
    return [fullPath];
  });
}

describe("TUI visual contract", () => {
  it("keeps component chrome terminal-renderable and theme-tokenized", () => {
    const scannedRoots = [
      componentsRoot,
      join(tuiRoot, "message-renderers"),
    ];
    const violations = scannedRoots.flatMap((root) => listSourceFiles(root)).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const rel = relative(process.cwd(), file);
      const checks = [
        [/borderStyle[^\n]*["']round["']/u, "round border"],
        [/["'`]#[0-9a-fA-F]{3,8}\b/u, "inline hex color"],
        [/\brgba\s*\(/u, "inline rgba color"],
        [/\b(?:linear|radial)-gradient\s*\(/u, "gradient"],
        [/\bboxShadow\b/u, "box shadow"],
        [/\bbackdropFilter\b/u, "backdrop blur"],
        [/\bborderRadius\b/u, "rounded corner"],
        [/\buseAnimationFrame\b/u, "timer-driven visual animation"],
        [/\buseBlink\b/u, "non-caret blink animation"],
      ] as const;

      return checks.flatMap(([pattern, label]) =>
        pattern.test(source) ? [`${rel}: ${label}`] : [],
      );
    });

    expect(violations).toEqual([]);
  });

  it("keeps retired v1 permission and task surfaces deleted", () => {
    const retiredPaths = [
      "permission-routing.tsx",
      "components/tasks/BackgroundTasksDialog.tsx",
      "components/tasks/BackgroundTasksDialog.test.tsx",
      "components/permissions/PermissionRequest.tsx",
      "components/permissions/PermissionDialog.tsx",
      "components/permissions/PermissionPrompt.tsx",
      "components/permissions/BashPermissionRequest/BashPermissionRequest.tsx",
      "components/permissions/FileEditPermissionRequest/FileEditPermissionRequest.tsx",
      "components/permissions/FileWritePermissionRequest/FileWritePermissionRequest.tsx",
      "components/permissions/FilesystemPermissionRequest/FilesystemPermissionRequest.tsx",
      "components/permissions/PowerShellPermissionRequest/PowerShellPermissionRequest.tsx",
      "components/permissions/SkillPermissionRequest/SkillPermissionRequest.tsx",
      "components/permissions/WebFetchPermissionRequest/WebFetchPermissionRequest.tsx",
      "components/permissions/FilePermissionDialog/permissionOptions.tsx",
      "components/permissions/rules/PermissionRuleList.tsx",
      "components/permissions/rules/AddPermissionRules.tsx",
      "components/permissions/rules/AddWorkspaceDirectory.tsx",
      "components/permissions/ComputerUseApproval/ComputerUseApproval.tsx",
      "components/permissions/ComputerUseApproval/computerUseGlyphs.ts",
      "components/Settings/Settings.tsx",
      "components/Settings/Config.tsx",
      "components/skills/SkillsMenu.tsx",
      "components/agents/AgentsMenu.tsx",
      "components/agents/AgentsList.tsx",
      "components/agents/AgentEditor.tsx",
      "components/agents/AgentDetail.tsx",
      "components/agents/ToolSelector.tsx",
      "components/hooks/HooksConfigMenu.tsx",
      "components/hooks/SelectEventMode.tsx",
      "components/hooks/SelectHookMode.tsx",
      "components/hooks/SelectMatcherMode.tsx",
      "components/hooks/ViewHookMode.tsx",
      "components/mcp/MCPToolListView.tsx",
      "components/mcp/MCPToolDetailView.tsx",
      "components/diff/DiffDialog.tsx",
      "components/tasks/AsyncAgentDetailDialog.tsx",
      "components/tasks/ShellDetailDialog.tsx",
      "components/tasks/InProcessTeammateDetailDialog.tsx",
      "components/ExportDialog.tsx",
    ];

    expect(
      retiredPaths.filter((rel) => existsSync(join(tuiRoot, rel))),
    ).toEqual([]);
  });

  it("pins the highlighted YOU message box to full width like its sibling renderers", () => {
    // BUG C regression: the YOU prompt highlight Box sets backgroundColor +
    // paddingRight but, UNLIKE SystemTextMessage/AssistantTextMessage, used to
    // omit width="100%". When a body/queued line word-wraps at exactly the
    // content-width boundary, that full-width wrap row rendered one column wider
    // than its siblings with no trailing bg pad, so the bg reset spilled onto the
    // next line's column 0 and the purple highlight rectangle got a ragged right
    // edge. Pinning width="100%" makes every wrapped row pad/clip to the same
    // right edge. This invariant asserts the user box mirrors its siblings.
    const messageRenderers = join(tuiRoot, "message-renderers");
    const userSource = readFileSync(
      join(messageRenderers, "UserPromptMessage.tsx"),
      "utf8",
    );

    // The single Box that paints the user-message highlight (it is the only line
    // carrying both the userMessageBackground token and paddingRight).
    const highlightBoxLine = userSource
      .split("\n")
      .find(
        (line) =>
          line.includes("userMessageBackground") && line.includes("paddingRight"),
      );

    expect(highlightBoxLine).toBeDefined();
    // Revert-sensitivity: removing width="100%" from that Box drops this match
    // and fails the assertion. The sibling renderers below confirm the pattern
    // this mirrors.
    expect(highlightBoxLine).toContain('width="100%"');

    // Sibling renderers pair backgroundColor with width="100%" on their text
    // boxes; assert the pattern the user box is mirroring actually exists so this
    // invariant cannot silently drift if the siblings change.
    const assistantSource = readFileSync(
      join(messageRenderers, "AssistantTextMessage.tsx"),
      "utf8",
    );
    const systemSource = readFileSync(
      join(messageRenderers, "SystemTextMessage.tsx"),
      "utf8",
    );
    // AssistantTextMessage's default markdown box: backgroundColor + width="100%".
    expect(assistantSource).toMatch(/width="100%"[^\n]*backgroundColor/u);
    // SystemTextMessage's text boxes: backgroundColor + width="100%".
    expect(systemSource).toMatch(/backgroundColor=\{bg\}[^\n]*width="100%"/u);
  });

  it("keeps old message and permissions component trees empty", () => {
    const permissionsRoot = join(componentsRoot, "permissions");
    const messagesRoot = join(componentsRoot, "messages");

    expect(listSourceFiles(permissionsRoot)).toEqual([]);
    expect(listSourceFiles(messagesRoot)).toEqual([]);
  });
});
