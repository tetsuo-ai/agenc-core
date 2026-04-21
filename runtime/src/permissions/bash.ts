/**
 * T11 Wave 2 — Bash permission splitter + sandbox override + I-3 re-fetch.
 *
 * LEAN port of openclaude
 * `src/tools/BashTool/bashPermissions.ts` (~2600 LOC) into ~700 LOC. The
 * upstream file layers tree-sitter AST parsing, shell-quote argv parsing,
 * heredoc extraction, classifier callbacks, and a React dialog queue on
 * top of the legacy regex/shell-quote security gate. AgenC keeps ONLY
 * the pieces the runtime evaluator needs:
 *
 *   1. A self-contained subcommand splitter (no tree-sitter, no
 *      shell-quote npm dep) that honours quote boundaries.
 *   2. `getSimpleCommandPrefix` and `getFirstWordPrefix` for stable
 *      rule matching (`git commit`, `npm run`, …).
 *   3. `shouldUseSandbox` — a conservative allow-list reading "safe"
 *      commands with no side effects.
 *   4. A curated inline dangerous-command pattern list (≈15 patterns).
 *   5. `bashToolHasPermission` — the orchestrator entry point.
 *
 * I-3 pattern (mid-execution AppState re-fetch):
 * Every `await` point that could yield to the UI event loop re-reads
 * the context via `context.getAppState()`. This is how Claude Code
 * survives the race where the user hits Shift+Tab (mode change) while
 * a permission check is mid-flight. Each re-fetch site is tagged with
 * `// I-3 re-fetch N/6` so auditors can trace the invariant.
 *
 * INTENTIONALLY SKIPPED (vs openclaude):
 *   - tree-sitter AST (openclaude's primary parse; we use regex fallback).
 *   - shell-quote npm dep (inline argv parser covers our matching needs).
 *   - Bash classifier async race (T13 auto-mode wiring).
 *   - React dialog queue / pending classifier hooks (orchestrator owns).
 *   - Heredoc extraction (rule matching uses first-word prefix only).
 *   - Full path-constraint validator (T11 Wave 2 Agent C owns).
 *   - 30+ dangerous pattern matchers (we keep the ~15 that AgenC enforces).
 *
 * When AgenC adds those layers it should PREPEND them to
 * `bashToolHasPermission`'s decision flow — this port's "fallback-to-ask"
 * default guarantees forward-compatibility.
 *
 * @module
 */

import {
  getAskRuleForTool,
  getDenyRuleForTool,
  toolAlwaysAllowedRule,
  getRuleByContentsForTool,
} from "./rules.js";
import type { ToolEvaluatorContext } from "./evaluator.js";
import type {
  PermissionDecisionReason,
  PermissionResult,
  PermissionRule,
  ToolPermissionContext,
} from "./types.js";

export type { ToolEvaluatorContext } from "./evaluator.js";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

export const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50;

export const BASH_TOOL_NAME = "Bash";

/**
 * Env-var assignment pattern. Matches openclaude's `ENV_VAR_ASSIGN_RE`.
 */
const ENV_VAR_ASSIGN_RE = /^[A-Za-z_]\w*=/;

/**
 * Shape check for "this token looks like a subcommand/command name":
 * lowercase, optionally hyphenated (e.g. `git`, `npm`, `run`, `compose`).
 * Rejects flags, paths, numbers, and filenames.
 */
const COMMAND_TOKEN_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Env vars safe to strip from the prefix lookup. Narrower than
 * openclaude's full list — AgenC keeps only the ones that appear in
 * lean-port test fixtures and which cannot execute code or hijack
 * binaries. When AgenC adds ANT_ONLY_SAFE_ENV_VARS (T11 Wave 3) it
 * should merge here, not replace.
 */
