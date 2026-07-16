#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  createGithubAppJwt,
  githubJsonRequest,
  listAppCheckRuns,
  readMainRef,
} from "./local-gate-github-app.mjs";
import {
  canonicalJson,
  computeRequiredGateContract,
  NEXT_REQUIRED_GATE_CONTEXT,
  REQUIRED_GATE_CONTEXT,
  REQUIRED_GATE_POLICY_PATHS,
} from "./required-gate-contract.mjs";
import {
  assertCgroupResourceProfile,
  LOCAL_GATE_AGGREGATE_CGROUP,
  LOCAL_GATE_AGGREGATE_LIMITS,
  LOCAL_GATE_AGGREGATE_SLICE,
} from "./systemd-worker-sandbox.mjs";

export const CONTEXT_SEED_REPOSITORY = "tetsuo-ai/agenc-core";
export const CONTEXT_SEED_REF = "refs/heads/main";
export const CONTEXT_SEED_PURPOSE = "policy-context-source-eligibility";
export const CONTEXT_SEED_TITLE = "Policy-context source seed (intentional failure)";
export const CONTEXT_SEED_SCHEMA_VERSION = 1;

const API_BASE_URL = "https://api.github.com";
const CONFIG_PATH = "/etc/agenc-local-gatekeeper/config.json";
const APP_KEY_CIPHERTEXT =
  "/etc/credstore.encrypted/agenc-local-gatekeeper-app-key";
const APP_KEY_CREDENTIAL = "github-app-private-key";
const HANDOFF_DIRECTORY = "/run/agenc-local-gate-context-seed";
const TRUSTED_REPOSITORY_ROOT = "/opt/agenc-local-gatekeeper/repo";
const TRUSTED_NODE_PATH = "/opt/agenc-local-gatekeeper/node/bin/node";
const TRUSTED_SCRIPT_PATH =
  "/opt/agenc-local-gatekeeper/repo/scripts/local-gate-context-seed.mjs";
const INSTALLED_PARENT_UNIT =
  "/etc/systemd/system/agenc-local-gate-context-seed@.service";
const INSTALLED_AGGREGATE_SLICE =
  "/etc/systemd/system/system-agencgate.slice";
const TRUSTED_PARENT_UNIT = path.join(
  TRUSTED_REPOSITORY_ROOT,
  "packaging/systemd/agenc-local-gate-context-seed@.service",
);
const TRUSTED_AGGREGATE_SLICE = path.join(
  TRUSTED_REPOSITORY_ROOT,
  "packaging/systemd/system-agencgate.slice",
);
const MAX_HANDOFF_BYTES = 4 * 1024;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const MAX_HANDOFF_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const MAX_RECOVERY_SEED_AGE_MS = 6 * 24 * 60 * 60_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const JOB_ID_PATTERN = /^[0-9a-f]{32}$/u;
const SEEDED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

function assertPositiveInteger(value, label) {
  const parsed = typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function assertSha(value, label = "main SHA") {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new TypeError(`${label} must be one lowercase 40-character Git SHA`);
  }
  return value;
}

function assertDigest(value, label = "policy A digest") {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} must be one lowercase SHA-256 digest`);
  }
  return value;
}

function assertJobId(value) {
  if (typeof value !== "string" || !JOB_ID_PATTERN.test(value)) {
    throw new TypeError("context-seed handoff ID must be 32 lowercase hex characters");
  }
  return value;
}

function assertAction(value) {
  if (value !== "seed" && value !== "recover") {
    throw new TypeError("context-seed action must be seed or recover");
  }
  return value;
}

function exactUtcSecond(value, label) {
  if (typeof value !== "string" || !SEEDED_AT_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical UTC timestamp at second precision`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().replace(".000Z", "Z") !== value) {
    throw new TypeError(`${label} must be a real canonical UTC timestamp`);
  }
  return value;
}

function utcSecond(now) {
  const date = now instanceof Date ? new Date(now) : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new TypeError("context-seed clock is invalid");
  date.setUTCMilliseconds(0);
  return date.toISOString().replace(".000Z", "Z");
}

function assertFreshHandoffClock(handoff, now) {
  const createdAt = exactUtcSecond(
    handoff?.createdAt,
    "context-seed handoff timestamp",
  );
  const currentMs = new Date(now).getTime();
  const ageMs = currentMs - Date.parse(createdAt);
  if (!Number.isFinite(ageMs) || ageMs < -MAX_FUTURE_SKEW_MS || ageMs > MAX_HANDOFF_AGE_MS) {
    throw new Error("context-seed handoff is stale or from the future");
  }
  return createdAt;
}

function assertRecoverySeedEligibility(evidence, handoff, now) {
  assertFreshHandoffClock(handoff, now);
  const currentMs = new Date(now).getTime();
  const seedAgeMs = currentMs - Date.parse(evidence.seededAt);
  if (
    !Number.isFinite(seedAgeMs) ||
    seedAgeMs < -MAX_FUTURE_SKEW_MS ||
    seedAgeMs > MAX_RECOVERY_SEED_AGE_MS
  ) {
    throw new Error("existing context seed is outside the conservative six-day eligibility window");
  }
}

function encodeRepository() {
  return CONTEXT_SEED_REPOSITORY.split("/").map(encodeURIComponent).join("/");
}

