/**
 * Permissions / sandbox prompt-injection.
 *
 * This file is the permissionsInstructions source for prompt assembly.
 *
 * The approval-policy and sandbox-mode text blocks are kept as exported
 * string constants with whitespace, casing, and leading spaces preserved. A
 * small selector combines the active approval guidance with the effective
 * sandbox authority captured for the current turn.
 *
 * AgenC's permission model and execution sandbox are independent axes. The
 * permission mode selects approval guidance while the turn context supplies
 * the sandbox and network text. In particular, `bypassPermissions` suppresses
 * approvals without claiming that the OS sandbox was also disabled.
 *
 *   AgenC `"plan"`              → approval `unless_trusted`
 *   AgenC `"default"`           → approval `on_request`
 *   AgenC `"acceptEdits"`       → approval `on_failure`
 *   AgenC `"bypassPermissions"` → approval `never`, or, inside a sandbox AgenC
 *                                 can lift, the pre-approved escalation text
 *   AgenC `"unattended"`        → background-agent allow/deny/pause policy
 *
 * Sandbox-mode text includes a `{{network_access}}` template placeholder that
 * resolves to either `enabled` or `restricted` from the current turn's
 * network policy. The constants themselves keep the placeholder literal so
 * tests can compare exact text.
 *
 * @module
 */

import type {
  PermissionMode,
  ToolPermissionContext,
} from "../permissions/types.js";
import type {
  NetworkSandboxPolicy,
  SandboxPolicy,
} from "../session/turn-context.js";
import { unattendedPolicyForContext } from "../permissions/unattended-policy.js";

// ─────────────────────────────────────────────────────────────────────
// Approval-policy `.md` constants — verbatim ports.
// ─────────────────────────────────────────────────────────────────────

/**
 * Approval policy: never.
 */
export const APPROVAL_POLICY_NEVER =
  "Approval policy is currently never. Do not provide the `sandbox_permissions` for any reason, commands will be rejected.\n";

/**
 * Bypass-only autonomy note. NOT part of the verbatim upstream `never.md` —
 * kept separate so the ported constant stays byte-for-byte. Bypass mode means
 * the user already pre-authorized every tool call, so the agent must not
 * re-introduce interactive gates the mode waived: no confirmation prompts, no
 * plan-approval pauses, no permission asks. Without this the model reads
 * "approval policy: never" narrowly (only about `sandbox_permissions`) and
 * still stops to ask the user before acting — the "yolo still prompts me"
 * complaint.
 *
 * The note waives tool prompts, not judgement: the static head's
 * "Executing actions with care" section keeps its say over destructive,
 * irreversible, shared-system and externally visible actions, the model may
 * still ask one question when the request is genuinely ambiguous, and a
 * finished task ends with a report rather than more work. An earlier wording
 * ("do not stop to wait for the user ... drive the task to completion")
 * contradicted that section and pushed the model past the end of a task.
 */
export const BYPASS_AUTONOMY_NOTE =
  "Approval policy never means tool calls are pre-approved: do not ask for tool permission or plan approval, and do not pause for confirmation of local, reversible work. The rules in 'Executing actions with care' still apply: destructive, irreversible, shared-system or externally visible actions still need the user's explicit request. If the task is genuinely ambiguous, ask one question with AskUserQuestion; when the requested work is done and verified, stop and report.";

/**
 * Approval text for bypassPermissions inside a sandbox AgenC can lift. The
 * orchestrator grants a `require_escalated` request in that mode without
 * asking (tools/orchestrator.ts), so APPROVAL_POLICY_NEVER, which says such
 * requests are rejected, is false there. A model told it gave up on work that
 * has to leave the sandbox, such as opening a page in the user's browser, and
 * instead started the browser's binary inside the sandbox, which crashed it.
 */
