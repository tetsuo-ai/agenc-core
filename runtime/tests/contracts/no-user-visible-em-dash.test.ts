import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const emDash = String.fromCodePoint(0x2014);

// Reviewed display surfaces. Traverse these directories so new CLI, slash
// command, onboarding and TUI modules are covered as well as existing ones.
const displayDirectories = [
  "runtime/src/bin", "runtime/src/cli", "runtime/src/commands",
  "runtime/src/onboarding", "runtime/src/tui",
  "packages/agenc/src", "packages/agenc-sdk/src",
];
// Other modules that supply errors, diagnostics, protocol docs or tool output.
const displayModules = [
  "runtime/src/agents/control.ts",
  "runtime/src/app-server/daemon-autostart.ts",
  "runtime/src/browser/executable.ts",
  "runtime/src/browser/page.ts",
  "runtime/src/browser/ssrf.ts",
  "runtime/src/constants/figures.ts",
  "runtime/src/entrypoints/sdk/coreSchemas.ts",
  "runtime/src/llm/providers/grok/adapter.ts",
  "runtime/src/llm/providers/ollama/adapter.ts",
  "runtime/src/mcp-client/resilient-client.ts",
  "runtime/src/mcp-client/tools.ts",
  "runtime/src/permissions/evaluator.ts",
  "runtime/src/phases/commit.ts",
  "runtime/src/phases/stop-hooks.ts",
  "runtime/src/services/autoDream/autoDream.ts",
  "runtime/src/services/autoDream/consolidationLock.ts",
  "runtime/src/services/mcp/auth.ts",
  "runtime/src/services/mcp/client.ts",
  "runtime/src/services/mcp/xaaIdpLogin.ts",
  "runtime/src/session/file-history.ts",
  "runtime/src/session/recovery-tool-result.ts",
  "runtime/src/session/rollout-reconstruction.ts",
  "runtime/src/session/session-store.ts",
  "runtime/src/skills/mcpSkillBuilders.ts",
  "runtime/src/tools/AgentTool/AgentTool.tsx",
  "runtime/src/tools/BashTool/BashTool.tsx",
  "runtime/src/tools/BashTool/bashPermissions.ts",
  "runtime/src/tools/BrowserTool/tool.ts",
  "runtime/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts",
  "runtime/src/tools/ExitWorktreeTool/ExitWorktreeTool.ts",
  "runtime/src/tools/PowerShellTool/PowerShellTool.tsx",
  "runtime/src/tools/PowerShellTool/modeValidation.ts",
  "runtime/src/tools/PowerShellTool/pathValidation.ts",
  "runtime/src/tools/PowerShellTool/powershellPermissions.ts",
  "runtime/src/tools/ScheduleCronTool/CronListTool.ts",
  "runtime/src/tools/SendMessageTool/SendMessageTool.ts",
  "runtime/src/tools/WebSearchTool/WebSearchTool.ts",
  "runtime/src/tools/WebSearchTool/providers/duckduckgo.ts",
  "runtime/src/tools/execution.ts",
  "runtime/src/tools/schema-errors.ts",
  "runtime/src/tools/streaming-executor.ts",
  "runtime/src/tools/system/file-edit.ts",
  "runtime/src/tools/system/orient.ts",
  "runtime/src/tools/system/worktree.ts",
  "runtime/src/utils/bash/ast.ts",
  "runtime/src/utils/cronScheduler.ts",
  "runtime/src/utils/fastMode.ts",
  "runtime/src/utils/hooks.ts",
  "runtime/src/utils/messages.ts",
  "runtime/src/utils/permissions/permissions.ts",
  "runtime/src/workflow/independent-review.ts",
];

// Mixed modules also contain model instructions or input syntax. Exempt the
// named declaration, never a whole line or a particular em-dash-bearing string.
const nonDisplayDeclarations: Record<string, readonly string[]> = {
  "runtime/src/onboarding/acts/identity.ts": ["BOOTSTRAP_TEMPLATE"],
  "runtime/src/tools/AgentTool/AgentTool.tsx": ["instructions"],
  "runtime/src/tools/system/worktree.ts": ["ENTER_WORKTREE_PROMPT", "EXIT_WORKTREE_PROMPT"],
  "runtime/src/tools/system/file-edit.ts": ["isOpeningQuoteContext"],
  "runtime/src/workflow/independent-review.ts": ["buildReviewerMessages"],
  "runtime/src/utils/messages.ts": [
    "MEMORY_CORRECTION_HINT", "PLAN_PHASE4_CONTROL", "PLAN_PHASE4_CAP",
    "getPlanModeV2Instructions", "getPlanModeInterviewInstructions",
    "getAutoModeFullInstructions", "normalizeOutputTokenUsageAttachment",
    "normalizeDeferredToolsDeltaAttachment", "normalizePlanModeReentryAttachment",
    "wrapCommandText",
  ],
};

function sourceFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]sx?$/.test(path) ? [path] : [];
  });
}

function findDisplayEmDashes(path: string, source: string): number[] {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  function visit(node: ts.Node): void {
    const name = "name" in node ? (node as ts.NamedDeclaration).name?.getText(ast) : undefined;
    if (name && nonDisplayDeclarations[path]?.includes(name)) return;
    // Tool descriptions and prompts are a separate editorial decision.
    if (path.includes("/tools/") && (name === "description" || name === "prompt")) return;
    if (path.includes("/tools/") && ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "describe") return;
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) ||
         ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) &&
        node.text.includes(emDash)) {
      lines.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return lines;
}

it("keeps user-visible source strings free of em dashes", () => {
  // Check the guard's boundary without importing or executing product modules.
  const fixturePath = "runtime/src/tools/system/worktree.ts";
  expect(findDisplayEmDashes(fixturePath,
    `// comment ${emDash}\nconst ENTER_WORKTREE_PROMPT = "model ${emDash}";\nconst tool = { description: "tool ${emDash}" };`,
  )).toEqual([]);
  expect(findDisplayEmDashes("display.tsx",
    `const label = "visible ${emDash}";\nconst escaped = "\\u2014";\nconst view = <Text>visible ${emDash}</Text>;`,
  )).toEqual([1, 2, 3]);

  const files = new Set([...displayModules, ...displayDirectories.flatMap(sourceFiles)]);
  const violations: string[] = [];
  for (const path of [...files].sort()) {
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /\/(prompts?)(\/|\.)/.test(path)) continue;
    // Captured transcript markers mirror upstream data; they are not UI copy.
    if (path === "runtime/src/tui/components/v2/designBrowserTextFixture.ts") continue;
    for (const line of findDisplayEmDashes(path, readFileSync(resolve(root, path), "utf8"))) {
      violations.push(`${relative(root, resolve(root, path))}:${line}`);
    }
  }
  expect(violations, "Use plain punctuation in user-visible strings").toEqual([]);
});
