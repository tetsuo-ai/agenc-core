import { describe, expect, test } from "vitest";

import { networkPolicyAmendment } from "../permissions/review-decision.js";
import {
  allowNetworkDecision,
  askNetworkDecision,
  blockedRequest,
  blockedRequestObserverFrom,
  deniedNetworkPolicyMessage,
  denyNetworkDecision,
  execpolicyNetworkRuleAmendment,
  networkPolicyDeciderFrom,
  networkPolicyDecisionPayloadFromDecision,
  networkApprovalProtocolFromRequestProtocol,
  networkApprovalContextFromPayload,
  noopBlockedRequestObserver,
  notifyBlockedRequest,
  parseNetworkPolicyDecisionPayload,
  type BlockedRequest,
  type BlockedRequestObserver,
  type NetworkPolicyDecider,
  type NetworkPolicyRequest,
  type NetworkPolicyRequestProtocol,
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
    timestamp: 1234,
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

describe("network policy decider contracts", () => {
  const request: NetworkPolicyRequest = {
    protocol: "https_connect",
    host: "api.agenc.tech",
    port: 443,
    clientAddr: "127.0.0.1",
    method: "CONNECT",
    command: "curl api.agenc.tech",
    execPolicyHint: "network approval",
  };

  test("function deciders can ask, deny, or allow", async () => {
    const ask = networkPolicyDeciderFrom((req) =>
      askNetworkDecision(`approval required for ${req.host}`),
    );
    const askDecision = await ask.decide(request);
    expect(askDecision).toEqual({
      decision: "ask",
      source: "decider",
      reason: "approval required for api.agenc.tech",
    });
    expect(
      networkPolicyDecisionPayloadFromDecision(askDecision, request),
    ).toEqual({
      decision: "ask",
      source: "decider",
      reason: "approval required for api.agenc.tech",
      protocol: "https",
      host: "api.agenc.tech",
      port: 443,
    });

    const deny = networkPolicyDeciderFrom(() => denyNetworkDecision(""));
    expect(await deny.decide(request)).toEqual({
      decision: "deny",
      source: "decider",
      reason: "denied",
    });
    expect(denyNetworkDecision("   ")).toEqual({
      decision: "deny",
      source: "decider",
      reason: "   ",
    });

    const allow = networkPolicyDeciderFrom(() => allowNetworkDecision());
    expect(
      networkPolicyDecisionPayloadFromDecision(await allow.decide(request), request),
    ).toBeNull();
  });

  test("object deciders preserve async decide implementations", async () => {
    const decider: NetworkPolicyDecider = {
      async decide(req) {
        return denyNetworkDecision(`blocked ${req.protocol}`, "mode_guard");
      },
    };

    await expect(networkPolicyDeciderFrom(decider).decide(request)).resolves.toEqual({
      decision: "deny",
      source: "mode_guard",
      reason: "blocked https_connect",
    });
  });

  test("request protocols preserve proxy labels before approval normalization", () => {
    const protocols: ReadonlyArray<{
      readonly request: NetworkPolicyRequestProtocol;
      readonly approval: "http" | "https" | "socks5-tcp" | "socks5-udp";
    }> = [
      { request: "http", approval: "http" },
      { request: "https_connect", approval: "https" },
      { request: "socks5_tcp", approval: "socks5-tcp" },
      { request: "socks5_udp", approval: "socks5-udp" },
    ];

    for (const { request: protocol, approval } of protocols) {
      const networkRequest: NetworkPolicyRequest = {
        protocol,
        host: "api.agenc.tech",
        port: protocol === "http" ? 80 : 443,
      };

      expect(networkRequest.protocol).toBe(protocol);
      expect(networkApprovalProtocolFromRequestProtocol(protocol)).toBe(approval);
      expect(
        networkPolicyDecisionPayloadFromDecision(
          askNetworkDecision("approval required"),
          networkRequest,
        )?.protocol,
      ).toBe(approval);
    }
  });
});

describe("blocked request observers", () => {
  test("blocked request records receive a timestamp", () => {
    expect(
      blockedRequest({
        host: "api.agenc.tech",
        reason: "not_allowed",
        protocol: "https",
        decision: "deny",
        source: "baseline_policy",
        port: 443,
        timestamp: 1234,
      }),
    ).toEqual({
      host: "api.agenc.tech",
      reason: "not_allowed",
      protocol: "https",
      decision: "deny",
      source: "baseline_policy",
      port: 443,
      timestamp: 1234,
    });

    expect(
      blockedRequest({
        host: "api.agenc.tech",
        reason: "not_allowed",
        protocol: "https",
      }).timestamp,
    ).toEqual(expect.any(Number));
  });

  test("function and object observers receive blocked requests", async () => {
    const entry = blockedRequest({
      host: "api.agenc.tech",
      reason: "not_allowed",
      protocol: "https",
      timestamp: 1234,
    });
    const observed: BlockedRequest[] = [];

    await notifyBlockedRequest(
      blockedRequestObserverFrom((request) => observed.push(request)),
      entry,
    );

    const observer: BlockedRequestObserver = {
      async onBlockedRequest(request) {
        observed.push({ ...request, reason: "async-observed" });
      },
    };
    await notifyBlockedRequest(blockedRequestObserverFrom(observer), entry);
    await notifyBlockedRequest(noopBlockedRequestObserver, entry);
    await notifyBlockedRequest(undefined, entry);

    expect(observed).toEqual([
      entry,
      { ...entry, reason: "async-observed" },
    ]);
    expect(observed.map((request) => request.timestamp)).toEqual([1234, 1234]);
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
      protocol: "socks5_udp",
      decision: "forbidden",
      justification: "Deny socks5_udp access to api.agenc.tech",
    });

    expect(
      execpolicyNetworkRuleAmendment(
        review.amendment,
        { host: "api.agenc.tech", protocol: "socks5-tcp" },
        "api.agenc.tech",
      ).protocol,
    ).toBe("socks5_tcp");
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
