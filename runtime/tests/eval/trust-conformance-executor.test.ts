import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  digestCanonicalJson,
} from "../../src/eval-contract/index.js";
import type {
  TrustConformanceSuiteDefinitionDocument,
  TrustFixtureBundleDocument,
} from "../../src/eval-suites/index.js";
import {
  aggregateTrustAttempts,
  runTrustConformanceSuite,
} from "../../src/eval-executor/trust-run.js";

const SUITE_DIR = path.resolve(
  __dirname,
  "../../eval/suites/trust-conformance/1.0.0",
);

function loadSuite(): {
  definition: TrustConformanceSuiteDefinitionDocument;
  fixtures: TrustFixtureBundleDocument;
} {
  return {
    definition: JSON.parse(
      readFileSync(path.join(SUITE_DIR, "definition.json"), "utf8"),
    ) as TrustConformanceSuiteDefinitionDocument,
    fixtures: JSON.parse(
      readFileSync(path.join(SUITE_DIR, "fixtures.json"), "utf8"),
    ) as TrustFixtureBundleDocument,
  };
}

describe("trust-conformance executor (diagnostic)", () => {
  it("runs every scenario and prints the honest summary", async () => {
    const { definition, fixtures } = loadSuite();
    const result = await runTrustConformanceSuite({
      definition,
      fixtures,
      seedSlot: 0,
      repositoryCommit: "deadbeef".repeat(5),
      systemConfigurationDigest: digestCanonicalJson(
        "agenc.eval.trust-system-configuration.v1",
        { test: true },
      ),
    });
    for (const attempt of result.attempts) {
      const infra = attempt.rawEvidence.filter(
        (event) => event.type === "infrastructure.error",
      );
      if (infra.length > 0) {
        console.log(attempt.report.scenarioId, JSON.stringify(infra));
      }
    }
    console.log(JSON.stringify(result.summary, null, 2));
    expect(result.attempts).toHaveLength(7);
    void aggregateTrustAttempts;
  }, 120_000);
});
