import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import competitiveJson from "../../eval/suites/competitive-coding/1.0.0/definition.json" with {
  type: "json",
};
import catalogJson from "../../eval/suites/catalog.json" with { type: "json" };
import trustJson from "../../eval/suites/trust-conformance/1.0.0/definition.json" with {
  type: "json",
};
import trustFixturesJson from "../../eval/suites/trust-conformance/1.0.0/fixtures.json" with {
  type: "json",
};
import {
  EVAL_CONTRACT_VERSION,
  withDocumentDigest,
  type PreregistrationDocument,
  type Sha256Digest,
} from "../../src/eval-contract/index.js";
import {
  EVAL_SUITE_PROTOCOL_VERSION,
  EvalSuiteProtocolValidationError,
  RELEASED_EVAL_SUITE_V1_DIGESTS,
  assertReleasedEvalSuiteCatalog,
  compileCompetitiveFaultPlan,
  compileTrustFaultPlans,
  computeCompetitiveHarnessConfigDigest,
  loadAndValidateEvalSuiteCatalog,
  validateCompetitiveConditionRegistrations,
  validateEvalSuiteCatalogSet,
  validateEvalSuiteProtocolDocument,
  type CompetitiveCodingSuiteDefinitionDocument,
  type CompetitiveCondition,
  type CompetitiveConditionRegistration,
  type EvalSuiteCatalogDocument,
  type TrustConformanceSuiteDefinitionDocument,
  type TrustFixtureBundleDocument,
  validateTrustFixtureBundleBinding,
} from "../../src/eval-suites/index.js";
import { makePreregistration, makeSuite } from "./evaluation-contract-fixtures.js";

const competitive = competitiveJson as unknown as CompetitiveCodingSuiteDefinitionDocument;
const trust = trustJson as unknown as TrustConformanceSuiteDefinitionDocument;
const trustFixtures = trustFixturesJson as unknown as TrustFixtureBundleDocument;
const catalog = catalogJson as unknown as EvalSuiteCatalogDocument;

function resign<T extends { readonly documentDigest: Sha256Digest }>(
  value: T,
  transform: (draft: Record<string, unknown>) => void,
): T {
  const draft = structuredClone(value) as unknown as Record<string, unknown>;
  delete draft.documentDigest;
  transform(draft);
  return withDocumentDigest<T>(draft as Omit<T, "documentDigest">);
}

function preregistrationFor(
  condition: CompetitiveCondition,
  index: number,
): CompetitiveConditionRegistration {
  return preregistrationForSuite(condition, index, makeSuite());
}

function preregistrationForSuite(
  condition: CompetitiveCondition,
  index: number,
  suite: ReturnType<typeof makeSuite>,
): CompetitiveConditionRegistration {
  const base = makePreregistration(suite);
  const { documentDigest: _documentDigest, ...unsigned } = base;
  const preregistration = withDocumentDigest<PreregistrationDocument>({
    ...unsigned,
    experimentId: `experiment-${condition}-${index}`,
    evaluator: {
      ...base.evaluator,
      harnessConfigDigest: computeCompetitiveHarnessConfigDigest(competitive, condition),
    },
  });
  return { condition, suite, preregistration };
}

