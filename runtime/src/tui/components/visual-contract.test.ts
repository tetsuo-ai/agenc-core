import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentsRoot = fileURLToPath(new URL(".", import.meta.url));
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
    ];

    expect(
      retiredPaths.filter((rel) => existsSync(join(tuiRoot, rel))),
    ).toEqual([]);
  });

  it("keeps old message and permissions component trees empty", () => {
    const permissionsRoot = join(componentsRoot, "permissions");
    const messagesRoot = join(componentsRoot, "messages");

    expect(listSourceFiles(permissionsRoot)).toEqual([]);
    expect(listSourceFiles(messagesRoot)).toEqual([]);
  });
});
