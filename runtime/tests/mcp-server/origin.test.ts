import { describe, expect, test } from "vitest";

import {
  mcpServerOriginValidationIssue,
  normalizeMcpServerAllowedOrigins,
} from "./origin.js";

describe("MCP HTTP/SSE allowed origin grammar", () => {
  test("accepts origins written the way a client sends them", () => {
    for (const origin of [
      "http://localhost",
      "http://localhost:5173",
      "http://127.0.0.1:8080",
      "http://[::1]:3000",
      "https://app.example",
      "https://app.example:8443",
      "https://xn--bcher-kva.example",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      "vscode-webview://1a2b3c4d",
    ]) {
      expect(mcpServerOriginValidationIssue(origin), origin).toBeUndefined();
    }
  });

  test("rejects values that can never equal an Origin header", () => {
    for (const origin of [
      "",
      "*",
      "null",
      "localhost",
      "localhost:5173",
      "//localhost:5173",
      "http://",
      "http://localhost:5173/",
      "http://localhost:5173/mcp",
      "http://localhost:5173?x=1",
      "http://localhost:5173#top",
      "http://user@localhost:5173",
      "http://user:secret@localhost:5173",
      "http://*.example.com",
      "http://localhost:*",
      "http://localhost:5173 ",
      " http://localhost:5173",
      "http://local host",
      "HTTP://localhost:5173",
      "http:\\\\localhost:5173",
    ]) {
      expect(
        mcpServerOriginValidationIssue(origin),
        JSON.stringify(origin),
      ).toEqual(expect.any(String));
    }
    for (const value of [undefined, null, 5173, {}, ["http://localhost"]]) {
      expect(mcpServerOriginValidationIssue(value)).toBe("must be a string");
    }
  });

  test("names the serialized form of a web origin written another way", () => {
    expect(mcpServerOriginValidationIssue("http://LOCALHOST:5173")).toBe(
      "must be written as http://localhost:5173",
    );
    expect(mcpServerOriginValidationIssue("http://localhost:80")).toBe(
      "must be written as http://localhost",
    );
    expect(mcpServerOriginValidationIssue("https://app.example:443")).toBe(
      "must be written as https://app.example",
    );
    expect(mcpServerOriginValidationIssue("https://bücher.example")).toBe(
      "must be written as https://xn--bcher-kva.example",
    );
  });

  test("normalizes a list by dropping duplicates and freezing it", () => {
    const normalized = normalizeMcpServerAllowedOrigins([
      "http://localhost:5173",
      "https://app.example",
      "http://localhost:5173",
    ]);
    expect(normalized).toEqual(["http://localhost:5173", "https://app.example"]);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(normalizeMcpServerAllowedOrigins([])).toEqual([]);
  });

  test("refuses a list with any invalid entry and says which", () => {
    expect(() =>
      normalizeMcpServerAllowedOrigins(["https://app.example", "*"]),
    ).toThrow('MCP HTTP/SSE allowed origin "*" must be an exact origin');
    expect(() => normalizeMcpServerAllowedOrigins([42])).toThrow(
      "MCP HTTP/SSE allowed origin 42 must be a string",
    );
  });
});
