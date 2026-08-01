import { join } from "node:path";

import {
  runSupervisedProcess,
  type SupervisedProcessResult,
} from "../../src/utils/supervisedProcess.js";
import {
  assertGitExecutableIdentity,
  BoundedGitDiscoveryError,
  createGitWallDeadline,
  isContainedGitPath,
  remainingGitWallMs,
  resolveGitExecutableBeforeDeadline,
  type GitWallDeadline,
  type ResolvedGitExecutable,
  validateBoundedAbsoluteGitPath,
} from "./bounded-repository-git-discovery.js";
import {
  assertExactKeys,
  MAX_CONFIGURED_GIT_OUTPUT_BYTES,
  MAX_GIT_ARGUMENT_COUNT,
  snapshotDenseArray,
  snapshotPlainDataRecord,
} from "./bounded-repository-policy.js";
import {
  BoundedRepositoryGitError,
  captureHermeticGitHostEnvironment,
  createBoundedGitWallContract,
  createHermeticGitEnvironment,
  gitConfigurationFailure,
  type BoundedGitFailureKind,
  type BoundedGitProcessState,
  type BoundedGitWallContract,
  validateWindowsGitProcessHandoff,
} from "./bounded-repository-git-launch.js";
import { isWellFormedUnicode } from "./portable-repository-path.js";

export {
  resolveBoundedGitExecutable,
  validateGitPathExtensions,
} from "./bounded-repository-git-discovery.js";
export type { ResolveGitExecutableOptions } from "./bounded-repository-git-discovery.js";
export {
  BoundedRepositoryGitError,
  createBoundedGitWallContract,
  createHermeticGitEnvironment,
  validateWindowsGitProcessHandoff,
} from "./bounded-repository-git-launch.js";
export type {
  BoundedGitFailureKind,
  BoundedGitMutationOutcome,
  BoundedGitProcessState,
  BoundedGitWallContract,
  BoundedGitWindowsLaunchFootprint,
  HermeticGitEnvironmentOptions,
} from "./bounded-repository-git-launch.js";

const GIT_EXCLUDES_FILE = "git-excludes";
const EMPTY_HOOKS_DIRECTORY = "hooks";
const SHA1_HEX_LENGTH = 40;
const MINIMUM_POSITIVE_LIMIT = 1;
const GIT_INTERNAL_ARGUMENT_HEADROOM = 24;
const MAX_GIT_INVOCATION_ARGUMENT_COUNT =
  MAX_GIT_ARGUMENT_COUNT + GIT_INTERNAL_ARGUMENT_HEADROOM;
export const MAX_GIT_INVOCATION_ARGUMENT_BYTES = 4_096;
export const MAX_GIT_INVOCATION_UTF16_CODE_UNITS = 4_096;
const MAX_GIT_PROGRAM_BYTES = 2_048;
const SHA1_OBJECT_ID = new RegExp(`^[0-9a-f]{${SHA1_HEX_LENGTH}}$`, "u");
const GIT_OPTION_KEYS = Object.freeze([
  "allocationRoot",
  "repositoryRoot",
  "controlRoot",
  "maxOutputBytes",
  "maxWallMs",
] as const);

export interface BoundedRepositoryGitOptions {
  readonly allocationRoot: string;
  readonly repositoryRoot: string;
  readonly controlRoot: string;
  readonly maxOutputBytes: number;
  /**
   * Per-command target deadline. It is not an end-to-end method-return SLA:
   * synchronous containment bootstrap and termination proof are owned by the
   * shared process supervisor outside this deadline.
   */
  readonly maxWallMs: number;
}

export interface BoundedGitRunResult {
  readonly program: string;
  readonly result: SupervisedProcessResult;
  readonly processState: BoundedGitProcessState;
  readonly wallContract: BoundedGitWallContract;
}

export interface BoundedGitCommitResult {
  readonly committed: true;
  readonly head: string;
  readonly wallContract: BoundedGitWallContract;
}

