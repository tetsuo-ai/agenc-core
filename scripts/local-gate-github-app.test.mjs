import assert from "node:assert/strict";
import {
  createVerify,
  generateKeyPairSync,
} from "node:crypto";
import test from "node:test";

import {
  createGateReceipt,
  createGithubAppJwt,
  formatReceiptSummary,
  gateExternalId,
  mintInstallationToken,
  parseReceiptSummary,
  publishGateCheck,
  readMainRef,
  readPullRequest,
  verifyGateCheckRuns,
} from "./local-gate-github-app.mjs";
import {
  REQUIRED_GATE_CONTEXT,
  REQUIRED_GATE_SCHEMA_VERSION,
} from "./required-gate-contract.mjs";

const SOURCE_SHA = "1".repeat(40);
const BASE_SHA = "2".repeat(40);
const CONTRACT_SHA = "a".repeat(64);
const LOG_SHA = "b".repeat(64);

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pullRequestPayload(overrides = {}) {
  return {
    state: "open",
    draft: false,
    head: {
      sha: SOURCE_SHA,
      ref: "feature/local-gate",
      repo: { full_name: "tetsuo-ai/agenc-core" },
    },
    base: { sha: BASE_SHA, ref: "main" },
    ...overrides,
  };
}

function receipt(result = "success") {
  return createGateReceipt({
    repository: "tetsuo-ai/agenc-core",
    pullRequest: {
      number: 1505,
      headSha: SOURCE_SHA,
      baseSha: BASE_SHA,
      headRef: "feature/local-gate",
      baseRef: "main",
    },
    contract: {
      schemaVersion: REQUIRED_GATE_SCHEMA_VERSION,
      context: REQUIRED_GATE_CONTEXT,
      sha256: CONTRACT_SHA,
    },
    executorId: "agenc-gate-01",
    startedAt: "2026-07-15T12:00:00.000Z",
    completedAt: "2026-07-15T12:01:30.000Z",
    result,
    logSha256: LOG_SHA,
    ...(result === "failure" ? { failureCode: "GATE_FAILED" } : {}),
  });
}

function mainReceipt() {
  return createGateReceipt({
    repository: "tetsuo-ai/agenc-core",
    subject: { kind: "main", ref: "refs/heads/main", sourceSha: SOURCE_SHA },
    contract: {
      schemaVersion: REQUIRED_GATE_SCHEMA_VERSION,
      context: REQUIRED_GATE_CONTEXT,
      sha256: CONTRACT_SHA,
    },
    executorId: "agenc-gate-01",
    startedAt: "2026-07-15T12:00:00Z",
    completedAt: "2026-07-15T12:01:30Z",
    result: "success",
    logSha256: LOG_SHA,
  });
}

function successfulCheck(overrides = {}, gateReceipt = receipt()) {
  return {
    id: 91,
    name: REQUIRED_GATE_CONTEXT,
    head_sha: SOURCE_SHA,
    status: "completed",
    conclusion: "success",
    completed_at: gateReceipt.completedAt,
    external_id: gateExternalId(gateReceipt),
    app: { id: 42 },
    check_suite: { id: 501 },
    output: {
      title: "Local required gates passed",
      summary: formatReceiptSummary(gateReceipt),
    },
    ...overrides,
  };
}

function createCheckApiFetch({ initialChecks = [], requests = [] } = {}) {
  let checks = [...initialChecks];
  return async (url, options) => {
    const parsed = new URL(url);
    const request = {
      url: String(url),
      method: options.method,
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    };
    requests.push(request);
    if (parsed.pathname.endsWith(`/commits/${SOURCE_SHA}/check-suites`)) {
      return response({
        total_count: checks.length === 0 ? 0 : 1,
        check_suites: checks.length === 0
          ? []
          : [{ id: 501, head_sha: SOURCE_SHA, app: { id: 42 } }],
      });
    }
    if (parsed.pathname.endsWith("/check-suites/501/check-runs")) {
      return response({ total_count: checks.length, check_runs: checks });
    }
    if (request.method === "POST" && parsed.pathname.endsWith("/check-runs")) {
      const persisted = {
        ...request.body,
        id: 91,
        head_sha: request.body.head_sha,
        app: { id: 42 },
        check_suite: { id: 501 },
        output: { ...request.body.output },
      };
      checks = [persisted];
      return response(persisted, 201);
    }
    if (request.method === "PATCH" && parsed.pathname.endsWith("/check-runs/91")) {
      const persisted = {
        ...request.body,
        id: 91,
        head_sha: SOURCE_SHA,
        app: { id: 42 },
        check_suite: { id: 501 },
        output: { ...request.body.output },
      };
      checks = [persisted];
      return response(persisted);
    }
    throw new Error(`unexpected request: ${request.method} ${url}`);
  };
}

