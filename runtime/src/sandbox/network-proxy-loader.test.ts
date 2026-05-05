import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { parseToml } from "../config/loader.js";
import {
  applyExecPolicyNetworkRules,
  applyNetworkTables,
  buildConfigState,
  buildConfigStateFromLayers,
  buildNetworkProxyState,
  configFromLayers,
  defaultNetworkProxyConfig,
  deniedDomains,
  enforceTrustedConstraints,
  hostPolicyDecision,
  networkConstraintsFromTrustedLayers,
  networkTablesFromToml,
  normalizeHost,
  selectedNetworkFromTables,
  setAllowedDomains,
  setAllowUnixSockets,
  setDeniedDomains,
  type ConfigLayer,
  type NetworkProxyConfig,
} from "./network-proxy-loader.js";

function rawToml(source: string): Record<string, unknown> {
  return parseToml(source) as Record<string, unknown>;
}

function layer(source: ConfigLayer["source"], toml: string): ConfigLayer {
  return { source, config: rawToml(toml) };
}

describe("network proxy loader defaults", () => {
  test("default config starts disabled with loopback proxy endpoints", () => {
    expect(defaultNetworkProxyConfig()).toEqual({
      network: {
        enabled: false,
        proxyUrl: "http://127.0.0.1:3128",
        enableSocks5: true,
        socksUrl: "http://127.0.0.1:8081",
        enableSocks5Udp: true,
        allowUpstreamProxy: true,
        dangerouslyAllowNonLoopbackProxy: false,
        dangerouslyAllowAllUnixSockets: false,
        mode: "full",
        domains: null,
        unixSockets: null,
        allowLocalBinding: false,
        mitm: false,
      },
    });
  });
});

describe("raw network TOML", () => {
  test("selects and applies the default permission profile network table", () => {
    const parsed = networkTablesFromToml(rawToml(`
default_permissions = "workspace"

[permissions.workspace.network]
enabled = true
mode = "limited"
allow_upstream_proxy = false

[permissions.workspace.network.domains]
"api.agenc.tech" = "allow"
"blocked.agenc.tech" = "deny"
`));

    expect(selectedNetworkFromTables(parsed)).toMatchObject({
      enabled: true,
      mode: "limited",
      allowUpstreamProxy: false,
    });

    const config = defaultNetworkProxyConfig();
    applyNetworkTables(config, parsed);
    expect(config.network.enabled).toBe(true);
    expect(config.network.mode).toBe("limited");
    expect(config.network.allowUpstreamProxy).toBe(false);
    expect(buildConfigState(config).allowedDomains).toEqual([
      "api.agenc.tech",
    ]);
    expect(buildConfigState(config).deniedDomains).toEqual([
      "blocked.agenc.tech",
    ]);
  });

  test("malformed network TOML throws instead of silently defaulting", () => {
    expect(() =>
      networkTablesFromToml(rawToml(`
default_permissions = "workspace"

[permissions.workspace.network]
enabled = "yes"
`)),
    ).toThrow(/enabled must be a boolean/);
  });

  test("permission network TOML ignores unsupported mitm field", () => {
    const parsed = networkTablesFromToml(rawToml(`
default_permissions = "workspace"

[permissions.workspace.network]
enabled = true
mitm = true
`));

    const config = defaultNetworkProxyConfig();
    applyNetworkTables(config, parsed);
    expect(config.network.enabled).toBe(true);
    expect(config.network.mitm).toBe(false);
  });

  test("permission network TOML rejects unsupported domain none value", () => {
    expect(() =>
      networkTablesFromToml(rawToml(`
default_permissions = "workspace"

[permissions.workspace.network.domains]
"api.agenc.tech" = "none"
`)),
    ).toThrow(/must be allow or deny/);
  });
});

