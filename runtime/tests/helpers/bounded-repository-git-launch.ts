import { isAbsolute, join } from "node:path";
import { types as nodeUtilTypes } from "node:util";

import {
  isContainedGitPath,
  MAX_GIT_PATH_BYTES,
} from "./bounded-repository-git-discovery.js";
import { EMPTY_GIT_TEMPLATES_DIRECTORY } from "./bounded-repository-lifecycle.js";
import {
  assertExactKeys,
  MAX_CONFIGURED_GIT_WALL_MS,
  MAX_GIT_ARGUMENT_COUNT,
  snapshotDenseArray,
  snapshotPlainDataRecord,
} from "./bounded-repository-policy.js";
import { BoundedRepositoryError } from "./bounded-repository-types.js";
import { isWellFormedUnicode } from "./portable-repository-path.js";

const EMPTY_GIT_CONFIG = "gitconfig";
const DETERMINISTIC_GIT_TIMESTAMP = "2000-01-01T00:00:00Z";
const MINIMUM_POSITIVE_LIMIT = 1;
const GIT_INTERNAL_ARGUMENT_HEADROOM = 24;
const MAX_GIT_LAUNCH_ARGUMENT_COUNT =
  MAX_GIT_ARGUMENT_COUNT + GIT_INTERNAL_ARGUMENT_HEADROOM;
const MAX_FORWARDED_ENVIRONMENT_VALUE_BYTES = 32_768;
const MAX_GIT_ENVIRONMENT_UTF8_BYTES = 6_144;
const MAX_GIT_ENVIRONMENT_UTF16_CODE_UNITS = 6_144;
const MAX_GIT_ENVIRONMENT_ENTRY_COUNT = 64;
const WINDOWS_CREATE_PROCESS_TEXT_CODE_UNITS = 32_767;
const WINDOWS_JOB_PROGRAM_ENVIRONMENT_NAME = "AGENC_PROCESS_JOB_PROGRAM";
const WINDOWS_JOB_COMMAND_LINE_ENVIRONMENT_NAME =
  "AGENC_PROCESS_JOB_COMMAND_LINE";
const WINDOWS_JOB_OWNER_PID_ENVIRONMENT_NAME = "AGENC_PROCESS_JOB_OWNER_PID";
const FORWARDED_ENVIRONMENT_NAMES = Object.freeze([
  "ComSpec",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
] as const);
const HERMETIC_GIT_OPTION_KEYS = Object.freeze([
  "allocationRoot",
  "controlRoot",
  "hostEnvironment",
] as const);
const ALLOCATION_ROOT_ENVIRONMENT_MULTIPLICITY = 4;
const CONTROL_ROOT_ENVIRONMENT_MULTIPLICITY = 2;

export type BoundedGitProcessState = "cleanup_proven" | "survivors_unproven";

export type BoundedGitMutationOutcome =
  "committed" | "not_applicable" | "unknown";

export type BoundedGitFailureKind =
  | "deadline"
  | "discovery"
  | "exit"
  | "invalid_head"
  | "post_commit_verification"
  | "supervision"
  | "survivors_unproven";

export interface BoundedGitWallContract {
  readonly targetCommandDeadlineMs: number;
  readonly appliesPerGitCommand: true;
  readonly synchronousContainmentSetup: "supervisor_owned_outside_target_deadline";
  readonly terminationAndSurvivorProof: "supervisor_owned_outside_target_deadline";
  readonly totalMethodReturnDeadlineMs: null;
}

export interface BoundedGitWindowsLaunchFootprint {
  readonly commandLineCodeUnits: number;
  readonly brokerEnvironmentCodeUnits: number;
}

export interface HermeticGitEnvironmentOptions {
  readonly allocationRoot: string;
  readonly controlRoot: string;
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
}

interface FrozenHermeticGitEnvironmentOptions extends HermeticGitEnvironmentOptions {}