export const APPROVAL_POLICY_BYPASS_ESCALATION =
  "Approval policy is currently never, and this session runs in bypass mode, so leaving the sandbox is pre-approved. Commands run in the sandbox. When one must run outside it, such as a GUI app (open, xdg-open, osascript) that opens a browser or a file, a write the sandbox forbids, or network access it blocks, provide `sandbox_permissions` with the value `\"require_escalated\"` and a one-line `justification`; the command then runs outside the sandbox without asking. Escalate instead of working around the sandbox another way, such as starting an app's binary directly.\n";

/**
 * Approval policy: unless trusted. Begins with one literal space character.
 */
export const APPROVAL_POLICY_UNLESS_TRUSTED =
  " Approvals are your mechanism to get user consent to run shell commands without the sandbox. `approval_policy` is `unless-trusted`: The harness will escalate most commands for user approval, apart from a limited allowlist of safe \"read\" commands.\n";

/**
 * Approval policy: on failure.
 */
export const APPROVAL_POLICY_ON_FAILURE =
  "Approvals are your mechanism to get user consent to run shell commands without the sandbox. `approval_policy` is `on-failure`: The harness will allow all commands to run in the sandbox (if enabled), and failures will be escalated to the user for approval to run again without the sandbox.\n";

/**
 * Approval policy: on request.
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
 * Approval policy: on request with direct permission-request guidance.
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
// Sandbox-mode text constants.
// The `{{network_access}}` placeholder is preserved as-is; the selector
// substitutes it at render time.
// ─────────────────────────────────────────────────────────────────────

/**
 * Sandbox mode: danger full access.
 */
export const SANDBOX_MODE_DANGER_FULL_ACCESS =
  "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `danger-full-access`: No filesystem sandboxing - all commands are permitted. Network access is {{network_access}}.\n";

/**
 * Sandbox mode: workspace write.
 */
export const SANDBOX_MODE_WORKSPACE_WRITE =
  "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `workspace-write`: The sandbox permits reading files, and editing files in `cwd` and `writable_roots`. Editing files in other directories requires approval. Network access is {{network_access}}.\n";

/**
 * Sandbox mode: read only.
 */
export const SANDBOX_MODE_READ_ONLY =
  "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `read-only`: The sandbox only permits reading files. Network access is {{network_access}}.\n";

/** Sandbox mode: externally managed. */
export const SANDBOX_MODE_EXTERNAL =
  "Filesystem sandboxing is controlled by an external authority. `sandbox_mode` is `external-sandbox`: AgenC does not widen or replace that sandbox. Network access is {{network_access}}.\n";

// ─────────────────────────────────────────────────────────────────────
// Selector
// ─────────────────────────────────────────────────────────────────────

/**
 * Mapping from AgenC permission mode to a (approval-policy, sandbox-mode,
 * network-access, label) tuple. Modes that don't have a clean prompt analog
 * map to `null` and the section is dropped (returns `null` from
 * `getPermissionsSection`).
 */
interface ModeBinding {
  readonly approvalText: string;
  /** Human-readable label for the section heading. */
  readonly label: string;
  /** Optional extra guidance appended after the approval text (bypass only). */
  readonly autonomyNote?: string;
}

const MODE_BINDINGS: Partial<Record<PermissionMode, ModeBinding>> = {
  plan: {
    approvalText: APPROVAL_POLICY_UNLESS_TRUSTED,
    label: "plan",
  },
  default: {
    approvalText: APPROVAL_POLICY_ON_REQUEST,
    label: "default",
  },
  acceptEdits: {
    approvalText: APPROVAL_POLICY_ON_FAILURE,
    label: "acceptEdits",
  },
  bypassPermissions: {
    approvalText: APPROVAL_POLICY_NEVER,
    label: "bypassPermissions",
    autonomyNote: BYPASS_AUTONOMY_NOTE,
  },
};

export interface PermissionPromptExecutionAuthority {
  readonly sandboxPolicy: SandboxPolicy;
  readonly networkSandboxPolicy: Pick<NetworkSandboxPolicy, "enabled">;
}