describe("domain overlays and host decisions", () => {
  test("higher-precedence layers add and override domain entries", () => {
    const config = configFromLayers([
      layer("user", `
default_permissions = "workspace"

[permissions.workspace.network.domains]
"lower.agenc.tech" = "allow"
"shared.agenc.tech" = "deny"
`),
      layer("user", `
default_permissions = "workspace"

[permissions.workspace.network.domains]
"shared.agenc.tech" = "allow"
"higher.agenc.tech" = "allow"
`),
    ]);

    expect(buildConfigState(config).allowedDomains).toEqual([
      "lower.agenc.tech",
      "shared.agenc.tech",
      "higher.agenc.tech",
    ]);
    expect(buildConfigState(config).deniedDomains).toEqual([]);
  });

  test("deny patterns win over allow patterns at decision time", () => {
    const exactDeny = defaultNetworkProxyConfig();
    setAllowedDomains(exactDeny, ["*.agenc.tech"]);
    setDeniedDomains(exactDeny, ["api.agenc.tech"]);
    const exactDenyState = buildConfigState(exactDeny);
    expect(hostPolicyDecision(exactDenyState, "api.agenc.tech")).toEqual({
      kind: "blocked",
      reason: "denied",
    });
    expect(hostPolicyDecision(exactDenyState, "deep.api.agenc.tech")).toEqual({
      kind: "allowed",
    });

    const wildcardDeny = defaultNetworkProxyConfig();
    setAllowedDomains(wildcardDeny, ["api.agenc.tech"]);
    setDeniedDomains(wildcardDeny, ["*.agenc.tech"]);
    expect(hostPolicyDecision(buildConfigState(wildcardDeny), "api.agenc.tech"))
      .toEqual({ kind: "blocked", reason: "denied" });
  });

  test("wildcard semantics match exact, strict subdomain, and apex forms", () => {
    const strict = defaultNetworkProxyConfig();
    setAllowedDomains(strict, ["*.agenc.tech"]);
    const strictState = buildConfigState(strict);
    expect(hostPolicyDecision(strictState, "agenc.tech")).toEqual({
      kind: "blocked",
      reason: "not_allowed",
    });
    expect(hostPolicyDecision(strictState, "api.agenc.tech")).toEqual({
      kind: "allowed",
    });
    expect(hostPolicyDecision(strictState, "deep.api.agenc.tech")).toEqual({
      kind: "allowed",
    });

    const apex = defaultNetworkProxyConfig();
    setAllowedDomains(apex, ["**.agenc.tech"]);
    const apexState = buildConfigState(apex);
    expect(hostPolicyDecision(apexState, "agenc.tech")).toEqual({
      kind: "allowed",
    });
    expect(hostPolicyDecision(apexState, "deep.api.agenc.tech")).toEqual({
      kind: "allowed",
    });
  });

  test.each([
    {
      label: "exact host",
      allowed: ["api.agenc.tech"],
      denied: [],
      host: "api.agenc.tech",
      expected: { kind: "allowed" as const },
    },
    {
      label: "case and trailing-dot normalization",
      allowed: ["api.agenc.tech"],
      denied: [],
      host: "API.agenc.tech.",
      expected: { kind: "allowed" as const },
    },
    {
      label: "star-dot excludes apex",
      allowed: ["*.agenc.tech"],
      denied: [],
      host: "agenc.tech",
      expected: { kind: "blocked" as const, reason: "not_allowed" as const },
    },
    {
      label: "star-dot includes multi-label subdomain",
      allowed: ["*.agenc.tech"],
      denied: [],
      host: "deep.api.agenc.tech",
      expected: { kind: "allowed" as const },
    },
    {
      label: "double-star includes apex",
      allowed: ["**.agenc.tech"],
      denied: [],
      host: "agenc.tech",
      expected: { kind: "allowed" as const },
    },
    {
      label: "empty pattern does not match",
      allowed: [""],
      denied: [],
      host: "api.agenc.tech",
      expected: { kind: "blocked" as const, reason: "not_allowed" as const },
    },
    {
      label: "internal wildcard exact pattern",
      allowed: ["region*.v2.agenc.tech"],
      denied: [],
      host: "region3.v2.agenc.tech",
      expected: { kind: "allowed" as const },
    },
    {
      label: "exact deny wins over wildcard allow",
      allowed: ["*.agenc.tech"],
      denied: ["api.agenc.tech"],
      host: "api.agenc.tech",
      expected: { kind: "blocked" as const, reason: "denied" as const },
    },
    {
      label: "wildcard deny wins over exact allow",
      allowed: ["api.agenc.tech"],
      denied: ["*.agenc.tech"],
      host: "api.agenc.tech",
      expected: { kind: "blocked" as const, reason: "denied" as const },
    },
  ])(
    "matches domain policy table case: $label",
    ({ allowed, denied, host, expected }) => {
      const config = defaultNetworkProxyConfig();
      setAllowedDomains(config, allowed);
      setDeniedDomains(config, denied);

      expect(hostPolicyDecision(buildConfigState(config), host)).toEqual(
        expected,
      );
    },
  );

  test("malformed domain glob patterns fail closed during state build", () => {
    const allowed = defaultNetworkProxyConfig();
    setAllowedDomains(allowed, ["[unterminated"]);
    expect(() => buildConfigState(allowed)).toThrow(
      /valid domain glob pattern/,
    );

    const denied = defaultNetworkProxyConfig();
    setDeniedDomains(denied, ["[unterminated"]);
    expect(() => buildConfigState(denied)).toThrow(
      /valid domain glob pattern/,
    );
  });
});