export const SAFE_ENV_VARS: ReadonlySet<string> = new Set([
  "NODE_ENV",
  "PYTHONUNBUFFERED",
  "PYTHONDONTWRITEBYTECODE",
  "PYTEST_DISABLE_PLUGIN_AUTOLOAD",
  "GOEXPERIMENT",
  "GOOS",
  "GOARCH",
  "CGO_ENABLED",
  "GO111MODULE",
  "RUST_BACKTRACE",
  "RUST_LOG",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_TIME",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "TZ",
  "CI",
  "DEBUG",
  "GOOGLE_CLOUD_PROJECT",
  "LS_COLORS",
  "LSCOLORS",
  "GREP_COLOR",
  "GREP_COLORS",
]);

/**
 * Bare shell/wrapper names we refuse to turn into prefix rules. A rule
 * like `Bash(bash:*)` would allow arbitrary code via `-c`. `sudo`/`doas`
 * similarly round-trip privilege.
 */
const BARE_SHELL_PREFIXES: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "csh",
  "tcsh",
  "ksh",
  "dash",
  "cmd",
  "powershell",
  "pwsh",
  "env",
  "xargs",
  "nice",
  "stdbuf",
  "nohup",
  "timeout",
  "time",
  "sudo",
  "doas",
  "pkexec",
]);

/**
 * Conservative sandbox-safe command allow-list. These commands are
 * read-only or otherwise have no file-mutating side effects when
 * invoked without `>`, `>>`, `|tee`, or similar redirections. The
 * `shouldUseSandbox` check composes this list with a redirection
 * sniff — presence on the list alone is NOT sufficient.
 *
 * openclaude has a much larger list driven by remote feature flags.
 * Lean port keeps the stable subset; adding entries requires a
 * corresponding test in `bash.test.ts`.
 */
const SANDBOX_SAFE_COMMANDS: ReadonlySet<string> = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "find",
  "grep",
  "rg",
  "pwd",
  "echo",
  "which",
  "whoami",
  "hostname",
  "date",
  "uname",
  "id",
  "stat",
  "realpath",
  "readlink",
  "file",
  "du",
  "df",
  "env",
  "printenv",
  "type",
  "git", // `git status`, `git log` etc. — guarded further by redirection check
  "node",
  "npm",
  "python",
  "python3",
  "ruby",
  "true",
  "false",
  "test",
  "printf",
  "awk",
  "sed",
  "cut",
  "sort",
  "uniq",
  "tr",
  "jq",
  "xargs",
  "column",
  "basename",
  "dirname",
  "tree",
  "tokei",
  "cloc",
]);

/**
 * Commands excluded from sandbox regardless of shape (they interact
 * with network/privileged daemons). Entering the sandbox for these is
 * pointless or counter-productive.
 */
const EXCLUDED_SANDBOX_COMMANDS: ReadonlySet<string> = new Set([
  "docker",
  "podman",
  "kubectl",
  "sudo",
  "doas",
  "pkexec",
  "systemctl",
  "service",
  "launchctl",
  "ssh",
  "scp",
  "rsync",
]);

/**
 * Inline dangerous-pattern list. Each entry is applied with `.test`
 * against the full command string. Matching any pattern forces a
 * deny with `decisionReason: { type: "safetyCheck", classifierApprovable: false }`.
 *
 * Curated to the ~15 patterns AgenC must always block. NOT a replacement
 * for the full security gate (openclaude's `bashCommandIsSafeAsync`
 * runs ~30 pattern classes); this is the hard-deny floor.
 */
