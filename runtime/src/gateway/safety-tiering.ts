import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

import type { EffectFilesystemSnapshot, EffectTarget } from "../workflow/effects.js";
import type {
  ExecutionEffectClass,
} from "../workflow/execution-envelope.js";
import { classifyToolGovernance } from "../policy/tool-governance.js";

export type GatewayApprovalMode =
  | "safe_local_dev"
  | "trusted_operator"
  | "unattended_background"
  | "benchmark";

export type ApprovalRiskLevel = "low" | "medium" | "high" | "critical";

export type TargetSensitivity =
  | "none"
  | "workspace"
  | "protected_workspace"
  | "host"
  | "process"
  | "server"
  | "desktop"
  | "financial"
  | "network"
  | "untrusted_mcp";

export type EffectApprovalReasonCode =
  | "read_only_effect"
  | "workspace_scaffold"
  | "workspace_write"
  | "workspace_destructive_mutation"
  | "protected_workspace_mutation"
  | "host_mutation"
  | "shell_read_only"
  | "shell_mutation"
  | "shell_open_world"
  | "desktop_read_only"
  | "desktop_automation"
  | "process_control"
  | "server_control"
  | "credential_secret_access"
  | "irreversible_financial_action"
  | "untrusted_mcp_tool";

interface ApprovalSafetyAssessment {
  readonly reasonCode: EffectApprovalReasonCode;
  readonly riskLevel: ApprovalRiskLevel;
  readonly targetSensitivity: TargetSensitivity;
  readonly destructive: boolean;
  readonly openWorld: boolean;
  readonly workspaceScoped: boolean;
  readonly shellIntent?: "read_only" | "mutating" | "open_world" | "unknown";
}

interface ApprovalSafetyAssessmentInput {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly effectClass?: ExecutionEffectClass;
  readonly effectKind?: string;
  readonly targets?: readonly EffectTarget[];
  readonly workspaceRoot?: string;
  readonly preExecutionSnapshots?: readonly Pick<
    EffectFilesystemSnapshot,
    "path" | "exists" | "entryType"
  >[];
  readonly mcpTrustTier?: "trusted" | "review" | "sandboxed" | "untrusted";
}

const PROTECTED_WORKSPACE_SEGMENTS = new Set([
  ".git",
  ".agents",
  ".codex",
  ".agenc",
]);

const PROTECTED_WORKSPACE_BASENAMES = new Set([
  ".env",
  "config.toml",
  "config.json",
  "secrets.json",
]);

const READ_ONLY_SHELL_PREFIXES = [
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "stat",
  "which",
  "whereis",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git rev-parse",
  "env",
  "printenv",
  "node --version",
  "python --version",
  "npm --version",
  "cargo --version",
];

const MUTATING_SHELL_PATTERN =
  /\b(rm|mv|cp|mkdir|touch|chmod|chown|truncate|tee|sed\s+-i|perl\s+-pi|git\s+(?:add|apply|checkout|clean|commit|merge|pull|push|rebase|reset)|npm\s+(?:install|update)|pnpm\s+(?:install|update)|yarn\s+(?:add|install)|cargo\s+add|apt(?:-get)?\s+|brew\s+|kubectl\s+(?:apply|delete)|docker\s+(?:rm|run|stop)|systemctl\s+|killall|pkill|kill\b)/i;

const SHELL_REDIRECTION_PATTERN = /(^|\s)(?:>|>>|1>|2>|&>|tee\b)/;
const OPEN_WORLD_SHELL_PATTERN =
  /\b(curl|wget|fetch|scp|ssh|rsync|nc|ncat)\b/i;

const DESKTOP_CONTROL_TOOL_PATTERN =
  /^(mcp\.peekaboo\.(?:click|type|scroll)|mcp\.macos-automator\.|desktop\.(?:bash|text_editor|process_start))/i;
const DESKTOP_READ_ONLY_TOOL_PATTERN =
  /^(desktop\.screenshot|desktop\.screen_read|mcp\.peekaboo\.screenshot)/i;

function normalizePathCandidate(path: string): string {
  return isAbsolute(path) ? resolvePath(path) : path;
}

function isWorkspacePath(path: string, workspaceRoot?: string): boolean {
  if (!workspaceRoot || !isAbsolute(path)) return false;
  const normalizedRoot = resolvePath(workspaceRoot);
  const normalizedPath = resolvePath(path);
  const rel = relative(normalizedRoot, normalizedPath);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
}

function isProtectedWorkspacePath(path: string, workspaceRoot?: string): boolean {
  if (!workspaceRoot || !isWorkspacePath(path, workspaceRoot)) return false;
  const normalizedRoot = resolvePath(workspaceRoot);
  const normalizedPath = resolvePath(path);
  const rel = relative(normalizedRoot, normalizedPath);
  const segments = rel.split(sep).filter((segment) => segment.length > 0);
  if (segments.some((segment) => PROTECTED_WORKSPACE_SEGMENTS.has(segment))) {
    return true;
  }
  const basename = segments[segments.length - 1];
  return basename ? PROTECTED_WORKSPACE_BASENAMES.has(basename) : false;
}

