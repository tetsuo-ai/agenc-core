import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const CONFIG_SOURCE = fileURLToPath(
  new URL("../../src/config/", import.meta.url),
);

function source(name: string): string {
  return readFileSync(`${CONFIG_SOURCE}/${name}`, "utf8");
}

describe("provider/model selector authority", () => {
  test("does not restore raw CLI or environment selector engines", () => {
    const providerResolver = source("resolve-provider.ts");
    const modelResolver = source("resolve-model.ts");

    for (const resolver of [providerResolver, modelResolver]) {
      expect(resolver).not.toMatch(/\bcli(?:Provider|Model)\b/u);
      expect(resolver).not.toMatch(/\bAGENC_(?:PROVIDER|MODEL)\b/u);
      expect(resolver).not.toMatch(/\bresolveEnv(?:Provider|Model)\b/u);
    }
    expect(providerResolver).not.toMatch(
      /export function resolveProviderSelection\b/u,
    );
    expect(modelResolver).not.toMatch(
      /export function resolveModelSelection\b/u,
    );
  });

  test("environment ingress cannot expose ambient-default selection helpers", () => {
    const environment = source("env.ts");

    expect(environment).not.toMatch(/export function resolveProvider\s*\(/u);
    expect(environment).not.toMatch(/export function resolveModel\s*\(/u);
    expect(environment).not.toMatch(
      /export function resolve(?:Provider|Model)\s*\([^)]*=\s*process\.env/u,
    );
  });
});
