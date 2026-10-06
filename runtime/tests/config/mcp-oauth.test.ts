import { describe, expect, it } from "vitest";

import {
  assertMcpOAuthHttpsUrl,
  validateMcpOAuthConfig,
} from "../../src/config/mcp-oauth.js";
import { validateMcpServersConfig } from "../../src/config/schema.js";

describe("validateMcpOAuthConfig", () => {
  it("returns undefined for an omitted block and freezes a valid object", () => {
    const scopes = ["read", "files"];
    const oauth = validateMcpOAuthConfig({
      clientId: "public-client",
      scopes,
      authServerMetadataUrl: "https://auth.example.test/.well-known/oauth",
      callbackPort: 3118,
      xaa: false,
    });
    expect(validateMcpOAuthConfig(undefined)).toBeUndefined();
    expect(oauth).toEqual({
      clientId: "public-client",
      scopes: ["read", "files"],
      authServerMetadataUrl: "https://auth.example.test/.well-known/oauth",
      callbackPort: 3118,
      xaa: false,
    });
    expect(Object.isFrozen(oauth)).toBe(true);
    expect(Object.isFrozen(oauth?.scopes)).toBe(true);
    scopes.push("admin");
    expect(oauth?.scopes).toEqual(["read", "files"]);
  });

  it.each([
    { label: "null", value: null },
    { label: "array", value: [] },
    { label: "string", value: "oauth" },
    { label: "number", value: 1 },
    { label: "boolean", value: true },
  ])("rejects a non-object $label", ({ value }) => {
    expect(() => validateMcpOAuthConfig(value)).toThrow(
      "MCP OAuth configuration must be an object",
    );
  });

  it("rejects unknown fields so secrets cannot live in config", () => {
    expect(() =>
      validateMcpOAuthConfig({ clientSecret: "must-not-leak" }),
    ).toThrow("unsupported field");
    expect(() => validateMcpOAuthConfig({ client_id: "public" })).toThrow(
      "unsupported field",
    );
  });

  it.each([
    ["", "empty"],
    ["a".repeat(2049), "too long"],
    ["public\nclient", "newline"],
    ["public\rclient", "carriage return"],
    ["public\0client", "NUL"],
  ])("rejects clientId %s (%s)", (clientId) => {
    expect(() => validateMcpOAuthConfig({ clientId })).toThrow(
      "MCP OAuth client ID is invalid",
    );
  });

  it.each([
    "read files",
    'read"',
    "read\\write",
    "",
    "s".repeat(257),
  ])("rejects scope name %j", (scope) => {
    expect(() => validateMcpOAuthConfig({ scopes: [scope] })).toThrow(
      "MCP OAuth scopes must be a list of valid scope names",
    );
  });

  it("rejects a non-array or oversized scope list", () => {
    expect(() => validateMcpOAuthConfig({ scopes: "read" })).toThrow(
      "MCP OAuth scopes must be a list of valid scope names",
    );
    expect(() =>
      validateMcpOAuthConfig({ scopes: Array.from({ length: 65 }, () => "s") }),
    ).toThrow("MCP OAuth scopes must be a list of valid scope names");
  });

  it.each([
    "http://auth.example.test/metadata",
    "https://user:secret@auth.example.test/metadata",
    "https://auth.example.test/metadata#fragment",
    "not-a-url",
  ])("rejects metadata URL %s", (authServerMetadataUrl) => {
    expect(() => validateMcpOAuthConfig({ authServerMetadataUrl })).toThrow(
      /MCP OAuth (URL is invalid|URLs must use HTTPS|metadata URL must use HTTPS)/,
    );
  });

  it.each([1023, 65536, 0, 1.5, "3118"])(
    "rejects callback port %j",
    (callbackPort) => {
      expect(() => validateMcpOAuthConfig({ callbackPort })).toThrow(
        "MCP OAuth callback port must be between 1024 and 65535",
      );
    },
  );

  it.each([1024, 65535])("accepts callback port %s", (callbackPort) => {
    expect(validateMcpOAuthConfig({ callbackPort })).toEqual({ callbackPort });
  });

  it("rejects a non-boolean XAA flag", () => {
    expect(() => validateMcpOAuthConfig({ xaa: "true" })).toThrow(
      "MCP OAuth XAA must be boolean",
    );
  });
});

describe("assertMcpOAuthHttpsUrl", () => {
  it("accepts HTTPS without credentials or fragments", () => {
    expect(assertMcpOAuthHttpsUrl("https://mcp.example.test/oauth").href).toBe(
      "https://mcp.example.test/oauth",
    );
  });

  it.each([
    "http://mcp.example.test/oauth",
    "https://user:token@mcp.example.test/oauth",
    "https://mcp.example.test/oauth#state",
  ])("rejects %s", (value) => {
    expect(() => assertMcpOAuthHttpsUrl(value)).toThrow(
      "MCP OAuth URLs must use HTTPS without embedded credentials or fragments",
    );
  });
});

describe("MCP server OAuth schema path", () => {
  it("accepts HTTPS HTTP-transport OAuth and rejects insecure or secret-bearing shapes", () => {
    expect(
      validateMcpServersConfig({
        sample: {
          transport: "http",
          endpoint: "https://mcp.example.test/mcp",
          oauth: {
            clientId: "public",
            scopes: ["read"],
            authServerMetadataUrl: "https://auth.example.test/metadata",
            callbackPort: 3118,
          },
        },
      })?.sample?.oauth,
    ).toEqual({
      clientId: "public",
      scopes: ["read"],
      authServerMetadataUrl: "https://auth.example.test/metadata",
      callbackPort: 3118,
    });
    expect(() =>
      validateMcpServersConfig({
        sample: {
          transport: "http",
          endpoint: "https://mcp.example.test/mcp",
          oauth: { authServerMetadataUrl: "http://auth.example.test/metadata" },
        },
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      validateMcpServersConfig({
        sample: {
          transport: "http",
          endpoint: "https://mcp.example.test/mcp",
          oauth: { callbackPort: 80 },
        },
      }),
    ).toThrow("callback port");
  });
});