function inferShellIntent(command: string | undefined): ApprovalSafetyAssessment["shellIntent"] {
  if (!command || command.trim().length === 0) {
    return "unknown";
  }
  const normalized = command.trim();
  const lowered = normalized.toLowerCase();
  if (
    OPEN_WORLD_SHELL_PATTERN.test(normalized) ||
    lowered.includes("http://") ||
    lowered.includes("https://")
  ) {
    return "open_world";
  }
  if (
    MUTATING_SHELL_PATTERN.test(normalized) ||
    SHELL_REDIRECTION_PATTERN.test(normalized)
  ) {
    return "mutating";
  }
  if (
    READ_ONLY_SHELL_PREFIXES.some(
      (prefix) =>
        lowered === prefix || lowered.startsWith(`${prefix} `),
    )
  ) {
    return "read_only";
  }
  return "unknown";
}

function summarizePathSensitivity(paths: readonly string[], workspaceRoot?: string): {
  targetSensitivity: TargetSensitivity;
  workspaceScoped: boolean;
  protectedWorkspace: boolean;
} {
  if (paths.length === 0) {
    return {
      targetSensitivity: "none",
      workspaceScoped: false,
      protectedWorkspace: false,
    };
  }
  let allWorkspace = true;
  let protectedWorkspace = false;
  for (const path of paths) {
    if (!isWorkspacePath(path, workspaceRoot)) {
      allWorkspace = false;
    }
    if (isProtectedWorkspacePath(path, workspaceRoot)) {
      protectedWorkspace = true;
    }
  }
  if (protectedWorkspace) {
    return {
      targetSensitivity: "protected_workspace",
      workspaceScoped: true,
      protectedWorkspace: true,
    };
  }
  if (allWorkspace) {
    return {
      targetSensitivity: "workspace",
      workspaceScoped: true,
      protectedWorkspace: false,
    };
  }
  return {
    targetSensitivity: "host",
    workspaceScoped: false,
    protectedWorkspace: false,
  };
}

function derivePathsFromArgs(args: Record<string, unknown>): string[] {
  const keys = [
    "path",
    "target",
    "destination",
    "dest",
    "directory",
    "outputPath",
    "workspacePath",
    "cwd",
    "workdir",
  ];
  const values = new Set<string>();
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) {
      values.add(normalizePathCandidate(value.trim()));
    }
  }
  return [...values];
}

function inferOverwrite(
  preExecutionSnapshots:
    | readonly Pick<EffectFilesystemSnapshot, "path" | "exists" | "entryType">[]
    | undefined,
): boolean {
  if (!preExecutionSnapshots || preExecutionSnapshots.length === 0) {
    return false;
  }
  return preExecutionSnapshots.some(
    (snapshot) =>
      snapshot.exists === true &&
      (snapshot.entryType === "file" || snapshot.entryType === "directory"),
  );
}