const DANGEROUS_COMMAND_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly label: string;
}> = [
  // rm -rf on root or home
  { pattern: /\brm\s+(-[rRfF]+\s+)+(\/|\/\*|~|~\/)/, label: "rm -rf /" },
  { pattern: /\brm\s+-[rRfF]+\s+--no-preserve-root/, label: "rm --no-preserve-root" },
  // Filesystem destruction
  { pattern: /\bmkfs(\.|\s)/, label: "mkfs" },
  { pattern: /\bdd\s+[^|;&]*\bof=\/dev\//, label: "dd of=/dev/…" },
  { pattern: /\b(shred|wipe)\s+[-\/]/, label: "shred/wipe" },
  // Fork bomb
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/, label: "fork bomb" },
  // Pipe curl/wget to shell
  {
    pattern: /\b(curl|wget|fetch)\b[^|;&]*\|\s*(sh|bash|zsh|fish|ksh|csh|tcsh|python|python3|perl|ruby|node)\b/,
    label: "curl|sh",
  },
  // Destructive git publish to default branch
  { pattern: /\bgit\s+push\s+(--force|-f)\b[^;&|]*\b(main|master)\b/, label: "git push --force main" },
  { pattern: /\bgit\s+push\b[^;&|]*\b(main|master)\b[^;&|]*\s(--force|-f)\b/, label: "git push main --force" },
  // Package-registry publishes
  { pattern: /\b(npm|yarn|pnpm|bun)\s+publish\b/, label: "npm publish" },
  { pattern: /\bcargo\s+publish\b/, label: "cargo publish" },
  { pattern: /\bgem\s+push\b/, label: "gem push" },
  { pattern: /\btwine\s+upload\b/, label: "twine upload" },
  // Privilege escalation (top-level, not bare references in docs)
  { pattern: /(^|[;&|]\s*)sudo\b/, label: "sudo" },
  { pattern: /(^|[;&|]\s*)(su|doas|pkexec)\b(\s|$)/, label: "su/doas/pkexec" },
  // chmod / chown on system paths
  {
    pattern: /\b(chmod|chown)\s+[^;&|]*(\/etc\/|\/usr\/|\/bin\/|\/sbin\/|\/boot\/)/,
    label: "chmod/chown on system path",
  },
];

// ─────────────────────────────────────────────────────────────────────
// Input + result types
// ─────────────────────────────────────────────────────────────────────

export interface BashPermissionInput {
  readonly command: string;
  readonly description?: string;
  readonly dangerouslyDisableSandbox?: boolean;
}

export interface BashSubcommandResult {
  readonly subcommand: string;
  readonly result: PermissionResult;
}

/**
 * A `PermissionResult` augmented with optional per-subcommand context.
 * Using intersection (not `extends`) because `PermissionResult` is a
 * union; TS does not allow interface-extension of union types.
 */
export type BashPermissionResult = PermissionResult & {
  readonly subcommandResults?: readonly BashSubcommandResult[];
};

// ─────────────────────────────────────────────────────────────────────
// Argv parser (inline shell-quote-lite)
// ─────────────────────────────────────────────────────────────────────

/**
 * Parse a single simple command into argv tokens. Honors:
 *   - single quotes  (literal)
 *   - double quotes  (backslash-escape of `"` `\` `$` `` ` `` only)
 *   - backslash escapes in unquoted context
 *
 * Returns `null` when the input has an unterminated quote or contains
 * a shell metachar (`|` `&` `;` `>` `<` `(` `)` `` ` ``, `$(`), which
 * signals that the caller should split first or fall back to "ask".
 *
 * NOT a full bash parser. Good enough for prefix extraction and first-
 * word lookup; any construct more subtle than "quoted arg with optional
 * backslash escapes" routes to the `ask` branch via the null return.
 */
export function parseShellCommand(command: string): readonly string[] | null {
  const src = command;
  const n = src.length;
  const tokens: string[] = [];
  let i = 0;
  let buf = "";
  let inToken = false;

  const flushToken = (): void => {
    if (inToken) {
      tokens.push(buf);
      buf = "";
      inToken = false;
    }
  };

  while (i < n) {
    const c = src[i]!;

    if (c === " " || c === "\t") {
      flushToken();
      i++;
      continue;
    }

    // Shell metachars → unparseable by this lean tokenizer.
    if (c === "|" || c === "&" || c === ";" || c === ">" || c === "<" || c === "(" || c === ")" || c === "`" || c === "\n" || c === "\r") {
      return null;
    }

    if (c === "$" && src[i + 1] === "(") {
      return null; // command substitution
    }

    inToken = true;

    if (c === "'") {
      // Single-quoted: literal until closing '
      const end = src.indexOf("'", i + 1);
      if (end === -1) return null; // unterminated
      buf += src.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (c === '"') {
      // Double-quoted: allow \", \\, \$, \`
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = src[j]!;
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === "\\" && j + 1 < n) {
          const e = src[j + 1]!;
          if (e === '"' || e === "\\" || e === "$" || e === "`") {
            buf += e;
            j += 2;
            continue;
          }
          buf += d;
          j++;
          continue;
        }
        if (d === "$" && src[j + 1] === "(") {
          return null;
        }
        if (d === "`") {
          return null;
        }
        buf += d;
        j++;
      }
      if (!closed) return null;
      i = j + 1;
      continue;
    }

    if (c === "\\") {
      // Backslash escape: preserve next char literally, or return null at EOF
      if (i + 1 >= n) return null;
      buf += src[i + 1]!;
      i += 2;
      continue;
    }

    buf += c;
    i++;
  }

  flushToken();
  return tokens;
}

