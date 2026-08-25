import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = resolve(runtimeRoot, "src");

describe("retired profiler surfaces", () => {
  test("does not retain the orphaned headless profiler", () => {
    const anthropicSource = readFileSync(
      resolve(sourceRoot, "services/api/anthropic.ts"),
      "utf8",
    );

    expect(
      existsSync(resolve(sourceRoot, "utils/headlessProfiler.ts")),
    ).toBe(false);
    expect(anthropicSource).not.toContain("headlessProfiler");
  });
});
