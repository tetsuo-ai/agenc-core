import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { resolveProviderSettings } from "../../src/config/resolve-provider.js";
import { defaultConfig, type AgenCConfig } from "../../src/config/schema.js";

const sourceRoot = resolve(import.meta.dirname, "../../src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/u.test(entry)
        ? [path]
        : [];
  });
}

describe("provider fallback authority", () => {
  test("runtime consumes only structured fallback.targets", () => {
    const config = {
      ...defaultConfig(),
      providers: {
        grok: {
          fallback: {
            targets: [{ model: "grok-3" }],
            // Deliberately bypass strict validation: the retired shorthand
            // must not reactivate in a stale in-memory object.
            models: ["grok-2"],
          },
          // Deliberately bypass strict config validation to prove that a stale
          // in-memory object cannot reactivate the retired schema-v1 field.
          fallback_models: ["grok-2"],
        },
      },
    } as unknown as AgenCConfig;

    expect(resolveProviderSettings("grok", config, {})?.fallbackTargets).toEqual([
      { provider: "grok", model: "grok-3" },
    ]);
  });

  test("retired fallback spellings are confined to explicit migration", () => {
    const allowed = new Set(["config/migration.ts"]);
    const violations = sourceFiles(sourceRoot)
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return /\bfallback_models\b|fallback\?*\.models\b/u.test(source);
      })
      .map((path) => relative(sourceRoot, path))
      .filter((path) => !allowed.has(path));

    expect(violations).toEqual([]);
  });
});