function normalizedConfig(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("local-gate configuration must be an object");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("local-gate configuration schema must be 1");
  }
  if (value.repository !== CONTEXT_SEED_REPOSITORY) {
    throw new Error(`context seeder is hard-bound to ${CONTEXT_SEED_REPOSITORY}`);
  }
  if (
    typeof value.githubClientId !== "string" ||
    !/^[A-Za-z0-9._-]{10,128}$/u.test(value.githubClientId)
  ) {
    throw new TypeError("GitHub App client ID is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    repository: CONTEXT_SEED_REPOSITORY,
    approvedContractSha256: assertDigest(
      value.approvedContractSha256,
      "approved gate contract digest",
    ),
    githubAppId: assertPositiveInteger(value.githubAppId, "GitHub App ID"),
    githubClientId: value.githubClientId,
    githubInstallationId: assertPositiveInteger(
      value.githubInstallationId,
      "GitHub App installation ID",
    ),
  });
}

function assertRootOwnedRegularFile(
  filePath,
  label,
  { exactMode, maxBytes, expectedUid = 0, expectedGid = 0 } = {},
) {
  const metadata = lstatSync(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.uid !== expectedUid ||
    metadata.gid !== expectedGid ||
    (exactMode !== undefined && (metadata.mode & 0o777) !== exactMode) ||
    (maxBytes !== undefined && (metadata.size < 1 || metadata.size > maxBytes))
  ) {
    throw new Error(`${label} is not one bounded root-owned regular file`);
  }
  return metadata;
}

export function assertImmutablePathChain(
  filePath,
  {
    anchorPath = "/",
    expectedUid = 0,
    expectedGid = 0,
    finalType = "file",
  } = {},
) {
  if (
    typeof filePath !== "string" ||
    !path.isAbsolute(filePath) ||
    path.resolve(filePath) !== filePath ||
    typeof anchorPath !== "string" ||
    !path.isAbsolute(anchorPath) ||
    path.resolve(anchorPath) !== anchorPath ||
    (finalType !== "file" && finalType !== "directory")
  ) {
    throw new TypeError("immutable path-chain request is invalid");
  }
  const relative = path.relative(anchorPath, filePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("immutable path target escapes its reviewed anchor");
  }
  const segments = relative === "" ? [] : relative.split(path.sep);
  let current = anchorPath;
  const chain = [anchorPath];
  for (const segment of segments) {
    current = path.join(current, segment);
    chain.push(current);
  }
  for (const [index, candidate] of chain.entries()) {
    const metadata = lstatSync(candidate);
    const isFinal = index === chain.length - 1;
    if (
      metadata.isSymbolicLink() ||
      metadata.uid !== expectedUid ||
      metadata.gid !== expectedGid ||
      (metadata.mode & 0o022) !== 0 ||
      (!isFinal && !metadata.isDirectory()) ||
      (isFinal && finalType === "file" && !metadata.isFile()) ||
      (isFinal && finalType === "directory" && !metadata.isDirectory())
    ) {
      throw new Error(`unsafe owner, mode, symlink, or type in path chain: ${candidate}`);
    }
  }
}

function assertTrustedPolicyFile(filePath, label) {
  assertImmutablePathChain(filePath);
  const metadata = assertRootOwnedRegularFile(filePath, label, { maxBytes: 1024 * 1024 });
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error(`${label} is writable by a non-root identity`);
  }
}

function assertInstalledFileMatches({ trustedPath, installedPath, label }) {
  assertTrustedPolicyFile(trustedPath, `trusted ${label}`);
  assertImmutablePathChain(installedPath);
  assertRootOwnedRegularFile(installedPath, `installed ${label}`, {
    exactMode: 0o644,
    maxBytes: 1024 * 1024,
  });
  const trusted = readFileSync(trustedPath);
  const installed = readFileSync(installedPath);
  if (!trusted.equals(installed)) {
    throw new Error(`installed ${label} is not byte-exact with the approved policy`);
  }
}

export function parseSystemctlShow(output, expectedProperties) {
  if (
    typeof output !== "string" ||
    Buffer.byteLength(output, "utf8") > 64 * 1024 ||
    !Array.isArray(expectedProperties) ||
    expectedProperties.length === 0
  ) {
    throw new TypeError("systemctl show response contract is invalid");
  }
  const expected = new Set(expectedProperties);
  if (
    expected.size !== expectedProperties.length ||
    expectedProperties.some((name) => !/^[A-Z][A-Za-z0-9]*$/u.test(name))
  ) {
    throw new TypeError("systemctl show property inventory is invalid");
  }
  const records = {};
  for (const line of output.replace(/\n$/u, "").split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("systemctl show returned a malformed record");
    const name = line.slice(0, separator);
    if (!expected.has(name) || Object.hasOwn(records, name)) {
      throw new Error(`systemctl show returned unexpected or duplicate ${name}`);
    }
    records[name] = line.slice(separator + 1);
  }
  if (Object.keys(records).length !== expected.size) {
    throw new Error("systemctl show omitted a required property");
  }
  return Object.freeze(records);
}

