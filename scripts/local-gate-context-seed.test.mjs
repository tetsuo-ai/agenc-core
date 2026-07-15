import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertApprovedContextSeedPolicy,
  assertContextSeedDeploymentRecords,
  assertExactFailureSeedCheck,
  assertImmutablePathChain,
  authenticateContextSeedApp,
  buildContextSeedCredentialCommand,
  CONTEXT_SEED_PURPOSE,
  CONTEXT_SEED_REF,
  CONTEXT_SEED_REPOSITORY,
  CONTEXT_SEED_TITLE,
  contextSeedExternalId,
  createContextSeedEvidence,
  createFailureOnlySeedBody,
  dispatchContextSeed,
  listNextContextCheckRuns,
  parseContextSeedArguments,
  parseSystemctlShow,
  pruneOrphanedContextSeedHandoffs,
  runCredentialedContextSeed,
} from "./local-gate-context-seed.mjs";
import {
  computeRequiredGateContract,
  NEXT_REQUIRED_GATE_CONTEXT,
  REQUIRED_GATE_CONTEXT,
  REQUIRED_GATE_POLICY_PATHS,
} from "./required-gate-contract.mjs";
import {
  LOCAL_GATE_AGGREGATE_CGROUP,
  LOCAL_GATE_AGGREGATE_SLICE,
} from "./systemd-worker-sandbox.mjs";

const SOURCE_SHA = "1".repeat(40);
const MOVED_SHA = "2".repeat(40);
const POLICY_DIGEST = "a".repeat(64);
const APP_ID = 42;
const TOKEN = "installation-token-value-123";
const SEEDED_AT = "2026-07-15T12:00:00Z";
const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function evidence(overrides = {}) {
  return createContextSeedEvidence({
    sourceSha: SOURCE_SHA,
    policyADigest: POLICY_DIGEST,
    seededAt: SEEDED_AT,
    ...overrides,
  });
}

function exactCheck({ id = 91, seedEvidence = evidence(), overrides = {} } = {}) {
  const body = createFailureOnlySeedBody(seedEvidence);
  return {
    id,
    name: body.name,
    head_sha: body.head_sha,
    status: body.status,
    conclusion: body.conclusion,
    completed_at: body.completed_at,
    external_id: body.external_id,
    app: { id: APP_ID },
    check_suite: { id: 501 },
    output: { ...body.output },
    ...overrides,
  };
}

function config(approvedContractSha256 = computeRequiredGateContract().sha256) {
  return {
    schemaVersion: 1,
    repository: CONTEXT_SEED_REPOSITORY,
    approvedContractSha256,
    githubAppId: APP_ID,
    githubClientId: "Iv1.1234567890abcdef",
    githubInstallationId: 77,
  };
}

function handoff(
  action,
  policyADigest = computeRequiredGateContract().sha256,
  createdAt = SEEDED_AT,
) {
  return {
    action,
    repository: CONTEXT_SEED_REPOSITORY,
    ref: CONTEXT_SEED_REF,
    sourceSha: SOURCE_SHA,
    currentContext: REQUIRED_GATE_CONTEXT,
    policyADigest,
    nextContext: NEXT_REQUIRED_GATE_CONTEXT,
    createdAt,
  };
}

function mainRef(sha = SOURCE_SHA) {
  return {
    ref: CONTEXT_SEED_REF,
    object: { type: "commit", sha },
  };
}

test("next policy context is the canonical one-epoch v1 to v2 transition", () => {
  assert.equal(REQUIRED_GATE_CONTEXT, "agenc-local-required-v1");
  assert.equal(NEXT_REQUIRED_GATE_CONTEXT, "agenc-local-required-v2");
  assert.match(NEXT_REQUIRED_GATE_CONTEXT, /^agenc-local-required-v[1-9][0-9]*$/u);
});