export function assessApprovalSafety(
  input: ApprovalSafetyAssessmentInput,
): ApprovalSafetyAssessment {
  const governance = classifyToolGovernance(input.toolName, input.args);
  const normalizedTargets = (input.targets ?? [])
    .map((target) => target.path)
    .filter((path): path is string => typeof path === "string")
    .map(normalizePathCandidate);
  const targetPaths =
    normalizedTargets.length > 0
      ? normalizedTargets
      : derivePathsFromArgs(input.args);
  const pathSensitivity = summarizePathSensitivity(
    targetPaths,
    input.workspaceRoot,
  );
  const destructiveByKind =
    input.effectKind === "filesystem_delete" ||
    input.effectKind === "filesystem_move";
  const overwrite = inferOverwrite(input.preExecutionSnapshots);

  if (input.mcpTrustTier === "untrusted") {
    return {
      reasonCode: "untrusted_mcp_tool",
      riskLevel: "critical",
      targetSensitivity: "untrusted_mcp",
      destructive: governance.metadata.destructive === true,
      openWorld: governance.metadata.openWorld === true,
      workspaceScoped: false,
    };
  }
  if (input.mcpTrustTier === "sandboxed") {
    return {
      reasonCode: "process_control",
      riskLevel: "high",
      targetSensitivity: "process",
      destructive: true,
      openWorld: false,
      workspaceScoped: false,
    };
  }

  if (governance.policyClass === "irreversible_financial_action") {
    return {
      reasonCode: "irreversible_financial_action",
      riskLevel: "critical",
      targetSensitivity: "financial",
      destructive: true,
      openWorld: false,
      workspaceScoped: false,
    };
  }

  if (DESKTOP_READ_ONLY_TOOL_PATTERN.test(input.toolName)) {
    return {
      reasonCode: "desktop_read_only",
      riskLevel: "low",
      targetSensitivity: "desktop",
      destructive: false,
      openWorld: false,
      workspaceScoped: true,
    };
  }

  if (DESKTOP_CONTROL_TOOL_PATTERN.test(input.toolName)) {
    return {
      reasonCode: "desktop_automation",
      riskLevel: "critical",
      targetSensitivity: "desktop",
      destructive: true,
      openWorld: input.toolName === "desktop.bash",
      workspaceScoped: false,
    };
  }

  if (input.effectClass === "read_only" || governance.access === "read") {
    return {
      reasonCode: "read_only_effect",
      riskLevel: "low",
      targetSensitivity: pathSensitivity.targetSensitivity,
      destructive: false,
      openWorld: governance.metadata.openWorld === true,
      workspaceScoped: pathSensitivity.workspaceScoped,
    };
  }

  if (input.effectClass === "filesystem_scaffold") {
    const protectedMutation =
      pathSensitivity.targetSensitivity === "protected_workspace";
    return {
      reasonCode: protectedMutation
        ? "protected_workspace_mutation"
        : "workspace_scaffold",
      riskLevel: protectedMutation ? "high" : "medium",
      targetSensitivity: pathSensitivity.targetSensitivity,
      destructive: false,
      openWorld: false,
      workspaceScoped: pathSensitivity.workspaceScoped,
    };
  }

  if (input.effectClass === "shell") {
    const command =
      typeof input.args.command === "string"
        ? input.args.command
        : undefined;
    const shellIntent = inferShellIntent(command);
    if (shellIntent === "open_world") {
      return {
        reasonCode: "shell_open_world",
        riskLevel: "critical",
        targetSensitivity: "network",
        destructive: true,
        openWorld: true,
        workspaceScoped: false,
        shellIntent,
      };
    }
    if (shellIntent === "read_only") {
      return {
        reasonCode: "shell_read_only",
        riskLevel: "medium",
        targetSensitivity: pathSensitivity.targetSensitivity,
        destructive: false,
        openWorld: false,
        workspaceScoped: pathSensitivity.workspaceScoped,
        shellIntent,
      };
    }
    return {
      reasonCode: "shell_mutation",
      riskLevel:
        pathSensitivity.targetSensitivity === "workspace" ? "high" : "critical",
      targetSensitivity: pathSensitivity.targetSensitivity,
      destructive: true,
      openWorld: false,
      workspaceScoped: pathSensitivity.workspaceScoped,
      shellIntent,
    };
  }

  if (governance.policyClass === "credential_secret_access") {
    return {
      reasonCode: "credential_secret_access",
      riskLevel: "critical",
      targetSensitivity: pathSensitivity.targetSensitivity,
      destructive: governance.metadata.processMutation === true,
      openWorld: governance.metadata.openWorld === true,
      workspaceScoped: pathSensitivity.workspaceScoped,
    };
  }

  if (input.effectKind === "process_start") {
    return {
      reasonCode: "process_control",
      riskLevel: "high",
      targetSensitivity: "process",
      destructive: true,
      openWorld: governance.metadata.openWorld === true,
      workspaceScoped: false,
    };
  }

  if (input.effectKind === "server_start") {
    return {
      reasonCode: "server_control",
      riskLevel: "high",
      targetSensitivity: "server",
      destructive: true,
      openWorld: true,
      workspaceScoped: false,
    };
  }

  if (
    destructiveByKind ||
    overwrite ||
    governance.policyClass === "destructive_side_effect"
  ) {
    const protectedMutation =
      pathSensitivity.targetSensitivity === "protected_workspace";
    const reasonCode = protectedMutation
      ? "protected_workspace_mutation"
      : pathSensitivity.targetSensitivity === "workspace"
        ? "workspace_destructive_mutation"
        : "host_mutation";
    return {
      reasonCode,
      riskLevel: protectedMutation
        ? "critical"
        : pathSensitivity.targetSensitivity === "workspace"
          ? "high"
          : "critical",
      targetSensitivity: pathSensitivity.targetSensitivity,
      destructive: true,
      openWorld: governance.metadata.openWorld === true,
      workspaceScoped: pathSensitivity.workspaceScoped,
    };
  }

  if (pathSensitivity.targetSensitivity === "protected_workspace") {
    return {
      reasonCode: "protected_workspace_mutation",
      riskLevel: "high",
      targetSensitivity: pathSensitivity.targetSensitivity,
      destructive: false,
      openWorld: governance.metadata.openWorld === true,
      workspaceScoped: true,
    };
  }

  if (pathSensitivity.targetSensitivity === "host") {
    return {
      reasonCode: "host_mutation",
      riskLevel: "critical",
      targetSensitivity: "host",
      destructive: false,
      openWorld: governance.metadata.openWorld === true,
      workspaceScoped: false,
    };
  }

  return {
    reasonCode: "workspace_write",
    riskLevel: "medium",
    targetSensitivity: pathSensitivity.targetSensitivity,
    destructive: false,
    openWorld: governance.metadata.openWorld === true,
    workspaceScoped: pathSensitivity.workspaceScoped,
  };
}
