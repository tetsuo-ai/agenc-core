import { createPrivateKey, createSign } from "node:crypto";

import {
  canonicalJson,
  REQUIRED_GATE_CONTEXT,
  REQUIRED_GATE_SCHEMA_VERSION,
} from "./required-gate-contract.mjs";

const API_VERSION = "2026-03-10";
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const CHECK_PAGE_SIZE = 100;
const MAX_NAMED_CHECK_SUITES = 2_048;
const MAX_NAMED_CHECK_RUNS_PER_SUITE = 2_048;
const RECEIPT_PREFIX = "<!-- agenc-local-gate-receipt\n";
const RECEIPT_SUFFIX = "\n-->";
const SUCCESS_TITLE = "Local required gates passed";
const FAILURE_TITLE = "Local required gates failed";

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function assertPositiveInteger(value, label) {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function assertGithubClientId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{10,128}$/u.test(value)) {
    throw new TypeError("GitHub App client ID must be a safe 10-128 character identifier");
  }
  return value;
}

function assertSha(value, label = "source SHA") {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new TypeError(`${label} must be one lowercase 40-character Git SHA`);
  }
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be one lowercase SHA-256 digest`);
  }
  return value;
}

function assertRepository(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new TypeError("repository must be owner/name");
  }
  return value;
}

function assertCheckName(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("check name must be a safe 1-255 character string");
  }
  return value;
}

function assertBranchName(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} must be a safe nonempty branch name`);
  }
  return value;
}

function githubTimestamp(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
  date.setUTCMilliseconds(0);
  return date.toISOString().replace(/\.000Z$/u, "Z");
}

function encodeRepository(repository) {
  const [owner, name] = assertRepository(repository).split("/");
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function sanitizeApiMessage(value) {
  return String(value ?? "unknown GitHub API error")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, 500);
}

async function responseText(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_API_RESPONSE_BYTES) {
    throw new Error(`GitHub API response exceeded ${MAX_API_RESPONSE_BYTES} bytes`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_API_RESPONSE_BYTES) {
    throw new Error(`GitHub API response exceeded ${MAX_API_RESPONSE_BYTES} bytes`);
  }
  return text;
}

export async function githubJsonRequest({
  apiBaseUrl = "https://api.github.com",
  path,
  method = "GET",
  authorization,
  body,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  const base = new URL(apiBaseUrl);
  if (base.username || base.password || base.search || base.hash) {
    throw new TypeError("GitHub API base URL must not contain credentials, query, or fragment");
  }
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new TypeError("GitHub API path must be absolute");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new TypeError("GitHub API timeout must be between 1 and 120 seconds");
  }
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agenc-local-gatekeeper/1",
    "X-GitHub-Api-Version": API_VERSION,
  };
  if (authorization !== undefined) {
    if (typeof authorization !== "string" || authorization.length < 10 || /[\r\n]/u.test(authorization)) {
      throw new TypeError("invalid GitHub authorization value");
    }
    headers.Authorization = authorization;
  }
  let encodedBody;
  if (body !== undefined) {
    encodedBody = canonicalJson(body);
    headers["Content-Type"] = "application/json";
  }
  const response = await fetchImpl(new URL(path, base), {
    method,
    headers,
    body: encodedBody,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await responseText(response);
  let parsed = null;
  if (text !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`GitHub API returned non-JSON status ${response.status}`);
    }
  }
  if (!response.ok) {
    throw new Error(
      `GitHub API ${method} ${path} failed with ${response.status}: ` +
      sanitizeApiMessage(parsed?.message ?? text),
    );
  }
  return parsed;
}

