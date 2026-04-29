/**
 * Permissions / sandbox prompt-injection — port of codex runtime's
 * `core/src/context/prompts/permissions/**` plus the composer logic in
 * `core/src/context/permissions_instructions.rs`.
 *
 * The eight `.md` files codex runtime bundles for approval-policy and sandbox-
 * mode are ported here as exported string constants, byte-for-byte
 * (whitespace, casing, leading spaces all preserved). A small selector
 * function combines the right pair into a single dynamic system-prompt
 * section based on the current AgenC permission mode.
 *
 * AgenC's permission model has four user-addressable modes that don't
 * map 1:1 onto codex runtime's two-axis (approval × sandbox) model. Mapping:
 *
 *   AgenC `"plan"`              → approval `unless_trusted` + sandbox `read_only`
 *   AgenC `"default"`           → approval `on_request`     + sandbox `workspace_write`
 *   AgenC `"acceptEdits"`       → approval `on_failure`     + sandbox `workspace_write`
 *   AgenC `"bypassPermissions"` → approval `never`          + sandbox `danger_full_access`
 *
 * codex runtime's sandbox-mode `.md` files include a `{{network_access}}` template
 * placeholder that codex runtime resolves to either `enabled` or `restricted` at
 * render time. AgenC mirrors that here: for `bypassPermissions` /
 * `danger_full_access` we substitute `enabled`; for everything else we
 * substitute `restricted` to match codex runtime's default sandbox-policy
 * behavior. The constants themselves keep the placeholder literal so
 * tests can compare them against the upstream files byte-for-byte.
 *
 * @module
 */

import type {
  PermissionMode,
  ToolPermissionContext,
} from "../permissions/types.js";

// ─────────────────────────────────────────────────────────────────────
// Approval-policy `.md` constants — verbatim ports.
// ─────────────────────────────────────────────────────────────────────

/**
 * Verbatim port of
 * `codex-rs/core/src/context/prompts/permissions/approval_policy/never.md`.
 */
export const APPROVAL_POLICY_NEVER =
  "Approval policy is currently never. Do not provide the `sandbox_permissions` for any reason, commands will be rejected.\n";

/**
 * Verbatim port of
 * `codex-rs/core/src/context/prompts/permissions/approval_policy/unless_trusted.md`.
 *
 * Note: the upstream file begins with a single literal space character.
 * Preserved here exactly.
 */
export const APPROVAL_POLICY_UNLESS_TRUSTED =
  " Approvals are your mechanism to get user consent to run shell commands without the sandbox. `approval_policy` is `unless-trusted`: The harness will escalate most commands for user approval, apart from a limited allowlist of safe \"read\" commands.\n";

/**
 * Verbatim port of
 * `codex-rs/core/src/context/prompts/permissions/approval_policy/on_failure.md`.
 */
export const APPROVAL_POLICY_ON_FAILURE =
  "Approvals are your mechanism to get user consent to run shell commands without the sandbox. `approval_policy` is `on-failure`: The harness will allow all commands to run in the sandbox (if enabled), and failures will be escalated to the user for approval to run again without the sandbox.\n";

/**
 * Verbatim port of
 * `codex-rs/core/src/context/prompts/permissions/approval_policy/on_request.md`.
 */
