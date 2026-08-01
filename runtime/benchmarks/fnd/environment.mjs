import { resolve } from "node:path";

const FIXED_WORKER_ENVIRONMENT = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  TSX_DISABLE_CACHE: "1",
  TZ: "UTC",
});
const FIXED_WORKER_ENVIRONMENT_NAMES = Object.freeze(
  Object.keys(FIXED_WORKER_ENVIRONMENT),
);

const WINDOWS_SYSTEM_ROOT_NAME = "SystemRoot";
const WINDOWS_INJECTED_ENVIRONMENT_NAMES = Object.freeze([
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATH",
  "SYSTEMDRIVE",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);
const DARWIN_INJECTED_TEXT_ENCODING_NAME = "__CF_USER_TEXT_ENCODING";
const DARWIN_INJECTED_TEXT_ENCODING_PATTERN =
  /^0x[0-9A-Fa-f]{1,8}:(?:0x)?[0-9A-Fa-f]{1,8}:(?:0x)?[0-9A-Fa-f]{1,8}$/u;
const TEMPORARY_WORKER_ENVIRONMENT_NAMES = Object.freeze([
  "TEMP",
  "TMP",
  "TMPDIR",
]);

export function assertNoBenchmarkExecArguments(execArguments) {
  if (!Array.isArray(execArguments)) {
    throw new Error("benchmark Node execArgv must be an array");
  }
  if (
    execArguments.some(
      (argument) => typeof argument !== "string" || argument.length === 0,
    )
  ) {
    throw new Error("benchmark Node execArgv contains an invalid argument");
  }
  if (execArguments.length > 0) {
    throw new Error("benchmark runner requires empty Node execArgv");
  }
}

export function assertNoUnsafeBenchmarkEnvironment(environment) {
  assertEnvironmentRecord(environment);
  const unsafeNames = Object.keys(environment)
    .filter((name) => {
      const value = environment[name];
      if (value === undefined || value === "") return false;
      const normalizedName = name.toUpperCase();
      return (
        normalizedName.startsWith("NODE_") || normalizedName.startsWith("TSX_")
      );
    })
    .sort();
  if (unsafeNames.length > 0) {
    throw new Error(
      `unsafe benchmark Node or loader environment override: ${unsafeNames.join(", ")}`,
    );
  }
}

export function removeDarwinInjectedBenchmarkEnvironment(
  environment,
  platform = process.platform,
) {
  assertEnvironmentRecord(environment);
  if (platform !== "darwin") return;
  const value = environment[DARWIN_INJECTED_TEXT_ENCODING_NAME];
  if (value === undefined) return;
  if (
    typeof value !== "string" ||
    !DARWIN_INJECTED_TEXT_ENCODING_PATTERN.test(value)
  ) {
    throw new Error(
      `macOS injected an invalid ${DARWIN_INJECTED_TEXT_ENCODING_NAME} value`,
    );
  }
  if (!delete environment[DARWIN_INJECTED_TEXT_ENCODING_NAME]) {
    throw new Error(
      `benchmark worker could not remove ${DARWIN_INJECTED_TEXT_ENCODING_NAME}`,
    );
  }
}

export function removeWindowsInjectedBenchmarkEnvironment(
  environment,
  platform = process.platform,
) {
  assertEnvironmentRecord(environment);
  if (platform !== "win32") return;
  for (const expectedName of WINDOWS_INJECTED_ENVIRONMENT_NAMES) {
    const matchingName = Object.keys(environment).find(
      (name) =>
        normalizeEnvironmentName(name, platform) ===
        normalizeEnvironmentName(expectedName, platform),
    );
    if (matchingName === undefined) continue;
    if (!delete environment[matchingName]) {
      throw new Error(
        `benchmark worker could not remove Windows-injected ${matchingName}`,
      );
    }
  }
}

/** @returns {Readonly<Record<string, string>>} */
export function createBenchmarkWorkerEnvironment(
  environment,
  platform = process.platform,
  ownedTemporaryRoot,
) {
  assertNoUnsafeBenchmarkEnvironment(environment);
  const workerEnvironment = { ...FIXED_WORKER_ENVIRONMENT };
  const resolvedTemporaryRoot = resolveOwnedTemporaryRoot(ownedTemporaryRoot);
  for (const name of TEMPORARY_WORKER_ENVIRONMENT_NAMES) {
    workerEnvironment[name] = resolvedTemporaryRoot;
  }
  workerEnvironment.AGENC_HOME = resolvedTemporaryRoot;
  if (platform === "win32") {
    const systemRoot = getEnvironmentValue(
      environment,
      WINDOWS_SYSTEM_ROOT_NAME,
      platform,
    );
    if (typeof systemRoot !== "string" || systemRoot.length === 0) {
      throw new Error("Windows benchmark workers require SystemRoot");
    }
    workerEnvironment[WINDOWS_SYSTEM_ROOT_NAME] = systemRoot;
  }
  return Object.freeze(workerEnvironment);
}

export function assertBenchmarkWorkerEnvironment(
  environment,
  platform = process.platform,
  expectedOwnedTemporaryRoot,
) {
  assertEnvironmentRecord(environment);
  const resolvedTemporaryRoot = resolveOwnedTemporaryRoot(
    expectedOwnedTemporaryRoot,
  );
  const allowedNames = new Set(
    FIXED_WORKER_ENVIRONMENT_NAMES.map((name) =>
      normalizeEnvironmentName(name, platform),
    ),
  );
  allowedNames.add(normalizeEnvironmentName("AGENC_HOME", platform));
  for (const name of TEMPORARY_WORKER_ENVIRONMENT_NAMES) {
    allowedNames.add(normalizeEnvironmentName(name, platform));
  }
  if (platform === "win32") {
    allowedNames.add(
      normalizeEnvironmentName(WINDOWS_SYSTEM_ROOT_NAME, platform),
    );
  }
  const seenNames = new Set();
  for (const [name, value] of Object.entries(environment)) {
    if (platform === "win32" && /^=[A-Za-z]:$/u.test(name)) continue;
    const normalizedName = normalizeEnvironmentName(name, platform);
    if (seenNames.has(normalizedName)) {
      throw new Error(
        `benchmark worker environment repeats a case-insensitive name: ${name}`,
      );
    }
    seenNames.add(normalizedName);
    if (!allowedNames.has(normalizedName)) {
      throw new Error(
        `benchmark worker inherited unexpected environment: ${name}`,
      );
    }
    const fixedName = FIXED_WORKER_ENVIRONMENT_NAMES.find(
      (candidate) =>
        normalizeEnvironmentName(candidate, platform) === normalizedName,
    );
    if (fixedName !== undefined) {
      if (value !== FIXED_WORKER_ENVIRONMENT[fixedName]) {
        throw new Error(`benchmark worker environment differs for ${name}`);
      }
    } else if (typeof value !== "string" || value.length === 0) {
      throw new Error(`benchmark worker environment is empty for ${name}`);
    }
  }
  for (const [name, expected] of Object.entries(FIXED_WORKER_ENVIRONMENT)) {
    if (getEnvironmentValue(environment, name, platform) !== expected) {
      throw new Error(`benchmark worker environment is missing ${name}`);
    }
  }
  for (const name of ["AGENC_HOME", ...TEMPORARY_WORKER_ENVIRONMENT_NAMES]) {
    const value = getEnvironmentValue(environment, name, platform);
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      resolve(value) !== resolvedTemporaryRoot
    ) {
      throw new Error(
        `benchmark worker environment has an invalid owned root for ${name}`,
      );
    }
  }
  if (
    platform === "win32" &&
    getEnvironmentValue(environment, WINDOWS_SYSTEM_ROOT_NAME, platform) ===
      undefined
  ) {
    throw new Error("benchmark worker environment is missing SystemRoot");
  }
}

function getEnvironmentValue(environment, expectedName, platform) {
  const normalizedExpectedName = normalizeEnvironmentName(
    expectedName,
    platform,
  );
  const matchingEntries = Object.entries(environment).filter(
    ([name]) =>
      normalizeEnvironmentName(name, platform) === normalizedExpectedName,
  );
  if (matchingEntries.length > 1) {
    throw new Error(
      `benchmark environment repeats a case-insensitive name: ${expectedName}`,
    );
  }
  return matchingEntries[0]?.[1];
}

function normalizeEnvironmentName(name, platform) {
  return platform === "win32" ? name.toUpperCase() : name;
}

function resolveOwnedTemporaryRoot(ownedTemporaryRoot) {
  if (
    typeof ownedTemporaryRoot !== "string" ||
    ownedTemporaryRoot.length === 0
  ) {
    throw new Error("benchmark workers require an owned temporary root");
  }
  return resolve(ownedTemporaryRoot);
}

function assertEnvironmentRecord(environment) {
  if (
    environment === null ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  ) {
    throw new Error("benchmark environment must be an object");
  }
}
