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
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
const MAX_CANDIDATE_ATTESTATION_BYTES = 4 * 1024 * 1024;
const GITHUB_ATTESTATION_TIMEOUT_MS = 30_000;
const GITHUB_CLI_TOOLCHAIN_SCHEMA_VERSION = 1;
const CANDIDATE_ESCROW_REPOSITORY = "tetsuo-ai/agenc-releases";
const GITHUB_CLI_TARGET_BY_HOST = Object.freeze({
  "linux:x64": "linuxX64",
  "linux:arm64": "linuxArm64",
  "darwin:x64": "macosX64",
  "darwin:arm64": "macosArm64",
  "win32:x64": "windowsX64",
});
const LANES = new Set(["full", "installer-hotfix"]);
const CANDIDATE_SUCCESSFUL_JOBS = Object.freeze([
  "release-source",
  "hosted-toolchain-preflight (macos-15, darwin-arm64)",
  "hosted-toolchain-preflight (macos-15-intel, darwin-x64)",
  "hosted-toolchain-preflight (windows-2025-vs2026, win-x64)",
  "linux-tarball (ubuntu-24.04, linux-x64)",
  "linux-tarball (ubuntu-24.04-arm, linux-arm64)",
  "native-tarball (macos-15, darwin-arm64)",
  "native-tarball (macos-15-intel, darwin-x64)",
  "native-tarball (windows-2025-vs2026, win-x64)",
  "candidate-seal",
]);
const CANDIDATE_ARTIFACT_SLUGS = Object.freeze([
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win-x64",
]);
const CHECKPOINTS = Object.freeze({
  full: Object.freeze([
    "candidate-build-complete",
    "candidate-escrow-published",
    "source-tag-pushed",
    "runtime-build-complete",
    "release-draft-staged",
    "github-published",
    "installer-promoted",
    "vercel-deployed",
    "homebrew-published",
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
    "  node scripts/release-state.mjs checkpoint --lane full [--version X.Y.Z] --step candidate-build-complete --receipt-file <path> --receipt-bundle <path> --github-cli <absolute-path>",
    "  GH_TOKEN=<token> node scripts/release-state.mjs checkpoint --lane full [--version X.Y.Z] --step candidate-escrow-published --github-cli <absolute-path>",
    "  node scripts/release-state.mjs checkpoint --lane <lane> [--version X.Y.Z] --step <other-name> --receipt-json <json>",
    "",
    "Options:",
    "  --state-root <path>  Override the private state root.",
    "  --sha <sha>          Bind to an exact commit; defaults to HEAD.",
    "  --receipt-file <path> Candidate seal receipt authenticated before parsing.",
    "  --receipt-bundle <path> Sigstore bundle authenticating the candidate receipt.",
    "  --github-cli <path>   Canonical absolute path to the checksum-pinned GitHub CLI.",
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
        "receipt-file",
        "receipt-bundle",
        "github-cli",
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
      id: "hosted-runner-contract",
      argv: ["npm", "run", "check:hosted-runner-contract"],
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

function readBoundedPlainFile(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} requires a file path`);
  }
  const path = resolve(value);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} is not readable at ${path}: ${error.message}`);
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > MAX_CANDIDATE_ATTESTATION_BYTES
  ) {
    throw new Error(
      `${label} must be a non-empty plain file no larger than ` +
        `${MAX_CANDIDATE_ATTESTATION_BYTES} bytes: ${path}`,
    );
  }
  const bytes = readFileSync(path);
  if (bytes.length !== metadata.size) {
    throw new Error(`${label} changed while it was being read: ${path}`);
  }
  return { bytes, path };
}

function pinnedGitHubCliIdentity() {
  const toolchain = loadJson(join(repoRoot, "release-toolchain.json"));
  if (toolchain.schemaVersion !== GITHUB_CLI_TOOLCHAIN_SCHEMA_VERSION) {
    throw new Error(
      "release-toolchain.json does not contain the supported schema version",
    );
  }
  const githubCli = toolchain.githubCli;
  if (
    githubCli === null ||
    typeof githubCli !== "object" ||
    Array.isArray(githubCli) ||
    githubCli.schemaVersion !== GITHUB_CLI_TOOLCHAIN_SCHEMA_VERSION
  ) {
    throw new Error(
      "release-toolchain.json does not contain the supported GitHub CLI pin schema",
    );
  }
  const version = githubCli.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error("release-toolchain.json does not contain a valid pinned GitHub CLI version");
  }
  const platform = process.platform;
  const arch = process.arch;
  const target = GITHUB_CLI_TARGET_BY_HOST[`${platform}:${arch}`];
  if (target === undefined) {
    throw new Error(
      `release-toolchain.json has no supported GitHub CLI host target for ${platform}/${arch}`,
    );
  }
  const pin = githubCli[target];
  if (
    pin === null ||
    typeof pin !== "object" ||
    Array.isArray(pin) ||
    !Number.isSafeInteger(pin.executableBytes) ||
    pin.executableBytes <= 0 ||
    !HASH_RE.test(pin.executableSha256 ?? "")
  ) {
    throw new Error(
      `release-toolchain.json does not contain a valid GitHub CLI executable pin for ${target}`,
    );
  }
  return Object.freeze({
    arch,
    executableBytes: pin.executableBytes,
    executableSha256: pin.executableSha256,
    platform,
    target,
    version,
  });
}