export const APPROVAL_POLICY_ON_REQUEST = `# Escalation Requests

Commands are run outside the sandbox if they are approved by the user, or match an existing rule that allows it to run unrestricted. The command string is split into independent command segments at shell control operators, including but not limited to:

- Pipes: |
- Logical operators: &&, ||
- Command separators: ;
- Subshell boundaries: (...), $(...)

Each resulting segment is evaluated independently for sandbox restrictions and approval requirements.

Example:

git pull | tee output.txt

This is treated as two command segments:

["git", "pull"]

["tee", "output.txt"]

Commands that use more advanced shell features like redirection (>, >>, <), substitutions ($(...), ...), environment variables (FOO=bar), or wildcard patterns (*, ?) will not be evaluated against rules, to limit the scope of what an approved rule allows.

## How to request escalation

IMPORTANT: To request approval to execute a command that will require escalated privileges:

- Provide the \`sandbox_permissions\` parameter with the value \`"require_escalated"\`
- Include a short question asking the user if they want to allow the action in \`justification\` parameter. e.g. "Do you want to download and install dependencies for this project?"
- Optionally suggest a \`prefix_rule\` - this will be shown to the user with an option to persist the rule approval for future sessions.

If you run a command that is important to solving the user's query, but it fails because of sandboxing or with a likely sandbox-related network error (for example DNS/host resolution, registry/index access, or dependency download failure), rerun the command with "require_escalated". ALWAYS proceed to use the \`justification\` parameter - do not message the user before requesting approval for the command.

## When to request escalation

While commands are running inside the sandbox, here are some scenarios that will require escalation outside the sandbox:

- You need to run a command that writes to a directory that requires it (e.g. running tests that write to /var)
- You need to run a GUI app (e.g., open/xdg-open/osascript) to open browsers or files.
- If you run a command that is important to solving the user's query, but it fails because of sandboxing or with a likely sandbox-related network error (for example DNS/host resolution, registry/index access, or dependency download failure), rerun the command with \`require_escalated\`. ALWAYS proceed to use the \`sandbox_permissions\` and \`justification\` parameters. do not message the user before requesting approval for the command.
- You are about to take a potentially destructive action such as an \`rm\` or \`git reset\` that the user did not explicitly ask for.
- Be judicious with escalating, but if completing the user's request requires it, you should do so - don't try and circumvent approvals by using other tools.

## prefix_rule guidance

When choosing a \`prefix_rule\`, request one that will allow you to fulfill similar requests from the user in the future without re-requesting escalation. It should be categorical and reasonably scoped to similar capabilities. You should rarely pass the entire command into \`prefix_rule\`.

### Banned prefix_rules${" "}
Avoid requesting overly broad prefixes that the user would be ill-advised to approve. For example, do not request ["python3"], ["python", "-"], or other similar prefixes that would allow arbitrary scripting.
NEVER provide a prefix_rule argument for destructive commands like rm.
NEVER provide a prefix_rule if your command uses a heredoc or herestring.${" "}

### Examples
Good examples of prefixes:
- ["npm", "run", "dev"]
- ["gh", "pr", "check"]
- ["cargo", "test"]
`;

/**
 * Verbatim port of
 * `codex-rs/core/src/context/prompts/permissions/approval_policy/on_request_rule_request_permission.md`.
 */
export const APPROVAL_POLICY_ON_REQUEST_RULE_REQUEST_PERMISSION = `# Permission Requests

Commands may require user approval before execution. Prefer requesting sandboxed additional permissions instead of asking to run fully outside the sandbox.

## Preferred request mode

When you need extra sandboxed permissions for one command, use:

- \`sandbox_permissions: "with_additional_permissions"\`
- \`additional_permissions\` with one or more of:
  - \`network.enabled\`: set to \`true\` to enable network access
  - \`file_system.read\`: list of paths that need read access
  - \`file_system.write\`: list of paths that need write access

When using the \`request_permissions\` tool directly, only request \`network\` and \`file_system\` permissions.

This keeps execution inside the current sandbox policy, while adding only the requested permissions for that command, unless an exec-policy allow rule applies and authorizes running the command outside the sandbox.

If the command already matches an exec-policy allow rule, the command can be auto-approved without an extra prompt. In that case, exec-policy allow behavior (including any sandbox bypass) takes precedence.

## Escalation Requests

Use full escalation only when sandboxed additional permissions cannot satisfy the task.

- \`sandbox_permissions: "require_escalated"\`
- Include \`justification\` as a short question asking for approval.
- Optionally include \`prefix_rule\` to suggest a reusable allow rule.

## Command segmentation reminder

The command string is split into independent command segments at shell control operators, including pipes (\`|\`), logical operators (\`&&\`, \`||\`), command separators (\`;\`), and subshell boundaries (\`(...)\`, \`$()\`).

Each segment is evaluated independently for sandbox restrictions and approval requirements.
`;

// ─────────────────────────────────────────────────────────────────────
// Sandbox-mode `.md` constants — verbatim ports.
// The `{{network_access}}` placeholder is preserved as-is; the selector
// substitutes it at render time, matching codex runtime's
// `permissions_instructions.rs::sandbox_text` behavior.
// ─────────────────────────────────────────────────────────────────────

/**
 * Verbatim port of
 * `codex-rs/core/src/context/prompts/permissions/sandbox_mode/danger_full_access.md`.
 */
export const SANDBOX_MODE_DANGER_FULL_ACCESS =
  "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `danger-full-access`: No filesystem sandboxing - all commands are permitted. Network access is {{network_access}}.\n";