export class BoundedRepositoryGitError extends BoundedRepositoryError {
  readonly kind: BoundedGitFailureKind;
  readonly processState: BoundedGitProcessState;
  readonly mutationOutcome: BoundedGitMutationOutcome;
  readonly wallContract: BoundedGitWallContract | undefined;

  constructor(
    kind: BoundedGitFailureKind,
    message: string,
    options: ErrorOptions & {
      readonly committed?: boolean;
      readonly processState?: BoundedGitProcessState;
      readonly mutationOutcome?: BoundedGitMutationOutcome;
      readonly wallContract?: BoundedGitWallContract;
    } = {},
  ) {
    super("git", message, options);
    this.name = "BoundedRepositoryGitError";
    this.kind = kind;
    this.processState = options.processState ?? "cleanup_proven";
    this.mutationOutcome = options.mutationOutcome ?? "not_applicable";
    this.wallContract = options.wallContract;
  }
}

/**
 * Describe the wall scope enforced by one bounded Git runner.
 *
 * The target deadline applies independently to every Git command. Synchronous
 * containment bootstrap and termination proof remain supervisor-owned phases,
 * so this contract deliberately makes no total method-return deadline claim.
 */
export function createBoundedGitWallContract(
  targetCommandDeadlineMs: number,
): BoundedGitWallContract {
  validatePositiveLimit(
    targetCommandDeadlineMs,
    MAX_CONFIGURED_GIT_WALL_MS,
    "Git target-command deadline",
  );
  return Object.freeze({
    targetCommandDeadlineMs,
    appliesPerGitCommand: true,
    synchronousContainmentSetup: "supervisor_owned_outside_target_deadline",
    terminationAndSurvivorProof: "supervisor_owned_outside_target_deadline",
    totalMethodReturnDeadlineMs: null,
  });
}

/** Snapshot only the host variables that the hermetic Git process may receive. */
export function captureHermeticGitHostEnvironment(): Readonly<
  Record<string, string | undefined>
> {
  const environment = Object.create(null) as Record<string, string | undefined>;
  for (const name of FORWARDED_ENVIRONMENT_NAMES) {
    environment[name] = process.env[name];
  }
  return Object.freeze(environment);
}

/** Construct the allowlisted, deterministic environment used for Git. */
export function createHermeticGitEnvironment(
  input: HermeticGitEnvironmentOptions,
): Readonly<Record<string, string>> {
  const options = snapshotHermeticGitEnvironmentOptions(input);
  const environment: Record<string, string> = {
    GIT_AUTHOR_EMAIL: "agenc-hermetic-test@invalid",
    GIT_AUTHOR_NAME: "AgenC Hermetic Test",
    GIT_AUTHOR_DATE: DETERMINISTIC_GIT_TIMESTAMP,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_COMMITTER_EMAIL: "agenc-hermetic-test@invalid",
    GIT_COMMITTER_NAME: "AgenC Hermetic Test",
    GIT_COMMITTER_DATE: DETERMINISTIC_GIT_TIMESTAMP,
    GIT_CONFIG_GLOBAL: join(options.controlRoot, EMPTY_GIT_CONFIG),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TEMPLATE_DIR: join(options.controlRoot, EMPTY_GIT_TEMPLATES_DIRECTORY),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    HOME: options.allocationRoot,
    LANG: "C",
    LC_ALL: "C",
    PAGER: "cat",
    TEMP: options.allocationRoot,
    TMP: options.allocationRoot,
    TMPDIR: options.allocationRoot,
    TZ: "UTC",
  };

  let aggregateBytes = environmentBlockUnits(environment, "utf8");
  let aggregateCodeUnits = environmentBlockUnits(environment, "utf16");
  if (aggregateBytes > MAX_GIT_ENVIRONMENT_UTF8_BYTES) {
    throw gitConfigurationFailure(
      "Git environment exceeds its UTF-8 byte limit",
    );
  }
  if (aggregateCodeUnits > MAX_GIT_ENVIRONMENT_UTF16_CODE_UNITS) {
    throw gitConfigurationFailure("Git environment exceeds its UTF-16 limit");
  }
  for (const name of FORWARDED_ENVIRONMENT_NAMES) {
    const value = options.hostEnvironment[name];
    if (value === undefined) continue;
    const maximum =
      name === "PATH"
        ? MAX_GIT_PATH_BYTES
        : MAX_FORWARDED_ENVIRONMENT_VALUE_BYTES;
    const pairCodeUnits = name.length + value.length + 2;
    if (value.length > maximum) {
      throw gitConfigurationFailure(
        `Git environment variable ${name} is malformed or unbounded`,
      );
    }
    if (
      aggregateCodeUnits >
      MAX_GIT_ENVIRONMENT_UTF16_CODE_UNITS - pairCodeUnits
    ) {
      throw gitConfigurationFailure("Git environment exceeds its UTF-16 limit");
    }
    if (
      !isWellFormedUnicode(value) ||
      value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > maximum
    ) {
      throw gitConfigurationFailure(
        `Git environment variable ${name} is malformed or unbounded`,
      );
    }
    const pairBytes =
      Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 2;
    if (aggregateBytes > MAX_GIT_ENVIRONMENT_UTF8_BYTES - pairBytes) {
      throw gitConfigurationFailure(
        "Git environment exceeds its UTF-8 byte limit",
      );
    }
    aggregateBytes += pairBytes;
    aggregateCodeUnits += pairCodeUnits;
    environment[name] = value;
  }
  return Object.freeze(environment);
}

