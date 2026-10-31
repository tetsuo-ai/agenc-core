/**
 * What a built-in (bundled) skill's `allowed-tools` may pre-approve.
 *
 * A skill the user invokes by name runs its turn with its `allowed-tools`
 * as allow rules. Built-in skills ship inside AgenC, so their grants are an
 * allowlist: a built-in skill may pre-approve only the built-in tools below,
 * none of which runs a shell command, a process or code. Every other entry is
 * left out with a warning: shell and process tools, any MCP tool (whatever
 * its spelling), server-wide and wildcard grants, and tools not listed. User
 * and plugin skills keep what their author declared.
 *
 * @module
 */

import { parseRuleString } from "../permissions/rules.js";
import { logForDebugging } from "../utils/debug.js";

/**
 * The tools built-in skills may pre-approve: the grants the shipped built-in
 * skills use (`/update-config`, `/keybindings`, `/debug`,
 * `/ledger-wallet-cli`), with no shell or process tool among them. A new
 * entry must be a built-in tool that cannot run a command, a process or code.
 */
export const BUNDLED_SKILL_GRANTABLE_TOOLS: ReadonlySet<string> = new Set([
  "FileRead",
  "Grep",
  "Glob",
  "Write",
  "Edit",
  "MultiEdit",
  "ledger_wallet_cli_status",
  "install_ledger_wallet_cli",
]);

/**
 * Tools that run or drive shell commands, processes or code, lowercased:
 * the shell tool family (permissions/rules.ts SHELL_TOOL_FAMILY), the
 * JavaScript REPL tools, and retired shell spellings. They are outside the
 * allowlist anyway; naming them gives the warning its reason.
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

function ruleToolName(rule: string): string {
  return (parseRuleString(rule.trim())?.toolName ?? rule).trim();
}

/** Whether a permission rule (`Tool` or `Tool(content)`) names a shell or process tool. */
export function isShellOrProcessToolRule(rule: string): boolean {
  return SHELL_OR_PROCESS_TOOLS.has(ruleToolName(rule).toLowerCase());
}

/** Whether a rule names an MCP tool or server, in any spelling or case. */
function isMcpRule(toolName: string): boolean {
  return /^mcp(?:__|[.:/])/iu.test(toolName) || toolName.toLowerCase() === "mcp";
}

/**
 * Why a built-in skill cannot keep `rule`, or null when it can: the rule's
 * tool must be on {@link BUNDLED_SKILL_GRANTABLE_TOOLS}, spelled exactly.
 */
export function bundledSkillGrantRefusal(rule: string): string | null {
  const toolName = ruleToolName(rule);
  if (BUNDLED_SKILL_GRANTABLE_TOOLS.has(toolName)) return null;
  if (isShellOrProcessToolRule(rule)) {
    return "built-in skills never pre-approve shell or process tools";
  }
  if (isMcpRule(toolName)) {
    return "built-in skills never pre-approve MCP tools or servers";
  }
  if (/[*?]/u.test(toolName)) {
    return "built-in skills never pre-approve wildcard grants";
  }
  return "it is not a built-in tool a built-in skill may pre-approve";
}

/**
 * The `allowed-tools` entries a built-in skill keeps, one rule per entry:
 * those whose tool is on the allowlist. Every other entry is left out with a
 * warning, whatever the definition declares.
 */
export function bundledSkillAllowedTools(
  skillName: string,
  allowedTools: readonly string[] | undefined,
): string[] {
  const kept: string[] = [];
  for (const rule of splitRules(allowedTools ?? [])) {
    const refusal = bundledSkillGrantRefusal(rule);
    if (refusal !== null) {
      logForDebugging(
        `Built-in skill ${skillName} cannot pre-approve ${rule}: ${refusal}, so that turn asks before using it.`,
        { level: "warn" },
      );
      continue;
    }
    kept.push(rule);
  }
  return kept;
}