async function assertPinnedGitHubCliExecutable(githubCliPath, identity, phase) {
  let metadata;
  try {
    metadata = lstatSync(githubCliPath);
  } catch (error) {
    throw new Error(
      `checksum-pinned GitHub CLI is not readable at ${githubCliPath}: ${error.message}`,
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`checksum-pinned GitHub CLI must be a plain file: ${githubCliPath}`);
  }
  if (realpathSync.native(githubCliPath) !== githubCliPath) {
    throw new Error("checksum-pinned GitHub CLI path must be canonical");
  }
  if (metadata.size !== identity.executableBytes) {
    throw new Error(
      `GitHub CLI executable byte count ${metadata.size} does not match ` +
        `release-toolchain.json ${identity.target} pin ${identity.executableBytes} ` +
        `during ${phase}`,
    );
  }
  const observedSha256 = await sha256File(githubCliPath);
  if (observedSha256 !== identity.executableSha256) {
    throw new Error(
      `GitHub CLI executable SHA-256 ${observedSha256} does not match ` +
        `release-toolchain.json ${identity.target} pin ${identity.executableSha256} ` +
        `during ${phase}`,
    );
  }
}

function isolatedGitHubCliEnvironment(workDirectory, source = process.env) {
  const environment = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  const configDirectory = join(workDirectory, "gh-config");
  return {
    ...environment,
    HOME: workDirectory,
    USERPROFILE: workDirectory,
    APPDATA: configDirectory,
    LOCALAPPDATA: configDirectory,
    XDG_CONFIG_HOME: configDirectory,
    XDG_CACHE_HOME: configDirectory,
    GH_CONFIG_DIR: configDirectory,
    GH_HOST: "github.com",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PROMPT_DISABLED: "1",
    GH_SPINNER_DISABLED: "1",
    GH_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
    NO_COLOR: "1",
    TEMP: workDirectory,
    TMP: workDirectory,
  };
}