function sandboxTemplateForPolicy(policy: SandboxPolicy): string {
  switch (policy) {
    case "danger_full_access":
      return SANDBOX_MODE_DANGER_FULL_ACCESS;
    case "workspace_write":
      return SANDBOX_MODE_WORKSPACE_WRITE;
    case "read_only":
      return SANDBOX_MODE_READ_ONLY;
    case "external_sandbox":
      return SANDBOX_MODE_EXTERNAL;
  }
}

/**
 * Render a sandbox-mode template by substituting the `{{network_access}}`
 * placeholder.
 *
 * The trailing `\n` is stripped first so the outer composition controls
 * section spacing exactly.
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
 * absent or the mode has no prompt analog (e.g. internal-only `bubble`,
 * `dontAsk`, or `auto` — these do not yet have published behavioral
 * descriptions and are intentionally elided rather than misrepresented).
 *
 * Composition order: sandbox text first, then approval text, joined with a
 * blank line.
 */
export function getPermissionsSection(
  ctx: ToolPermissionContext | null,
  authority: PermissionPromptExecutionAuthority,
  options: { readonly light?: boolean; readonly lightPrint?: boolean } = {},
): string | null {
  if (ctx === null) return null;
  if (ctx.mode === "unattended") {
    const policy = unattendedPolicyForContext(ctx);
    const allow = policy.allowlist.length > 0
      ? policy.allowlist.join(", ")
      : "(none)";
    const deny = policy.denylist.length > 0
      ? policy.denylist.join(", ")
      : "(none)";
    return [
      "# Permission Mode: unattended",
      policy.readOnly
        ? "This routine runs without an attached human client. Tools on the unattended denylist are rejected automatically. Tools on the unattended allowlist are approved automatically. Other calls may proceed only when Core verifies them as read-only and within the run's allowed scope. Calls that need approval are refused, not paused. Never request bypass permissions or retry a refused operation. Preserve partial findings and identify anything that could not be collected."
        : "This background agent runs without an attached human client. Tools on the unattended denylist are rejected automatically. Tools on the unattended allowlist are approved automatically. Any other tool pauses the agent and surfaces a permission request to an attached client.",
      ...(policy.readOnly ? ["For system diagnostics, use one bounded native command per call, without shell wrappers, substitutions, redirections or chaining. On macOS, prefer sw_vers, sysctl -n with specific hardware keys, vm_stat, df -h, top -l 1 -n 5 -stats pid,command,cpu,mem, pmset -g batt, and system_profiler SPPowerDataType -detailLevel mini -timeout 10. Use ifconfig or ipconfig getifaddr en0 for local network state. These queries do not authorize changing settings or reading arbitrary files outside the project."] : []),
      `Unattended allowlist: ${allow}`,
      `Unattended denylist: ${deny}`,
    ].join("\n\n");
  }
  const binding = MODE_BINDINGS[ctx.mode];
  if (binding === undefined) return null;
  if (options.light === true) {
    return options.lightPrint === true && unattendedPolicyForContext(ctx).noApprover !== true
      ? lightPrintPermissionsSection(ctx, authority)
      : lightPermissionsSection(ctx, authority);
  }

  const sandboxText = renderSandbox(
    sandboxTemplateForPolicy(authority.sandboxPolicy),
    authority.networkSandboxPolicy.enabled === true ? "enabled" : "restricted",
  );
  // Approval text constants keep their trailing `\n` from the upstream
  // file. Strip it so the outer joiner controls spacing.
  const approvalText = (bypassGrantsEscalation(ctx, authority)
    ? APPROVAL_POLICY_BYPASS_ESCALATION
    : binding.approvalText).replace(/\n+$/, "");

  const heading = `# Permission Mode: ${binding.label}`;
  // A routine that keeps acceptEdits or bypassPermissions runs on a schedule
  // with nobody attached. It keeps its mode's text, but the bypass autonomy
  // note (which offers AskUserQuestion) gives way to what is true here.
  const routineNote = unattendedPolicyForContext(ctx).noApprover === true
    ? ROUTINE_NO_APPROVER_NOTE
    : undefined;
  return [heading, sandboxText, approvalText]
    .concat(
      routineNote !== undefined
        ? [routineNote]
        : binding.autonomyNote !== undefined
          ? [binding.autonomyNote]
          : [],
    )
    .join("\n\n");
}