test("seed body is immutable, main-bound, evidence-complete, and failure-only", () => {
  const seedEvidence = evidence();
  const body = createFailureOnlySeedBody(seedEvidence);
  assert.deepEqual(body, {
    name: "agenc-local-required-v2",
    head_sha: SOURCE_SHA,
    status: "completed",
    conclusion: "failure",
    completed_at: SEEDED_AT,
    external_id: contextSeedExternalId(seedEvidence),
    output: {
      title: CONTEXT_SEED_TITLE,
      summary: JSON.stringify({
        currentContext: "agenc-local-required-v1",
        nextContext: "agenc-local-required-v2",
        policyADigest: POLICY_DIGEST,
        purpose: CONTEXT_SEED_PURPOSE,
        ref: CONTEXT_SEED_REF,
        repository: CONTEXT_SEED_REPOSITORY,
        schemaVersion: 1,
        seededAt: SEEDED_AT,
        sourceSha: SOURCE_SHA,
      }),
    },
  });
  assert.ok(body.external_id.length <= 255);
  for (const expected of [
    CONTEXT_SEED_PURPOSE,
    CONTEXT_SEED_REPOSITORY,
    "main",
    SOURCE_SHA,
    REQUIRED_GATE_CONTEXT,
    POLICY_DIGEST,
    NEXT_REQUIRED_GATE_CONTEXT,
    SEEDED_AT,
  ]) {
    assert.ok(body.external_id.includes(expected));
  }
  assert.equal("context" in body, false);
  assert.equal("success" in body, false);
});

test("exact seed verifier rejects every identity and outcome mutation", () => {
  const valid = exactCheck();
  assert.equal(
    assertExactFailureSeedCheck(valid, {
      appId: APP_ID,
      sourceSha: SOURCE_SHA,
      policyADigest: POLICY_DIGEST,
    }).check.id,
    91,
  );
  for (const mutate of [
    (value) => { value.name = REQUIRED_GATE_CONTEXT; },
    (value) => { value.head_sha = MOVED_SHA; },
    (value) => { value.app.id = APP_ID + 1; },
    (value) => { value.status = "in_progress"; },
    (value) => { value.conclusion = "success"; },
    (value) => { value.completed_at = "2026-07-15T12:00:01Z"; },
    (value) => { value.external_id += "-tampered"; },
    (value) => { value.output.title = "looks close"; },
    (value) => {
      const summary = JSON.parse(value.output.summary);
      summary.purpose = "ordinary-gate";
      value.output.summary = JSON.stringify(summary);
    },
    (value) => { value.output.summary = `{ "seededAt": "${SEEDED_AT}" }`; },
  ]) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.throws(
      () => assertExactFailureSeedCheck(changed, {
        appId: APP_ID,
        sourceSha: SOURCE_SHA,
        policyADigest: POLICY_DIGEST,
      }),
      /exact failure-only|canonical JSON|exact reviewed evidence/u,
    );
  }
});

test("strict inventory paginates beyond 1000 suites and inspects each suite", async () => {
  const suites = Array.from({ length: 1_001 }, (_, index) => ({
    id: index + 1,
    head_sha: SOURCE_SHA,
    app: { id: APP_ID },
  }));
  let suitePageRequests = 0;
  let runRequests = 0;
  const found = exactCheck({ overrides: { check_suite: { id: 1_001 } } });
  const checks = await listNextContextCheckRuns({
    sourceSha: SOURCE_SHA,
    appId: APP_ID,
    installationToken: TOKEN,
    apiBaseUrl: "https://api.example.test",
    fetchImpl: async (url, options) => {
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
      const parsed = new URL(url);
      const suiteMatch = /\/commits\/[0-9a-f]{40}\/check-suites$/u.exec(parsed.pathname);
      if (suiteMatch) {
        suitePageRequests += 1;
        const page = Number(parsed.searchParams.get("page"));
        assert.equal(parsed.searchParams.get("app_id"), String(APP_ID));
        assert.equal(parsed.searchParams.get("check_name"), NEXT_REQUIRED_GATE_CONTEXT);
        assert.equal(parsed.searchParams.get("per_page"), "100");
        return response({
          total_count: suites.length,
          check_suites: suites.slice((page - 1) * 100, page * 100),
        });
      }
      const runMatch = /\/check-suites\/([1-9][0-9]*)\/check-runs$/u.exec(parsed.pathname);
      assert.ok(runMatch, `unexpected URL ${url}`);
      runRequests += 1;
      assert.equal(parsed.searchParams.get("check_name"), NEXT_REQUIRED_GATE_CONTEXT);
      assert.equal(parsed.searchParams.get("filter"), "all");
      const suiteId = Number(runMatch[1]);
      return response({
        total_count: suiteId === 1_001 ? 1 : 0,
        check_runs: suiteId === 1_001 ? [found] : [],
      });
    },
  });
  assert.equal(suitePageRequests, 11);
  assert.equal(runRequests, 1_001);
  assert.deepEqual(checks, [found]);
});

