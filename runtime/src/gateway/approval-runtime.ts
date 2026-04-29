import {
  type ApprovalEngineConfig,
  buildDefaultApprovalRules,
  type ApprovalRule,
} from './approvals.js';
import { createEffectApprovalPolicy } from './effect-approval-policy.js';
import { buildMCPApprovalRules } from '../policy/mcp-governance.js';
import { mapGatewayApprovalMode } from './daemon-policy-mapping.js';
import type {
  GatewayApprovalConfig,
  GatewayMCPServerConfig,
} from './types.js';

export function approvalsEnabled(
  approvals: GatewayApprovalConfig | undefined,
): boolean {
  return approvals?.enabled === true;
}

export function resolveGatewayApprovalRules(params: {
  approvals?: GatewayApprovalConfig;
  mcpServers?: readonly GatewayMCPServerConfig[];
}): ApprovalRule[] {
  if (!approvalsEnabled(params.approvals)) {
    return [];
  }

  return [
    ...buildDefaultApprovalRules({
      gateDesktopAutomation: params.approvals?.gateDesktopAutomation === true,
    }),
    ...buildMCPApprovalRules(params.mcpServers),
  ];
}

export function resolveGatewayApprovalEngineConfig(params: {
  approvals?: GatewayApprovalConfig;
  mcpServers?: readonly GatewayMCPServerConfig[];
  workspaceRoot?: string;
}): Pick<
  ApprovalEngineConfig,
  | "rules"
  | "effectPolicy"
  | "timeoutMs"
  | "defaultSlaMs"
  | "defaultEscalationDelayMs"
  | "resolverSigningKey"
> | null {
  if (!approvalsEnabled(params.approvals)) {
    return null;
  }

  return {
    rules: resolveGatewayApprovalRules(params),
    effectPolicy: createEffectApprovalPolicy({
      mode: mapGatewayApprovalMode(params.approvals),
      workspaceRoot: params.workspaceRoot,
      mcpServers: params.mcpServers,
    }),
    timeoutMs: params.approvals?.timeoutMs,
    defaultSlaMs: params.approvals?.defaultSlaMs,
    defaultEscalationDelayMs: params.approvals?.defaultEscalationDelayMs,
  };
}