test("GitHub App JWT is RS256-signed with the bounded GitHub claims", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = createGithubAppJwt({
    clientId: "Iv1.1234567890abcdef",
    privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }),
    now: Date.parse("2026-07-15T12:00:00.000Z"),
  });
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.iss, "Iv1.1234567890abcdef");
  assert.equal(claims.exp - claims.iat, 9 * 60);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, "base64url")), true);
  assert.throws(
    () => createGithubAppJwt({
      appId: 42,
      privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }),
      now: Date.parse("2026-07-15T12:00:00.000Z"),
    }),
    /client ID/u,
  );
});

test("installation token request is repository- and permission-scoped", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let observed;
  const token = await mintInstallationToken({
    clientId: "Iv1.1234567890abcdef",
    appId: 42,
    installationId: 77,
    privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }),
    now: Date.parse("2026-07-15T12:00:00Z"),
    apiBaseUrl: "https://api.example.test",
    fetchImpl: async (url, options) => {
      if (options.method === "GET") {
        return response({
          id: 77,
          app_id: 42,
          repository_selection: "selected",
          target_type: "Organization",
          account: { login: "tetsuo-ai", type: "Organization" },
          suspended_at: null,
          events: [],
          permissions: { checks: "write", statuses: "write", metadata: "read" },
        });
      }
      observed = { url: String(url), options, body: JSON.parse(options.body) };
      return response({
        token: "installation-token-value-123",
        expires_at: "2026-07-15T13:00:00Z",
        permissions: { checks: "write", metadata: "read" },
        repository_selection: "selected",
        repositories: [{ id: 123, name: "agenc-core", full_name: "tetsuo-ai/agenc-core" }],
      }, 201);
    },
  });
  assert.equal(token.token, "installation-token-value-123");
  assert.equal(observed.url, "https://api.example.test/app/installations/77/access_tokens");
  assert.equal(observed.options.method, "POST");
  assert.match(observed.options.headers.Authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/u);
  assert.deepEqual(observed.body, {
    permissions: { checks: "write" },
    repositories: ["agenc-core"],
  });
  assert.deepEqual(token.permissions, { checks: "write", metadata: "read" });
  assert.equal(token.repositoryId, 123);
});

test("installation token readback rejects extra permissions or repository scope", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const base = {
    token: "installation-token-value-123",
    expires_at: "2026-07-15T13:00:00Z",
    permissions: { checks: "write" },
    repository_selection: "selected",
    repositories: [{ id: 123, name: "agenc-core", full_name: "tetsuo-ai/agenc-core" }],
  };
  for (const mutate of [
    (value) => { value.permissions.statuses = "write"; },
    (value) => { value.repositories[0].full_name = "attacker/agenc-core"; },
    (value) => { value.repositories.push({ id: 124, name: "other", full_name: "tetsuo-ai/other" }); },
    (value) => { value.repository_selection = "all"; },
    (value) => { value.expires_at = "2026-07-15T11:59:00Z"; },
  ]) {
    const payload = structuredClone(base);
    mutate(payload);
    await assert.rejects(
      mintInstallationToken({
        clientId: "Iv1.1234567890abcdef",
        appId: 42,
        installationId: 77,
        privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }),
        now: Date.parse("2026-07-15T12:00:00Z"),
        apiBaseUrl: "https://api.example.test",
        fetchImpl: async (_url, options) => options.method === "GET"
          ? response({
              id: 77,
              app_id: 42,
              repository_selection: "selected",
              target_type: "Organization",
              account: { login: "tetsuo-ai", type: "Organization" },
              suspended_at: null,
              events: [],
              permissions: { checks: "write", statuses: "write", metadata: "read" },
            })
          : response(payload, 201),
      }),
      /installation token response|permissions exceed/u,
    );
  }
});

test("installation identity is verified before a token can be minted", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  for (const drift of [
    { app_id: 99 },
    { client_id: "Iv1.wrong-client-id" },
  ]) {
    let posts = 0;
    await assert.rejects(
      mintInstallationToken({
        clientId: "Iv1.1234567890abcdef",
        appId: 42,
        installationId: 77,
        privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }),
        now: Date.parse("2026-07-15T12:00:00Z"),
        apiBaseUrl: "https://api.example.test",
        fetchImpl: async (_url, options) => {
          if (options.method === "POST") posts += 1;
          return response({
            id: 77,
            app_id: 42,
            repository_selection: "selected",
            target_type: "Organization",
            account: { login: "tetsuo-ai", type: "Organization" },
            suspended_at: null,
            events: [],
            permissions: { checks: "write", statuses: "write", metadata: "read" },
            ...drift,
          });
        },
      }),
      /installation identity/u,
    );
    assert.equal(posts, 0);
  }
});