/**
 * Validate the exact Windows Job-broker launch representation.
 *
 * The supervisor passes the quoted target command and executable through
 * base64 environment variables. Validating that final representation keeps
 * every accepted invocation below CreateProcess's UTF-16 limits.
 */
export function validateWindowsGitProcessHandoff(
  program: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  wallContract?: BoundedGitWallContract,
): BoundedGitWindowsLaunchFootprint {
  const copiedArgs = snapshotDenseArray(
    args,
    MAX_GIT_LAUNCH_ARGUMENT_COUNT,
    "Git launch arguments",
  );
  const launchArguments = new Array<string>(copiedArgs.length + 1);
  let unquotedCommandLineCodeUnits = 1;
  const copiedProgram = validateCommandLineString(
    program,
    "Git launch program",
    WINDOWS_CREATE_PROCESS_TEXT_CODE_UNITS - unquotedCommandLineCodeUnits,
    wallContract,
  );
  launchArguments[0] = copiedProgram;
  unquotedCommandLineCodeUnits += copiedProgram.length;
  for (let index = 0; index < copiedArgs.length; index += 1) {
    const separatorCodeUnits = 1;
    const remainingCodeUnits =
      WINDOWS_CREATE_PROCESS_TEXT_CODE_UNITS -
      unquotedCommandLineCodeUnits -
      separatorCodeUnits;
    const copiedArgument = validateCommandLineString(
      copiedArgs[index],
      `Git launch argument ${index}`,
      remainingCodeUnits,
      wallContract,
    );
    launchArguments[index + 1] = copiedArgument;
    unquotedCommandLineCodeUnits += separatorCodeUnits + copiedArgument.length;
  }
  const commandLine = launchArguments
    .map(quoteWindowsCommandLineArgument)
    .join(" ");
  const commandLineCodeUnits = commandLine.length + 1;
  if (commandLineCodeUnits > WINDOWS_CREATE_PROCESS_TEXT_CODE_UNITS) {
    throw gitConfigurationFailure(
      "Git command exceeds the Windows CreateProcess command-line limit",
      wallContract,
    );
  }

  const brokerEnvironment: Record<string, string> = {
    ...snapshotLaunchEnvironment(environment),
    [WINDOWS_JOB_PROGRAM_ENVIRONMENT_NAME]: Buffer.from(
      copiedProgram,
      "utf8",
    ).toString("base64"),
    [WINDOWS_JOB_COMMAND_LINE_ENVIRONMENT_NAME]: Buffer.from(
      commandLine,
      "utf8",
    ).toString("base64"),
    [WINDOWS_JOB_OWNER_PID_ENVIRONMENT_NAME]: String(process.pid),
  };
  const brokerEnvironmentCodeUnits =
    windowsEnvironmentBlockCodeUnits(brokerEnvironment);
  if (brokerEnvironmentCodeUnits > WINDOWS_CREATE_PROCESS_TEXT_CODE_UNITS) {
    throw gitConfigurationFailure(
      "Git launch exceeds the Windows CreateProcess environment limit",
      wallContract,
    );
  }
  return Object.freeze({
    commandLineCodeUnits,
    brokerEnvironmentCodeUnits,
  });
}