function inspectSystemdUnit(unitName, properties) {
  if (typeof unitName !== "string" || !/^[A-Za-z0-9@_.-]+$/u.test(unitName)) {
    throw new TypeError("systemd unit name is invalid");
  }
  const result = spawnSync(
    "/usr/bin/systemctl",
    ["show", unitName, ...properties.map((name) => `--property=${name}`)],
    {
      encoding: "utf8",
      env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `could not inspect ${unitName}: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return parseSystemctlShow(result.stdout, properties);
}

export function assertContextSeedDeploymentRecords({ action, parent, aggregate }) {
  const selectedAction = assertAction(action);
  const parentUnit = `agenc-local-gate-context-seed@${selectedAction}.service`;
  const expectedParent = {
    LoadState: "loaded",
    FragmentPath: INSTALLED_PARENT_UNIT,
    DropInPaths: "",
    NeedDaemonReload: "no",
    Slice: LOCAL_GATE_AGGREGATE_SLICE,
    ControlGroup: `${LOCAL_GATE_AGGREGATE_CGROUP}/${parentUnit}`,
  };
  const expectedAggregate = {
    LoadState: "loaded",
    FragmentPath: INSTALLED_AGGREGATE_SLICE,
    DropInPaths: "",
    NeedDaemonReload: "no",
    ControlGroup: LOCAL_GATE_AGGREGATE_CGROUP,
  };
  for (const [name, value] of Object.entries(expectedParent)) {
    if (parent?.[name] !== value) {
      throw new Error(`live context-seed parent has unexpected ${name}`);
    }
  }
  if (Object.keys(parent ?? {}).length !== Object.keys(expectedParent).length) {
    throw new Error("live context-seed parent property inventory is not exact");
  }
  for (const [name, value] of Object.entries(expectedAggregate)) {
    if (aggregate?.[name] !== value) {
      throw new Error(`live aggregate slice has unexpected ${name}`);
    }
  }
  if (Object.keys(aggregate ?? {}).length !== Object.keys(expectedAggregate).length) {
    throw new Error("live aggregate slice property inventory is not exact");
  }
}

function readAggregateCgroupRecords() {
  const cgroupRoot = path.join("/sys/fs/cgroup", LOCAL_GATE_AGGREGATE_CGROUP);
  const names = [
    "cpu.max",
    "memory.high",
    "memory.max",
    "memory.swap.max",
    "memory.zswap.max",
    "pids.max",
    "cgroup.subtree_control",
  ];
  return Object.fromEntries(names.map((name) => {
    const target = path.join(cgroupRoot, name);
    const metadata = lstatSync(target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) {
      throw new Error(`aggregate cgroup control is unsafe: ${name}`);
    }
    return [name, readFileSync(target, "utf8").trim()];
  }));
}

function assertInstalledContextSeedDeployment(action) {
  assertInstalledFileMatches({
    trustedPath: TRUSTED_PARENT_UNIT,
    installedPath: INSTALLED_PARENT_UNIT,
    label: "context-seed parent unit",
  });
  assertInstalledFileMatches({
    trustedPath: TRUSTED_AGGREGATE_SLICE,
    installedPath: INSTALLED_AGGREGATE_SLICE,
    label: "aggregate slice",
  });
  const parentProperties = [
    "LoadState",
    "FragmentPath",
    "DropInPaths",
    "NeedDaemonReload",
    "Slice",
    "ControlGroup",
  ];
  const aggregateProperties = [
    "LoadState",
    "FragmentPath",
    "DropInPaths",
    "NeedDaemonReload",
    "ControlGroup",
  ];
  const parent = inspectSystemdUnit(
    `agenc-local-gate-context-seed@${assertAction(action)}.service`,
    parentProperties,
  );
  const aggregate = inspectSystemdUnit(LOCAL_GATE_AGGREGATE_SLICE, aggregateProperties);
  assertContextSeedDeploymentRecords({ action, parent, aggregate });
  assertCgroupResourceProfile(readAggregateCgroupRecords(), LOCAL_GATE_AGGREGATE_LIMITS);
}

export function assertApprovedContextSeedPolicy(config, contract = computeRequiredGateContract()) {
  const normalized = normalizedConfig(config);
  if (
    contract?.context !== REQUIRED_GATE_CONTEXT ||
    contract?.sha256 !== normalized.approvedContractSha256
  ) {
    throw new Error("installed context-seed policy is not the root-approved policy A");
  }
  return contract;
}

function loadInstalledConfig() {
  assertImmutablePathChain(CONFIG_PATH);
  assertRootOwnedRegularFile(CONFIG_PATH, "local-gate configuration", {
    exactMode: 0o600,
    maxBytes: 64 * 1024,
  });
  const encoded = readFileSync(CONFIG_PATH, "utf8");
  return normalizedConfig(JSON.parse(encoded));
}

function readSystemdCredential() {
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (
    typeof directory !== "string" ||
    !path.isAbsolute(directory) ||
    directory.includes("\0")
  ) {
    throw new Error("systemd credential directory is unavailable");
  }
  const credentialPath = path.join(directory, APP_KEY_CREDENTIAL);
  assertImmutablePathChain(credentialPath);
  const metadata = lstatSync(credentialPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.uid !== 0 ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size < 64 ||
    metadata.size > MAX_CREDENTIAL_BYTES
  ) {
    throw new Error("GitHub App systemd credential metadata is unsafe");
  }
  return readFileSync(credentialPath, "utf8");
}

export function createContextSeedEvidence({ sourceSha, policyADigest, seededAt }) {
  const evidence = Object.freeze({
    schemaVersion: CONTEXT_SEED_SCHEMA_VERSION,
    purpose: CONTEXT_SEED_PURPOSE,
    repository: CONTEXT_SEED_REPOSITORY,
    ref: CONTEXT_SEED_REF,
    sourceSha: assertSha(sourceSha),
    currentContext: REQUIRED_GATE_CONTEXT,
    policyADigest: assertDigest(policyADigest),
    nextContext: NEXT_REQUIRED_GATE_CONTEXT,
    seededAt: exactUtcSecond(seededAt, "context-seed timestamp"),
  });
  return evidence;
}

export function contextSeedExternalId(evidence) {
  const normalized = createContextSeedEvidence(evidence);
  const externalId = [
    CONTEXT_SEED_PURPOSE,
    CONTEXT_SEED_SCHEMA_VERSION,
    CONTEXT_SEED_REPOSITORY,
    "main",
    normalized.sourceSha,
    REQUIRED_GATE_CONTEXT,
    normalized.policyADigest,
    NEXT_REQUIRED_GATE_CONTEXT,
    normalized.seededAt,
  ].join(":");
  if (externalId.length > 255) {
    throw new Error("context-seed external ID exceeds GitHub's 255-character bound");
  }
  return externalId;
}

export function createFailureOnlySeedBody(evidence) {
  const normalized = createContextSeedEvidence(evidence);
  return Object.freeze({
    name: NEXT_REQUIRED_GATE_CONTEXT,
    head_sha: normalized.sourceSha,
    status: "completed",
    conclusion: "failure",
    completed_at: normalized.seededAt,
    external_id: contextSeedExternalId(normalized),
    output: Object.freeze({
      title: CONTEXT_SEED_TITLE,
      summary: canonicalJson(normalized),
    }),
  });
}

function parseEvidenceSummary(value, { sourceSha, policyADigest }) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 16 * 1024) {
    throw new Error("context-seed summary is missing or oversized");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("context-seed summary is not JSON");
  }
  if (canonicalJson(parsed) !== value) {
    throw new Error("context-seed summary is not canonical JSON");
  }
  const expected = createContextSeedEvidence({
    sourceSha,
    policyADigest,
    seededAt: parsed?.seededAt,
  });
  if (canonicalJson(parsed) !== canonicalJson(expected)) {
    throw new Error("context-seed summary is not the exact reviewed evidence shape");
  }
  return expected;
}

export function assertExactFailureSeedCheck(check, { appId, sourceSha, policyADigest }) {
  const numericAppId = assertPositiveInteger(appId, "GitHub App ID");
  const sha = assertSha(sourceSha);
  const digest = assertDigest(policyADigest);
  const evidence = parseEvidenceSummary(check?.output?.summary, {
    sourceSha: sha,
    policyADigest: digest,
  });
  if (
    !Number.isSafeInteger(check?.id) ||
    check.id <= 0 ||
    check.name !== NEXT_REQUIRED_GATE_CONTEXT ||
    check.head_sha !== sha ||
    check.app?.id !== numericAppId ||
    check.status !== "completed" ||
    check.conclusion !== "failure" ||
    check.completed_at !== evidence.seededAt ||
    check.external_id !== contextSeedExternalId(evidence) ||
    check.output?.title !== CONTEXT_SEED_TITLE
  ) {
    throw new Error("GitHub did not persist the exact failure-only context seed");
  }
  return Object.freeze({ check, evidence });
}

export async function listNextContextCheckRuns({
  sourceSha,
  appId,
  installationToken,
  apiBaseUrl = API_BASE_URL,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof installationToken !== "string" || installationToken.length < 20) {
    throw new TypeError("GitHub App installation token is required");
  }
  return listAppCheckRuns({
    repository: CONTEXT_SEED_REPOSITORY,
    sha: assertSha(sourceSha),
    name: NEXT_REQUIRED_GATE_CONTEXT,
    appId: assertPositiveInteger(appId, "GitHub App ID"),
    token: installationToken,
    apiBaseUrl,
    fetchImpl,
  });
}

async function readExactMain({ expectedSha, apiBaseUrl, fetchImpl, label }) {
  const main = await readMainRef({
    repository: CONTEXT_SEED_REPOSITORY,
    apiBaseUrl,
    fetchImpl,
  });
  if (main.ref !== CONTEXT_SEED_REF || main.sourceSha !== expectedSha) {
    throw new Error(`remote main moved ${label}`);
  }
  return main;
}

async function readCheckRunById({ checkId, installationToken, apiBaseUrl, fetchImpl }) {
  return githubJsonRequest({
    apiBaseUrl,
    path: `/repos/${encodeRepository()}/check-runs/${assertPositiveInteger(checkId, "check run ID")}`,
    authorization: `Bearer ${installationToken}`,
    fetchImpl,
  });
}

function assertInstallationIdentity(value, config) {
  const permissionKeys = value?.permissions && typeof value.permissions === "object"
    ? Object.keys(value.permissions).sort()
    : [];
  if (
    value?.id !== config.githubInstallationId ||
    value?.app_id !== config.githubAppId ||
    (value?.client_id !== undefined && value.client_id !== config.githubClientId) ||
    value?.target_type !== "Organization" ||
    value?.account?.login !== "tetsuo-ai" ||
    value?.account?.type !== "Organization" ||
    value?.repository_selection !== "selected" ||
    value?.suspended_at !== null ||
    value?.permissions?.checks !== "write" ||
    value?.permissions?.statuses !== "write" ||
    (value.permissions.metadata !== undefined && value.permissions.metadata !== "read") ||
    ![
      ["checks", "statuses"],
      ["checks", "metadata", "statuses"],
    ].some((expected) => canonicalJson(expected) === canonicalJson(permissionKeys)) ||
    !Array.isArray(value?.events) ||
    value.events.length !== 0
  ) {
    throw new Error("GitHub App installation identity or installed permissions are not exact");
  }
}

function assertScopedTokenResponse(value, { action, config, now }) {
  const checksPermission = action === "seed" ? "write" : "read";
  const expiresAtMs = Date.parse(value?.expires_at);
  const permissionKeys = value?.permissions && typeof value.permissions === "object"
    ? Object.keys(value.permissions).sort()
    : [];
  if (
    typeof value?.token !== "string" ||
    value.token.length < 20 ||
    value.repository_selection !== "selected" ||
    !Array.isArray(value.repositories) ||
    value.repositories.length !== 1 ||
    value.repositories[0]?.name !== "agenc-core" ||
    value.repositories[0]?.full_name !== CONTEXT_SEED_REPOSITORY ||
    !Number.isSafeInteger(value.repositories[0]?.id) ||
    value.repositories[0].id <= 0 ||
    value.permissions?.checks !== checksPermission ||
    (value.permissions.metadata !== undefined && value.permissions.metadata !== "read") ||
    ![
      ["checks"],
      ["checks", "metadata"],
    ].some((expected) => canonicalJson(expected) === canonicalJson(permissionKeys)) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= now.getTime() + 60_000 ||
    expiresAtMs > now.getTime() + 2 * 60 * 60_000 ||
    config.repository !== CONTEXT_SEED_REPOSITORY
  ) {
    throw new Error("GitHub returned an invalid narrowly scoped context-seed token");
  }
  return Object.freeze({ token: value.token, expiresAt: value.expires_at });
}

export async function authenticateContextSeedApp({
  action,
  config,
  privateKeyPem,
  now,
  apiBaseUrl = API_BASE_URL,
  fetchImpl = globalThis.fetch,
}) {
  const selectedAction = assertAction(action);
  const normalized = normalizedConfig(config);
  const clock = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(clock.getTime())) throw new TypeError("App authentication clock is invalid");
  const jwt = createGithubAppJwt({
    clientId: normalized.githubClientId,
    privateKeyPem,
    now: clock.getTime(),
  });
  const installation = await githubJsonRequest({
    apiBaseUrl,
    path: `/app/installations/${normalized.githubInstallationId}`,
    authorization: `Bearer ${jwt}`,
    fetchImpl,
  });
  assertInstallationIdentity(installation, normalized);
  const checksPermission = selectedAction === "seed" ? "write" : "read";
  const tokenResponse = await githubJsonRequest({
    apiBaseUrl,
    path: `/app/installations/${normalized.githubInstallationId}/access_tokens`,
    method: "POST",
    authorization: `Bearer ${jwt}`,
    body: {
      repositories: ["agenc-core"],
      permissions: { checks: checksPermission },
    },
    fetchImpl,
  });
  return assertScopedTokenResponse(tokenResponse, {
    action: selectedAction,
    config: normalized,
    now: clock,
  });
}

export async function runCredentialedContextSeed({
  action,
  config,
  handoff,
  apiBaseUrl = API_BASE_URL,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  readPrivateKey = readSystemdCredential,
  authenticateApp = authenticateContextSeedApp,
}) {
  const selectedAction = assertAction(action);
  const normalized = normalizedConfig(config);
  const expectedSha = assertSha(handoff?.sourceSha);
  const policyADigest = assertDigest(handoff?.policyADigest);
  const operationTime = now();
  assertFreshHandoffClock(handoff, operationTime);
  if (
    handoff?.action !== selectedAction ||
    handoff?.repository !== CONTEXT_SEED_REPOSITORY ||
    handoff?.ref !== CONTEXT_SEED_REF ||
    handoff?.currentContext !== REQUIRED_GATE_CONTEXT ||
    handoff?.nextContext !== NEXT_REQUIRED_GATE_CONTEXT
  ) {
    throw new Error("credentialed context-seed action or fixed policy identity changed");
  }
  const installedContract = assertApprovedContextSeedPolicy(normalized);
  if (
    installedContract.context !== REQUIRED_GATE_CONTEXT ||
    installedContract.sha256 !== policyADigest
  ) {
    throw new Error("context-seed handoff does not match installed policy A");
  }

  await readExactMain({
    expectedSha,
    apiBaseUrl,
    fetchImpl,
    label: "before the App key became available",
  });
  const privateKeyPem = readPrivateKey();
  const publicationTime = operationTime;
  const installation = await authenticateApp({
    action: selectedAction,
    config: normalized,
    privateKeyPem,
    now: publicationTime,
    apiBaseUrl,
    fetchImpl,
  });
  await readExactMain({
    expectedSha,
    apiBaseUrl,
    fetchImpl,
    label: "after minting the installation token",
  });

  const existing = await listNextContextCheckRuns({
    sourceSha: expectedSha,
    appId: normalized.githubAppId,
    installationToken: installation.token,
    apiBaseUrl,
    fetchImpl,
  });
  if (selectedAction === "recover") {
    if (existing.length !== 1) {
      throw new Error(
        `recovery requires exactly one ${NEXT_REQUIRED_GATE_CONTEXT} check; observed ${existing.length}`,
      );
    }
    const verified = assertExactFailureSeedCheck(existing[0], {
      appId: normalized.githubAppId,
      sourceSha: expectedSha,
      policyADigest,
    });
    assertRecoverySeedEligibility(verified.evidence, handoff, publicationTime);
    const byId = await readCheckRunById({
      checkId: verified.check.id,
      installationToken: installation.token,
      apiBaseUrl,
      fetchImpl,
    });
    if (byId?.id !== verified.check.id) {
      throw new Error("recovery GET-by-ID returned a different check run");
    }
    assertExactFailureSeedCheck(byId, {
      appId: normalized.githubAppId,
      sourceSha: expectedSha,
      policyADigest,
    });
    const finalInventory = await listNextContextCheckRuns({
      sourceSha: expectedSha,
      appId: normalized.githubAppId,
      installationToken: installation.token,
      apiBaseUrl,
      fetchImpl,
    });
    if (finalInventory.length !== 1 || finalInventory[0]?.id !== verified.check.id) {
      throw new Error("recovery final inventory is missing, replaced, or duplicated");
    }
    assertExactFailureSeedCheck(finalInventory[0], {
      appId: normalized.githubAppId,
      sourceSha: expectedSha,
      policyADigest,
    });
    const recoveryReadbackTime = now();
    assertRecoverySeedEligibility(verified.evidence, handoff, recoveryReadbackTime);
    await readExactMain({
      expectedSha,
      apiBaseUrl,
      fetchImpl,
      label: "during read-only recovery verification",
    });
    return Object.freeze({ action: selectedAction, ...verified });
  }
  if (existing.length !== 0) {
    throw new Error(
      `seed requires exactly zero ${NEXT_REQUIRED_GATE_CONTEXT} checks; observed ${existing.length}`,
    );
  }

  await readExactMain({
    expectedSha,
    apiBaseUrl,
    fetchImpl,
    label: "immediately before failure-only publication",
  });
  const postTime = now();
  assertFreshHandoffClock(handoff, postTime);
  const evidence = createContextSeedEvidence({
    sourceSha: expectedSha,
    policyADigest,
    seededAt: utcSecond(postTime),
  });
  const body = createFailureOnlySeedBody(evidence);
  const created = await githubJsonRequest({
    apiBaseUrl,
    path: `/repos/${encodeRepository()}/check-runs`,
    method: "POST",
    authorization: `Bearer ${installation.token}`,
    body,
    fetchImpl,
  });
  const persisted = assertExactFailureSeedCheck(created, {
    appId: normalized.githubAppId,
    sourceSha: expectedSha,
    policyADigest,
  });
  const byId = await readCheckRunById({
    checkId: persisted.check.id,
    installationToken: installation.token,
    apiBaseUrl,
    fetchImpl,
  });
  if (byId?.id !== persisted.check.id) {
    throw new Error("created check GET-by-ID returned a different check run");
  }
  assertExactFailureSeedCheck(byId, {
    appId: normalized.githubAppId,
    sourceSha: expectedSha,
    policyADigest,
  });
  const after = await listNextContextCheckRuns({
    sourceSha: expectedSha,
    appId: normalized.githubAppId,
    installationToken: installation.token,
    apiBaseUrl,
    fetchImpl,
  });
  if (after.length !== 1 || after[0]?.id !== persisted.check.id) {
    throw new Error(
      `postcondition requires exactly one ${NEXT_REQUIRED_GATE_CONTEXT} check with the created ID`,
    );
  }
  const verified = assertExactFailureSeedCheck(after[0], {
    appId: normalized.githubAppId,
    sourceSha: expectedSha,
    policyADigest,
  });
  await readExactMain({
    expectedSha,
    apiBaseUrl,
    fetchImpl,
    label: "after failure-only publication and exact readback",
  });
  return Object.freeze({ action: selectedAction, ...verified });
}

export function buildContextSeedCredentialCommand({ action, jobId }) {
  const selectedAction = assertAction(action);
  const id = assertJobId(jobId);
  const parentUnit = `agenc-local-gate-context-seed@${selectedAction}.service`;
  const unitName = `agenc-local-gate-context-seed-credential-${id}`;
  return Object.freeze({
    unitName: `${unitName}.service`,
    command: "/usr/bin/systemd-run",
    args: Object.freeze([
      "--system",
      `--slice=${LOCAL_GATE_AGGREGATE_SLICE}`,
      "--no-ask-password",
      "--expand-environment=no",
      "--quiet",
      "--wait",
      "--collect",
      "--pipe",
      "--service-type=exec",
      `--unit=${unitName}`,
      "--uid=0",
      "--gid=0",
      "--working-directory=/",
      "--property=Type=exec",
      "--property=ExitType=main",
      "--property=KillMode=control-group",
      "--property=SendSIGKILL=yes",
      "--property=TimeoutStopSec=30s",
      "--property=RuntimeMaxSec=600s",
      "--property=Restart=no",
      `--property=BindsTo=${parentUnit}`,
      `--property=PartOf=${parentUnit}`,
      `--property=LoadCredentialEncrypted=${APP_KEY_CREDENTIAL}:${APP_KEY_CIPHERTEXT}`,
      "--property=NoNewPrivileges=yes",
      "--property=CapabilityBoundingSet=",
      "--property=AmbientCapabilities=",
      "--property=SupplementaryGroups=",
      "--property=ProtectSystem=strict",
      "--property=ProtectHome=yes",
      "--property=PrivateTmp=yes",
      "--property=PrivateDevices=yes",
      "--property=PrivateIPC=yes",
      "--property=ProtectHostname=yes",
      "--property=KeyringMode=private",
      "--property=ProtectKernelTunables=yes",
      "--property=ProtectKernelModules=yes",
      "--property=ProtectKernelLogs=yes",
      "--property=ProtectControlGroups=yes",
      "--property=ProtectClock=yes",
      "--property=ProtectProc=invisible",
      "--property=ProcSubset=pid",
      "--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
      "--property=RestrictNamespaces=yes",
      "--property=RestrictSUIDSGID=yes",
      "--property=LockPersonality=yes",
      "--property=RestrictRealtime=yes",
      "--property=SystemCallArchitectures=native",
      "--property=TasksMax=64",
      "--property=CPUQuota=100%",
      "--property=MemoryMax=512M",
      "--property=MemorySwapMax=0",
      "--property=OOMPolicy=kill",
      "--property=LimitFSIZE=16M",
      "--property=LimitCORE=0",
      "--property=LimitNOFILE=1024",
      "--property=UMask=0077",
      "--property=ReadOnlyPaths=/run/agenc-local-gate-context-seed",
      "--property=InaccessiblePaths=-/var/lib/agenc-local-gatekeeper",
      "--property=InaccessiblePaths=-/var/log/agenc-local-gatekeeper",
      "--property=InaccessiblePaths=-/var/lib/agenc-gate-worker",
      "--property=InaccessiblePaths=-/run/agenc-local-gatekeeper",
      "--property=InaccessiblePaths=-/var/run/docker.sock",
      "--property=InaccessiblePaths=-/run/docker.sock",
      "--property=InaccessiblePaths=-/run/dbus/system_bus_socket",
      "--property=InaccessiblePaths=-/run/systemd/private",
      "--setenv=HOME=/nonexistent",
      "--setenv=LANG=C.UTF-8",
      "--setenv=LC_ALL=C.UTF-8",
      "--setenv=NODE_OPTIONS=",
      "--setenv=PATH=/usr/bin:/bin",
      "--setenv=TZ=UTC",
      "--",
      TRUSTED_NODE_PATH,
      TRUSTED_SCRIPT_PATH,
      "--credentialed",
      id,
    ]),
  });
}

function assertHandoffDirectory(
  directory,
  { expectedUid = 0, expectedGid = 0 } = {},
) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== expectedUid ||
    metadata.gid !== expectedGid ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new Error("context-seed runtime directory metadata is unsafe");
  }
}

function handoffPath(directory, jobId) {
  return path.join(directory, `${assertJobId(jobId)}.json`);
}

export function pruneOrphanedContextSeedHandoffs({
  directory = HANDOFF_DIRECTORY,
  expectedUid = 0,
  expectedGid = 0,
} = {}) {
  assertHandoffDirectory(directory, { expectedUid, expectedGid });
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.length > 128) {
    throw new Error("context-seed runtime directory exceeds the reviewed 128-entry bound");
  }
  let removed = 0;
  for (const entry of entries) {
    const match = /^([0-9a-f]{32})\.json$/u.exec(entry.name);
    if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`unexpected context-seed runtime entry: ${entry.name}`);
    }
    const targetPath = handoffPath(directory, match[1]);
    assertRootOwnedRegularFile(targetPath, "orphaned context-seed handoff", {
      exactMode: 0o600,
      maxBytes: MAX_HANDOFF_BYTES,
      expectedUid,
      expectedGid,
    });
    unlinkSync(targetPath);
    removed += 1;
  }
  return removed;
}

export function writeContextSeedHandoff({
  directory = HANDOFF_DIRECTORY,
  action,
  jobId,
  sourceSha,
  policyADigest,
  createdAt,
}) {
  assertHandoffDirectory(directory);
  const handoff = Object.freeze({
    schemaVersion: CONTEXT_SEED_SCHEMA_VERSION,
    action: assertAction(action),
    jobId: assertJobId(jobId),
    repository: CONTEXT_SEED_REPOSITORY,
    ref: CONTEXT_SEED_REF,
    sourceSha: assertSha(sourceSha),
    currentContext: REQUIRED_GATE_CONTEXT,
    policyADigest: assertDigest(policyADigest),
    nextContext: NEXT_REQUIRED_GATE_CONTEXT,
    createdAt: exactUtcSecond(createdAt, "context-seed handoff timestamp"),
  });
  const targetPath = handoffPath(directory, jobId);
  const fd = openSync(
    targetPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${canonicalJson(handoff)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return Object.freeze({ handoff, path: targetPath });
}

export function readContextSeedHandoff({
  directory = HANDOFF_DIRECTORY,
  jobId,
  now = new Date(),
}) {
  const targetPath = handoffPath(directory, jobId);
  assertRootOwnedRegularFile(targetPath, "context-seed handoff", {
    exactMode: 0o600,
    maxBytes: MAX_HANDOFF_BYTES,
  });
  const encoded = readFileSync(targetPath, "utf8");
  if (!encoded.endsWith("\n") || encoded.slice(0, -1).includes("\n")) {
    throw new Error("context-seed handoff must be one newline-terminated record");
  }
  const parsed = JSON.parse(encoded.slice(0, -1));
  const expected = Object.freeze({
    schemaVersion: CONTEXT_SEED_SCHEMA_VERSION,
    action: assertAction(parsed?.action),
    jobId: assertJobId(parsed?.jobId),
    repository: CONTEXT_SEED_REPOSITORY,
    ref: CONTEXT_SEED_REF,
    sourceSha: assertSha(parsed?.sourceSha),
    currentContext: REQUIRED_GATE_CONTEXT,
    policyADigest: assertDigest(parsed?.policyADigest),
    nextContext: NEXT_REQUIRED_GATE_CONTEXT,
    createdAt: exactUtcSecond(parsed?.createdAt, "context-seed handoff timestamp"),
  });
  if (parsed.jobId !== jobId || canonicalJson(parsed) !== canonicalJson(expected)) {
    throw new Error("context-seed handoff is not the exact reviewed shape");
  }
  const ageMs = new Date(now).getTime() - Date.parse(expected.createdAt);
  if (!Number.isFinite(ageMs) || ageMs < -MAX_FUTURE_SKEW_MS || ageMs > MAX_HANDOFF_AGE_MS) {
    throw new Error("context-seed handoff is stale or from the future");
  }
  return expected;
}

export function parseContextSeedArguments(argv) {
  if (
    argv.length === 2 &&
    argv[0] === "--dispatch" &&
    (argv[1] === "seed" || argv[1] === "recover")
  ) {
    return Object.freeze({ mode: "dispatch", action: argv[1] });
  }
  if (argv.length === 2 && argv[0] === "--credentialed" && JOB_ID_PATTERN.test(argv[1])) {
    return Object.freeze({ mode: "credentialed", jobId: argv[1] });
  }
  throw new Error(
    "usage: local-gate-context-seed --dispatch (seed|recover) | --credentialed <handoff-id>",
  );
}

function assertEncryptedCredentialSource() {
  assertImmutablePathChain(APP_KEY_CIPHERTEXT);
  assertRootOwnedRegularFile(APP_KEY_CIPHERTEXT, "encrypted GitHub App credential", {
    exactMode: 0o600,
    maxBytes: 256 * 1024,
  });
}

function assertTrustedContextSeedExecutionPaths() {
  assertImmutablePathChain(TRUSTED_REPOSITORY_ROOT, { finalType: "directory" });
  for (const relativePath of REQUIRED_GATE_POLICY_PATHS) {
    assertImmutablePathChain(path.join(TRUSTED_REPOSITORY_ROOT, ...relativePath.split("/")));
  }
  for (const [filePath, label] of [
    [TRUSTED_SCRIPT_PATH, "trusted context-seed script"],
    [TRUSTED_NODE_PATH, "trusted context-seed Node executable"],
  ]) {
    assertImmutablePathChain(filePath);
    const metadata = assertRootOwnedRegularFile(
      filePath,
      label,
      { maxBytes: 256 * 1024 * 1024 },
    );
    if (filePath === TRUSTED_NODE_PATH && (metadata.mode & 0o111) === 0) {
      throw new Error("trusted context-seed Node is not executable");
    }
  }
}

function startContextSeedCredentialService(invocation) {
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "inherit", "inherit"],
    timeout: 11 * 60_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${invocation.unitName} failed with ${result.error?.message ?? `exit ${result.status}`}`,
    );
  }
}

