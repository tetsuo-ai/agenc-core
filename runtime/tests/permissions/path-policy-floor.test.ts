import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { hasPermissionsToUseTool, type ToolEvaluatorContext } from "../../src/permissions/evaluator.js";
import { checkToolPathPermission, isPathAllowed, validatePath } from "../../src/permissions/path-validation.js";
import { createEmptyToolPermissionContext, type PermissionRuleSource, type ToolPermissionContext } from "../../src/permissions/types.js";
import { createFileWriteTool } from "../../src/tools/system/file-write.js";
import { createFileEditTool, createFileMultiEditTool } from "../../src/tools/system/file-edit.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import { createNotebookEditTool } from "../../src/tools/system/notebook-edit.js";
import { createApplyPatchTool } from "../../src/tools/apply-patch/tool.js";

// A permissive classifier must never be asked to waive a user review boundary.
vi.mock("../../src/permissions/classifier.js", async (original) => ({
  ...await original<typeof import("../../src/permissions/classifier.js")>(),
  classifyYoloAction: vi.fn(async () => ({ shouldBlock: false, reason: "safe", model: "test" })),
}));

const modes = ["default", "acceptEdits", "auto", "bypassPermissions"] as const;
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "path-policy-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function evaluator(context: ToolPermissionContext): ToolEvaluatorContext {
  return {
    getAppState: () => ({ toolPermissionContext: context, denialTracking: { consecutiveDenials: 0, totalDenials: 0 }, autoModeActive: context.mode === "auto" }),
    session: {},
    executionSurface: "cli",
  } as ToolEvaluatorContext;
}

const sensitive = [
  ".vscode/settings.json", ".idea/workspace.xml", ".bashrc", ".ZsHrC",
  ".VsCoDe/settings.json", "settings.json.", "settings.json ", "GIT~1/config",
  "settings.json.CON", ".git./config", ".agenc /config.toml", "CON", "NUL.txt", "COM1/log",
  "C:\\workspace\\.VsCoDe\\settings.json", "C:\\workspace\\GIT~1\\config",
] as const;

test.each(modes.flatMap((mode) => [...sensitive, "alias/settings.json"].map((relative) => ({ mode, relative }))))(
  "every file-tool family preserves $relative in $mode", async ({ mode, relative }) => {
    await mkdir(join(root, ".vscode"));
    await writeFile(join(root, ".vscode", "settings.json"), "{}");
    await symlink(join(root, ".vscode"), join(root, "alias"), "junction");
    const context = createEmptyToolPermissionContext({ mode });
    const tools = {
      write: createFileWriteTool({ allowedPaths: [root] }),
      edit: createFileEditTool({ allowedPaths: [root] }),
      multi: createFileMultiEditTool({ allowedPaths: [root] }),
      notebook: createNotebookEditTool({ workspaceRoot: root }),
      patch: createApplyPatchTool({ cwd: root, allowedPaths: [root] }),
    };
    const path = join(root, relative);
    const expected = { type: "safetyCheck", classifierApprovable: false };
    expect(validatePath(path, root, context, "write").decisionReason, relative).toMatchObject(expected);
    expect(isPathAllowed(path, context, "create", root).decisionReason, relative).toMatchObject(expected);
    const inputs = [
      [tools.write, { file_path: path, content: "{}", cwd: root }],
      [tools.edit, { file_path: path, old_string: "", new_string: "{}", cwd: root }],
      [tools.multi, { file_path: path, edits: [{ old_string: "", new_string: "{}" }], cwd: root }],
      [tools.notebook, { notebook_path: path, new_source: "", cwd: root }],
      [tools.patch, { input: `*** Begin Patch\n*** Add File: ${path}\n+{}\n*** End Patch` }],
    ] as const;
    for (const [tool, input] of inputs) {
      const result = await tool.checkPermissions!(input, evaluator(context));
      expect(result.behavior, `${tool.name}: ${relative}`).toBe("ask");
      expect(result.decisionReason, `${tool.name}: ${relative}`).toMatchObject(expected);
    }
});

test.each(modes)("identical relative rule text retains each source root in %s", async (mode) => {
  const home = join(root, "home");
  const project = join(root, "project");
  const cwd = join(project, "nested");
  await mkdir(home);
  await mkdir(cwd, { recursive: true });
  const store = new ConfigStore({ home, cwd, projectRoot: project });
  await store.reload();
  await runWithCanonicalSettingsAuthority(store, () => {
    const bases = { userSettings: home, projectSettings: project, localSettings: project, command: cwd, session: cwd };
    for (const behavior of ["deny", "ask", "allow"] as const) {
      const toolName = behavior === "allow" ? "Write" : "FileRead";
      const bucket = Object.fromEntries(Object.keys(bases).map((source) => [source, [`${toolName}(./src/**)`]]));
      const context = createEmptyToolPermissionContext({
        mode,
        [behavior === "deny" ? "alwaysDenyRules" : behavior === "ask" ? "alwaysAskRules" : "alwaysAllowRules"]: bucket,
      });
      for (const [source, base] of Object.entries(bases)) {
        const path = join(base, "src", "app.ts");
        const result = checkToolPathPermission({ toolName, input: { file_path: path }, path, cwd, context, operationType: behavior === "allow" ? "write" : "read" });
        expect(result.behavior, `${behavior}: ${source}`).toBe(behavior);
        if (behavior !== "allow" || mode !== "acceptEdits" || base !== cwd) {
          expect(result.decisionReason?.type, `${behavior}: ${source}`).toBe("rule");
        }
      }
    }
  });
});

