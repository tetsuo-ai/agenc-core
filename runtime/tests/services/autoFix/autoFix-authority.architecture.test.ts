import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const SOURCE_ROOT = resolve(import.meta.dirname, "../../../src");
const AUTO_FIX_ROOT = resolve(SOURCE_ROOT, "services/autoFix");

function source(relativePath: string): string {
  return readFileSync(resolve(AUTO_FIX_ROOT, relativePath), "utf8");
}

describe("auto-fix authority", () => {
  test("uses one strict parser without a competing object schema", () => {
    const config = source("autoFixConfig.ts");

    expect(config.match(/export function parseAutoFixConfig\b/gu)).toHaveLength(1);
    expect(config).not.toContain("AutoFixConfigSchema");
    expect(config).not.toMatch(/from ["']zod(?:\/v4)?["']/u);

    const canonicalSchema = readFileSync(
      resolve(SOURCE_ROOT, "config/schema.ts"),
      "utf8",
    );
    expect(canonicalSchema).toContain("parseAutoFixConfig(config.autoFix)");
  });

  test("admits only registered canonical file mutation tools", () => {
    const hook = source("autoFixHook.ts");
    const initializer = hook.match(
      /const AUTO_FIX_TOOLS = new Set\(\[([\s\S]*?)\]\);/u,
    )?.[1];

    expect(initializer).toBeDefined();
    expect(initializer?.match(/[A-Z][A-Z0-9_]+/gu)).toEqual([
      "FILE_EDIT_TOOL_NAME",
      "FILE_MULTI_EDIT_TOOL_NAME",
      "FILE_WRITE_TOOL_NAME",
    ]);
    expect(initializer).not.toMatch(/["']/u);
  });

  test("contains no historical port annotations", () => {
    const historical = /\b(?:donor|upstream|ports?|ported|porting)\b/iu;
    const violations = readdirSync(AUTO_FIX_ROOT)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => historical.test(source(name)));

    expect(violations).toEqual([]);
  });
});