/**
 * Appended for a routine run that keeps acceptEdits or bypassPermissions
 * (unattended policy `noApprover`). Nothing can be approved while it runs.
 */
export const ROUTINE_NO_APPROVER_NOTE =
  "This routine runs on a schedule with nobody attached. What this permission mode allows proceeds without asking. Anything that would need approval is refused, not paused: that includes asking the user a question, handing over a plan, and requesting escalated sandbox permissions. Files may be written only inside the routine's workspace. Do not retry a refused call; finish what the mode allows and report what you could not do.";

// ─────────────────────────────────────────────────────────────────────
// Light renderings. Light resends this section after the cached prefix of
// every model call. These texts carry the same mode, sandbox, network and
// approval rules as the canonical texts above in fewer words; Standard
// sessions keep the canonical texts.
// ─────────────────────────────────────────────────────────────────────

const LIGHT_SANDBOX_TEXT: Readonly<Record<SandboxPolicy, string>> = {
  danger_full_access:
    "Sandbox danger-full-access: no filesystem sandboxing; all commands are permitted.",
  workspace_write:
    "Sandbox workspace-write: commands may read files and edit files in cwd and writable_roots; editing files elsewhere requires approval.",
  read_only: "Sandbox read-only: commands may only read files.",
  external_sandbox:
    "Sandbox external-sandbox: an external authority controls it, and AgenC does not widen or replace it.",
};

export const LIGHT_APPROVAL_UNLESS_TRUSTED =
  "Approval policy unless-trusted: most commands are escalated for user approval, apart from a short allowlist of safe read commands.";

export const LIGHT_APPROVAL_ON_FAILURE =
  "Approval policy on-failure: commands run in the sandbox; a command that fails there is escalated for user approval to run again without it.";

export const LIGHT_APPROVAL_ON_REQUEST = [
  "Approval policy on-request: a command runs outside the sandbox only when the user approves it or an existing rule allows it.",
  "Rules are checked per segment of a command split at |, &&, ||, ; and subshells; segments with redirection, substitution, environment assignments or wildcards never match a rule.",
  "To escalate, call exec_command with sandbox_permissions \"require_escalated\" and justification as a short question for the user, such as \"Do you want to install this project's dependencies?\". Do not message the user first.",
  "Escalate when the task needs it: writing where the sandbox forbids (such as tests writing to /var), GUI apps (open, xdg-open, osascript), an important command failing from the sandbox or its network limits (DNS, registry or dependency downloads), or a destructive command such as rm or git reset that the user did not ask for. Do not work around approvals with other tools.",
  "An optional prefix_rule offers a reusable approval: keep it categorical and narrow, such as [\"npm\", \"run\", \"dev\"] or [\"cargo\", \"test\"]; never a broad interpreter prefix such as [\"python3\"], never for rm or other destructive commands, never for a heredoc or herestring.",
].join(" ");

export const LIGHT_APPROVAL_NEVER =
  "Approval policy never: do not provide sandbox_permissions; such commands are rejected.";

/** Light rendering of APPROVAL_POLICY_BYPASS_ESCALATION. */
export const LIGHT_APPROVAL_BYPASS_ESCALATION =
  "Approval policy never: bypass mode pre-approves leaving the sandbox. For a command the sandbox blocks (GUI apps such as open or xdg-open, writes it forbids, blocked network), call exec_command with sandbox_permissions \"require_escalated\" and a one-line justification; it runs outside the sandbox without asking. Do not work around the sandbox another way.";