function runGitHubCli(githubCliPath, args, environment, label) {
  const result = spawnSync(githubCliPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
    timeout: GITHUB_ATTESTATION_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (result.error?.code === "ENOENT") {
    throw new Error(`checksum-pinned GitHub CLI disappeared during ${label}`);
  }
  if (result.error !== undefined) {
    throw new Error(`checksum-pinned GitHub CLI failed during ${label}: ${result.error.message}`);
  }
  return result;
}

async function authenticatedCandidateReceipt(identity, state, options, paths) {
  if (options["receipt-json"] !== undefined) {
    throw new Error(
      "candidate-build-complete does not accept --receipt-json; " +
        "use --receipt-file, --receipt-bundle, and --github-cli",
    );
  }
  const receiptSource = readBoundedPlainFile(
    options["receipt-file"],
    "candidate receipt",
  );
  const bundleSource = readBoundedPlainFile(
    options["receipt-bundle"],
    "candidate receipt Sigstore bundle",
  );
  const githubCliPath = options["github-cli"];
  if (typeof githubCliPath !== "string" || !isAbsolute(githubCliPath)) {
    throw new Error("candidate checkpoint requires an absolute checksum-pinned GitHub CLI path");
  }

  const githubCliIdentity = pinnedGitHubCliIdentity();
  await assertPinnedGitHubCliExecutable(
    githubCliPath,
    githubCliIdentity,
    "pre-spawn verification",
  );
  const workDirectory = mkdtempSync(join(paths.directory, ".candidate-auth-"));
  chmodSync(workDirectory, 0o700);
  const receiptPath = join(workDirectory, basename(receiptSource.path));
  const bundlePath = join(workDirectory, `${basename(receiptSource.path)}.sigstore.json`);
  const configDirectory = join(workDirectory, "gh-config");
  try {
    writeFileSync(receiptPath, receiptSource.bytes, {
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(bundlePath, bundleSource.bytes, {
      flag: "wx",
      mode: 0o600,
    });
    mkdirSync(configDirectory, { mode: 0o700 });
    const environment = isolatedGitHubCliEnvironment(workDirectory);
    const versionResult = runGitHubCli(
      githubCliPath,
      ["--version"],
      environment,
      "version verification",
    );
    if (versionResult.status !== 0) {
      throw new Error(
        "checksum-pinned GitHub CLI version verification failed: " +
          `${versionResult.stderr.trim() || versionResult.stdout.trim() || "unknown error"}`,
      );
    }
    const versionMatch = /^gh version (\d+\.\d+\.\d+)(?:\s|$)/u.exec(
      versionResult.stdout.trim(),
    );
    if (versionMatch?.[1] !== githubCliIdentity.version) {
      throw new Error(
        `GitHub CLI version ${versionMatch?.[1] ?? "unknown"} does not match ` +
          `release-toolchain.json pin ${githubCliIdentity.version}`,
      );
    }

    const verifyArguments = [
      "attestation",
      "verify",
      receiptPath,
      "--bundle",
      bundlePath,
      "--repo",
      REPOSITORY,
      "--signer-workflow",
      `${REPOSITORY}/.github/workflows/release-runtime.yml`,
      "--signer-digest",
      identity.sha,
      "--source-digest",
      identity.sha,
      "--source-ref",
      "refs/heads/main",
      "--hostname",
      "github.com",
      "--cert-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      "--predicate-type",
      "https://slsa.dev/provenance/v1",
      "--deny-self-hosted-runners",
    ];
    const verifyResult = runGitHubCli(
      githubCliPath,
      verifyArguments,
      environment,
      "candidate receipt attestation verification",
    );
    if (verifyResult.status !== 0) {
      throw new Error(
        `GitHub attestation policy rejected ${basename(receiptSource.path)}: ` +
          `${verifyResult.stderr.trim() || verifyResult.stdout.trim() || "unknown error"}`,
      );
    }

    const verifiedReceiptBytes = readFileSync(receiptPath);
    const verifiedBundleBytes = readFileSync(bundlePath);
    if (
      !verifiedReceiptBytes.equals(receiptSource.bytes) ||
      !verifiedBundleBytes.equals(bundleSource.bytes)
    ) {
      throw new Error("candidate receipt or Sigstore bundle changed during verification");
    }
    await assertPinnedGitHubCliExecutable(
      githubCliPath,
      githubCliIdentity,
      "post-spawn verification",
    );

    let receipt;
    try {
      receipt = JSON.parse(verifiedReceiptBytes.toString("utf8"));
    } catch (error) {
      throw new Error(`invalid authenticated candidate receipt JSON: ${error.message}`);
    }
    if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
      throw new Error("authenticated candidate receipt must contain a JSON object");
    }
    validateCheckpointReceipt({
      evidenceSha256: state.verification.evidenceSha256,
      lane: identity.lane,
      receipt,
      sha: identity.sha,
      step: "candidate-build-complete",
      version: identity.version,
    });
    return {
      authentication: {
        type: "github-attestation",
        repository: REPOSITORY,
        signerWorkflow: `${REPOSITORY}/.github/workflows/release-runtime.yml`,
        signerDigest: identity.sha,
        sourceDigest: identity.sha,
        sourceRef: "refs/heads/main",
        githubCliPlatform: githubCliIdentity.platform,
        githubCliArch: githubCliIdentity.arch,
        githubCliTarget: githubCliIdentity.target,
        githubCliVersion: githubCliIdentity.version,
        githubCliExecutableBytes: githubCliIdentity.executableBytes,
        githubCliExecutableSha256: githubCliIdentity.executableSha256,
        receiptBytes: verifiedReceiptBytes.length,
        receiptSha256: sha256Bytes(verifiedReceiptBytes),
        bundleBytes: verifiedBundleBytes.length,
        bundleSha256: sha256Bytes(verifiedBundleBytes),
      },
      receipt,
    };
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
}

function requireExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const observed = Object.keys(value).sort();
  const required = [...expected].sort();
  if (canonicalJson(observed) !== canonicalJson(required)) {
    throw new Error(
      `${label} keys were ${JSON.stringify(observed)}, expected ${JSON.stringify(required)}`,
    );
  }
}

function candidateEscrowReceiptFromRelease(
  release,
  candidateCheckpoint,
  version,
) {
  const runId = candidateCheckpoint.receipt.runId;
  const tag = `agenc-candidate-v${version}-run-${runId}`;
  if (
    release === null ||
    typeof release !== "object" ||
    Array.isArray(release) ||
    release.tag_name !== tag ||
    release.html_url !==
      `https://github.com/${CANDIDATE_ESCROW_REPOSITORY}/releases/tag/${tag}` ||
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    release.immutable !== true ||
    release.draft !== false ||
    release.prerelease !== true ||
    !Array.isArray(release.assets)
  ) {
    throw new Error(
      "candidate escrow API did not return the exact immutable prerelease",
    );
  }
  const assets = {};
  for (const asset of release.assets) {
    const name = asset?.name;
    const expectedUrl =
      `https://github.com/${CANDIDATE_ESCROW_REPOSITORY}/releases/download/` +
      `${tag}/${name}`;
    const digest = typeof asset?.digest === "string"
      ? /^sha256:([0-9a-f]{64})$/u.exec(asset.digest)?.[1]
      : undefined;
    if (
      typeof name !== "string" ||
      Object.hasOwn(assets, name) ||
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      digest === undefined ||
      asset.state !== "uploaded" ||
      asset.browser_download_url !== expectedUrl
    ) {
      throw new Error(
        `candidate escrow API asset identity is invalid for ${String(name)}`,
      );
    }
    assets[name] = {
      assetId: asset.id,
      bytes: asset.size,
      sha256: digest,
    };
  }
  return {
    schemaVersion: 1,
    repository: CANDIDATE_ESCROW_REPOSITORY,
    tag,
    url: release.html_url,
    runId,
    releaseId: release.id,
    immutable: release.immutable,
    draft: release.draft,
    prerelease: release.prerelease,
    assets,
  };
}

async function authenticatedCandidateEscrow(identity, state, options, paths) {
  if (
    options["receipt-json"] !== undefined ||
    options["receipt-file"] !== undefined ||
    options["receipt-bundle"] !== undefined
  ) {
    throw new Error(
      "candidate-escrow-published does not accept operator-supplied receipts; " +
        "use --github-cli with an explicit GH_TOKEN",
    );
  }
  const candidateCheckpoint =
    state.checkpoints["candidate-build-complete"];
  validateCheckpointReceipt({
    evidenceSha256: state.verification.evidenceSha256,
    lane: identity.lane,
    receipt: candidateCheckpoint?.receipt,
    sha: identity.sha,
    step: "candidate-build-complete",
    version: identity.version,
  });
  const githubToken = process.env.GH_TOKEN;
  if (
    typeof githubToken !== "string" ||
    githubToken.length === 0 ||
    /[\0\r\n]/u.test(githubToken)
  ) {
    throw new Error(
      "candidate-escrow-published requires an explicit non-empty GH_TOKEN",
    );
  }
  const githubCliPath = options["github-cli"];
  if (typeof githubCliPath !== "string" || !isAbsolute(githubCliPath)) {
    throw new Error(
      "candidate escrow checkpoint requires an absolute checksum-pinned GitHub CLI path",
    );
  }
  const githubCliIdentity = pinnedGitHubCliIdentity();
  await assertPinnedGitHubCliExecutable(
    githubCliPath,
    githubCliIdentity,
    "candidate escrow pre-spawn verification",
  );
  const workDirectory = mkdtempSync(join(paths.directory, ".candidate-escrow-"));
  chmodSync(workDirectory, 0o700);
  try {
    const environment = {
      ...isolatedGitHubCliEnvironment(workDirectory),
      GH_TOKEN: githubToken,
    };
    mkdirSync(join(workDirectory, "gh-config"), { mode: 0o700 });
    const versionResult = runGitHubCli(
      githubCliPath,
      ["--version"],
      environment,
      "candidate escrow version verification",
    );
    if (versionResult.status !== 0) {
      throw new Error(
        "checksum-pinned GitHub CLI version verification failed for candidate escrow",
      );
    }
    const versionMatch = /^gh version (\d+\.\d+\.\d+)(?:\s|$)/u.exec(
      versionResult.stdout.trim(),
    );
    if (versionMatch?.[1] !== githubCliIdentity.version) {
      throw new Error(
        `GitHub CLI version ${versionMatch?.[1] ?? "unknown"} does not match ` +
          `release-toolchain.json pin ${githubCliIdentity.version}`,
      );
    }
    const runId = candidateCheckpoint.receipt.runId;
    const candidateTag =
      `agenc-candidate-v${identity.version}-run-${runId}`;
    const verifyResult = runGitHubCli(
      githubCliPath,
      [
        "release",
        "verify",
        candidateTag,
        "--repo",
        CANDIDATE_ESCROW_REPOSITORY,
      ],
      environment,
      "candidate escrow immutable release verification",
    );
    if (verifyResult.status !== 0) {
      throw new Error(
        `GitHub immutable release verification rejected ${candidateTag}: ` +
          `${verifyResult.stderr.trim() || verifyResult.stdout.trim() || "unknown error"}`,
      );
    }
    const apiVersion = "2026-03-10";
    const apiResult = runGitHubCli(
      githubCliPath,
      [
        "api",
        "--method",
        "GET",
        `repos/${CANDIDATE_ESCROW_REPOSITORY}/releases/tags/${candidateTag}`,
        "--header",
        "Accept: application/vnd.github+json",
        "--header",
        `X-GitHub-Api-Version: ${apiVersion}`,
      ],
      environment,
      "candidate escrow release API readback",
    );
    if (apiResult.status !== 0) {
      throw new Error(
        `candidate escrow API readback failed for ${candidateTag}: ` +
          `${apiResult.stderr.trim() || apiResult.stdout.trim() || "unknown error"}`,
      );
    }
    if (
      Buffer.byteLength(apiResult.stdout, "utf8") <= 0 ||
      Buffer.byteLength(apiResult.stdout, "utf8") >
        MAX_CANDIDATE_ATTESTATION_BYTES
    ) {
      throw new Error("candidate escrow API response is outside the 4 MiB bound");
    }
    let release;
    try {
      release = JSON.parse(apiResult.stdout);
    } catch (error) {
      throw new Error(`candidate escrow API returned invalid JSON: ${error.message}`);
    }
    const receipt = candidateEscrowReceiptFromRelease(
      release,
      candidateCheckpoint,
      identity.version,
    );
    validateCheckpointReceipt({
      candidateCheckpoint,
      evidenceSha256: state.verification.evidenceSha256,
      lane: identity.lane,
      receipt,
      sha: identity.sha,
      step: "candidate-escrow-published",
      version: identity.version,
    });
    await assertPinnedGitHubCliExecutable(
      githubCliPath,
      githubCliIdentity,
      "candidate escrow post-spawn verification",
    );
    return {
      authentication: {
        type: "github-immutable-release",
        repository: CANDIDATE_ESCROW_REPOSITORY,
        tag: candidateTag,
        apiVersion,
        githubCliPlatform: githubCliIdentity.platform,
        githubCliArch: githubCliIdentity.arch,
        githubCliTarget: githubCliIdentity.target,
        githubCliVersion: githubCliIdentity.version,
        githubCliExecutableBytes: githubCliIdentity.executableBytes,
        githubCliExecutableSha256: githubCliIdentity.executableSha256,
      },
      receipt,
    };
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
}

export function validateCheckpointReceipt({
  candidateCheckpoint,
  evidenceSha256,
  lane,
  receipt,
  sha,
  step,
  version,
}) {
  if (step === "candidate-escrow-published") {
    if (lane !== "full") {
      throw new Error(
        "candidate-escrow-published is valid only for the full release lane",
      );
    }
    const candidateReceipt = candidateCheckpoint?.receipt;
    const authentication = candidateCheckpoint?.authentication;
    validateCheckpointReceipt({
      evidenceSha256,
      lane,
      receipt: candidateReceipt,
      sha,
      step: "candidate-build-complete",
      version,
    });
    if (
      authentication?.type !== "github-attestation" ||
      !Number.isSafeInteger(authentication.receiptBytes) ||
      authentication.receiptBytes <= 0 ||
      !HASH_RE.test(authentication.receiptSha256 ?? "") ||
      !Number.isSafeInteger(authentication.bundleBytes) ||
      authentication.bundleBytes <= 0 ||
      !HASH_RE.test(authentication.bundleSha256 ?? "")
    ) {
      throw new Error(
        "candidate-escrow-published requires the authenticated seal byte identity",
      );
    }
    const runId = candidateReceipt.runId;
    const candidateTag = `agenc-candidate-v${version}-run-${runId}`;
    requireExactKeys(
      receipt,
      [
        "assets",
        "draft",
        "immutable",
        "prerelease",
        "releaseId",
        "repository",
        "runId",
        "schemaVersion",
        "tag",
        "url",
      ],
      "candidate-escrow-published receipt",
    );
    if (
      receipt.schemaVersion !== 1 ||
      receipt.repository !== CANDIDATE_ESCROW_REPOSITORY ||
      receipt.tag !== candidateTag ||
      receipt.url !==
        `https://github.com/${CANDIDATE_ESCROW_REPOSITORY}/releases/tag/${candidateTag}` ||
      receipt.runId !== runId ||
      !Number.isSafeInteger(receipt.releaseId) ||
      receipt.releaseId <= 0 ||
      receipt.immutable !== true ||
      receipt.draft !== false ||
      receipt.prerelease !== true
    ) {
      throw new Error(
        "candidate-escrow-published receipt is not the exact immutable prerelease",
      );
    }
    const expectedAssets = {
      "agenc-runtime-candidate-seal.json": {
        bytes: authentication.receiptBytes,
        sha256: authentication.receiptSha256,
      },
      "agenc-runtime-candidate-seal.json.sigstore.json": {
        bytes: authentication.bundleBytes,
        sha256: authentication.bundleSha256,
      },
    };
    for (const slug of CANDIDATE_ARTIFACT_SLUGS) {
      const artifact = candidateReceipt.artifacts[`agenc-runtime-${slug}`];
      expectedAssets[artifact.archive] = {
        bytes: artifact.archiveBytes,
        sha256: artifact.archiveSha256,
      };
      expectedAssets[`${artifact.archive}.meta.json`] = {
        bytes: artifact.metadataBytes,
        sha256: artifact.metadataSha256,
      };
      expectedAssets[`${artifact.archive}.sigstore.json`] = {
        bytes: artifact.candidateBundleBytes,
        sha256: artifact.candidateBundleSha256,
      };
    }
    requireExactKeys(
      receipt.assets,
      Object.keys(expectedAssets),
      "candidate escrow asset inventory",
    );
    for (const [name, expected] of Object.entries(expectedAssets)) {
      const asset = receipt.assets[name];
      requireExactKeys(
        asset,
        ["assetId", "bytes", "sha256"],
        `candidate escrow asset ${name}`,
      );
      if (
        !Number.isSafeInteger(asset.assetId) ||
        asset.assetId <= 0 ||
        asset.bytes !== expected.bytes ||
        asset.sha256 !== expected.sha256
      ) {
        throw new Error(
          `candidate escrow asset identity does not match the authenticated candidate: ${name}`,
        );
      }
    }
    return receipt;
  }
  if (step !== "candidate-build-complete") return receipt;
  if (lane !== "full") {
    throw new Error("candidate-build-complete is valid only for the full release lane");
  }
  requireExactKeys(
    receipt,
    [
      "artifacts",
      "evidenceSha256",
      "phase",
      "runAttempt",
      "runId",
      "runUrl",
      "schemaVersion",
      "sha",
      "successfulJobs",
      "workflow",
    ],
    "candidate-build-complete receipt",
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.workflow !== "release-runtime.yml" ||
    receipt.phase !== "candidate" ||
    !Number.isSafeInteger(receipt.runId) ||
    receipt.runId <= 0 ||
    !Number.isSafeInteger(receipt.runAttempt) ||
    receipt.runAttempt <= 0 ||
    receipt.runUrl !==
      `https://github.com/${REPOSITORY}/actions/runs/${receipt.runId}` ||
    !SHA_RE.test(sha ?? "") ||
    !HASH_RE.test(evidenceSha256 ?? "") ||
    receipt.sha !== sha ||
    receipt.evidenceSha256 !== evidenceSha256 ||
    !HASH_RE.test(receipt.evidenceSha256 ?? "")
  ) {
    throw new Error(
      "candidate-build-complete receipt identity does not match the exact verified release",
    );
  }
  const successfulJobs = Array.isArray(receipt.successfulJobs)
    ? receipt.successfulJobs
    : [];
  if (
    successfulJobs.some((name) => typeof name !== "string") ||
    new Set(successfulJobs).size !== successfulJobs.length ||
    canonicalJson([...successfulJobs].sort()) !==
      canonicalJson([...CANDIDATE_SUCCESSFUL_JOBS].sort())
  ) {
    throw new Error(
      "candidate-build-complete receipt must contain the exact ten successful jobs",
    );
  }
  const expectedArtifactNames = CANDIDATE_ARTIFACT_SLUGS.map(
    (slug) => `agenc-runtime-${slug}`,
  );
  requireExactKeys(
    receipt.artifacts,
    expectedArtifactNames,
    "candidate-build-complete artifact inventory",
  );
  for (const slug of CANDIDATE_ARTIFACT_SLUGS) {
    const name = `agenc-runtime-${slug}`;
    const artifact = receipt.artifacts[name];
    requireExactKeys(
      artifact,
      [
        "archive",
        "archiveBytes",
        "archiveSha256",
        "candidateBundleBytes",
        "candidateBundleSha256",
        "metadataBytes",
        "metadataSha256",
      ],
      `candidate-build-complete artifact ${name}`,
    );
    if (
      artifact.archive !==
        `agenc-runtime-${version}-${slug}-node26-abi147.tar.gz` ||
      !Number.isSafeInteger(artifact.archiveBytes) ||
      artifact.archiveBytes <= 0 ||
      !HASH_RE.test(artifact.archiveSha256 ?? "") ||
      !Number.isSafeInteger(artifact.metadataBytes) ||
      artifact.metadataBytes <= 0 ||
      !HASH_RE.test(artifact.metadataSha256 ?? "") ||
      !Number.isSafeInteger(artifact.candidateBundleBytes) ||
      artifact.candidateBundleBytes <= 0 ||
      !HASH_RE.test(artifact.candidateBundleSha256 ?? "")
    ) {
      throw new Error(
        `candidate-build-complete artifact identity is invalid for ${name}`,
      );
    }
  }
  return receipt;
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
    let authentication = null;
    let receipt;
    if (step === "candidate-build-complete") {
      ({ authentication, receipt } = await authenticatedCandidateReceipt(
        identity,
        state,
        options,
        paths,
      ));
    } else if (step === "candidate-escrow-published") {
      ({ authentication, receipt } = await authenticatedCandidateEscrow(
        identity,
        state,
        options,
        paths,
      ));
    } else {
      if (
        options["receipt-file"] !== undefined ||
        options["receipt-bundle"] !== undefined ||
        options["github-cli"] !== undefined
      ) {
        throw new Error(
          `${step} accepts --receipt-json, not candidate attestation options`,
        );
      }
      receipt = parseReceipt(options["receipt-json"]);
      validateCheckpointReceipt({
        candidateCheckpoint:
          state.checkpoints["candidate-build-complete"],
        evidenceSha256: state.verification.evidenceSha256,
        lane: identity.lane,
        receipt,
        sha: identity.sha,
        step,
        version: identity.version,
      });
    }
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
      if (
        canonicalJson(existing.receipt) !== canonicalJson(receipt) ||
        canonicalJson(existing.authentication ?? null) !==
          canonicalJson(authentication)
      ) {
        throw new Error(`checkpoint ${step} already has a different immutable receipt`);
      }
      if (step === "converged") await compactCompletedLogs(state, paths);
      return { resumed: true, state, paths };
    }
    state.checkpoints[step] = {
      recordedAt: new Date().toISOString(),
      receipt,
      ...(authentication === null ? {} : { authentication }),
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
