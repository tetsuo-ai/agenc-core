#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { canonicalJson, REQUIRED_GATE_CONTEXT } from "./required-gate-contract.mjs";

const REQUIRED_GATE_CONTEXT_PATTERN = /^agenc-local-required-v([1-9][0-9]*)$/u;

function requiredGateContext(value) {
  const match = typeof value === "string" ? REQUIRED_GATE_CONTEXT_PATTERN.exec(value) : null;
  const epoch = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw new TypeError("required gate context must end in a positive safe vN epoch");
  }
  return Object.freeze({ context: value, epoch });
}

function rulesetNameForContext(context) {
  return requiredGateContext(context).context.replace(/^agenc-/u, "agenc-main-");
}

export function previousRequiredGateContext(context) {
  const parsed = requiredGateContext(context);
  if (parsed.epoch === 1) {
    throw new Error("required gate context v1 has no policy-rotation predecessor");
  }
  return `agenc-local-required-v${parsed.epoch - 1}`;
}

export const REQUIRED_GATE_RULESET_NAME = rulesetNameForContext(REQUIRED_GATE_CONTEXT);
export const REQUIRED_GATE_RULESET_REPOSITORY = "tetsuo-ai/agenc-core";
export const STALE_HOSTED_GATE_CONTEXTS = Object.freeze(["agenc-m0-required"]);
const CUTOVER_AUDIT_SCHEMA_VERSION = 1;
const MAX_RULESET_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_CUTOVER_SNAPSHOT_AGE_MS = 5 * 60 * 1000;
const MAX_CUTOVER_SNAPSHOT_FUTURE_MS = 30 * 1000;

function positiveInteger(value, label) {
  const parsed = typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function rulesetEnforcement(value) {
  if (value !== "disabled" && value !== "active") {
    throw new TypeError("ruleset enforcement must be disabled or active");
  }
  return value;
}

function rulesetSource(value, enforcement) {
  if (value !== "any" && value !== "app") {
    throw new TypeError("ruleset source must be any or app");
  }
  if (value === "any" && enforcement !== "disabled") {
    throw new Error("an any-source bootstrap ruleset must remain disabled");
  }
  return value;
}

function buildRequiredGateRuleset({
  appId,
  enforcement,
  source = "app",
  context = REQUIRED_GATE_CONTEXT,
}) {
  const integrationId = positiveInteger(appId, "GitHub App ID");
  const normalizedEnforcement = rulesetEnforcement(enforcement);
  const normalizedSource = rulesetSource(source, normalizedEnforcement);
  const normalizedContext = requiredGateContext(context).context;
  return Object.freeze({
    name: rulesetNameForContext(normalizedContext),
    target: "branch",
    enforcement: normalizedEnforcement,
    bypass_actors: Object.freeze([]),
    conditions: Object.freeze({
      ref_name: Object.freeze({
        include: Object.freeze(["refs/heads/main"]),
        exclude: Object.freeze([]),
      }),
    }),
    rules: Object.freeze([
      Object.freeze({
        type: "required_status_checks",
        parameters: Object.freeze({
          do_not_enforce_on_create: false,
          required_status_checks: Object.freeze([
            Object.freeze({
              context: normalizedContext,
              ...(normalizedSource === "app" ? { integration_id: integrationId } : {}),
            }),
          ]),
          strict_required_status_checks_policy: true,
        }),
      }),
    ]),
  });
}

export function createRequiredGateRuleset({
  appId,
  enforcement,
  source = "app",
  rulesetId,
  bootstrapRulesetId,
  cutoverInventory,
  policyRotationInventory,
  now,
}) {
  const payload = buildRequiredGateRuleset({ appId, enforcement, source });
  if (payload.enforcement === "active") {
    if (
      rulesetId === undefined ||
      (cutoverInventory === undefined) === (policyRotationInventory === undefined)
    ) {
      throw new Error(
        "activating the local gate ruleset requires exactly one current cutover or policy-rotation inventory",
      );
    }
    if (cutoverInventory !== undefined) {
      if (bootstrapRulesetId !== undefined) {
        throw new Error("initial cutover rendering must not specify a bootstrap ruleset ID");
      }
      verifyCutoverInventory(cutoverInventory, { appId, rulesetId, now });
    } else {
      verifyPolicyContextRotationInventory(policyRotationInventory, {
        appId,
        rulesetId,
        bootstrapRulesetId,
        now,
      });
    }
  }
  return payload;
}

function verifyRequiredGateRulesetForContext(
  value,
  { appId, enforcement, source = "app", context = REQUIRED_GATE_CONTEXT },
) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("GitHub ruleset readback must be an object");
  }
  const expected = buildRequiredGateRuleset({ appId, enforcement, source, context });
  if (
    value.source_type !== "Repository" ||
    value.source !== REQUIRED_GATE_RULESET_REPOSITORY
  ) {
    throw new Error("GitHub ruleset readback has an unexpected repository source");
  }
  for (const field of [
    "name",
    "target",
    "enforcement",
    "bypass_actors",
    "conditions",
    "rules",
  ]) {
    if (canonicalJson(value[field]) !== canonicalJson(expected[field])) {
      throw new Error(`GitHub ruleset readback has unexpected ${field}`);
    }
  }
  const rulesetId = positiveInteger(value.id, "GitHub ruleset ID");
  return Object.freeze({
    rulesetId,
    name: expected.name,
    enforcement: expected.enforcement,
    source,
    integrationId: source === "app" ? positiveInteger(appId, "GitHub App ID") : null,
    context: requiredGateContext(context).context,
    targetRef: expected.conditions.ref_name.include[0],
  });
}

