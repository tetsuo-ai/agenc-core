import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_PRODUCTION_MODULES_PER_CASE } from "./contract.mjs";
import { readBoundedRegularFile } from "./bounded-file.mjs";
import { formatBoundedDiagnostic } from "./diagnostic.mjs";

export const BOUNDED_COMMAND_TIMEOUT_MS = 5_000;
export const MAX_BOUND_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_BOUND_FILE_BYTES = 2_097_152;
export const MAX_BOUND_COMMAND_OUTPUT_BYTES = 4_194_304;
export const MAX_BOUND_COMMAND_ARGUMENTS = 256;
export const MAX_BOUND_COMMAND_ARGUMENT_BYTES = 65_536;
export const TEXT_BINDING_NORMALIZATION = "utf8_lf";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const CASE_ID_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/u;
const METADATA_COMMAND_WORKER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "metadata-command-worker.mjs",
);
export const METADATA_COMMAND_SETTLEMENT_TIMEOUT_MS = 2_000;
export const METADATA_COMMAND_WORKER_OVERHEAD_MS = 2_000;
const METADATA_COMMAND_RESPONSE_OVERHEAD_BYTES = 65_536;
const MAX_WINDOWS_GIT_SEARCH_PATH_BYTES = 131_072;
const MAX_WINDOWS_GIT_SEARCH_PATH_ENTRIES = 512;
const MAX_WINDOWS_GIT_SEARCH_PATH_ENTRY_BYTES = 32_768;
const WINDOWS_GIT_EXECUTABLE_NAMES = Object.freeze(["git.com", "git.exe"]);
const WINDOWS_SEARCH_PATH_SEPARATOR = ";";
const WINDOWS_SEARCH_PATH_QUOTES = Object.freeze(['"', "'"]);