test("strict inventory rejects a pagination total that changes mid-read", async () => {
  await assert.rejects(
    listNextContextCheckRuns({
      sourceSha: SOURCE_SHA,
      appId: APP_ID,
      installationToken: TOKEN,
      apiBaseUrl: "https://api.example.test",
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        const page = Number(parsed.searchParams.get("page"));
        return response({
          total_count: page === 1 ? 101 : 102,
          check_suites: page === 1
            ? Array.from({ length: 100 }, (_, index) => ({
                id: index + 1,
                head_sha: SOURCE_SHA,
                app: { id: APP_ID },
              }))
            : [{ id: 101, head_sha: SOURCE_SHA, app: { id: APP_ID } }],
        });
      },
    }),
    /total changed/u,
  );
});

test("App-scoped inventory rejects a foreign suite even if GitHub ignores its filter", async () => {
  await assert.rejects(
    listNextContextCheckRuns({
      sourceSha: SOURCE_SHA,
      appId: APP_ID,
      installationToken: TOKEN,
      apiBaseUrl: "https://api.example.test",
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get("app_id"), String(APP_ID));
        assert.equal(parsed.searchParams.get("check_name"), NEXT_REQUIRED_GATE_CONTEXT);
        return response({
          total_count: 1,
          check_suites: [{ id: 1, head_sha: SOURCE_SHA, app: { id: APP_ID + 1 } }],
        });
      },
    }),
    /exact requested SHA and App/u,
  );
});

function exactInstallation(overrides = {}) {
  return {
    id: 77,
    app_id: APP_ID,
    client_id: "Iv1.1234567890abcdef",
    target_type: "Organization",
    account: { login: "tetsuo-ai", type: "Organization" },
    repository_selection: "selected",
    suspended_at: null,
    permissions: { checks: "write", metadata: "read", statuses: "write" },
    events: [],
    ...overrides,
  };
}

function exactToken(checks) {
  return {
    token: TOKEN,
    expires_at: "2026-07-15T13:00:00Z",
    permissions: { checks, metadata: "read" },
    repository_selection: "selected",
    repositories: [{ id: 123, name: "agenc-core", full_name: CONTEXT_SEED_REPOSITORY }],
  };
}

test("App preflight binds numeric identity and scopes seed write versus recovery read", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" });
  for (const [action, permission] of [["seed", "write"], ["recover", "read"]]) {
    const requests = [];
    const result = await authenticateContextSeedApp({
      action,
      config: config(),
      privateKeyPem,
      now: new Date(SEEDED_AT),
      apiBaseUrl: "https://api.example.test",
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), method: options.method, body: options.body });
        assert.match(options.headers.Authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/u);
        if (String(url).endsWith("/app/installations/77")) {
          assert.equal(options.method, "GET");
          return response(exactInstallation({
            ...(action === "recover" ? { client_id: undefined } : {}),
          }));
        }
        assert.equal(String(url).endsWith("/app/installations/77/access_tokens"), true);
        assert.equal(options.method, "POST");
        assert.deepEqual(JSON.parse(options.body), {
          permissions: { checks: permission },
          repositories: ["agenc-core"],
        });
        return response(exactToken(permission), 201);
      },
    });
    assert.equal(result.token, TOKEN);
    assert.equal(requests.length, 2);
  }
});

