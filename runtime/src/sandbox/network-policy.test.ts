import { describe, expect, test } from "vitest";

import { networkPolicyAmendment } from "../permissions/review-decision.js";
import {
  deniedNetworkPolicyMessage,
  execpolicyNetworkRuleAmendment,
  networkApprovalContextFromPayload,
  parseNetworkPolicyDecisionPayload,
  type BlockedRequest,
} from "./network-policy.js";

describe("network policy decision payloads", () => {
  test("approval context requires ask decisions from the decider", () => {
    expect(
      networkApprovalContextFromPayload({
        decision: "deny",
        source: "decider",
        protocol: "https",
        host: "api.agenc.tech",
      }),
    ).toBeNull();
    expect(
      networkApprovalContextFromPayload({
        decision: "ask",
        source: "baseline_policy",
        protocol: "https",
        host: "api.agenc.tech",
      }),
    ).toBeNull();
  });

  test("approval context maps protocol aliases and trims host", () => {
    const payload = parseNetworkPolicyDecisionPayload({
      decision: "ask",
      source: "decider",
      protocol: "https_connect",
      host: "  api.agenc.tech  ",
      reason: "not_allowed",
      port: 443,
    });

    expect(networkApprovalContextFromPayload(payload)).toEqual({
      host: "api.agenc.tech",
      protocol: "https",
    });

    expect(
      parseNetworkPolicyDecisionPayload({
        decision: "ask",
        source: "decider",
        protocol: "http-connect",
        host: "api.agenc.tech",
      }).protocol,
    ).toBe("https");
    expect(
      parseNetworkPolicyDecisionPayload({
        decision: "ask",
        source: "decider",
        protocol: "socks5_tcp",
        host: "api.agenc.tech",
      }).protocol,
    ).toBe("socks5-tcp");
    expect(
      parseNetworkPolicyDecisionPayload({
        decision: "ask",
        source: "decider",
        protocol: "socks5_udp",
        host: "api.agenc.tech",
      }).protocol,
    ).toBe("socks5-udp");
  });

  test("approval context rejects missing protocol and blank host", () => {
    expect(
      networkApprovalContextFromPayload({
        decision: "ask",
        source: "decider",
        host: "api.agenc.tech",
      }),
    ).toBeNull();
    expect(
      networkApprovalContextFromPayload({
        decision: "ask",
        source: "decider",
        protocol: "http",
        host: "   ",
      }),
    ).toBeNull();
  });

  test("invalid payload fields throw", () => {
    expect(() =>
      parseNetworkPolicyDecisionPayload({
        decision: "allow",
        source: "decider",
      }),
    ).toThrow(/decision must be ask or deny/);
    expect(() =>
      parseNetworkPolicyDecisionPayload({
        decision: "ask",
        source: "operator",
      }),
    ).toThrow(/source is invalid/);
    expect(() =>
      parseNetworkPolicyDecisionPayload({
        decision: "ask",
        source: "decider",
        protocol: "ftp",
      }),
    ).toThrow(/protocol is invalid/);
  });
});

describe("denied network policy messages", () => {
  const baseBlocked: BlockedRequest = {
    host: "api.agenc.tech",
    reason: "not_allowed",
    method: "GET",
    protocol: "http",
    decision: "deny",
    source: "baseline_policy",
    port: 80,
  };

  test("only deny decisions produce messages", () => {
    expect(
      deniedNetworkPolicyMessage({ ...baseBlocked, decision: "ask" }),
    ).toBeNull();
  });

  test("known reasons produce explicit text", () => {
    expect(
      deniedNetworkPolicyMessage({ ...baseBlocked, reason: "denied" }),
    ).toBe(
      'Network access to "api.agenc.tech" was blocked: domain is explicitly denied by policy and cannot be approved from this prompt.',
    );
    expect(
      deniedNetworkPolicyMessage({
        ...baseBlocked,
        reason: "not_allowed_local",
      }),
    ).toBe(
      'Network access to "api.agenc.tech" was blocked: local/private network addresses are blocked by the sandbox policy.',
    );
    expect(
      deniedNetworkPolicyMessage({
        ...baseBlocked,
        reason: "method_not_allowed",
      }),
    ).toBe(
      'Network access to "api.agenc.tech" was blocked: request method is blocked by the current network mode.',
    );
    expect(
      deniedNetworkPolicyMessage({
        ...baseBlocked,
        reason: "proxy_disabled",
      }),
    ).toBe(
      'Network access to "api.agenc.tech" was blocked: network proxy is disabled.',
    );
  });

  test("empty host uses the generic blocked message", () => {
    expect(deniedNetworkPolicyMessage({ ...baseBlocked, host: " " })).toBe(
      "Network access was blocked by policy.",
    );
  });
});

describe("network policy amendments", () => {
  test("permission-layer amendments map to exec-policy rule amendments", () => {
    const review = networkPolicyAmendment({
      action: "deny",
      host: "api.agenc.tech",
      protocol: "socks5-udp",
    });

    expect(review.kind).toBe("network_policy_amendment");
    if (review.kind !== "network_policy_amendment") return;

    expect(
      execpolicyNetworkRuleAmendment(
        review.amendment,
        { host: "api.agenc.tech", protocol: "socks5-udp" },
        "api.agenc.tech",
      ),
    ).toEqual({
      protocol: "socks5-udp",
      decision: "forbidden",
      justification: "Deny socks5_udp access to api.agenc.tech",
    });
  });

  test("allow amendments produce allow justifications", () => {
    expect(
      execpolicyNetworkRuleAmendment(
        { action: "allow", host: "api.agenc.tech" },
        { host: "api.agenc.tech", protocol: "https" },
        "api.agenc.tech",
      ),
    ).toEqual({
      protocol: "https",
      decision: "allow",
      justification: "Allow https_connect access to api.agenc.tech",
    });
  });
});