export interface BoundedGitInvocationFootprint {
  readonly argumentCount: number;
  readonly utf8Bytes: number;
  readonly utf16CodeUnits: number;
}

interface FrozenGitOptions {
  readonly allocationRoot: string;
  readonly repositoryRoot: string;
  readonly controlRoot: string;
  readonly maxOutputBytes: number;
  readonly wallContract: BoundedGitWallContract;
}

/**
 * Supervise deterministic Git commands for one repository.
 *
 * Initialization state and the commit-count limit deliberately remain owned
 * by the repository facade. This component caches only the exact executable
 * identity it discovered.
 */
export class BoundedRepositoryGit {
  readonly wallContract: BoundedGitWallContract;

  readonly #options: FrozenGitOptions;
  readonly #hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #fixedArguments: readonly string[];
  #executable: ResolvedGitExecutable | undefined;

  constructor(input: BoundedRepositoryGitOptions) {
    this.#options = snapshotGitOptionsOrThrow(input);
    this.wallContract = this.#options.wallContract;
    this.#hostEnvironment = captureHermeticGitHostEnvironment();
    this.#environment = createHermeticGitEnvironment({
      allocationRoot: this.#options.allocationRoot,
      controlRoot: this.#options.controlRoot,
      hostEnvironment: this.#hostEnvironment,
    });
    this.#fixedArguments = snapshotInvocationArguments(
      fixedGitArguments(this.#options.controlRoot),
    );
  }

  /** Initialize this repository with the one supported object format. */
  async initialize(): Promise<void> {
    await this.#runChecked(
      ["init", "--quiet", "--initial-branch=main", "--object-format=sha1"],
      "initialize repository",
      true,
    );
  }

  /** Stage only the caller's already-validated repository-relative paths. */
  async add(paths: readonly string[]): Promise<void> {
    const copiedPaths = snapshotInvocationArguments(paths);
    await this.#runChecked(
      ["add", "--", ...copiedPaths],
      "stage repository files",
      true,
    );
  }

  /** Validate the exact fixed-plus-dynamic argument footprint before auditing. */
  validateAddInvocation(
    paths: readonly string[],
  ): BoundedGitInvocationFootprint {
    const copiedPaths = snapshotInvocationArguments(paths);
    return this.#prepareCommandArguments(["add", "--", ...copiedPaths])
      .footprint;
  }

  /** Validate the complete commit argument footprint before mutation begins. */
  validateCommitInvocation(message: string): BoundedGitInvocationFootprint {
    return this.#prepareCommandArguments([
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "--message",
      message,
    ]).footprint;
  }

  /**
   * Run one internally fixed command under the target-command portion of the
   * public wall contract. The shared supervisor owns synchronous containment
   * initialization and termination proof outside this target deadline.
   */
  async #run(args: readonly string[]): Promise<BoundedGitRunResult> {
    const wallContract = this.wallContract;
    const deadline = createGitWallDeadline(
      wallContract.targetCommandDeadlineMs,
    );
    let commandArguments: readonly string[];
    try {
      commandArguments = this.#prepareCommandArguments(args).arguments;
      // Synchronous preflight cannot be interrupted, but it is charged to the
      // target deadline before any filesystem probe or child launch begins.
      remainingGitWallMs(deadline);
    } catch (error) {
      throw attachGitWallContract(error, wallContract);
    }
    const hostEnvironment = this.#hostEnvironment;
    let executable: ResolvedGitExecutable;
    try {
      executable = await this.#resolveExecutable(hostEnvironment, deadline);
    } catch (error) {
      throw attachGitWallContract(error, wallContract);
    }
    if (
      executable.program.length > MAX_GIT_PROGRAM_BYTES ||
      Buffer.byteLength(executable.program, "utf8") > MAX_GIT_PROGRAM_BYTES
    ) {
      throw gitConfigurationFailure(
        "resolved Git executable path exceeds the launch byte limit",
        wallContract,
      );
    }

    let timeoutMs: number;
    try {
      validateWindowsGitProcessHandoff(
        executable.program,
        commandArguments,
        this.#environment,
        wallContract,
      );
      // Node has no cross-platform API for executing an already-open file.
      // Revalidate at the last async boundary before handing the pathname to
      // the supervisor, minimizing the unavoidable check-to-exec window.
      await assertGitExecutableIdentity(executable, deadline);
      timeoutMs = remainingGitWallMs(deadline);
    } catch (error) {
      throw attachGitWallContract(error, wallContract);
    }

    let result: SupervisedProcessResult;
    try {
      result = await runSupervisedProcess(
        {
          program: executable.program,
          args: commandArguments,
          cwd: this.#options.repositoryRoot,
          env: this.#environment,
        },
        {
          timeoutMs,
          maxOutputBytes: this.#options.maxOutputBytes,
        },
      );
    } catch (error) {
      throw new BoundedRepositoryGitError(
        "supervision",
        "Git supervision failed without a terminal process result; surviving-process cleanup is unproven",
        {
          cause: error,
          processState: "survivors_unproven",
          wallContract,
        },
      );
    }
    return Object.freeze({
      program: executable.program,
      result,
      processState: classifyGitProcessState(result),
      wallContract,
    });
  }

  /** Run one internally fixed command and reject every failed result. */
  async #runChecked(
    args: readonly string[],
    operation: string,
    mutatesRepository = false,
  ): Promise<BoundedGitRunResult> {
    let run: BoundedGitRunResult;
    try {
      run = await this.#run(args);
    } catch (error) {
      if (
        mutatesRepository &&
        error instanceof BoundedRepositoryGitError &&
        (error.kind === "supervision" || error.kind === "survivors_unproven")
      ) {
        throw new BoundedRepositoryGitError(error.kind, error.message, {
          cause: error,
          mutationOutcome: "unknown",
          processState: error.processState,
          wallContract: error.wallContract ?? this.wallContract,
        });
      }
      throw error;
    }
    if (run.result.exitCode !== 0 || hasGitSupervisionFailure(run.result)) {
      throw gitProcessFailure(
        operation,
        run.result,
        mutatesRepository,
        run.wallContract,
      );
    }
    return run;
  }

  async readHead(): Promise<string> {
    const run = await this.#runChecked(
      ["rev-parse", "--verify", "HEAD"],
      "read repository HEAD",
    );
    const head = run.result.stdout.toString("utf8").trim();
    if (!SHA1_OBJECT_ID.test(head)) {
      throw new BoundedRepositoryGitError(
        "invalid_head",
        "Git returned an invalid HEAD",
        { wallContract: run.wallContract },
      );
    }
    return head;
  }

  async readStatus(): Promise<string> {
    const run = await this.#runChecked(
      ["status", "--short", "--untracked-files=all"],
      "read repository status",
    );
    return run.result.stdout.toString("utf8");
  }

  /**
   * Commit and resolve HEAD. A failure after the successful commit carries
   * committed=true so callers cannot mistake it for a rejected commit.
   */
  async commitAndReadHead(message: string): Promise<BoundedGitCommitResult> {
    await this.#runChecked(
      ["commit", "--quiet", "--no-gpg-sign", "--message", message],
      "commit repository files",
      true,
    );
    try {
      return Object.freeze({
        committed: true,
        head: await this.readHead(),
        wallContract: this.wallContract,
      });
    } catch (error) {
      throw postCommitVerificationFailure(error, this.wallContract);
    }
  }

  async #resolveExecutable(
    hostEnvironment: Readonly<Record<string, string | undefined>>,
    deadline: GitWallDeadline,
  ): Promise<ResolvedGitExecutable> {
    if (this.#executable !== undefined) {
      await assertGitExecutableIdentity(this.#executable, deadline);
      return this.#executable;
    }
    const executable = await resolveGitExecutableBeforeDeadline(
      hostEnvironment.PATH,
      hostEnvironment.PATHEXT,
      deadline,
    );
    this.#executable = executable;
    return executable;
  }

  #prepareCommandArguments(args: readonly string[]): {
    readonly arguments: readonly string[];
    readonly footprint: BoundedGitInvocationFootprint;
  } {
    const copiedArgs = snapshotInvocationArguments(args);
    const commandArguments = snapshotInvocationArguments([
      ...this.#fixedArguments,
      ...copiedArgs,
    ]);
    return Object.freeze({
      arguments: commandArguments,
      footprint: measureInvocationFootprint(commandArguments),
    });
  }
}