describe("trusted constraints", () => {
  test("trusted scalar constraints are last trusted layer wins", () => {
    const constraints = networkConstraintsFromTrustedLayers([
      layer("system", `
default_permissions = "workspace"

[permissions.workspace.network]
enabled = false
mode = "limited"
allow_local_binding = false
`),
      layer("managed", `
default_permissions = "workspace"

[permissions.workspace.network]
enabled = true
allow_local_binding = true
`),
    ]);

    expect(constraints.enabled).toBe(true);
    expect(constraints.mode).toBe("limited");
    expect(constraints.allowLocalBinding).toBe(true);
  });

  test("trusted domain constraints accumulate and override by normalized pattern", () => {
    const constraints = networkConstraintsFromTrustedLayers([
      layer("managed", `
default_permissions = "workspace"

[permissions.workspace.network.domains]
"*.agenc.tech" = "allow"
"blocked.agenc.tech" = "deny"
`),
      layer("legacy_managed", `
default_permissions = "workspace"

[permissions.workspace.network.domains]
"BLOCKED.agenc.tech." = "allow"
"api.agenc.tech" = "deny"
`),
    ]);

    expect(constraints.allowedDomains).toEqual([
      "*.agenc.tech",
      "BLOCKED.agenc.tech.",
    ]);
    expect(constraints.deniedDomains).toEqual(["api.agenc.tech"]);
  });

  test("user layers do not contribute trusted constraints", () => {
    const constraints = networkConstraintsFromTrustedLayers([
      layer("user", `
default_permissions = "workspace"

[permissions.workspace.network]
enabled = false
`),
    ]);

    expect(constraints.enabled).toBeUndefined();
  });

  test("validator rejects widening over trusted constraints", () => {
    const candidate = defaultNetworkProxyConfig();
    candidate.network.enabled = true;
    candidate.network.mode = "full";
    setAllowedDomains(candidate, ["api.agenc.tech"]);
    setDeniedDomains(candidate, ["blocked.agenc.tech"]);

    expect(() =>
      buildConfigState(candidate, {
        enabled: false,
      }),
    ).toThrow(/network.enabled/);
    expect(() =>
      buildConfigState(candidate, {
        mode: "limited",
      }),
    ).toThrow(/network.mode/);
    expect(() =>
      buildConfigState(candidate, {
        deniedDomains: ["blocked.agenc.tech", "audit.agenc.tech"],
      }),
    ).toThrow(/missing managed denied_domains entries/);
  });

  test("managed allowed domains enforce subset and expansion semantics", () => {
    const narrowed = defaultNetworkProxyConfig();
    setAllowedDomains(narrowed, [
      "api.agenc.tech",
      "deep.api.agenc.tech",
    ]);
    expect(() =>
      buildConfigState(narrowed, { allowedDomains: ["*.agenc.tech"] }),
    ).not.toThrow();

    const widened = defaultNetworkProxyConfig();
    setAllowedDomains(widened, ["**.agenc.tech"]);
    expect(() =>
      buildConfigState(widened, { allowedDomains: ["*.agenc.tech"] }),
    ).toThrow(/subset of managed allowed_domains/);

    const expanded = defaultNetworkProxyConfig();
    setAllowedDomains(expanded, ["api.agenc.tech", "other.agenc.tech"]);
    expect(() =>
      buildConfigState(expanded, {
        allowedDomains: ["api.agenc.tech"],
        allowlistExpansionEnabled: true,
      }),
    ).not.toThrow();

    const exact = defaultNetworkProxyConfig();
    setAllowedDomains(exact, ["api.agenc.tech", "other.agenc.tech"]);
    expect(() =>
      buildConfigState(exact, {
        allowedDomains: ["api.agenc.tech"],
        allowlistExpansionEnabled: false,
      }),
    ).toThrow(/must match managed allowed_domains/);
  });

  test("global wildcard validation is fail-closed", () => {
    const deniedWildcard = defaultNetworkProxyConfig();
    setDeniedDomains(deniedWildcard, ["*"]);
    expect(() => buildConfigState(deniedWildcard)).toThrow(
      /network.denied_domains/,
    );

    const allowedWildcard = defaultNetworkProxyConfig();
    setAllowedDomains(allowedWildcard, ["*"]);
    expect(() => buildConfigState(allowedWildcard)).not.toThrow();
    expect(() =>
      buildConfigState(allowedWildcard, { allowedDomains: ["*.agenc.tech"] }),
    ).toThrow(/subset of managed allowed_domains/);
    expect(() =>
      buildConfigState(defaultNetworkProxyConfig(), { allowedDomains: ["*"] }),
    ).toThrow(/network.allowed_domains/);
  });

  test("unix socket constraints require absolute paths and managed subsets", () => {
    const config = defaultNetworkProxyConfig();
    setAllowUnixSockets(config, ["/var/run/service.sock"]);
    expect(() =>
      buildConfigState(config, {
        allowUnixSockets: ["/var/run/service.sock", "/tmp/other.sock"],
      }),
    ).not.toThrow();
    expect(() =>
      buildConfigState(config, { allowUnixSockets: ["/tmp/other.sock"] }),
    ).toThrow(/network.allow_unix_sockets/);

    const relative = defaultNetworkProxyConfig();
    setAllowUnixSockets(relative, ["relative.sock"]);
    expect(() => buildConfigState(relative)).toThrow(/absolute filesystem/);

    const windowsPath = defaultNetworkProxyConfig();
    setAllowUnixSockets(windowsPath, ["C:\\Temp\\service.sock"]);
    expect(() => buildConfigState(windowsPath)).not.toThrow();
  });

  test("enforceTrustedConstraints validates candidate config against trusted layers", () => {
    const layers = [
      layer("managed", `
default_permissions = "workspace"

[permissions.workspace.network]
enabled = false
`),
      layer("user", `
default_permissions = "workspace"

[permissions.workspace.network]
enabled = true
`),
    ];
    const config = configFromLayers(layers);
    expect(() => enforceTrustedConstraints(layers, config)).toThrow(
      /network.enabled/,
    );
  });
});