test("pull request identity is remote, open, same-repository, and main-bound", async () => {
  const valid = await readPullRequest({
    repository: "tetsuo-ai/agenc-core",
    pullRequestNumber: 1505,
    apiBaseUrl: "https://api.example.test",
    fetchImpl: async () => response(pullRequestPayload()),
  });
  assert.deepEqual(valid, {
    kind: "pull_request",
    number: 1505,
    headSha: SOURCE_SHA,
    baseSha: BASE_SHA,
    headRef: "feature/local-gate",
    baseRef: "main",
  });
  await assert.rejects(
    readPullRequest({
      repository: "tetsuo-ai/agenc-core",
      pullRequestNumber: 1505,
      apiBaseUrl: "https://api.example.test",
      fetchImpl: async () => response(pullRequestPayload({
        head: { ...pullRequestPayload().head, repo: { full_name: "attacker/fork" } },
      })),
    }),
    /must use a branch in/u,
  );
});

test("main identity is bound to the canonical remote main ref", async () => {
  const valid = await readMainRef({
    repository: "tetsuo-ai/agenc-core",
    apiBaseUrl: "https://api.example.test",
    fetchImpl: async () => response({
      ref: "refs/heads/main",
      object: { type: "commit", sha: SOURCE_SHA },
    }),
  });
  assert.deepEqual(valid, {
    kind: "main",
    ref: "refs/heads/main",
    sourceSha: SOURCE_SHA,
  });
  await assert.rejects(
    readMainRef({
      repository: "tetsuo-ai/agenc-core",
      apiBaseUrl: "https://api.example.test",
      fetchImpl: async () => response({
        ref: "refs/heads/release",
        object: { type: "commit", sha: SOURCE_SHA },
      }),
    }),
    /invalid main ref/u,
  );
});

test("main receipt refuses any non-canonical ref", () => {
  assert.throws(
    () => createGateReceipt({
      repository: "tetsuo-ai/agenc-core",
      subject: { kind: "main", ref: "refs/heads/release", sourceSha: SOURCE_SHA },
      contract: {
        schemaVersion: REQUIRED_GATE_SCHEMA_VERSION,
        context: REQUIRED_GATE_CONTEXT,
        sha256: CONTRACT_SHA,
      },
      executorId: "agenc-gate-01",
      startedAt: "2026-07-15T12:00:00.000Z",
      completedAt: "2026-07-15T12:01:30.000Z",
      result: "success",
      logSha256: LOG_SHA,
    }),
    /must be refs\/heads\/main/u,
  );
});

test("receipt summary is canonical, exact-SHA-bound, and mutation-sensitive", () => {
  const gateReceipt = receipt();
  assert.equal(gateReceipt.startedAt, "2026-07-15T12:00:00Z");
  assert.equal(gateReceipt.completedAt, "2026-07-15T12:01:30Z");
  const summary = formatReceiptSummary(gateReceipt);
  assert.deepEqual(parseReceiptSummary(summary), gateReceipt);
  assert.equal(
    gateExternalId(gateReceipt),
    `${REQUIRED_GATE_CONTEXT}:${SOURCE_SHA}:${CONTRACT_SHA}`,
  );
  assert.throws(
    () => parseReceiptSummary(summary.replace(`\"durationMs\":90000`, `\"durationMs\":090000`)),
    /canonical JSON|Unexpected number/u,
  );
});

test("publisher creates one completed App-owned check for the exact receipt", async () => {
  const requests = [];
  const gateReceipt = receipt();
  const check = await publishGateCheck({
    repository: "tetsuo-ai/agenc-core",
    appId: 42,
    installationToken: "installation-token-value-123",
    receipt: gateReceipt,
    apiBaseUrl: "https://api.example.test",
    fetchImpl: createCheckApiFetch({ requests }),
  });
  assert.equal(check.id, 91);
  assert.equal(requests.length, 4);
  assert.match(requests[0].url, new RegExp(`/commits/${SOURCE_SHA}/check-suites\\?`));
  assert.match(requests[0].url, /[?&]app_id=42(?:&|$)/u);
  assert.equal(requests[1].method, "POST");
  assert.equal(requests[1].body.name, REQUIRED_GATE_CONTEXT);
  assert.equal(requests[1].body.head_sha, SOURCE_SHA);
  assert.equal(requests[1].body.status, "completed");
  assert.equal(requests[1].body.conclusion, "success");
  assert.equal(requests[1].body.completed_at, "2026-07-15T12:01:30Z");
  assert.equal(requests[1].body.external_id, gateExternalId(gateReceipt));
  assert.equal(requests[2].method, "GET");
  assert.equal(requests[3].method, "GET");
});

