import assert from "node:assert/strict";
import test from "node:test";

import {
  createRequiredGateRuleset,
  previousRequiredGateContext,
  REQUIRED_GATE_RULESET_NAME,
  REQUIRED_GATE_RULESET_REPOSITORY,
  STALE_HOSTED_GATE_CONTEXTS,
  verifyCutoverInventory,
  verifyEffectiveMainRules,
  verifyPolicyContextRotationInventory,
  verifyRequiredGateRuleset,
} from "./local-gate-ruleset.mjs";
import { REQUIRED_GATE_CONTEXT } from "./required-gate-contract.mjs";

const APP_ID = 42;
const RULESET_ID = 9001;
const CAPTURED_AT = "2026-07-15T18:00:00Z";
const NOW = Date.parse(CAPTURED_AT);

function intendedRulesetDetail({
  id = RULESET_ID,
  enforcement = "disabled",
  context = REQUIRED_GATE_CONTEXT,
} = {}) {
  const payload = structuredClone(createRequiredGateRuleset({
    appId: APP_ID,
    enforcement: "disabled",
    source: "app",
  }));
  payload.name = context.replace(/^agenc-/u, "agenc-main-");
  payload.rules[0].parameters.required_status_checks[0].context = context;
  return {
    id,
    source_type: "Repository",
    source: REQUIRED_GATE_RULESET_REPOSITORY,
    ...payload,
    enforcement,
  };
}

function summaryFor(detail) {
  return {
    id: detail.id,
    name: detail.name,
    target: detail.target,
    source_type: detail.source_type,
    source: detail.source,
    enforcement: detail.enforcement,
  };
}

function cutoverInventory({
  details = [intendedRulesetDetail()],
  legacyMainProtection = { status: 404, body: null },
  capturedAt = CAPTURED_AT,
} = {}) {
  return {
    schema_version: 1,
    repository: REQUIRED_GATE_RULESET_REPOSITORY,
    branch: "main",
    captured_at: capturedAt,
    query: {
      endpoint: `repos/${REQUIRED_GATE_RULESET_REPOSITORY}/rulesets`,
      includes_parents: true,
      targets: "branch",
      per_page: 100,
      paginated: true,
      page_count: 1,
    },
    listed_rulesets: details.map(summaryFor),
    rulesets: details,
    legacy_main_protection: legacyMainProtection,
  };
}

function effectiveMainRules({
  rules = [{
    type: "required_status_checks",
    ruleset_id: RULESET_ID,
    ruleset_source_type: "Repository",
    ruleset_source: REQUIRED_GATE_RULESET_REPOSITORY,
    parameters: structuredClone(intendedRulesetDetail().rules[0].parameters),
  }],
  legacyMainProtection = { status: 404, body: null },
  capturedAt = CAPTURED_AT,
} = {}) {
  return {
    schema_version: 1,
    repository: REQUIRED_GATE_RULESET_REPOSITORY,
    branch: "main",
    captured_at: capturedAt,
    query: {
      endpoint: `repos/${REQUIRED_GATE_RULESET_REPOSITORY}/rules/branches/main`,
      per_page: 100,
      paginated: true,
      page_count: 1,
    },
    rules,
    legacy_main_protection: legacyMainProtection,
  };
}

function hostedRulesetDetail({ context = STALE_HOSTED_GATE_CONTEXTS[0] } = {}) {
  return {
    id: 77,
    name: "legacy-hosted-required",
    target: "branch",
    source_type: "Repository",
    source: REQUIRED_GATE_RULESET_REPOSITORY,
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: [{
      type: "required_status_checks",
      parameters: {
        required_status_checks: [{ context, integration_id: 15368 }],
        strict_required_status_checks_policy: true,
      },
    }],
  };
}

test("ruleset payload binds main to the exact App-owned local check", () => {
  assert.deepEqual(createRequiredGateRuleset({
    appId: APP_ID,
    enforcement: "active",
    source: "app",
    rulesetId: RULESET_ID,
    cutoverInventory: cutoverInventory(),
    now: NOW,
  }), {
    name: REQUIRED_GATE_RULESET_NAME,
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: {
      ref_name: {
        include: ["refs/heads/main"],
        exclude: [],
      },
    },
    rules: [{
      type: "required_status_checks",
      parameters: {
        do_not_enforce_on_create: false,
        required_status_checks: [{
          context: REQUIRED_GATE_CONTEXT,
          integration_id: APP_ID,
        }],
        strict_required_status_checks_policy: true,
      },
    }],
  });
});

