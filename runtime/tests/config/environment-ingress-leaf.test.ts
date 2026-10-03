import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/env.js", () => {
  throw new Error("startup ingress must not load full config environment projection");
});
vi.mock("../../src/config/schema.js", () => {
  throw new Error("startup ingress must not construct settings schemas");
});
import { assertCanonicalEnvironmentIngress } from "../../src/config/environment-ingress.js";
import { withChildTempAuthority } from "../../src/utils/subprocessEnv.js";
import { OBSOLETE_CONFIG_ENV_REPLACEMENTS } from "../../src/config/obsolete-environment.js";

describe("schema-free canonical ingress", () => {
  it("validates ingress and exposes child temp authority without importing config", () => {
    expect(() => assertCanonicalEnvironmentIngress({})).not.toThrow();
    const root = process.platform === "win32" ? "C:\\agenc-temp" : "/agenc-temp";
    expect(withChildTempAuthority({}, root).TMPDIR).toBe(root);
  });
  it.each(Object.keys(OBSOLETE_CONFIG_ENV_REPLACEMENTS))("still rejects defined %s at ingress", key => {
    for (const value of ["", "0", "false", "1"]) {
      expect(() => assertCanonicalEnvironmentIngress({ [key]: value })).toThrow(
        `obsolete configuration environment variable ${key}`,
      );
    }
    expect(() => assertCanonicalEnvironmentIngress({ [key]: undefined })).not.toThrow();
  });
  it("retains runtime and home rejection before obsolete configuration diagnostics", () => {
    expect(() => assertCanonicalEnvironmentIngress({ AGENC_SIMPLE: "0", OPENAI_MODEL: "test" })).toThrow("AGENC_SIMPLE was removed");
    expect(() => assertCanonicalEnvironmentIngress({ AGENC_CONFIG_DIR: "/old", OPENAI_MODEL: "test" })).toThrow("AGENC_CONFIG_DIR");
  });
});
