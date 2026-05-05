import type { NetworkPolicyAmendment } from "../permissions/review-decision.js";

export type NetworkPolicyDecision = "ask" | "deny";
export type NetworkDecisionSource =
  | "baseline_policy"
  | "mode_guard"
  | "proxy_state"
  | "decider";
export type NetworkApprovalProtocol =
  | "http"
  | "https"
  | "socks5-tcp"
  | "socks5-udp";

export interface NetworkPolicyDecisionPayload {
  readonly decision: NetworkPolicyDecision;
  readonly source: NetworkDecisionSource;
  readonly protocol?: NetworkApprovalProtocol;
  readonly host?: string;
  readonly reason?: string;
  readonly port?: number;
}

export interface NetworkApprovalContext {
  readonly host: string;
  readonly protocol: NetworkApprovalProtocol;
}

export interface BlockedRequest {
  readonly host: string;
  readonly reason: string;
  readonly client?: string | null;
  readonly method?: string | null;
  readonly mode?: string | null;
  readonly protocol: string;
  readonly decision?: string | null;
  readonly source?: string | null;
  readonly port?: number | null;
  readonly timestamp?: number;
}

export interface ExecPolicyNetworkRuleAmendment {
  readonly protocol: NetworkApprovalProtocol;
  readonly decision: "allow" | "forbidden";
  readonly justification: string;
}

export function parseNetworkPolicyDecision(
  value: unknown,
): NetworkPolicyDecision | null {
  return value === "deny" || value === "ask" ? value : null;
}

export function parseNetworkDecisionSource(
  value: unknown,
): NetworkDecisionSource | null {
  switch (value) {
    case "baseline_policy":
    case "mode_guard":
    case "proxy_state":
    case "decider":
      return value;
    default:
      return null;
  }
}

export function parseNetworkApprovalProtocol(
  value: unknown,
): NetworkApprovalProtocol | null {
  switch (value) {
    case "http":
      return "http";
    case "https":
    case "https_connect":
    case "http-connect":
      return "https";
    case "socks5-tcp":
    case "socks5_tcp":
      return "socks5-tcp";
    case "socks5-udp":
    case "socks5_udp":
      return "socks5-udp";
    default:
      return null;
  }
}

export function parseNetworkPolicyDecisionPayload(
  value: unknown,
): NetworkPolicyDecisionPayload {
  if (!isPlainRecord(value)) {
    throw new Error("network policy decision payload must be an object");
  }

  const decision = parseNetworkPolicyDecision(value.decision);
  if (decision === null) {
    throw new Error("network policy decision must be ask or deny");
  }
  const source = parseNetworkDecisionSource(value.source);
  if (source === null) {
    throw new Error("network policy decision source is invalid");
  }

  const protocolValue = value.protocol;
  const protocol =
    protocolValue === undefined || protocolValue === null
      ? undefined
      : parseNetworkApprovalProtocol(protocolValue);
  if (protocolValue !== undefined && protocolValue !== null && protocol === null) {
    throw new Error("network approval protocol is invalid");
  }

  return {
    decision,
    source,
    ...(protocol !== undefined && protocol !== null ? { protocol } : {}),
    ...optionalStringField(value, "host"),
    ...optionalStringField(value, "reason"),
    ...optionalPortField(value),
  };
}

export function isAskFromDecider(
  payload: NetworkPolicyDecisionPayload,
): boolean {
  return payload.decision === "ask" && payload.source === "decider";
}

export function networkApprovalContextFromPayload(
  payload: NetworkPolicyDecisionPayload,
): NetworkApprovalContext | null {
  if (!isAskFromDecider(payload)) return null;
  if (payload.protocol === undefined) return null;

  const host = payload.host?.trim();
  if (!host) return null;

  return {
    host,
    protocol: payload.protocol,
  };
}

export function deniedNetworkPolicyMessage(
  blocked: BlockedRequest,
): string | null {
  const decision = parseNetworkPolicyDecision(blocked.decision);
  if (decision !== "deny") return null;

  const host = blocked.host.trim();
  if (host.length === 0) return "Network access was blocked by policy.";

  const detail = deniedReasonDetail(blocked.reason);
  return `Network access to "${host}" was blocked: ${detail}.`;
}

export function execpolicyNetworkRuleAmendment(
  amendment: NetworkPolicyAmendment,
  networkApprovalContext: NetworkApprovalContext,
  host: string,
): ExecPolicyNetworkRuleAmendment {
  const decision = amendment.action === "allow" ? "allow" : "forbidden";
  const actionVerb = amendment.action === "allow" ? "Allow" : "Deny";
  return {
    protocol: networkApprovalContext.protocol,
    decision,
    justification:
      `${actionVerb} ${protocolJustificationLabel(networkApprovalContext.protocol)} ` +
      `access to ${host}`,
  };
}

function deniedReasonDetail(reason: string): string {
  switch (reason) {
    case "denied":
      return "domain is explicitly denied by policy and cannot be approved from this prompt";
    case "not_allowed":
      return "domain is not on the allowlist for the current sandbox mode";
    case "not_allowed_local":
      return "local/private network addresses are blocked by the sandbox policy";
    case "method_not_allowed":
      return "request method is blocked by the current network mode";
    case "proxy_disabled":
      return "network proxy is disabled";
    default:
      return "request is blocked by network policy";
  }
}

function protocolJustificationLabel(protocol: NetworkApprovalProtocol): string {
  switch (protocol) {
    case "http":
      return "http";
    case "https":
      return "https_connect";
    case "socks5-tcp":
      return "socks5_tcp";
    case "socks5-udp":
      return "socks5_udp";
  }
}

function optionalStringField<T extends "host" | "reason">(
  value: Readonly<Record<string, unknown>>,
  field: T,
): Partial<Record<T, string>> {
  const raw = value[field];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") {
    throw new Error(`network policy decision ${field} must be a string`);
  }
  return { [field]: raw } as Partial<Record<T, string>>;
}

function optionalPortField(
  value: Readonly<Record<string, unknown>>,
): { readonly port?: number } {
  const raw = value.port;
  if (raw === undefined || raw === null) return {};
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > 65535
  ) {
    throw new Error("network policy decision port must be a uint16");
  }
  return { port: raw };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