test("publisher scopes duplicate detection to the configured App", async () => {
  const urls = [];
  const requests = [];
  const fetchImpl = createCheckApiFetch({ requests });
  const result = await publishGateCheck({
    repository: "tetsuo-ai/agenc-core",
    appId: 42,
    installationToken: "installation-token-value-123",
    receipt: receipt(),
    apiBaseUrl: "https://api.example.test",
    fetchImpl: async (url, options) => {
      urls.push(String(url));
      return fetchImpl(url, options);
    },
  });
  assert.equal(result.app.id, 42);
  assert.ok(urls.filter((url) => url.includes("/check-suites?")).every((url) =>
    url.includes("app_id=42")
  ));
});

test("publisher refuses duplicate checks from its own App", async () => {
  const first = successfulCheck();
  await assert.rejects(publishGateCheck({
    repository: "tetsuo-ai/agenc-core",
    appId: 42,
    installationToken: "installation-token-value-123",
    receipt: receipt(),
    apiBaseUrl: "https://api.example.test",
    fetchImpl: createCheckApiFetch({
      initialChecks: [first, { ...first, id: 92 }],
    }),
  }), /duplicate/u);
});

test("release verifier rejects stale, duplicate, wrong-App, and non-success checks", () => {
  const expected = {
    repository: "tetsuo-ai/agenc-core",
    sha: SOURCE_SHA,
    appId: 42,
    contractSha256: CONTRACT_SHA,
  };
  assert.equal(
    verifyGateCheckRuns({
      checkRuns: [
        successfulCheck({ id: 90, app: { id: 7 } }),
        successfulCheck(),
      ],
      ...expected,
    }).receipt.result,
    "success",
  );
  const exactMainReceipt = mainReceipt();
  assert.equal(
    verifyGateCheckRuns({
      checkRuns: [successfulCheck({}, exactMainReceipt)],
      expectedSubjectKind: "main",
      ...expected,
    }).receipt.subject.ref,
    "refs/heads/main",
  );
  assert.throws(
    () => verifyGateCheckRuns({ checkRuns: [successfulCheck({ head_sha: "3".repeat(40) })], ...expected }),
    /wrong source SHA/u,
  );
  assert.throws(
    () => verifyGateCheckRuns({ checkRuns: [successfulCheck({ app: { id: 7 } })], ...expected }),
    /wrong GitHub App/u,
  );
  assert.throws(
    () => verifyGateCheckRuns({ checkRuns: [successfulCheck({ conclusion: "neutral" })], ...expected }),
    /not a completed success/u,
  );
  assert.throws(
    () => verifyGateCheckRuns({ checkRuns: [successfulCheck(), successfulCheck({ id: 92 })], ...expected }),
    /exactly one/u,
  );
  assert.throws(
    () => verifyGateCheckRuns({
      checkRuns: [successfulCheck()],
      expectedSubjectKind: "main",
      ...expected,
    }),
    /not a main attestation/u,
  );
});

test("verifier rejects malformed canonical receipts and persisted field drift", () => {
  const expected = {
    repository: "tetsuo-ai/agenc-core",
    sha: SOURCE_SHA,
    appId: 42,
    contractSha256: CONTRACT_SHA,
    expectedSubjectKind: "main",
  };
  const valid = mainReceipt();
  for (const mutate of [
    (value) => { value.subject.ref = "refs/heads/release"; },
    (value) => { value.completedAt = "2026-07-15T12:01:31Z"; },
    (value) => { value.durationMs += 1; },
    (value) => { value.executorId = "invalid executor"; },
    (value) => { value.logSha256 = "not-a-digest"; },
    (value) => { value.unreviewed = true; },
  ]) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.throws(
      () => verifyGateCheckRuns({
        checkRuns: [successfulCheck({}, changed)],
        ...expected,
      }),
      /main gate subject|canonical schema|executor ID|log digest/u,
    );
  }
  assert.throws(
    () => verifyGateCheckRuns({
      checkRuns: [successfulCheck({ completed_at: "2026-07-15T12:01:31Z" }, valid)],
      ...expected,
    }),
    /exact local-gate check identity/u,
  );
  assert.throws(
    () => verifyGateCheckRuns({
      checkRuns: [successfulCheck({
        output: {
          title: "Looks close",
          summary: formatReceiptSummary(valid),
        },
      }, valid)],
      ...expected,
    }),
    /exact local-gate check identity/u,
  );
});