test("wrong App identity fails before token mint or Check Run mutation", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let requests = 0;
  await assert.rejects(
    authenticateContextSeedApp({
      action: "seed",
      config: config(),
      privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }),
      now: new Date(SEEDED_AT),
      apiBaseUrl: "https://api.example.test",
      fetchImpl: async () => {
        requests += 1;
        return response(exactInstallation({ app_id: APP_ID + 1 }));
      },
    }),
    /installation identity/u,
  );
  assert.equal(requests, 1);
});

function createSeedFetch({
  preexisting = [],
  postChecks,
  byIdOverride,
  moveOnMainRead,
  requests,
}) {
  let createdCheck;
  let mainReads = 0;
  let checkPostCount = 0;
  return async (url, options) => {
    const parsed = new URL(url);
    const method = options.method;
    requests.push({ url: String(url), method, body: options.body && JSON.parse(options.body) });
    if (parsed.pathname.endsWith("/git/ref/heads/main")) {
      mainReads += 1;
      return response(mainRef(mainReads === moveOnMainRead ? MOVED_SHA : SOURCE_SHA));
    }
    if (parsed.pathname.endsWith(`/commits/${SOURCE_SHA}/check-suites`)) {
      const selected = createdCheck === undefined ? preexisting : (postChecks ?? [createdCheck]);
      return response({
        total_count: selected.length === 0 ? 0 : 1,
        check_suites: selected.length === 0
          ? []
          : [{ id: 501, head_sha: SOURCE_SHA, app: { id: APP_ID } }],
      });
    }
    if (parsed.pathname.endsWith("/check-suites/501/check-runs")) {
      const selected = createdCheck === undefined ? preexisting : (postChecks ?? [createdCheck]);
      return response({ total_count: selected.length, check_runs: selected });
    }
    if (parsed.pathname.endsWith("/check-runs") && method === "POST") {
      checkPostCount += 1;
      const body = JSON.parse(options.body);
      createdCheck = {
        id: 91,
        ...body,
        head_sha: body.head_sha,
        completed_at: body.completed_at,
        app: { id: APP_ID },
        check_suite: { id: 501 },
        output: { ...body.output },
      };
      return response(createdCheck, 201);
    }
    if (parsed.pathname.endsWith("/check-runs/91")) {
      return response(byIdOverride ?? createdCheck ?? preexisting[0]);
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };
}

test("credentialed seeder rereads main around key use, creates only failure, and proves exact one", async () => {
  const requests = [];
  const ordering = [];
  const contract = computeRequiredGateContract();
  const fetchImpl = createSeedFetch({ requests });
  const result = await runCredentialedContextSeed({
    action: "seed",
    config: config(),
    handoff: handoff("seed", contract.sha256),
    apiBaseUrl: "https://api.example.test",
    fetchImpl: async (...args) => {
      const url = String(args[0]);
      if (url.endsWith("/git/ref/heads/main")) ordering.push("main");
      if (url.endsWith("/check-runs") && args[1].method === "POST") ordering.push("check-post");
      return fetchImpl(...args);
    },
    now: () => new Date(SEEDED_AT),
    readPrivateKey: () => {
      ordering.push("key");
      return "private-key-pem";
    },
    authenticateApp: async (args) => {
      ordering.push("authenticate");
      assert.equal(args.privateKeyPem, "private-key-pem");
      return { token: TOKEN };
    },
  });
  assert.equal(result.action, "seed");
  assert.equal(result.check.id, 91);
  assert.deepEqual(ordering, [
    "main",
    "key",
    "authenticate",
    "main",
    "main",
    "check-post",
    "main",
  ]);
  const mutations = requests.filter(({ method, url }) =>
    method === "POST" && url.endsWith("/check-runs"));
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].body.name, NEXT_REQUIRED_GATE_CONTEXT);
  assert.equal(mutations[0].body.conclusion, "failure");
  assert.equal(requests.some(({ method }) => method === "PATCH"), false);
  assert.equal(
    requests.some(({ url }) => url.endsWith("/check-runs/91")),
    true,
  );
});