export function classifyGitProcessState(
  result: SupervisedProcessResult,
): BoundedGitProcessState {
  return result.backstopExpired ||
    result.stopReason === "spawn_error" ||
    (result.error !== undefined &&
      result.exitCode === null &&
      result.signal === null)
    ? "survivors_unproven"
    : "cleanup_proven";
}

export function hasGitSupervisionFailure(
  result: SupervisedProcessResult,
): boolean {
  return (
    result.signal !== null ||
    result.error !== undefined ||
    result.stopReason !== undefined ||
    result.forced ||
    result.backstopExpired
  );
}

export function gitProcessFailure(
  operation: string,
  result: SupervisedProcessResult,
  mutatesRepository = false,
  wallContract?: BoundedGitWallContract,
): BoundedRepositoryGitError {
  const processState = classifyGitProcessState(result);
  const diagnostic = Buffer.concat([result.stdout, result.stderr])
    .toString("utf8")
    .trim();
  const diagnosticSuffix = diagnostic.length === 0 ? "" : `: ${diagnostic}`;
  const survivalSuffix =
    processState === "survivors_unproven"
      ? "; surviving-process cleanup is unproven"
      : "";
  return new BoundedRepositoryGitError(
    failureKind(result),
    `failed to ${operation} (exit=${String(result.exitCode)}, signal=${String(result.signal)}, stop=${String(result.stopReason)})${survivalSuffix}${diagnosticSuffix}`,
    {
      ...(result.error === undefined ? {} : { cause: result.error }),
      mutationOutcome: mutatesRepository ? "unknown" : "not_applicable",
      processState,
      ...(wallContract === undefined ? {} : { wallContract }),
    },
  );
}