export function verifyRequiredGateRuleset(value, options) {
  return verifyRequiredGateRulesetForContext(value, options);
}

function objectValue(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function arrayValue(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
  return value;
}

function verifyRecentCapture(value, now = Date.now()) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    throw new TypeError("cutover snapshot captured_at must be an ISO-8601 UTC timestamp");
  }
  if (!Number.isFinite(now) || now <= 0) {
    throw new TypeError("cutover audit clock must be positive");
  }
  const capturedAt = Date.parse(value);
  if (!Number.isFinite(capturedAt)) throw new TypeError("cutover snapshot captured_at is invalid");
  if (capturedAt - now > MAX_CUTOVER_SNAPSHOT_FUTURE_MS) {
    throw new Error("cutover snapshot captured_at is in the future");
  }
  if (now - capturedAt > MAX_CUTOVER_SNAPSHOT_AGE_MS) {
    throw new Error("cutover snapshot is older than five minutes");
  }
  return value;
}

function verifySnapshotMetadata(value, { endpoint, includesParents, now }) {
  const snapshot = objectValue(value, "GitHub policy snapshot");
  if (snapshot.schema_version !== CUTOVER_AUDIT_SCHEMA_VERSION) {
    throw new Error(
      `GitHub policy snapshot schema_version must be ${CUTOVER_AUDIT_SCHEMA_VERSION}`,
    );
  }
  if (snapshot.repository !== REQUIRED_GATE_RULESET_REPOSITORY || snapshot.branch !== "main") {
    throw new Error("GitHub policy snapshot has an unexpected repository or branch");
  }
  verifyRecentCapture(snapshot.captured_at, now);
  const query = objectValue(snapshot.query, "GitHub policy snapshot query");
  if (
    query.endpoint !== endpoint ||
    query.per_page !== 100 ||
    query.paginated !== true ||
    !Number.isSafeInteger(query.page_count) ||
    query.page_count <= 0
  ) {
    throw new Error("GitHub policy snapshot does not prove a complete paginated query");
  }
  if (includesParents) {
    if (query.includes_parents !== true || query.targets !== "branch") {
      throw new Error("GitHub ruleset inventory must include parent branch rulesets");
    }
  }
  return snapshot;
}

