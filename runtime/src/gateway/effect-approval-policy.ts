import type { GatewayMCPServerConfig } from "./types.js";
import type { ApprovalEffectRef } from "./approvals.js";
import {
  assessApprovalSafety,
  type ApprovalRiskLevel,
  type EffectApprovalReasonCode,
  type GatewayApprovalMode,
} from "./safety-tiering.js";

export interface EffectApprovalOutcome {
  readonly status: "allow" | "require_approval" | "deny";
  readonly source: "effect_policy";
  readonly reasonCode: EffectApprovalReasonCode;
  readonly riskLevel: ApprovalRiskLevel;
  readonly approvalScopeKey: string;
  readonly message: string;
  readonly autoApprovedReasonCode?: EffectApprovalReasonCode;
  readonly approverGroup?: string;
  readonly approverRoles?: readonly string[];
}

export interface EffectApprovalPolicyInput {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly subagentSessionId?: string;
  readonly effect?: ApprovalEffectRef;
}

export interface EffectApprovalPolicy {
  readonly mode: GatewayApprovalMode;
  evaluate(input: EffectApprovalPolicyInput): EffectApprovalOutcome;
}

const REASON_MESSAGE: Record<EffectApprovalReasonCode, string> = {
  read_only_effect: "Read-only effect",
  workspace_scaffold: "Workspace scaffold mutation",
  workspace_write: "Workspace file mutation",
  workspace_destructive_mutation: "Destructive workspace mutation",
  protected_workspace_mutation: "Protected workspace mutation",
  host_mutation: "Host filesystem mutation",
  shell_read_only: "Read-only shell command",
  shell_mutation: "Shell command with mutation risk",
  shell_open_world: "Shell command with network or open-world side effects",
  desktop_read_only: "Read-only desktop action",
  desktop_automation: "Desktop automation action",
  process_control: "Process control action",
  server_control: "Server control action",
  credential_secret_access: "Secret or credential access surface",
  irreversible_financial_action: "Irreversible financial action",
  untrusted_mcp_tool: "Untrusted MCP tool invocation",
};

function deriveMcpTrustTier(
  toolName: string,
  servers: readonly GatewayMCPServerConfig[] | undefined,
): "trusted" | "review" | "sandboxed" | "untrusted" | undefined {
  if (!toolName.startsWith("mcp.")) return undefined;
  const [, serverName] = toolName.split(".");
  if (!serverName) return undefined;
  const server = servers?.find((entry) => entry.name === serverName);
  return server?.trustTier;
}

function looksLikePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/")
  );
}

function buildApprovalScopeKey(params: {
  readonly toolName: string;
  readonly reasonCode: EffectApprovalReasonCode;
  readonly riskLevel: ApprovalRiskLevel;
  readonly effect?: ApprovalEffectRef;
}): string {
  const targetSummary =
    params.effect?.targets && params.effect.targets.length > 0
      ? params.effect.targets.slice().sort().join("|")
      : "no-target";
  return [
    "effect-policy",
    params.reasonCode,
    params.riskLevel,
    params.effect?.effectClass ?? "unknown-class",
    params.effect?.effectKind ?? "unknown-kind",
    params.toolName,
    targetSummary,
  ].join(":");
}

function buildMessage(params: {
  readonly base: string;
  readonly input: EffectApprovalPolicyInput;
}): string {
  const fragments = [params.base];
  if (params.input.effect?.summary) {
    fragments.push(`Effect: ${params.input.effect.summary}`);
  }
  if (params.input.parentSessionId) {
    fragments.push(`Parent session: ${params.input.parentSessionId}`);
  }
  if (params.input.subagentSessionId) {
    fragments.push(`Sub-agent session: ${params.input.subagentSessionId}`);
  }
  return fragments.join("\n");
}

function allow(
  input: EffectApprovalPolicyInput,
  params: {
    readonly reasonCode: EffectApprovalReasonCode;
    readonly riskLevel: ApprovalRiskLevel;
    readonly riskyAutoApproval?: boolean;
  },
): EffectApprovalOutcome {
  return {
    status: "allow",
    source: "effect_policy",
    reasonCode: params.reasonCode,
    riskLevel: params.riskLevel,
    approvalScopeKey: buildApprovalScopeKey({
      toolName: input.toolName,
      reasonCode: params.reasonCode,
      riskLevel: params.riskLevel,
      effect: input.effect,
    }),
    message: buildMessage({
      base: REASON_MESSAGE[params.reasonCode],
      input,
    }),
    ...(params.riskyAutoApproval
      ? { autoApprovedReasonCode: params.reasonCode }
      : {}),
  };
}

function requireApproval(
  input: EffectApprovalPolicyInput,
  params: {
    readonly reasonCode: EffectApprovalReasonCode;
    readonly riskLevel: ApprovalRiskLevel;
    readonly approverGroup?: string;
    readonly approverRoles?: readonly string[];
  },
): EffectApprovalOutcome {
  return {
    status: "require_approval",
    source: "effect_policy",
    reasonCode: params.reasonCode,
    riskLevel: params.riskLevel,
    approvalScopeKey: buildApprovalScopeKey({
      toolName: input.toolName,
      reasonCode: params.reasonCode,
      riskLevel: params.riskLevel,
      effect: input.effect,
    }),
    message: buildMessage({
      base: `Approval required: ${REASON_MESSAGE[params.reasonCode]}`,
      input,
    }),
    ...(params.approverGroup ? { approverGroup: params.approverGroup } : {}),
    ...(params.approverRoles && params.approverRoles.length > 0
      ? { approverRoles: params.approverRoles }
      : {}),
  };
}

