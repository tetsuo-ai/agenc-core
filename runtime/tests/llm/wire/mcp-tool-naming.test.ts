import { describe, expect, test } from "vitest";

import {
  decodeMcpToolNameFromWire,
  encodeMcpToolNameForWire,
  isProviderToolNameSafe,
} from "./mcp-tool-naming.js";

describe("MCP tool-name wire encoding", () => {
  test("encodes the canonical mcp.<server>.<tool> form to mcp__<server>__<tool>", () => {
    expect(encodeMcpToolNameForWire("mcp.memory.search_nodes")).toBe(
      "mcp__memory__search_nodes",
    );
    expect(encodeMcpToolNameForWire("mcp.github.create_issue")).toBe(
      "mcp__github__create_issue",
    );
  });

  test("preserves hyphens and single underscores in server and tool names", () => {
    expect(
      encodeMcpToolNameForWire("mcp.context7.resolve-library-id"),
    ).toBe("mcp__context7__resolve-library-id");
    expect(
      encodeMcpToolNameForWire("mcp.xai-docs.list_doc_pages"),
    ).toBe("mcp__xai-docs__list_doc_pages");
    expect(
      encodeMcpToolNameForWire("mcp.design_tooling.get_design_context"),
    ).toBe("mcp__design_tooling__get_design_context");
  });

  test("passes non-MCP tool names through unchanged", () => {
    expect(encodeMcpToolNameForWire("FileEdit")).toBe("FileEdit");
    expect(encodeMcpToolNameForWire("exec_command")).toBe("exec_command");
    expect(encodeMcpToolNameForWire("TodoWrite")).toBe("TodoWrite");
    expect(encodeMcpToolNameForWire("")).toBe("");
  });

  test("passes malformed mcp-prefix names through unchanged", () => {
    // No second dot — can't be decomposed into server/tool. Pass through
    // so provider-side validation surfaces the malformed name rather
    // than corrupting it silently.
    expect(encodeMcpToolNameForWire("mcp.")).toBe("mcp.");
    expect(encodeMcpToolNameForWire("mcp.server")).toBe("mcp.server");
  });

  test("escapes server names that would be ambiguous in the legacy form", () => {
    expect(encodeMcpToolNameForWire("mcp.serv__er.foo")).toBe(
      "mcp2__serv_u_uer__foo",
    );
    expect(decodeMcpToolNameFromWire("mcp2__serv_u_uer__foo")).toBe(
      "mcp.serv__er.foo",
    );
  });

  test("escapes plugin-style server names while preserving canonical decode", () => {
    const wire = encodeMcpToolNameForWire("mcp.plugin:sample:local.ping");
    expect(wire).toBe("mcp2__plugin_x3asample_x3alocal__ping");
    expect(isProviderToolNameSafe(wire)).toBe(true);
    expect(decodeMcpToolNameFromWire(wire)).toBe(
      "mcp.plugin:sample:local.ping",
    );
  });

  test("escapes non-MCP internal tool names rejected by strict providers", () => {
    const systemSearchWire = encodeMcpToolNameForWire("system.searchTools");
    expect(systemSearchWire).toBe("tool2__system_x2esearchTools");
    expect(isProviderToolNameSafe(systemSearchWire)).toBe(true);
    expect(decodeMcpToolNameFromWire(systemSearchWire)).toBe(
      "system.searchTools",
    );

    const dottedWire = encodeMcpToolNameForWire("foo.bar-baz");
    expect(dottedWire).toBe("tool2__foo_x2ebar-baz");
    expect(isProviderToolNameSafe(dottedWire)).toBe(true);
    expect(decodeMcpToolNameFromWire(dottedWire)).toBe("foo.bar-baz");
  });

  test("decodes mcp__<server>__<tool> back to the dotted form", () => {
    expect(decodeMcpToolNameFromWire("mcp__memory__search_nodes")).toBe(
      "mcp.memory.search_nodes",
    );
    expect(
      decodeMcpToolNameFromWire("mcp__context7__resolve-library-id"),
    ).toBe("mcp.context7.resolve-library-id");
  });

  test("preserves __ inside the tool segment when decoding", () => {
    // A tool name like `do__stuff` round-trips cleanly: encoded form is
    // `mcp__server__do__stuff` and decode uses the FIRST `__` after the
    // wire prefix as the server/tool delimiter, so the trailing `__`
    // survives.
    expect(decodeMcpToolNameFromWire("mcp__server__do__stuff")).toBe(
      "mcp.server.do__stuff",
    );
  });

  test("passes non-encoded names through decode unchanged", () => {
    expect(decodeMcpToolNameFromWire("FileEdit")).toBe("FileEdit");
    expect(decodeMcpToolNameFromWire("exec_command")).toBe("exec_command");
    // `mcp.foo.bar` is the internal form, not the wire form. Should
    // round-trip unchanged when fed to decode by mistake.
    expect(decodeMcpToolNameFromWire("mcp.memory.search_nodes")).toBe(
      "mcp.memory.search_nodes",
    );
  });

  test("decode passes through malformed wire prefix", () => {
    // No `__` after `mcp__` prefix — can't split into server/tool.
    expect(decodeMcpToolNameFromWire("mcp__server")).toBe("mcp__server");
    expect(decodeMcpToolNameFromWire("mcp__")).toBe("mcp__");
  });

  test("encode and decode are mutual inverses for valid names", () => {
    const inputs = [
      "mcp.memory.search_nodes",
      "mcp.github.create_issue",
      "mcp.context7.resolve-library-id",
      "mcp.design_tooling.get_design_context",
      "mcp.server.do__stuff", // tool name with __
      "mcp.serv__er.foo",
      "mcp.plugin:sample:local.ping",
      "system.searchTools",
      "foo.bar-baz",
      "FileEdit",
      "exec_command",
      "TodoWrite",
    ];
    for (const input of inputs) {
      expect(decodeMcpToolNameFromWire(encodeMcpToolNameForWire(input))).toBe(
        input,
      );
    }
  });

  test("encoded names match the strict-regex providers' tool-name pattern", () => {
    // `^[a-zA-Z0-9_-]{1,64}$` per provider docs (this regex is shared
    // across every major commercial chat-completions provider).
    const strictRegex = /^[a-zA-Z0-9_-]{1,64}$/;
    const cases = [
      "mcp.memory.search_nodes",
      "mcp.github.create_issue",
      "mcp.context7.resolve-library-id",
      "mcp.design_tooling.get_design_context",
      "mcp.plugin:sample:local.ping",
      "mcp.serv__er.foo",
      "system.searchTools",
      "foo.bar-baz",
    ];
    for (const internal of cases) {
      const wire = encodeMcpToolNameForWire(internal);
      expect(wire).toMatch(strictRegex);
      expect(wire.length).toBeLessThanOrEqual(64);
      expect(isProviderToolNameSafe(wire)).toBe(true);
    }
  });
});