test("seed refuses a nonzero precondition without POST or PATCH", async () => {
  const requests = [];
  const contract = computeRequiredGateContract();
  const existing = exactCheck({
    seedEvidence: createContextSeedEvidence({
      sourceSha: SOURCE_SHA,
      policyADigest: contract.sha256,
      seededAt: SEEDED_AT,
    }),
  });
  await assert.rejects(
    runCredentialedContextSeed({
      action: "seed",
      config: config(),
      handoff: handoff("seed", contract.sha256),
      apiBaseUrl: "https://api.example.test",
      fetchImpl: createSeedFetch({ preexisting: [existing], requests }),
      now: () => new Date(SEEDED_AT),
      readPrivateKey: () => "private-key-pem",
      authenticateApp: async () => ({ token: TOKEN }),
    }),
    /exactly zero/u,
  );
  assert.equal(requests.some(({ method }) => method === "POST" || method === "PATCH"), false);
});

test("seed revalidates the five-minute handoff immediately before its sole Check Run POST", async () => {
  const requests = [];
  const contract = computeRequiredGateContract();
  const times = [
    new Date(SEEDED_AT),
    new Date("2026-07-15T12:06:00Z"),
  ];
  await assert.rejects(
    runCredentialedContextSeed({
      action: "seed",
      config: config(),
      handoff: handoff("seed", contract.sha256),
      apiBaseUrl: "https://api.example.test",
      fetchImpl: createSeedFetch({ requests }),
      now: () => times.shift(),
      readPrivateKey: () => "private-key-pem",
      authenticateApp: async () => ({ token: TOKEN }),
    }),
    /handoff is stale/u,
  );
  assert.equal(
    requests.some(({ method, url }) => method === "POST" && url.endsWith("/check-runs")),
    false,
  );
});

test("seed rejects duplicate postcondition and moved main after publication", async () => {
  const contract = computeRequiredGateContract();
  const seedEvidence = createContextSeedEvidence({
    sourceSha: SOURCE_SHA,
    policyADigest: contract.sha256,
    seededAt: SEEDED_AT,
  });
  const duplicate = exactCheck({ id: 92, seedEvidence });
  for (const variant of [
    { postChecks: [exactCheck({ seedEvidence }), duplicate] },
    { moveOnMainRead: 4 },
    { byIdOverride: exactCheck({ id: 92, seedEvidence }) },
  ]) {
    const requests = [];
    await assert.rejects(
      runCredentialedContextSeed({
        action: "seed",
        config: config(),
        handoff: handoff("seed", contract.sha256),
        apiBaseUrl: "https://api.example.test",
        fetchImpl: createSeedFetch({ ...variant, requests }),
        now: () => new Date(SEEDED_AT),
        readPrivateKey: () => "private-key-pem",
        authenticateApp: async () => ({ token: TOKEN }),
      }),
      /postcondition requires exactly one|remote main moved|GET-by-ID returned a different/u,
    );
  }
});

test("recovery verifies one existing exact failure without check mutation", async () => {
  const requests = [];
  const contract = computeRequiredGateContract();
  const existing = exactCheck({
    seedEvidence: createContextSeedEvidence({
      sourceSha: SOURCE_SHA,
      policyADigest: contract.sha256,
      seededAt: SEEDED_AT,
    }),
  });
  const result = await runCredentialedContextSeed({
    action: "recover",
    config: config(),
    handoff: handoff("recover", contract.sha256),
    apiBaseUrl: "https://api.example.test",
    fetchImpl: createSeedFetch({ preexisting: [existing], requests }),
    now: () => new Date("2026-07-15T12:05:00Z"),
    readPrivateKey: () => "private-key-pem",
    authenticateApp: async () => ({ token: TOKEN }),
  });
  assert.equal(result.action, "recover");
  assert.equal(result.check.id, 91);
  assert.equal(
    requests.some(({ method, url }) =>
      (method === "POST" || method === "PATCH") && url.endsWith("/check-runs")),
    false,
  );
  assert.equal(
    requests.filter(({ url }) => url.endsWith("/check-runs/91")).length,
    1,
  );
  assert.equal(
    requests.filter(({ url }) => url.includes(`/commits/${SOURCE_SHA}/check-suites`)).length,
    2,
  );
});

