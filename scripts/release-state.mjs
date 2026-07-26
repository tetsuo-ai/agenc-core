#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_SCHEMA_VERSION = 1;
const EVIDENCE_SCHEMA_VERSION = 2;
const REPOSITORY = "tetsuo-ai/agenc-core";
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA_RE = /^[0-9a-f]{40}$/u;
const HASH_RE = /^[0-9a-f]{64}$/u;
const INVALID_LOCK_GRACE_MS = 30_000;
const LANES = new Set(["full", "installer-hotfix"]);
const CHECKPOINTS = Object.freeze({
  full: Object.freeze([
    "source-tag-pushed",
    "runtime-build-complete",
    "release-draft-staged",
    "github-published",
    "installer-promoted",
    "vercel-deployed",
    "npm-published",
    "converged",
  ]),
  "installer-hotfix": Object.freeze([
    "installer-promoted",
    "converged",
  ]),
});

export function checkpointSequence(lane) {
  const sequence = CHECKPOINTS[lane];
  if (!sequence) throw new Error(`unknown release lane: ${lane}`);
  return sequence;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/release-state.mjs verify --lane full --version X.Y.Z",
    "  node scripts/release-state.mjs verify --lane installer-hotfix",
    "  node scripts/release-state.mjs status --lane <lane> [--version X.Y.Z] [--sha <sha>]",
    "  node scripts/release-state.mjs checkpoint --lane <lane> [--version X.Y.Z] --step <name> --receipt-json <json>",
    "",
    "Options:",
    "  --state-root <path>  Override the private state root.",
    "  --sha <sha>          Bind to an exact commit; defaults to HEAD.",
    "  --json               Emit machine-readable output (status always does).",
  ].join("\n");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    return { command: "help", options: {} };
  }
  if (!["verify", "status", "checkpoint"].includes(command)) {
    throw new Error(`unknown command: ${command}\n${usage()}`);
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}\n${usage()}`);
    }
    const equals = arg.indexOf("=");
    const key = arg.slice(2, equals === -1 ? undefined : equals);
    const value = equals === -1 ? rest[++index] : arg.slice(equals + 1);
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}\n${usage()}`);
    }
    if (
      ![
        "lane",
        "version",
        "sha",
        "state-root",
        "step",
        "receipt-json",
      ].includes(key)
    ) {
      throw new Error(`unknown option: --${key}\n${usage()}`);
    }
    options[key] = value;
  }
  return { command, options };
}

function runGit(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function currentReleaseVersion() {
  const paths = [
    "package.json",
    "runtime/package.json",
    "packages/agenc/package.json",
  ];
  const versions = paths.map(
    (path) => JSON.parse(readFileSync(join(repoRoot, path), "utf8")).version,
  );
  if (new Set(versions).size !== 1 || !SEMVER_RE.test(versions[0])) {
    throw new Error(`release package versions are not synchronized: ${versions.join(", ")}`);
  }
  const source = readFileSync(join(repoRoot, "runtime/src/version.ts"), "utf8");
  const sourceMatch = /export const VERSION = "([^"]+)";/u.exec(source);
  if (!sourceMatch || sourceMatch[1] !== versions[0]) {
    throw new Error("runtime/src/version.ts does not match the release package version");
  }
  return versions[0];
}

function resolveIdentity(options) {
  const lane = options.lane;
  if (!LANES.has(lane)) {
    throw new Error(`--lane must be one of: ${[...LANES].join(", ")}`);
  }
  const sha = options.sha ?? runGit(["rev-parse", "HEAD"]).stdout;
  if (!SHA_RE.test(sha)) throw new Error(`invalid exact commit SHA: ${sha}`);
  const sourceVersion = currentReleaseVersion();
  const version = options.version ?? sourceVersion;
  if (!SEMVER_RE.test(version)) {
    throw new Error(`release version is not canonical stable SemVer: ${version}`);
  }
  if (version !== sourceVersion) {
    throw new Error(
      `requested version ${version} does not match synchronized source ${sourceVersion}`,
    );
  }
  return {
    lane,
    sha,
    version,
    tag: lane === "full" ? `agenc-v${version}` : null,
  };
}