/**
 * Bypass grants an escalation only where there is a sandbox AgenC can lift
 * and somebody chose the mode: a scheduled routine never leaves its sandbox,
 * and danger-full-access or an external sandbox leaves nothing to lift.
 */
function bypassGrantsEscalation(
  ctx: ToolPermissionContext,
  authority: PermissionPromptExecutionAuthority,
): boolean {
  return ctx.mode === "bypassPermissions" &&
    unattendedPolicyForContext(ctx).noApprover !== true &&
    (authority.sandboxPolicy === "workspace_write" || authority.sandboxPolicy === "read_only");
}

/**
 * Light's head has no section titled 'Executing actions with care', so this
 * note refers to its action rules directly. Same terms as
 * BYPASS_AUTONOMY_NOTE.
 */
export const LIGHT_BYPASS_AUTONOMY_NOTE =
  "Tool calls are pre-approved: do not ask for tool permission or plan approval, and do not pause to confirm local, reversible work. The action rules above still apply: destructive, irreversible, shared-system or externally visible actions need the user's explicit request. If the task is genuinely ambiguous, ask one question with AskUserQuestion; when the requested work is done and verified, stop and report.";

const LIGHT_APPROVAL_TEXT: Partial<Record<PermissionMode, string>> = {
  plan: LIGHT_APPROVAL_UNLESS_TRUSTED,
  default: LIGHT_APPROVAL_ON_REQUEST,
  acceptEdits: LIGHT_APPROVAL_ON_FAILURE,
  bypassPermissions: LIGHT_APPROVAL_NEVER,
};

const LIGHT_PRINT_SANDBOX_TEXT: Readonly<Record<SandboxPolicy, string>> = {
  danger_full_access: "no filesystem sandbox",
  workspace_write: "read files; write only cwd and writable_roots",
  read_only: "read files only",
  external_sandbox: "externally controlled; never widen or replace it",
};

function lightPrintPermissionsSection(
  ctx: ToolPermissionContext,
  authority: PermissionPromptExecutionAuthority,
): string | null {
  const binding = MODE_BINDINGS[ctx.mode];
  if (binding === undefined) return null;
  const sandbox = authority.sandboxPolicy.replaceAll("_", "-");
  const network = authority.networkSandboxPolicy.enabled === true ? "enabled" : "restricted";
  return [
    `Permission mode: ${binding.label}. Sandbox ${sandbox}: ${LIGHT_PRINT_SANDBOX_TEXT[authority.sandboxPolicy]}; network ${network}.`,
    "No approver: approval requests are denied. Do not bypass restrictions.",
    ...(ctx.mode === "bypassPermissions" ? [LIGHT_APPROVAL_NEVER] : []),
  ].join("\n");
}

function lightPermissionsSection(
  ctx: ToolPermissionContext,
  authority: PermissionPromptExecutionAuthority,
): string | null {
  const binding = MODE_BINDINGS[ctx.mode];
  const approvalText = bypassGrantsEscalation(ctx, authority)
    ? LIGHT_APPROVAL_BYPASS_ESCALATION
    : LIGHT_APPROVAL_TEXT[ctx.mode];
  if (binding === undefined || approvalText === undefined) return null;
  const network = authority.networkSandboxPolicy.enabled === true ? "enabled" : "restricted";
  const note = unattendedPolicyForContext(ctx).noApprover === true
    ? ROUTINE_NO_APPROVER_NOTE
    : binding.autonomyNote !== undefined
      ? LIGHT_BYPASS_AUTONOMY_NOTE
      : undefined;
  return [
    `Permission mode: ${binding.label}. ${LIGHT_SANDBOX_TEXT[authority.sandboxPolicy]} Network access is ${network}.`,
    approvalText,
    ...(note !== undefined ? [note] : []),
  ].join("\n");
}
