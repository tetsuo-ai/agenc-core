/**
 * What a built-in (bundled) skill's `allowed-tools` may pre-approve.
 *
 * A skill the user invokes by name runs its turn with its `allowed-tools`
 * as allow rules. Built-in skills ship inside AgenC, so their declarations
 * get the same treatment as a user's, except that none may pre-approve a
 * shell or process tool: the shell commands of a built-in skill's turn ask
 * like any other turn's. User and plugin skills keep what their author
 * declared.
 *
 * @module
 */

import { logForDebugging } from "../utils/debug.js";

/**
 * Tools that run or drive shell commands, processes or code, lowercased:
 * the shell tool family (permissions/rules.ts SHELL_TOOL_FAMILY), the
 * JavaScript REPL tools, and retired shell spellings.
 */
const SHELL_OR_PROCESS_TOOLS: ReadonlySet<string> = new Set([
  "exec_command",
  "system.bash",
  "write_stdin",
  "kill_process",
  "powershell",
  "monitor",
  "js_repl",
  "js_repl_reset",
  "repl",
  "bash",
  "shell",
  "desktop.bash",
  "killshell",
  "bashoutputtool",
]);

/**
 * Split `allowed-tools` entries into rules at commas and spaces outside
 * parentheses, as `parseToolRuleStringsFromCLI` (permissions/settings.ts)
 * does for every other skill, so `"FileRead, exec_command"` is two rules.
 */
function splitRules(entries: readonly string[]): string[] {
  const rules: string[] = [];
  for (const entry of entries) {
    let current = "";
    let depth = 0;
    for (const char of entry) {
      if (char === "(") depth += 1;
      if (char === ")") depth = Math.max(0, depth - 1);
      if (depth === 0 && (char === "," || char === " ")) {
        if (current.trim()) rules.push(current.trim());
        current = "";
        continue;
      }
      current += char;
    }
    if (current.trim()) rules.push(current.trim());
  }
  return rules;
}

/** Whether a permission rule (`Tool` or `Tool(content)`) names a shell or process tool. */
export function isShellOrProcessToolRule(rule: string): boolean {
  const open = rule.indexOf("(");
  const toolName = (open === -1 ? rule : rule.slice(0, open)).trim().toLowerCase();
  return SHELL_OR_PROCESS_TOOLS.has(toolName);
}

/**
 * The `allowed-tools` entries a built-in skill keeps, one rule per entry.
 * Shell and process tools are left out, with a warning, whatever the
 * definition declares.
 */
export function bundledSkillAllowedTools(
  skillName: string,
  allowedTools: readonly string[] | undefined,
): string[] {
  const kept: string[] = [];
  for (const rule of splitRules(allowedTools ?? [])) {
    if (isShellOrProcessToolRule(rule)) {
      logForDebugging(
        `Built-in skill ${skillName} cannot pre-approve ${rule}: built-in skills never pre-approve shell or process tools, so that turn asks before running them.`,
        { level: "warn" },
      );
      continue;
    }
    kept.push(rule);
  }
  return kept;
}
