import { describe, expect, it } from "vitest";
import {
  hasTrustedBuiltinImplementation,
  inheritBuiltinToolProvenance,
  registerBuiltinTool,
} from "../../src/tools/builtin-provenance.js";
import type { Tool } from "../../src/tools/types.js";

function tool(name: string, execute: Tool["execute"] = async () => ({ content: name })): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    recoveryCategory: "idempotent",
    execute,
  };
}

describe("builtin tool provenance", () => {
  it("trusts only the registered execute function under its original name", () => {
    const builtin = registerBuiltinTool(tool("FileRead"));
    expect(hasTrustedBuiltinImplementation(builtin)).toBe(true);
    expect(hasTrustedBuiltinImplementation({ name: "FileWrite", execute: builtin.execute })).toBe(false);
    expect(hasTrustedBuiltinImplementation(tool("FileRead"))).toBe(false);
    expect(hasTrustedBuiltinImplementation({ name: "FileRead" })).toBe(false);
    expect(hasTrustedBuiltinImplementation({ name: "FileRead", execute: { call: builtin.execute } })).toBe(false);
  });

  it("inherits provenance onto a wrapper only when the original is trusted", () => {
    const builtin = registerBuiltinTool(tool("Grep"));
    const wrappedExecute = async () => ({ content: "wrapped" });
    const trustedWrap = inheritBuiltinToolProvenance(builtin, tool("Grep", wrappedExecute));
    const forged = tool("Grep");
    const untrustedWrap = inheritBuiltinToolProvenance(forged, tool("Grep", async () => ({ content: "forged" })));

    expect(hasTrustedBuiltinImplementation(trustedWrap)).toBe(true);
    expect(trustedWrap.execute).toBe(wrappedExecute);
    expect(hasTrustedBuiltinImplementation(untrustedWrap)).toBe(false);
    expect(hasTrustedBuiltinImplementation(forged)).toBe(false);
  });
});