function integrationId(value, label) {
  if (value === undefined || value === null) return null;
  return safeInteger(value, label);
}

function collectRequiredChecks(rules, describeRule) {
  const checks = [];
  for (const [index, rawRule] of arrayValue(rules, "GitHub rules").entries()) {
    const rule = objectValue(rawRule, `GitHub rule ${index}`);
    if (rule.type !== "required_status_checks") continue;
    const description = describeRule(rule, index);
    const parameters = objectValue(rule.parameters, `${description} parameters`);
    const required = arrayValue(
      parameters.required_status_checks,
      `${description} required_status_checks`,
    );
    for (const [checkIndex, rawCheck] of required.entries()) {
      const check = objectValue(rawCheck, `${description} required check ${checkIndex}`);
      checks.push(Object.freeze({
        context: nonEmptyString(check.context, `${description} required check context`),
        integrationId: integrationId(
          check.integration_id,
          `${description} required check integration_id`,
        ),
        location: description,
        rulesetId: rule.ruleset_id ?? null,
      }));
    }
  }
  return checks;
}

function collectLegacyProtectionChecks(value) {
  const legacy = objectValue(value, "legacy main branch protection evidence");
  if (legacy.status === 404) {
    if (legacy.body !== null) {
      throw new Error("404 legacy main branch protection evidence must have a null body");
    }
    return [];
  }
  if (legacy.status !== 200) {
    throw new Error("legacy main branch protection evidence must record HTTP 200 or 404");
  }
  const body = objectValue(legacy.body, "legacy main branch protection body");
  if (body.required_status_checks === undefined || body.required_status_checks === null) return [];
  const required = objectValue(
    body.required_status_checks,
    "legacy main branch required_status_checks",
  );
  const checks = [];
  const contexts = arrayValue(required.contexts, "legacy main branch status contexts");
  for (const [index, context] of contexts.entries()) {
    checks.push(Object.freeze({
      context: nonEmptyString(context, `legacy main branch status context ${index}`),
      integrationId: null,
      location: "legacy main branch protection contexts",
      rulesetId: null,
    }));
  }
  const branchChecks = required.checks === undefined
    ? []
    : arrayValue(required.checks, "legacy main branch status checks");
  for (const [index, rawCheck] of branchChecks.entries()) {
    const check = objectValue(rawCheck, `legacy main branch status check ${index}`);
    checks.push(Object.freeze({
      context: nonEmptyString(check.context, `legacy main branch status check ${index} context`),
      integrationId: integrationId(
        check.app_id,
        `legacy main branch status check ${index} app_id`,
      ),
      location: "legacy main branch protection checks",
      rulesetId: null,
    }));
  }
  return checks;
}

function verifyRequiredCheckSet(checks, { appId, expected }) {
  const expectedAppId = positiveInteger(appId, "GitHub App ID");
  const expectedByContext = new Map();
  for (const [index, rawExpected] of arrayValue(expected, "expected required checks").entries()) {
    const expectedCheck = objectValue(rawExpected, `expected required check ${index}`);
    const context = requiredGateContext(expectedCheck.context).context;
    if (expectedByContext.has(context)) {
      throw new Error(`expected required-check set repeats ${context}`);
    }
    expectedByContext.set(context, positiveInteger(
      expectedCheck.rulesetId,
      `expected required check ${context} ruleset ID`,
    ));
  }
  const observedContexts = new Set();
  for (const check of checks) {
    if (STALE_HOSTED_GATE_CONTEXTS.includes(check.context)) {
      throw new Error(
        `stale hosted required check ${JSON.stringify(check.context)} remains in ${check.location}`,
      );
    }
    const expectedRulesetId = expectedByContext.get(check.context);
    if (expectedRulesetId === undefined) {
      throw new Error(
        `unexpected required check ${JSON.stringify(check.context)} remains in ${check.location}`,
      );
    }
    if (observedContexts.has(check.context)) {
      throw new Error(`required check ${JSON.stringify(check.context)} is duplicated`);
    }
    if (check.rulesetId !== expectedRulesetId) {
      throw new Error(
        `required check ${JSON.stringify(check.context)} is outside ruleset ${expectedRulesetId}`,
      );
    }
    if (check.integrationId !== expectedAppId) {
      throw new Error(
        `required check ${JSON.stringify(check.context)} is not bound to the expected GitHub App`,
      );
    }
    observedContexts.add(check.context);
  }
  if (
    observedContexts.size !== expectedByContext.size ||
    [...expectedByContext.keys()].some((context) => !observedContexts.has(context))
  ) {
    throw new Error("the layered main policy is missing an expected App-bound required check");
  }
}