export function gitConfigurationFailure(
  message: string,
  wallContract?: BoundedGitWallContract,
): BoundedRepositoryGitError {
  return new BoundedRepositoryGitError("discovery", message, {
    ...(wallContract === undefined ? {} : { wallContract }),
  });
}

function snapshotHermeticGitEnvironmentOptions(
  input: HermeticGitEnvironmentOptions,
): FrozenHermeticGitEnvironmentOptions {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = snapshotPlainDataRecord(
      input,
      "hermetic Git environment options",
      HERMETIC_GIT_OPTION_KEYS.length,
    );
    assertExactKeys(
      record,
      HERMETIC_GIT_OPTION_KEYS,
      "hermetic Git environment options",
    );
  } catch (error) {
    throw gitOptionSnapshotFailure(
      "hermetic Git environment options must be an exact plain own-data-property record",
      error,
    );
  }

  const allocationRoot = record.allocationRoot;
  const controlRoot = record.controlRoot;
  if (
    typeof allocationRoot !== "string" ||
    typeof controlRoot !== "string" ||
    allocationRoot.length === 0 ||
    controlRoot.length === 0 ||
    allocationRoot.length > MAX_GIT_ENVIRONMENT_UTF16_CODE_UNITS ||
    controlRoot.length > MAX_GIT_ENVIRONMENT_UTF16_CODE_UNITS ||
    allocationRoot.length * ALLOCATION_ROOT_ENVIRONMENT_MULTIPLICITY +
      controlRoot.length * CONTROL_ROOT_ENVIRONMENT_MULTIPLICITY >
      MAX_GIT_ENVIRONMENT_UTF16_CODE_UNITS
  ) {
    throw gitConfigurationFailure(
      "hermetic Git environment roots exceed their aggregate length limit",
    );
  }
  const copiedAllocationRoot = validateHermeticGitRoot(
    allocationRoot,
    "Git allocation root",
  );
  const copiedControlRoot = validateHermeticGitRoot(
    controlRoot,
    "Git control root",
  );
  if (!isContainedGitPath(copiedAllocationRoot, copiedControlRoot)) {
    throw gitConfigurationFailure(
      "Git control root must be contained by the allocation root",
    );
  }
  return Object.freeze({
    allocationRoot: copiedAllocationRoot,
    controlRoot: copiedControlRoot,
    hostEnvironment: snapshotHermeticHostEnvironment(record.hostEnvironment),
  });
}

function snapshotHermeticHostEnvironment(
  input: unknown,
): Readonly<Record<string, string | undefined>> {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = snapshotPlainDataRecord(
      input,
      "hermetic Git host environment",
      MAX_GIT_ENVIRONMENT_ENTRY_COUNT,
    );
  } catch (error) {
    throw gitOptionSnapshotFailure(
      "hermetic Git host environment must be a bounded plain own-data-property record",
      error,
    );
  }
  const result = Object.create(null) as Record<string, string | undefined>;
  for (const name of FORWARDED_ENVIRONMENT_NAMES) {
    if (!Object.hasOwn(record, name)) continue;
    const value = record[name];
    if (value !== undefined && typeof value !== "string") {
      throw gitConfigurationFailure(
        `Git environment variable ${name} must be a string or undefined`,
      );
    }
    result[name] = value as string | undefined;
  }
  return Object.freeze(result);
}