/**
 * Verbatim port of
 * `codex-rs/core/src/context/prompts/permissions/sandbox_mode/workspace_write.md`.
 */
export const SANDBOX_MODE_WORKSPACE_WRITE =
  "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `workspace-write`: The sandbox permits reading files, and editing files in `cwd` and `writable_roots`. Editing files in other directories requires approval. Network access is {{network_access}}.\n";

/**
 * Verbatim port of
 * `codex-rs/core/src/context/prompts/permissions/sandbox_mode/read_only.md`.
 */
export const SANDBOX_MODE_READ_ONLY =
  "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `read-only`: The sandbox only permits reading files. Network access is {{network_access}}.\n";

// ─────────────────────────────────────────────────────────────────────
// Selector
// ─────────────────────────────────────────────────────────────────────

/**
 * Mapping from AgenC permission mode to a (approval-policy, sandbox-mode,
 * network-access, label) tuple. Modes that don't have a clean codex runtime analog
 * map to `null` and the section is dropped (returns `null` from
 * `getPermissionsSection`).
 */
interface ModeBinding {
  readonly approvalText: string;
  readonly sandboxTemplate: string;
  /** Substituted into `{{network_access}}` in the sandbox template. */
  readonly networkAccess: "enabled" | "restricted";
  /** Human-readable label for the section heading. */
  readonly label: string;
}

const MODE_BINDINGS: Partial<Record<PermissionMode, ModeBinding>> = {
  plan: {
    approvalText: APPROVAL_POLICY_UNLESS_TRUSTED,
    sandboxTemplate: SANDBOX_MODE_READ_ONLY,
    networkAccess: "restricted",
    label: "plan",
  },
  default: {
    approvalText: APPROVAL_POLICY_ON_REQUEST,
    sandboxTemplate: SANDBOX_MODE_WORKSPACE_WRITE,
    networkAccess: "restricted",
    label: "default",
  },
  acceptEdits: {
    approvalText: APPROVAL_POLICY_ON_FAILURE,
    sandboxTemplate: SANDBOX_MODE_WORKSPACE_WRITE,
    networkAccess: "restricted",
    label: "acceptEdits",
  },
  bypassPermissions: {
    approvalText: APPROVAL_POLICY_NEVER,
    sandboxTemplate: SANDBOX_MODE_DANGER_FULL_ACCESS,
    networkAccess: "enabled",
    label: "bypassPermissions",
  },
};

/**
 * Render a sandbox-mode template by substituting the `{{network_access}}`
 * placeholder. Mirrors codex runtime's `sandbox_text` (which goes through the
 * `Template::render` path) byte-for-byte for the supported placeholder.
 *
 * The trailing `\n` from the upstream `.md` is stripped first so the
 * outer composition controls section spacing exactly, matching codex runtime's
 * `Template::parse(...)` on `trim_end()`-ed source.
 */
function renderSandbox(
  template: string,
  networkAccess: "enabled" | "restricted",
): string {
  return template.replace(/\n+$/, "").replace(/\{\{network_access\}\}/g, networkAccess);
}

/**
 * Build the dynamic permissions/sandbox system-prompt section for the
 * supplied AgenC permission context. Returns `null` when the context is
 * absent or the mode has no codex runtime analog (e.g. internal-only `bubble`,
 * `dontAsk`, or `auto` — these do not yet have published behavioral
 * descriptions on the codex runtime side and are intentionally elided rather
 * than misrepresented).
 *
 * Composition order, per codex runtime `permissions_instructions.rs`:
 * sandbox text first, then approval text, joined with a blank line.
 * The brief originally specified approval-then-sandbox; the codex runtime
 * composer is the authoritative source ("Take each codex runtime .md byte-for-
 * byte. No rewording.") so we follow codex runtime's actual ordering here.
 */
export function getPermissionsSection(
  ctx: ToolPermissionContext | null,
): string | null {
  if (ctx === null) return null;
  const binding = MODE_BINDINGS[ctx.mode];
  if (binding === undefined) return null;

  const sandboxText = renderSandbox(binding.sandboxTemplate, binding.networkAccess);
  // Approval text constants keep their trailing `\n` from the upstream
  // file. Strip it so the outer joiner controls spacing.
  const approvalText = binding.approvalText.replace(/\n+$/, "");

  const heading = `# Permission Mode: ${binding.label}`;
  return [heading, sandboxText, approvalText].join("\n\n");
}