function verifyOnlyIntendedRequiredCheck(
  checks,
  { appId, rulesetId, context = REQUIRED_GATE_CONTEXT },
) {
  verifyRequiredCheckSet(checks, {
    appId,
    expected: [{ context, rulesetId }],
  });
}

function readLayeredRulesetInventory(value, { rulesetId, now }) {
  const expectedRulesetId = positiveInteger(rulesetId, "GitHub ruleset ID");
  const snapshot = verifySnapshotMetadata(value, {
    endpoint: `repos/${REQUIRED_GATE_RULESET_REPOSITORY}/rulesets`,
    includesParents: true,
    now,
  });
  const listed = arrayValue(snapshot.listed_rulesets, "listed GitHub rulesets");
  const details = arrayValue(snapshot.rulesets, "full GitHub rulesets");
  const listedById = new Map();
  for (const [index, rawSummary] of listed.entries()) {
    const summary = objectValue(rawSummary, `listed GitHub ruleset ${index}`);
    const id = positiveInteger(summary.id, `listed GitHub ruleset ${index} ID`);
    if (listedById.has(id)) throw new Error(`GitHub ruleset inventory repeats listed ID ${id}`);
    for (const field of ["name", "source_type", "source", "enforcement"]) {
      nonEmptyString(summary[field], `listed GitHub ruleset ${id} ${field}`);
    }
    if (summary.target !== undefined && summary.target !== "branch") {
      throw new Error(`listed GitHub ruleset ${id} is not a branch ruleset`);
    }
    listedById.set(id, summary);
  }
  const detailsById = new Map();
  for (const [index, rawDetail] of details.entries()) {
    const detail = objectValue(rawDetail, `full GitHub ruleset ${index}`);
    const id = positiveInteger(detail.id, `full GitHub ruleset ${index} ID`);
    if (detailsById.has(id)) throw new Error(`GitHub ruleset inventory repeats full ID ${id}`);
    if (detail.target !== "branch") {
      throw new Error(`full GitHub ruleset ${id} is not a branch ruleset`);
    }
    arrayValue(detail.rules, `full GitHub ruleset ${id} rules`);
    detailsById.set(id, detail);
  }
  if (listedById.size !== detailsById.size) {
    throw new Error("GitHub ruleset inventory is missing one or more full ruleset readbacks");
  }
  for (const [id, summary] of listedById) {
    const detail = detailsById.get(id);
    if (detail === undefined) {
      throw new Error(`GitHub ruleset inventory is missing full ruleset ${id}`);
    }
    for (const field of ["name", "source_type", "source", "enforcement"]) {
      if (detail[field] !== summary[field]) {
        throw new Error(`GitHub ruleset ${id} summary and full readback disagree on ${field}`);
      }
    }
  }
  const intended = detailsById.get(expectedRulesetId);
  if (intended === undefined) {
    throw new Error(
      `GitHub ruleset inventory does not include intended ruleset ${expectedRulesetId}`,
    );
  }
  const checks = [];
  for (const [id, detail] of detailsById) {
    checks.push(...collectRequiredChecks(
      detail.rules,
      () => `ruleset ${id} (${detail.source_type}:${detail.source})`,
    ).map((check) => Object.freeze({ ...check, rulesetId: id })));
  }
  checks.push(...collectLegacyProtectionChecks(snapshot.legacy_main_protection));
  return Object.freeze({
    snapshot,
    detailsById,
    intended,
    checks: Object.freeze(checks),
    expectedRulesetId,
  });
}