function deny(
  input: EffectApprovalPolicyInput,
  params: {
    readonly reasonCode: EffectApprovalReasonCode;
    readonly riskLevel: ApprovalRiskLevel;
  },
): EffectApprovalOutcome {
  return {
    status: "deny",
    source: "effect_policy",
    reasonCode: params.reasonCode,
    riskLevel: params.riskLevel,
    approvalScopeKey: buildApprovalScopeKey({
      toolName: input.toolName,
      reasonCode: params.reasonCode,
      riskLevel: params.riskLevel,
      effect: input.effect,
    }),
    message: buildMessage({
      base: `Denied by approval policy: ${REASON_MESSAGE[params.reasonCode]}`,
      input,
    }),
  };
}

export function createEffectApprovalPolicy(params: {
  readonly mode?: GatewayApprovalMode;
  readonly workspaceRoot?: string;
  readonly mcpServers?: readonly GatewayMCPServerConfig[];
}): EffectApprovalPolicy {
  const mode = params.mode ?? "safe_local_dev";

  return {
    mode,
    evaluate(input: EffectApprovalPolicyInput): EffectApprovalOutcome {
      const trustTier = deriveMcpTrustTier(input.toolName, params.mcpServers);
      const assessment = assessApprovalSafety({
        toolName: input.toolName,
        args: input.args,
        effectClass: input.effect?.effectClass as
          | "read_only"
          | "filesystem_write"
          | "filesystem_scaffold"
          | "shell"
          | "mixed"
          | undefined,
        effectKind: input.effect?.effectKind,
        targets: input.effect?.targets
          ?.filter((target) => looksLikePath(target))
          .map((target) => ({ kind: "path", path: target })),
        workspaceRoot: params.workspaceRoot,
        preExecutionSnapshots: input.effect?.preExecutionSnapshots,
        ...(trustTier ? { mcpTrustTier: trustTier } : {}),
      });

      if (assessment.reasonCode === "untrusted_mcp_tool") {
        return requireApproval(input, {
          reasonCode: assessment.reasonCode,
          riskLevel: assessment.riskLevel,
          approverGroup: "security-review",
          approverRoles: ["security", "admin"],
        });
      }

      switch (mode) {
        case "trusted_operator": {
          if (
            assessment.reasonCode === "read_only_effect" ||
            assessment.reasonCode === "desktop_read_only" ||
            assessment.reasonCode === "workspace_scaffold" ||
            assessment.reasonCode === "workspace_write"
          ) {
            return allow(input, {
              reasonCode: assessment.reasonCode,
              riskLevel: assessment.riskLevel,
            });
          }
          if (assessment.reasonCode === "shell_read_only") {
            return allow(input, {
              reasonCode: assessment.reasonCode,
              riskLevel: assessment.riskLevel,
              riskyAutoApproval: true,
            });
          }
          return requireApproval(input, {
            reasonCode: assessment.reasonCode,
            riskLevel: assessment.riskLevel,
          });
        }

        case "unattended_background": {
          if (
            assessment.reasonCode === "read_only_effect" ||
            assessment.reasonCode === "desktop_read_only" ||
            assessment.reasonCode === "workspace_scaffold" ||
            assessment.reasonCode === "workspace_write"
          ) {
            return allow(input, {
              reasonCode: assessment.reasonCode,
              riskLevel: assessment.riskLevel,
            });
          }
          return deny(input, {
            reasonCode: assessment.reasonCode,
            riskLevel: assessment.riskLevel,
          });
        }

        case "benchmark": {
          if (
            assessment.reasonCode === "read_only_effect" ||
            assessment.reasonCode === "desktop_read_only" ||
            assessment.reasonCode === "workspace_scaffold" ||
            assessment.reasonCode === "workspace_write"
          ) {
            return allow(input, {
              reasonCode: assessment.reasonCode,
              riskLevel: assessment.riskLevel,
            });
          }
          if (
            assessment.reasonCode === "shell_read_only" ||
            (assessment.reasonCode === "shell_mutation" &&
              assessment.workspaceScoped &&
              assessment.targetSensitivity === "workspace")
          ) {
            return allow(input, {
              reasonCode: assessment.reasonCode,
              riskLevel: assessment.riskLevel,
              riskyAutoApproval: true,
            });
          }
          return requireApproval(input, {
            reasonCode: assessment.reasonCode,
            riskLevel: assessment.riskLevel,
          });
        }

        case "safe_local_dev":
        default: {
          if (
            assessment.reasonCode === "read_only_effect" ||
            assessment.reasonCode === "desktop_read_only" ||
            assessment.reasonCode === "workspace_scaffold" ||
            assessment.reasonCode === "workspace_write"
          ) {
            return allow(input, {
              reasonCode: assessment.reasonCode,
              riskLevel: assessment.riskLevel,
            });
          }
          return requireApproval(input, {
            reasonCode: assessment.reasonCode,
            riskLevel: assessment.riskLevel,
          });
        }
      }
    },
  };
}