describe("exec-policy network rule projection", () => {
  test("cross-protocol forbids are not erased by allows", () => {
    const config = defaultNetworkProxyConfig();
    applyExecPolicyNetworkRules(config, [
      {
        host: "api.agenc.tech",
        protocol: "http",
        decision: "allow",
      },
      {
        host: "api.agenc.tech",
        protocol: "socks5_udp",
        decision: "forbidden",
      },
    ]);

    expect(deniedDomains(config)).toEqual(["api.agenc.tech"]);
    expect(hostPolicyDecision(buildConfigState(config), "api.agenc.tech"))
      .toEqual({ kind: "blocked", reason: "denied" });
  });

  test("duplicate host-protocol rules are last-rule-wins before host projection", () => {
    const config = defaultNetworkProxyConfig();
    applyExecPolicyNetworkRules(config, [
      {
        host: "api.agenc.tech",
        protocol: "https",
        decision: "forbidden",
      },
      {
        host: "API.agenc.tech.",
        protocol: "https_connect",
        decision: "allow",
      },
    ]);

    expect(buildConfigState(config).allowedDomains).toEqual(["api.agenc.tech"]);
    expect(deniedDomains(config)).toEqual([]);
  });

  test("prompt rules do not erase existing projected rules", () => {
    const config = defaultNetworkProxyConfig();
    applyExecPolicyNetworkRules(config, [
      {
        host: "api.agenc.tech",
        protocol: "http",
        decision: "allow",
      },
      {
        host: "api.agenc.tech",
        protocol: "http",
        decision: "prompt",
      },
    ]);

    expect(buildConfigState(config).allowedDomains).toEqual(["api.agenc.tech"]);
  });

  test("unknown exec-policy protocol and decision throw", () => {
    expect(() =>
      applyExecPolicyNetworkRules(defaultNetworkProxyConfig(), [
        { host: "api.agenc.tech", protocol: "ftp", decision: "allow" },
      ]),
    ).toThrow(/protocol must be one of/);
    expect(() =>
      applyExecPolicyNetworkRules(defaultNetworkProxyConfig(), [
        { host: "api.agenc.tech", protocol: "http", decision: "maybe" },
      ]),
    ).toThrow(/decision must be one of/);
  });

  test("malformed bracketed exec-policy hosts throw", () => {
    expect(() =>
      applyExecPolicyNetworkRules(defaultNetworkProxyConfig(), [
        { host: "[::1]bad", protocol: "http", decision: "allow" },
      ]),
    ).toThrow(/unsupported suffix/);
  });
});