function verifyInventoryRequiredCheckState(
  inventory,
  { appId, context, enforcement },
) {
  const expectedContext = requiredGateContext(context).context;
  const expectedName = rulesetNameForContext(expectedContext);
  verifyRequiredGateRulesetForContext(inventory.intended, {
    appId,
    enforcement,
    source: "app",
    context: expectedContext,
  });
  if (
    [...inventory.detailsById.values()].filter(
      (detail) => detail.name === expectedName,
    ).length !== 1
  ) {
    throw new Error(
      `GitHub ruleset inventory must contain exactly one ${expectedName}`,
    );
  }
  verifyOnlyIntendedRequiredCheck(inventory.checks, {
    appId,
    rulesetId: inventory.expectedRulesetId,
    context: expectedContext,
  });
}

export function verifyCutoverInventory(value, { appId, rulesetId, now = Date.now() }) {
  const inventory = readLayeredRulesetInventory(value, { rulesetId, now });
  verifyInventoryRequiredCheckState(inventory, {
    appId,
    context: REQUIRED_GATE_CONTEXT,
    enforcement: "disabled",
  });
  return Object.freeze({
    schemaVersion: CUTOVER_AUDIT_SCHEMA_VERSION,
    repository: REQUIRED_GATE_RULESET_REPOSITORY,
    branch: "main",
    rulesetCount: inventory.detailsById.size,
    intendedRulesetId: inventory.expectedRulesetId,
    context: REQUIRED_GATE_CONTEXT,
    integrationId: positiveInteger(appId, "GitHub App ID"),
    capturedAt: inventory.snapshot.captured_at,
  });
}

export function verifyPolicyContextRotationInventory(
  value,
  {
    appId,
    rulesetId,
    bootstrapRulesetId,
    requiredContext = REQUIRED_GATE_CONTEXT,
    now = Date.now(),
  },
) {
  const nextContext = requiredGateContext(requiredContext).context;
  const previousContext = previousRequiredGateContext(nextContext);
  const activeRulesetId = positiveInteger(rulesetId, "GitHub ruleset ID");
  const bootstrapId = positiveInteger(bootstrapRulesetId, "bootstrap GitHub ruleset ID");
  if (activeRulesetId === bootstrapId) {
    throw new Error("policy-context rotation requires a separate bootstrap ruleset");
  }
  const inventory = readLayeredRulesetInventory(value, { rulesetId, now });
  const bootstrapRuleset = inventory.detailsById.get(bootstrapId);
  if (bootstrapRuleset === undefined) {
    throw new Error(`GitHub ruleset inventory is missing bootstrap ruleset ${bootstrapId}`);
  }
  verifyRequiredGateRulesetForContext(bootstrapRuleset, {
    appId,
    context: nextContext,
    enforcement: "disabled",
    source: "app",
  });
  verifyRequiredGateRulesetForContext(inventory.intended, {
    appId,
    context: previousContext,
    enforcement: "active",
    source: "app",
  });
  for (const context of [previousContext, nextContext]) {
    const name = rulesetNameForContext(context);
    if (
      [...inventory.detailsById.values()].filter((detail) => detail.name === name).length !== 1
    ) {
      throw new Error(`GitHub ruleset inventory must contain exactly one ${name}`);
    }
  }
  verifyRequiredCheckSet(inventory.checks, {
    appId,
    expected: [
      { context: previousContext, rulesetId: activeRulesetId },
      { context: nextContext, rulesetId: bootstrapId },
    ],
  });
  return Object.freeze({
    schemaVersion: CUTOVER_AUDIT_SCHEMA_VERSION,
    repository: REQUIRED_GATE_RULESET_REPOSITORY,
    branch: "main",
    rulesetCount: inventory.detailsById.size,
    intendedRulesetId: activeRulesetId,
    bootstrapRulesetId: bootstrapId,
    previousContext,
    context: nextContext,
    previousRulesetName: rulesetNameForContext(previousContext),
    rulesetName: rulesetNameForContext(nextContext),
    integrationId: positiveInteger(appId, "GitHub App ID"),
    capturedAt: inventory.snapshot.captured_at,
  });
}