function defaultStateRoot() {
  const configured = process.env.AGENC_RELEASE_STATE_DIR?.trim();
  return resolve(
    configured || join(homedir(), ".local", "state", "agenc-release"),
  );
}

function statePaths(identity, options = {}) {
  const root = resolve(options["state-root"] || defaultStateRoot());
  const name =
    identity.lane === "full"
      ? `${identity.tag}-${identity.sha}`
      : `installer-hotfix-${identity.sha}`;
  const directory = join(root, name);
  return {
    root,
    directory,
    state: join(directory, "state.json"),
    evidence: join(directory, "evidence.json"),
    logs: join(directory, "logs"),
    lock: join(directory, "operation.lock"),
  };
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o700) {
    throw new Error(`release state directory must be mode 0700: ${path}`);
  }
}

function writeJsonAtomic(path, value) {
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function writeBytesAtomic(path, bytes) {
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function loadJson(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected JSON object: ${path}`);
  }
  return value;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function lockOwner(path) {
  try {
    const owner = loadJson(path);
    if (
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.token !== "string" ||
      !HASH_RE.test(owner.token) ||
      typeof owner.operation !== "string" ||
      typeof owner.startedAt !== "string"
    ) {
      return null;
    }
    return owner;
  } catch {
    return null;
  }
}

export function acquireReleaseLock(paths, operation) {
  ensurePrivateDirectory(paths.directory);
  const token = randomBytes(32).toString("hex");
  const owner = {
    pid: process.pid,
    token,
    operation,
    startedAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    let descriptor;
    let created = false;
    try {
      descriptor = openSync(paths.lock, "wx", 0o600);
      created = true;
      writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      chmodSync(paths.lock, 0o600);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = lockOwner(paths.lock);
        if (current?.token === token) unlinkSync(paths.lock);
      };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error?.code !== "EEXIST") {
        if (created && existsSync(paths.lock)) unlinkSync(paths.lock);
        throw error;
      }
      const current = lockOwner(paths.lock);
      let invalidLockIsFresh = false;
      if (current === null) {
        try {
          invalidLockIsFresh =
            Date.now() - statSync(paths.lock).mtimeMs < INVALID_LOCK_GRACE_MS;
        } catch (statError) {
          if (statError?.code === "ENOENT") continue;
          throw statError;
        }
      }
      if (invalidLockIsFresh || (current !== null && processIsAlive(current.pid))) {
        const detail =
          current === null
            ? "owner metadata is still being written"
            : `${current.operation} by pid ${current.pid} since ${current.startedAt}`;
        throw new Error(
          `release state is already locked for ${detail}: ${paths.lock}`,
        );
      }
      const stale = `${paths.lock}.stale-${process.pid}-${randomBytes(8).toString("hex")}`;
      try {
        renameSync(paths.lock, stale);
        unlinkSync(stale);
      } catch (renameError) {
        if (renameError?.code !== "ENOENT") throw renameError;
      }
    }
  }
  throw new Error(`could not acquire release state lock: ${paths.lock}`);
}

export function verificationPlan(lane) {
  if (!LANES.has(lane)) throw new Error(`unknown release lane: ${lane}`);
  if (lane === "installer-hotfix") {
    return Object.freeze([
      Object.freeze({
        id: "installer-lock-sync",
        argv: ["npm", "run", "check:installer-sqlite-lock"],
      }),
      Object.freeze({
        id: "installer-shell-syntax",
        argv: ["sh", "-n", "scripts/install/install.sh"],
      }),
      Object.freeze({
        id: "installer-runtime-tests",
        argv: [
          "npm",
          "exec",
          "--workspace=@tetsuo-ai/runtime",
          "--",
          "vitest",
          "run",
          "tests/packaging/install-sh.test.ts",
        ],
      }),
      Object.freeze({
        id: "installer-launcher-tests",
        argv: ["npm", "test", "--workspace=@tetsuo-ai/agenc"],
      }),
    ]);
  }
  return Object.freeze([
    Object.freeze({
      id: "release-preflight",
      argv: ["npm", "run", "release:preflight"],
    }),
    Object.freeze({
      id: "installer-lock-sync",
      argv: ["npm", "run", "check:installer-sqlite-lock"],
    }),
    Object.freeze({
      id: "typecheck",
      argv: ["npm", "run", "typecheck"],
    }),
    Object.freeze({
      id: "full-tests",
      argv: ["npm", "test"],
    }),
    Object.freeze({
      id: "runtime-build",
      argv: ["npm", "run", "build", "--workspace=@tetsuo-ai/runtime"],
    }),
    Object.freeze({
      id: "runtime-startup",
      argv: [
        "npm",
        "run",
        "check:tui-runtime-startup",
        "--workspace=@tetsuo-ai/runtime",
      ],
    }),
    Object.freeze({
      id: "clean-build",
      argv: [
        "npm",
        "run",
        "check:clean-build",
        "--",
        "--buildkit-network=host",
      ],
    }),
  ]);
}

export function releasePlanDigest(plan) {
  return sha256Bytes(
    Buffer.from(
      canonicalJson(
        plan.map(({ id, argv }) => ({ id, argv })),
      ),
      "utf8",
    ),
  );
}

function refreshOriginMain() {
  runGit([
    "fetch",
    "--no-tags",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
}

function assertCleanHead(identity) {
  const head = runGit(["rev-parse", "HEAD"]).stdout;
  if (head !== identity.sha) {
    throw new Error(`HEAD ${head} does not match requested exact SHA ${identity.sha}`);
  }
  const status = runGit([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]).stdout;
  if (status) throw new Error(`release verification requires a clean tree:\n${status}`);
}

function assertExactCleanMain(identity) {
  refreshOriginMain();
  assertCleanHead(identity);
  const originMain = runGit(["rev-parse", "refs/remotes/origin/main"]).stdout;
  if (originMain !== identity.sha) {
    throw new Error(
      `release verification requires exact origin/main ${originMain}; found ${identity.sha}`,
    );
  }
}

function assertStillOnMainHistory(identity) {
  refreshOriginMain();
  assertCleanHead(identity);
  const ancestry = runGit(
    [
      "merge-base",
      "--is-ancestor",
      identity.sha,
      "refs/remotes/origin/main",
    ],
    { allowFailure: true },
  );
  if (!ancestry.ok) {
    throw new Error(
      `verified SHA ${identity.sha} is no longer on origin/main history`,
    );
  }
}

function initialState(identity, plan) {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    repository: REPOSITORY,
    lane: identity.lane,
    version: identity.version,
    tag: identity.tag,
    sha: identity.sha,
    createdAt: timestamp,
    updatedAt: timestamp,
    plan: {
      digest: releasePlanDigest(plan),
      gates: plan.map(({ id, argv }) => ({ id, argv })),
    },
    verification: {
      status: "pending",
      startedAt: null,
      finishedAt: null,
      cleanTree: null,
      gates: [],
      evidencePath: null,
      evidenceSha256: null,
    },
    checkpoints: {},
  };
}

function validateStateIdentity(state, identity, plan) {
  const expected = {
    schemaVersion: STATE_SCHEMA_VERSION,
    repository: REPOSITORY,
    lane: identity.lane,
    version: identity.version,
    tag: identity.tag,
    sha: identity.sha,
    planDigest: releasePlanDigest(plan),
  };
  const observed = {
    schemaVersion: state.schemaVersion,
    repository: state.repository,
    lane: state.lane,
    version: state.version,
    tag: state.tag,
    sha: state.sha,
    planDigest: state.plan?.digest,
  };
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    throw new Error(
      `release state identity or verification plan drifted:\n` +
        `expected=${JSON.stringify(expected)}\nobserved=${JSON.stringify(observed)}`,
    );
  }
}

function loadOrCreateState(identity, plan, paths) {
  ensurePrivateDirectory(paths.root);
  ensurePrivateDirectory(paths.directory);
  ensurePrivateDirectory(paths.logs);
  if (!existsSync(paths.state)) {
    const state = initialState(identity, plan);
    writeJsonAtomic(paths.state, state);
    return state;
  }
  const state = loadJson(paths.state);
  validateStateIdentity(state, identity, plan);
  return state;
}

function updateState(paths, state) {
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(paths.state, state);
}

function gateRecord(state, id) {
  return state.verification.gates.find((candidate) => candidate.id === id);
}

export async function passedGateCanResume(record) {
  if (
    record?.result !== "pass" ||
    typeof record.logPath !== "string" ||
    !HASH_RE.test(record.logSha256 ?? "") ||
    !existsSync(record.logPath)
  ) {
    return false;
  }
  return (await sha256File(record.logPath)) === record.logSha256;
}

async function runGate(gate, logPath) {
  ensurePrivateDirectory(dirname(logPath));
  const startedAt = new Date().toISOString();
  const log = createWriteStream(logPath, { flags: "w", mode: 0o600 });
  log.write(
    `${JSON.stringify({
      startedAt,
      cwd: repoRoot,
      argv: gate.argv,
    })}\n`,
  );
  const child = spawn(gate.argv[0], gate.argv.slice(1), {
    cwd: repoRoot,
    env: { ...process.env, CI: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const forward = (stream, destination) => {
    stream.on("data", (chunk) => {
      destination.write(chunk);
      log.write(chunk);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  const outcome = await new Promise((resolveOutcome) => {
    child.on("error", (error) => resolveOutcome({ exitCode: null, error }));
    child.on("close", (code, signal) =>
      resolveOutcome({ exitCode: code, signal, error: null }),
    );
  });
  await new Promise((resolveLog, rejectLog) => {
    log.on("error", rejectLog);
    log.end(resolveLog);
  });
  chmodSync(logPath, 0o600);
  const finishedAt = new Date().toISOString();
  const logSha256 = await sha256File(logPath);
  return {
    id: gate.id,
    argv: gate.argv,
    command: gate.argv.map((part) => JSON.stringify(part)).join(" "),
    result: outcome.exitCode === 0 ? "pass" : "fail",
    exitCode: outcome.exitCode,
    signal: outcome.signal ?? null,
    error: outcome.error?.message ?? null,
    startedAt,
    finishedAt,
    logPath,
    logSha256,
  };
}

function replaceGateRecord(state, record) {
  const index = state.verification.gates.findIndex(
    (candidate) => candidate.id === record.id,
  );
  if (index === -1) state.verification.gates.push(record);
  else state.verification.gates[index] = record;
}

function evidenceDocument(identity, state) {
  const npmVersionResult = spawnSync("npm", ["--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (npmVersionResult.status !== 0) {
    throw new Error(
      `could not record npm version: ${npmVersionResult.stderr.trim()}`,
    );
  }
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    repository: REPOSITORY,
    lane: identity.lane,
    tag: identity.tag,
    testedSha: identity.sha,
    mainShaAtVerification: identity.sha,
    startedAt: state.verification.startedAt,
    finishedAt: state.verification.finishedAt,
    nodeVersion: process.versions.node,
    npmVersion: npmVersionResult.stdout.trim(),
    planDigest: state.plan.digest,
    gates: state.plan.gates.map(({ id }) => {
      const record = gateRecord(state, id);
      if (record?.result !== "pass") {
        throw new Error(`cannot create evidence without passing gate: ${id}`);
      }
      return {
        id,
        argv: record.argv,
        result: record.result,
        exitCode: record.exitCode,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        logSha256: record.logSha256,
      };
    }),
    skips: [],
    cleanTree: state.verification.cleanTree,
    reviewer: "release-orchestrator",
    unresolvedRisks: [],
  };
}

async function writeEvidence(identity, state, paths) {
  const evidence = evidenceDocument(identity, state);
  const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const digest = sha256Bytes(bytes);
  if (existsSync(paths.evidence)) {
    const existing = readFileSync(paths.evidence);
    const existingDigest = sha256Bytes(existing);
    if (existingDigest !== digest) {
      throw new Error(
        `existing evidence bytes differ for the same exact SHA: ${paths.evidence}`,
      );
    }
  } else {
    writeJsonAtomic(paths.evidence, evidence);
  }
  chmodSync(paths.evidence, 0o600);
  state.verification.evidencePath = paths.evidence;
  state.verification.evidenceSha256 = digest;
}

async function verify(identity, options) {
  const plan = verificationPlan(identity.lane);
  const paths = statePaths(identity, options);
  const releaseLock = acquireReleaseLock(paths, "verify");
  try {
    if (existsSync(paths.state)) assertStillOnMainHistory(identity);
    else assertExactCleanMain(identity);
    const state = loadOrCreateState(identity, plan, paths);
    if (state.verification.status === "pass") {
      if (
        state.retention?.compactedAt &&
        state.checkpoints.converged !== undefined
      ) {
        await compactCompletedLogs(state, paths);
        return { resumed: true, state, paths };
      }
      for (const gate of plan) {
        const record = gateRecord(state, gate.id);
        if (!(await passedGateCanResume(record))) {
          throw new Error(
            `passing release evidence lost or changed its retained log: ${gate.id}`,
          );
        }
      }
      await writeEvidence(identity, state, paths);
      updateState(paths, state);
      return { resumed: true, state, paths };
    }
    state.verification.status = "running";
    state.verification.startedAt ??= new Date().toISOString();
    state.verification.finishedAt = null;
    state.verification.cleanTree = null;
    updateState(paths, state);

    for (const gate of plan) {
      const previous = gateRecord(state, gate.id);
      if (
        previous &&
        canonicalJson(previous.argv) === canonicalJson(gate.argv) &&
        (await passedGateCanResume(previous))
      ) {
        process.stderr.write(
          `[release-state] ${gate.id}: already passed for ${identity.sha}; skipping\n`,
        );
        continue;
      }
      process.stderr.write(
        `[release-state] ${gate.id}: ${gate.argv.join(" ")}\n`,
      );
      const logPath = join(paths.logs, `${gate.id}.log`);
      const record = await runGate(gate, logPath);
      replaceGateRecord(state, record);
      if (record.result !== "pass") {
        state.verification.status = "fail";
        state.verification.finishedAt = record.finishedAt;
        state.verification.cleanTree = false;
        updateState(paths, state);
        throw new Error(
          `release verification gate failed: ${gate.id} (log: ${logPath})`,
        );
      }
      updateState(paths, state);
    }

    assertStillOnMainHistory(identity);
    state.verification.status = "pass";
    state.verification.finishedAt = new Date().toISOString();
    state.verification.cleanTree = true;
    await writeEvidence(identity, state, paths);
    updateState(paths, state);
    return { resumed: false, state, paths };
  } finally {
    releaseLock();
  }
}

export async function compactCompletedLogs(state, paths) {
  if (state.retention?.compactedAt) {
    const receipts = state.retention.logs;
    const expectedIds = state.verification.gates.map(({ id }) => id).sort();
    const receiptIds = Array.isArray(receipts)
      ? receipts.map(({ id }) => id).sort()
      : [];
    if (canonicalJson(receiptIds) !== canonicalJson(expectedIds)) {
      throw new Error("compacted verification archive inventory is incomplete");
    }
    for (const receipt of receipts) {
      if (
        !HASH_RE.test(receipt.archiveSha256 ?? "") ||
        !existsSync(receipt.archivePath) ||
        (await sha256File(receipt.archivePath)) !== receipt.archiveSha256
      ) {
        throw new Error(
          `compacted verification archive is missing or changed: ${receipt.id}`,
        );
      }
      const record = state.verification.gates.find(
        (candidate) => candidate.id === receipt.id,
      );
      if (record && existsSync(record.logPath)) {
        if ((await sha256File(record.logPath)) !== receipt.originalSha256) {
          throw new Error(
            `retained plaintext verification log changed after compaction: ${receipt.id}`,
          );
        }
        unlinkSync(record.logPath);
      }
    }
    if (!state.retention.plaintextRemovedAt) {
      state.retention.plaintextRemovedAt = new Date().toISOString();
      updateState(paths, state);
    }
    return;
  }
  const archived = [];
  for (const record of state.verification.gates) {
    if (!(await passedGateCanResume(record))) {
      throw new Error(
        `cannot compact missing or changed verification log: ${record.id}`,
      );
    }
    const bytes = readFileSync(record.logPath);
    const archivePath = `${record.logPath}.gz`;
    const compressed = gzipSync(bytes, { level: 9, mtime: 0 });
    writeBytesAtomic(archivePath, compressed);
    const archiveSha256 = sha256Bytes(compressed);
    record.archivePath = archivePath;
    record.archiveSha256 = archiveSha256;
    archived.push({
      id: record.id,
      originalSha256: record.logSha256,
      archivePath,
      archiveSha256,
      originalBytes: bytes.length,
      archiveBytes: compressed.length,
    });
  }
  state.retention = {
    compactedAt: new Date().toISOString(),
    plaintextRemovedAt: null,
    logs: archived,
  };
  updateState(paths, state);
  for (const record of state.verification.gates) {
    unlinkSync(record.logPath);
  }
  state.retention.plaintextRemovedAt = new Date().toISOString();
  updateState(paths, state);
}

function parseReceipt(value) {
  if (typeof value !== "string") {
    throw new Error("checkpoint requires --receipt-json");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`invalid --receipt-json: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--receipt-json must contain a JSON object");
  }
  return parsed;
}

async function checkpoint(identity, options) {
  const plan = verificationPlan(identity.lane);
  const paths = statePaths(identity, options);
  const releaseLock = acquireReleaseLock(paths, `checkpoint:${options.step ?? "unknown"}`);
  try {
    if (!existsSync(paths.state)) {
      throw new Error(`no release state exists for ${identity.sha}; run verify first`);
    }
    const state = loadJson(paths.state);
    validateStateIdentity(state, identity, plan);
    if (state.verification.status !== "pass") {
      throw new Error("release checkpoints require completed exact-SHA verification");
    }
    const step = options.step;
    const sequence = checkpointSequence(identity.lane);
    if (!sequence.includes(step)) {
      throw new Error(
        `invalid ${identity.lane} checkpoint ${JSON.stringify(step)}; expected one of ` +
          sequence.join(", "),
      );
    }
    const receipt = parseReceipt(options["receipt-json"]);
    const priorSteps = sequence.slice(
      0,
      sequence.indexOf(step),
    );
    const missingPrior = priorSteps.filter(
      (candidate) => state.checkpoints[candidate] === undefined,
    );
    if (missingPrior.length > 0) {
      throw new Error(
        `checkpoint ${step} is out of order; missing ${missingPrior.join(", ")}`,
      );
    }
    const existing = state.checkpoints[step];
    if (existing !== undefined) {
      if (canonicalJson(existing.receipt) !== canonicalJson(receipt)) {
        throw new Error(`checkpoint ${step} already has a different immutable receipt`);
      }
      if (step === "converged") await compactCompletedLogs(state, paths);
      return { resumed: true, state, paths };
    }
    state.checkpoints[step] = {
      recordedAt: new Date().toISOString(),
      receipt,
    };
    updateState(paths, state);
    if (step === "converged") await compactCompletedLogs(state, paths);
    return { resumed: false, state, paths };
  } finally {
    releaseLock();
  }
}

function status(identity, options) {
  const plan = verificationPlan(identity.lane);
  const paths = statePaths(identity, options);
  if (!existsSync(paths.state)) {
    return {
      exists: false,
      lane: identity.lane,
      version: identity.version,
      tag: identity.tag,
      sha: identity.sha,
      statePath: paths.state,
      next: "verify",
    };
  }
  const state = loadJson(paths.state);
  validateStateIdentity(state, identity, plan);
  const nextCheckpoint = checkpointSequence(identity.lane).find(
    (step) => state.checkpoints[step] === undefined,
  );
  return {
    exists: true,
    lane: identity.lane,
    version: identity.version,
    tag: identity.tag,
    sha: identity.sha,
    verification: state.verification,
    checkpoints: state.checkpoints,
    statePath: paths.state,
    next:
      state.verification.status !== "pass"
        ? "verify"
        : nextCheckpoint ?? "complete",
  };
}

function resultSummary(result, identity) {
  return {
    lane: identity.lane,
    version: identity.version,
    tag: identity.tag,
    sha: identity.sha,
    resumed: result.resumed,
    verification: result.state.verification.status,
    statePath: result.paths.state,
    evidencePath: result.state.verification.evidencePath,
    evidenceSha256: result.state.verification.evidenceSha256,
    checkpoints: result.state.checkpoints,
  };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const identity = resolveIdentity(options);
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(status(identity, options), null, 2)}\n`);
    return;
  }
  if (command === "checkpoint") {
    const result = await checkpoint(identity, options);
    process.stdout.write(
      `${JSON.stringify(resultSummary(result, identity), null, 2)}\n`,
    );
    return;
  }
  const result = await verify(identity, options);
  process.stdout.write(
    `${JSON.stringify(resultSummary(result, identity), null, 2)}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error) => {
    console.error(`[release-state] FAILED: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