// ─────────────────────────────────────────────────────────────────────
// Subcommand splitter
// ─────────────────────────────────────────────────────────────────────

/**
 * Split a command string on top-level shell operators: `;`, `&&`, `||`,
 * `|`, `&`. Quote boundaries are honored. Redirection operators
 * (`>`, `<`, `>>`, `2>`, etc.) are NOT split points — the segment that
 * contains them is kept whole; the per-subcommand check plus
 * `isDangerousCommand` handle the rest.
 *
 * Returns an empty array for empty/blank input. Callers that need to
 * enforce the 50-subcommand cap should check
 * `MAX_SUBCOMMANDS_FOR_SECURITY_CHECK` against the return length.
 */
export function splitCommand(command: string): readonly string[] {
  const trimmed = command.trim();
  if (trimmed.length === 0) return [];

  const parts: string[] = [];
  const n = trimmed.length;
  let i = 0;
  let start = 0;

  while (i < n) {
    const c = trimmed[i]!;

    // Skip over quoted regions intact.
    if (c === "'") {
      const end = trimmed.indexOf("'", i + 1);
      if (end === -1) {
        // unterminated — treat rest of string as opaque, don't split
        i = n;
        continue;
      }
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        const d = trimmed[j]!;
        if (d === '"') break;
        if (d === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        j++;
      }
      i = j < n ? j + 1 : n;
      continue;
    }
    if (c === "\\" && i + 1 < n) {
      i += 2;
      continue;
    }

    // Operator split points.
    const two = trimmed.substr(i, 2);
    let opLen = 0;
    if (two === "&&" || two === "||") {
      opLen = 2;
    } else if (c === ";" || c === "|" || c === "&") {
      // `&` ambiguous with `&&` — handled above.
      opLen = 1;
    }

    if (opLen > 0) {
      const segment = trimmed.slice(start, i).trim();
      if (segment.length > 0) parts.push(segment);
      i += opLen;
      start = i;
      continue;
    }

    i++;
  }

  const last = trimmed.slice(start).trim();
  if (last.length > 0) parts.push(last);

  return parts;
}

// ─────────────────────────────────────────────────────────────────────
// Prefix extraction
// ─────────────────────────────────────────────────────────────────────

function stripLeadingSafeEnvVars(tokens: readonly string[]): readonly string[] | null {
  let i = 0;
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split("=")[0]!;
    if (!SAFE_ENV_VARS.has(varName)) return null;
    i++;
  }
  return tokens.slice(i);
}

/**
 * Extract a stable two-token prefix ("git commit", "npm run"). Returns
 * null if:
 *   - a non-safe env var prefix is encountered
 *   - the command has fewer than 2 tokens
 *   - the second token doesn't look like a lowercase subcommand
 */
export function getSimpleCommandPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const stripped = stripLeadingSafeEnvVars(tokens);
  if (stripped === null) return null;
  if (stripped.length < 2) return null;
  const subcmd = stripped[1]!;
  if (!COMMAND_TOKEN_RE.test(subcmd)) return null;
  return stripped.slice(0, 2).join(" ");
}

/**
 * Simpler fallback: return the first command token after stripping
 * safe env vars. Rejects bare shells / wrappers ("bash", "sudo", …).
 */