export function captureBenchmarkProvenance(options) {
  const validated = validateProvenanceOptions(options);
  const captureHeadRevision = gitText(
    validated.repositoryRoot,
    ["rev-parse", "HEAD"],
    "resolve benchmark capture HEAD",
  );
  assertGitRevision(captureHeadRevision);
  const sourceRevision = gitText(
    validated.repositoryRoot,
    [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${validated.sourceRevisionSelector}^{commit}`,
    ],
    "resolve benchmark source revision",
  );
  assertGitRevision(sourceRevision);
  assertRevisionIsCommit(validated.repositoryRoot, sourceRevision);
  assertRevisionIsAncestor(validated.repositoryRoot, sourceRevision);
  assertProductionTreeMatchesRevision(
    validated.repositoryRoot,
    sourceRevision,
    validated.productionTreePath,
  );
  const productionTreeBinding = collectGitTreeBinding(
    validated.repositoryRoot,
    sourceRevision,
    validated.productionTreePath,
  );
  const evidenceBindings = collectNormalizedFileBindings(
    validated.repositoryRoot,
    validated.evidencePaths,
  );

  return Object.freeze({
    captureHeadRevision,
    evidenceBindings,
    evidencePaths: validated.evidencePaths,
    productionTreeBinding,
    productionTreePath: validated.productionTreePath,
    repositoryRoot: validated.repositoryRoot,
    sourceRevision,
  });
}

export function bindProductionModuleClosures(provenance, observedClosures) {
  const normalizedClosures = normalizeObservedModuleClosures(
    observedClosures,
    provenance.productionTreePath,
  );
  return normalizedClosures.map(({ caseId, paths }) => {
    assertTrackedPathsMatchRevision(
      provenance.repositoryRoot,
      provenance.sourceRevision,
      paths,
    );
    const modules = collectGitBlobBindings(
      provenance.repositoryRoot,
      provenance.sourceRevision,
      paths,
    );
    assertPathDigestsEqual(
      modules,
      collectNormalizedFileBindings(provenance.repositoryRoot, paths),
      `production module closure for ${caseId} does not match its Git revision`,
    );
    return { caseId, modules };
  });
}

export function verifyBenchmarkCapture(provenance) {
  const currentRevision = gitText(
    provenance.repositoryRoot,
    ["rev-parse", "HEAD"],
    "recheck benchmark source revision",
  );
  if (currentRevision !== provenance.captureHeadRevision) {
    throw new Error("Git revision changed while the benchmark was running");
  }
  assertProductionTreeMatchesRevision(
    provenance.repositoryRoot,
    provenance.sourceRevision,
    provenance.productionTreePath,
  );
  assertBindingsEqual(
    provenance.productionTreeBinding,
    collectGitTreeBinding(
      provenance.repositoryRoot,
      provenance.sourceRevision,
      provenance.productionTreePath,
    ),
    "production Git tree binding changed during capture",
  );
  assertBindingsEqual(
    provenance.evidenceBindings,
    collectNormalizedFileBindings(
      provenance.repositoryRoot,
      provenance.evidencePaths,
    ),
    "benchmark evidence files changed during capture",
  );
}

export function verifyCheckedBenchmarkProvenance(report, options) {
  const validated = validateProvenanceOptions(options);
  assertGitRevision(report.sourceRevision);
  assertRevisionIsCommit(validated.repositoryRoot, report.sourceRevision);
  assertRevisionIsAncestor(validated.repositoryRoot, report.sourceRevision);
  assertBindingsEqual(
    report.productionTreeBinding,
    collectGitTreeBinding(
      validated.repositoryRoot,
      report.sourceRevision,
      validated.productionTreePath,
    ),
    "production tree binding does not match its Git revision",
  );
  const moduleClosures = normalizeBoundModuleClosures(
    report.productionModuleClosures,
    validated.productionTreePath,
  );
  for (const closure of moduleClosures) {
    const paths = closure.modules.map((binding) => binding.path);
    assertBindingsEqual(
      closure.modules,
      collectGitBlobBindings(
        validated.repositoryRoot,
        report.sourceRevision,
        paths,
      ),
      `production module closure for ${closure.caseId} does not match its Git revision`,
    );
    assertPathDigestsEqual(
      closure.modules,
      collectNormalizedFileBindings(validated.repositoryRoot, paths),
      `current production module closure for ${closure.caseId} is stale`,
    );
  }
  assertBindingsEqual(
    report.evidenceBindings,
    collectNormalizedFileBindings(
      validated.repositoryRoot,
      validated.evidencePaths,
    ),
    "benchmark evidence bindings are stale",
  );
}

export function collectNormalizedFileBindings(repositoryRoot, paths) {
  const canonicalRepositoryRoot = canonicalizeRepositoryRoot(repositoryRoot);
  return normalizePaths(paths).map((path) => ({
    normalization: TEXT_BINDING_NORMALIZATION,
    path,
    sha256: sha256Hex(readNormalizedTextFile(canonicalRepositoryRoot, path)),
  }));
}

export function assertBindingsStable(
  repositoryRoot,
  expectedBindings,
  label = "bounded file bindings changed",
) {
  const paths = expectedBindings.map((binding) => binding.path);
  assertBindingsEqual(
    expectedBindings,
    collectNormalizedFileBindings(repositoryRoot, paths),
    label,
  );
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   label?: string,
 *   maxOutputBytes?: number,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {string}
 */
export function runBoundedCommandText(
  command,
  args,
  {
    cwd,
    env = createBenchmarkSubprocessEnvironment(),
    label = "bounded command",
    maxOutputBytes = MAX_BOUND_COMMAND_OUTPUT_BYTES,
    timeoutMs = BOUNDED_COMMAND_TIMEOUT_MS,
  } = {},
) {
  validateCommand(command, args, cwd, maxOutputBytes, timeoutMs);
  try {
    const result = runBoundedCommandResult(command, args, {
      cwd,
      env,
      maxOutputBytes,
      timeoutMs,
    });
    if (result.exitCode !== 0 || result.signal !== null) {
      const diagnostic = formatBoundedDiagnostic(result.stderr);
      throw new Error(
        `bounded command exited with ${String(result.exitCode)} / ${String(result.signal)}` +
          (diagnostic.length > 0 ? `: ${diagnostic}` : ""),
      );
    }
    return result.stdout.toString("utf8").trim();
  } catch (error) {
    throw new Error(
      `${label} failed or exceeded its ${timeoutMs} ms deadline`,
      {
        cause: error,
      },
    );
  }
}

/** @returns {Record<string, string>} */
export function createSanitizedGitEnvironment(environment = process.env) {
  const sanitized = {
    ...createBenchmarkSubprocessEnvironment(environment),
  };
  sanitized.GIT_CONFIG_GLOBAL =
    process.platform === "win32" ? "NUL" : "/dev/null";
  sanitized.GIT_CONFIG_NOSYSTEM = "1";
  sanitized.GIT_NO_REPLACE_OBJECTS = "1";
  return sanitized;
}

/** @returns {Record<string, string>} */
export function createBenchmarkSubprocessEnvironment(
  environment = process.env,
  platform = process.platform,
) {
  if (
    environment === null ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  ) {
    throw new Error("benchmark subprocess environment must be an object");
  }
  const path = platformEnvironmentValue(environment, "PATH", platform);
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("benchmark subprocess environment requires PATH");
  }
  const sanitized = {
    LANG: "C",
    LC_ALL: "C",
    PATH: path,
    TZ: "UTC",
  };
  if (platform === "win32") {
    const systemRoot = platformEnvironmentValue(
      environment,
      "SystemRoot",
      platform,
    );
    if (typeof systemRoot !== "string" || systemRoot.length === 0) {
      throw new Error("Windows benchmark subprocesses require SystemRoot");
    }
    sanitized.SystemRoot = systemRoot;
  }
  return sanitized;
}

export function resolveBenchmarkGitExecutable(
  environment = process.env,
  platform = process.platform,
) {
  if (platform !== "win32") return "git";
  const searchPath = platformEnvironmentValue(environment, "PATH", platform);
  const directories = parseBoundedWindowsSearchPath(searchPath);
  for (const directory of directories) {
    for (const executableName of WINDOWS_GIT_EXECUTABLE_NAMES) {
      const candidate = resolve(directory, executableName);
      try {
        const metadata = lstatSync(candidate);
        if (metadata.isSymbolicLink() || !metadata.isFile()) continue;
        const canonicalPath = realpathSync(candidate);
        const canonicalMetadata = lstatSync(canonicalPath);
        if (canonicalMetadata.isSymbolicLink() || !canonicalMetadata.isFile()) {
          continue;
        }
        return canonicalPath;
      } catch {
        // A missing or unreadable PATH candidate is not executable.
      }
    }
  }
  throw new Error("could not resolve a regular Git executable from PATH");
}

export function resolveBenchmarkNpmCliPath(executablePath = process.execPath) {
  const executableDirectory = dirname(realpathSync(executablePath));
  const candidates = [
    {
      installationRoot: executableDirectory,
      path: resolve(executableDirectory, "node_modules/npm/bin/npm-cli.js"),
    },
    {
      installationRoot: resolve(executableDirectory, ".."),
      path: resolve(
        executableDirectory,
        "../lib/node_modules/npm/bin/npm-cli.js",
      ),
    },
  ];
  for (const candidate of candidates) {
    try {
      const metadata = lstatSync(candidate.path);
      const canonicalPath = realpathSync(candidate.path);
      if (
        metadata.isFile() &&
        !metadata.isSymbolicLink() &&
        isContainedPath(candidate.installationRoot, canonicalPath)
      ) {
        return canonicalPath;
      }
    } catch {
      // Continue through the finite trusted-layout candidates.
    }
  }
  throw new Error("could not resolve the pinned npm CLI entrypoint");
}

function isContainedPath(root, path) {
  const relativePath = relative(root, path);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    ) &&
    !isAbsolute(relativePath)
  );
}

function parseBoundedWindowsSearchPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_WINDOWS_GIT_SEARCH_PATH_BYTES
  ) {
    throw new Error("Windows Git PATH is malformed or exceeds its byte limit");
  }
  const entries = [];
  let cursor = 0;
  while (cursor < value.length) {
    if (value[cursor] === WINDOWS_SEARCH_PATH_SEPARATOR) {
      cursor += 1;
      continue;
    }
    const openingQuote = WINDOWS_SEARCH_PATH_QUOTES.includes(value[cursor])
      ? value[cursor]
      : undefined;
    let end;
    if (openingQuote === undefined) {
      end = value.indexOf(WINDOWS_SEARCH_PATH_SEPARATOR, cursor);
    } else {
      const closingQuote = value.indexOf(openingQuote, cursor + 1);
      if (closingQuote < 0) {
        throw new Error("Windows Git PATH contains an unmatched quote");
      }
      end = value.indexOf(WINDOWS_SEARCH_PATH_SEPARATOR, closingQuote + 1);
    }
    if (end < 0) end = value.length;
    let entry = value.slice(cursor, end);
    if (openingQuote !== undefined) {
      if (!entry.endsWith(openingQuote)) {
        throw new Error("Windows Git PATH contains trailing quoted content");
      }
      entry = entry.slice(1, -1);
    } else if (WINDOWS_SEARCH_PATH_QUOTES.includes(entry.at(-1))) {
      throw new Error("Windows Git PATH contains an unmatched quote");
    }
    if (
      Buffer.byteLength(entry, "utf8") > MAX_WINDOWS_GIT_SEARCH_PATH_ENTRY_BYTES
    ) {
      throw new Error("Windows Git PATH entry exceeds its byte limit");
    }
    if (entry.length > 0) entries.push(entry);
    if (entries.length > MAX_WINDOWS_GIT_SEARCH_PATH_ENTRIES) {
      throw new Error("Windows Git PATH has too many entries");
    }
    cursor = end + 1;
  }
  if (entries.length === 0) {
    throw new Error("Windows Git PATH has no search directories");
  }
  return entries;
}

function runBoundedCommandResult(
  command,
  args,
  {
    cwd,
    env = createBenchmarkSubprocessEnvironment(),
    maxOutputBytes = MAX_BOUND_COMMAND_OUTPUT_BYTES,
    timeoutMs = BOUNDED_COMMAND_TIMEOUT_MS,
  },
) {
  validateCommand(command, args, cwd, maxOutputBytes, timeoutMs);
  const helperEnvironment = createBenchmarkSubprocessEnvironment();
  const request = JSON.stringify({
    args,
    command,
    cwd,
    env,
    maxOutputBytes,
    settlementTimeoutMs: METADATA_COMMAND_SETTLEMENT_TIMEOUT_MS,
    timeoutMs,
  });
  const maximumResponseBytes =
    Math.ceil((maxOutputBytes * 4) / 3) +
    METADATA_COMMAND_RESPONSE_OVERHEAD_BYTES;
  const responseText = execFileSync(
    process.execPath,
    [METADATA_COMMAND_WORKER_PATH],
    {
      cwd,
      encoding: "utf8",
      env: helperEnvironment,
      input: request,
      killSignal: "SIGKILL",
      maxBuffer: maximumResponseBytes,
      timeout:
        timeoutMs +
        METADATA_COMMAND_SETTLEMENT_TIMEOUT_MS +
        METADATA_COMMAND_WORKER_OVERHEAD_MS,
      windowsHide: true,
    },
  );
  let response;
  try {
    response = JSON.parse(responseText);
  } catch (error) {
    throw new Error("bounded metadata command returned malformed JSON", {
      cause: error,
    });
  }
  validateMetadataCommandResponse(response);
  if (response.backstopExpired) {
    throw new Error("bounded metadata command containment was not proven");
  }
  if (typeof response.error === "string" && response.error.length > 0) {
    throw new Error(`bounded metadata command failed: ${response.error}`);
  }
  if (response.stopReason !== undefined) {
    throw new Error(
      `bounded metadata command stopped for ${String(response.stopReason)}`,
    );
  }
  const stdout = decodeCanonicalBase64(response.stdoutBase64, "stdout");
  const stderr = decodeCanonicalBase64(response.stderrBase64, "stderr");
  if (stdout.length + stderr.length > maxOutputBytes) {
    throw new Error("bounded metadata command exceeded its output ceiling");
  }
  return {
    exitCode: response.exitCode,
    signal: response.signal,
    stderr,
    stdout,
  };
}

function validateMetadataCommandResponse(response) {
  if (
    response === null ||
    typeof response !== "object" ||
    Array.isArray(response)
  ) {
    throw new Error("bounded metadata command returned an invalid result");
  }
  const allowedNames = new Set([
    "backstopExpired",
    "error",
    "exitCode",
    "signal",
    "stderrBase64",
    "stdoutBase64",
    "stopReason",
  ]);
  if (Object.keys(response).some((name) => !allowedNames.has(name))) {
    throw new Error("bounded metadata command result keys differ");
  }
  if (
    typeof response.backstopExpired !== "boolean" ||
    (!Number.isInteger(response.exitCode) && response.exitCode !== null) ||
    (response.signal !== null && typeof response.signal !== "string") ||
    typeof response.stdoutBase64 !== "string" ||
    typeof response.stderrBase64 !== "string" ||
    (response.error !== undefined && typeof response.error !== "string") ||
    (response.stopReason !== undefined &&
      typeof response.stopReason !== "string")
  ) {
    throw new Error("bounded metadata command returned an invalid result");
  }
}

function decodeCanonicalBase64(value, label) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error(
      `bounded metadata command ${label} is not canonical base64`,
    );
  }
  return bytes;
}

function platformEnvironmentValue(environment, expectedName, platform) {
  if (platform !== "win32") return environment[expectedName];
  const normalizedExpectedName = expectedName.toUpperCase();
  const matches = Object.entries(environment).filter(
    ([name]) => name.toUpperCase() === normalizedExpectedName,
  );
  if (matches.length > 1) {
    throw new Error(`benchmark subprocess environment repeats ${expectedName}`);
  }
  return matches[0]?.[1];
}

function collectGitBlobBindings(repositoryRoot, revision, paths) {
  return normalizePaths(paths).map((path) => ({
    path,
    sha256: sha256Hex(
      gitBuffer(
        repositoryRoot,
        ["show", `${revision}:${path}`],
        `read production source blob ${path}`,
      ),
    ),
  }));
}

function collectGitTreeBinding(repositoryRoot, revision, path) {
  const gitObjectId = gitText(
    repositoryRoot,
    ["rev-parse", `${revision}:${path}`],
    `resolve production tree object ${path}`,
  );
  assertGitRevision(gitObjectId);
  const objectType = gitText(
    repositoryRoot,
    ["cat-file", "-t", gitObjectId],
    `inspect production tree object ${path}`,
  );
  if (objectType !== "tree") {
    throw new Error(`bound production path is not a Git tree: ${path}`);
  }
  return { gitObjectId, objectType, path };
}

function assertRevisionIsCommit(repositoryRoot, revision) {
  const result = gitStatus(repositoryRoot, [
    "cat-file",
    "-e",
    `${revision}^{commit}`,
  ]);
  if (result !== 0) {
    throw new Error("benchmark source revision is not a local Git commit");
  }
}

function assertRevisionIsAncestor(repositoryRoot, revision) {
  const result = gitStatus(repositoryRoot, [
    "merge-base",
    "--is-ancestor",
    revision,
    "HEAD",
  ]);
  if (result !== 0) {
    throw new Error("benchmark source revision is not an ancestor of HEAD");
  }
}

function assertTrackedPathsMatchRevision(repositoryRoot, revision, paths) {
  const result = gitStatus(repositoryRoot, [
    "diff",
    "--no-ext-diff",
    "--quiet",
    revision,
    "--",
    ...normalizePaths(paths),
  ]);
  if (result === 1) {
    throw new Error(
      "production source differs from the bound benchmark revision",
    );
  }
  if (result !== 0) {
    throw new Error("could not compare production source with its revision");
  }
}

function assertProductionTreeMatchesRevision(repositoryRoot, revision, path) {
  const worktreeStatus = gitStatus(repositoryRoot, [
    "diff",
    "--no-ext-diff",
    "--quiet",
    revision,
    "--",
    path,
  ]);
  const indexStatus = gitStatus(repositoryRoot, [
    "diff",
    "--no-ext-diff",
    "--cached",
    "--quiet",
    revision,
    "--",
    path,
  ]);
  const indexToWorktreeStatus = gitStatus(repositoryRoot, [
    "diff-files",
    "--no-ext-diff",
    "--quiet",
    "--",
    path,
  ]);
  if (
    worktreeStatus === 1 ||
    indexStatus === 1 ||
    indexToWorktreeStatus === 1
  ) {
    throw new Error(
      "complete production tree must match the benchmark source revision",
    );
  }
  if (
    worktreeStatus !== 0 ||
    indexStatus !== 0 ||
    indexToWorktreeStatus !== 0
  ) {
    throw new Error("could not audit the complete production tree");
  }
  const untracked = gitText(
    repositoryRoot,
    ["ls-files", "--others", "--", path],
    "inventory untracked production files",
  );
  if (untracked.length > 0) {
    throw new Error("complete production tree contains untracked files");
  }
}

function gitText(repositoryRoot, args, label) {
  const environment = createSanitizedGitEnvironment();
  return runBoundedCommandText(
    resolveBenchmarkGitExecutable(environment),
    args,
    {
      cwd: repositoryRoot,
      env: environment,
      label,
      maxOutputBytes: 65_536,
    },
  );
}

function gitBuffer(repositoryRoot, args, label) {
  try {
    const environment = createSanitizedGitEnvironment();
    const result = runBoundedCommandResult(
      resolveBenchmarkGitExecutable(environment),
      args,
      {
        cwd: repositoryRoot,
        env: environment,
        maxOutputBytes: MAX_BOUND_COMMAND_OUTPUT_BYTES,
        timeoutMs: BOUNDED_COMMAND_TIMEOUT_MS,
      },
    );
    if (result.exitCode !== 0 || result.signal !== null) {
      throw new Error("bounded Git command exited unsuccessfully");
    }
    return result.stdout;
  } catch (error) {
    throw new Error(
      `${label} failed or exceeded its ${BOUNDED_COMMAND_TIMEOUT_MS} ms deadline`,
      { cause: error },
    );
  }
}

function gitStatus(repositoryRoot, args) {
  const environment = createSanitizedGitEnvironment();
  const result = runBoundedCommandResult(
    resolveBenchmarkGitExecutable(environment),
    args,
    {
      cwd: repositoryRoot,
      env: environment,
      maxOutputBytes: MAX_BOUND_COMMAND_OUTPUT_BYTES,
      timeoutMs: BOUNDED_COMMAND_TIMEOUT_MS,
    },
  );
  if (result.signal !== null) {
    throw new Error("bounded Git command ended by signal");
  }
  return result.exitCode;
}

function readNormalizedTextFile(repositoryRoot, path) {
  const absolutePath = join(repositoryRoot, path);
  const canonicalPathBefore = realpathSync(absolutePath);
  assertContainedEvidencePath(repositoryRoot, canonicalPathBefore, path);
  const bytes = readBoundedRegularFile(
    absolutePath,
    MAX_BOUND_FILE_BYTES,
    `bound evidence file ${path}`,
  );
  const canonicalPathAfter = realpathSync(absolutePath);
  assertContainedEvidencePath(repositoryRoot, canonicalPathAfter, path);
  if (canonicalPathAfter !== canonicalPathBefore) {
    throw new Error(`bound evidence file ${path} changed its canonical path`);
  }
  const text = UTF8_DECODER.decode(bytes);
  return text.replace(/\r\n?/gu, "\n");
}

function assertContainedEvidencePath(repositoryRoot, canonicalPath, path) {
  if (!isContainedPath(repositoryRoot, canonicalPath)) {
    throw new Error(`bound evidence file ${path} escapes the repository root`);
  }
}

function canonicalizeRepositoryRoot(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
    throw new Error("benchmark repository root must be a non-empty string");
  }
  return realpathSync(resolve(repositoryRoot));
}

function validateProvenanceOptions(options) {
  if (options === null || typeof options !== "object") {
    throw new Error("benchmark provenance options must be an object");
  }
  return {
    productionTreePath: normalizeProductionTreePath(options.productionTreePath),
    repositoryRoot: canonicalizeRepositoryRoot(options.repositoryRoot),
    sourceRevisionSelector: normalizeSourceRevisionSelector(
      options.sourceRevision,
    ),
    evidencePaths: normalizePaths(options.evidencePaths),
  };
}

function normalizeObservedModuleClosures(closures, productionTreePath) {
  if (!Array.isArray(closures) || closures.length === 0) {
    throw new Error("observed production module closures must be non-empty");
  }
  const seenCaseIds = new Set();
  return closures.map((closure, index) => {
    const closureLabel = `observed closure ${index}`;
    assertPlainRecord(closure, closureLabel);
    assertExactKeys(closure, ["caseId", "paths"], closureLabel);
    const caseId = normalizeCaseId(closure.caseId, closureLabel);
    if (seenCaseIds.has(caseId)) {
      throw new Error(`observed production module closure repeats ${caseId}`);
    }
    seenCaseIds.add(caseId);
    const paths = normalizePaths(closure.paths);
    assertProductionModulePaths(paths, productionTreePath, caseId);
    return { caseId, paths };
  });
}

function normalizeBoundModuleClosures(closures, productionTreePath) {
  if (!Array.isArray(closures) || closures.length === 0) {
    throw new Error("bound production module closures must be non-empty");
  }
  const seenCaseIds = new Set();
  return closures.map((closure, closureIndex) => {
    const closureLabel = `bound closure ${closureIndex}`;
    assertPlainRecord(closure, closureLabel);
    assertExactKeys(closure, ["caseId", "modules"], closureLabel);
    const caseId = normalizeCaseId(closure.caseId, closureLabel);
    if (seenCaseIds.has(caseId)) {
      throw new Error(`bound production module closure repeats ${caseId}`);
    }
    seenCaseIds.add(caseId);
    if (!Array.isArray(closure.modules) || closure.modules.length === 0) {
      throw new Error(`${closureLabel}.modules must be non-empty`);
    }
    if (closure.modules.length > MAX_PRODUCTION_MODULES_PER_CASE) {
      throw new Error(`${closureLabel}.modules exceeds its bounded size`);
    }
    const modules = closure.modules.map((binding, bindingIndex) => {
      const bindingLabel = `${closureLabel}.modules[${bindingIndex}]`;
      assertPlainRecord(binding, bindingLabel);
      assertExactKeys(binding, ["path", "sha256"], bindingLabel);
      if (
        typeof binding.sha256 !== "string" ||
        !SHA256_PATTERN.test(binding.sha256)
      ) {
        throw new Error(`${bindingLabel}.sha256 is invalid`);
      }
      return { path: binding.path, sha256: binding.sha256 };
    });
    const normalizedPaths = normalizePaths(
      modules.map((binding) => binding.path),
    );
    const originalPaths = modules.map((binding) => binding.path);
    if (JSON.stringify(normalizedPaths) !== JSON.stringify(originalPaths)) {
      throw new Error(`${closureLabel}.modules must be unique and path-sorted`);
    }
    assertProductionModulePaths(normalizedPaths, productionTreePath, caseId);
    return { caseId, modules };
  });
}

function normalizeCaseId(value, label) {
  if (typeof value !== "string" || !CASE_ID_PATTERN.test(value)) {
    throw new Error(`${label}.caseId is invalid`);
  }
  return value;
}

function assertProductionModulePaths(paths, productionTreePath, caseId) {
  if (paths.length > MAX_PRODUCTION_MODULES_PER_CASE) {
    throw new Error(
      `production module closure for ${caseId} exceeds its bounded size`,
    );
  }
  const prefix = `${productionTreePath}/`;
  if (
    paths.some(
      (path) =>
        !path.startsWith(prefix) ||
        path.includes("\\") ||
        path
          .split("/")
          .some(
            (segment) =>
              segment.length === 0 || segment === "." || segment === "..",
          ),
    )
  ) {
    throw new Error(
      `production module closure for ${caseId} escapes ${productionTreePath}`,
    );
  }
}

function normalizeSourceRevisionSelector(value) {
  const selector = value ?? "HEAD";
  if (
    typeof selector !== "string" ||
    selector.length === 0 ||
    Buffer.byteLength(selector) > 1_024 ||
    selector.includes("\0")
  ) {
    throw new Error("benchmark source revision selector is invalid");
  }
  return selector;
}

function normalizeProductionTreePath(path) {
  const normalized = normalizePaths([path])[0];
  if (normalized === undefined) {
    throw new Error("benchmark production tree path is required");
  }
  return normalized;
}

function normalizePaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("benchmark binding paths must be a non-empty array");
  }
  const normalized = paths.map((path) => {
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      isAbsolute(path) ||
      path.split(/[\\/]/u).some((segment) => segment === "..")
    ) {
      throw new Error("benchmark binding path must be repository-relative");
    }
    return path.replace(/\\/gu, "/");
  });
  const sorted = [...new Set(normalized)].sort();
  if (sorted.length !== normalized.length) {
    throw new Error("benchmark binding paths must be unique");
  }
  return sorted;
}

function validateCommand(command, args, cwd, maxOutputBytes, timeoutMs) {
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("bounded command must be non-empty");
  }
  if (
    !Array.isArray(args) ||
    args.length > MAX_BOUND_COMMAND_ARGUMENTS ||
    args.some(
      (argument) =>
        typeof argument !== "string" ||
        Buffer.byteLength(argument) > MAX_BOUND_COMMAND_ARGUMENT_BYTES,
    )
  ) {
    throw new Error("bounded command arguments exceed their named limits");
  }
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("bounded command cwd must be non-empty");
  }
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    maxOutputBytes > MAX_BOUND_COMMAND_OUTPUT_BYTES
  ) {
    throw new Error("bounded command output exceeds its named limit");
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_BOUND_COMMAND_TIMEOUT_MS
  ) {
    throw new Error("bounded command timeout exceeds its named limit");
  }
}

function assertGitRevision(revision) {
  if (!GIT_REVISION_PATTERN.test(revision)) {
    throw new Error("benchmark source revision must be a full Git object ID");
  }
}

function assertBindingsEqual(expected, actual, message) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(message);
  }
}

function assertPathDigestsEqual(expected, actual, message) {
  const expectedDigests = expected.map(({ path, sha256 }) => ({
    path,
    sha256,
  }));
  const actualDigests = actual.map(({ path, sha256 }) => ({ path, sha256 }));
  assertBindingsEqual(expectedDigests, actualDigests, message);
}

function assertPlainRecord(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(sortedExpectedKeys)) {
    throw new Error(`${label} keys differ`);
  }
}

function sha256Hex(value) {
  const digest = createHash("sha256").update(value).digest("hex");
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error("failed to produce a SHA-256 binding");
  }
  return digest;
}