function validateHermeticGitRoot(value: string, label: string): string {
  if (
    !isWellFormedUnicode(value) ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_GIT_PATH_BYTES ||
    !isAbsolute(value)
  ) {
    throw gitConfigurationFailure(`${label} is not a bounded absolute path`);
  }
  return value;
}

function gitOptionSnapshotFailure(
  message: string,
  cause: unknown,
): BoundedRepositoryGitError {
  return new BoundedRepositoryGitError("discovery", message, { cause });
}

function snapshotLaunchEnvironment(
  input: Readonly<Record<string, string>>,
): Record<string, string> {
  if (
    input === null ||
    typeof input !== "object" ||
    nodeUtilTypes.isProxy(input)
  ) {
    throw gitConfigurationFailure("Git launch environment is invalid");
  }
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw gitConfigurationFailure("Git launch environment is not plain");
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length > MAX_GIT_ENVIRONMENT_ENTRY_COUNT) {
    throw gitConfigurationFailure(
      "Git launch environment has too many entries",
    );
  }
  const result = Object.create(null) as Record<string, string>;
  let aggregateCodeUnits = 1;
  for (const key of keys) {
    if (typeof key !== "string") {
      throw gitConfigurationFailure("Git launch environment name is invalid");
    }
    const remainingNameCodeUnits =
      WINDOWS_CREATE_PROCESS_TEXT_CODE_UNITS - aggregateCodeUnits - 2;
    if (
      key.length === 0 ||
      key.length > remainingNameCodeUnits ||
      key.includes("=") ||
      key.includes("\0") ||
      !isWellFormedUnicode(key)
    ) {
      throw gitConfigurationFailure("Git launch environment name is invalid");
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw gitConfigurationFailure(
        `Git launch environment ${key} must be a data property`,
      );
    }
    const remainingValueCodeUnits =
      WINDOWS_CREATE_PROCESS_TEXT_CODE_UNITS -
      aggregateCodeUnits -
      key.length -
      2;
    const value = validateLaunchString(
      descriptor.value,
      `Git launch environment ${key}`,
      remainingValueCodeUnits,
    );
    aggregateCodeUnits += key.length + value.length + 2;
    result[key] = value;
  }
  return result;
}

function validateCommandLineString(
  value: unknown,
  label: string,
  maximumCodeUnits: number,
  wallContract?: BoundedGitWallContract,
): string {
  if (
    typeof value === "string" &&
    (maximumCodeUnits < 0 || value.length > maximumCodeUnits)
  ) {
    throw gitConfigurationFailure(
      "Git command exceeds the Windows CreateProcess command-line limit",
      wallContract,
    );
  }
  return validateLaunchString(value, label, maximumCodeUnits);
}

function validateLaunchString(
  value: unknown,
  label: string,
  maximumCodeUnits: number,
): string {
  if (
    typeof value !== "string" ||
    maximumCodeUnits < 0 ||
    value.length > maximumCodeUnits ||
    !isWellFormedUnicode(value) ||
    value.includes("\0")
  ) {
    throw gitConfigurationFailure(`${label} is malformed`);
  }
  return value;
}

function quoteWindowsCommandLineArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1);
      quoted += '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes);
    backslashes = 0;
    quoted += character;
  }
  quoted += "\\".repeat(backslashes * 2);
  return `${quoted}"`;
}

function windowsEnvironmentBlockCodeUnits(
  environment: Readonly<Record<string, string>>,
): number {
  return environmentBlockUnits(environment, "utf16");
}

function environmentBlockUnits(
  environment: Readonly<Record<string, string>>,
  encoding: "utf8" | "utf16",
): number {
  let units = 1;
  for (const [name, value] of Object.entries(environment)) {
    units +=
      encoding === "utf8"
        ? Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 2
        : name.length + value.length + 2;
  }
  return units;
}

function validatePositiveLimit(
  value: number,
  maximum: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < MINIMUM_POSITIVE_LIMIT ||
    value > maximum
  ) {
    throw gitConfigurationFailure(`${label} is invalid`);
  }
}