test("ruleset readback verifier rejects source, bypass, target, and strictness drift", () => {
  const expected = createRequiredGateRuleset({
    appId: APP_ID,
    enforcement: "active",
    source: "app",
    rulesetId: RULESET_ID,
    cutoverInventory: cutoverInventory(),
    now: NOW,
  });
  const response = {
    id: 9001,
    source_type: "Repository",
    source: REQUIRED_GATE_RULESET_REPOSITORY,
    ...expected,
  };
  assert.deepEqual(
    verifyRequiredGateRuleset(response, {
      appId: APP_ID,
      enforcement: "active",
      source: "app",
    }),
    {
      rulesetId: 9001,
      name: REQUIRED_GATE_RULESET_NAME,
      enforcement: "active",
      source: "app",
      integrationId: APP_ID,
      context: REQUIRED_GATE_CONTEXT,
      targetRef: "refs/heads/main",
    },
  );
  for (const mutate of [
    (value) => { value.source = "attacker/example"; },
    (value) => { value.source_type = "Organization"; },
    (value) => {
      value.bypass_actors = [{ actor_id: 1, actor_type: "Team", bypass_mode: "always" }];
    },
    (value) => { value.conditions.ref_name.include = ["refs/heads/release"]; },
    (value) => { value.rules[0].parameters.strict_required_status_checks_policy = false; },
    (value) => { value.rules[0].parameters.required_status_checks[0].integration_id = 7; },
    (value) => { value.rules[0].parameters.required_status_checks[0].context = "foreign-check"; },
  ]) {
    const changed = structuredClone(response);
    mutate(changed);
    assert.throws(
      () => verifyRequiredGateRuleset(changed, {
        appId: APP_ID,
        enforcement: "active",
        source: "app",
      }),
      /unexpected/u,
    );
  }
});

test("ruleset renderer requires an explicit safe App ID and enforcement state", () => {
  assert.throws(
    () => createRequiredGateRuleset({ appId: 0, enforcement: "disabled" }),
    /positive safe integer/u,
  );
  assert.throws(
    () => createRequiredGateRuleset({ appId: APP_ID, enforcement: "evaluate" }),
    /disabled or active/u,
  );
  assert.throws(
    () => createRequiredGateRuleset({
      appId: APP_ID,
      enforcement: "active",
      source: "any",
    }),
    /must remain disabled/u,
  );
  assert.throws(
    () => createRequiredGateRuleset({
      appId: APP_ID,
      enforcement: "active",
      source: "app",
    }),
    /requires exactly one current cutover or policy-rotation inventory/u,
  );
});

test("disabled bootstrap payload creates the required context before App binding", () => {
  const payload = createRequiredGateRuleset({
    appId: APP_ID,
    enforcement: "disabled",
    source: "any",
  });
  assert.deepEqual(
    payload.rules[0].parameters.required_status_checks,
    [{ context: REQUIRED_GATE_CONTEXT }],
  );
  assert.equal("integration_id" in payload.rules[0].parameters.required_status_checks[0], false);
  assert.deepEqual(
    verifyRequiredGateRuleset({
      id: 9002,
      source_type: "Repository",
      source: REQUIRED_GATE_RULESET_REPOSITORY,
      ...payload,
    }, {
      appId: APP_ID,
      enforcement: "disabled",
      source: "any",
    }).integrationId,
    null,
  );
});

test("cutover inventory covers all listed rulesets and legacy protection", () => {
  assert.deepEqual(
    verifyCutoverInventory(cutoverInventory(), {
      appId: APP_ID,
      rulesetId: RULESET_ID,
      now: NOW,
    }),
    {
      schemaVersion: 1,
      repository: REQUIRED_GATE_RULESET_REPOSITORY,
      branch: "main",
      rulesetCount: 1,
      intendedRulesetId: RULESET_ID,
      context: REQUIRED_GATE_CONTEXT,
      integrationId: APP_ID,
      capturedAt: CAPTURED_AT,
    },
  );

  const missingParentDetails = cutoverInventory();
  missingParentDetails.rulesets = [];
  assert.throws(
    () => verifyCutoverInventory(missingParentDetails, {
      appId: APP_ID,
      rulesetId: RULESET_ID,
      now: NOW,
    }),
    /missing one or more full ruleset readbacks/u,
  );

  const withoutParents = cutoverInventory();
  withoutParents.query.includes_parents = false;
  assert.throws(
    () => verifyCutoverInventory(withoutParents, {
      appId: APP_ID,
      rulesetId: RULESET_ID,
      now: NOW,
    }),
    /must include parent branch rulesets/u,
  );

  assert.throws(
    () => verifyCutoverInventory(cutoverInventory({
      capturedAt: "2026-07-15T17:54:59Z",
    }), {
      appId: APP_ID,
      rulesetId: RULESET_ID,
      now: NOW,
    }),
    /older than five minutes/u,
  );
});

