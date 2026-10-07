import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/config/env.js", () => { throw new Error("flags must not load config environment"); });
vi.mock("../../src/config/schema.js", () => { throw new Error("flags must not construct config schemas"); });
vi.mock("../../src/config/provider-model-authority.js", () => { throw new Error("literal flags must not resolve a model"); });
import { readStartupCliFlags } from "../../src/bin/startup-cli-flags.js";

describe("startup flag parser without config authority", () => {
  it("preserves literal provider/model selection for later canonical validation", () => {
    expect(readStartupCliFlags(["node", "agenc", "-p", "--provider", "custom", "--model", "exact", "--light", "hello"])).toEqual({ provider: "custom", model: "exact", lightMode: true });
  });
  it("rejects contradictory or internal permission choices before spawn", () => {
    expect(() => readStartupCliFlags(["node", "agenc", "--bypass-approvals", "--permission-mode", "plan"])).toThrow("conflicts");
    expect(() => readStartupCliFlags(["node", "agenc", "--permission-mode", "unattended"])).toThrow("unknown permission mode");
  });
});
