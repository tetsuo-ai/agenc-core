import { afterEach, describe, expect, test } from "vitest";
import {
  clearPowerShellParserCacheForTests,
  parsePowerShellScriptWithNativeAst,
} from "./powershell-parser.js";

describe("parsePowerShellScriptWithNativeAst", () => {
  afterEach(() => {
    clearPowerShellParserCacheForTests();
  });

  test("returns a failed outcome when the platform executable is unavailable", () => {
    const outcome = parsePowerShellScriptWithNativeAst(
      "__agenc_missing_powershell_executable__",
      "Get-ChildItem",
      { timeoutMs: 250 },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("failed");
      expect(outcome.diagnostics.length).toBeGreaterThan(0);
    }
  });
});