test("cutover inventory rejects stale hosted and every unexpected required check", () => {
  for (const [inventory, pattern] of [
    [
      cutoverInventory({
        details: [intendedRulesetDetail(), hostedRulesetDetail()],
      }),
      /stale hosted required check "agenc-m0-required"/u,
    ],
    [
      cutoverInventory({
        details: [intendedRulesetDetail(), hostedRulesetDetail({ context: "unknown-remote-test" })],
      }),
      /unexpected required check "unknown-remote-test"/u,
    ],
    [
      cutoverInventory({
        legacyMainProtection: {
          status: 200,
          body: { required_status_checks: { contexts: ["agenc-m0-required"] } },
        },
      }),
      /stale hosted required check "agenc-m0-required"/u,
    ],
    [
      cutoverInventory({
        legacyMainProtection: {
          status: 200,
          body: {
            required_status_checks: {
              contexts: [],
              checks: [{ context: REQUIRED_GATE_CONTEXT, app_id: APP_ID }],
            },
          },
        },
      }),
      /is duplicated/u,
    ],
  ]) {
    assert.throws(
      () => verifyCutoverInventory(inventory, {
        appId: APP_ID,
        rulesetId: RULESET_ID,
        now: NOW,
      }),
      pattern,
    );
  }
});

test("policy rotation requires the immediately previous active context epoch", () => {
  assert.equal(previousRequiredGateContext("agenc-local-required-v2"), REQUIRED_GATE_CONTEXT);
  assert.throws(
    () => previousRequiredGateContext(REQUIRED_GATE_CONTEXT),
    /v1 has no policy-rotation predecessor/u,
  );

  const nextRulesetId = 9002;
  const activeV1WithDisabledV2 = cutoverInventory({
    details: [
      intendedRulesetDetail({ enforcement: "active" }),
      intendedRulesetDetail({
        id: nextRulesetId,
        context: "agenc-local-required-v2",
      }),
    ],
  });
  assert.deepEqual(
    verifyPolicyContextRotationInventory(activeV1WithDisabledV2, {
      appId: APP_ID,
      rulesetId: RULESET_ID,
      bootstrapRulesetId: nextRulesetId,
      requiredContext: "agenc-local-required-v2",
      now: NOW,
    }),
    {
      schemaVersion: 1,
      repository: REQUIRED_GATE_RULESET_REPOSITORY,
      branch: "main",
      rulesetCount: 2,
      intendedRulesetId: RULESET_ID,
      bootstrapRulesetId: nextRulesetId,
      previousContext: REQUIRED_GATE_CONTEXT,
      context: "agenc-local-required-v2",
      previousRulesetName: REQUIRED_GATE_RULESET_NAME,
      rulesetName: "agenc-main-local-required-v2",
      integrationId: APP_ID,
      capturedAt: CAPTURED_AT,
    },
  );

  assert.throws(
    () => verifyPolicyContextRotationInventory(activeV1WithDisabledV2, {
      appId: APP_ID,
      rulesetId: RULESET_ID,
      bootstrapRulesetId: nextRulesetId,
      requiredContext: "agenc-local-required-v3",
      now: NOW,
    }),
    /unexpected name|unexpected rules/u,
  );
});

test("effective main verifier proves the App-bound rule is the only required check", () => {
  assert.deepEqual(
    verifyEffectiveMainRules(effectiveMainRules(), {
      appId: APP_ID,
      rulesetId: RULESET_ID,
      now: NOW,
    }),
    {
      schemaVersion: 1,
      repository: REQUIRED_GATE_RULESET_REPOSITORY,
      branch: "main",
      effectiveRuleCount: 1,
      intendedRulesetId: RULESET_ID,
      context: REQUIRED_GATE_CONTEXT,
      integrationId: APP_ID,
      capturedAt: CAPTURED_AT,
    },
  );

  const stale = effectiveMainRules();
  stale.rules.push({
    type: "required_status_checks",
    ruleset_id: 77,
    ruleset_source_type: "Repository",
    ruleset_source: REQUIRED_GATE_RULESET_REPOSITORY,
    parameters: {
      required_status_checks: [{ context: "agenc-m0-required", integration_id: 15368 }],
      strict_required_status_checks_policy: true,
    },
  });
  assert.throws(
    () => verifyEffectiveMainRules(stale, {
      appId: APP_ID,
      rulesetId: RULESET_ID,
      now: NOW,
    }),
    /stale hosted required check/u,
  );

  const wrongApp = effectiveMainRules();
  wrongApp.rules[0].parameters.required_status_checks[0].integration_id = 7;
  assert.throws(
    () => verifyEffectiveMainRules(wrongApp, {
      appId: APP_ID,
      rulesetId: RULESET_ID,
      now: NOW,
    }),
    /differs from the intended policy/u,
  );

  const legacy = effectiveMainRules({
    legacyMainProtection: {
      status: 200,
      body: { required_status_checks: { contexts: ["other-hosted-check"] } },
    },
  });
  assert.throws(
    () => verifyEffectiveMainRules(legacy, {
      appId: APP_ID,
      rulesetId: RULESET_ID,
      now: NOW,
    }),
    /unexpected required check/u,
  );
});
