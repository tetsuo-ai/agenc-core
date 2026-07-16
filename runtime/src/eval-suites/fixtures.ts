import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import fixtureSchema from "./trust-fixture-bundle-v1.schema.json" with { type: "json" };
import {
  canonicalizeJson,
  computeDocumentDigest,
  digestCanonicalJson,
} from "../eval-contract/index.js";
import { EvalSuiteProtocolValidationError, validateEvalSuiteProtocolDocument } from "./validation.js";
import type {
  TrustFixtureBundleDocument,
} from "./types.js";

let compiledSchema: ValidateFunction | undefined;

function schemaValidator(): ValidateFunction {
  if (compiledSchema) return compiledSchema;
  compiledSchema = new Ajv({ allErrors: true, strict: true }).compile(fixtureSchema);
  return compiledSchema;
}

function renderSchemaErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  if (!errors) return ["document does not match trust fixture bundle v1"];
  const issues = new Set<string>();
  for (const error of errors) {
    const location = error.instancePath || "/";
    const detail = error.params && "additionalProperty" in error.params
      ? `unknown property ${String(error.params.additionalProperty)}`
      : error.message ?? error.keyword;
    issues.add(`${location}: ${detail}`);
  }
  return [...issues].slice(0, 64);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

export function validateTrustFixtureBundleDocument(
  value: unknown,
): TrustFixtureBundleDocument {
  const schema = schemaValidator();
  if (!schema(value)) {
    throw new EvalSuiteProtocolValidationError(renderSchemaErrors(schema.errors));
  }
  const document = value as TrustFixtureBundleDocument;
  const issues: string[] = [];
  if (document.documentDigest !== computeDocumentDigest(document)) {
    issues.push("trust fixture bundle documentDigest mismatch");
  }
  const scenarioIds = document.scenarios.map((scenario) => scenario.scenarioId);
  if (new Set(scenarioIds).size !== scenarioIds.length) {
    issues.push("trust fixture bundle scenario IDs must be unique");
  }
  if (issues.length > 0) throw new EvalSuiteProtocolValidationError(issues);
  return deepFreeze(
    JSON.parse(canonicalizeJson(document)) as TrustFixtureBundleDocument,
  );
}

export function validateTrustFixtureBundleBinding(
  definitionValue: unknown,
  bundleValue: unknown,
): TrustFixtureBundleDocument {
  const definition = validateEvalSuiteProtocolDocument(definitionValue);
  if (definition.kind !== "agenc.eval.trust-suite-definition") {
    throw new EvalSuiteProtocolValidationError([
      "trust fixture binding requires a trust-conformance definition",
    ]);
  }
  const bundle = validateTrustFixtureBundleDocument(bundleValue);
  const issues: string[] = [];
  const expected = {
    harness: digestCanonicalJson("agenc.eval.trust-fixture.harness.v1", bundle.harness),
    provider: digestCanonicalJson("agenc.eval.trust-fixture.provider.v1", bundle.fakeProvider),
    tools: digestCanonicalJson("agenc.eval.trust-fixture.tools.v1", bundle.fakeTools),
  };
  if (definition.execution.fixtureBundle.digest !== bundle.documentDigest) {
    issues.push("trust definition fixture bundle digest mismatch");
  }
  if (definition.execution.harnessImplementationDigest !== expected.harness) {
    issues.push("trust harness implementation digest mismatch");
  }
  if (definition.execution.fakeProviderFixtureDigest !== expected.provider) {
    issues.push("trust fake-provider fixture digest mismatch");
  }
  if (definition.execution.fakeToolFixtureDigest !== expected.tools) {
    issues.push("trust fake-tool fixture digest mismatch");
  }
  const byId = new Map(bundle.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  if (byId.size !== definition.scenarios.length) {
    issues.push("trust fixture scenario count mismatch");
  }
  for (const scenario of definition.scenarios) {
    const fixture = byId.get(scenario.scenarioId);
    if (!fixture) {
      issues.push(`${scenario.scenarioId}: fixture is missing`);
      continue;
    }
    if (
      scenario.fixtureDigest !==
        digestCanonicalJson("agenc.eval.trust-fixture.scenario.v1", fixture.fixture)
    ) {
      issues.push(`${scenario.scenarioId}: scenario fixture digest mismatch`);
    }
    if (
      scenario.initialStateDigest !==
        digestCanonicalJson("agenc.eval.trust-fixture.initial-state.v1", fixture.initialState)
    ) {
      issues.push(`${scenario.scenarioId}: initial-state digest mismatch`);
    }
    if (
      scenario.expectedStateDigest !==
        digestCanonicalJson("agenc.eval.trust-fixture.expected-state.v1", fixture.expectedState)
    ) {
      issues.push(`${scenario.scenarioId}: expected-state digest mismatch`);
    }
  }
  if (issues.length > 0) throw new EvalSuiteProtocolValidationError(issues);
  return bundle;
}