describe("host normalization", () => {
  test("normalizes host ports, trailing dots, case, and IPv6 scope ids", () => {
    expect(normalizeHost("  API.Agenc.Tech.:443 ")).toBe("api.agenc.tech");
    expect(normalizeHost("[::1]:443")).toBe("::1");
    expect(normalizeHost("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizeHost("[fe80::1%25lo0]:443")).toBe("fe80::1%lo0");
  });
});

describe("mtime reloader", () => {
  test("reloads when the user config file mtime changes", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-network-policy-"));
    try {
      await mkdir(home, { recursive: true });
      const configPath = join(home, "config.toml");
      await writeFile(
        configPath,
        `
default_permissions = "workspace"

[permissions.workspace.network.domains]
"api.agenc.tech" = "allow"
`,
      );

      const state = await buildNetworkProxyState({ agencHome: home });
      expect(state.current().allowedDomains).toEqual(["api.agenc.tech"]);
      expect(await state.maybeReload()).toBeNull();

      await writeFile(
        configPath,
        `
default_permissions = "workspace"

[permissions.workspace.network.domains]
"other.agenc.tech" = "allow"
`,
      );
      const future = new Date(Date.now() + 2000);
      await utimes(configPath, future, future);

      const reloaded = await state.maybeReload();
      expect(reloaded?.allowedDomains).toEqual(["other.agenc.tech"]);
      expect(state.current().allowedDomains).toEqual(["other.agenc.tech"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("layer construction", () => {
  test("builds config state from provided layers and options", () => {
    const state = buildConfigStateFromLayers(
      [
        layer("user", `
default_permissions = "workspace"

[permissions.workspace.network.domains]
"api.agenc.tech" = "allow"
`),
      ],
      {
        execPolicyNetworkRules: [
          {
            host: "blocked.agenc.tech",
            protocol: "https",
            decision: "forbidden",
          },
        ],
      },
    );

    expect(state.allowedDomains).toEqual(["api.agenc.tech"]);
    expect(state.deniedDomains).toEqual(["blocked.agenc.tech"]);
  });
});