export function getFirstWordPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const stripped = stripLeadingSafeEnvVars(tokens);
  if (stripped === null) return null;
  const cmd = stripped[0];
  if (!cmd) return null;
  if (!COMMAND_TOKEN_RE.test(cmd)) return null;
  if (BARE_SHELL_PREFIXES.has(cmd)) return null;
  return cmd;
}

// ─────────────────────────────────────────────────────────────────────
// Sandbox override
// ─────────────────────────────────────────────────────────────────────

/**
 * Matches any shell-metachar that could produce a side effect in a
 * pipeline segment. Used as a negative filter for sandbox eligibility.
 */
const UNSAFE_SANDBOX_CHARS_RE = /[`$]|(^|\s)\|\s*tee\b|(?:^|\s)(>>?|<)\s|^\s*(>>?|<)/;

/**
 * Determine whether a command is sandbox-safe. A command is sandbox-
 * safe when:
 *   - `input.dangerouslyDisableSandbox` is not true
 *   - the FIRST command token is in `SANDBOX_SAFE_COMMANDS`
 *   - no subcommand first-token is in `EXCLUDED_SANDBOX_COMMANDS`
 *   - the command contains no redirection / command substitution
 *   - splitting reveals ≤ `MAX_SUBCOMMANDS_FOR_SECURITY_CHECK` parts
 *
 * Conservative by design: a `false` return means "don't skip permissions
 * via sandbox", NOT "definitely dangerous" — the normal evaluator flow
 * still applies.
 */
export function shouldUseSandbox(input: BashPermissionInput): boolean {
  if (input.dangerouslyDisableSandbox === true) return false;
  const cmd = input.command;
  if (!cmd || cmd.trim().length === 0) return false;

  if (UNSAFE_SANDBOX_CHARS_RE.test(cmd)) return false;

  const parts = splitCommand(cmd);
  if (parts.length === 0 || parts.length > MAX_SUBCOMMANDS_FOR_SECURITY_CHECK) {
    return false;
  }

  for (const part of parts) {
    const firstTok = getFirstCommandToken(part);
    if (firstTok === null) return false;
    if (EXCLUDED_SANDBOX_COMMANDS.has(firstTok)) return false;
    if (!SANDBOX_SAFE_COMMANDS.has(firstTok)) return false;
  }
  return true;
}

function getFirstCommandToken(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) i++;
  return tokens[i] ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// Dangerous patterns
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns true if the command matches any inline dangerous pattern.
 * Called against both the original command and each subcommand.
 */
export function isDangerousCommand(command: string): boolean {
  for (const { pattern } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) return true;
  }
  return false;
}

export function matchedDangerousLabel(command: string): string | null {
  for (const { pattern, label } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) return label;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Rule lookup helpers (content-qualified)
// ─────────────────────────────────────────────────────────────────────

/**
 * Match `Bash(prefix:*)` style content rules. openclaude wildcard
 * matching is implemented in `shared/permissions` and supports a
 * superset we don't need yet: exact match, `prefix:*`, and bare
 * `Bash` (whole-tool). This helper covers all three.
 */
function matchBashContentRule(
  ruleContent: string | undefined,
  command: string,
  prefix: string | null,
  firstWord: string | null,
): boolean {
  if (ruleContent === undefined) return true; // whole-tool
  const rc = ruleContent;

  // `prefix:*` — prefix rule
  if (rc.endsWith(":*")) {
    const rulePrefix = rc.slice(0, -2);
    if (rulePrefix === "") return false;
    if (command === rulePrefix) return true;
    if (command.startsWith(rulePrefix + " ")) return true;
    if (prefix === rulePrefix) return true;
    if (firstWord === rulePrefix) return true;
    return false;
  }
  // Exact match
  return rc === command;
}

function findMatchingContentRule(
  rules: ReadonlyMap<string, PermissionRule>,
  command: string,
  prefix: string | null,
  firstWord: string | null,
): PermissionRule | null {
  for (const [content, rule] of rules) {
    if (matchBashContentRule(content, command, prefix, firstWord)) return rule;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Per-subcommand evaluation
// ─────────────────────────────────────────────────────────────────────

function evaluateSubcommand(
  subcommand: string,
  ctx: ToolPermissionContext,
): PermissionResult {
  // Hard block: dangerous pattern anywhere in this subcommand.
  const dangerLabel = matchedDangerousLabel(subcommand);
  if (dangerLabel !== null) {
    return {
      behavior: "deny",
      message: `Bash command \`${subcommand}\` blocked by safety check: ${dangerLabel}.`,
      decisionReason: {
        type: "safetyCheck",
        reason: dangerLabel,
        classifierApprovable: false,
      },
    };
  }

  const prefix = getSimpleCommandPrefix(subcommand);
  const firstWord = getFirstWordPrefix(subcommand);

  const denyRules = getRuleByContentsForTool(ctx, BASH_TOOL_NAME, "deny");
  const denyMatch = findMatchingContentRule(denyRules, subcommand, prefix, firstWord);
  if (denyMatch !== null) {
    return {
      behavior: "deny",
      message: `Bash command \`${subcommand}\` denied by rule \`${denyMatch.ruleValue.toolName}(${denyMatch.ruleValue.ruleContent ?? ""})\`.`,
      decisionReason: { type: "rule", rule: denyMatch },
    };
  }
  const wholeDeny = getDenyRuleForTool(ctx, BASH_TOOL_NAME);
  if (wholeDeny !== null) {
    return {
      behavior: "deny",
      message: `Bash command \`${subcommand}\` denied by rule.`,
      decisionReason: { type: "rule", rule: wholeDeny },
    };
  }

  const askRules = getRuleByContentsForTool(ctx, BASH_TOOL_NAME, "ask");
  const askMatch = findMatchingContentRule(askRules, subcommand, prefix, firstWord);
  if (askMatch !== null) {
    return {
      behavior: "ask",
      message: `Approval required for bash command \`${subcommand}\`.`,
      decisionReason: { type: "rule", rule: askMatch },
    };
  }
  const wholeAsk = getAskRuleForTool(ctx, BASH_TOOL_NAME);
  if (wholeAsk !== null) {
    return {
      behavior: "ask",
      message: `Approval required for bash command \`${subcommand}\`.`,
      decisionReason: { type: "rule", rule: wholeAsk },
    };
  }

  const allowRules = getRuleByContentsForTool(ctx, BASH_TOOL_NAME, "allow");
  const allowMatch = findMatchingContentRule(allowRules, subcommand, prefix, firstWord);
  if (allowMatch !== null) {
    return {
      behavior: "allow",
      decisionReason: { type: "rule", rule: allowMatch },
    };
  }
  const wholeAllow = toolAlwaysAllowedRule(ctx, BASH_TOOL_NAME);
  if (wholeAllow !== null) {
    return {
      behavior: "allow",
      decisionReason: { type: "rule", rule: wholeAllow },
    };
  }

  return {
    behavior: "passthrough",
    message: `No rule matched subcommand \`${subcommand}\`.`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Plan-mode and mode-based gating
// ─────────────────────────────────────────────────────────────────────

/**
 * Best-effort read-only detector used only for plan mode gating. True
 * when every subcommand's first token is in the sandbox-safe set AND
 * no redirection chars appear. Plan mode denies everything that isn't
 * read-only.
 */
function looksReadOnly(command: string): boolean {
  if (/[`$]|(^|\s)(>>?|<)\s/.test(command)) return false;
  const parts = splitCommand(command);
  if (parts.length === 0) return false;
  for (const part of parts) {
    const firstTok = getFirstCommandToken(part);
    if (firstTok === null) return false;
    if (!SANDBOX_SAFE_COMMANDS.has(firstTok)) return false;
    if (EXCLUDED_SANDBOX_COMMANDS.has(firstTok)) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────

function aggregateSubcommandResults(
  input: BashPermissionInput,
  subresults: readonly BashSubcommandResult[],
): BashPermissionResult {
  const deny = subresults.find((s) => s.result.behavior === "deny");
  if (deny !== undefined) {
    const denyMsg =
      deny.result.behavior === "deny" || deny.result.behavior === "ask" || deny.result.behavior === "passthrough"
        ? deny.result.message
        : "subcommand denied";
    return {
      behavior: "deny",
      message: `Permission to use Bash with command \`${input.command}\` denied: ${denyMsg}.`,
      decisionReason: buildSubcommandReason(subresults),
      subcommandResults: subresults,
    };
  }
  const ask = subresults.find((s) => s.result.behavior === "ask");
  if (ask !== undefined) {
    return {
      behavior: "ask",
      message: `Approval required for bash command \`${input.command}\`.`,
      decisionReason: buildSubcommandReason(subresults),
      subcommandResults: subresults,
    };
  }
  const anyPass = subresults.some((s) => s.result.behavior === "passthrough");
  if (anyPass) {
    return {
      behavior: "passthrough",
      message: `No rule matched bash command \`${input.command}\`.`,
      decisionReason: buildSubcommandReason(subresults),
      subcommandResults: subresults,
    };
  }
  return {
    behavior: "allow",
    updatedInput: { ...input },
    decisionReason: buildSubcommandReason(subresults),
    subcommandResults: subresults,
  };
}

function buildSubcommandReason(
  subresults: readonly BashSubcommandResult[],
): PermissionDecisionReason {
  const map = new Map<string, PermissionResult>();
  for (const s of subresults) map.set(s.subcommand, s.result);
  return { type: "subcommandResults", reasons: map };
}

// ─────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Orchestrates a Bash permission decision. See file header for the full
 * I-3 re-fetch invariant. Six re-fetch sites are tagged below; each
 * sits immediately after an `await` or at a boundary where the user
 * could have hit Shift+Tab since the last read.
 */
export async function bashToolHasPermission(
  input: BashPermissionInput,
  context: ToolEvaluatorContext,
): Promise<BashPermissionResult> {
  // I-3 re-fetch 1/6 — initial snapshot.
  let appState = context.getAppState();
  let ctx = appState.toolPermissionContext;

  // Bypass short-circuit: `bypassPermissions` mode allows everything
  // except dangerous commands. The dangerous check runs regardless of
  // mode — AgenC's hard floor.
  if (isDangerousCommand(input.command)) {
    const label = matchedDangerousLabel(input.command) ?? "dangerous command";
    return {
      behavior: "deny",
      message: `Permission to use Bash with command \`${input.command}\` denied: ${label}.`,
      decisionReason: {
        type: "safetyCheck",
        reason: label,
        classifierApprovable: false,
      },
    };
  }

  // Parse the full command as a simple argv first. When that fails the
  // input has shell metachars worth splitting; when it succeeds we
  // already know there's no `|` / `;` / `&`-based compound.
  const argv = parseShellCommand(input.command);

  // Yield once so UI-triggered mode changes can land before the next
  // read. Matches openclaude's pre-classifier yield at ~1989.
  await Promise.resolve();
  // I-3 re-fetch 2/6 — after initial parse yield.
  appState = context.getAppState();
  ctx = appState.toolPermissionContext;

  // Plan mode: deny anything that isn't clearly read-only.
  if (ctx.mode === "plan" && !looksReadOnly(input.command)) {
    return {
      behavior: "deny",
      message: `Command \`${input.command}\` is not read-only and the runtime is in plan mode.`,
      decisionReason: { type: "mode", mode: "plan" },
    };
  }

  // Split into subcommands (regex-based, quote-aware).
  const subcommands = splitCommand(input.command);

  if (subcommands.length === 0) {
    return {
      behavior: "ask",
      message: "Bash command was empty; confirm intent.",
      decisionReason: { type: "other", reason: "empty_command" },
    };
  }

  if (subcommands.length > MAX_SUBCOMMANDS_FOR_SECURITY_CHECK) {
    return {
      behavior: "ask",
      message: `Command splits into ${subcommands.length} subcommands, too many to safety-check individually.`,
      decisionReason: { type: "other", reason: "bash_parse_unavailable" },
    };
  }

  // If argv parse failed AND the split did not break the command into
  // recognizable parts (still contains exotic shell chars), fall back
  // to ask. Never silently allow.
  if (argv === null && subcommands.length === 1 && /[`$()<]/.test(input.command)) {
    return {
      behavior: "ask",
      message: `Bash command contains shell constructs this runtime cannot verify; confirm intent for \`${input.command}\`.`,
      decisionReason: { type: "other", reason: "bash_parse_unavailable" },
    };
  }

  // Yield before first subcommand check — classifier peek would go here.
  await Promise.resolve();
  // I-3 re-fetch 3/6 — after split / pre subcommand loop.
  appState = context.getAppState();
  ctx = appState.toolPermissionContext;

  // Re-check plan mode — user may have entered it mid-split.
  if (ctx.mode === "plan" && !looksReadOnly(input.command)) {
    return {
      behavior: "deny",
      message: `Command \`${input.command}\` is not read-only and the runtime is in plan mode.`,
      decisionReason: { type: "mode", mode: "plan" },
    };
  }

  // Per-subcommand evaluation.
  const subresults: BashSubcommandResult[] = [];
  for (const subcommand of subcommands) {
    subresults.push({ subcommand, result: evaluateSubcommand(subcommand, ctx) });
  }

  // Yield after subcommand loop — classifier result would attach here.
  await Promise.resolve();
  // I-3 re-fetch 4/6 — after per-subcommand evaluation.
  appState = context.getAppState();
  ctx = appState.toolPermissionContext;

  // bypassPermissions mode: user has explicitly accepted YOLO. Skip
  // final aggregation only when no subcommand hit a deny — dangerous
  // check already ran above, rule-deny still wins.
  if (ctx.mode === "bypassPermissions") {
    const hadDeny = subresults.some((s) => s.result.behavior === "deny");
    if (!hadDeny) {
      return {
        behavior: "allow",
        updatedInput: { ...input },
        decisionReason: { type: "mode", mode: "bypassPermissions" },
      };
    }
  }

  // Aggregate.
  const aggregate = aggregateSubcommandResults(input, subresults);

  // Yield before sandbox override / allow upgrade.
  await Promise.resolve();
  // I-3 re-fetch 5/6 — before sandbox override application.
  appState = context.getAppState();
  ctx = appState.toolPermissionContext;

  // Sandbox override: if the command is sandbox-safe AND the context
  // opts into auto-allow-when-sandboxed, upgrade a passthrough / ask
  // decision to allow with `sandboxOverride` reason.
  const ctxWithFlag = ctx as ToolPermissionContext & {
    readonly autoAllowBashIfSandboxed?: boolean;
  };
  if (ctxWithFlag.autoAllowBashIfSandboxed === true && shouldUseSandbox(input)) {
    if (aggregate.behavior === "passthrough" || aggregate.behavior === "ask") {
      return {
        behavior: "allow",
        updatedInput: { ...input },
        decisionReason: {
          type: "sandboxOverride",
          reason: "excludedCommand",
        },
        subcommandResults: aggregate.subcommandResults,
      };
    }
  }

  if (input.dangerouslyDisableSandbox === true && aggregate.behavior === "allow") {
    // Annotate the allow with the override reason for telemetry — other
    // flows rely on knowing the user waived sandbox.
    await Promise.resolve();
    // I-3 re-fetch 6/6 — final snapshot before annotation.
    appState = context.getAppState();
    ctx = appState.toolPermissionContext;
    return {
      ...aggregate,
      decisionReason: {
        type: "sandboxOverride",
        reason: "dangerouslyDisableSandbox",
      },
    };
  }

  // Convert passthrough to ask — the evaluator contract is that Bash
  // never passthroughs past the tool gate; a passthrough means "no rule
  // matched, ask the user".
  if (aggregate.behavior === "passthrough") {
    return {
      behavior: "ask",
      message: `No rule matched bash command \`${input.command}\`.`,
      decisionReason: aggregate.decisionReason,
      subcommandResults: aggregate.subcommandResults,
    };
  }

  return aggregate;
}