export async function dispatchContextSeed({
  action,
  config,
  now = () => new Date(),
  fetchImpl,
  verifyDeployment = assertInstalledContextSeedDeployment,
  verifyExecutionPaths = assertTrustedContextSeedExecutionPaths,
  verifyCredentialSource = assertEncryptedCredentialSource,
  pruneHandoffs = pruneOrphanedContextSeedHandoffs,
  startCredentialService = startContextSeedCredentialService,
}) {
  const installedContract = assertApprovedContextSeedPolicy(config);
  verifyExecutionPaths();
  verifyDeployment(action);
  verifyCredentialSource();
  pruneHandoffs();
  const main = await readMainRef({
    repository: CONTEXT_SEED_REPOSITORY,
    apiBaseUrl: API_BASE_URL,
    fetchImpl,
  });
  const jobId = randomBytes(16).toString("hex");
  const written = writeContextSeedHandoff({
    action,
    jobId,
    sourceSha: main.sourceSha,
    policyADigest: installedContract.sha256,
    createdAt: utcSecond(now()),
  });
  try {
    const invocation = buildContextSeedCredentialCommand({ action, jobId });
    startCredentialService(invocation);
  } finally {
    unlinkSync(written.path);
  }
}

async function credentialedContextSeed({ jobId, config, now = () => new Date(), fetchImpl }) {
  const handoff = readContextSeedHandoff({ jobId, now: now() });
  return runCredentialedContextSeed({
    action: handoff.action,
    config,
    handoff,
    now,
    fetchImpl,
  });
}

async function main(argv) {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("policy-context seeder must run as root on Linux");
  }
  if (realpathSync(fileURLToPath(import.meta.url)) !== TRUSTED_SCRIPT_PATH) {
    throw new Error("policy-context seeder must run from the reviewed root-installed mirror");
  }
  if (realpathSync(process.execPath) !== TRUSTED_NODE_PATH) {
    throw new Error("policy-context seeder must run with the reviewed root-installed Node");
  }
  assertTrustedContextSeedExecutionPaths();
  const parsed = parseContextSeedArguments(argv);
  const config = loadInstalledConfig();
  if (parsed.mode === "dispatch") {
    await dispatchContextSeed({ action: parsed.action, config });
    process.stdout.write(
      `local-gate-context-seed: ${parsed.action} completed for ${NEXT_REQUIRED_GATE_CONTEXT}\n`,
    );
    return;
  }
  const result = await credentialedContextSeed({ jobId: parsed.jobId, config });
  process.stdout.write(
    `local-gate-context-seed: ${result.action} verified failure check ${result.check.id}\n`,
  );
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`local-gate-context-seed: ${error?.stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