export function verifyEffectiveMainRules(value, { appId, rulesetId, now = Date.now() }) {
  const expectedRulesetId = positiveInteger(rulesetId, "GitHub ruleset ID");
  const snapshot = verifySnapshotMetadata(value, {
    endpoint: `repos/${REQUIRED_GATE_RULESET_REPOSITORY}/rules/branches/main`,
    includesParents: false,
    now,
  });
  const rules = arrayValue(snapshot.rules, "effective GitHub main rules");
  const expectedParameters = buildRequiredGateRuleset({
    appId,
    enforcement: "active",
    source: "app",
  }).rules[0].parameters;
  let intendedRuleCount = 0;
  const checks = collectRequiredChecks(rules, (rule, index) => {
    const id = positiveInteger(rule.ruleset_id, `effective GitHub rule ${index} ruleset_id`);
    if (id === expectedRulesetId) {
      intendedRuleCount += 1;
      if (
        rule.ruleset_source_type !== "Repository" ||
        rule.ruleset_source !== REQUIRED_GATE_RULESET_REPOSITORY ||
        canonicalJson(rule.parameters) !== canonicalJson(expectedParameters)
      ) {
        throw new Error(
          "effective main local required-check rule differs from the intended policy",
        );
      }
    }
    return `effective ruleset ${id} (` +
      `${String(rule.ruleset_source_type)}:${String(rule.ruleset_source)})`;
  });
  if (intendedRuleCount !== 1) {
    throw new Error("effective main rules must contain exactly one intended required-check rule");
  }
  checks.push(...collectLegacyProtectionChecks(snapshot.legacy_main_protection));
  verifyOnlyIntendedRequiredCheck(checks, { appId, rulesetId: expectedRulesetId });
  return Object.freeze({
    schemaVersion: CUTOVER_AUDIT_SCHEMA_VERSION,
    repository: REQUIRED_GATE_RULESET_REPOSITORY,
    branch: "main",
    effectiveRuleCount: rules.length,
    intendedRulesetId: expectedRulesetId,
    context: REQUIRED_GATE_CONTEXT,
    integrationId: positiveInteger(appId, "GitHub App ID"),
    capturedAt: snapshot.captured_at,
  });
}

