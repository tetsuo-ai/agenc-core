import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/config/env.js", () => { throw new Error("cwd ingress must not load configuration projection"); });
vi.mock("../../src/config/schema.js", () => { throw new Error("cwd ingress must not construct settings schemas"); });
import { resolveCliCwdForStartup } from "../../src/bin/cli-cwd.js";
import { resolveWorkspace } from "../../src/config/workspace-environment.js";

describe("configuration-free startup cwd", () => {
  it("retains literal workspace whitespace and empty-versus-absent behavior", () => {
    expect(resolveWorkspace({ AGENC_WORKSPACE: " folder " })).toBe(" folder ");
    expect(resolveWorkspace({ AGENC_WORKSPACE: "" })).toBeUndefined();
    expect(resolveWorkspace({})).toBeUndefined();
    expect(resolveCliCwdForStartup({ AGENC_WORKSPACE: " folder " }, { cwdFn: () => process.cwd() })).toEqual({ ok: true, cwd: resolve(" folder ") });
  });
  it("preserves relative workspace refusal when the process cwd is unavailable", () => {
    expect(resolveCliCwdForStartup({ AGENC_WORKSPACE: "relative" }, { cwdFn: () => { throw new Error("gone"); } })).toEqual({
      ok: false, message: "AGENC_WORKSPACE must be absolute when the current working directory is unavailable.",
    });
  });
});