test("recovery rejects a seed outside the conservative source-eligibility window", async () => {
  const requests = [];
  const contract = computeRequiredGateContract();
  const recoveryAt = "2026-07-22T12:00:00Z";
  const existing = exactCheck({
    seedEvidence: createContextSeedEvidence({
      sourceSha: SOURCE_SHA,
      policyADigest: contract.sha256,
      seededAt: SEEDED_AT,
    }),
  });
  await assert.rejects(
    runCredentialedContextSeed({
      action: "recover",
      config: config(),
      handoff: handoff("recover", contract.sha256, recoveryAt),
      apiBaseUrl: "https://api.example.test",
      fetchImpl: createSeedFetch({ preexisting: [existing], requests }),
      now: () => new Date(recoveryAt),
      readPrivateKey: () => "private-key-pem",
      authenticateApp: async () => ({ token: TOKEN }),
    }),
    /six-day eligibility/u,
  );
  assert.equal(
    requests.some(({ method, url }) =>
      (method === "POST" || method === "PATCH") && url.endsWith("/check-runs")),
    false,
  );
});

test("handoff pruning is owner-, type-, name-, mode-, and entry-count bounded", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agenc-context-seed-prune-"));
  chmodSync(root, 0o700);
  const ownership = { expectedUid: process.getuid(), expectedGid: process.getgid() };
  try {
    for (const id of ["a".repeat(32), "b".repeat(32)]) {
      writeFileSync(path.join(root, `${id}.json`), "orphan\n", { mode: 0o600 });
    }
    assert.equal(pruneOrphanedContextSeedHandoffs({ directory: root, ...ownership }), 2);

    writeFileSync(path.join(root, "unexpected.txt"), "blocked\n", { mode: 0o600 });
    assert.throws(
      () => pruneOrphanedContextSeedHandoffs({ directory: root, ...ownership }),
      /unexpected context-seed runtime entry/u,
    );
    rmSync(path.join(root, "unexpected.txt"));

    symlinkSync("missing", path.join(root, `${"c".repeat(32)}.json`));
    assert.throws(
      () => pruneOrphanedContextSeedHandoffs({ directory: root, ...ownership }),
      /unexpected context-seed runtime entry/u,
    );
    rmSync(path.join(root, `${"c".repeat(32)}.json`));

    for (let index = 0; index < 129; index += 1) {
      writeFileSync(
        path.join(root, `${index.toString(16).padStart(32, "0")}.json`),
        "bounded\n",
        { mode: 0o600 },
      );
    }
    assert.throws(
      () => pruneOrphanedContextSeedHandoffs({ directory: root, ...ownership }),
      /128-entry bound/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted path validation rejects writable or symlinked ancestors and final files", () => {
  const anchor = mkdtempSync(path.join(tmpdir(), "agenc-context-seed-path-"));
  const uid = process.getuid();
  const gid = process.getgid();
  const options = { anchorPath: anchor, expectedUid: uid, expectedGid: gid };
  try {
    chmodSync(anchor, 0o700);
    const parent = path.join(anchor, "trusted");
    mkdirSync(parent, { mode: 0o700 });
    const target = path.join(parent, "policy.mjs");
    writeFileSync(target, "trusted\n", { mode: 0o600 });
    assert.doesNotThrow(() => assertImmutablePathChain(target, options));

    chmodSync(parent, 0o770);
    assert.throws(
      () => assertImmutablePathChain(target, options),
      /unsafe owner, mode, symlink, or type/u,
    );
    chmodSync(parent, 0o700);

    const linkedParent = path.join(anchor, "linked");
    symlinkSync(parent, linkedParent, "dir");
    assert.throws(
      () => assertImmutablePathChain(path.join(linkedParent, "policy.mjs"), options),
      /unsafe owner, mode, symlink, or type/u,
    );

    const linkedFile = path.join(parent, "linked.mjs");
    symlinkSync(target, linkedFile);
    assert.throws(
      () => assertImmutablePathChain(linkedFile, options),
      /unsafe owner, mode, symlink, or type/u,
    );
  } finally {
    rmSync(anchor, { recursive: true, force: true });
  }
});

test("unapproved policy drift stops coordinator and credential child before any authority use", async () => {
  const unapproved = config("0".repeat(64));
  assert.throws(
    () => assertApprovedContextSeedPolicy(unapproved),
    /not the root-approved policy A/u,
  );
  const calls = [];
  await assert.rejects(
    dispatchContextSeed({
      action: "seed",
      config: unapproved,
      fetchImpl: async () => {
        calls.push("github");
        return response(mainRef());
      },
      verifyDeployment: () => { calls.push("deployment"); },
      verifyCredentialSource: () => { calls.push("credential-source"); },
      pruneHandoffs: () => { calls.push("handoff-prune"); },
      startCredentialService: () => { calls.push("service"); },
    }),
    /not the root-approved policy A/u,
  );
  assert.deepEqual(calls, []);

  let keyReads = 0;
  await assert.rejects(
    runCredentialedContextSeed({
      action: "seed",
      config: unapproved,
      handoff: handoff("seed"),
      fetchImpl: async () => {
        calls.push("credentialed-github");
        return response(mainRef());
      },
      now: () => new Date(SEEDED_AT),
      readPrivateKey: () => {
        keyReads += 1;
        return "private-key-pem";
      },
      authenticateApp: async () => {
        calls.push("authenticate");
        return { token: TOKEN };
      },
    }),
    /not the root-approved policy A/u,
  );
  assert.equal(keyReads, 0);
  assert.deepEqual(calls, []);
});

test("live deployment parser requires loaded byte-bound units and exact aggregate placement", () => {
  const parent = parseSystemctlShow([
    "LoadState=loaded",
    "FragmentPath=/etc/systemd/system/agenc-local-gate-context-seed@.service",
    "DropInPaths=",
    "NeedDaemonReload=no",
    "Slice=system-agencgate.slice",
    `ControlGroup=${LOCAL_GATE_AGGREGATE_CGROUP}/agenc-local-gate-context-seed@seed.service`,
    "",
  ].join("\n"), [
    "LoadState",
    "FragmentPath",
    "DropInPaths",
    "NeedDaemonReload",
    "Slice",
    "ControlGroup",
  ]);
  const aggregate = parseSystemctlShow([
    "LoadState=loaded",
    "FragmentPath=/etc/systemd/system/system-agencgate.slice",
    "DropInPaths=",
    "NeedDaemonReload=no",
    `ControlGroup=${LOCAL_GATE_AGGREGATE_CGROUP}`,
    "",
  ].join("\n"), [
    "LoadState",
    "FragmentPath",
    "DropInPaths",
    "NeedDaemonReload",
    "ControlGroup",
  ]);
  assert.doesNotThrow(() =>
    assertContextSeedDeploymentRecords({ action: "seed", parent, aggregate }));
  for (const [target, name, value] of [
    [parent, "LoadState", "error"],
    [parent, "FragmentPath", "/tmp/unreviewed.service"],
    [parent, "DropInPaths", "/etc/systemd/system/override.conf"],
    [parent, "NeedDaemonReload", "yes"],
    [parent, "Slice", "system.slice"],
    [parent, "ControlGroup", `${LOCAL_GATE_AGGREGATE_CGROUP}/wrong.service`],
    [aggregate, "LoadState", "not-found"],
    [aggregate, "FragmentPath", "/tmp/unreviewed.slice"],
    [aggregate, "DropInPaths", "/tmp/override.conf"],
    [aggregate, "NeedDaemonReload", "yes"],
    [aggregate, "ControlGroup", "/system.slice"],
  ]) {
    const changedParent = { ...parent };
    const changedAggregate = { ...aggregate };
    (target === parent ? changedParent : changedAggregate)[name] = value;
    assert.throws(
      () => assertContextSeedDeploymentRecords({
        action: "seed",
        parent: changedParent,
        aggregate: changedAggregate,
      }),
      /unexpected/u,
    );
  }
  assert.throws(
    () => parseSystemctlShow("LoadState=loaded\nLoadState=loaded\n", ["LoadState"]),
    /duplicate/u,
  );
});

test("CLI cannot accept a SHA, context, or conclusion and child receives only random handoff ID", () => {
  const id = "b".repeat(32);
  assert.deepEqual(parseContextSeedArguments(["--dispatch", "seed"]), {
    mode: "dispatch",
    action: "seed",
  });
  assert.deepEqual(parseContextSeedArguments(["--dispatch", "recover"]), {
    mode: "dispatch",
    action: "recover",
  });
  assert.deepEqual(parseContextSeedArguments(["--credentialed", id]), {
    mode: "credentialed",
    jobId: id,
  });
  for (const args of [
    ["--dispatch", "seed", SOURCE_SHA],
    ["--context", NEXT_REQUIRED_GATE_CONTEXT],
    ["--conclusion", "success"],
    ["--credentialed", id, "failure"],
  ]) {
    assert.throws(() => parseContextSeedArguments(args), /usage/u);
  }

  const command = buildContextSeedCredentialCommand({ action: "seed", jobId: id });
  assert.equal(command.unitName, `agenc-local-gate-context-seed-credential-${id}.service`);
  assert.ok(command.args.includes(`--slice=${LOCAL_GATE_AGGREGATE_SLICE}`));
  assert.ok(command.args.includes(
    "--property=LoadCredentialEncrypted=github-app-private-key:/etc/credstore.encrypted/agenc-local-gatekeeper-app-key",
  ));
  assert.ok(command.args.includes(
    "--property=BindsTo=agenc-local-gate-context-seed@seed.service",
  ));
  assert.ok(command.args.includes("--working-directory=/"));
  for (const hidden of [
    "/var/lib/agenc-local-gatekeeper",
    "/var/log/agenc-local-gatekeeper",
    "/var/lib/agenc-gate-worker",
    "/run/agenc-local-gatekeeper",
  ]) {
    assert.ok(command.args.includes(`--property=InaccessiblePaths=-${hidden}`));
  }
  assert.ok(command.args.includes(
    "--property=ReadOnlyPaths=/run/agenc-local-gate-context-seed",
  ));
  assert.deepEqual(command.args.slice(-4), [
    "/opt/agenc-local-gatekeeper/node/bin/node",
    "/opt/agenc-local-gatekeeper/repo/scripts/local-gate-context-seed.mjs",
    "--credentialed",
    id,
  ]);
  assert.equal(command.args.some((value) => /success|conclusion|--context/u.test(value)), false);
});

test("static parent is aggregate-capped and credential-free", () => {
  const unit = readFileSync(
    path.join(repositoryRoot, "packaging/systemd/agenc-local-gate-context-seed@.service"),
    "utf8",
  );
  assert.match(unit, /^Slice=system-agencgate\.slice$/mu);
  assert.match(unit, /local-gate-context-seed\.mjs --dispatch %i/u);
  assert.match(unit, /^User=root$/mu);
  assert.match(unit, /^CapabilityBoundingSet=$/mu);
  assert.doesNotMatch(unit, /LoadCredential/u);
  assert.doesNotMatch(unit, /^StateDirectory=/mu);
  assert.doesNotMatch(unit, /--context|--conclusion|success/u);
  for (const policyPath of [
    "packaging/systemd/agenc-local-gate-context-seed@.service",
    "packaging/systemd/agenc-local-gate-publish@.service",
    "packaging/systemd/agenc-local-gate-docker.service",
    "scripts/local-gate-context-seed.mjs",
    "scripts/local-gate-context-seed.test.mjs",
  ]) {
    assert.ok(REQUIRED_GATE_POLICY_PATHS.includes(policyPath), `${policyPath} is not hashed`);
  }
});
