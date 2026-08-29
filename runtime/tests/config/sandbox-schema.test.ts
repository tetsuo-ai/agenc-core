import { describe, expect, test } from "vitest";

import { validateStrictConfigDocument } from "../../src/config/repository.js";
import {
  InvalidSandboxConfigError,
  validateSandboxConfig,
} from "../../src/config/schema.js";
import type { JsonRecord } from "../../src/config/json.js";

describe("canonical sandbox config schema", () => {
  test("accepts and deeply freezes every documented sandbox field", () => {
    const sandbox = validateSandboxConfig({
      network_access: false,
      allow_gpu: false,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: {
        allowedDomains: ["api.example.com"],
        allowManagedDomainsOnly: true,
        allowUnixSockets: ["/tmp/service.sock"],
        allowAllUnixSockets: false,
        allowLocalBinding: true,
        httpProxyPort: 1,
        socksProxyPort: 65_535,
      },
      filesystem: {
        allowWrite: ["./output"],
        denyWrite: ["~/.ssh"],
        denyRead: ["~/.aws"],
        allowRead: ["~/.aws/config"],
        allowManagedReadPathsOnly: true,
      },
      ignoreViolations: {
        Bash: ["/tmp/known.sock"],
      },
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      excludedCommands: ["trusted-helper"],
      ripgrep: {
        command: "/opt/bin/rg",
        args: ["--hidden"],
      },
    });

    expect(sandbox?.network?.httpProxyPort).toBe(1);
    expect(sandbox?.network?.socksProxyPort).toBe(65_535);
    expect(sandbox?.ripgrep?.command).toBe("/opt/bin/rg");
    for (const value of [
      sandbox,
      sandbox?.network,
      sandbox?.network?.allowedDomains,
      sandbox?.network?.allowUnixSockets,
      sandbox?.filesystem,
      sandbox?.filesystem?.allowWrite,
      sandbox?.filesystem?.denyWrite,
      sandbox?.filesystem?.denyRead,
      sandbox?.filesystem?.allowRead,
      sandbox?.ignoreViolations,
      sandbox?.ignoreViolations?.Bash,
      sandbox?.excludedCommands,
      sandbox?.ripgrep,
      sandbox?.ripgrep?.args,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  test.each([
    ["root", { mystery: true }, /mystery.*unknown field/u],
    [
      "retired write roots",
      { writable_roots: ["./tmp"] },
      /writable_roots.*unknown field/u,
    ],
    [
      "network",
      { network: { allowedDomains: [], allowDomains: [] } },
      /network\.allowDomains.*unknown field/u,
    ],
    [
      "filesystem",
      { filesystem: { allowWrite: [], writable: [] } },
      /filesystem\.writable.*unknown field/u,
    ],
    [
      "ripgrep",
      { ripgrep: { command: "rg", custom: true } },
      /ripgrep\.custom.*unknown field/u,
    ],
    [
      "operator argv0",
      { ripgrep: { command: "rg", argv0: "rg" } },
      /ripgrep\.argv0.*unknown field/u,
    ],
  ])("rejects an unknown %s field", (_label, value, error) => {
    expect(() => validateSandboxConfig(value)).toThrow(error);
  });

  test.each([
    ["allowed domains", { network: { allowedDomains: [42] } }, /network\.allowedDomains/u],
    ["Unix sockets", { network: { allowUnixSockets: [false] } }, /network\.allowUnixSockets/u],
    ["write paths", { filesystem: { allowWrite: "./tmp" } }, /filesystem\.allowWrite/u],
    ["ignored violations", { ignoreViolations: { Bash: [false] } }, /ignoreViolations\.Bash/u],
    ["excluded commands", { excludedCommands: [1] }, /excludedCommands/u],
    ["ripgrep args", { ripgrep: { command: "rg", args: [1] } }, /ripgrep\.args/u],
  ])("rejects malformed %s string arrays", (_label, value, error) => {
    expect(() => validateSandboxConfig(value)).toThrow(error);
  });

  test.each([0, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "8080"])(
    "rejects invalid TCP port %s",
    (port) => {
      expect(() =>
        validateSandboxConfig({ network: { httpProxyPort: port } }),
      ).toThrow(/network\.httpProxyPort.*1\.\.65535/u);
    },
  );

  test.each([
    [undefined, /ripgrep\.command.*non-empty string/u],
    ["", /ripgrep\.command.*non-empty string/u],
    ["   ", /ripgrep\.command.*non-empty string/u],
    [42, /ripgrep\.command.*expected string/u],
  ])(
    "requires a non-empty ripgrep command (%s)",
    (command, error) => {
      expect(() => validateSandboxConfig({ ripgrep: { command } })).toThrow(
        error,
      );
    },
  );

  test.each([
    ["network_access", { network_access: "false" }],
    ["allow_gpu", { allow_gpu: 1 }],
    ["autoAllowBashIfSandboxed", { autoAllowBashIfSandboxed: 0 }],
    ["allowUnsandboxedCommands", { allowUnsandboxedCommands: "no" }],
    ["enableWeakerNestedSandbox", { enableWeakerNestedSandbox: 1 }],
    ["enableWeakerNetworkIsolation", { enableWeakerNetworkIsolation: null }],
    [
      "network.allowManagedDomainsOnly",
      { network: { allowManagedDomainsOnly: "true" } },
    ],
    ["network.allowAllUnixSockets", { network: { allowAllUnixSockets: 1 } }],
    ["network.allowLocalBinding", { network: { allowLocalBinding: "yes" } }],
    [
      "filesystem.allowManagedReadPathsOnly",
      { filesystem: { allowManagedReadPathsOnly: "true" } },
    ],
  ])("rejects non-boolean security field %s", (_label, value) => {
    expect(() => validateSandboxConfig(value)).toThrow(
      InvalidSandboxConfigError,
    );
  });

  test("strict schema-v2 validation rejects nested sandbox passthrough", () => {
    expect(() =>
      validateStrictConfigDocument(
        {
          config_version: 2,
          sandbox: {
            network: { allowedDomains: ["example.com"], vendorPolicy: true },
          },
        } as JsonRecord,
        "/tmp/config.toml",
      ),
    ).toThrow(/sandbox.*network\.vendorPolicy.*unknown field/u);
  });
});