function parseArguments(argv) {
  const mode = argv[0];
  if (![
    "--render",
    "--verify",
    "--verify-cutover",
    "--verify-policy-rotation",
    "--verify-effective",
  ].includes(mode)) {
    throw new Error(
      "usage: local-gate-ruleset (--render|--verify|--verify-cutover|--verify-policy-rotation|--verify-effective) [options]",
    );
  }
  const allowedFlags = mode === "--render"
    ? new Set([
        "--app-id",
        "--enforcement",
        "--source",
        "--ruleset-id",
        "--bootstrap-ruleset-id",
        "--cutover-inventory",
        "--policy-rotation-inventory",
      ])
    : mode === "--verify"
      ? new Set(["--app-id", "--enforcement", "--source"])
    : mode === "--verify-policy-rotation"
        ? new Set(["--app-id", "--ruleset-id", "--bootstrap-ruleset-id"])
        : new Set(["--app-id", "--ruleset-id"]);
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowedFlags.has(flag) || value === undefined) {
      throw new Error(`invalid local-gate ruleset option: ${flag ?? "(missing)"}`);
    }
    if (values.has(flag)) throw new Error(`duplicate local-gate ruleset option: ${flag}`);
    values.set(flag, value);
  }
  if (!values.has("--app-id")) throw new Error("local-gate ruleset requires --app-id");
  if (mode === "--render" || mode === "--verify") {
    if (!values.has("--enforcement") || !values.has("--source")) {
      throw new Error("local-gate ruleset render/readback requires --enforcement and --source");
    }
  } else if (!values.has("--ruleset-id")) {
    throw new Error("local-gate ruleset layered verification requires --ruleset-id");
  }
  if (mode === "--verify-policy-rotation" && !values.has("--bootstrap-ruleset-id")) {
    throw new Error("policy-context rotation verification requires --bootstrap-ruleset-id");
  }
  if (mode === "--render" && values.get("--enforcement") === "active") {
    if (
      !values.has("--ruleset-id") ||
      values.has("--cutover-inventory") === values.has("--policy-rotation-inventory")
    ) {
      throw new Error(
        "active rendering requires --ruleset-id and exactly one cutover or policy-rotation inventory",
      );
    }
    if (
      values.has("--policy-rotation-inventory") !== values.has("--bootstrap-ruleset-id")
    ) {
      throw new Error("policy-context rotation rendering requires --bootstrap-ruleset-id");
    }
  } else if (
    mode === "--render" &&
    (
      values.has("--ruleset-id") ||
      values.has("--bootstrap-ruleset-id") ||
      values.has("--cutover-inventory") ||
      values.has("--policy-rotation-inventory")
    )
  ) {
    throw new Error("layered inventory options are only valid for active rendering");
  }
  return Object.freeze({
    mode,
    appId: values.get("--app-id"),
    enforcement: values.get("--enforcement"),
    source: values.get("--source"),
    rulesetId: values.get("--ruleset-id"),
    bootstrapRulesetId: values.get("--bootstrap-ruleset-id"),
    cutoverInventoryPath: values.get("--cutover-inventory"),
    policyRotationInventoryPath: values.get("--policy-rotation-inventory"),
  });
}

function parseBoundedJson(bytes, label) {
  if (bytes.length === 0 || bytes.length > MAX_RULESET_RESPONSE_BYTES) {
    throw new Error(`${label} must be between 1 byte and 8 MiB`);
  }
  return JSON.parse(bytes.toString("utf8"));
}

function readBoundedStdin() {
  return parseBoundedJson(readFileSync(0), "GitHub policy readback");
}

function readBoundedJsonFile(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("layered inventory path is required");
  }
  return parseBoundedJson(readFileSync(path), "GitHub layered inventory");
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.mode === "--render") {
    const cutoverInventory = options.cutoverInventoryPath === undefined
      ? undefined
      : readBoundedJsonFile(options.cutoverInventoryPath);
    const policyRotationInventory = options.policyRotationInventoryPath === undefined
      ? undefined
      : readBoundedJsonFile(options.policyRotationInventoryPath);
    process.stdout.write(`${canonicalJson(createRequiredGateRuleset({
      ...options,
      cutoverInventory,
      policyRotationInventory,
    }))}\n`);
    return;
  }
  const input = readBoundedStdin();
  const verified = options.mode === "--verify"
    ? verifyRequiredGateRuleset(input, options)
    : options.mode === "--verify-cutover"
      ? verifyCutoverInventory(input, options)
      : options.mode === "--verify-policy-rotation"
        ? verifyPolicyContextRotationInventory(input, options)
        : verifyEffectiveMainRules(input, options);
  process.stdout.write(`${canonicalJson(verified)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `local-gate-ruleset: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