function snapshotGitOptionsOrThrow(
  input: BoundedRepositoryGitOptions,
): FrozenGitOptions {
  try {
    return snapshotGitOptions(input);
  } catch (error) {
    throw translateDiscoveryFailure(error);
  }
}

function snapshotGitOptions(
  input: BoundedRepositoryGitOptions,
): FrozenGitOptions {
  const record = snapshotPlainDataRecord(
    input,
    "bounded Git options",
    GIT_OPTION_KEYS.length,
  );
  assertExactKeys(record, GIT_OPTION_KEYS, "bounded Git options");
  const allocationRoot = validateBoundedGitRoot(
    record.allocationRoot as string,
    "Git allocation root",
  );
  const repositoryRoot = validateBoundedGitRoot(
    record.repositoryRoot as string,
    "Git repository root",
  );
  const controlRoot = validateBoundedGitRoot(
    record.controlRoot as string,
    "Git control root",
  );
  if (
    !isContainedGitPath(allocationRoot, repositoryRoot) ||
    !isContainedGitPath(allocationRoot, controlRoot)
  ) {
    throw gitConfigurationFailure(
      "Git repository and control roots must be contained by the allocation",
    );
  }
  validatePositiveLimit(
    record.maxOutputBytes as number,
    MAX_CONFIGURED_GIT_OUTPUT_BYTES,
    "Git output limit",
  );
  return Object.freeze({
    allocationRoot,
    repositoryRoot,
    controlRoot,
    maxOutputBytes: record.maxOutputBytes as number,
    wallContract: createBoundedGitWallContract(record.maxWallMs as number),
  });
}

function validateBoundedGitRoot(value: string, label: string): string {
  try {
    return validateBoundedAbsoluteGitPath(value, label);
  } catch (error) {
    throw translateDiscoveryFailure(error);
  }
}