export function createGithubAppJwt({ clientId, privateKeyPem, now = Date.now() }) {
  const issuer = assertGithubClientId(clientId);
  if (typeof privateKeyPem !== "string" || privateKeyPem.length < 64) {
    throw new TypeError("GitHub App private key PEM is required");
  }
  if (!Number.isFinite(now) || now <= 0) throw new TypeError("JWT clock must be positive");
  const issuedAt = Math.floor(now / 1000) - 60;
  const payload = {
    iat: issuedAt,
    exp: issuedAt + 9 * 60,
    iss: issuer,
  };
  const protectedHeader = base64Url(canonicalJson({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64Url(canonicalJson(payload));
  const unsigned = `${protectedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(createPrivateKey(privateKeyPem)).toString("base64url");
  return `${unsigned}.${signature}`;
}

export async function mintInstallationToken({
  clientId,
  appId,
  installationId,
  privateKeyPem,
  apiBaseUrl,
  fetchImpl,
  now,
}) {
  const clock = now ?? Date.now();
  const jwt = createGithubAppJwt({ clientId, privateKeyPem, now: clock });
  const id = assertPositiveInteger(installationId, "GitHub App installation ID");
  const numericAppId = assertPositiveInteger(appId, "GitHub App ID");
  const installed = await githubJsonRequest({
    apiBaseUrl,
    path: `/app/installations/${id}`,
    authorization: `Bearer ${jwt}`,
    fetchImpl,
  });
  const installedPermissionKeys = Object.keys(installed?.permissions ?? {}).sort();
  if (
    installed?.id !== id ||
    installed?.app_id !== numericAppId ||
    (installed?.client_id !== undefined && installed.client_id !== clientId) ||
    installed?.repository_selection !== "selected" ||
    installed?.target_type !== "Organization" ||
    installed?.account?.login !== "tetsuo-ai" ||
    installed?.account?.type !== "Organization" ||
    installed?.suspended_at !== null ||
    JSON.stringify(installed?.events) !== "[]" ||
    installed?.permissions?.checks !== "write" ||
    installed?.permissions?.statuses !== "write" ||
    (installed.permissions.metadata !== undefined && installed.permissions.metadata !== "read") ||
    ![
      ["checks", "statuses"],
      ["checks", "metadata", "statuses"],
    ].some((keys) => JSON.stringify(keys) === JSON.stringify(installedPermissionKeys))
  ) {
    throw new Error("GitHub App installation identity or installed permissions are not exact");
  }
  const response = await githubJsonRequest({
    apiBaseUrl,
    path: `/app/installations/${id}/access_tokens`,
    method: "POST",
    authorization: `Bearer ${jwt}`,
    body: {
      repositories: ["agenc-core"],
      permissions: {
        checks: "write",
      },
    },
    fetchImpl,
  });
  const expiresAtMs = Date.parse(response?.expires_at);
  if (
    response === null ||
    typeof response.token !== "string" ||
    response.token.length < 20 ||
    typeof response.expires_at !== "string" ||
    response.repository_selection !== "selected" ||
    !Array.isArray(response.repositories) ||
    response.repositories.length !== 1 ||
    response.repositories[0]?.name !== "agenc-core" ||
    response.repositories[0]?.full_name !== "tetsuo-ai/agenc-core" ||
    !Number.isSafeInteger(response.repositories[0]?.id) ||
    response.repositories[0].id <= 0 ||
    response.permissions === null ||
    typeof response.permissions !== "object" ||
    Array.isArray(response.permissions) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= clock + 60_000 ||
    expiresAtMs > clock + 2 * 60 * 60_000
  ) {
    throw new Error("GitHub returned an invalid installation token response");
  }
  const permissionKeys = Object.keys(response.permissions).sort();
  const allowedPermissionShapes = [
    ["checks"],
    ["checks", "metadata"],
  ];
  if (
    response.permissions.checks !== "write" ||
    (response.permissions.metadata !== undefined && response.permissions.metadata !== "read") ||
    !allowedPermissionShapes.some((keys) =>
      keys.length === permissionKeys.length && keys.every((key, index) => key === permissionKeys[index])
    )
  ) {
    throw new Error("GitHub installation token permissions exceed checks:write");
  }
  return Object.freeze({
    token: response.token,
    expiresAt: response.expires_at,
    repositoryId: response.repositories[0].id,
    permissions: Object.freeze({ ...response.permissions }),
  });
}

export async function readPullRequest({
  repository,
  pullRequestNumber,
  apiBaseUrl,
  fetchImpl,
}) {
  const number = assertPositiveInteger(pullRequestNumber, "pull request number");
  const response = await githubJsonRequest({
    apiBaseUrl,
    path: `/repos/${encodeRepository(repository)}/pulls/${number}`,
    fetchImpl,
  });
  const headSha = assertSha(response?.head?.sha, "pull request head SHA");
  const baseSha = assertSha(response?.base?.sha, "pull request base SHA");
  if (response.state !== "open" || response.draft === true) {
    throw new Error(`pull request #${number} must be open and non-draft`);
  }
  if (response.base?.ref !== "main") {
    throw new Error(`pull request #${number} must target main`);
  }
  if (response.head?.repo?.full_name !== repository) {
    throw new Error(`pull request #${number} must use a branch in ${repository}`);
  }
  return Object.freeze({
    kind: "pull_request",
    number,
    headSha,
    baseSha,
    headRef: response.head.ref,
    baseRef: response.base.ref,
  });
}

export async function readMainRef({
  repository,
  apiBaseUrl,
  fetchImpl,
}) {
  const response = await githubJsonRequest({
    apiBaseUrl,
    path: `/repos/${encodeRepository(repository)}/git/ref/heads/main`,
    fetchImpl,
  });
  if (response?.ref !== "refs/heads/main" || response?.object?.type !== "commit") {
    throw new Error("GitHub returned an invalid main ref response");
  }
  return Object.freeze({
    kind: "main",
    sourceSha: assertSha(response.object.sha, "main source SHA"),
    ref: response.ref,
  });
}

export function createGateReceipt({
  repository,
  pullRequest,
  subject,
  contract,
  executorId,
  startedAt,
  completedAt,
  result,
  logSha256,
  failureCode,
}) {
  assertRepository(repository);
  const identity = subject ?? pullRequest;
  if (!identity || typeof identity !== "object") {
    throw new TypeError("gate subject identity is required");
  }
  let normalizedSubject;
  if (identity.kind === "main") {
    if (identity.ref !== "refs/heads/main") {
      throw new Error("main gate subject must be refs/heads/main");
    }
    normalizedSubject = Object.freeze({
      kind: "main",
      ref: identity.ref,
      sourceSha: assertSha(identity.sourceSha),
    });
  } else {
    const number = assertPositiveInteger(identity.number, "pull request number");
    const headRef = assertBranchName(identity.headRef, "pull request head ref");
    const baseRef = assertBranchName(identity.baseRef, "pull request base ref");
    if (baseRef !== "main") {
      throw new Error("pull request gate subject must target main");
    }
    normalizedSubject = Object.freeze({
      kind: "pull_request",
      number,
      headRef,
      baseRef,
      sourceSha: assertSha(identity.headSha ?? identity.sourceSha),
      baseSha: assertSha(identity.baseSha, "base SHA"),
    });
  }
  if (!contract || typeof contract !== "object") throw new TypeError("gate contract is required");
  const contractSha256 = assertDigest(contract.sha256, "gate contract digest");
  if (contract.context !== REQUIRED_GATE_CONTEXT) throw new Error("gate contract context mismatch");
  if (contract.schemaVersion !== REQUIRED_GATE_SCHEMA_VERSION) {
    throw new Error("gate contract schema mismatch");
  }
  if (typeof executorId !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/u.test(executorId)) {
    throw new TypeError("executor ID must be a safe 1-64 character identifier");
  }
  const startedInstant = new Date(startedAt);
  const completedInstant = new Date(completedAt);
  if (
    !Number.isFinite(startedInstant.getTime()) ||
    !Number.isFinite(completedInstant.getTime())
  ) {
    throw new TypeError("gate receipt timestamps must be valid");
  }
  if (completedInstant.getTime() < startedInstant.getTime()) {
    throw new Error("gate receipt completion precedes its start");
  }
  const normalizedStartedAt = githubTimestamp(startedInstant, "gate receipt start");
  const normalizedCompletedAt = githubTimestamp(completedInstant, "gate receipt completion");
  const started = new Date(normalizedStartedAt);
  const completed = new Date(normalizedCompletedAt);
  if (result !== "success" && result !== "failure") {
    throw new TypeError("gate receipt result must be success or failure");
  }
  assertDigest(logSha256, "gate log digest");
  if (
    failureCode !== undefined &&
    (typeof failureCode !== "string" || !/^[A-Z0-9_]{1,64}$/u.test(failureCode))
  ) {
    throw new TypeError("failure code must be a safe uppercase identifier");
  }
  if (result === "success" && failureCode !== undefined) {
    throw new Error("successful gate receipt cannot contain a failure code");
  }
  return Object.freeze({
    schemaVersion: REQUIRED_GATE_SCHEMA_VERSION,
    context: REQUIRED_GATE_CONTEXT,
    repository,
    subject: normalizedSubject,
    contractSha256,
    executorId,
    startedAt: normalizedStartedAt,
    completedAt: normalizedCompletedAt,
    durationMs: completed.getTime() - started.getTime(),
    result,
    logSha256,
    ...(failureCode === undefined ? {} : { failureCode }),
  });
}

export function normalizeGateReceipt(receipt) {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new TypeError("gate receipt must be an object");
  }
  const normalized = createGateReceipt({
    repository: receipt.repository,
    subject: receipt.subject,
    contract: {
      schemaVersion: receipt.schemaVersion,
      context: receipt.context,
      sha256: receipt.contractSha256,
    },
    executorId: receipt.executorId,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    result: receipt.result,
    logSha256: receipt.logSha256,
    ...(Object.hasOwn(receipt, "failureCode") ? { failureCode: receipt.failureCode } : {}),
  });
  if (canonicalJson(normalized) !== canonicalJson(receipt)) {
    throw new Error("local-gate receipt is not the exact canonical schema");
  }
  return normalized;
}

export function formatReceiptSummary(receipt) {
  const canonical = canonicalJson(receipt);
  return [
    `Local required gates ${receipt.result}.`,
    "",
    `Source: \`${receipt.subject.sourceSha}\``,
    `Contract: \`${receipt.contractSha256}\``,
    `Executor: \`${receipt.executorId}\``,
    `Log SHA-256: \`${receipt.logSha256}\``,
    "",
    `${RECEIPT_PREFIX}${canonical}${RECEIPT_SUFFIX}`,
  ].join("\n");
}

export function parseReceiptSummary(summary) {
  if (typeof summary !== "string") throw new TypeError("check summary must be a string");
  const start = summary.indexOf(RECEIPT_PREFIX);
  const end = summary.indexOf(RECEIPT_SUFFIX, start + RECEIPT_PREFIX.length);
  if (start < 0 || end < 0 || summary.indexOf(RECEIPT_PREFIX, start + 1) !== -1) {
    throw new Error("check summary contains no unique local-gate receipt");
  }
  const encoded = summary.slice(start + RECEIPT_PREFIX.length, end);
  const receipt = JSON.parse(encoded);
  if (canonicalJson(receipt) !== encoded) {
    throw new Error("local-gate receipt is not canonical JSON");
  }
  return receipt;
}

export function gateExternalId(receipt) {
  return `${REQUIRED_GATE_CONTEXT}:${receipt.subject.sourceSha}:${receipt.contractSha256}`;
}

async function collectPaginatedGithubRecords({ firstPage, nextPage, field, label }) {
  const expectedTotal = firstPage.total_count;
  const records = [...firstPage[field]];
  let page = 1;
  while (records.length < expectedTotal) {
    page += 1;
    const response = await nextPage(page);
    if (response.total_count !== expectedTotal) {
      throw new Error(`GitHub ${label} total changed during pagination`);
    }
    if (response[field].length === 0) {
      throw new Error(`GitHub ${label} pagination ended before total_count`);
    }
    records.push(...response[field]);
    if (records.length > expectedTotal) {
      throw new Error(`GitHub ${label} pagination exceeded total_count`);
    }
  }
  if (records.length !== expectedTotal) {
    throw new Error(`GitHub ${label} pagination is incomplete`);
  }
  return records;
}

export async function listAppCheckRuns({
  repository,
  sha,
  name,
  appId,
  token,
  apiBaseUrl,
  fetchImpl,
}) {
  const encodedRepository = encodeRepository(repository);
  const sourceSha = assertSha(sha);
  const checkName = assertCheckName(name);
  const numericAppId = assertPositiveInteger(appId, "GitHub App ID");
  if (typeof token !== "string" || token.length < 10) {
    throw new TypeError("GitHub checks read token is required");
  }
  const requestSuitePage = async (page) => {
    const response = await githubJsonRequest({
      apiBaseUrl,
      path:
        `/repos/${encodedRepository}/commits/${sourceSha}/check-suites` +
        `?app_id=${numericAppId}` +
        `&check_name=${encodeURIComponent(checkName)}` +
        `&per_page=${CHECK_PAGE_SIZE}&page=${page}`,
      authorization: `Bearer ${token}`,
      fetchImpl,
    });
    if (
      !Number.isSafeInteger(response?.total_count) ||
      response.total_count < 0 ||
      response.total_count > MAX_NAMED_CHECK_SUITES ||
      !Array.isArray(response?.check_suites) ||
      response.check_suites.length > CHECK_PAGE_SIZE
    ) {
      throw new Error("GitHub returned an invalid or unbounded check-suites page");
    }
    return response;
  };
  const firstSuitePage = await requestSuitePage(1);
  const suites = await collectPaginatedGithubRecords({
    firstPage: firstSuitePage,
    nextPage: requestSuitePage,
    field: "check_suites",
    label: "check suites",
  });
  const suiteIds = new Set();
  const checkIds = new Set();
  const checks = [];
  for (const suite of suites) {
    const suiteId = assertPositiveInteger(suite?.id, "GitHub check suite ID");
    if (suiteIds.has(suiteId)) throw new Error("GitHub returned a duplicate check suite ID");
    suiteIds.add(suiteId);
    if (suite.head_sha !== sourceSha || suite.app?.id !== numericAppId) {
      throw new Error("GitHub check suite is not bound to the exact requested SHA and App");
    }
    const requestRunPage = async (page) => {
      const response = await githubJsonRequest({
        apiBaseUrl,
        path:
          `/repos/${encodedRepository}/check-suites/${suiteId}/check-runs` +
          `?check_name=${encodeURIComponent(checkName)}` +
          `&filter=all&per_page=${CHECK_PAGE_SIZE}&page=${page}`,
        authorization: `Bearer ${token}`,
        fetchImpl,
      });
      if (
        !Number.isSafeInteger(response?.total_count) ||
        response.total_count < 0 ||
        response.total_count > MAX_NAMED_CHECK_RUNS_PER_SUITE ||
        !Array.isArray(response?.check_runs) ||
        response.check_runs.length > CHECK_PAGE_SIZE
      ) {
        throw new Error("GitHub returned an invalid or unbounded suite check-runs page");
      }
      return response;
    };
    const firstRunPage = await requestRunPage(1);
    const runs = await collectPaginatedGithubRecords({
      firstPage: firstRunPage,
      nextPage: requestRunPage,
      field: "check_runs",
      label: `check runs for suite ${suiteId}`,
    });
    for (const check of runs) {
      const checkId = assertPositiveInteger(check?.id, "GitHub check run ID");
      if (checkIds.has(checkId)) throw new Error("GitHub returned a duplicate check run ID");
      checkIds.add(checkId);
      if (
        check.name !== checkName ||
        check.head_sha !== sourceSha ||
        check.app?.id !== numericAppId ||
        check.check_suite?.id !== suiteId
      ) {
        throw new Error("GitHub ignored the exact App, SHA, suite, or check-name filter");
      }
      checks.push(check);
    }
  }
  return Object.freeze(checks);
}

async function listNamedChecks(options) {
  return listAppCheckRuns(options);
}

function assertPersistedGateCheck(check, { appId, sourceSha, conclusion, receipt }) {
  assertPositiveInteger(check?.id, "GitHub check run ID");
  const title = conclusion === "success" ? SUCCESS_TITLE : FAILURE_TITLE;
  if (
    check?.name !== REQUIRED_GATE_CONTEXT ||
    check?.head_sha !== sourceSha ||
    check?.app?.id !== appId ||
    check?.status !== "completed" ||
    check?.conclusion !== conclusion ||
    check?.completed_at !== receipt.completedAt ||
    check?.external_id !== gateExternalId(receipt) ||
    check?.output?.title !== title
  ) {
    throw new Error("GitHub did not persist the exact local-gate check identity");
  }
  const persistedReceipt = normalizeGateReceipt(parseReceiptSummary(check?.output?.summary));
  if (canonicalJson(persistedReceipt) !== canonicalJson(receipt)) {
    throw new Error("GitHub did not persist the exact local-gate receipt");
  }
  return check;
}

export async function publishGateCheck({
  repository,
  appId,
  installationToken,
  receipt,
  apiBaseUrl,
  fetchImpl,
}) {
  const numericAppId = assertPositiveInteger(appId, "GitHub App ID");
  if (typeof installationToken !== "string" || installationToken.length < 20) {
    throw new TypeError("GitHub App installation token is required");
  }
  const normalizedReceipt = normalizeGateReceipt(receipt);
  const sourceSha = normalizedReceipt.subject.sourceSha;
  const conclusion = normalizedReceipt.result === "success" ? "success" : "failure";
  const existing = await listNamedChecks({
    repository,
    sha: sourceSha,
    name: REQUIRED_GATE_CONTEXT,
    appId: numericAppId,
    token: installationToken,
    apiBaseUrl,
    fetchImpl,
  });
  if (existing.length > 1) {
    throw new Error(`refusing duplicate ${REQUIRED_GATE_CONTEXT} checks from the gate App`);
  }
  const body = {
    name: REQUIRED_GATE_CONTEXT,
    status: "completed",
    conclusion,
    completed_at: normalizedReceipt.completedAt,
    external_id: gateExternalId(normalizedReceipt),
    output: {
      title: conclusion === "success" ? SUCCESS_TITLE : FAILURE_TITLE,
      summary: formatReceiptSummary(normalizedReceipt),
    },
  };
  const check = existing[0];
  const requestBody = check ? body : { ...body, head_sha: sourceSha };
  const response = await githubJsonRequest({
    apiBaseUrl,
    path: check
      ? `/repos/${encodeRepository(repository)}/check-runs/${assertPositiveInteger(check.id, "check run ID")}`
      : `/repos/${encodeRepository(repository)}/check-runs`,
    method: check ? "PATCH" : "POST",
    authorization: `Bearer ${installationToken}`,
    body: requestBody,
    fetchImpl,
  });
  assertPersistedGateCheck(response, {
    appId: numericAppId,
    sourceSha,
    conclusion,
    receipt: normalizedReceipt,
  });
  const readback = await listNamedChecks({
    repository,
    sha: sourceSha,
    name: REQUIRED_GATE_CONTEXT,
    appId: numericAppId,
    token: installationToken,
    apiBaseUrl,
    fetchImpl,
  });
  if (readback.length !== 1 || readback[0]?.id !== response.id) {
    throw new Error("GitHub check readback is missing or duplicated");
  }
  return assertPersistedGateCheck(readback[0], {
    appId: numericAppId,
    sourceSha,
    conclusion,
    receipt: normalizedReceipt,
  });
}

export function verifyGateCheckRuns({
  checkRuns,
  repository,
  sha,
  appId,
  contractSha256,
  expectedSubjectKind,
}) {
  assertRepository(repository);
  const sourceSha = assertSha(sha);
  const numericAppId = assertPositiveInteger(appId, "GitHub App ID");
  const digest = assertDigest(contractSha256, "gate contract digest");
  if (!Array.isArray(checkRuns)) throw new TypeError("check runs must be an array");
  const allNamed = checkRuns.filter((check) => check?.name === REQUIRED_GATE_CONTEXT);
  const named = allNamed.filter(
    (check) => check?.name === REQUIRED_GATE_CONTEXT && check?.app?.id === numericAppId,
  );
  if (named.length === 0 && allNamed.length > 0) {
    throw new Error("local-gate check came from the wrong GitHub App");
  }
  if (named.length !== 1) {
    throw new Error(`expected exactly one ${REQUIRED_GATE_CONTEXT} check, observed ${named.length}`);
  }
  const check = named[0];
  if (check.head_sha !== sourceSha) throw new Error("local-gate check is bound to the wrong source SHA");
  if (check.status !== "completed" || check.conclusion !== "success") {
    throw new Error("local-gate check is not a completed success");
  }
  const receipt = normalizeGateReceipt(parseReceiptSummary(check?.output?.summary));
  if (
    expectedSubjectKind !== undefined &&
    expectedSubjectKind !== "pull_request" &&
    expectedSubjectKind !== "main"
  ) {
    throw new TypeError("expected gate subject kind must be pull_request or main");
  }
  if (
    receipt.repository !== repository ||
    receipt.result !== "success" ||
    receipt.subject?.sourceSha !== sourceSha ||
    receipt.contractSha256 !== digest ||
    check.external_id !== gateExternalId(receipt)
  ) {
    throw new Error("local-gate receipt does not match the required source and contract");
  }
  if (expectedSubjectKind !== undefined && receipt.subject?.kind !== expectedSubjectKind) {
    throw new Error(`local-gate receipt is not a ${expectedSubjectKind} attestation`);
  }
  assertPersistedGateCheck(check, {
    appId: numericAppId,
    sourceSha,
    conclusion: "success",
    receipt,
  });
  return Object.freeze({ check, receipt });
}

export async function readAndVerifyGateCheck({
  repository,
  sha,
  appId,
  contractSha256,
  token,
  apiBaseUrl,
  fetchImpl,
  expectedSubjectKind,
}) {
  if (typeof token !== "string" || token.length < 10) {
    throw new TypeError("GitHub read token is required");
  }
  const checkRuns = await listNamedChecks({
    repository,
    sha,
    name: REQUIRED_GATE_CONTEXT,
    appId,
    token,
    apiBaseUrl,
    fetchImpl,
  });
  return verifyGateCheckRuns({
    checkRuns,
    repository,
    sha,
    appId,
    contractSha256,
    expectedSubjectKind,
  });
}
