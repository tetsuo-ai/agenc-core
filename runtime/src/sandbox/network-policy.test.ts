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
        host: "api.service.test",
      }),
    ).toBeNull();
    expect(
      networkApprovalContextFromPayload({
        decision: "ask",
        source: "baseline_policy",
        protocol: "https",
        host: "api.service.test",
      }),
    ).toBeNull();
  });

  test("approval context maps protocol aliases and trims host", () => {
    const payload = parseNetworkPolicyDecisionPayload({
      decision: "ask",
      source: "decider",
      protocol: "https_connect",
      host: "  api.service.test  ",
      reason: "not_allowed",
      port: 443,
    });

    expect(networkApprovalContextFromPayload(payload)).toEqual({
      host: "api.service.test",
      protocol: "https",
    });

    expect(
      parseNetworkPolicyDecisionPayload({
        decision: "ask",
        source: "decider",
        protocol: "http-connect",
        host: "api.service.test",
      }).protocol,
    ).toBe("https");
    expect(
      parseNetworkPolicyDecisionPayload({
        decision: "ask",
        source: "decider",
        protocol: "socks5_tcp",
        host: "api.service.test",
      }).protocol,
    ).toBe("socks5-tcp");
    expect(
      parseNetworkPolicyDecisionPayload({
        decision: "ask",
        source: "decider",
        protocol: "socks5_udp",
        host: "api.service.test",
      }).protocol,
    ).toBe("socks5-udp");
  });

  test("approval context rejects missing protocol and blank host", () => {
    expect(
      networkApprovalContextFromPayload({
        decision: "ask",
        source: "decider",
        host: "api.service.test",
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
    host: "api.service.test",
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
      'Network access to "api.service.test" was blocked: domain is explicitly denied by policy and cannot be approved from this prompt.',
    );
    expect(
      deniedNetworkPolicyMessage({
        ...baseBlocked,
        reason: "not_allowed_local",
      }),
    ).toBe(
      'Network access to "api.service.test" was blocked: local/private network addresses are blocked by the sandbox policy.',
    );
    expect(
      deniedNetworkPolicyMessage({
        ...baseBlocked,
        reason: "method_not_allowed",
      }),
    ).toBe(
      'Network access to "api.service.test" was blocked: request method is blocked by the current network mode.',
    );
    expect(
      deniedNetworkPolicyMessage({
        ...baseBlocked,
        reason: "proxy_disabled",
      }),
    ).toBe(
      'Network access to "api.service.test" was blocked: network proxy is disabled.',
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
      host: "api.service.test",
      protocol: "socks5-udp",
    });

    expect(review.kind).toBe("network_policy_amendment");
    if (review.kind !== "network_policy_amendment") return;

    expect(
      execpolicyNetworkRuleAmendment(
        review.amendment,
        { host: "api.service.test", protocol: "socks5-udp" },
        "api.service.test",
      ),
    ).toEqual({
      protocol: "socks5-udp",
      decision: "forbidden",
      justification: "Deny socks5_udp access to api.service.test",
    });
  });

  test("allow amendments produce allow justifications", () => {
    expect(
      execpolicyNetworkRuleAmendment(
        { action: "allow", host: "api.service.test" },
        { host: "api.service.test", protocol: "https" },
        "api.service.test",
      ),
    ).toEqual({
      protocol: "https",
      decision: "allow",
      justification: "Allow https_connect access to api.service.test",
    });
  });
});