test.each(modes)("retired commands keep narrow exceptions through file permissions in %s", async (mode) => {
  const context = createEmptyToolPermissionContext({ mode });
  const tool = createFileWriteTool({ allowedPaths: [root] });
  for (const target of [".agenc/commands/review.md", ".agents/commands/review.md", ".AgEnTs/CoMmAnDs/review.md"]) {
    const path = join(root, target);
    expect(validatePath(path, root, context, "write").decisionReason?.type).not.toBe("safetyCheck");
    const result = await hasPermissionsToUseTool(tool, { file_path: path, content: "ordinary", cwd: root }, evaluator(context));
    expect(result.behavior, target).toBe(mode === "default" ? "ask" : "allow");
  }

  const skills = join(root, ".agents", "skills", "review");
  const commands = join(root, ".agents", "commands");
  await mkdir(skills, { recursive: true });
  await mkdir(commands);
  await symlink(skills, join(commands, "linked"), "junction");
  for (const target of [
    ".agents/skills/review/SKILL.md",
    ".agenc/skills/review/SKILL.md",
    ".agents/commands/.agents/skills/review/SKILL.md",
    ".agents/commands/linked/SKILL.md",
  ]) {
    const result = await hasPermissionsToUseTool(tool, { file_path: join(root, target), content: "protected", cwd: root }, evaluator(context));
    expect(result.behavior, target).toBe("ask");
    expect(result.decisionReason, target).toMatchObject({ type: "safetyCheck", classifierApprovable: false });
  }
});

test.each(modes)("ask and deny retain precedence at real read/write entry points in %s", async (mode) => {
  const path = join(root, "src", "app.ts");
  for (const source of ["userSettings", "policySettings"] as const satisfies readonly PermissionRuleSource[]) {
    for (const pattern of [path, join(root, "src", "**")]) {
      for (const operationType of ["read", "write"] as const) {
        const toolName = operationType === "read" ? "FileRead" : "Write";
        for (const deny of [false, true]) {
          const context = createEmptyToolPermissionContext({ mode,
            alwaysAskRules: { [source]: [`${toolName}(${pattern})`] },
            alwaysAllowRules: { session: [`${toolName}(${pattern})`] },
            ...(deny ? { alwaysDenyRules: { session: [`${toolName}(${pattern})`] } } : {}),
          });
          for (const result of [validatePath(path, root, context, operationType), isPathAllowed(path, context, operationType, root)]) {
            expect(result.allowed).toBe(false);
            expect(result.decisionReason).toMatchObject({ type: "rule", rule: { ruleBehavior: deny ? "deny" : "ask" } });
          }
          const tool = operationType === "read" ? createFileReadTool({ allowedPaths: [root] }) : createFileWriteTool({ allowedPaths: [root] });
          const result = await hasPermissionsToUseTool(tool, { file_path: path, content: "hello", cwd: root }, evaluator(context));
          expect(result.behavior, `${source}: ${operationType}: ${pattern}`).toBe(deny ? "deny" : "ask");
        }
      }
    }
  }
});

test("auto mode cannot approve IDE or shell control writes", async () => {
  const context = createEmptyToolPermissionContext({ mode: "auto" });
  const tool = createFileWriteTool({ allowedPaths: [root] });
  for (const target of [".vscode/settings.json", ".idea/workspace.xml", ".bashrc"]) {
    const result = await hasPermissionsToUseTool(tool, { file_path: join(root, target), content: "{}", cwd: root }, evaluator(context));
    expect(result.behavior).toBe("ask");
    expect(result.decisionReason).toMatchObject({ type: "safetyCheck", classifierApprovable: false });
  }
});

test("bypass only lifts working-directory prompts, never malformed path safety", () => {
  const context = createEmptyToolPermissionContext({ mode: "bypassPermissions" });
  for (const path of ["\\\\server\\share\\file", "~someone/file", "${CONFIG}/file", "*.json"]) {
    const result = checkToolPathPermission({ toolName: "Write", input: { file_path: path }, path, cwd: root, context, operationType: "write" });
    expect(result.behavior, path).not.toBe("allow");
    expect(result.decisionReason?.type, path).toBe("safetyCheck");
  }
});
