import { describe, expect, test } from "vitest";

import {
  hasAdditionalSandboxPermissions,
  normalizeSandboxPermissionsRequest,
  parseSandboxPermissionsArgs,
  runtimeAdditionalPermissionsForSandboxRequest,
  sandboxPermissionsFromArgs,
} from "../../../src/sandbox/escalation/sandboxing.js";

describe("parseSandboxPermissionsArgs", () => {
  test("missing or default input is an explicit default request", () => {
    expect(parseSandboxPermissionsArgs({})).toEqual({
      kind: "ok",
      request: { kind: "default" },
    });
    expect(parseSandboxPermissionsArgs({ sandbox_permissions: null })).toEqual({
      kind: "ok",
      request: { kind: "default" },
    });
    expect(parseSandboxPermissionsArgs({ sandbox_permissions: "default" })).toEqual({
      kind: "ok",
      request: { kind: "default" },
    });
  });

  test("accepted strings keep escalation and additional-permission requests", () => {
    expect(parseSandboxPermissionsArgs({ sandbox_permissions: "require_escalated" }))
      .toEqual({ kind: "ok", request: { kind: "require_escalated" } });
    expect(parseSandboxPermissionsArgs({
      sandbox_permissions: "with_additional_permissions",
      additional_permissions: {
        network: { enabled: true },
        file_system: { read: ["/tmp/in"], write: ["/tmp/out"] },
      },
    })).toEqual({
      kind: "ok",
      request: {
        kind: "with_additional_permissions",
        additionalPermissions: {
          network: { enabled: true },
          file_system: { read: ["/tmp/in"], write: ["/tmp/out"] },
        },
      },
    });
  });

  test("the live incident object is refused, never silently dropped", () => {
    const incident = { sandbox_permissions: { network: "full" } };
    const parsed = parseSandboxPermissionsArgs(incident);
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind !== "invalid") return;
    expect(parsed.reason).toContain("sandbox_permissions must be one of");
    expect(parsed.reason).toContain('{"network":"full"}');
    expect(sandboxPermissionsFromArgs(incident)).toEqual({ kind: "default" });
  });

  test.each([
    "escalate",
    1,
    ["require_escalated"],
    { kind: "require_escalated" },
  ])("refuses unrecognized sandbox_permissions %j", (value) => {
    const parsed = parseSandboxPermissionsArgs({ sandbox_permissions: value });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind !== "invalid") return;
    expect(parsed.reason).toContain("sandbox_permissions must be one of");
  });

  test.each([
    "full",
    { extra: true },
    { network: true },
    { network: { enabled: "true" } },
    { network: { enabled: true, extra: true } },
    { file_system: ["/tmp"] },
    { file_system: { read: "/tmp" } },
    { file_system: { read: ["/tmp", 1] } },
    { file_system: { write: true } },
    { file_system: { read: [], extra: [] } },
  ])("refuses unsupported additional_permissions %j", (value) => {
    const parsed = parseSandboxPermissionsArgs({
      sandbox_permissions: "with_additional_permissions",
      additional_permissions: value,
    });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind !== "invalid") return;
    expect(parsed.reason).toContain("additional_permissions has an unsupported shape");
  });

  test("invalid additional_permissions is refused even without sandbox_permissions", () => {
    const parsed = parseSandboxPermissionsArgs({
      additional_permissions: { network: "full" },
    });
    expect(parsed.kind).toBe("invalid");
  });
});

describe("sandbox permission companions", () => {
  test("normalizeSandboxPermissionsRequest maps strings and empty inputs", () => {
    expect(normalizeSandboxPermissionsRequest(null)).toEqual({ kind: "default" });
    expect(normalizeSandboxPermissionsRequest(undefined)).toEqual({ kind: "default" });
    expect(normalizeSandboxPermissionsRequest("default")).toEqual({ kind: "default" });
    expect(normalizeSandboxPermissionsRequest("require_escalated")).toEqual({
      kind: "require_escalated",
    });
    expect(normalizeSandboxPermissionsRequest("with_additional_permissions", null)).toEqual({
      kind: "with_additional_permissions",
      additionalPermissions: {},
    });
  });

  test("hasAdditionalSandboxPermissions requires an enabled grant", () => {
    expect(hasAdditionalSandboxPermissions({})).toBe(false);
    expect(hasAdditionalSandboxPermissions({ network: { enabled: false } })).toBe(false);
    expect(hasAdditionalSandboxPermissions({ file_system: { read: [], write: [] } })).toBe(false);
    expect(hasAdditionalSandboxPermissions({ network: { enabled: true } })).toBe(true);
    expect(hasAdditionalSandboxPermissions({ file_system: { read: ["/tmp"] } })).toBe(true);
    expect(hasAdditionalSandboxPermissions({ file_system: { write: ["/tmp"] } })).toBe(true);
  });

  test("runtimeAdditionalPermissionsForSandboxRequest projects only real grants", () => {
    expect(runtimeAdditionalPermissionsForSandboxRequest("default")).toBeUndefined();
    expect(runtimeAdditionalPermissionsForSandboxRequest("require_escalated")).toBeUndefined();
    expect(runtimeAdditionalPermissionsForSandboxRequest({
      kind: "with_additional_permissions",
      additionalPermissions: {},
    })).toBeUndefined();
    expect(runtimeAdditionalPermissionsForSandboxRequest({
      kind: "with_additional_permissions",
      additionalPermissions: { network: { enabled: true } },
    })).toEqual({ network: { enabled: true } });
    expect(runtimeAdditionalPermissionsForSandboxRequest({
      kind: "with_additional_permissions",
      additionalPermissions: { file_system: { read: ["/tmp/in"], write: ["/tmp/out"] } },
    })).toEqual({
      fileSystem: {
        entries: [
          { path: { kind: "path", path: "/tmp/in" }, access: "read" },
          { path: { kind: "path", path: "/tmp/out" }, access: "write" },
        ],
      },
    });
  });
});