function snapshotInvocationArguments(
  input: readonly string[],
): readonly string[] {
  const values = snapshotDenseArray(
    input,
    MAX_GIT_INVOCATION_ARGUMENT_COUNT,
    "Git invocation arguments",
  );
  const result = new Array<string>(values.length);
  let aggregateBytes = 0;
  let aggregateCodeUnits = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== "string") {
      throw gitConfigurationFailure(`Git argument ${index} is malformed`);
    }
    if (
      value.length >
      MAX_GIT_INVOCATION_UTF16_CODE_UNITS - aggregateCodeUnits
    ) {
      throw gitConfigurationFailure(
        "Git invocation arguments exceed their UTF-16 limit",
      );
    }
    if (!isWellFormedUnicode(value) || value.includes("\0")) {
      throw gitConfigurationFailure(`Git argument ${index} is malformed`);
    }
    const bytes = Buffer.byteLength(value, "utf8");
    if (aggregateBytes > MAX_GIT_INVOCATION_ARGUMENT_BYTES - bytes) {
      throw gitConfigurationFailure(
        "Git invocation arguments exceed their byte limit",
      );
    }
    aggregateBytes += bytes;
    aggregateCodeUnits += value.length;
    result[index] = value;
  }
  return Object.freeze(result);
}

function fixedGitArguments(controlRoot: string): readonly string[] {
  return Object.freeze([
    "-c",
    `core.hooksPath=${join(controlRoot, EMPTY_HOOKS_DIRECTORY)}`,
    "-c",
    `core.excludesFile=${join(controlRoot, GIT_EXCLUDES_FILE)}`,
    "-c",
    "commit.gpgSign=false",
    "-c",
    "protocol.allow=never",
  ]);
}

function measureInvocationFootprint(
  args: readonly string[],
): BoundedGitInvocationFootprint {
  let utf8Bytes = 0;
  let utf16CodeUnits = 0;
  for (const argument of args) {
    utf8Bytes += Buffer.byteLength(argument, "utf8");
    utf16CodeUnits += argument.length;
  }
  return Object.freeze({
    argumentCount: args.length,
    utf8Bytes,
    utf16CodeUnits,
  });
}

function postCommitVerificationFailure(
  error: unknown,
  wallContract: BoundedGitWallContract,
): BoundedRepositoryGitError {
  const processState =
    error instanceof BoundedRepositoryGitError
      ? error.processState
      : "cleanup_proven";
  return new BoundedRepositoryGitError(
    "post_commit_verification",
    "Git commit succeeded, but its resulting HEAD could not be verified",
    {
      cause: error,
      committed: true,
      mutationOutcome: "committed",
      processState,
      wallContract:
        error instanceof BoundedRepositoryGitError &&
        error.wallContract !== undefined
          ? error.wallContract
          : wallContract,
    },
  );
}

function failureKind(result: SupervisedProcessResult): BoundedGitFailureKind {
  if (classifyGitProcessState(result) === "survivors_unproven") {
    return "survivors_unproven";
  }
  if (
    result.signal !== null ||
    result.error !== undefined ||
    result.stopReason !== undefined ||
    result.forced
  ) {
    return "supervision";
  }
  return "exit";
}

function translateDiscoveryFailure(
  error: unknown,
  wallContract?: BoundedGitWallContract,
): unknown {
  if (!(error instanceof BoundedGitDiscoveryError)) return error;
  return new BoundedRepositoryGitError(error.kind, error.message, {
    cause: error,
    ...(wallContract === undefined ? {} : { wallContract }),
  });
}

function attachGitWallContract(
  error: unknown,
  wallContract: BoundedGitWallContract,
): unknown {
  if (error instanceof BoundedGitDiscoveryError) {
    return translateDiscoveryFailure(error, wallContract);
  }
  if (
    !(error instanceof BoundedRepositoryGitError) ||
    error.wallContract !== undefined
  ) {
    return error;
  }
  return new BoundedRepositoryGitError(error.kind, error.message, {
    cause: error,
    committed: error.committed,
    mutationOutcome: error.mutationOutcome,
    processState: error.processState,
    wallContract,
  });
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