describe("versioned evaluation suite protocol", () => {
  it("validates the committed two-suite catalog without changing evaluation contract v1", async () => {
    expect(EVAL_CONTRACT_VERSION).toBe("1.0.0");
    expect(EVAL_SUITE_PROTOCOL_VERSION).toBe("1.0.0");
    const validated = assertReleasedEvalSuiteCatalog(
      validateEvalSuiteCatalogSet(catalog, [competitive, trust]),
    );
    expect(validated.competitive.suiteClass).toBe("competitive_coding");
    expect(validated.trust.suiteClass).toBe("trust_conformance");
    expect(validated.competitive.reporting.kind).not.toBe(validated.trust.reporting.kind);
    expect(validateTrustFixtureBundleBinding(trust, trustFixtures).scenarios).toHaveLength(7);
    expect(RELEASED_EVAL_SUITE_V1_DIGESTS).toEqual({
      catalog: "sha256:531627aec0c3a287ebd568494e1a9c0dc8116f01d324a61d571d1a200e2bde62",
      competitive: "sha256:e7214668c3bd9d9299afb61ade397232f3e060d8a45ee7bd26ac87675514f69b",
      trust: "sha256:e83ad76587b4e0fa8897f29a7148ac3c1823e560eff86ea43fc4fec7105db811",
    });

    const loaded = await loadAndValidateEvalSuiteCatalog(
      path.resolve("eval/suites/catalog.json"),
    );
    expect(loaded.catalog.documentDigest).toBe(catalog.documentDigest);
    expect(Object.isFrozen(loaded.competitive)).toBe(true);
  });

  it("rejects stale digests, product-specific competitive triggers, and mixed reports", () => {
    const stale = structuredClone(competitive) as unknown as Record<string, unknown>;
    stale.suiteVersion = "1.0.1";
    expect(() => validateEvalSuiteProtocolDocument(stale)).toThrow(/documentDigest/u);

    const productSpecific = resign(competitive, (draft) => {
      const schedule = draft.faultSchedule as Record<string, unknown>;
      schedule.agencEvent = "daemon.turn.accepted";
    });
    expect(() => validateEvalSuiteProtocolDocument(productSpecific)).toThrow(/unknown property/u);

    const mixedReport = resign(competitive, (draft) => {
      const reporting = draft.reporting as Record<string, unknown>;
      reporting.kind = "agenc.eval.trust-conformance-report";
    });
    expect(() => validateEvalSuiteProtocolDocument(mixedReport)).toThrow(
      EvalSuiteProtocolValidationError,
    );
  });

  it("requires every deterministic trust fault class and its exact oracle/evidence boundary", () => {
    const missingClass = resign(trust, (draft) => {
      const scenarios = draft.scenarios as unknown[];
      draft.scenarios = scenarios.slice(1);
    });
    expect(() => validateEvalSuiteProtocolDocument(missingClass)).toThrow(/fewer than 7 items/u);

    const swappedBoundary = resign(trust, (draft) => {
      const scenarios = draft.scenarios as Array<Record<string, unknown>>;
      scenarios[0].injectionBoundary = "after_event_publish_before_cursor_ack";
    });
    expect(() => validateEvalSuiteProtocolDocument(swappedBoundary)).toThrow(
      /restart: injection boundary differs/u,
    );

    const codingMetric = resign(trust, (draft) => {
      const reporting = draft.reporting as Record<string, unknown>;
      reporting.primaryMetric = "verified_fix_rate_clean";
    });
    expect(() => validateEvalSuiteProtocolDocument(codingMetric)).toThrow(
      EvalSuiteProtocolValidationError,
    );

    const changedFixture = resign(trustFixtures, (draft) => {
      const scenarios = draft.scenarios as Array<Record<string, unknown>>;
      const expectedState = scenarios[0].expectedState as Record<string, unknown>;
      expectedState.facts = ["different_expected_state"];
    });
    expect(() => validateTrustFixtureBundleBinding(trust, changedFixture)).toThrow(
      /expected-state digest mismatch/u,
    );
  });

  it("compiles a stable product-neutral fault schedule without system identity", () => {
    const suite = makeSuite();
    const kill = compileCompetitiveFaultPlan(competitive, suite, {
      condition: "coordinator_process_kill",
      taskId: "task-7",
      seedSlot: 101,
    });
    expect(kill).toEqual({
      kind: "agenc.eval.competitive-fault-plan",
      suiteDefinitionDigest: competitive.documentDigest,
      suiteId: "agenc-competitive-coding",
      suiteVersion: "1.0.0",
      suiteManifestDigest: suite.documentDigest,
      condition: "coordinator_process_kill",
      taskId: "task-7",
      taskVersion: "1.0.0",
      taskDocumentDigest: suite.tasks[7].documentDigest,
      taskWallTimeMs: 60_000,
      seedSlot: 101,
      delayAfterAcceptanceMs: 14_323,
      maximumDelayAfterAcceptanceMs: 29_000,
      recoveryWindowMs: 30_000,
      maximumInjectionJitterMs: 1_000,
      target: "coordinator_process_group",
      operation: "sigkill",
      recovery: "adapter_restart_and_attach",
      planDigest: "sha256:83c60c6c0a67a2584b227c491d6c161febcb5f8abb175d5b0560763a8d220439",
    });
    expect(compileCompetitiveFaultPlan(competitive, suite, {
      condition: "coordinator_process_kill",
      taskId: "task-7",
      seedSlot: 101,
    })).toEqual(kill);
    expect(Object.keys(kill)).not.toContain("systemId");

    expect(() => compileCompetitiveFaultPlan(competitive, suite, {
      condition: "client_disconnect",
      taskId: "missing-task",
      seedSlot: 101,
    })).toThrow(/not in the suite manifest/u);
    const shortTask = resign(suite.tasks[7], (draft) => {
      const budget = draft.budget as Record<string, unknown>;
      budget.wallTimeMs = 35_000;
    });
    const shortSuite = resign(suite, (draft) => {
      const tasks = draft.tasks as unknown[];
      tasks[7] = shortTask;
    });
    expect(() => compileCompetitiveFaultPlan(competitive, shortSuite, {
      condition: "client_disconnect",
      taskId: "task-7",
      seedSlot: 101,
    })).toThrow(/no valid fault\/recovery window/u);

    const trustPlans = compileTrustFaultPlans(trust, 101);
    expect(trustPlans).toHaveLength(7);
    expect(trustPlans.map((plan) => plan.scenarioId)).toEqual(
      [...trustPlans.map((plan) => plan.scenarioId)].sort(),
    );
    expect(trustPlans[0].planDigest).toBe(
      "sha256:481ab3035c42cf53d8817f252c30193ac9608dddb0116ebd898dfeaea0a2d39f",
    );
    expect(trustPlans[6].planDigest).toBe(
      "sha256:e2dfb8caa5d054756bad4a272dfe3845f313735ba089b9dca0f77c79541d6037",
    );
    expect(compileTrustFaultPlans(trust, 101)).toEqual(trustPlans);
  });

  it("binds clean, kill, and disconnect preregistrations to identical inputs", () => {
    const registrations = ([
      "clean",
      "coordinator_process_kill",
      "client_disconnect",
    ] as const).map(preregistrationFor);
    expect(validateCompetitiveConditionRegistrations(competitive, registrations)).toHaveLength(3);

    const wrongHarness = registrations.map((registration) => ({ ...registration }));
    const original = wrongHarness[1].preregistration;
    wrongHarness[1] = {
      ...wrongHarness[1],
      preregistration: resign(original, (draft) => {
        const evaluator = draft.evaluator as Record<string, unknown>;
        evaluator.harnessConfigDigest = `sha256:${"f".repeat(64)}`;
      }),
    };
    expect(() => validateCompetitiveConditionRegistrations(competitive, wrongHarness)).toThrow(
      /harness config digest/u,
    );

    const drifted = registrations.map((registration) => ({ ...registration }));
    const driftedPreregistration = drifted[2].preregistration;
    drifted[2] = {
      ...drifted[2],
      preregistration: resign(driftedPreregistration, (draft) => {
        const systems = draft.systems as Array<Record<string, unknown>>;
        systems[0].release = "1.0.1";
      }),
    };
    expect(() => validateCompetitiveConditionRegistrations(competitive, drifted)).toThrow(
      /inputs, systems, budgets, scoring, or trial design differ/u,
    );

    expect(() => validateCompetitiveConditionRegistrations(competitive, [
      null,
      {},
      registrations[2],
    ])).toThrow(EvalSuiteProtocolValidationError);
    expect(() => validateCompetitiveConditionRegistrations(competitive, [
      { ...registrations[0], suite: registrations[0].preregistration },
      registrations[1],
      registrations[2],
    ])).toThrow(/suite is not a v1 suite manifest/u);

    const boundaryTasks = registrations[0].suite.tasks.map((task) =>
      resign(task, (draft) => {
        const budget = draft.budget as Record<string, unknown>;
        budget.wallTimeMs = 35_000;
      })
    );
    const boundarySuite = resign(registrations[0].suite, (draft) => {
      draft.tasks = boundaryTasks;
    });
    const boundaryRegistrations = ([
      "clean",
      "coordinator_process_kill",
      "client_disconnect",
    ] as const).map((condition, index) =>
      preregistrationForSuite(condition, index, boundarySuite)
    );
    expect(() =>
      validateCompetitiveConditionRegistrations(competitive, boundaryRegistrations)
    ).toThrow(/no valid fault\/recovery window/u);
  });

  it("rejects catalog substitution and symlinked catalog input", async () => {
    expect(() => validateEvalSuiteCatalogSet(catalog, [trust, competitive])).toThrow(
      /catalog path does not resolve to its declared definition/u,
    );

    const substituted = resign(competitive, (draft) => {
      draft.suiteVersion = "1.0.1";
    });
    expect(() => validateEvalSuiteCatalogSet(catalog, [substituted, trust])).toThrow(
      /suite version mismatch|suite digest mismatch/u,
    );

    const rewrittenTrust = resign(trust, (draft) => {
      const scenarios = draft.scenarios as Array<Record<string, unknown>>;
      scenarios[0].timeoutMs = 60_001;
    });
    const rewrittenCatalog = resign(catalog, (draft) => {
      const entries = draft.activeDefinitions as Array<Record<string, unknown>>;
      entries[1].definitionDigest = rewrittenTrust.documentDigest;
    });
    const selfConsistentRewrite = validateEvalSuiteCatalogSet(
      rewrittenCatalog,
      [competitive, rewrittenTrust],
    );
    expect(() => assertReleasedEvalSuiteCatalog(selfConsistentRewrite)).toThrow(
      /bytes changed without a new/u,
    );

    if (process.platform === "win32") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "agenc-eval-suite-"));
    try {
      const linkedCatalog = path.join(root, "catalog.json");
      await symlink(path.resolve("eval/suites/catalog.json"), linkedCatalog);
      await expect(loadAndValidateEvalSuiteCatalog(linkedCatalog)).rejects.toThrow(/non-symlink/u);

      await rm(linkedCatalog);
      await writeFile(linkedCatalog, `${JSON.stringify(catalog)}\n`);
      const competitivePath = path.join(
        root,
        "competitive-coding/1.0.0/definition.json",
      );
      const trustPath = path.join(root, "trust-conformance/1.0.0/definition.json");
      await mkdir(path.dirname(competitivePath), { recursive: true });
      await mkdir(path.dirname(trustPath), { recursive: true });
      await symlink(
        path.resolve("eval/suites/competitive-coding/1.0.0/definition.json"),
        competitivePath,
      );
      await cp(path.resolve("eval/suites/trust-conformance/1.0.0/definition.json"), trustPath);
      await expect(loadAndValidateEvalSuiteCatalog(linkedCatalog)).rejects.toThrow(
        /regular non-symlink/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate-key, invalid UTF-8, oversized, and traversal catalog input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agenc-eval-suite-input-"));
    const candidate = path.join(root, "catalog.json");
    try {
      await writeFile(candidate, '{"kind":"first","kind":"second"}\n');
      await expect(loadAndValidateEvalSuiteCatalog(candidate)).rejects.toThrow(/duplicate JSON/u);

      await writeFile(candidate, Buffer.from([0xff]));
      await expect(loadAndValidateEvalSuiteCatalog(candidate)).rejects.toThrow(/not valid JSON/u);

      await writeFile(candidate, Buffer.alloc(1024 * 1024 + 1, 0x20));
      await expect(loadAndValidateEvalSuiteCatalog(candidate)).rejects.toThrow(/exceeds/u);

      const traversal = resign(catalog, (draft) => {
        const entries = draft.activeDefinitions as Array<Record<string, unknown>>;
        entries[0].path = "../definition.json";
      });
      await writeFile(candidate, `${JSON.stringify(traversal)}\n`);
      await expect(loadAndValidateEvalSuiteCatalog(candidate)).rejects.toThrow(
        /traversal, empty, or reserved segment/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes deterministic suite CLI success, validation-failure, and usage exits", () => {
    const tsxPath = fileURLToPath(
      new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url),
    );
    const cliPath = fileURLToPath(new URL("../../src/eval-suites/cli.ts", import.meta.url));
    const run = (...arguments_: string[]) => spawnSync(
      process.execPath,
      [tsxPath, cliPath, ...arguments_],
      { cwd: path.resolve("."), encoding: "utf8" },
    );

    const valid = run("--json");
    expect(valid.status, valid.stderr).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({
      valid: true,
      suiteProtocolVersion: EVAL_SUITE_PROTOCOL_VERSION,
    });

    const invalid = run("--json", path.join(os.tmpdir(), "missing-eval-suite-catalog.json"));
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ valid: false });

    const usage = run("--unknown");
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("Usage:");
  });
});
